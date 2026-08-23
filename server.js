const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
// Mongo optional — package na ho to bhi server chalega (local JSON files)
let MongoClient = null;
try { MongoClient = require('mongodb').MongoClient; } catch (e) { console.log('mongodb package not installed — using local files only'); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ---------- Multi WhatsApp Sessions ----------
// sessions: Map id -> { id, name, sock, connected, qrCode, restUntil, sentInBatch, batchSize, authDir }
const sessions = new Map();
const SESSION_BATCH = 30;          // msgs per WA then 2hr rest
const SESSION_REST_MS = 2 * 60 * 60 * 1000;

let isAutoReplyEnabled = true;
let autoReplyMessage = `🌟 Welcome! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करने के लिए`;

function listSessionsPublic() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        name: s.name,
        connected: !!s.connected,
        qrCode: s.qrCode || null,
        restUntil: s.restUntil || null,
        resting: !!(s.restUntil && Date.now() < s.restUntil),
        sentInBatch: s.sentInBatch || 0,
        batchSize: s.batchSize || SESSION_BATCH
    }));
}
function anyConnected() {
    return Array.from(sessions.values()).some(s => s.connected && s.sock);
}
function getFirstConnectedSock() {
    for (const s of sessions.values()) {
        if (s.connected && s.sock) return s.sock;
    }
    return null;
}
function getSession(id) {
    return sessions.get(id) || null;
}

// Local file fallbacks (used only if MongoDB not configured)
const statsFile = __dirname + '/stats.json';
const historyFile = __dirname + '/history.json';
const templatesFile = __dirname + '/templates.json';
const contactsFile = __dirname + '/contacts.json';
const connectionMetaFile = __dirname + '/connection_meta.json';

// ---------- MongoDB Persistent Store ----------
const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient = null;
let db = null;
let useMongo = false;

// In-memory cache (synced to Mongo or files)
let cache = {
    contacts: {},
    templates: [],
    history: [],
    stats: {},
    meta: {}
};

async function initMongo() {
    if (!MONGODB_URI || !MongoClient) {
        console.log('⚠️ MongoDB not used — local JSON files (data may reset on Render restart)');
        cache.contacts = getJsonFile(contactsFile) || {};
        cache.templates = getJsonFile(templatesFile) || [];
        cache.history = getJsonFile(historyFile) || [];
        cache.stats = getJsonFile(statsFile) || {};
        cache.meta = getJsonFile(connectionMetaFile) || {};
        return;
    }
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db('whatsapp_bot');
        useMongo = true;
        console.log('✅ MongoDB connected — data will persist across restarts');

        // Load all into cache
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

        // One-time migrate from local files if mongo empty
        if (Object.keys(cache.contacts).length === 0 && fs.existsSync(contactsFile)) {
            cache.contacts = getJsonFile(contactsFile) || {};
            await persist('contacts', cache.contacts);
        }
        if (cache.templates.length === 0 && fs.existsSync(templatesFile)) {
            cache.templates = getJsonFile(templatesFile) || [];
            await persist('templates', cache.templates);
        }
        if (cache.history.length === 0 && fs.existsSync(historyFile)) {
            cache.history = getJsonFile(historyFile) || [];
            await persist('history', cache.history);
        }
        if (Object.keys(cache.stats).length === 0 && fs.existsSync(statsFile)) {
            cache.stats = getJsonFile(statsFile) || {};
            await persist('stats', cache.stats);
        }
        if (!cache.meta.firstConnectedAt && fs.existsSync(connectionMetaFile)) {
            cache.meta = getJsonFile(connectionMetaFile) || {};
            await persist('meta', cache.meta);
        }
    } catch (e) {
        console.error('❌ MongoDB connect failed, falling back to files:', e.message);
        useMongo = false;
        cache.contacts = getJsonFile(contactsFile) || {};
        cache.templates = getJsonFile(templatesFile) || [];
        cache.history = getJsonFile(historyFile) || [];
        cache.stats = getJsonFile(statsFile) || {};
        cache.meta = getJsonFile(connectionMetaFile) || {};
    }
}

async function persist(key, data) {
    cache[key] = data;
    if (useMongo && db) {
        try {
            await db.collection(key).updateOne(
                { _id: 'main' },
                { $set: { data, updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (e) {
            console.error('Mongo persist error:', key, e.message);
        }
    } else {
        const map = {
            contacts: contactsFile,
            templates: templatesFile,
            history: historyFile,
            stats: statsFile,
            meta: connectionMetaFile
        };
        if (map[key]) saveJsonFile(map[key], data);
    }
}

function getJsonFile(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch(e) { return null; } }
function saveJsonFile(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {} }

// Sync wrappers used by rest of app
function getStats() { return cache.stats || {}; }
function saveStats(date, sent, failed) {
    const stats = getStats();
    if (!stats[date]) stats[date] = { sent: 0, failed: 0 };
    stats[date].sent += sent;
    stats[date].failed += failed;
    persist('stats', stats); // fire-and-forget async
}
function getHistory() { return cache.history || []; }
function addHistory(number, messageSent) {
    let list = getHistory();
    list.push({ number: number, message: messageSent, date: new Date().toLocaleString('en-IN') });
    // keep last 50000 entries max
    if (list.length > 50000) list = list.slice(-50000);
    persist('history', list);
}
function getTemplates() { return cache.templates || []; }
function getContacts() { return cache.contacts || {}; }
function getMeta() { return cache.meta || {}; }

let liveCampaign = {
    isActive: false,
    total: 0,
    sent: 0,
    failed: 0,
    pending: 0,
    numbers: [],
    status: 'idle',
    restReason: '',
    resumeAt: null,
    batchSize: 50,
    accountAgeDays: 0
};

// --- Time helpers (IST = Asia/Kolkata) ---
function getISTNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
function getAccountAgeDays() {
    const meta = getMeta();
    if (!meta || !meta.firstConnectedAt) return 0;
    const first = new Date(meta.firstConnectedAt);
    const now = new Date();
    return Math.floor((now - first) / (1000 * 60 * 60 * 24));
}
function getBatchSize() {
    // Anti-ban: always 30–50 per batch (never 100+)
    const age = getAccountAgeDays();
    if (age < 3) return 30;   // new account: smaller batches
    if (age < 7) return 40;
    return 50;                // older: max 50
}

// Daily send limit (anti-ban)
function getDailyLimit() {
    const age = getAccountAgeDays();
    if (age < 3) return 80;
    if (age < 7) return 150;
    return 200;
}
function getTodaySentCount() {
    const today = new Date().toLocaleDateString('en-CA');
    const stats = getStats();
    return (stats[today] && stats[today].sent) ? stats[today].sent : 0;
}

// Daily SCAN limit — progressive auto-scan
// New account (<3 days): 80 scans/day
// Older: up to 200/day, still in chunks of max 20 per tick
function getDailyScanLimit() {
    const age = getAccountAgeDays();
    if (age < 3) return 80;
    return 200;
}
function getTodayScanCount() {
    const today = new Date().toLocaleDateString('en-CA');
    const meta = getMeta();
    if (!meta.scanByDate) meta.scanByDate = {};
    return meta.scanByDate[today] || 0;
}
function addTodayScanCount(n) {
    const today = new Date().toLocaleDateString('en-CA');
    const meta = { ...getMeta() };
    if (!meta.scanByDate) meta.scanByDate = {};
    meta.scanByDate[today] = (meta.scanByDate[today] || 0) + n;
    persist('meta', meta);
}

function getGroupScanStats(groupContacts) {
    const list = groupContacts || [];
    let pending = 0, valid = 0, invalid = 0, unscanned = 0;
    list.forEach(c => {
        if (c.waStatus === 'valid') valid++;
        else if (c.waStatus === 'invalid') invalid++;
        else { pending++; unscanned++; }
    });
    return { total: list.length, valid, invalid, pending, scanned: valid + invalid };
}

// Check one number on WhatsApp
async function checkOneNumberOnWA(phone10) {
    const sock = getFirstConnectedSock();
    if (!sock) return false;
    try {
        const r = await sock.onWhatsApp('91' + phone10 + '@s.whatsapp.net');
        return Array.isArray(r) && r[0] && r[0].exists !== false;
    } catch (e) {
        return false;
    }
}

// Auto progressive scan — runs in background
let autoScanRunning = false;
async function runAutoScanTick() {
    if (autoScanRunning) return;
    if (!anyConnected()) return;
    if (liveCampaign && liveCampaign.isActive) return;
    if (!isWithinSendWindow()) return;

    const dailyLimit = getDailyScanLimit();
    const used = getTodayScanCount();
    if (used >= dailyLimit) return;

    const chunk = Math.min(20, dailyLimit - used);
    const contacts = getContacts();
    const pendingItems = []; // { group, index, contact }

    Object.keys(contacts).forEach(g => {
        (contacts[g] || []).forEach((c, idx) => {
            if (!c.waStatus || c.waStatus === 'pending') {
                pendingItems.push({ group: g, index: idx, contact: c });
            }
        });
    });

    if (pendingItems.length === 0) return;

    autoScanRunning = true;
    const batch = pendingItems.slice(0, chunk);
    let scannedNow = 0;

    try {
        for (const item of batch) {
            const phone = String(item.contact.phone || '').replace(/\D/g, '').slice(-10);
            if (phone.length !== 10) {
                contacts[item.group][item.index].waStatus = 'invalid';
                scannedNow++;
                continue;
            }
            const ok = await checkOneNumberOnWA(phone);
            contacts[item.group][item.index].waStatus = ok ? 'valid' : 'invalid';
            contacts[item.group][item.index].phone = phone;
            scannedNow++;
            await new Promise(r => setTimeout(r, 1500)); // gap between checks
        }
        if (scannedNow > 0) {
            addTodayScanCount(scannedNow);
            await persist('contacts', contacts);
            console.log(`Auto-scan: ${scannedNow} checked today=${getTodayScanCount()}/${dailyLimit}`);
        }
    } catch (e) {
        console.error('Auto-scan error:', e.message);
    } finally {
        autoScanRunning = false;
    }
}
function isWithinSendWindow() {
    const ist = getISTNow();
    const h = ist.getHours();
    return h >= 8 && h < 22;
}
function msUntilNext8AM_IST() {
    const ist = getISTNow();
    const h = ist.getHours();
    const m = ist.getMinutes();
    const s = ist.getSeconds();
    const msSinceMidnight = ((h * 60 + m) * 60 + s) * 1000;
    const eightAM = 8 * 60 * 60 * 1000;
    if (h >= 8 && h < 22) return 0;
    if (h < 8) return eightAM - msSinceMidnight;
    const msUntilMidnight = 24 * 60 * 60 * 1000 - msSinceMidnight;
    return msUntilMidnight + eightAM;
}
async function smartSleep(ms, reason) {
    const resumeAt = new Date(Date.now() + ms);
    liveCampaign.status = (reason.includes('Night') || reason.includes('रात') || reason.includes('Night Rest')) ? 'night_rest' : 'resting';
    liveCampaign.restReason = reason;
    liveCampaign.resumeAt = resumeAt.toISOString();
    const step = 5000;
    let left = ms;
    while (left > 0) {
        await new Promise(r => setTimeout(r, Math.min(step, left)));
        left = resumeAt.getTime() - Date.now();
        liveCampaign.resumeAt = resumeAt.toISOString();
    }
    liveCampaign.status = 'sending';
    liveCampaign.restReason = '';
    liveCampaign.resumeAt = null;
}
async function waitForSendWindow() {
    if (isWithinSendWindow()) return;
    const waitMs = msUntilNext8AM_IST();
    if (waitMs > 0) {
        await smartSleep(waitMs, 'Night Rest (10 PM – 8 AM IST) — बाकी नंबर्स अगली सुबह 8 बजे से भेजेंगे');
    }
}

// WhatsApp Connection
async function startSession(sessionId, sessionName) {
    const authDir = pathJoinAuth(sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });

    const session = sessions.get(sessionId) || {
        id: sessionId,
        name: sessionName || sessionId,
        sock: null,
        connected: false,
        qrCode: null,
        restUntil: null,
        sentInBatch: 0,
        batchSize: SESSION_BATCH,
        authDir
    };
    session.sock = sock;
    session.name = sessionName || session.name;
    sessions.set(sessionId, session);

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
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                s.qrCode = null;
                setTimeout(() => startSession(sessionId, s.name), 2000);
            }
        } else if (connection === 'open') {
            s.connected = true;
            s.qrCode = null;
            const meta = { ...getMeta() };
            if (!meta.firstConnectedAt) {
                meta.firstConnectedAt = new Date().toISOString();
                persist('meta', meta);
            }
            if (!meta.sessions) meta.sessions = [];
            if (!meta.sessions.find(x => x.id === sessionId)) {
                meta.sessions.push({ id: sessionId, name: s.name });
                persist('meta', meta);
            }
            console.log(`Session connected: ${s.name} (${sessionId})`);
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

function pathJoinAuth(sessionId) {
    return (__dirname + '/auth_sessions/' + sessionId).replace(/\\/g, '/');
}

async function bootstrapSessions() {
    // Migrate old single auth if exists
    const oldAuth = __dirname + '/auth_info_baileys';
    const defaultId = 'wa_1';
    if (fs.existsSync(oldAuth) && !fs.existsSync(pathJoinAuth(defaultId))) {
        try {
            fs.mkdirSync(__dirname + '/auth_sessions', { recursive: true });
            fs.renameSync(oldAuth, pathJoinAuth(defaultId));
        } catch (e) {}
    }
    const meta = getMeta();
    let list = (meta.sessions && meta.sessions.length) ? meta.sessions : [{ id: defaultId, name: 'WhatsApp 1' }];
    // Ensure at least one session slot
    if (!list.length) list = [{ id: defaultId, name: 'WhatsApp 1' }];
    for (const item of list) {
        await startSession(item.id, item.name);
    }
}

// Standard API Routes
app.get('/status', (req, res) => {
    const list = listSessionsPublic();
    const primary = list.find(s => s.connected) || list[0] || null;
    res.json({
        connected: anyConnected(),
        qrCode: primary && !primary.connected ? primary.qrCode : null,
        sessions: list,
        autoReply: isAutoReplyEnabled,
        currentMsg: autoReplyMessage,
        storage: useMongo ? 'mongodb' : 'local'
    });
});

app.get('/api/sessions', (req, res) => res.json({ sessions: listSessionsPublic() }));

app.post('/api/sessions/create', async (req, res) => {
    const name = (req.body && req.body.name) ? String(req.body.name).trim() : '';
    const id = 'wa_' + Date.now();
    const displayName = name || ('WhatsApp ' + (sessions.size + 1));
    const meta = { ...getMeta() };
    if (!meta.sessions) meta.sessions = [];
    meta.sessions.push({ id, name: displayName });
    await persist('meta', meta);
    await startSession(id, displayName);
    res.json({ success: true, session: { id, name: displayName } });
});

app.post('/api/sessions/delete', async (req, res) => {
    const id = req.body && req.body.id;
    if (!id || !sessions.has(id)) return res.status(400).json({ success: false, error: 'Session not found' });
    const s = sessions.get(id);
    try { if (s.sock) s.sock.end(); } catch (e) {}
    sessions.delete(id);
    try { fs.rmSync(pathJoinAuth(id), { recursive: true, force: true }); } catch (e) {}
    const meta = { ...getMeta() };
    meta.sessions = (meta.sessions || []).filter(x => x.id !== id);
    await persist('meta', meta);
    res.json({ success: true });
});
app.post('/toggle-autoreply', (req, res) => { isAutoReplyEnabled = req.body.enabled; res.json({ success: true }); });
app.post('/update-autoreply', (req, res) => { autoReplyMessage = req.body.message; res.json({ success: true }); });
app.get('/api/stats', (req, res) => { const stats = getStats(); const date = req.query.date; res.json(date ? (stats[date] || { sent: 0, failed: 0 }) : { sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) }); });
app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/live-status', (req, res) => res.json(liveCampaign));

// Template Routes (Mongo persistent)
app.get('/api/templates', (req, res) => res.json(getTemplates()));
app.post('/api/templates', async (req, res) => {
    const t = getTemplates();
    t.push(req.body);
    await persist('templates', t);
    res.json({ success: true });
});
app.post('/api/templates/delete', async (req, res) => {
    let t = getTemplates().filter(x => x.id !== req.body.id);
    await persist('templates', t);
    res.json({ success: true });
});

// Contacts & Groups Routes (Mongo persistent)
app.get('/api/contacts', (req, res) => res.json(getContacts()));
app.post('/api/contacts', async (req, res) => {
    // Normalize: keep waStatus if present
    const body = req.body || {};
    Object.keys(body).forEach(g => {
        if (!Array.isArray(body[g])) return;
        body[g] = body[g].map(c => ({
            name: c.name || 'Customer',
            phone: String(c.phone || '').replace(/\D/g, '').slice(-10),
            waStatus: c.waStatus || null // null = not scanned yet
        }));
    });
    await persist('contacts', body);
    res.json({ success: true });
});

// Group scan progress + daily scan quota
app.get('/api/scan-progress', (req, res) => {
    const contacts = getContacts();
    const groups = {};
    Object.keys(contacts).forEach(g => {
        groups[g] = getGroupScanStats(contacts[g]);
    });
    res.json({
        groups,
        todayScanned: getTodayScanCount(),
        dailyScanLimit: getDailyScanLimit(),
        accountAgeDays: getAccountAgeDays(),
        autoScan: true,
        window: '8 AM – 10 PM IST'
    });
});

// Manual "scan next chunk" still limited to 20, marks waStatus
app.post('/api/scan-next', async (req, res) => {
    if (!anyConnected()) {
        return res.status(400).json({ success: false, error: 'WhatsApp connect nahi hai' });
    }
    const group = req.body.group;
    const contacts = getContacts();
    if (!group || !contacts[group]) {
        return res.status(400).json({ success: false, error: 'Group select karo' });
    }
    const dailyLimit = getDailyScanLimit();
    const used = getTodayScanCount();
    if (used >= dailyLimit) {
        return res.status(400).json({
            success: false,
            error: `Aaj ka scan limit (${dailyLimit}) pure. Kal auto continue hoga.`,
            todayScanned: used,
            dailyScanLimit: dailyLimit
        });
    }
    const chunk = Math.min(20, dailyLimit - used);
    let scanned = 0, valid = 0, invalid = 0;
    for (let i = 0; i < contacts[group].length && scanned < chunk; i++) {
        const c = contacts[group][i];
        if (c.waStatus === 'valid' || c.waStatus === 'invalid') continue;
        const phone = String(c.phone || '').replace(/\D/g, '').slice(-10);
        const ok = phone.length === 10 ? await checkOneNumberOnWA(phone) : false;
        contacts[group][i].waStatus = ok ? 'valid' : 'invalid';
        contacts[group][i].phone = phone;
        if (ok) valid++; else invalid++;
        scanned++;
        await new Promise(r => setTimeout(r, 1500));
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
        dailyScanLimit: dailyLimit,
        groupStats: getGroupScanStats(contacts[group])
    });
});

app.post('/pair-code', async (req, res) => {
    try {
        let { phone, sessionId } = req.body || {};
        phone = String(phone || '').replace(/\D/g, '');
        if (phone.length === 10) phone = '91' + phone;
        if (!phone || phone.length < 11) {
            return res.status(400).json({
                success: false,
                error: 'Sahi number daalo (e.g. 9876543210). Country code auto 91 lag jayega.'
            });
        }

        let s = sessionId ? getSession(sessionId) : null;
        // Prefer session jo abhi connected NAHI (QR pending)
        if (!s || !s.sock) {
            s = Array.from(sessions.values()).find(x => x.sock && !x.connected)
                || Array.from(sessions.values()).find(x => x.sock);
        }
        if (!s || !s.sock) {
            return res.status(400).json({
                success: false,
                error: 'Session ready nahi. Device Settings → Add WhatsApp, wait for QR, phir pairing try karo.'
            });
        }
        if (s.connected) {
            return res.status(400).json({
                success: false,
                error: `"${s.name}" already connected hai. Naya session Add karke uspe pairing use karo.`
            });
        }

        // Baileys: number without + (e.g. 9198xxxxxxxx)
        const code = await s.sock.requestPairingCode(phone);
        const raw = String(code || '');
        const formatted = raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
        res.json({
            success: true,
            code: formatted,
            raw,
            sessionId: s.id,
            sessionName: s.name
        });
    } catch (e) {
        console.error('pair-code error:', e);
        res.status(500).json({
            success: false,
            error: (e && e.message) ? e.message : 'Pairing code generate nahi hua. QR se connect karo ya 10 sec baad retry.'
        });
    }
});

// ✅ Validate numbers — ANTI-BAN: max 20 numbers per scan
app.post('/api/validate-numbers', async (req, res) => {
    if (!anyConnected()) {
        return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है! Pehle device connect karo.' });
    }

    // numbers: [{ phone, name }] or ["98...", "97..."]
    let raw = req.body.numbers || [];
    if (!Array.isArray(raw) || raw.length === 0) {
        return res.json({ success: true, valid: [], invalid: 0, duplicatesRemoved: 0, total: 0 });
    }

    // ANTI-BAN HARD LIMIT: max 20 per request
    const MAX_SCAN = 20;
    if (raw.length > MAX_SCAN) {
        return res.status(400).json({
            success: false,
            error: `Anti-Ban: ek baar mein max ${MAX_SCAN} numbers scan allowed. Aapne ${raw.length} bheje. List chhoti karke phir try karo.`,
            maxAllowed: MAX_SCAN,
            received: raw.length
        });
    }

    // Normalize + dedupe (keep first name for each unique 10-digit)
    const seen = new Map(); // key: last 10 digits → { phone, name }
    let duplicatesRemoved = 0;

    for (const item of raw) {
        let phoneStr = typeof item === 'string' ? item : String(item.phone || '');
        let name = typeof item === 'object' && item.name ? String(item.name).trim() : 'Customer';
        let digits = phoneStr.replace(/\D/g, '');
        if (digits.length < 10) continue;
        let last10 = digits.slice(-10);
        // Indian mobile: starts with 6-9
        if (!/^[6-9]\d{9}$/.test(last10)) continue;

        if (seen.has(last10)) {
            duplicatesRemoved++;
            continue;
        }
        seen.set(last10, { phone: last10, name: name || 'Customer' });
    }

    const uniqueList = Array.from(seen.values());
    const valid = [];
    let invalidCount = 0;

    // Check one-by-one with delay (safer than big batch)
    const BATCH = 5;
    for (let i = 0; i < uniqueList.length; i += BATCH) {
        const batch = uniqueList.slice(i, i + BATCH);
        try {
            // Pass full JIDs
            const jids = batch.map(c => '91' + c.phone + '@s.whatsapp.net');
            const _sock = getFirstConnectedSock();
            if (!_sock) throw new Error('no sock');
            const results = await _sock.onWhatsApp(...jids);
            const existSet = new Set();
            if (Array.isArray(results)) {
                results.forEach(r => {
                    if (r && (r.exists === true || r.exists === undefined) && r.jid) {
                        const p = String(r.jid).split('@')[0].replace(/\D/g, '').slice(-10);
                        existSet.add(p);
                    }
                });
            }
            batch.forEach(c => {
                if (existSet.has(c.phone)) valid.push(c);
                else invalidCount++;
            });
        } catch (e) {
            // Fallback: one-by-one
            for (const c of batch) {
                try {
                    const _sock2 = getFirstConnectedSock();
                    const r = await _sock2.onWhatsApp('91' + c.phone + '@s.whatsapp.net');
                    const ok = Array.isArray(r) && r[0] && r[0].exists !== false;
                    if (ok) valid.push(c);
                    else invalidCount++;
                } catch (e2) {
                    invalidCount++;
                }
            }
        }
        if (i + BATCH < uniqueList.length) {
            await new Promise(r => setTimeout(r, 2000)); // anti-ban gap between scan batches
        }
    }

    res.json({
        success: true,
        valid,
        invalid: invalidCount,
        duplicatesRemoved,
        total: raw.length,
        validCount: valid.length
    });
});

// 🚀 MULTI-WA SEND — each session 30 msgs → 2hr rest; one msg per number total
app.post('/send', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });

    const { numbers, message, minDelay, maxDelay, imageBase64, templates, sessionIds } = req.body;

    if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ success: false, error: 'Number list empty!' });
    }

    // Selected sessions (or all connected)
    let selectedIds = Array.isArray(sessionIds) && sessionIds.length
        ? sessionIds
        : Array.from(sessions.values()).filter(s => s.connected).map(s => s.id);
    selectedIds = selectedIds.filter(id => {
        const s = getSession(id);
        return s && s.connected && s.sock;
    });
    if (!selectedIds.length) {
        return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });
    }

    // Deduplicate numbers — ek number pe sirf ek msg
    const seenPhone = new Set();
    let uniqueNumbers = [];
    for (const n of numbers) {
        const p = String(n.phone || '').replace(/\D/g, '').slice(-10);
        if (p.length === 10 && !seenPhone.has(p)) {
            seenPhone.add(p);
            uniqueNumbers.push({ phone: p, name: n.name || 'Customer' });
        }
    }

    // Daily limit scales with number of selected WAs
    const dailyLimit = getDailyLimit() * selectedIds.length;
    const alreadySent = getTodaySentCount();
    if (alreadySent >= dailyLimit) {
        return res.status(400).json({
            success: false,
            error: `Anti-Ban: aaj ka limit (${dailyLimit}) pure. Kal try karo.`
        });
    }
    const remainingQuota = dailyLimit - alreadySent;
    if (uniqueNumbers.length > remainingQuota) {
        uniqueNumbers = uniqueNumbers.slice(0, remainingQuota);
    }

    const useRotation = Array.isArray(templates) && templates.length > 0;
    let tplIndex = 0;

    liveCampaign = {
        isActive: true,
        total: uniqueNumbers.length,
        dailyLimit,
        alreadySentToday: alreadySent,
        sent: 0,
        failed: 0,
        pending: uniqueNumbers.length,
        numbers: uniqueNumbers.map(n => ({ phone: n.phone, status: 'Pending ⏳' })),
        status: 'sending',
        restReason: '',
        resumeAt: null,
        batchSize: SESSION_BATCH,
        accountAgeDays: getAccountAgeDays(),
        sessions: selectedIds.map(id => {
            const s = getSession(id);
            return { id, name: s.name, resting: false };
        })
    };
    res.json({
        success: true,
        willSend: uniqueNumbers.length,
        sessions: selectedIds.length,
        batchPerSession: SESSION_BATCH
    });

    const minD = Math.max(45, parseInt(minDelay) || 45);
    const maxD = Math.max(minD + 15, parseInt(maxDelay) || 90);

    // Shared queue — shift is atomic enough in single-threaded node
    const queue = uniqueNumbers.map((n, idx) => ({ ...n, idx }));

    async function sessionWorker(sessionId) {
        const s = getSession(sessionId);
        if (!s) return;

        while (queue.length > 0) {
            // Wait while this session is resting
            while (s.restUntil && Date.now() < s.restUntil) {
                const left = s.restUntil - Date.now();
                liveCampaign.status = 'resting';
                liveCampaign.restReason = `${s.name}: 2hr rest after ${SESSION_BATCH} msgs`;
                liveCampaign.resumeAt = new Date(s.restUntil).toISOString();
                await new Promise(r => setTimeout(r, Math.min(5000, left)));
            }

            if (!s.connected || !s.sock) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }

            await waitForSendWindow();
            liveCampaign.status = 'sending';
            liveCampaign.restReason = '';
            liveCampaign.resumeAt = null;

            let batchCount = 0;
            while (batchCount < SESSION_BATCH && queue.length > 0) {
                if (!s.connected || !s.sock) break;
                if (s.restUntil && Date.now() < s.restUntil) break;

                const item = queue.shift();
                if (!item) break;

                let num = item.phone;
                const customerName = item.name || 'Customer';
                const idx = item.idx;

                try {
                    if (!num.startsWith('91')) num = '91' + num;
                    const jid = num + '@s.whatsapp.net';

                    let finalMessage = '';
                    let finalImageBase64 = null;
                    let tplName = '';

                    if (useRotation) {
                        const tpl = templates[tplIndex % templates.length];
                        tplIndex++;
                        tplName = tpl.name || '';
                        finalMessage = (tpl.message || '').replace(/\[Name\]/gi, customerName);
                        finalImageBase64 = tpl.imageBase64 || null;
                    } else {
                        finalMessage = message ? message.replace(/\[Name\]/gi, customerName) : '';
                        finalImageBase64 = imageBase64 || null;
                    }

                    let messageOptions;
                    if (finalImageBase64) {
                        const base64Data = finalImageBase64.includes(',') ? finalImageBase64.split(',')[1] : finalImageBase64;
                        messageOptions = { image: Buffer.from(base64Data, 'base64'), caption: finalMessage };
                    } else {
                        messageOptions = { text: finalMessage || ' ' };
                    }

                    await s.sock.sendMessage(jid, messageOptions);
                    liveCampaign.sent++;
                    liveCampaign.pending = Math.max(0, liveCampaign.pending - 1);
                    if (liveCampaign.numbers[idx]) {
                        liveCampaign.numbers[idx].status = `Sent ✅ (${s.name}${tplName ? ' / ' + tplName : ''})`;
                    }
                    addHistory(num, finalMessage || 'Media Sent');
                    saveStats(new Date().toLocaleDateString('en-CA'), 1, 0);
                    batchCount++;
                    s.sentInBatch = batchCount;

                    const delayMs = (Math.floor(Math.random() * (maxD - minD + 1)) + minD) * 1000;
                    await new Promise(r => setTimeout(r, delayMs));
                } catch (e) {
                    liveCampaign.failed++;
                    liveCampaign.pending = Math.max(0, liveCampaign.pending - 1);
                    if (liveCampaign.numbers[idx]) liveCampaign.numbers[idx].status = `Invalid ❌ (${s.name})`;
                    saveStats(new Date().toLocaleDateString('en-CA'), 0, 1);
                    batchCount++;
                    s.sentInBatch = batchCount;
                }
            }

            // After 30 msgs from this WA → 2hr rest (if more work remains)
            if (batchCount >= SESSION_BATCH && queue.length > 0) {
                s.restUntil = Date.now() + SESSION_REST_MS;
                s.sentInBatch = 0;
                liveCampaign.status = 'resting';
                liveCampaign.restReason = `${s.name}: ${SESSION_BATCH} msgs done → 2hr rest. Doosre WA se continue...`;
                liveCampaign.resumeAt = new Date(s.restUntil).toISOString();
            } else if (queue.length === 0) {
                break;
            }
        }
    }

    // All selected WAs work in parallel; each takes next number from shared queue
    await Promise.all(selectedIds.map(id => sessionWorker(id)));

    liveCampaign.isActive = false;
    liveCampaign.status = 'idle';
    liveCampaign.restReason = '';
    liveCampaign.resumeAt = null;
});

// Boot: Mongo first, then WhatsApp, then HTTP
(async () => {
    await initMongo();
    await bootstrapSessions();
    app.listen(process.env.PORT || 10000, '0.0.0.0', () => {
        console.log(`Server started | Storage: ${useMongo ? 'MongoDB ✅' : 'Local files ⚠️'} | Multi-WA sessions`);
        setInterval(() => { runAutoScanTick().catch(() => {}); }, 3 * 60 * 1000);
        setTimeout(() => { runAutoScanTick().catch(() => {}); }, 30000);
    });
})();
