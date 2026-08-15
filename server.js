const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let qrCodeData = null;
let isConnected = false;
let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["My WhatsApp Bot", "Chrome", "1.0.0"]
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

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    }

    const { numbers, message } = req.body;
    let sentCount = 0;
    let failedCount = 0;

    for (let num of numbers) {
        try {
            if (!num.startsWith('91')) num = '91' + num;
            const jid = num + '@s.whatsapp.net';
            
            await sock.sendMessage(jid, { text: message });
            sentCount++;
            console.log(`${num} पर मैसेज भेजा गया।`);
            
            await new Promise(resolve => setTimeout(resolve, 3000));
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
