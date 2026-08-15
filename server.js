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

// --- STATS DATABASE SYSTEM ---
const statsFile = __dirname + '/stats.json';

function getStats() {
    try {
        if (fs.existsSync(statsFile)) {
            return JSON.parse(fs.readFileSync(statsFile));
        }
    } catch (e) {
        console.error("Stats read error", e);
    }
    return {};
}

function saveStats(date, sent, failed) {
    const stats = getStats();
    if (!stats[date]) stats[date] = { sent: 0, failed: 0 };
    stats[date].sent += sent;
    stats[date].failed += failed;
    fs.writeFileSync(statsFile, JSON.stringify(stats));
}
// -----------------------------

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if(qr) {
            console.log('नया QR Code जनरेट हुआ है...');
            qrCodeData = await qrcode.toDataURL(qr);
        }

        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            isConnected = false;
            if(shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            } else {
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log('WhatsApp सफलतापूर्वक कनेक्ट हो गया है!');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        if (!isAutoReplyEnabled) return;

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (jid.includes('@g.us') || jid === 'status@broadcast') return;

        const messageType = Object.keys(msg.message)[0];
        let text = '';
        if (messageType === 'conversation') {
            text = msg.message.conversation.trim().toLowerCase();
        } else if (messageType === 'extendedTextMessage') {
            text = msg.message.extendedTextMessage.text.trim().toLowerCase();
        }

        if (text === 'hi' || text === 'hello' || text === 'menu') {
            const menuText = `🌟 Welcome to website banane wala! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n\n*1️⃣* - हमारी सर्विस और प्रोडक्ट देखने के लिए\n*2️⃣* - प्राइस लिस्ट (Rate List) के लिए\n*3️⃣* - हमसे बात करने के लिए`;
            await sock.sendMessage(jid, { text: menuText });
        } 
        else if (text === '1') {
            const reply1 = `यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है...\n\n(आप इस जगह अपनी सर्विस के बारे में लिख सकते हैं)`;
            await sock.sendMessage(jid, { text: reply1 });
        } 
        else if (text === '2') {
            const reply2 = `यहाँ हमारी प्राइस लिस्ट है...\n\n(आप यहाँ अपनी रेट लिस्ट डाल सकते हैं)`;
            await sock.sendMessage(jid, { text: reply2 });
        } 
        else if (text === '3') {
            const reply3 = `कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!`;
            await sock.sendMessage(jid, { text: reply3 });
        }
    });
}

connectToWhatsApp();

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qrCode: qrCodeData,
        autoReply: isAutoReplyEnabled
    });
});

app.post('/toggle-autoreply', (req, res) => {
    isAutoReplyEnabled = req.body.enabled;
    res.json({ success: true, autoReply: isAutoReplyEnabled });
});

// नया API: Dashboard के लिए डेटा भेजना
app.get('/api/stats', (req, res) => {
    const date = req.query.date; // Format: YYYY-MM-DD
    const stats = getStats();
    
    if (date) {
        res.json(stats[date] || { sent: 0, failed: 0 });
    } else {
        // अगर कोई तारीख नहीं चुनी गई है, तो 'All Time' डेटा दिखाएँ
        let totalSent = 0;
        let totalFailed = 0;
        for (let d in stats) {
            totalSent += stats[d].sent;
            totalFailed += stats[d].failed;
        }
        res.json({ sent: totalSent, failed: totalFailed });
    }
});

app.post('/pair-code', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!sock) return res.status(400).json({ error: 'सिस्टम तैयार नहीं है, थोड़ा इंतज़ार करें।' });
        if (isConnected) return res.status(400).json({ error: 'WhatsApp पहले से ही कनेक्ट है!' });

        phone = phone.replace(/[^0-9]/g, '');
        if (!phone.startsWith('91')) phone = '91' + phone;

        const code = await sock.requestPairingCode(phone);
        res.json({ success: true, code: code });
    } catch (error) {
        res.status(500).json({ success: false, error: 'कोड नहीं बन पाया। कृपया अपना नंबर सही से चेक करें।' });
    }
});

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    }

    const { numbers, message, delay, imageBase64 } = req.body;
    let sentCount = 0;
    let failedCount = 0;

    for (let num of numbers) {
        try {
            if (!num.startsWith('91')) num = '91' + num;
            const jid = num + '@s.whatsapp.net';
            
            let messageOptions = {};
            
            if (imageBase64) {
                const base64Data = imageBase64.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                messageOptions = { image: buffer, caption: message || '' };
            } else {
                messageOptions = { text: message };
            }
            
            await sock.sendMessage(jid, messageOptions);
            sentCount++;
            console.log(`${num} पर मैसेज भेजा गया।`);
            
            const delayMs = (delay && delay > 0 ? delay : 3) * 1000;
            await new Promise(resolve => setTimeout(resolve, delayMs));
        } catch (error) {
            console.error(`${num} पर मैसेज फेल हुआ:`, error);
            failedCount++;
        }
    }

    // नया फ़ीचर: आज की तारीख में रिकॉर्ड सेव करना
    const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format
    saveStats(todayDate, sentCount, failedCount);

    res.json({ success: true, sent: sentCount, failed: failedCount });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

