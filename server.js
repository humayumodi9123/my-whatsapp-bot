const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

// Render crash prevent — Baileys errors process ko kill na karein
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.message ? err.message : err);
});

let MongoClient = null;
try { MongoClient = require('mongodb').MongoClient; } catch (e) { console.log('mongodb package not installed'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const sessions = new Map();
const deletedSessionIds = new Set(); // user-deleted — reconnect mat karo
const SESSION_BATCH = 30;          
const SESSION_REST_MS = 2 * 60 * 60 * 1000;
let skipSleepUntil = 0;

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

function getSelectedOrRandomSock(sessionIds) {
    let activeSessions = Array.from(sessions.values()).filter(s => s.connected && s.sock);
    if (sessionIds && sessionIds.length > 0) {
        let filtered = activeSessions.filter(s => sessionIds.includes(s.id));
        if (filtered.length > 0) activeSessions = filtered;
    }
    if (activeSessions.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * activeSessions.length);
    return activeSessions[randomIndex].sock;
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
        cache.contacts = getJsonFile(contactsFile) || {}; cache.templates = getJsonFile(templatesFile) || [];
        cache.history = getJsonFile(historyFile) || []; cache.stats = getJsonFile(statsFile) || {}; cache.meta = getJsonFile(connectionMetaFile) || {};
        return;
    }
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db('whatsapp_bot');
        useMongo = true;

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
    } catch (e) { useMongo = false; }
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
function addHistory(number, messageSent, sessionName) {
    const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let list = getHistory(); 
    list.push({ number: number, message: messageSent, session: sessionName || 'Unknown', date: istTime });
    if (list.length > 50000) list = list.slice(-50000);
    persist('history', list);
}

function getTemplates() { return cache.templates || []; }
function getContacts() { return cache.contacts || {}; }
function getMeta() { return cache.meta || {}; }

let liveCampaign = {
    isActive: false, isPaused: false, total: 0, sent: 0, failed: 0, pending: 0, numbers: [],
    status: 'idle', restReason: '', resumeAt: null, batchSize: 50, accountAgeDays: 0
};

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

function getGroupScanStats(groupContacts) {
    const list = groupContacts || [];
    let pending = 0, valid = 0, invalid = 0;
    list.forEach(c => {
        if (c.waStatus === 'valid') valid++;
        else if (c.waStatus === 'invalid') invalid++;
        else pending++;
    });
    return { total: list.length, valid, invalid, pending, scanned: valid + invalid };
}

function getScanSocks(sessionIds) {
    let list = Array.from(sessions.values()).filter(s => s.connected && s.sock);
    if (sessionIds && sessionIds.length > 0) {
        const filtered = list.filter(s => sessionIds.includes(s.id));
        if (filtered.length) list = filtered;
    }
    return list;
}

async function checkOneNumberOnWA(phone10, sessionIds, preferredSock) {
    const sock = preferredSock || getSelectedOrRandomSock(sessionIds);
    if (!sock) return false;
    try {
        const r = await sock.onWhatsApp('91' + phone10 + '@s.whatsapp.net');
        return Array.isArray(r) && r[0] && r[0].exists !== false;
    } catch (e) { return false; }
}

function scanDelayMs(waCount) {
    // Multi WA: 2–3 sec | Single WA: 2.5–5 sec (random)
    if (waCount >= 2) return 2000 + Math.floor(Math.random() * 1001);
    return 2500 + Math.floor(Math.random() * 2501);
}

let autoScanRunning = false;
async function runAutoScanTick() {
    if (autoScanRunning || !anyConnected() || (liveCampaign && liveCampaign.isActive)) return;
    const ist = getISTNow();
    if (ist.getHours() < 8 || ist.getHours() >= 22) {
        if (Date.now() > skipSleepUntil) return;
    }

    const dailyLimit = getDailyScanLimit();
    const used = getTodayScanCount();
    if (used >= dailyLimit) return;

    const chunk = Math.min(10, dailyLimit - used);
    const contacts = getContacts();
    const pendingItems = [];
    Object.keys(contacts).forEach(g => {
        (contacts[g] || []).forEach((c, idx) => {
            if (!c.waStatus || c.waStatus === 'pending') pendingItems.push({ group: g, index: idx, contact: c });
        });
    });
    if (pendingItems.length === 0) return;

    autoScanRunning = true;
    let scannedNow = 0;
    try {
        for (const item of pendingItems.slice(0, chunk)) {
            const phone = String(item.contact.phone || '').replace(/\D/g, '').slice(-10);
            if (phone.length !== 10) { contacts[item.group][item.index].waStatus = 'invalid'; scannedNow++; continue; }
            const ok = await checkOneNumberOnWA(phone, []);
            contacts[item.group][item.index].waStatus = ok ? 'valid' : 'invalid';
            contacts[item.group][item.index].phone = phone;
            scannedNow++;
            await new Promise(r => setTimeout(r, 2500));
        }
        if (scannedNow > 0) { addTodayScanCount(scannedNow); await persist('contacts', contacts); }
    } catch (e) {} finally { autoScanRunning = false; }
}

function msUntilNext8AM_IST() {
    const ist = getISTNow(); const h = ist.getHours(), m = ist.getMinutes(), s = ist.getSeconds();
    const msSinceMidnight = ((h * 60 + m) * 60 + s) * 1000;
    const eightAM = 8 * 60 * 60 * 1000;
    if (h >= 8 && h < 22) return 0;
    if (h < 8) return eightAM - msSinceMidnight;
    return (24 * 60 * 60 * 1000 - msSinceMidnight) + eightAM;
}

async function smartSleep(ms, reason) {
    const resumeAt = new Date(Date.now() + ms);
    liveCampaign.status = (reason.includes('Night')) ? 'night_rest' : 'resting';
    liveCampaign.restReason = reason; liveCampaign.resumeAt = resumeAt.toISOString();
    let left = ms;
    while (left > 0) {
        await new Promise(r => setTimeout(r, Math.min(5000, left)));
        if (reason.includes('Night') && Date.now() < skipSleepUntil) {
            break;
        }
        left = resumeAt.getTime() - Date.now();
        liveCampaign.resumeAt = new Date(Date.now() + left).toISOString();
    }
    liveCampaign.status = 'sending'; liveCampaign.restReason = ''; liveCampaign.resumeAt = null;
}
async function waitForSendWindow() { 
    if (Date.now() < skipSleepUntil) return; 
    const waitMs = msUntilNext8AM_IST(); 
    if (waitMs > 0) await smartSleep(waitMs, 'Night Rest (10 PM – 8 AM IST)'); 
}

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
                        await Promise.all(ids.map(async id => { let value = await readData(`${type}-${id}`); data[id] = value; }));
                        return data;
                    },
                    set: async (data) => {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id]; const key = `${category}-${id}`;
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

async function startSession(sessionId, sessionName) {
    if (deletedSessionIds.has(sessionId)) {
        console.log(`[${sessionId}] skip start — user deleted`);
        return;
    }
    const { state, saveCreds } = await getAuthState(sessionId);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });

    const session = sessions.get(sessionId) || {
        id: sessionId, name: sessionName || sessionId, sock: null, connected: false,
        qrCode: null, restUntil: null, sentInBatch: 0, batchSize: SESSION_BATCH
    };
    session.sock = sock; session.name = sessionName || session.name; sessions.set(sessionId, session);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
        const s = sessions.get(sessionId);
        if (!s) return;
        if (qr) {
            try { s.qrCode = await qrcode.toDataURL(qr); } catch (e) {}
        }
        if (connection === 'close') {
            s.connected = false;
            if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`[${sessionId}] connection close code=${code}`);
            if (code === DisconnectReason.loggedOut) {
                try { await clearSessionAuth(sessionId); } catch (e) {}
                s.qrCode = null;
            }
            const delay = (code === 440 || code === DisconnectReason.connectionReplaced) ? 8000 : 4000;
            if (!s._reconnectTimer && !deletedSessionIds.has(sessionId) && sessions.has(sessionId)) {
                s._reconnectTimer = setTimeout(() => {
                    s._reconnectTimer = null;
                    if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
                    startSession(sessionId, s.name).catch(() => {});
                }, delay);
            }
        } else if (connection === 'open') {
            if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
            s.connected = true; s.qrCode = null;
            const meta = { ...getMeta() };
            if (!meta.firstConnectedAt) { meta.firstConnectedAt = new Date().toISOString(); persist('meta', meta); }
            if (!meta.sessions) meta.sessions = [];
            // Sirf tab add karo jab meta mein pehle se planned session ho / create API se aaya ho
            if (!meta.sessions.find(x => x.id === sessionId)) {
                meta.sessions.push({ id: sessionId, name: s.name });
                persist('meta', meta);
            }
        }
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' || !isAutoReplyEnabled) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const phone = jid.split('@')[0];
        const histList = getHistory();
        if (!histList.find(c => c.number === phone)) return;
        const messageType = Object.keys(msg.message)[0];
        let text = messageType === 'conversation' ? msg.message.conversation.trim().toLowerCase() : (messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text.trim().toLowerCase() : '');
        try {
            if (text === 'hi' || text === 'hello' || text === 'menu') await sock.sendMessage(jid, { text: autoReplyMessage });
            else if (text === '1') await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
            else if (text === '2') await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
            else if (text === '3') await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
        } catch (e) {}
    });
}

async function bootstrapSessions() {
    const meta = getMeta();
    let list = (meta.sessions && meta.sessions.length) ? meta.sessions : [{ id: 'wa_1', name: 'WhatsApp 1' }];
    if (!list.length) list = [{ id: 'wa_1', name: 'WhatsApp 1' }];
    // Ek saath saari sessions mat kholo — conflict kam
    for (const item of list) {
        try {
            await startSession(item.id, item.name);
        } catch (e) {
            console.error('bootstrap session fail', item.id, e.message);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}

app.get('/status', (req, res) => {
    const list = listSessionsPublic(); const primary = list.find(s => s.connected) || list[0] || null;
    res.json({ connected: anyConnected(), qrCode: primary && !primary.connected ? primary.qrCode : null, sessions: list, autoReply: isAutoReplyEnabled, currentMsg: autoReplyMessage, storage: useMongo ? 'mongodb' : 'local' });
});

app.get('/api/sessions', (req, res) => res.json({ sessions: listSessionsPublic() }));

app.post('/api/sessions/create', async (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : ''; const id = 'wa_' + Date.now();
    const displayName = name || ('WhatsApp ' + (sessions.size + 1));
    deletedSessionIds.delete(id);
    const meta = { ...getMeta() }; if (!meta.sessions) meta.sessions = []; meta.sessions.push({ id, name: displayName });
    await persist('meta', meta); await startSession(id, displayName);
    res.json({ success: true, session: { id, name: displayName } });
});

app.post('/api/sessions/delete', async (req, res) => {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ success: false, error: 'Session id missing' });
    deletedSessionIds.add(id);
    const s = sessions.get(id);
    if (s) {
        try { if (s._reconnectTimer) clearTimeout(s._reconnectTimer); } catch (e) {}
        s._reconnectTimer = null;
        try { if (s.sock) s.sock.end(undefined); } catch (e) {}
    }
    sessions.delete(id);
    try { await clearSessionAuth(id); } catch (e) {}
    const meta = { ...getMeta() };
    meta.sessions = (meta.sessions || []).filter(x => x.id !== id);
    await persist('meta', meta);
    res.json({ success: true });
});

app.post('/toggle-autoreply', (req, res) => { isAutoReplyEnabled = req.body.enabled; res.json({ success: true }); });
app.post('/update-autoreply', (req, res) => { autoReplyMessage = req.body.message; res.json({ success: true }); });
app.get('/api/stats', (req, res) => { const stats = getStats(); const date = req.query.date; res.json(date ? (stats[date] || { sent: 0, failed: 0 }) : { sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) }); });
app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/live-status', (req, res) => res.json({ ...liveCampaign, sleepDisabled: Date.now() < skipSleepUntil }));

// 🌟 NEW: Campaign Pause/Resume Toggle API
app.post('/api/toggle-pause', (req, res) => {
    liveCampaign.isPaused = !!req.body.pause;
    if (liveCampaign.isPaused) {
        liveCampaign.status = 'paused';
        liveCampaign.restReason = '🛑 Campaign Paused by User';
    } else {
        liveCampaign.status = 'sending';
        liveCampaign.restReason = '';
    }
    res.json({ success: true, isPaused: liveCampaign.isPaused });
});

app.post('/api/toggle-sleep', (req, res) => {
    const { disable } = req.body;
    if (disable) {
        skipSleepUntil = Date.now() + (14 * 60 * 60 * 1000); 
    } else {
        skipSleepUntil = 0;
    }
    res.json({ success: true, sleepDisabled: disable });
});

app.get('/api/templates', (req, res) => res.json(getTemplates()));
app.post('/api/templates', async (req, res) => {
    const t = getTemplates(); t.push(req.body); await persist('templates', t); res.json({ success: true });
});
app.post('/api/templates/delete', async (req, res) => {
    let t = getTemplates().filter(x => x.id !== req.body.id); await persist('templates', t); res.json({ success: true });
});

app.get('/api/contacts', (req, res) => res.json(getContacts()));
app.post('/api/contacts', async (req, res) => {
    const body = req.body || {};
    Object.keys(body).forEach(g => {
        if (!Array.isArray(body[g])) return;
        body[g] = body[g].map(c => ({
            name: c.name || 'Customer',
            phone: String(c.phone || '').replace(/\D/g, '').slice(-10),
            waStatus: c.waStatus === 'valid' || c.waStatus === 'invalid' || c.waStatus === 'pending' ? c.waStatus : (c.waStatus || null)
        }));
    });
    await persist('contacts', body);
    res.json({ success: true });
});

// Invalid numbers permanently remove (server-side — poll se wapas nahi aayenge)
app.post('/api/contacts/remove-invalid', async (req, res) => {
    const group = req.body && req.body.group;
    const contacts = { ...getContacts() };
    if (!group || !Array.isArray(contacts[group])) {
        return res.status(400).json({ success: false, error: 'Group select karo' });
    }
    const before = contacts[group].length;
    contacts[group] = contacts[group].filter(c => c.waStatus !== 'invalid');
    const removed = before - contacts[group].length;
    await persist('contacts', contacts);
    res.json({
        success: true,
        removed,
        remaining: contacts[group].length,
        contacts
    });
});

app.get('/api/scan-progress', (req, res) => {
    const contacts = getContacts(); const groups = {};
    Object.keys(contacts).forEach(g => { groups[g] = getGroupScanStats(contacts[g]); });
    res.json({ groups, todayScanned: getTodayScanCount(), dailyScanLimit: getDailyScanLimit(), accountAgeDays: getAccountAgeDays(), autoScan: true, window: '8 AM – 10 PM IST' });
});

app.post('/api/scan-next', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp connect nahi hai' });
    const { group, sessionIds, scanAll } = req.body || {};
    const contacts = getContacts();
    if (!group || !contacts[group]) return res.status(400).json({ success: false, error: 'Group select karo' });

    const socks = getScanSocks(sessionIds);
    if (!socks.length) return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });

    const activeWaCount = socks.length;
    // Scan All Pending: daily 80 limit NAHI — sab pending numbers bari-bari
    // Manual "Scan next 10": daily limit apply
    const dailyLimit = getDailyScanLimit() * activeWaCount;
    const used = getTodayScanCount();
    if (!scanAll && used >= dailyLimit) {
        return res.status(400).json({
            success: false,
            error: `Aaj ki limit (${dailyLimit}) puri. "Scan All Pending" se bina limit scan kar sakte ho (gaps + multi-WA rules lagte rahenge).`,
            todayScanned: used,
            dailyScanLimit: dailyLimit
        });
    }

    // Scan All: 5/batch (lamba request = mobile/Render network error)
    // Manual Scan next: max 10
    const chunk = scanAll ? 5 : Math.min(10, Math.max(1, dailyLimit - used));
    let scanned = 0, valid = 0, invalid = 0;
    let rr = 0; // round-robin: eak ke baad eak WhatsApp

    for (let i = 0; i < contacts[group].length && scanned < chunk; i++) {
        const c = contacts[group][i];
        if (c.waStatus === 'valid' || c.waStatus === 'invalid') continue;

        const phone = String(c.phone || '').replace(/\D/g, '').slice(-10);
        const sObj = socks[rr % socks.length];
        rr++;
        const ok = phone.length === 10
            ? await checkOneNumberOnWA(phone, sessionIds, sObj.sock)
            : false;

        contacts[group][i].waStatus = ok ? 'valid' : 'invalid';
        contacts[group][i].phone = phone;
        if (ok) valid++; else invalid++;
        scanned++;

        // Random gap: multi 2–3s | single 2.5–5s (series feel na aaye)
        const delay = scanDelayMs(activeWaCount);
        await new Promise(r => setTimeout(r, delay));
    }

    if (scanned > 0) {
        addTodayScanCount(scanned);
        await persist('contacts', contacts);
    }
    res.json({
        success: true,
        scanned,
        valid,
        invalid,
        todayScanned: getTodayScanCount(),
        dailyScanLimit: scanAll ? null : dailyLimit,
        unlimited: !!scanAll,
        waUsed: activeWaCount,
        delayMode: activeWaCount >= 2 ? '2-3s multi-WA' : '2.5-5s single-WA',
        groupStats: getGroupScanStats(contacts[group])
    });
});

app.post('/pair-code', async (req, res) => {
    try {
        let { phone, sessionId, fresh } = req.body || {};
        phone = String(phone || '').replace(/\D/g, '');
        if (phone.startsWith('0')) phone = phone.slice(1); if (phone.length === 10) phone = '91' + phone;
        if (!phone || phone.length < 12) return res.status(400).json({ success: false, error: 'Sahi 10-digit Indian number daalo.' });
        
        let s = sessionId ? getSession(sessionId) : (Array.from(sessions.values()).find(x => x.sock && !x.connected) || Array.from(sessions.values()).find(x => x.sock));
        if (!s) return res.status(400).json({ success: false, error: 'Session nahi mili. Pehle + Add WhatsApp karo.' });
        if (s.connected) return res.status(400).json({ success: false, error: `Already connected.` });

        if (fresh || req.body.forceFresh) {
            try { if (s.sock) s.sock.end(undefined); } catch (e) {}
            await clearSessionAuth(s.id);
            await startSession(s.id, s.name);
            for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); s = getSession(sessionId || s.id); if (s && s.sock && (s.qrCode || !s.connected)) break; }
        }
        s = getSession(s.id); if (!s || !s.sock) return res.status(400).json({ success: false, error: 'Socket ready nahi — 5 sec baad phir try.' });
        await new Promise(r => setTimeout(r, 1500));
        
        const code = await s.sock.requestPairingCode(phone);
        const raw = String(code || '').replace(/\s/g, '');
        res.json({ success: true, code: raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw, raw: raw, phoneUsed: phone, sessionId: s.id, sessionName: s.name });
    } catch (e) { res.status(500).json({ success: false, error: e.message || 'Pairing fail.' }); }
});

app.post('/api/validate-numbers', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है! Pehle device connect karo.' });
    let raw = req.body.numbers || []; if (!Array.isArray(raw) || raw.length === 0) return res.json({ success: true, valid: [], invalid: 0, duplicatesRemoved: 0, total: 0 });
    if (raw.length > 10) return res.status(400).json({ success: false, error: `Anti-Ban: ek baar mein max 10 numbers scan allowed.`, maxAllowed: 10, received: raw.length });

    const seen = new Map(); let duplicatesRemoved = 0;
    for (const item of raw) {
        let phoneStr = typeof item === 'string' ? item : String(item.phone || ''); let name = typeof item === 'object' && item.name ? String(item.name).trim() : 'Customer';
        let digits = phoneStr.replace(/\D/g, ''); if (digits.length < 10) continue;
        let last10 = digits.slice(-10); if (!/^[6-9]\d{9}$/.test(last10)) continue;
        if (seen.has(last10)) { duplicatesRemoved++; continue; }
        seen.set(last10, { phone: last10, name: name || 'Customer' });
    }
    const uniqueList = Array.from(seen.values()); const valid = []; let invalidCount = 0;
    for (let i = 0; i < uniqueList.length; i += 5) {
        const batch = uniqueList.slice(i, i + 5);
        try {
            const jids = batch.map(c => '91' + c.phone + '@s.whatsapp.net'); 
            const _sock = getSelectedOrRandomSock([]); 
            if (!_sock) throw new Error('no sock');
            const results = await _sock.onWhatsApp(...jids);
            const existSet = new Set();
            if (Array.isArray(results)) results.forEach(r => { if (r && (r.exists === true || r.exists === undefined) && r.jid) existSet.add(String(r.jid).split('@')[0].replace(/\D/g, '').slice(-10)); });
            batch.forEach(c => { if (existSet.has(c.phone)) valid.push(c); else invalidCount++; });
        } catch (e) {
            for (const c of batch) {
                try { const ok = await checkOneNumberOnWA(c.phone, []); if (ok) valid.push(c); else invalidCount++; } catch (e2) { invalidCount++; }
            }
        }
        if (i + 5 < uniqueList.length) await new Promise(r => setTimeout(r, 2000));
    }
    res.json({ success: true, valid, invalid: invalidCount, duplicatesRemoved, total: raw.length, validCount: valid.length });
});

app.post('/send', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    const { numbers, message, minDelay, maxDelay, imageBase64, templates, sessionIds, customBatch, customRestHours } = req.body;
    if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ success: false, error: 'Number list empty!' });

    let selectedIds = Array.isArray(sessionIds) && sessionIds.length ? sessionIds : Array.from(sessions.values()).filter(s => s.connected).map(s => s.id);
    selectedIds = selectedIds.filter(id => { const s = getSession(id); return s && s.connected && s.sock; });
    if (!selectedIds.length) return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });

    const seenPhone = new Set(); let uniqueNumbers = [];
    for (const n of numbers) {
        const p = String(n.phone || '').replace(/\D/g, '').slice(-10);
        if (p.length === 10 && !seenPhone.has(p)) { seenPhone.add(p); uniqueNumbers.push({ phone: p, name: n.name || 'Customer' }); }
    }

    // Daily limit always applies (80 / WA etc.) — custom batch se bypass nahi
    const dailyLimit = getDailyLimit() * selectedIds.length; const alreadySent = getTodaySentCount();
    if (alreadySent >= dailyLimit) return res.status(400).json({ success: false, error: `Anti-Ban: aaj ka limit (${dailyLimit}) pure. Kal try karo.` });
    const remainingQuota = dailyLimit - alreadySent; if (uniqueNumbers.length > remainingQuota) uniqueNumbers = uniqueNumbers.slice(0, remainingQuota);

    // Custom batch / rest — empty = default 30 / 2hr
    let batchSize = SESSION_BATCH;
    let restMs = SESSION_REST_MS;
    const cb = parseInt(customBatch, 10);
    const cr = parseFloat(customRestHours);
    if (!isNaN(cb) && cb >= 1) batchSize = Math.min(50, Math.max(1, cb));
    if (!isNaN(cr) && cr > 0) restMs = Math.min(12, Math.max(0.25, cr)) * 60 * 60 * 1000;
    const restHoursLabel = (restMs / (60 * 60 * 1000)).toFixed(restMs % 3600000 === 0 ? 0 : 2);

    const useRotation = Array.isArray(templates) && templates.length > 0; let tplIndex = 0;

    liveCampaign = {
        isActive: true, isPaused: false, total: uniqueNumbers.length, dailyLimit, alreadySentToday: alreadySent, sent: 0, failed: 0, pending: uniqueNumbers.length,
        numbers: uniqueNumbers.map(n => ({
            phone: n.phone,
            name: n.name || 'Customer',
            status: 'Pending ⏳',
            state: 'pending',
            session: null,
            template: null
        })),
        status: 'sending', restReason: '', resumeAt: null, batchSize, restHours: restHoursLabel, accountAgeDays: getAccountAgeDays(),
        sessions: selectedIds.map(id => { const s = getSession(id); return { id, name: s.name, resting: false }; })
    };
    res.json({ success: true, willSend: uniqueNumbers.length, sessions: selectedIds.length, batchPerSession: batchSize, restHours: restHoursLabel });

    const minD = Math.max(45, parseInt(minDelay) || 45); const maxD = Math.max(minD + 15, parseInt(maxDelay) || 90);
    const queue = uniqueNumbers.map((n, idx) => ({ ...n, idx }));

    async function sessionWorker(sessionId) {
        const s = getSession(sessionId); if (!s) return;
        while (queue.length > 0) {
            
            // 🌟 NEW: Campaign Pause Check before sleeping/sending
            while (liveCampaign.isPaused) {
                liveCampaign.status = 'paused';
                liveCampaign.restReason = '🛑 Campaign Stop/Paused (User)';
                await new Promise(r => setTimeout(r, 2000));
            }

            while (s.restUntil && Date.now() < s.restUntil) {
                const left = s.restUntil - Date.now();
                liveCampaign.status = 'resting'; liveCampaign.restReason = `${s.name}: ${restHoursLabel}hr rest after ${batchSize} msgs`; liveCampaign.resumeAt = new Date(s.restUntil).toISOString();
                await new Promise(r => setTimeout(r, Math.min(5000, left)));
            }
            if (!s.connected || !s.sock) { await new Promise(r => setTimeout(r, 5000)); continue; }
            await waitForSendWindow();
            liveCampaign.status = 'sending'; liveCampaign.restReason = ''; liveCampaign.resumeAt = null;

            let batchCount = 0;
            while (batchCount < batchSize && queue.length > 0) {
                
                // 🌟 NEW: Check Pause inside the message sending batch
                while (liveCampaign.isPaused) {
                    liveCampaign.status = 'paused';
                    liveCampaign.restReason = '🛑 Campaign Stop/Paused (User)';
                    await new Promise(r => setTimeout(r, 2000));
                }

                if (!s.connected || !s.sock) break; if (s.restUntil && Date.now() < s.restUntil) break;
                const item = queue.shift(); if (!item) break;
                let num = item.phone; const customerName = item.name || 'Customer'; const idx = item.idx;

                try {
                    if (!num.startsWith('91')) num = '91' + num; const jid = num + '@s.whatsapp.net';
                    let finalMessage = ''; let finalImageBase64 = null; let tplName = '';
                    let buttons = [];
                    if (useRotation) {
                        const tpl = templates[tplIndex % templates.length]; tplIndex++; tplName = tpl.name || '';
                        finalMessage = (tpl.message || '').replace(/\[Name\]/gi, customerName); finalImageBase64 = tpl.imageBase64 || null;
                        buttons = Array.isArray(tpl.buttons) ? tpl.buttons : [];
                    } else {
                        finalMessage = message ? message.replace(/\[Name\]/gi, customerName) : ''; finalImageBase64 = imageBase64 || null;
                    }

                    // Action buttons → message footer (Call / Link / Reply) — har device pe dikhe
                    if (buttons.length) {
                        const lines = ['', '────────────'];
                        buttons.forEach(b => {
                            const label = (b.text || '').trim();
                            const val = (b.value || '').trim();
                            if (!label || !val) return;
                            if (b.type === 'call') lines.push('📞 *' + label + '*\n' + val);
                            else if (b.type === 'url') lines.push('🔗 *' + label + '*\n' + val);
                            else lines.push('💬 *' + label + '*\nReply: ' + val);
                        });
                        finalMessage = (finalMessage || '') + lines.join('\n');
                    }

                    let messageOptions;
                    if (finalImageBase64) {
                        const base64Data = finalImageBase64.includes(',') ? finalImageBase64.split(',')[1] : finalImageBase64;
                        messageOptions = { image: Buffer.from(base64Data, 'base64'), caption: finalMessage };
                    } else messageOptions = { text: finalMessage || ' ' };

                    await s.sock.sendMessage(jid, messageOptions);

                    // Try native-style buttons (optional — kuch accounts pe dikhte hain)
                    if (buttons.length) {
                        try {
                            const nativeBtns = buttons.slice(0, 3).map((b, i) => ({
                                buttonId: 'btn_' + i + '_' + (b.type || 'reply'),
                                buttonText: { displayText: String(b.text || '').slice(0, 20) },
                                type: 1
                            }));
                            if (nativeBtns.length) {
                                await s.sock.sendMessage(jid, {
                                    text: 'Quick actions:',
                                    footer: 'Tap a option or use links above',
                                    buttons: nativeBtns,
                                    headerType: 1
                                });
                            }
                        } catch (btnErr) { /* ignore — text buttons already in caption */ }
                    }
                    liveCampaign.sent++; liveCampaign.pending = Math.max(0, liveCampaign.pending - 1);
                    if (liveCampaign.numbers[idx]) {
                        liveCampaign.numbers[idx].status = 'Sent ✅ (' + s.name + (tplName ? ' / ' + tplName : '') + ')';
                        liveCampaign.numbers[idx].state = 'sent';
                        liveCampaign.numbers[idx].session = s.name;
                        liveCampaign.numbers[idx].template = tplName || (finalImageBase64 ? 'Media' : 'Message');
                    }
                    addHistory(num, finalMessage || 'Media Sent', s.name + (tplName ? ' | ' + tplName : ''));
                    saveStats(new Date().toLocaleDateString('en-CA'), 1, 0);
                    batchCount++; s.sentInBatch = batchCount;

                    const delayMs = (Math.floor(Math.random() * (maxD - minD + 1)) + minD) * 1000;
                    await new Promise(r => setTimeout(r, delayMs));
                } catch (e) {
                    liveCampaign.failed++; liveCampaign.pending = Math.max(0, liveCampaign.pending - 1);
                    if (liveCampaign.numbers[idx]) {
                        liveCampaign.numbers[idx].status = 'Failed ❌ (' + s.name + ')';
                        liveCampaign.numbers[idx].state = 'failed';
                        liveCampaign.numbers[idx].session = s.name;
                        liveCampaign.numbers[idx].template = null;
                    }
                    saveStats(new Date().toLocaleDateString('en-CA'), 0, 1); batchCount++; s.sentInBatch = batchCount;
                }
            }
            if (batchCount >= batchSize && queue.length > 0) {
                s.restUntil = Date.now() + restMs; s.sentInBatch = 0;
                liveCampaign.status = 'resting'; liveCampaign.restReason = `${s.name}: ${batchSize} msgs done → ${restHoursLabel}hr rest. Doosre WA se continue...`; liveCampaign.resumeAt = new Date(s.restUntil).toISOString();
            } else if (queue.length === 0) break;
        }
    }

    await Promise.all(selectedIds.map(id => sessionWorker(id)));
    liveCampaign.isActive = false; liveCampaign.status = 'idle'; liveCampaign.restReason = ''; liveCampaign.resumeAt = null;
});

(async () => {
    try {
        await initMongo();
    } catch (e) {
        console.error('initMongo error', e.message);
    }
    // Pehle HTTP listen — Render health check pass
    const port = process.env.PORT || 10000;
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server started on ${port} | Storage: ${useMongo ? 'MongoDB ✅' : 'Local files ⚠️'}`);
        setInterval(() => { runAutoScanTick().catch(() => {}); }, 3 * 60 * 1000);
    });
    // WhatsApp sessions background mein
    bootstrapSessions().catch(e => console.error('bootstrap error', e.message));
})();
