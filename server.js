// ... पुराने कोड के साथ ऊपर ये लाइन जोड़ें:
let autoReplyMessage = `🌟 Welcome to website banane wala! 🌟\n\nकृपया अपनी ज़रूरत के हिसाब से नीचे दिए गए नंबर का रिप्लाई करें:\n\n*1️⃣* - सर्विस और प्रोडक्ट\n*2️⃣* - प्राइस लिस्ट\n*3️⃣* - हमसे बात करें`;

// ... /toggle-autoreply के नीचे ये नया API जोड़ें:
app.post('/update-autoreply', (req, res) => {
    autoReplyMessage = req.body.message;
    res.json({ success: true });
});

// ... और ऑटो-रिप्लाई वाले सेक्शन (messages.upsert) में 'menuText' की जगह 'autoReplyMessage' का इस्तेमाल करें:
if (text === 'hi' || text === 'hello' || text === 'menu') {
    await sock.sendMessage(jid, { text: autoReplyMessage });
}
