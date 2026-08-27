const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

// Mongo Initialization
let MongoClient = null;
try { MongoClient = require('mongodb').MongoClient; } catch (e) { console.log('mongodb package not installed'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const sessions = new Map();
const SESSION_BATCH = 30;          
const SESSION_REST_MS = 2 * 60 * 60 * 1000;

let isAutoReplyEnabled = true;
let autoReplyMessage = `🌟 Welcome! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करने के लिए`;

function listSessionsPublic() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id, name: s.name, connected: !!s.connected, qrCode: s.qrCode || null,
        restUntil: s.restUntil || null, resting: !!(s.restUntil && Date.now() < s.restUntil),
        sentInBatch: s.sentInBatch || 0, batchSize: s.batchSize || SESSION_BATCH
    }));
}
function anyConnected() { return Array.from(sessions.values()).some(s => s.connected && s.sock); }
function getFirstConnectedSock() {
    for (const s of sessions.values()) if (s.connected && s.sock) return s.sock;
    return null;
}
function getSession(id) { return sessions.get(id) || null; }

const statsFile = __dirname + '/stats.json';
const historyFile = __dirname + '/history.json';
const templatesFile = __dirname + '/templates.json';
const contactsFile = __dirname + '/contacts.json';
const connectionMetaFile = __dirname + '/connection_meta.json';

const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient = null;
let db = null;
let useMongo = false;

let cache = { contacts: {}, templates: [], history: [], stats: {}, meta: {} };

async function initMongo() {
    if (!MONGODB_URI || !MongoClient) {
        console.log('⚠️ MongoDB not used — local JSON files fallback');
        cache.contacts = getJsonFile(contactsFile) || {}; cache.templates = getJsonFile(templatesFile) || [];
        cache.history = getJsonFile(historyFile) || []; cache.stats = getJsonFile(statsFile) || {}; cache.meta = getJsonFile(connectionMetaFile) || {};
        return;
    }
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db('whatsapp_bot');
        useMongo = true;
        console.log('✅ MongoDB connected — Data & Auth Keys will persist');

        const col = (name) => db.collection(name);
        const contactsDoc = await col('contacts').findOne({ _id: 'main' });
        const templatesDoc = await col('templates').findOne({ _id: 'main' });
        const historyDoc = await col('history').findOne({ _id: 'main' });
        const statsDoc = await col('stats').findOne({ _id: 'main' });
        const metaDoc = await col('meta').findOne({ _id: 'main' });

        cache.contacts = (contactsDoc && contactsDoc.data) ? contactsDoc.data : {};
        cache.templates = (templatesDoc && templatesDoc.data) ? templatesDoc.data : [];
        cache.history = (historyDoc && historyDoc.data) ? historyDoc.data : [];
        cache.stats = (statsDoc && statsDoc.data) ? statsDoc.data : {};
        cache.meta = (metaDoc && metaDoc.data) ? metaDoc.data : {};
    } catch (e) {
        console.error('❌ MongoDB connect failed:', e.message);
        useMongo = false;
    }
}

async function persist(key, data) {
    cache[key] = data;
    if (useMongo && db) {
        try { await db.collection(key).updateOne({ _id: 'main' }, { $set: { data, updatedAt: new Date() } }, { upsert: true }); } catch (e) {}
    } else {
        const map = { contacts: contactsFile, templates: templatesFile, history: historyFile, stats: statsFile, meta: connectionMetaFile };
        if (map[key]) saveJsonFile(map[key], data);
    }
}

function getJsonFile(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch(e) { return null; } }
function saveJsonFile(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {} }

function getStats() { return cache.stats || {}; }
function saveStats(date, sent, failed) {
    const stats = getStats();
    if (!stats[date]) stats[date] = { sent: 0, failed: 0 };
    stats[date].sent += sent; stats[date].failed += failed;
    persist('stats', stats);
}
function getHistory() { return cache.history || []; }
function addHistory(number, messageSent) {
    let list = getHistory(); list.push({ number: number, message: messageSent, date: new Date().toLocaleString('en-IN') });
    if (list.length > 50000) list = list.slice(-50000);
    persist('history', list);
}
function getTemplates() { return cache.templates || []; }
function getContacts() { return cache.contacts || {}; }
function getMeta() { return cache.meta || {}; }

// --- TIME & ANTI-BAN LIMITS ---
function getISTNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })); }
function getAccountAgeDays() {
    const meta = getMeta(); if (!meta || !meta.firstConnectedAt) return 0;
    return Math.floor((new Date() - new Date(meta.firstConnectedAt)) / (1000 * 60 * 60 * 24));
}
function getDailyLimit() { const age = getAccountAgeDays(); return age < 3 ? 80 : (age < 7 ? 150 : 200); }
function getTodaySentCount() { const today = new Date().toLocaleDateString('en-CA'); const stats = getStats(); return (stats[today] && stats[today].sent) ? stats[today].sent : 0; }
function getDailyScanLimit() { return getAccountAgeDays() < 3 ? 80 : 200; }
function getTodayScanCount() { const today = new Date().toLocaleDateString('en-CA'); const meta = getMeta(); if (!meta.scanByDate) meta.scanByDate = {}; return meta.scanByDate[today] || 0; }
function addTodayScanCount(n) { const today = new Date().toLocaleDateString('en-CA'); const meta = { ...getMeta() }; if (!meta.scanByDate) meta.scanByDate = {}; meta.scanByDate[today] = (meta.scanByDate[today] || 0) + n; persist('meta', meta); }

// --- MONGODB AUTH ADAPTER ---
function pathJoinAuth(sessionId) { return (__dirname + '/auth_sessions/' + sessionId).replace(/\\/g, '/'); }

async function clearSessionAuth(sessionId) {
    if (useMongo && db) {
        await db.collection('auth_keys').deleteMany({ _id: { $regex: `^${sessionId}-` } });
    } else {
        try { fs.rmSync(pathJoinAuth(sessionId), { recursive: true, force: true }); } catch (e) {}
    }
}

async function getAuthState(sessionId) {
    if (useMongo && db) {
        const col = db.collection('auth_keys');
        const writeData = async (data, id) => {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await col.updateOne({ _id: `${sessionId}-${id}` }, { $set: { data: str } }, { upsert: true });
        };
        const readData = async (id) => {
            const doc = await col.findOne({ _id: `${sessionId}-${id}` });
            return doc && doc.data ? JSON.parse(doc.data, BufferJSON.reviver) : null;
        };
        const removeData = async (id) => { await col.deleteOne({ _id: `${sessionId}-${id}` }); };

        let creds = await readData('creds');
        if (!creds) { creds = initAuthCreds(); await writeData(creds, 'creds'); }

        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            data[id] = value;
                        }));
                        return data;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                const key = `${category}-${id}`;
                                tasks.push(value ? writeData(value, key) : removeData(key));
                            }
                        }
                        await Promise.all(tasks);
                    }
                }
            },
            saveCreds: () => writeData(creds, 'creds')
        };
    } else {
        const authDir = pathJoinAuth(sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        return { state, saveCreds };
    }
}

// WhatsApp Connection
async function startSession(sessionId, sessionName) {
    const { state, saveCreds } = await getAuthState(sessionId);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });

    const session = sessions.get(sessionId) || {
        id: sessionId, name: sessionName || sessionId, sock: null, connected: false,
        qrCode: null, restUntil: null, sentInBatch: 0, batchSize: SESSION_BATCH
    };
    session.sock = sock; session.name = sessionName || session.name; sessions.set(sessionId, session);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const s = sessions.get(sessionId);
        if (!s) return;
        if (qr) s.qrCode = await qrcode.toDataURL(qr);
        if (connection === 'close') {
            s.connected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId, s.name), 3000);
            } else {
                try { await clearSessionAuth(sessionId); } catch(e){}
                s.qrCode = null;
                setTimeout(() => startSession(sessionId, s.name), 2000);
            }
        } else if (connection === 'open') {
            s.connected = true; s.qrCode = null;
            const meta = { ...getMeta() };
            if (!meta.firstConnectedAt) { meta.firstConnectedAt = new Date().toISOString(); persist('meta', meta); }
            if (!meta.sessions) meta.sessions = [];
            if (!meta.sessions.find(x => x.id === sessionId)) { meta.sessions.push({ id: sessionId, name: s.name }); persist('meta', meta); }
            console.log(`Session connected: ${s.name} (${sessionId})`);
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

async function bootstrapSessions() {
    const meta = getMeta();
    let list = (meta.sessions && meta.sessions.length) ? meta.sessions : [{ id: 'wa_1', name: 'WhatsApp 1' }];
    if (!list.length) list = [{ id: 'wa_1', name: 'WhatsApp 1' }];
    for (const item of list) { await startSession(item.id, item.name); }
}

// API Routes
app.get('/status', (req, res) => {
    const list = listSessionsPublic(); const primary = list.find(s => s.connected) || list[0] || null;
    res.json({ connected: anyConnected(), qrCode: primary && !primary.connected ? primary.qrCode : null, sessions: list, autoReply: isAutoReplyEnabled, currentMsg: autoReplyMessage, storage: useMongo ? 'mongodb' : 'local' });
});
app.get('/api/sessions', (req, res) => res.json({ sessions: listSessionsPublic() }));
app.post('/api/sessions/create', async (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : ''; const id = 'wa_' + Date.now();
    const displayName = name || ('WhatsApp ' + (sessions.size + 1));
    const meta = { ...getMeta() }; if (!meta.sessions) meta.sessions = []; meta.sessions.push({ id, name: displayName });
    await persist('meta', meta); await startSession(id, displayName);
    res.json({ success: true, session: { id, name: displayName } });
});
app.post('/api/sessions/delete', async (req, res) => {
    const id = req.body && req.body.id; if (!id || !sessions.has(id)) return res.status(400).json({ success: false, error: 'Session not found' });
    const s = sessions.get(id); try { if (s.sock) s.sock.end(); } catch (e) {} sessions.delete(id);
    await clearSessionAuth(id);
    const meta = { ...getMeta() }; meta.sessions = (meta.sessions || []).filter(x => x.id !== id); await persist('meta', meta);
    res.json({ success: true });
});
app.post('/pair-code', async (req, res) => {
    try {
        let { phone, sessionId, fresh } = req.body || {};
        phone = String(phone || '').replace(/\D/g, '');
        if (phone.startsWith('0')) phone = phone.slice(1); if (phone.length === 10) phone = '91' + phone;
        if (!phone || phone.length < 12) return res.status(400).json({ success: false, error: 'Sahi 10-digit Indian number daalo.' });
        
        let s = sessionId ? getSession(sessionId) : (Array.from(sessions.values()).find(x => x.sock && !x.connected) || Array.from(sessions.values()).find(x => x.sock));
        if (!s) return res.status(400).json({ success: false, error: 'Session nahi mili.' });
        if (s.connected) return res.status(400).json({ success: false, error: `Already connected.` });

        if (fresh || req.body.forceFresh) {
            try { if (s.sock) s.sock.end(undefined); } catch (e) {}
            await clearSessionAuth(s.id);
            await startSession(s.id, s.name);
            for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); s = getSession(sessionId || s.id); if (s && s.sock && (s.qrCode || !s.connected)) break; }
        }
        s = getSession(s.id); if (!s || !s.sock) return res.status(400).json({ success: false, error: 'Socket ready nahi.' });
        await new Promise(r => setTimeout(r, 1500));
        
        const code = await s.sock.requestPairingCode(phone);
        const raw = String(code || '').replace(/\s/g, '');
        res.json({ success: true, code: raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw, raw: raw, phoneUsed: phone, sessionId: s.id, sessionName: s.name });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'Pairing fail.' }); }
});

// Boot
(async () => {
    await initMongo();
    await bootstrapSessions();
    app.listen(process.env.PORT || 10000, '0.0.0.0', () => {
        console.log(`Server started | Storage: ${useMongo ? 'MongoDB ✅' : 'Local files ⚠️'}`);
    });
})();
