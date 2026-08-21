const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

let qrCodeData = null;
let isConnected = false;
let sock;
let isAutoReplyEnabled = true;
let autoReplyMessage = `🌟 Welcome! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करने के लिए`;

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
    if (!MONGODB_URI) {
        console.log('⚠️ MONGODB_URI not set — using local JSON files (data may reset on Render restart)');
        // Load from files
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
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if(qr) qrCodeData = await qrcode.toDataURL(qr);
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            if(shouldReconnect) setTimeout(connectToWhatsApp, 3000);
            else { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); connectToWhatsApp(); }
        } else if(connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            // Save first connected time (for account age / batch size) — persists in Mongo
            const meta = { ...getMeta() };
            if (!meta.firstConnectedAt) {
                meta.firstConnectedAt = new Date().toISOString();
                persist('meta', meta);
            }
        }
    });
    sock.ev.on('creds.update', saveCreds);

    // Auto-Reply
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

        if (text === 'hi' || text === 'hello' || text === 'menu') await sock.sendMessage(jid, { text: autoReplyMessage });
        else if (text === '1') await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
        else if (text === '2') await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
        else if (text === '3') await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
    });
}

// Standard API Routes
app.get('/status', (req, res) => res.json({
    connected: isConnected,
    qrCode: qrCodeData,
    autoReply: isAutoReplyEnabled,
    currentMsg: autoReplyMessage,
    storage: useMongo ? 'mongodb' : 'local'
}));
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
    await persist('contacts', req.body || {});
    res.json({ success: true });
});

app.post('/pair-code', async (req, res) => {
    let { phone } = req.body; phone = phone.replace(/[^0-9]/g, ''); if (!phone.startsWith('91')) phone = '91' + phone;
    res.json({ success: true, code: await sock.requestPairingCode(phone) });
});

// ✅ Validate numbers — ANTI-BAN: max 20 numbers per scan
app.post('/api/validate-numbers', async (req, res) => {
    if (!isConnected || !sock) {
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
            const results = await sock.onWhatsApp(...jids);
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
                    const r = await sock.onWhatsApp('91' + c.phone + '@s.whatsapp.net');
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

// 🚀 SEND ROUTE — Anti-Ban AI limits + Smart template mix
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    
    // numbers: [{phone, name}, ...]
    // templates: [{name, message, imageBase64}, ...]  → AI-style random mix (no series pattern)
    const { numbers, message, minDelay, maxDelay, imageBase64, templates } = req.body;

    if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ success: false, error: 'Number list empty!' });
    }

    // Anti-ban: daily limit
    const dailyLimit = getDailyLimit();
    const alreadySent = getTodaySentCount();
    if (alreadySent >= dailyLimit) {
        return res.status(400).json({
            success: false,
            error: `Anti-Ban: aaj ka limit (${dailyLimit}) pure ho chuke. Kal phir try karo. Aaj already sent: ${alreadySent}`
        });
    }
    // Only process remaining quota for today (rest stay for next day via night window + user restart)
    let numbersToSend = numbers;
    const remainingQuota = dailyLimit - alreadySent;
    if (numbers.length > remainingQuota) {
        numbersToSend = numbers.slice(0, remainingQuota);
    }
    
    const useRotation = Array.isArray(templates) && templates.length > 0;
    
    // Smart shuffle: fair distribution + random order so consecutive numbers don't get sequential templates
    let shuffledTemplateOrder = [];
    if (useRotation) {
        const n = numbersToSend.length;
        const tCount = templates.length;
        for (let i = 0; i < n; i++) {
            shuffledTemplateOrder.push(i % tCount);
        }
        for (let i = shuffledTemplateOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledTemplateOrder[i], shuffledTemplateOrder[j]] = [shuffledTemplateOrder[j], shuffledTemplateOrder[i]];
        }
        for (let i = 1; i < shuffledTemplateOrder.length; i++) {
            if (shuffledTemplateOrder[i] === shuffledTemplateOrder[i - 1] && tCount > 1) {
                for (let k = i + 1; k < shuffledTemplateOrder.length; k++) {
                    if (shuffledTemplateOrder[k] !== shuffledTemplateOrder[i - 1]) {
                        [shuffledTemplateOrder[i], shuffledTemplateOrder[k]] = [shuffledTemplateOrder[k], shuffledTemplateOrder[i]];
                        break;
                    }
                }
            }
        }
    }
    
    const ageDays = getAccountAgeDays();
    const batchSize = getBatchSize(); // 30 / 40 / 50 anti-ban

    liveCampaign = {
        isActive: true,
        total: numbersToSend.length,
        dailyLimit,
        alreadySentToday: alreadySent,
        sent: 0,
        failed: 0,
        pending: numbersToSend.length,
        numbers: numbersToSend.map(n => ({ phone: n.phone, status: 'Pending ⏳' })),
        status: 'sending',
        restReason: '',
        resumeAt: null,
        batchSize,
        accountAgeDays: ageDays
    };
    res.json({
        success: true,
        batchSize,
        accountAgeDays: ageDays,
        dailyLimit,
        willSend: numbersToSend.length,
        skippedForDailyLimit: numbers.length - numbersToSend.length
    }); 
    
    // Anti-ban minimum delays
    let minD = Math.max(45, parseInt(minDelay) || 45);
    let maxD = Math.max(minD + 15, parseInt(maxDelay) || 90);
    let sentCount = 0;
    let failedCount = 0;
    let sentInCurrentBatch = 0;

    for (let i = 0; i < numbersToSend.length; i++) {
        // 1) Only send between 8 AM – 10 PM IST
        await waitForSendWindow();

        // 2) After every batchSize, rest 2 hours
        if (sentInCurrentBatch >= batchSize && i < numbersToSend.length) {
            sentInCurrentBatch = 0;
            const twoHours = 2 * 60 * 60 * 1000;
            await smartSleep(
                twoHours,
                `Batch Rest — हर ${batchSize} msgs के बाद 2 घंटे आराम (Account age: ${ageDays} दिन)`
            );
            // After long rest, ensure still in send window
            await waitForSendWindow();
        }

        liveCampaign.status = 'sending';
        liveCampaign.restReason = '';
        liveCampaign.resumeAt = null;

        let contact = numbersToSend[i];
        let num = String(contact.phone).replace(/[^0-9]/g, '');
        let customerName = contact.name || 'Customer';

        try {
            if (!num.startsWith('91')) num = '91' + num;
            const jid = num + '@s.whatsapp.net';
            
            let finalMessage = '';
            let finalImageBase64 = null;
            let tplName = '';

            if (useRotation) {
                const tpl = templates[shuffledTemplateOrder[i]];
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
            
            await sock.sendMessage(jid, messageOptions);
            sentCount++;
            liveCampaign.sent++;
            liveCampaign.pending--;
            liveCampaign.numbers[i].status = useRotation ? `Sent ✅ (${tplName})` : 'Sent ✅';
            addHistory(num, finalMessage || (tplName ? `[${tplName}] Media` : "Media Sent")); 
            // Live dashboard update (incremental)
            saveStats(new Date().toLocaleDateString('en-CA'), 1, 0);
            sentInCurrentBatch++;
            
            if (i < numbersToSend.length - 1) {
                const delayMs = (Math.floor(Math.random() * (maxD - minD + 1)) + minD) * 1000;
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        } catch (e) { 
            failedCount++;
            liveCampaign.failed++;
            liveCampaign.pending--;
            liveCampaign.numbers[i].status = 'Invalid ❌';
            saveStats(new Date().toLocaleDateString('en-CA'), 0, 1);
            sentInCurrentBatch++; // still counts toward batch rest
        }
    }
    liveCampaign.isActive = false;
    liveCampaign.status = 'idle';
    liveCampaign.restReason = '';
    liveCampaign.resumeAt = null;
});

// Boot: Mongo first, then WhatsApp, then HTTP
(async () => {
    await initMongo();
    connectToWhatsApp();
    app.listen(process.env.PORT || 10000, '0.0.0.0', () => {
        console.log(`Server started | Storage: ${useMongo ? 'MongoDB ✅' : 'Local files ⚠️'}`);
    });
})();
