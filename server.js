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
const inboxFile = __dirname + '/inbox.json';
const proFile = __dirname + '/pro.json';
const connectionMetaFile = __dirname + '/connection_meta.json';

const MONGODB_URI = process.env.MONGODB_URI || '';
let mongoClient = null;
let db = null;
let useMongo = false;

let cache = { contacts: {}, templates: [], history: [], stats: {}, meta: {}, inbox: { chats: {} }, pro: null };

async function initMongo() {
    if (!MONGODB_URI || !MongoClient) {
        cache.contacts = getJsonFile(contactsFile) || {}; cache.templates = getJsonFile(templatesFile) || [];
        cache.history = getJsonFile(historyFile) || []; cache.stats = getJsonFile(statsFile) || {}; cache.meta = getJsonFile(connectionMetaFile) || {}; cache.inbox = getJsonFile(inboxFile) || { chats: {} }; cache.pro = getJsonFile(proFile) || null;
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
        const map = { contacts: contactsFile, templates: templatesFile, history: historyFile, stats: statsFile, meta: connectionMetaFile, inbox: inboxFile, pro: proFile };
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

function getInbox() {
    if (!cache.inbox || typeof cache.inbox !== 'object') cache.inbox = { chats: {} };
    if (!cache.inbox.chats) cache.inbox.chats = {};
    return cache.inbox;
}
function listInboxChats() {
    const chats = getInbox().chats || {};
    return Object.values(chats)
        .map(c => ({
            phone: c.phone,
            name: c.name || c.phone,
            lastMessage: c.lastMessage || '',
            lastAt: c.lastAt || 0,
            lastAtText: c.lastAtText || '',
            unread: c.unread || 0,
            sessionId: c.sessionId || null,
            sessionName: c.sessionName || ''
        }))
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
function pushInboxMessage({ phone, name, text, fromMe, sessionId, sessionName }) {
    if (!phone || !text) return;
    const inbox = getInbox();
    if (!inbox.chats[phone]) {
        inbox.chats[phone] = {
            phone,
            name: name || phone,
            lastMessage: '',
            lastAt: 0,
            lastAtText: '',
            unread: 0,
            sessionId: sessionId || null,
            sessionName: sessionName || '',
            messages: []
        };
    }
    const chat = inbox.chats[phone];
    if (name && name !== phone) chat.name = name;
    if (sessionId) chat.sessionId = sessionId;
    if (sessionName) chat.sessionName = sessionName;
    const now = Date.now();
    const lastAtText = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    chat.messages = chat.messages || [];
    chat.messages.push({ id: now + '_' + Math.random().toString(36).slice(2, 7), text: String(text).slice(0, 4000), fromMe: !!fromMe, at: now, atText: lastAtText });
    if (chat.messages.length > 80) chat.messages = chat.messages.slice(-80);
    chat.lastMessage = String(text).slice(0, 120);
    chat.lastAt = now;
    chat.lastAtText = lastAtText;
    if (!fromMe) chat.unread = (chat.unread || 0) + 1;
    // keep max 200 chats
    const phones = Object.keys(inbox.chats);
    if (phones.length > 200) {
        const sorted = phones.sort((a, b) => (inbox.chats[a].lastAt || 0) - (inbox.chats[b].lastAt || 0));
        sorted.slice(0, phones.length - 200).forEach(p => delete inbox.chats[p]);
    }
    persist('inbox', inbox);
}

let isAutoReplyEnabled = true; // global menu fallback (when session bot off)
let autoReplyMessage = `🌟 Welcome! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करने के लिए`;
// Per-WhatsApp Gemini bots: sessionId -> { enabled, prompt, knowledge, lastError }

function defaultPro() {
    return {
        blacklist: [],
        quickReplies: [
            { id: 'qr1', text: 'Namaste! Kaise help kar sakte hain?' },
            { id: 'qr2', text: 'Rate confirm karke jaldi bhejenge. Quantity bataiye.' },
            { id: 'qr3', text: 'Dhanyavaad! Team jald contact karegi.' }
        ],
        followUps: [],
        keywords: ['price', 'rate', 'order', 'buy', 'book', 'urgent', 'complaint', 'agent', 'human'],
        keywordHits: [],
        leadTags: {},
        crmNotes: {},
        chatAssign: {},
        handoff: {},
        orderFlow: {},
        numberQuality: {},
        templateCooldown: {},
        templateStats: {},
        sessionStats: {},
        campaignReplies: {},
        signatures: ['', '— Team', 'Thanks', 'Regards'],
        signatureEnabled: true,
        templateCooldownHours: 24,
        warmupEnabled: true,
        sequences: {
            enabled: false,
            day0: '',
            day3: 'Namaste! Kal wali baat pe follow-up — kya help chahiye?',
            day7: 'Ek soft reminder — agar abhi need ho to reply karein.'
        },
        catalog: null,
        faqText: '',
        pinHash: '',
        businessHours: { enabled: false, start: 8, end: 22, offMessage: 'Abhi business hours ke bahar hain (8 AM – 10 PM IST). Kal subah reply karenge. Urgent ho to message chhod dein.' },
        multiLang: true
    };
}
function getPro() {
    if (!cache.pro || typeof cache.pro !== 'object') cache.pro = defaultPro();
    const d = defaultPro();
    for (const k of Object.keys(d)) {
        if (cache.pro[k] === undefined || cache.pro[k] === null) cache.pro[k] = d[k];
    }
    return cache.pro;
}
async function savePro() { await persist('pro', getPro()); }
function normPhone(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function isBlacklisted(phone) {
    const n = normPhone(phone);
    return (getPro().blacklist || []).some(x => normPhone(x) === n || String(x).replace(/\D/g, '').endsWith(n));
}
function bumpTemplateStat(name, ok) {
    if (!name) return;
    const pro = getPro();
    if (!pro.templateStats[name]) pro.templateStats[name] = { sent: 0, failed: 0 };
    if (ok) pro.templateStats[name].sent++; else pro.templateStats[name].failed++;
    persist('pro', pro);
}
function bumpSessionStat(sessionName, ok) {
    if (!sessionName) return;
    const pro = getPro();
    const day = new Date().toLocaleDateString('en-CA');
    if (!pro.sessionStats[day]) pro.sessionStats[day] = {};
    if (!pro.sessionStats[day][sessionName]) pro.sessionStats[day][sessionName] = { sent: 0, failed: 0 };
    if (ok) pro.sessionStats[day][sessionName].sent++; else pro.sessionStats[day][sessionName].failed++;
    persist('pro', pro);
}
function isWithinBusinessHours() {
    const bh = getPro().businessHours || {};
    if (!bh.enabled) return true;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = now.getHours();
    const start = Number(bh.start != null ? bh.start : 8);
    const end = Number(bh.end != null ? bh.end : 22);
    return h >= start && h < end;
}
function detectLangHint(text) {
    const t = String(text || '');
    if (/[\u0900-\u097F]/.test(t)) return 'Reply mainly in Hindi (Devanagari) or natural Hinglish.';
    if (/^[a-zA-Z0-9\s.,!'?\"-]+$/.test(t) && t.length > 2) return 'Reply mainly in clear English.';
    return 'Reply in natural Hinglish unless customer uses pure English or pure Hindi.';
}

function randomSignature() {
    const pro = getPro();
    if (!pro.signatureEnabled) return '';
    const list = (pro.signatures || []).filter(s => s != null && String(s).length >= 0);
    if (!list.length) return '';
    const s = list[Math.floor(Math.random() * list.length)];
    return s ? ('\n\n' + String(s).trim()) : '';
}
function isTemplateOnCooldown(phone, tplName) {
    if (!tplName) return false;
    const pro = getPro();
    const hours = Number(pro.templateCooldownHours != null ? pro.templateCooldownHours : 24);
    const key = normPhone(phone) + '|' + tplName;
    const last = (pro.templateCooldown || {})[key];
    if (!last) return false;
    return (Date.now() - last) < hours * 3600 * 1000;
}
function markTemplateSent(phone, tplName) {
    if (!tplName) return;
    const pro = getPro();
    if (!pro.templateCooldown) pro.templateCooldown = {};
    pro.templateCooldown[normPhone(phone) + '|' + tplName] = Date.now();
    // prune old
    const keys = Object.keys(pro.templateCooldown);
    if (keys.length > 5000) {
        keys.sort((a, b) => pro.templateCooldown[a] - pro.templateCooldown[b]);
        keys.slice(0, keys.length - 4000).forEach(k => delete pro.templateCooldown[k]);
    }
    persist('pro', pro);
}
function bumpNumberQuality(phone, field) {
    const pro = getPro();
    const n = normPhone(phone);
    if (!n) return;
    if (!pro.numberQuality[n]) pro.numberQuality[n] = { sent: 0, replies: 0, invalid: 0 };
    pro.numberQuality[n][field] = (pro.numberQuality[n][field] || 0) + 1;
    persist('pro', pro);
}
function getNumberScore(phone) {
    const q = (getPro().numberQuality || {})[normPhone(phone)] || { sent: 0, replies: 0, invalid: 0 };
    if (q.invalid) return { score: 0, label: 'invalid' };
    if (!q.sent) return { score: 50, label: 'new' };
    const rate = q.replies / q.sent;
    if (rate >= 0.3) return { score: 90, label: 'hot' };
    if (rate >= 0.1) return { score: 70, label: 'warm' };
    if (q.sent >= 3 && q.replies === 0) return { score: 25, label: 'cold' };
    return { score: 50, label: 'ok' };
}
function getSessionAgeDays(sessionId) {
    try {
        const s = sessions.get(sessionId);
        if (s && s.firstConnectedAt) {
            return Math.floor((Date.now() - new Date(s.firstConnectedAt).getTime()) / 86400000);
        }
    } catch (e) {}
    return getAccountAgeDays();
}
function getWarmupDailyLimit(sessionId) {
    const pro = getPro();
    if (pro.warmupEnabled === false) return getDailyLimit();
    const age = getSessionAgeDays(sessionId);
    if (age < 3) return 40;
    if (age < 7) return 80;
    return getDailyLimit();
}
function simplePinHash(pin) {
    const s = String(pin || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
    return 'p' + Math.abs(h) + '_' + s.length;
}



let sessionBots = {};
let lastGeminiBotError = null;

function defaultSessionBot() {
    return {
        enabled: false,
        prompt: 'You represent this WhatsApp business number. Answer from the business knowledge. Be professional Hinglish. If info missing, ask 1 short clarifying question.',
        knowledge: '',
        lastError: null
    };
}
function getSessionBot(sessionId) {
    if (!sessionId) return defaultSessionBot();
    if (!sessionBots[sessionId]) sessionBots[sessionId] = defaultSessionBot();
    return sessionBots[sessionId];
}
function loadBotSettingsFromMeta() {
    try {
        const m = getMeta() || {};
        if (typeof m.isAutoReplyEnabled === 'boolean') isAutoReplyEnabled = m.isAutoReplyEnabled;
        if (m.autoReplyMessage) autoReplyMessage = m.autoReplyMessage;
        if (m.sessionBots && typeof m.sessionBots === 'object') sessionBots = m.sessionBots;
        // migrate old global gemini settings onto first session if needed
        if (m.isGeminiBotEnabled && m.geminiBotPrompt && (!m.sessionBots || !Object.keys(m.sessionBots).length)) {
            const meta = getMeta();
            const sid = (meta.sessions && meta.sessions[0] && meta.sessions[0].id) || 'wa_1';
            sessionBots[sid] = {
                enabled: true,
                prompt: m.geminiBotPrompt,
                knowledge: m.geminiBotKnowledge || '',
                lastError: null
            };
        }
    } catch (e) {}
}
async function saveBotSettingsToMeta() {
    try {
        const meta = { ...getMeta() };
        meta.isAutoReplyEnabled = !!isAutoReplyEnabled;
        meta.autoReplyMessage = autoReplyMessage;
        meta.sessionBots = sessionBots;
        await persist('meta', meta);
    } catch (e) {}
}

async function fetchUrlKnowledge(urlStr) {
    try {
        let u = String(urlStr || '').trim();
        if (!u) return '';
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        const r = await fetch(u, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8'
            },
            signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 18000); return c.signal; })()
        });
        if (!r.ok) return '';
        let html = await r.text();
        html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
        const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
        const metaDesc = ((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
            html.match(/content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1] || '');
        const og = ((html.match(/property=["']og:description["'][^>]+content=["']([^"']+)/i) || [])[1] || '');
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 9000);
        return ('URL: ' + u + '\nTitle: ' + title + '\nDescription: ' + metaDesc + '\nOG: ' + og + '\nContent: ' + text).slice(0, 10000);
    } catch (e) {
        return '';
    }
}

async function refreshBotKnowledgeFromPrompt(promptText) {
    const text = String(promptText || '');
    const urls = text.match(/https?:\/\/[^\s\]\)\"\']+/gi) || [];
    const bare = text.match(/(?:www\.)?(?:facebook\.com|fb\.com|instagram\.com)[^\s\]\)\"\']*/gi) || [];
    const all = [];
    urls.forEach(u => all.push(u));
    bare.forEach(u => {
        if (!/^https?:/i.test(u)) all.push('https://' + u);
        else all.push(u);
    });
    const unique = [...new Set(all)].slice(0, 4);
    let knowledge = '';
    for (const u of unique) {
        const k = await fetchUrlKnowledge(u);
        if (k) knowledge += k + '\n\n';
    }
    return knowledge.trim().slice(0, 12000);
}

// Multi parallel campaigns (alag WA + alag template saath-saath)
const liveCampaigns = new Map();

function anyCampaignActive() {
    for (const c of liveCampaigns.values()) {
        if (c.isActive && !c.cancelFlag) return true;
    }
    return false;
}

function sessionsBusyInCampaigns(sessionIds) {
    const busy = new Set();
    for (const c of liveCampaigns.values()) {
        if (!c.isActive || c.cancelFlag) continue;
        (c.sessionIds || []).forEach(id => busy.add(id));
    }
    return (sessionIds || []).filter(id => busy.has(id));
}

function listCampaignsPublic() {
    return Array.from(liveCampaigns.values()).map(c => ({
        id: c.id,
        name: c.name,
        isActive: !!c.isActive,
        isPaused: !!c.isPaused,
        total: c.total || 0,
        sent: c.sent || 0,
        failed: c.failed || 0,
        pending: c.pending || 0,
        numbers: c.numbers || [],
        status: c.status || 'idle',
        restReason: c.restReason || '',
        resumeAt: c.resumeAt || null,
        batchSize: c.batchSize,
        restHours: c.restHours,
        sessionIds: c.sessionIds || [],
        sessions: c.sessions || [],
        templateNames: c.templateNames || []
    }));
}

function aggregateLiveForCompat() {
    const list = listCampaignsPublic().filter(c => c.isActive);
    if (!list.length) {
        return {
            isActive: false, isPaused: false, total: 0, sent: 0, failed: 0, pending: 0,
            numbers: [], status: 'idle', restReason: '', resumeAt: null, campaigns: []
        };
    }
    const numbers = [];
    list.forEach(c => (c.numbers || []).forEach(n => numbers.push(n)));
    return {
        isActive: true,
        isPaused: list.every(c => c.isPaused),
        total: list.reduce((a, c) => a + (c.total || 0), 0),
        sent: list.reduce((a, c) => a + (c.sent || 0), 0),
        failed: list.reduce((a, c) => a + (c.failed || 0), 0),
        pending: list.reduce((a, c) => a + (c.pending || 0), 0),
        numbers,
        status: list.some(c => c.status === 'sending') ? 'sending' : (list[0].status || 'sending'),
        restReason: list.map(c => c.restReason).filter(Boolean).join(' | '),
        resumeAt: list[0].resumeAt || null,
        batchSize: list[0].batchSize,
        restHours: list[0].restHours,
        campaigns: list
    };
}

function getISTNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })); }
function getAccountAgeDays() {
    const meta = getMeta(); if (!meta || !meta.firstConnectedAt) return 0;
    return Math.floor((new Date() - new Date(meta.firstConnectedAt)) / (1000 * 60 * 60 * 24));
}
function getDailyLimit() {
    const pro = getPro();
    const age = getAccountAgeDays();
    if (pro.warmupEnabled !== false) {
        if (age < 3) return 40;
        if (age < 7) return 80;
    }
    return age < 3 ? 80 : (age < 7 ? 150 : 200);
}
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

// Background Scan All — browser band hone pe bhi chalta rahe
let bgScanJob = {
    running: false,
    stop: false,
    group: null,
    sessionIds: [],
    scanned: 0,
    valid: 0,
    invalid: 0,
    pendingLeft: 0,
    lastMessage: '',
    startedAt: null,
    finishedAt: null
};

async function processScanChunk(group, sessionIds, scanAll) {
    const contacts = getContacts();
    if (!group || !contacts[group]) return { scanned: 0, valid: 0, invalid: 0, pending: 0 };
    const socks = getScanSocks(sessionIds);
    if (!socks.length) return { scanned: 0, valid: 0, invalid: 0, pending: -1, error: 'No WA' };

    const activeWaCount = socks.length;
    const dailyLimit = getDailyScanLimit() * activeWaCount;
    const used = getTodayScanCount();
    if (!scanAll && used >= dailyLimit) {
        return { scanned: 0, valid: 0, invalid: 0, pending: 0, error: 'daily_limit' };
    }
    const chunk = scanAll ? 5 : Math.min(10, Math.max(1, dailyLimit - used));
    let scanned = 0, valid = 0, invalid = 0, rr = 0;

    for (let i = 0; i < contacts[group].length && scanned < chunk; i++) {
        if (bgScanJob.stop && scanAll) break;
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
        await new Promise(r => setTimeout(r, scanDelayMs(activeWaCount)));
    }
    if (scanned > 0) {
        addTodayScanCount(scanned);
        await persist('contacts', contacts);
    }
    const stats = getGroupScanStats(contacts[group]);
    return { scanned, valid, invalid, pending: stats.pending, waUsed: activeWaCount };
}

async function runBackgroundScanLoop() {
    bgScanJob.running = true;
    bgScanJob.stop = false;
    bgScanJob.finishedAt = null;
    bgScanJob.lastMessage = 'Scanning…';
    try {
        while (!bgScanJob.stop) {
            if (!anyConnected()) {
                bgScanJob.lastMessage = 'WhatsApp offline — waiting…';
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            const result = await processScanChunk(bgScanJob.group, bgScanJob.sessionIds, true);
            if (result.error === 'No WA') {
                bgScanJob.lastMessage = 'No connected WhatsApp';
                break;
            }
            bgScanJob.scanned += result.scanned || 0;
            bgScanJob.valid += result.valid || 0;
            bgScanJob.invalid += result.invalid || 0;
            bgScanJob.pendingLeft = result.pending != null ? result.pending : 0;
            bgScanJob.lastMessage = '+' + (result.scanned || 0) + ' this batch · pending ' + bgScanJob.pendingLeft;

            if (!result.scanned || result.pending === 0) {
                bgScanJob.lastMessage = 'Complete · total scanned ' + bgScanJob.scanned;
                break;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e) {
        bgScanJob.lastMessage = 'Error: ' + (e.message || 'scan failed');
    }
    bgScanJob.running = false;
    bgScanJob.finishedAt = new Date().toISOString();
    if (bgScanJob.stop) bgScanJob.lastMessage = 'Stopped by user · scanned ' + bgScanJob.scanned;
}

let autoScanRunning = false;
async function runAutoScanTick() {
    if (bgScanJob.running || autoScanRunning || !anyConnected() || anyCampaignActive()) return;
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
    for (const c of liveCampaigns.values()) {
        if (!c.isActive || c.cancelFlag) continue;
        c.status = (reason.includes('Night')) ? 'night_rest' : 'resting';
        c.restReason = reason;
        c.resumeAt = resumeAt.toISOString();
    }
    let left = ms;
    while (left > 0) {
        await new Promise(r => setTimeout(r, Math.min(5000, left)));
        if (reason.includes('Night') && Date.now() < skipSleepUntil) break;
        left = resumeAt.getTime() - Date.now();
        for (const c of liveCampaigns.values()) {
            if (!c.isActive || c.cancelFlag) continue;
            c.resumeAt = new Date(Date.now() + left).toISOString();
        }
    }
    for (const c of liveCampaigns.values()) {
        if (!c.isActive || c.cancelFlag) continue;
        c.status = 'sending';
        c.restReason = '';
        c.resumeAt = null;
    }
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
    const existing = sessions.get(sessionId);
    if (existing && existing._starting) {
        console.log(`[${sessionId}] start already in progress — skip`);
        return;
    }
    if (existing) existing._starting = true;

    // Purana socket quietly band (reconnect race kam)
    try {
        if (existing && existing.sock) {
            try { existing.sock.ev.removeAllListeners(); } catch (e) {}
            try { existing.sock.end(undefined); } catch (e) {}
            existing.sock = null;
            existing.connected = false;
        }
    } catch (e) {}

    const { state, saveCreds } = await getAuthState(sessionId);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500,
        getMessage: async () => undefined
    });

    const session = sessions.get(sessionId) || {
        id: sessionId, name: sessionName || sessionId, sock: null, connected: false,
        qrCode: null, restUntil: null, sentInBatch: 0, batchSize: SESSION_BATCH
    };
    session.sock = sock; session.name = sessionName || session.name; session._starting = false;
    sessions.set(sessionId, session);

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
            // Multi-session: staggered reconnect (cascade drop kam)
            const base = (code === 440 || code === DisconnectReason.connectionReplaced) ? 12000 : 6000;
            const jitter = Math.floor(Math.random() * 8000);
            const delay = base + jitter;
            if (!s._reconnectTimer && !deletedSessionIds.has(sessionId) && sessions.has(sessionId)) {
                s._reconnectTimer = setTimeout(() => {
                    s._reconnectTimer = null;
                    if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
                    startSession(sessionId, s.name).catch(() => {});
                }, delay);
            }
        } else if (connection === 'open') {
            if (deletedSessionIds.has(sessionId) || !sessions.has(sessionId)) return;
            s.connected = true; s.qrCode = null; s._starting = false;
            if (!s.firstConnectedAt) s.firstConnectedAt = new Date().toISOString();
            const meta = { ...getMeta() };
            if (!meta.firstConnectedAt) { meta.firstConnectedAt = new Date().toISOString(); persist('meta', meta); }
            if (!meta.sessionFirstSeen) meta.sessionFirstSeen = {};
            if (!meta.sessionFirstSeen[sessionId]) {
                meta.sessionFirstSeen[sessionId] = s.firstConnectedAt;
                persist('meta', meta);
            } else {
                s.firstConnectedAt = meta.sessionFirstSeen[sessionId];
            }
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
        try {
            if (m.type !== 'notify') return;
            const msg = m.messages && m.messages[0];
            if (!msg || !msg.message || !msg.key) return;
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;
            const phone = jid.split('@')[0].replace(/\D/g, '');
            if (!phone) return;
            const fromMe = !!msg.key.fromMe;
            // unwrap ephemeral / viewOnce / edited
            let content = msg.message;
            if (content.ephemeralMessage && content.ephemeralMessage.message) content = content.ephemeralMessage.message;
            if (content.viewOnceMessage && content.viewOnceMessage.message) content = content.viewOnceMessage.message;
            if (content.viewOnceMessageV2 && content.viewOnceMessageV2.message) content = content.viewOnceMessageV2.message;
            if (content.templateMessage) content = content.templateMessage.hydratedTemplate || content;
            const messageType = Object.keys(content)[0];
            let text = '';
            if (messageType === 'conversation') text = (content.conversation || '').trim();
            else if (messageType === 'extendedTextMessage') text = (content.extendedTextMessage && content.extendedTextMessage.text || '').trim();
            else if (messageType === 'imageMessage') text = (content.imageMessage && content.imageMessage.caption) || '[Photo]';
            else if (messageType === 'videoMessage') text = (content.videoMessage && content.videoMessage.caption) || '[Video]';
            else if (messageType === 'documentMessage') text = (content.documentMessage && content.documentMessage.fileName) || '[Document]';
            else if (messageType === 'audioMessage' || messageType === 'pttMessage' || messageType === 'pttMessageV2') text = '[Audio]';
            else if (messageType === 'buttonsResponseMessage') text = (content.buttonsResponseMessage && content.buttonsResponseMessage.selectedDisplayText) || '';
            else if (messageType === 'listResponseMessage') text = (content.listResponseMessage && content.listResponseMessage.title) || '';
            else text = '';
            if (!text) return;
            // media-only: still allow short ack via gemini
            if (text === '[Photo]' || text === '[Video]' || text === '[Audio]' || text === '[Document]') {
                if (!(getSessionBot(sessionId) && getSessionBot(sessionId).enabled)) return;
            }

            let pushName = (msg.pushName || '').trim();
            pushInboxMessage({
                phone,
                name: pushName || phone,
                text,
                fromMe,
                sessionId,
                sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) || sessionId
            });

            if (fromMe) return;

            // Blacklist: no bot reply
            if (isBlacklisted(phone)) return;

            // Number quality — count reply
            try { bumpNumberQuality(phone, 'replies'); } catch (e) {}

            // Human handoff keywords
            try {
                const low0 = text.toLowerCase();
                if (/(agent|human|person|team|operator|बात कर|agent please)/i.test(low0)) {
                    const pro = getPro();
                    pro.handoff = pro.handoff || {};
                    pro.handoff[normPhone(phone)] = { at: Date.now(), sessionId, name: pushName || phone };
                    persist('pro', pro);
                    const ack = 'Aapko team se connect kar rahe hain. Please wait — human agent reply karega.';
                    try {
                        await sock.sendMessage(jid, { text: ack });
                        pushInboxMessage({ phone, name: pushName || phone, text: ack, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    } catch (e) {}
                    try { if (typeof sendPushToAll === 'function') sendPushToAll('Human handoff', (pushName || phone) + ' agent maang raha hai'); } catch (e) {}
                    return;
                }
            } catch (e) {}

            // If handoff active — no bot
            try {
                const ho = (getPro().handoff || {})[normPhone(phone)];
                if (ho) return;
            } catch (e) {}

            // Simple order flow state machine
            try {
                const pro = getPro();
                const n = normPhone(phone);
                const flow = (pro.orderFlow || {})[n];
                const low = text.toLowerCase().trim();
                if (flow && flow.step) {
                    if (flow.step === 'qty') {
                        flow.qty = text.trim();
                        flow.step = 'city';
                        pro.orderFlow[n] = flow;
                        persist('pro', pro);
                        const t = 'Quantity note ho gayi (' + flow.qty + '). Delivery city / area bataiye?';
                        await sock.sendMessage(jid, { text: t });
                        pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                        return;
                    }
                    if (flow.step === 'city') {
                        flow.city = text.trim();
                        flow.step = 'done';
                        pro.orderFlow[n] = flow;
                        persist('pro', pro);
                        const t = 'Order summary:\nProduct interest: ' + (flow.product || '—') + '\nQty: ' + (flow.qty || '—') + '\nCity: ' + (flow.city || '—') + '\n\nTeam confirm karke rate/delivery bataogi. Dhanyavaad!';
                        await sock.sendMessage(jid, { text: t });
                        pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                        try { if (typeof sendPushToAll === 'function') sendPushToAll('Order lead', n + ' ' + (flow.qty || '') + ' ' + (flow.city || '')); } catch (e) {}
                        return;
                    }
                }
                if (/(order|book|khareedna|lena hai|order kar)/i.test(low)) {
                    pro.orderFlow = pro.orderFlow || {};
                    pro.orderFlow[n] = { step: 'qty', product: text.slice(0, 80), at: Date.now() };
                    persist('pro', pro);
                    const t = 'Order help karta hoon. Kitni quantity chahiye?';
                    await sock.sendMessage(jid, { text: t });
                    pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    return;
                }
            } catch (e) {}

            // Voice note — no STT, ask text
            if (text === '[Audio]') {
                try {
                    const t = 'Voice note mil gaya. Clear reply ke liye short text mein likh dein — main turant help karunga.';
                    await sock.sendMessage(jid, { text: t });
                    pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                } catch (e) {}
                return;
            }

            // Keyword → team alert log
            try {
                const pro = getPro();
                const keys = pro.keywords || [];
                const low = text.toLowerCase();
                const hit = keys.find(k => k && low.includes(String(k).toLowerCase()));
                if (hit) {
                    pro.keywordHits = pro.keywordHits || [];
                    pro.keywordHits.unshift({
                        phone, name: pushName || phone, keyword: hit, text: text.slice(0, 200),
                        sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) || '',
                        at: Date.now(), atText: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
                    });
                    if (pro.keywordHits.length > 100) pro.keywordHits = pro.keywordHits.slice(0, 100);
                    persist('pro', pro);
                    try {
                        if (typeof sendPushToAll === 'function') {
                            sendPushToAll('Keyword: ' + hit, (pushName || phone) + ': ' + text.slice(0, 80));
                        }
                    } catch (e) {}
                }
            } catch (e) {}

            const botCfgEarly = getSessionBot(sessionId);
            const geminiOn = !!(botCfgEarly && botCfgEarly.enabled);
            if (!isAutoReplyEnabled && !geminiOn) return;

            // Business hours gate for auto replies
            if (!isWithinBusinessHours()) {
                const offMsg = (getPro().businessHours && getPro().businessHours.offMessage) || 'Business hours ke baad reply karenge.';
                try {
                    await sock.sendMessage(jid, { text: offMsg });
                    pushInboxMessage({ phone, name: pushName || phone, text: offMsg, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                } catch (e) {}
                return;
            }

            const lower = text.toLowerCase();
            // Menu-style auto reply only when THIS WA has Gemini OFF
            if (isAutoReplyEnabled && !geminiOn) {
                try {
                    if (lower === 'hi' || lower === 'hello' || lower === 'menu' || lower === 'hii' || lower === 'hey') {
                        await sock.sendMessage(jid, { text: autoReplyMessage });
                        pushInboxMessage({ phone, name: pushName || phone, text: autoReplyMessage, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    } else if (lower === '1') {
                        const t = 'यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है। Detail ke liye team se baat karein.';
                        await sock.sendMessage(jid, { text: t });
                        pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    } else if (lower === '2') {
                        const t = 'Price list ke liye apna requirement likhein — team jaldi reply karegi.';
                        await sock.sendMessage(jid, { text: t });
                        pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    } else if (lower === '3') {
                        const t = 'Sawaal likh dein — hamari team jald contact karegi. Dhanyavaad!';
                        await sock.sendMessage(jid, { text: t });
                        pushInboxMessage({ phone, text: t, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                    }
                } catch (e) {}
                return;
            }

            // Per-WhatsApp Gemini chatbot
            const botCfg = getSessionBot(sessionId);
            if (botCfg && botCfg.enabled) {
                const apiKey = (typeof getGeminiKey === 'function' ? getGeminiKey() : '') || '';
                if (!apiKey) {
                    lastGeminiBotError = 'Gemini API key missing — AI Studio mein key save karo';
                    botCfg.lastError = lastGeminiBotError;
                    console.error(lastGeminiBotError);
                    return;
                }
                try {
                    const chat = (getInbox().chats[phone] && getInbox().chats[phone].messages) || [];
                    const recent = chat.slice(-12).map(x => (x.fromMe ? 'Business' : 'Customer') + ': ' + x.text).join('\n');
                    let knowledge = botCfg.knowledge || '';
                    if (!knowledge && /https?:\/\//i.test(botCfg.prompt || '')) {
                        try {
                            knowledge = await refreshBotKnowledgeFromPrompt(botCfg.prompt);
                            botCfg.knowledge = knowledge;
                            await saveBotSettingsToMeta();
                        } catch (e) {}
                    }
                    const waName = (sessions.get(sessionId) && sessions.get(sessionId).name) || sessionId;
                    const prompt = `You are an intelligent WhatsApp business assistant (like Gemini app — thoughtful, helpful, context-aware).

This chat is on WhatsApp account: "${waName}".
You ONLY represent THIS account's business (different WhatsApp numbers may be different businesses).

Owner instructions for THIS WhatsApp:
${botCfg.prompt || 'Be professional and helpful.'}

${knowledge ? ('Detailed business knowledge (website / Facebook / page text — READ carefully and use facts from here):\n' + knowledge + '\n') : 'No page knowledge loaded — rely on owner instructions and ask smart questions if needed.\n'}
${(getPro().faqText ? ('FAQ / price list text:\n' + String(getPro().faqText).slice(0, 6000) + '\n') : '')}

Intelligence rules (very important):
1. Read the full knowledge and instructions before answering.
2. Answer the customer's exact question with useful detail (not one-word).
3. If price / product / location / timing is NOT in knowledge, ask ONE short clarifying question to get what you need, then help.
4. NEVER send the old numbered menu (1 service, 2 price, 3 contact) unless customer asks for menu/options.
5. Do not invent fake prices, addresses, or claims not in knowledge.
6. Natural Hinglish or Hindi, 2–6 short lines, warm and professional.
7. If customer greets only (hi/hello), give a smart welcome about THIS business + invite their need — not a rigid 1/2/3 menu.
8. Use recent chat memory so replies feel continuous.
9. Language: ${(getPro().multiLang !== false) ? detectLangHint(text) : 'Hinglish'}
10. Max ONE clarifying question if needed.

Recent chat:
${recent}

Customer just said: ${text}

Write ONLY the WhatsApp reply (no quotes, no labels).`;
                    async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
                    // Prefer models that support generateContent (no legacy gemini-pro)
                    let models = [
                        'gemini-2.0-flash',
                        'gemini-2.0-flash-lite',
                        'gemini-2.0-flash-001',
                        'gemini-1.5-flash',
                        'gemini-1.5-flash-latest',
                        'gemini-1.5-flash-8b',
                        'gemini-1.5-pro',
                        'gemini-1.5-pro-latest'
                    ];
                    try {
                        const lr = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey));
                        const ld = await lr.json();
                        if (lr.ok && ld.models && ld.models.length) {
                            const fromApi = ld.models
                                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                                .map(m => String(m.name || '').replace(/^models\//, ''))
                                .filter(n => /flash|pro/i.test(n) && !/embed|tts|image|vision/i.test(n));
                            // flash first
                            fromApi.sort((a, b) => {
                                const score = (n) => (/flash-lite/i.test(n) ? 0 : /flash/i.test(n) ? 1 : 2);
                                return score(a) - score(b);
                            });
                            if (fromApi.length) models = fromApi.slice(0, 8);
                        }
                    } catch (e) {}
                    let reply = '';
                    let lastErr = '';
                    for (const model of models) {
                        for (let attempt = 0; attempt < 2; attempt++) {
                            try {
                                if (attempt > 0) await sleep(1000 * attempt);
                                const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
                                const r = await fetch(url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                                        generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
                                    })
                                });
                                const data = await r.json();
                                if (!r.ok) {
                                    lastErr = model + ': ' + ((data.error && data.error.message) || ('HTTP ' + r.status));
                                    if (r.status === 404 || /not found|not supported/i.test(lastErr)) break;
                                    if (r.status === 429 || /high demand|resource exhausted|quota|rate/i.test(lastErr)) continue;
                                    break;
                                }
                                try { reply = data.candidates[0].content.parts.map(p => p.text || '').join('').trim(); } catch (e) { lastErr = model + ': empty candidates'; reply = ''; }
                                if (reply) break;
                            } catch (e) {
                                lastErr = model + ': ' + (e.message || String(e));
                            }
                        }
                        if (reply) break;
                    }
                    reply = (reply || '').replace(/^["']|["']$/g, '').slice(0, 1500);
                    if (!reply) {
                        lastGeminiBotError = lastErr || 'Gemini empty reply';
                        botCfg.lastError = lastGeminiBotError;
                        console.error('gemini bot no reply', lastGeminiBotError);
                        return;
                    }
                    lastGeminiBotError = null;
                    botCfg.lastError = null;
                    await sock.sendMessage(jid, { text: reply });
                    pushInboxMessage({ phone, name: pushName || phone, text: reply, fromMe: true, sessionId, sessionName: (sessions.get(sessionId) && sessions.get(sessionId).name) });
                } catch (e) {
                    lastGeminiBotError = e.message || String(e);
                    console.error('gemini bot reply fail', lastGeminiBotError);
                }
            }
        } catch (e) {
            console.error('messages.upsert', e.message || e);
        }
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
    const anyBot = Object.values(sessionBots || {}).some(b => b && b.enabled);
    res.json({ connected: anyConnected(), qrCode: primary && !primary.connected ? primary.qrCode : null, sessions: list, autoReply: isAutoReplyEnabled, geminiBot: anyBot, geminiBotError: lastGeminiBotError, currentMsg: autoReplyMessage, storage: useMongo ? 'mongodb' : 'local' });
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


app.get('/api/inbox', (req, res) => {
    res.json({ success: true, chats: listInboxChats() });
});
app.get('/api/inbox/:phone', (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const chat = (getInbox().chats || {})[phone];
    if (!chat) return res.json({ success: true, phone, messages: [], name: phone });
    chat.unread = 0;
    persist('inbox', getInbox());
    res.json({ success: true, phone, name: chat.name || phone, messages: chat.messages || [], sessionName: chat.sessionName || '' });
});
app.post('/api/inbox/send', async (req, res) => {
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!phone || !text) return res.status(400).json({ success: false, error: 'phone/text missing' });
    const chat = (getInbox().chats || {})[phone];
    let sock = null;
    let sid = (req.body && req.body.sessionId) || (chat && chat.sessionId);
    if (sid && sessions.get(sid) && sessions.get(sid).connected) sock = sessions.get(sid).sock;
    if (!sock) {
        const s = getSelectedOrRandomSock(null);
        sock = s;
        const _found = Array.from(sessions.values()).find(x => x.sock === sock); sid = _found && _found.id;
    }
    if (!sock) return res.status(400).json({ success: false, error: 'WhatsApp connect nahi hai' });
    try {
        const jid = phone.includes('@') ? phone : (phone + '@s.whatsapp.net');
        await sock.sendMessage(jid, { text });
        pushInboxMessage({ phone, text, fromMe: true, sessionId: sid, sessionName: (sessions.get(sid) && sessions.get(sid).name) });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'send fail' });
    }
});
app.get('/api/session-bot', (req, res) => {
    const sid = String(req.query.sessionId || '');
    if (!sid) {
        return res.json({
            success: true,
            sessions: listSessionsPublic().map(s => {
                const b = getSessionBot(s.id);
                return { id: s.id, name: s.name, connected: s.connected, botEnabled: !!b.enabled, hasKnowledge: !!(b.knowledge && b.knowledge.length > 20), lastError: b.lastError || null };
            }),
            autoReply: isAutoReplyEnabled,
            hasGeminiKey: !!(typeof getGeminiKey === 'function' && getGeminiKey())
        });
    }
    const b = getSessionBot(sid);
    res.json({
        success: true,
        sessionId: sid,
        enabled: !!b.enabled,
        prompt: b.prompt || '',
        knowledgeChars: (b.knowledge || '').length,
        lastError: b.lastError || lastGeminiBotError,
        autoReply: isAutoReplyEnabled,
        currentMsg: autoReplyMessage,
        hasGeminiKey: !!(typeof getGeminiKey === 'function' && getGeminiKey())
    });
});
app.post('/toggle-geminibot', async (req, res) => {
    let sid = String((req.body && req.body.sessionId) || '');
    if (!sid) {
        const list = listSessionsPublic();
        const online = list.find(s => s.connected) || list[0];
        sid = online ? online.id : '';
    }
    if (!sid) return res.status(400).json({ success: false, error: 'Pehle WhatsApp connect karo' });
    const b = getSessionBot(sid);
    b.enabled = !!(req.body && req.body.enabled);
    b.lastError = null;
    lastGeminiBotError = null;
    sessionBots[sid] = b;
    await saveBotSettingsToMeta();
    console.log('[bot] toggle', sid, 'enabled=', b.enabled);
    res.json({ success: true, sessionId: sid, geminiBot: b.enabled, autoReply: isAutoReplyEnabled, hasGeminiKey: !!(typeof getGeminiKey === 'function' && getGeminiKey()) });
});
app.post('/update-geminibot-prompt', async (req, res) => {
    let sid = String((req.body && req.body.sessionId) || '');
    if (!sid) {
        const list = listSessionsPublic();
        const online = list.find(s => s.connected) || list[0];
        sid = online ? online.id : '';
    }
    if (!sid) return res.status(400).json({ success: false, error: 'Pehle WhatsApp connect karo' });
    const b = getSessionBot(sid);
    if (req.body && typeof req.body.prompt === 'string') b.prompt = req.body.prompt;
    const promptText = b.prompt || '';
    const hasUrl = /https?:\/\//i.test(promptText) || /(?:facebook|fb|instagram)\.com/i.test(promptText);
    let fetched = false;
    try {
        if (hasUrl) {
            const k = await refreshBotKnowledgeFromPrompt(promptText);
            if (k) {
                b.knowledge = k;
                fetched = true;
            }
            // keep old knowledge if fetch fails and user only updated text slightly
            if (!fetched && !b.knowledge) b.knowledge = '';
        } else {
            // no link — instructions text itself is the knowledge
            b.knowledge = promptText.slice(0, 12000);
            fetched = false;
        }
    } catch (e) {}
    await saveBotSettingsToMeta();
    let note = 'Instructions save ho gayi — bot is text se jawab dega';
    if (hasUrl && fetched) note = 'Page content + instructions save — bot dono se jawab dega';
    if (hasUrl && !fetched) note = 'Instructions save. Link se page nahi padha (Facebook block). Jo text likha hai usi se bot chalega.';
    res.json({
        success: true,
        sessionId: sid,
        knowledgeLoaded: fetched || (!hasUrl && !!(b.prompt && b.prompt.trim())),
        knowledgeChars: (b.knowledge || b.prompt || '').length,
        hasUrl: !!hasUrl,
        note
    });
});

app.post('/toggle-autoreply', async (req, res) => {
    isAutoReplyEnabled = !!(req.body && req.body.enabled);
    await saveBotSettingsToMeta();
    res.json({ success: true, autoReply: isAutoReplyEnabled });
});
app.post('/update-autoreply', async (req, res) => {
    if (req.body && req.body.message != null) autoReplyMessage = req.body.message;
    await saveBotSettingsToMeta();
    res.json({ success: true });
});

app.get('/api/pro', (req, res) => {
    const pro = getPro();
    res.json({
        success: true,
        blacklist: pro.blacklist || [],
        quickReplies: pro.quickReplies || [],
        followUps: (pro.followUps || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0)),
        keywords: pro.keywords || [],
        keywordHits: (pro.keywordHits || []).slice(0, 30),
        leadTags: pro.leadTags || {},
        crmNotes: pro.crmNotes || {},
        chatAssign: pro.chatAssign || {},
        handoff: pro.handoff || {},
        templateStats: pro.templateStats || {},
        sessionStats: pro.sessionStats || {},
        numberQuality: pro.numberQuality || {},
        sequences: pro.sequences || {},
        signatures: pro.signatures || [],
        signatureEnabled: pro.signatureEnabled !== false,
        templateCooldownHours: pro.templateCooldownHours != null ? pro.templateCooldownHours : 24,
        warmupEnabled: pro.warmupEnabled !== false,
        catalog: pro.catalog ? { fileName: pro.catalog.fileName, hasFile: true } : null,
        faqText: pro.faqText || '',
        hasPin: !!(pro.pinHash),
        businessHours: pro.businessHours || {},
        multiLang: pro.multiLang !== false
    });
});

app.post('/api/pro/crm-note', async (req, res) => {
    const phone = normPhone(req.body && req.body.phone);
    const note = String((req.body && req.body.note) || '').slice(0, 1000);
    if (!phone) return res.status(400).json({ success: false, error: 'phone missing' });
    const pro = getPro();
    pro.crmNotes = pro.crmNotes || {};
    pro.crmNotes[phone] = note;
    await savePro();
    res.json({ success: true });
});
app.post('/api/pro/assign', async (req, res) => {
    const phone = normPhone(req.body && req.body.phone);
    const agent = String((req.body && req.body.agent) || '').trim().slice(0, 40);
    if (!phone) return res.status(400).json({ success: false, error: 'phone missing' });
    const pro = getPro();
    pro.chatAssign = pro.chatAssign || {};
    if (!agent) delete pro.chatAssign[phone];
    else pro.chatAssign[phone] = agent;
    await savePro();
    res.json({ success: true, chatAssign: pro.chatAssign });
});
app.post('/api/pro/handoff', async (req, res) => {
    const phone = normPhone(req.body && req.body.phone);
    const action = (req.body && req.body.action) || 'clear';
    const pro = getPro();
    pro.handoff = pro.handoff || {};
    if (action === 'clear' && phone) delete pro.handoff[phone];
    else if (action === 'clear-all') pro.handoff = {};
    await savePro();
    res.json({ success: true, handoff: pro.handoff });
});
app.post('/api/pro/sequences', async (req, res) => {
    const pro = getPro();
    const b = req.body || {};
    pro.sequences = {
        enabled: !!b.enabled,
        day0: String(b.day0 || '').slice(0, 500),
        day3: String(b.day3 || '').slice(0, 500),
        day7: String(b.day7 || '').slice(0, 500)
    };
    await savePro();
    res.json({ success: true, sequences: pro.sequences });
});
app.post('/api/pro/signatures', async (req, res) => {
    const pro = getPro();
    if (Array.isArray(req.body && req.body.signatures)) {
        pro.signatures = req.body.signatures.map(s => String(s).slice(0, 80)).slice(0, 15);
    }
    if (typeof (req.body && req.body.signatureEnabled) === 'boolean') pro.signatureEnabled = req.body.signatureEnabled;
    if (req.body && req.body.templateCooldownHours != null) pro.templateCooldownHours = Math.min(72, Math.max(1, Number(req.body.templateCooldownHours) || 24));
    if (typeof (req.body && req.body.warmupEnabled) === 'boolean') pro.warmupEnabled = req.body.warmupEnabled;
    await savePro();
    res.json({ success: true });
});
app.post('/api/pro/catalog', async (req, res) => {
    const pro = getPro();
    if (req.body && req.body.clear) { pro.catalog = null; await savePro(); return res.json({ success: true }); }
    const fileBase64 = req.body && req.body.fileBase64;
    if (!fileBase64) return res.status(400).json({ success: false, error: 'file missing' });
    pro.catalog = {
        fileBase64: String(fileBase64).slice(0, 12 * 1024 * 1024),
        fileName: String((req.body && req.body.fileName) || 'catalog.pdf').slice(0, 80),
        fileMime: String((req.body && req.body.fileMime) || 'application/pdf')
    };
    await savePro();
    res.json({ success: true, catalog: { fileName: pro.catalog.fileName, hasFile: true } });
});
app.post('/api/pro/send-catalog', async (req, res) => {
    const phone = normPhone(req.body && req.body.phone);
    const pro = getPro();
    if (!pro.catalog || !pro.catalog.fileBase64) return res.status(400).json({ success: false, error: 'Catalog upload karo pehle' });
    if (!phone) return res.status(400).json({ success: false, error: 'phone missing' });
    const sock = getSelectedOrRandomSock(null);
    if (!sock) return res.status(400).json({ success: false, error: 'WhatsApp connect nahi' });
    try {
        const raw = pro.catalog.fileBase64.includes(',') ? pro.catalog.fileBase64.split(',')[1] : pro.catalog.fileBase64;
        const buf = Buffer.from(raw, 'base64');
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { document: buf, mimetype: pro.catalog.fileMime || 'application/pdf', fileName: pro.catalog.fileName || 'catalog.pdf', caption: 'Catalog / price list' });
        pushInboxMessage({ phone, text: '[Catalog sent]', fromMe: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'send fail' });
    }
});
app.post('/api/pro/faq', async (req, res) => {
    const pro = getPro();
    pro.faqText = String((req.body && req.body.faqText) || '').slice(0, 12000);
    await savePro();
    res.json({ success: true });
});
app.post('/api/pro/pin', async (req, res) => {
    const pro = getPro();
    const action = (req.body && req.body.action) || 'set';
    if (action === 'clear') { pro.pinHash = ''; await savePro(); return res.json({ success: true }); }
    if (action === 'check') {
        const ok = !pro.pinHash || pro.pinHash === simplePinHash(req.body && req.body.pin);
        return res.json({ success: true, ok });
    }
    const pin = String((req.body && req.body.pin) || '');
    if (pin.length < 4) return res.status(400).json({ success: false, error: 'PIN min 4 digits' });
    pro.pinHash = simplePinHash(pin);
    await savePro();
    res.json({ success: true });
});
app.get('/api/pro/backup', (req, res) => {
    res.json({
        success: true,
        exportedAt: new Date().toISOString(),
        contacts: getContacts(),
        templates: getTemplates().map(t => ({ ...t, imageBase64: undefined, fileBase64: undefined, attachments: (t.attachments || []).map(a => ({ fileName: a.fileName, fileKind: a.fileKind })) })),
        pro: { ...getPro(), catalog: getPro().catalog ? { fileName: getPro().catalog.fileName } : null },
        meta: { sessions: (getMeta().sessions || []) }
    });
});
app.get('/api/pro/reply-rate', (req, res) => {
    const pro = getPro();
    const nq = pro.numberQuality || {};
    let sent = 0, replies = 0;
    Object.values(nq).forEach(q => { sent += q.sent || 0; replies += q.replies || 0; });
    const rate = sent ? Math.round((replies / sent) * 100) : 0;
    res.json({ success: true, sent, replies, rate });
});


app.post('/api/pro/blacklist', async (req, res) => {
    const pro = getPro();
    const action = (req.body && req.body.action) || 'add';
    const phone = normPhone(req.body && req.body.phone);
    if (!phone) return res.status(400).json({ success: false, error: 'phone missing' });
    if (action === 'remove') pro.blacklist = (pro.blacklist || []).filter(x => normPhone(x) !== phone);
    else if (!(pro.blacklist || []).some(x => normPhone(x) === phone)) pro.blacklist.push(phone);
    await savePro();
    res.json({ success: true, blacklist: pro.blacklist });
});
app.post('/api/pro/quick-replies', async (req, res) => {
    const pro = getPro();
    if (Array.isArray(req.body && req.body.quickReplies)) {
        pro.quickReplies = req.body.quickReplies.filter(x => x && String(x.text || '').trim()).slice(0, 20).map((x, i) => ({
            id: x.id || ('qr_' + Date.now() + '_' + i),
            text: String(x.text).trim().slice(0, 500)
        }));
    }
    await savePro();
    res.json({ success: true, quickReplies: pro.quickReplies });
});
app.post('/api/pro/followups', async (req, res) => {
    const pro = getPro();
    const action = (req.body && req.body.action) || 'add';
    if (action === 'delete') {
        const id = req.body.id;
        pro.followUps = (pro.followUps || []).filter(f => f.id !== id);
    } else if (action === 'done') {
        const id = req.body.id;
        const f = (pro.followUps || []).find(x => x.id === id);
        if (f) f.done = true;
    } else {
        const phone = normPhone(req.body && req.body.phone);
        const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
        const when = req.body && req.body.when;
        if (!phone || !when) return res.status(400).json({ success: false, error: 'phone + when required' });
        const at = new Date(when).getTime();
        if (!at) return res.status(400).json({ success: false, error: 'invalid when' });
        pro.followUps = pro.followUps || [];
        pro.followUps.push({
            id: 'fu_' + Date.now(),
            phone,
            name: String((req.body && req.body.name) || phone),
            note: note || 'Follow up',
            at,
            atText: new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            done: false
        });
    }
    await savePro();
    res.json({ success: true, followUps: pro.followUps });
});
app.post('/api/pro/keywords', async (req, res) => {
    const pro = getPro();
    if (Array.isArray(req.body && req.body.keywords)) {
        pro.keywords = req.body.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 40);
    }
    await savePro();
    res.json({ success: true, keywords: pro.keywords });
});
app.post('/api/pro/lead-tag', async (req, res) => {
    const pro = getPro();
    const phone = normPhone(req.body && req.body.phone);
    const tag = String((req.body && req.body.tag) || '').toLowerCase();
    if (!phone) return res.status(400).json({ success: false, error: 'phone missing' });
    if (!['hot', 'warm', 'cold', ''].includes(tag)) return res.status(400).json({ success: false, error: 'tag hot|warm|cold|empty' });
    pro.leadTags = pro.leadTags || {};
    if (!tag) delete pro.leadTags[phone];
    else pro.leadTags[phone] = tag;
    // also on inbox chat
    try {
        const inbox = getInbox();
        if (inbox.chats[phone]) { inbox.chats[phone].leadTag = tag || null; persist('inbox', inbox); }
    } catch (e) {}
    await savePro();
    res.json({ success: true, leadTags: pro.leadTags });
});
app.post('/api/pro/business-hours', async (req, res) => {
    const pro = getPro();
    const b = req.body || {};
    pro.businessHours = {
        enabled: !!b.enabled,
        start: Number(b.start != null ? b.start : 8),
        end: Number(b.end != null ? b.end : 22),
        offMessage: String(b.offMessage || pro.businessHours.offMessage || '').slice(0, 500)
    };
    if (typeof b.multiLang === 'boolean') pro.multiLang = b.multiLang;
    await savePro();
    res.json({ success: true, businessHours: pro.businessHours, multiLang: pro.multiLang !== false });
});


app.get('/api/stats', (req, res) => {
    const stats = getStats();
    const date = req.query.date;
    if (date) return res.json(stats[date] || { sent: 0, failed: 0 });
    const sent = Object.values(stats).reduce((a, b) => a + (b.sent || 0), 0);
    const failed = Object.values(stats).reduce((a, b) => a + (b.failed || 0), 0);
    const days = [];
    for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString('en-CA');
        const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        const row = stats[key] || { sent: 0, failed: 0 };
        days.push({ date: key, label, sent: row.sent || 0, failed: row.failed || 0 });
    }
    res.json({ sent, failed, days });
});
app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/live-status', (req, res) => {
    const agg = aggregateLiveForCompat();
    res.json({ ...agg, sleepDisabled: Date.now() < skipSleepUntil, campaigns: listCampaignsPublic().filter(c => c.isActive) });
});

app.post('/api/toggle-pause', (req, res) => {
    const campaignId = req.body && req.body.campaignId;
    const pause = !!req.body.pause;
    let targets = [];
    if (campaignId && liveCampaigns.has(campaignId)) {
        targets = [liveCampaigns.get(campaignId)];
    } else {
        targets = Array.from(liveCampaigns.values()).filter(c => c.isActive && !c.cancelFlag);
    }
    if (!targets.length) return res.json({ success: true, isPaused: false, message: 'No active campaign' });
    targets.forEach(c => {
        c.isPaused = pause;
        if (pause) {
            c.status = 'paused';
            c.restReason = '🛑 Campaign Paused by User';
        } else {
            c.status = 'sending';
            c.restReason = '';
        }
    });
    res.json({ success: true, isPaused: pause });
});

app.post('/api/campaign/delete', (req, res) => {
    const campaignId = req.body && req.body.campaignId;
    let sent = 0, failed = 0, count = 0;
    if (campaignId && liveCampaigns.has(campaignId)) {
        const c = liveCampaigns.get(campaignId);
        c.cancelFlag = true;
        c.isActive = false;
        c.isPaused = false;
        c.status = 'idle';
        sent = c.sent || 0;
        failed = c.failed || 0;
        liveCampaigns.delete(campaignId);
        count = 1;
    } else {
        for (const [id, c] of liveCampaigns.entries()) {
            if (!c.isActive) continue;
            c.cancelFlag = true;
            c.isActive = false;
            sent += c.sent || 0;
            failed += c.failed || 0;
            liveCampaigns.delete(id);
            count++;
        }
    }
    res.json({
        success: true,
        message: count ? (count + ' campaign deleted / stopped') : 'No active campaign',
        lastSent: sent,
        lastFailed: failed
    });
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
app.post('/api/templates/update', async (req, res) => {
    const body = req.body || {};
    const id = body.id;
    if (!id) return res.status(400).json({ success: false, error: 'id missing' });
    let t = getTemplates();
    const idx = t.findIndex(x => x.id === id);
    if (idx < 0) return res.status(404).json({ success: false, error: 'template not found' });
    t[idx] = { ...t[idx], ...body, id };
    await persist('templates', t);
    res.json({ success: true, template: t[idx] });
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

// ——— Gemini AI Assistant ———
function getGeminiKey() {
    return process.env.GEMINI_API_KEY || (getMeta().geminiApiKey || '');
}

app.get('/api/ai/settings', (req, res) => {
    const key = getGeminiKey();
    res.json({
        success: true,
        hasKey: !!key,
        keyPreview: key ? (key.slice(0, 8) + '…' + key.slice(-4)) : null
    });
});

app.post('/api/ai/settings', async (req, res) => {
    const key = String((req.body && req.body.geminiApiKey) || '').trim();
    const meta = { ...getMeta() };
    if (key === '') delete meta.geminiApiKey;
    else meta.geminiApiKey = key;
    // clear old multi-provider keys if any
    delete meta.imageProvider;
    delete meta.cfAccountId;
    delete meta.cfApiToken;
    delete meta.hfToken;
    await persist('meta', meta);
    res.json({ success: true, hasKey: !!meta.geminiApiKey });
});

app.post('/api/ai/generate', async (req, res) => {
    const apiKey = getGeminiKey();
    if (!apiKey) {
        return res.status(400).json({
            success: false,
            error: 'Gemini API key nahi mili. AI Studio mein key save karo (aistudio.google.com/apikey).'
        });
    }
    let topic = String((req.body && req.body.topic) || '').trim();
    let websiteUrl = String((req.body && req.body.websiteUrl) || '').trim();
    const tone = String((req.body && req.body.tone) || 'friendly').trim();
    const language = String((req.body && req.body.language) || 'hinglish').trim();
    let mode = String((req.body && req.body.mode) || 'text').trim();
    if (mode === 'image' || mode === 'all') mode = 'text';
    const allowedModels = {
        'gemini-3.7-flash': true,
        'gemini-3.5-flash-lite': true,
        'gemini-3.1-pro-preview': true,
        'gemini-3.1-pro': true,
        'gemini-3.6-flash': true
    };
    let selectedModel = String((req.body && req.body.model) || 'gemini-3.7-flash').trim();
    if (!allowedModels[selectedModel]) selectedModel = 'gemini-3.7-flash';
    let count = parseInt(req.body && req.body.count, 10);
    if (isNaN(count) || count < 1) count = 5;
    count = Math.min(15, count);
    if (!topic && !websiteUrl) return res.status(400).json({ success: false, error: 'Topic ya website link likho' });
    if (!topic && websiteUrl) topic = 'Offer from ' + websiteUrl;

    // If website link diya aur sirf text mode — HTML bhi useful
    if (websiteUrl && mode === 'text') {
        // keep text; user can choose html. don't force
    }

    const wantText = mode === 'text' || mode === 'both';
    const wantHtml = mode === 'html' || mode === 'both';
    const langHint = language === 'hindi' ? 'Pure Hindi (Devanagari)' : (language === 'english' ? 'English only' : 'Hindi-English mix (Hinglish), natural Indian style');

    async function geminiText(prompt, maxTokens) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(selectedModel) + ':generateContent?key=' + encodeURIComponent(apiKey);
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.85, maxOutputTokens: maxTokens || 2048 }
            })
        });
        const data = await r.json();
        if (!r.ok) throw new Error((data.error && data.error.message) || ('Gemini HTTP ' + r.status));
        let text = '';
        try { text = data.candidates[0].content.parts.map(p => p.text || '').join(''); } catch (e) { throw new Error('Gemini empty response'); }
        return text.replace(/```json/gi, '').replace(/```html/gi, '').replace(/```/g, '').trim();
    }

    async function fetchSiteSnippet(urlStr) {
        try {
            let u = urlStr;
            if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
            const r = await fetch(u, {
                method: 'GET',
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WBWBot/1.0)', 'Accept': 'text/html' },
                signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 12000); return c.signal; })()
            });
            if (!r.ok) return { error: 'Site HTTP ' + r.status, text: '' };
            let html = await r.text();
            html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
            const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
            const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
                html.match(/content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1] || '';
            const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
            return { title: title.replace(/\s+/g, ' ').trim().slice(0, 200), metaDesc: String(metaDesc).slice(0, 300), text, url: u };
        } catch (e) {
            return { error: e.message || 'fetch fail', text: '' };
        }
    }

    try {
        let messages = [];
        let files = [];
        let siteInfo = null;
        if (websiteUrl) {
            siteInfo = await fetchSiteSnippet(websiteUrl);
        }

        if (wantText) {
            let prompt = `You are a WhatsApp marketing copywriter for Indian small businesses.
Topic/product: ${topic}
Tone: ${tone}
Language: ${langHint}
`;
            if (siteInfo && siteInfo.text) {
                prompt += `Reference website: ${siteInfo.url}
Site title: ${siteInfo.title || ''}
Site about: ${siteInfo.metaDesc || ''}
Site text sample: ${siteInfo.text.slice(0, 1500)}
Write messages as if promoting this same business/brand.
`;
            }
            prompt += `
Generate exactly ${count} DIFFERENT WhatsApp message variants.
Rules: 2–5 short lines, use [Name] placeholder once for customer name, no spam walls, unique wording, max 1 emoji.
Return ONLY JSON array: ["message1","message2",...]`;
            const text = await geminiText(prompt, 2048);
            try { messages = JSON.parse(text); } catch (e) {
                messages = text.split(/\n+/).map(s => s.replace(/^\d+[\).\s-]+/, '').replace(/^["']|["']$/g, '').trim()).filter(s => s.length > 10);
            }
            if (!Array.isArray(messages)) messages = [];
            messages = messages.map(m => String(m).trim()).filter(Boolean).slice(0, count);
        }

        if (wantHtml) {
            let htmlPrompt = `Create ONE complete standalone HTML5 page — a mobile marketing flyer.
Topic: ${topic}
Tone: ${tone}
Visible text language: ${langHint}

CRITICAL personalization:
- Greet the customer with placeholder exactly [Name] (e.g. "Namaste [Name]," or "Hi [Name],")
- This [Name] will be replaced per contact later

`;
            if (siteInfo && (siteInfo.text || siteInfo.title)) {
                htmlPrompt += `Clone the LOOK and OFFER style of this website (not a pixel-perfect copy — similar colors, brand feel, services):
URL: ${siteInfo.url || websiteUrl}
Title: ${siteInfo.title || ''}
Description: ${siteInfo.metaDesc || ''}
Content sample: ${(siteInfo.text || '').slice(0, 2500)}

Match brand colors if you can infer them. Include business name from the site if clear.
`;
            } else if (websiteUrl) {
                htmlPrompt += `Inspired by website: ${websiteUrl} (could not fully fetch — invent a professional mobile landing matching a typical Indian business site for this topic).\n`;
            }

            htmlPrompt += `
Requirements:
- Full HTML document, inline CSS only, mobile-first (max-width 480px centered)
- Header with brand, personal greeting with [Name], offer section, 3 benefits, CTA button style, footer
- No JavaScript, no external images (CSS gradients/shapes only)
- Return ONLY raw HTML`;

            const html = await geminiText(htmlPrompt, 8192);
            let clean = html.trim();
            if (!/^<!DOCTYPE/i.test(clean) && !/^<html/i.test(clean)) {
                clean = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offer</title></head><body>' + clean + '</body></html>';
            }
            // ensure [Name] exists
            if (!/\[Name\]/i.test(clean)) {
                clean = clean.replace(/<body[^>]*>/i, (m) => m + '<p style="padding:12px;font-family:sans-serif;">Namaste [Name],</p>');
            }
            files.push({
                fileName: 'site-flyer-' + Date.now() + '.html',
                fileMime: 'text/html',
                fileKind: 'document',
                fileBase64: 'data:text/html;base64,' + Buffer.from(clean, 'utf8').toString('base64')
            });
            if (!messages.length) {
                messages = ['[Name], aapke liye personal offer page ready hai — file open karke dekho 👆'];
            }
        }

        if (!messages.length && !files.length) {
            return res.status(500).json({ success: false, error: 'Gemini se output nahi bana' });
        }
        res.json({
            success: true,
            messages,
            files,
            topic,
            websiteUrl: websiteUrl || null,
            siteFetched: !!(siteInfo && siteInfo.text),
            mode,
            model: selectedModel,
            count: messages.length,
            note: files.length
                ? ('HTML flyer ready' + (websiteUrl ? ' (website inspired + [Name])' : ' ([Name] personal)') + ' — template save karke campaign mein bhejo.')
                : null
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message || 'Gemini request failed' });
    }
});

app.post('/api/scan-next', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp connect nahi hai' });
    const { group, sessionIds, scanAll } = req.body || {};
    if (!group) return res.status(400).json({ success: false, error: 'Group select karo' });
    if (bgScanJob.running) {
        return res.status(400).json({ success: false, error: 'Background Scan All pehle se chal raha hai. Stop karke try karo.' });
    }
    const socks = getScanSocks(sessionIds);
    if (!socks.length) return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });

    const result = await processScanChunk(group, sessionIds, !!scanAll);
    if (result.error === 'daily_limit') {
        return res.status(400).json({
            success: false,
            error: 'Aaj ki scan limit puri. Scan All Pending use karo (background, no daily limit).',
            todayScanned: getTodayScanCount()
        });
    }
    const contacts = getContacts();
    res.json({
        success: true,
        scanned: result.scanned,
        valid: result.valid,
        invalid: result.invalid,
        todayScanned: getTodayScanCount(),
        dailyScanLimit: scanAll ? null : getDailyScanLimit() * socks.length,
        unlimited: !!scanAll,
        waUsed: result.waUsed || socks.length,
        delayMode: (result.waUsed || socks.length) >= 2 ? '2-3s multi-WA' : '2.5-5s single-WA',
        groupStats: getGroupScanStats(contacts[group] || [])
    });
});

// Background Scan All — site band / tab band hone pe bhi server pe chalta hai
app.post('/api/scan-all/start', async (req, res) => {
    if (!anyConnected()) return res.status(400).json({ success: false, error: 'WhatsApp connect nahi hai' });
    const { group, sessionIds } = req.body || {};
    if (!group) return res.status(400).json({ success: false, error: 'Group select karo' });
    const contacts = getContacts();
    if (!contacts[group]) return res.status(400).json({ success: false, error: 'Group nahi mila' });
    const socks = getScanSocks(sessionIds);
    if (!socks.length) return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });
    if (bgScanJob.running) {
        return res.json({ success: true, alreadyRunning: true, job: { ...bgScanJob } });
    }
    bgScanJob = {
        running: true,
        stop: false,
        group,
        sessionIds: Array.isArray(sessionIds) ? sessionIds : [],
        scanned: 0,
        valid: 0,
        invalid: 0,
        pendingLeft: getGroupScanStats(contacts[group]).pending,
        lastMessage: 'Starting…',
        startedAt: new Date().toISOString(),
        finishedAt: null
    };
    setImmediate(() => { runBackgroundScanLoop().catch(() => {}); });
    res.json({ success: true, message: 'Background Scan All started — site band karke bhi chalega', job: { ...bgScanJob } });
});

app.post('/api/scan-all/stop', (req, res) => {
    if (!bgScanJob.running) {
        return res.json({ success: true, message: 'Koi background scan nahi chal raha' });
    }
    bgScanJob.stop = true;
    res.json({ success: true, message: 'Stop signal bhej diya — current number ke baad rukega' });
});

app.get('/api/scan-all/status', (req, res) => {
    res.json({ success: true, job: { ...bgScanJob } });
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
    const { numbers, message, minDelay, maxDelay, imageBase64, attachments: reqAttachments, templates, sessionIds, customBatch, customRestHours } = req.body;
    if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ success: false, error: 'Number list empty!' });

    let selectedIds = Array.isArray(sessionIds) && sessionIds.length ? sessionIds : Array.from(sessions.values()).filter(s => s.connected).map(s => s.id);
    selectedIds = selectedIds.filter(id => { const s = getSession(id); return s && s.connected && s.sock; });
    if (!selectedIds.length) return res.status(400).json({ success: false, error: 'Koi connected WhatsApp select nahi hai' });

    // Same WA already busy in another active campaign?
    const busy = sessionsBusyInCampaigns(selectedIds);
    if (busy.length) {
        const names = busy.map(id => { const s = getSession(id); return s ? s.name : id; }).join(', ');
        return res.status(400).json({
            success: false,
            error: 'Ye WhatsApp pehle se campaign mein busy hain: ' + names + '. Alag WA select karo ya pehle campaign delete karo.'
        });
    }

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
    const campaignId = 'camp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const sessionLabel = selectedIds.map(id => { const s = getSession(id); return s ? s.name : id; }).join(' + ');
    const templateNames = useRotation ? templates.map(t => t.name || 'Template').filter(Boolean) : [];
    const campaignName = (templateNames[0] || 'Campaign') + ' · ' + sessionLabel;

    const camp = {
        id: campaignId,
        name: campaignName,
        cancelFlag: false,
        isActive: true,
        isPaused: false,
        total: uniqueNumbers.length,
        dailyLimit,
        alreadySentToday: alreadySent,
        sent: 0,
        failed: 0,
        pending: uniqueNumbers.length,
        numbers: uniqueNumbers.map(n => ({
            phone: n.phone,
            name: n.name || 'Customer',
            status: 'Pending ⏳',
            state: 'pending',
            session: null,
            template: null
        })),
        status: 'sending',
        restReason: '',
        resumeAt: null,
        batchSize,
        restHours: restHoursLabel,
        accountAgeDays: getAccountAgeDays(),
        sessionIds: selectedIds.slice(),
        sessions: selectedIds.map(id => { const s = getSession(id); return { id, name: s.name, resting: false }; }),
        templateNames
    };
    liveCampaigns.set(campaignId, camp);
    res.json({
        success: true,
        campaignId,
        campaignName,
        willSend: uniqueNumbers.length,
        sessions: selectedIds.length,
        batchPerSession: batchSize,
        restHours: restHoursLabel
    });

    const minD = Math.max(45, parseInt(minDelay) || 45); const maxD = Math.max(minD + 15, parseInt(maxDelay) || 90);
    const queue = uniqueNumbers.map((n, idx) => ({ ...n, idx }));

    async function sessionWorker(sessionId) {
        const s = getSession(sessionId); if (!s) return;
        while (queue.length > 0) {
            if (camp.cancelFlag || !camp.isActive) {
                queue.length = 0;
                break;
            }

            while (camp.isPaused && !camp.cancelFlag && camp.isActive) {
                camp.status = 'paused';
                camp.restReason = '🛑 Campaign Paused by User';
                await new Promise(r => setTimeout(r, 2000));
            }
            if (camp.cancelFlag || !camp.isActive) { queue.length = 0; break; }

            while (s.restUntil && Date.now() < s.restUntil) {
                if (camp.cancelFlag || !camp.isActive) break;
                const left = s.restUntil - Date.now();
                camp.status = 'resting'; camp.restReason = `${s.name}: ${restHoursLabel}hr rest after ${batchSize} msgs`; camp.resumeAt = new Date(s.restUntil).toISOString();
                await new Promise(r => setTimeout(r, Math.min(5000, left)));
            }
            if (camp.cancelFlag || !camp.isActive) { queue.length = 0; break; }
            if (!s.connected || !s.sock) {
                camp.status = 'waiting';
                camp.restReason = (s.name || sessionId) + ' reconnect ho raha hai… campaign queue safe hai';
                await new Promise(r => setTimeout(r, 8000));
                continue;
            }
            await waitForSendWindow();
            if (camp.cancelFlag || !camp.isActive) { queue.length = 0; break; }
            camp.status = 'sending'; camp.restReason = ''; camp.resumeAt = null;

            let batchCount = 0;
            while (batchCount < batchSize && queue.length > 0) {
                if (camp.cancelFlag || !camp.isActive) { queue.length = 0; break; }

                while (camp.isPaused && !camp.cancelFlag && camp.isActive) {
                    camp.status = 'paused';
                    camp.restReason = '🛑 Campaign Paused by User';
                    await new Promise(r => setTimeout(r, 2000));
                }
                if (camp.cancelFlag || !camp.isActive) { queue.length = 0; break; }

                if (!s.connected || !s.sock) break; if (s.restUntil && Date.now() < s.restUntil) break;
                const item = queue.shift(); if (!item) break;
                let num = item.phone; const customerName = item.name || 'Customer'; const idx = item.idx;
                if (isBlacklisted(num)) {
                    camp.failed++; camp.pending = Math.max(0, camp.pending - 1);
                    if (camp.numbers[idx]) {
                        camp.numbers[idx].status = 'Skipped 🚫 blacklist';
                        camp.numbers[idx].state = 'failed';
                    }
                    continue;
                }

                try {
                    if (!num.startsWith('91')) num = '91' + num; const jid = num + '@s.whatsapp.net';
                    let finalMessage = '';
                    let mediaList = [];
                    let tplName = '';
                    let buttons = [];
                    if (useRotation) {
                        let picked = null;
                        for (let attempt = 0; attempt < templates.length; attempt++) {
                            const cand = templates[tplIndex % templates.length];
                            tplIndex++;
                            const cname = cand.name || '';
                            if (!isTemplateOnCooldown(num, cname)) { picked = cand; tplName = cname; break; }
                        }
                        if (!picked) {
                            camp.failed++; camp.pending = Math.max(0, camp.pending - 1);
                            if (camp.numbers[idx]) { camp.numbers[idx].status = 'Skipped ⏳ template cooldown'; camp.numbers[idx].state = 'failed'; }
                            continue;
                        }
                        const tpl = picked;
                        finalMessage = (tpl.message || '').replace(/\[Name\]/gi, customerName);
                        if (Array.isArray(tpl.attachments) && tpl.attachments.length) {
                            mediaList = tpl.attachments.slice(0, 5);
                        } else if (tpl.fileBase64 || tpl.imageBase64) {
                            mediaList = [{
                                fileBase64: tpl.fileBase64 || tpl.imageBase64,
                                fileMime: tpl.fileMime || null,
                                fileName: tpl.fileName || null,
                                fileKind: tpl.fileKind || null
                            }];
                        }
                        buttons = Array.isArray(tpl.buttons) ? tpl.buttons : [];
                    } else {
                        finalMessage = message ? message.replace(/\[Name\]/gi, customerName) : '';
                        if (Array.isArray(reqAttachments) && reqAttachments.length) {
                            mediaList = reqAttachments.slice(0, 5);
                        } else if (imageBase64) {
                            mediaList = [{ fileBase64: imageBase64 }];
                        }
                    }

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

                    function normalizeMedia(item) {
                        let fileBase64 = item.fileBase64 || item.imageBase64 || null;
                        let fileMime = item.fileMime || null;
                        let fileName = item.fileName || null;
                        let fileKind = item.fileKind || null;
                        if (fileBase64 && !fileKind) {
                            const head = String(fileBase64).slice(0, 80).toLowerCase();
                            if (head.includes('image/')) fileKind = 'image';
                            else if (head.includes('video/')) fileKind = 'video';
                            else if (head.includes('audio/')) fileKind = 'audio';
                            else fileKind = 'document';
                            if (!fileMime && head.startsWith('data:')) {
                                const m = head.match(/^data:([^;]+)/);
                                if (m) fileMime = m[1];
                            }
                        }
                        return { fileBase64, fileMime, fileName, fileKind };
                    }

                    function buildOptions(item, caption) {
                        const { fileBase64, fileMime, fileName, fileKind } = normalizeMedia(item);
                        if (!fileBase64) return { text: caption || ' ' };
                        const base64Data = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
                        const buf = Buffer.from(base64Data, 'base64');
                        if (fileKind === 'image') return { image: buf, caption: caption || undefined };
                        if (fileKind === 'video') return { video: buf, caption: caption || undefined, mimetype: fileMime || 'video/mp4' };
                        if (fileKind === 'audio') return { audio: buf, mimetype: fileMime || 'audio/mpeg', ptt: false };
                        let mime = fileMime || 'application/octet-stream';
                        let fname = fileName || 'document';
                        if (!fileName && mime.includes('pdf')) fname = 'document.pdf';
                        if (!fileName && (mime.includes('sheet') || mime.includes('excel'))) fname = 'sheet.xlsx';
                        if (!fileName && mime.includes('html')) fname = 'file.html';
                        return { document: buf, mimetype: mime, fileName: fname, caption: caption || undefined };
                    }

                    if (!mediaList.length) {
                        await s.sock.sendMessage(jid, { text: (finalMessage || ' ') + randomSignature() });
                    } else {
                        for (let mi = 0; mi < mediaList.length; mi++) {
                            const cap = mi === 0 ? finalMessage : undefined;
                            const opts = buildOptions(mediaList[mi], cap);
                            // audio + caption: pehle text
                            if (opts.audio && cap) {
                                await s.sock.sendMessage(jid, { text: cap });
                                await s.sock.sendMessage(jid, opts);
                            } else {
                                await s.sock.sendMessage(jid, opts);
                            }
                            if (mi < mediaList.length - 1) await new Promise(r => setTimeout(r, 1200));
                        }
                    }

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
                        } catch (btnErr) { /* ignore */ }
                    }
                    camp.sent++; camp.pending = Math.max(0, camp.pending - 1);
                    if (camp.numbers[idx]) {
                        camp.numbers[idx].status = 'Sent ✅ (' + s.name + (tplName ? ' / ' + tplName : '') + ')';
                        camp.numbers[idx].state = 'sent';
                        camp.numbers[idx].session = s.name;
                        camp.numbers[idx].template = tplName || (mediaList.length ? (mediaList.length + ' files') : 'Message');
                    }
                    addHistory(num, finalMessage || 'Media Sent', s.name + (tplName ? ' | ' + tplName : ''));
                    saveStats(new Date().toLocaleDateString('en-CA'), 1, 0);
                    bumpTemplateStat(tplName || 'Message', true);
                    bumpSessionStat(s.name, true);
                    markTemplateSent(num, tplName || 'Message');
                    bumpNumberQuality(num, 'sent');
                    try {
                        const seq = getPro().sequences || {};
                        if (seq.enabled) {
                            const pro = getPro();
                            pro.followUps = pro.followUps || [];
                            const base = Date.now();
                            if (seq.day3) pro.followUps.push({ id: 'seq3_' + num + '_' + base, phone: normPhone(num), name: customerName, note: seq.day3, at: base + 3 * 86400000, atText: new Date(base + 3 * 86400000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), done: false, auto: true });
                            if (seq.day7) pro.followUps.push({ id: 'seq7_' + num + '_' + base, phone: normPhone(num), name: customerName, note: seq.day7, at: base + 7 * 86400000, atText: new Date(base + 7 * 86400000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), done: false, auto: true });
                            persist('pro', pro);
                        }
                    } catch (e) {}
                    batchCount++; s.sentInBatch = batchCount;

                    const delayMs = (Math.floor(Math.random() * (maxD - minD + 1)) + minD) * 1000;
                    await new Promise(r => setTimeout(r, delayMs));
                } catch (e) {
                    const errMsg = String(e && e.message || e || '');
                    const connFail = /connection|closed|timed out|ECONN|not connected|Connection Closed|reset/i.test(errMsg);
                    // Disconnect mid-send: number wapas queue, fail mat maaro
                    if (connFail || !s.connected) {
                        queue.unshift(item);
                        camp.status = 'waiting';
                        camp.restReason = (s.name || sessionId) + ' disconnect — reconnect ke baad continue';
                        await new Promise(r => setTimeout(r, 10000));
                        break;
                    }
                    camp.failed++; camp.pending = Math.max(0, camp.pending - 1);
                    if (camp.numbers[idx]) {
                        camp.numbers[idx].status = 'Failed ❌ (' + s.name + ')';
                        camp.numbers[idx].state = 'failed';
                        camp.numbers[idx].session = s.name;
                        camp.numbers[idx].template = null;
                    }
                    saveStats(new Date().toLocaleDateString('en-CA'), 0, 1); batchCount++; s.sentInBatch = batchCount;
                    bumpTemplateStat(camp.numbers[idx] && camp.numbers[idx].template, false);
                    bumpSessionStat(s.name, false);
                }
            }
            if (batchCount >= batchSize && queue.length > 0) {
                s.restUntil = Date.now() + restMs; s.sentInBatch = 0;
                camp.status = 'resting'; camp.restReason = `${s.name}: ${batchSize} msgs done → ${restHoursLabel}hr rest. Doosre WA se continue...`; camp.resumeAt = new Date(s.restUntil).toISOString();
            } else if (queue.length === 0) break;
        }
    }

    // Workers stagger start — saath mein blast se multi-WA drop kam
    await Promise.all(selectedIds.map((id, wi) => (async () => {
        await new Promise(r => setTimeout(r, wi * 3000));
        return sessionWorker(id);
    })()));
    // Queue bachi + cancel nahi = abhi complete mat maaro (safety)
    if (!camp.cancelFlag && queue.length > 0) {
        camp.status = 'waiting';
        camp.restReason = 'Workers paused — reconnect / rest ke baad pending queue';
        // ek recovery pass: 2 min wait then single worker drain
        await new Promise(r => setTimeout(r, 120000));
        if (!camp.cancelFlag && queue.length > 0) {
            const sid = selectedIds.find(id => {
                const s = getSession(id);
                return s && s.connected && s.sock;
            }) || selectedIds[0];
            if (sid) await sessionWorker(sid);
        }
    }
    if (!camp.cancelFlag) {
        camp.isActive = false;
        camp.status = queue.length ? 'idle' : 'idle';
        camp.restReason = queue.length ? ('Pending left ' + queue.length) : '';
        camp.resumeAt = null;
        camp.pending = queue.length;
    }
    // Complete campaigns thodi der baad list se hatao (UI ke liye)
    setTimeout(() => {
        if (liveCampaigns.has(campaignId) && !liveCampaigns.get(campaignId).isActive) {
            liveCampaigns.delete(campaignId);
        }
    }, 60000);
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
