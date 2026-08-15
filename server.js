const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // UI दिखाने के लिए

let qrCodeData = null;
let isConnected = false;

// Render के 512MB RAM लिमिट के लिए सबसे तगड़ी 'Single Process' सेटिंग
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <-- यह सबसे ज़्यादा RAM बचाएगा
            '--disable-gpu'
        ]
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

// '0.0.0.0' जोड़ने से क्लाउड सर्वर का कनेक्शन मजबूत रहता है
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
