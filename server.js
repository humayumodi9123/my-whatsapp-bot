const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// --- 🔐 Session (Login) System ---
app.use(session({
    secret: 'website-banane-wala-secret-key',
    resave: false,
    saveUninitialized: false
}));

// --- 👤 Credentials Management ---
const credsFile = './credentials.json';
// अगर फ़ाइल नहीं है तो डिफ़ॉल्ट (admin / admin123) बना देगा
if (!fs.existsSync(credsFile)) {
    fs.writeFileSync(credsFile, JSON.stringify({ admin: "admin123" }));
}
const getCreds = () => JSON.parse(fs.readFileSync(credsFile));
const saveCredsDB = (data) => fs.writeFileSync(credsFile, JSON.stringify(data));

// --- 📊 Data Tracking Variables ---
let userSockets = {};
let isConnected = {};
let qrCodes = {};
let liveCampaigns = {};
let autoReplySettings = {}; 

const defaultAutoReply = `🌟 Welcome to website banane wala! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n\n*1️⃣* - हमारी सर्विस और प्रोडक्ट देखने के लिए\n*2️⃣* - प्राइस लिस्ट (Rate List) के लिए\n*3️⃣* - हमसे बात करने के लिए`;

// --- 🚀 WhatsApp Connection Manager ---
async function startWhatsApp(user) {
    const userDir = `./data/${user}`;
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(`${userDir}/auth`);
    
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    userSockets[user] = sock;
    if(!autoReplySettings[user]) autoReplySettings[user] = { enabled: true, msg: defaultAutoReply };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCodes[user] = await qrcode.toDataURL(qr);
        
        if (connection === 'close') {
            isConnected[user] = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(user), 3000);
            } else { 
                fs.rmSync(`${userDir}/auth`, { recursive: true, force: true }); 
                userSockets[user] = null;
                qrCodes[user] = null;
            }
        } else if (connection === 'open') { 
            isConnected[user] = true; 
            qrCodes[user] = null; 
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 🤖 Auto-Reply Logic ---
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' || !autoReplySettings[user].enabled) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const phone = jid.split('@')[0]; 

        const histFile = `./data/${user}/history.json`;
        if (!fs.existsSync(histFile)) return;
        const historyData = fs.readFileSync(histFile, 'utf-8');
        if (!historyData.includes(phone)) return; 

        const msgType = Object.keys(msg.message)[0];
        let text = msgType === 'conversation' ? msg.message.conversation.trim().toLowerCase() : (msgType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text.trim().toLowerCase() : '');

        if (text === 'hi' || text === 'hello' || text === 'menu') await sock.sendMessage(jid, { text: autoReplySettings[user].msg });
        else if (text === '1') await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
        else if (text === '2') await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
        else if (text === '3') await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
    });
}

// सर्वर स्टार्ट होते ही पुराने यूज़र्स का डेटा लोड करें
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
fs.readdirSync('./data').forEach(user => {
    const creds = getCreds();
    if (creds[user]) startWhatsApp(user);
});

// --- 🛡️ Security Check ---
const isAuthenticated = (req, res, next) => {
    if (req.session.user) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

// --- 🌐 API Routes ---
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const creds = getCreds();
    if (creds[username] && creds[username] === password) {
        req.session.user = username;
        if (!userSockets[username]) startWhatsApp(username); 
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

// नया: पासवर्ड अपडेट करने का रूट
app.post('/update-credentials', isAuthenticated, (req, res) => {
    const { newPassword } = req.body;
    const user = req.session.user;
    const creds = getCreds();
    creds[user] = newPassword;
    saveCredsDB(creds);
    res.json({ success: true });
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/status', isAuthenticated, (req, res) => {
    const user = req.session.user;
    res.json({ 
        connected: isConnected[user] || false, 
        qrCode: qrCodes[user] || null,
        autoReply: autoReplySettings[user]?.enabled || false,
        currentMsg: autoReplySettings[user]?.msg || defaultAutoReply
    });
});

app.post('/toggle-autoreply', isAuthenticated, (req, res) => { 
    autoReplySettings[req.session.user].enabled = req.body.enabled; 
    res.json({ success: true }); 
});

app.post('/update-autoreply', isAuthenticated, (req, res) => { 
    autoReplySettings[req.session.user].msg = req.body.message; 
    res.json({ success: true }); 
});

app.get('/api/stats', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const statsFile = `./data/${user}/stats.json`;
    let stats = {};
    try { if(fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile)); } catch(e){}
    
    const date = req.query.date;
    if(date) res.json(stats[date] || { sent: 0, failed: 0 });
    else res.json({ 
        sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), 
        failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) 
    });
});

app.get('/api/history', isAuthenticated, (req, res) => {
    const histFile = `./data/${req.session.user}/history.json`;
    try {
        if(fs.existsSync(histFile)) res.json(JSON.parse(fs.readFileSync(histFile)));
        else res.json([]);
    } catch(e) { res.json([]); }
});

app.get('/api/live-status', isAuthenticated, (req, res) => {
    res.json(liveCampaigns[req.session.user] || { isActive: false, total: 0 });
});

app.post('/pair-code', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    if (!userSockets[user]) await startWhatsApp(user);
    
    let phone = req.body.phone.replace(/[^0-9]/g, '');
    if (!phone.startsWith('91')) phone = '91' + phone;
    
    setTimeout(async () => {
        try {
            const code = await userSockets[user].requestPairingCode(phone);
            res.json({ success: true, code: code });
        } catch(e) { res.status(500).json({ success: false, error: 'Pairing failed' }); }
    }, 1500);
});

app.post('/send', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    if (!isConnected[user] || !userSockets[user]) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    
    const { numbers, message, minDelay, maxDelay, imageBase64 } = req.body;
    res.json({ success: true }); 
    
    liveCampaigns[user] = { isActive: true, total: numbers.length, sent: 0, failed: 0, pending: numbers.length, numbers: numbers.map(n => ({ phone: n, status: 'Pending ⏳' })) };
    
    let sentCount = 0, failedCount = 0;
    let minD = parseInt(minDelay) || 10, maxD = parseInt(maxDelay) || 20;

    for (let i = 0; i < numbers.length; i++) {
        let num = numbers[i].replace(/[^0-9]/g, '');
        if (!num.startsWith('91')) num = '91' + num;
        
        try {
            const jid = num + '@s.whatsapp.net';
            let msgOptions = imageBase64 ? { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: message || '' } : { text: message };
            await userSockets[user].sendMessage(jid, msgOptions);
            
            sentCount++;
            liveCampaigns[user].sent++;
            liveCampaigns[user].pending--;
            liveCampaigns[user].numbers[i].status = 'Sent ✅';
            
            const histFile = `./data/${user}/history.json`;
            let history = [];
            if(fs.existsSync(histFile)) history = JSON.parse(fs.readFileSync(histFile));
            history.push({ number: num, message: message || "Media Sent", date: new Date().toLocaleString('en-IN') });
            fs.writeFileSync(histFile, JSON.stringify(history, null, 2));
            
        } catch (e) {
            failedCount++;
            liveCampaigns[user].failed++;
            liveCampaigns[user].pending--;
            liveCampaigns[user].numbers[i].status = 'Invalid ❌';
        }
        
        if (i < numbers.length - 1) {
            const rDelay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
            await new Promise(r => setTimeout(r, rDelay * 1000));
        }
    }
    
    liveCampaigns[user].isActive = false;
    
    const today = new Date().toLocaleDateString('en-CA');
    const statsFile = `./data/${user}/stats.json`;
    let stats = {};
    if(fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile));
    if(!stats[today]) stats[today] = { sent: 0, failed: 0 };
    stats[today].sent += sentCount;
    stats[today].failed += failedCount;
    fs.writeFileSync(statsFile, JSON.stringify(stats));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
