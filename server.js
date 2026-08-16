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

const statsFile = __dirname + '/stats.json';
const historyFile = __dirname + '/history.json';

// --- Live Campaign Tracking Variable ---
let liveCampaign = {
    isActive: false, total: 0, sent: 0, failed: 0, pending: 0, numbers: []
};

// Data Management
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

function getHistory() {
    try { return fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : []; }
    catch(e) { return []; }
}

function addHistory(number, messageSent) {
    let list = getHistory();
    list.push({ number: number, message: messageSent, date: new Date().toLocaleString('en-IN') });
    fs.writeFileSync(historyFile, JSON.stringify(list, null, 2));
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
        } else if(connection === 'open') { isConnected = true; qrCodeData = null; }
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
        if (!histList.find(c => c.number === phone)) return; // Only reply to those we sent a message

        const messageType = Object.keys(msg.message)[0];
        let text = messageType === 'conversation' ? msg.message.conversation.trim().toLowerCase() : (messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text.trim().toLowerCase() : '');

        if (text === 'hi' || text === 'hello' || text === 'menu') await sock.sendMessage(jid, { text: autoReplyMessage });
        else if (text === '1') await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
        else if (text === '2') await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
        else if (text === '3') await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
    });
}

connectToWhatsApp();

// API Routes
app.get('/status', (req, res) => res.json({ connected: isConnected, qrCode: qrCodeData, autoReply: isAutoReplyEnabled, currentMsg: autoReplyMessage }));
app.post('/toggle-autoreply', (req, res) => { isAutoReplyEnabled = req.body.enabled; res.json({ success: true }); });
app.post('/update-autoreply', (req, res) => { autoReplyMessage = req.body.message; res.json({ success: true }); });

app.get('/api/stats', (req, res) => {
    const stats = getStats();
    const date = req.query.date;
    res.json(date ? (stats[date] || { sent: 0, failed: 0 }) : { sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) });
});

app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/live-status', (req, res) => res.json(liveCampaign));

app.post('/pair-code', async (req, res) => {
    let { phone } = req.body;
    phone = phone.replace(/[^0-9]/g, '');
    if (!phone.startsWith('91')) phone = '91' + phone;
    const code = await sock.requestPairingCode(phone);
    res.json({ success: true, code: code });
});

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    
    const { numbers, message, minDelay, maxDelay, imageBase64 } = req.body;
    
    // Live Campaign Reset
    liveCampaign = {
        isActive: true, total: numbers.length, sent: 0, failed: 0, pending: numbers.length,
        numbers: numbers.map(n => ({ phone: n, status: 'Pending ⏳' }))
    };
    
    res.json({ success: true }); // Response before loop
    
    let minD = parseInt(minDelay) || 10;
    let maxD = parseInt(maxDelay) || 20;
    let sentCount = 0; let failedCount = 0;

    for (let i = 0; i < numbers.length; i++) {
        let num = numbers[i].replace(/[^0-9]/g, '');
        try {
            if (!num.startsWith('91')) num = '91' + num;
            const jid = num + '@s.whatsapp.net';
            let messageOptions = imageBase64 ? { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: message || '' } : { text: message };
            
            await sock.sendMessage(jid, messageOptions);
            
            sentCount++;
            liveCampaign.sent++;
            liveCampaign.pending--;
            liveCampaign.numbers[i].status = 'Sent ✅';
            addHistory(num, message || "Media Sent"); 
            
            if (i < numbers.length - 1) {
                const randomDelay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
                await new Promise(resolve => setTimeout(resolve, randomDelay * 1000));
            }
        } catch (e) { 
            failedCount++;
            liveCampaign.failed++;
            liveCampaign.pending--;
            liveCampaign.numbers[i].status = 'Invalid ❌';
        }
    }
    liveCampaign.isActive = false;
    saveStats(new Date().toLocaleDateString('en-CA'), sentCount, failedCount);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server started`));

