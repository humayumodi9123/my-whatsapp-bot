const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

let qrCodeData = null;
let isConnected = false;

// Termux (Android) के लिए खास सेटिंग
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    console.log('नया QR Code जनरेट हुआ है...');
    qrCodeData = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
    console.log('WhatsApp सफलतापूर्वक कनेक्ट हो गया है!');
    isConnected = true;
    qrCodeData = null; 
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp डिस्कनेक्ट हो गया:', reason);
    isConnected = false;
});

client.initialize();

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qrCode: qrCodeData
    });
});

app.post('/send', async (req, res) => {
    if (!isConnected) {
        return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    }

    const { numbers, message } = req.body;
    let sentCount = 0;
    let failedCount = 0;

    for (let num of numbers) {
        try {
            if (!num.startsWith('91')) num = '91' + num;
            const chatId = num + '@c.us';
            
            await client.sendMessage(chatId, message);
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
