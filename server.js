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
let autoReplyMessage = `🌟 Welcome! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करने के लिए`;

const statsFile = __dirname + '/stats.json';
const historyFile = __dirname + '/history.json';
const templatesFile = __dirname + '/templates.json';
const contactsFile = __dirname + '/contacts.json'; // नया: Contacts/Groups सेव करने के लिए

let liveCampaign = { isActive: false, total: 0, sent: 0, failed: 0, pending: 0, numbers: [] };

// Data Management Functions
function getJson(file) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch(e) { return null; } }
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function getStats() { return getJson(statsFile) || {}; }
function saveStats(date, sent, failed) {
    const stats = getStats();
    if (!stats[date]) stats[date] = { sent: 0, failed: 0 };
    stats[date].sent += sent; stats[date].failed += failed;
    saveJson(statsFile, stats);
}

function getHistory() { return getJson(historyFile) || []; }
function addHistory(number, messageSent) {
    let list = getHistory();
    list.push({ number: number, message: messageSent, date: new Date().toLocaleString('en-IN') });
    saveJson(historyFile, list);
}

function getTemplates() { return getJson(templatesFile) || []; }
function getContacts() { return getJson(contactsFile) || {}; } // Format: { "VIP": [{name: "Rahul", phone: "9198..."}] }

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
        if (!histList.find(c => c.number === phone)) return; 

        const messageType = Object.keys(msg.message)[0];
        let text = messageType === 'conversation' ? msg.message.conversation.trim().toLowerCase() : (messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text.trim().toLowerCase() : '');

        if (text === 'hi' || text === 'hello' || text === 'menu') await sock.sendMessage(jid, { text: autoReplyMessage });
        else if (text === '1') await sock.sendMessage(jid, { text: "यहाँ हमारी सर्विस और प्रोडक्ट की जानकारी है..." });
        else if (text === '2') await sock.sendMessage(jid, { text: "यहाँ हमारी प्राइस लिस्ट है..." });
        else if (text === '3') await sock.sendMessage(jid, { text: "कृपया अपना सवाल यहाँ लिख दें, हमारी टीम जल्द ही आपसे संपर्क करेगी। धन्यवाद!" });
    });
}
connectToWhatsApp();

// Standard API Routes
app.get('/status', (req, res) => res.json({ connected: isConnected, qrCode: qrCodeData, autoReply: isAutoReplyEnabled, currentMsg: autoReplyMessage }));
app.post('/toggle-autoreply', (req, res) => { isAutoReplyEnabled = req.body.enabled; res.json({ success: true }); });
app.post('/update-autoreply', (req, res) => { autoReplyMessage = req.body.message; res.json({ success: true }); });
app.get('/api/stats', (req, res) => { const stats = getStats(); const date = req.query.date; res.json(date ? (stats[date] || { sent: 0, failed: 0 }) : { sent: Object.values(stats).reduce((a,b) => a + b.sent, 0), failed: Object.values(stats).reduce((a,b) => a + b.failed, 0) }); });
app.get('/api/history', (req, res) => res.json(getHistory()));
app.get('/api/live-status', (req, res) => res.json(liveCampaign));

// Template Routes
app.get('/api/templates', (req, res) => res.json(getTemplates()));
app.post('/api/templates', (req, res) => { const t = getTemplates(); t.push(req.body); saveJson(templatesFile, t); res.json({ success: true }); });
app.post('/api/templates/delete', (req, res) => { let t = getTemplates(); t = t.filter(x => x.id !== req.body.id); saveJson(templatesFile, t); res.json({ success: true }); });

// Contacts & Groups Routes
app.get('/api/contacts', (req, res) => res.json(getContacts()));
app.post('/api/contacts', (req, res) => { saveJson(contactsFile, req.body); res.json({ success: true }); });

app.post('/pair-code', async (req, res) => {
    let { phone } = req.body; phone = phone.replace(/[^0-9]/g, ''); if (!phone.startsWith('91')) phone = '91' + phone;
    res.json({ success: true, code: await sock.requestPairingCode(phone) });
});

// 🚀 UPDATED SEND ROUTE (Personalized Message Support)
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(400).json({ success: false, error: 'WhatsApp कनेक्ट नहीं है!' });
    
    // numbers array will now contain objects: [{phone: "91...", name: "Rahul"}, ...]
    const { numbers, message, minDelay, maxDelay, imageBase64 } = req.body;
    
    liveCampaign = { isActive: true, total: numbers.length, sent: 0, failed: 0, pending: numbers.length, numbers: numbers.map(n => ({ phone: n.phone, status: 'Pending ⏳' })) };
    res.json({ success: true }); 
    
    let minD = parseInt(minDelay) || 10; let maxD = parseInt(maxDelay) || 20;
    let sentCount = 0; let failedCount = 0;

    for (let i = 0; i < numbers.length; i++) {
        let contact = numbers[i];
        let num = contact.phone.replace(/[^0-9]/g, '');
        let customerName = contact.name || 'Customer'; // अगर नाम नहीं है तो 'Customer' लिखेगा

        try {
            if (!num.startsWith('91')) num = '91' + num;
            const jid = num + '@s.whatsapp.net';
            
            // 🏷️ PERSONALIZED MESSAGE LOGIC
            let finalMessage = message ? message.replace(/\[Name\]/gi, customerName) : '';

            let messageOptions = imageBase64 ? { image: Buffer.from(imageBase64.split(',')[1], 'base64'), caption: finalMessage } : { text: finalMessage };
            
            await sock.sendMessage(jid, messageOptions);
            sentCount++; liveCampaign.sent++; liveCampaign.pending--; liveCampaign.numbers[i].status = 'Sent ✅';
            addHistory(num, finalMessage || "Media Sent"); 
            
            if (i < numbers.length - 1) await new Promise(resolve => setTimeout(resolve, (Math.floor(Math.random() * (maxD - minD + 1)) + minD) * 1000));
        } catch (e) { 
            failedCount++; liveCampaign.failed++; liveCampaign.pending--; liveCampaign.numbers[i].status = 'Invalid ❌';
        }
    }
    liveCampaign.isActive = false;
    saveStats(new Date().toLocaleDateString('en-CA'), sentCount, failedCount);
});

app.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log(`Server started`));
