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

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        // Pairing Code फीचर के लिए ब्राउज़र का नाम इस तरह होना ज़रूरी है
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
}

connectToWhatsApp();

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qrCode: qrCodeData
    });
});

// नया फीचर: Phone Number से Pairing Code मंगाना
app.post('/pair-code', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!sock) return res.status(400).json({ error: 'सिस्टम तैयार नहीं है, थोड़ा इंतज़ार करें।' });
        if (isConnected) return res.status(400).json({ error: 'WhatsApp पहले से ही कनेक्ट है!' });

        // नंबर में से स्पेस और + हटाकर सिर्फ अंक रखें
        phone = phone.replace(/[^0-9]/g, '');
        if (!phone.startsWith('91')) phone = '91' + phone;

        // Baileys से 8 अक्षरों का कोड रिक्वेस्ट करें
        const code = await sock.requestPairingCode(phone);
        res.json({ success: true, code: code });
    } catch (error) {
        console.error('Pairing Code Error:', error);
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
    res.json({ success: true, sent: sentCount, failed: failedCount });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
