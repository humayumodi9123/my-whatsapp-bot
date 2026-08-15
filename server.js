const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

let qrCodeData = null;
let isConnected = false;
let sock;
let isAutoReplyEnabled = true;
let autoReplyMessage = `🌟 Welcome to website banane wala! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n\n*1️⃣* - हमारी सर्विस और प्रोडक्ट देखने के लिए\n*2️⃣* - प्राइस लिस्ट (Rate List) के लिए\n*3️⃣* - हमसे बात करने के लिए`;

// --- DATABASE SYSTEMS ---
const statsFile = __dirname + '/stats.json';
const sentContactsFile = __dirname + '/sent_contacts.json';

function getStats() {
    try { return fs.existsSync(statsFile) ? JSON.parse(fs.readFileSync(statsFile)) : {}; } 
    catch (e) { return {}; }
}

function saveStats(date, sent, failed) {
    const stats = getStats();
    if (!stats[date]) stats[date] = { sent: 0, failed: 0 };
    stats[date].sent += sent;
    stats[date].failed += failed;
    fs.writeFileSync(statsFile, JSON.stringify(stats));
}

function getSentContacts() {
    try { return fs.existsSync(sentContactsFile) ? JSON.parse(fs.readFileSync(sentContactsFile)) : []; }
    catch(e) { return []; }
}

function addSentContact(number) {
    let list = getSentContacts();
    if (!list.includes(number)) {
        list.push(number);
        fs.writeFileSync(sentContactsFile, JSON.stringify(list));
    }
}
// ------------------------

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
        } else if(connection === 'open') { isConnected = true; qrCodeData = null; }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- AUTO-REPLY LOGIC (Whitelist Filter) ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' || !isAutoReplyEnabled) return;

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const phone = jid.split('@')[0]; 
        
        const sentList = getSentContacts();
        if (!sentList.includes(phone)) return; 

        if (jid.includes('@g.us') || jid === 'status@broadcast') return;

        const messageType = Object.keys(msg.message)[0];
        let text = '';
        if (messageType === 'conversation') text = msg.message.conversation.trim().toLowerCase();
        else if (messageType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text.trim().toLowerCase();

        if (text === 'hi' || text === 'hello' || text === 'menu') {
            await sock.sendMessage(jid, { text: autoReplyMessage });
        } else if (text === '1') {
            await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
        } else if (text === '2') {
            await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
        } else if (text === '3') {
            await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
        }
    });
}

connectToWhatsApp();

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, qrCode: qrCodeData, autoReply: isAutoReplyEnabled, currentMsg: autoReplyMessage });
});

app.post('/toggle-autoreply', (req, res) => { 
    isAutoReplyEnabled = req.body.enabled; 
    res.json({ success: true, autoReply: isAutoReplyEnabled }); 
});

app.post('/update-autoreply', (req, res) => {
    autoReplyMessage = req.body.message;
    res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
    const stats = getStats();
    const date = req.query.date;
    res.json(date ? (stats[date] || { sent: 0, failed: 0 }) : { sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) });
});

app.post('/pair-code', async (req, res) => {
    let { phone } = req.body;
    phone = phone.replace(/[^0-9]/g, '');
    if (!phone.startsWith('91')) phone = '91' + phone;
    const code = await sock.requestPairingCode(phone);
    res.json({ success: true, code: code });
});

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    const { numbers, message, delay, imageBase64 } = req.body;
    let sentCount = 0; let failedCount = 0;

    for (let num of numbers) {
        try {
            if (!num.startsWith('91')) num = '91' + num;
            addSentContact(num); 
            
            const jid = num + '@s.whatsapp.net';
            let messageOptions = imageBase64 ? { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: message || '' } : { text: message };
            await sock.sendMessage(jid, messageOptions);
            sentCount++;
            await new Promise(resolve => setTimeout(resolve, (delay || 3) * 1000));
        } catch (error) { failedCount++; }
    }
    saveStats(new Date().toLocaleDateString('en-CA'), sentCount, failedCount);
    res.json({ success: true, sent: sentCount, failed: failedCount });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port ${PORT}`));
