const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.use(session({
    secret: 'my-super-secret-key-12345',
    resave: false,
    saveUninitialized: false
}));

// यहाँ यूजर आईडी और पासवर्ड डालें
const USERS = { "admin": "admin123", "mayur": "mayur123" };

const isAuthenticated = (req, res, next) => {
    if (req.session.user) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] && USERS[username] === password) {
        req.session.user = username;
        if (!fs.existsSync(`./data/${username}`)) fs.mkdirSync(`./data/${username}`, { recursive: true });
        res.json({ success: true });
    } else res.status(401).json({ success: false });
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// बाईलिस और लाइव ट्रैकिंग का डेटा यूजर-वाइज़ हैंडलिंग
let userSockets = {}; // { username: sock }
let liveCampaigns = {}; // { username: liveCampaignData }

app.get('/status', isAuthenticated, (req, res) => {
    const user = req.session.user;
    res.json({ connected: !!userSockets[user], autoReply: true });
});

app.post('/send', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const { numbers, message, minDelay, maxDelay, imageBase64 } = req.body;
    const sock = userSockets[user];
    if (!sock) return res.status(400).json({ error: 'WhatsApp कनेक्ट नहीं है!' });

    liveCampaigns[user] = { isActive: true, total: numbers.length, sent: 0, failed: 0, pending: numbers.length, numbers: numbers.map(n => ({ phone: n, status: 'Pending ⏳' })) };
    res.json({ success: true });

    for (let i = 0; i < numbers.length; i++) {
        try {
            let num = numbers[i].replace(/[^0-9]/g, '');
            if (!num.startsWith('91')) num = '91' + num;
            await sock.sendMessage(num + '@s.whatsapp.net', imageBase64 ? { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: message } : { text: message });
            liveCampaigns[user].sent++;
            liveCampaigns[user].pending--;
            liveCampaigns[user].numbers[i].status = 'Sent ✅';
            fs.appendFileSync(`./data/${user}/history.json`, JSON.stringify({ number: num, date: new Date().toLocaleString() }) + '\n');
        } catch (e) {
            liveCampaigns[user].failed++;
            liveCampaigns[user].pending--;
            liveCampaigns[user].numbers[i].status = 'Invalid ❌';
        }
        await new Promise(r => setTimeout(r, (Math.floor(Math.random() * (parseInt(maxDelay) - parseInt(minDelay) + 1)) + parseInt(minDelay)) * 1000));
    }
    liveCampaigns[user].isActive = false;
});

app.get('/api/live-status', isAuthenticated, (req, res) => res.json(liveCampaigns[req.session.user] || { total: 0 }));

app.post('/pair-code', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const { state, saveCreds } = await useMultiFileAuthState(`./data/${user}/auth`);
    const sock = makeWASocket({ auth: state });
    userSockets[user] = sock;
    sock.ev.on('creds.update', saveCreds);
    const code = await sock.requestPairingCode(req.body.phone.replace(/[^0-9]/g, ''));
    res.json({ code });
});

app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log('Server Running'));
