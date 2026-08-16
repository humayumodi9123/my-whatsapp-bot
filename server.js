const express = require('express');
const session = require('express-session');
const cors = require('cors');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use(session({ secret: 'secret-key', resave: false, saveUninitialized: false }));

// यूजर डेटा लोड करना
const getUserData = (user) => {
    if (!fs.existsSync(`./data/${user}/config.json`)) return { pass: "12345" }; // Default password
    return JSON.parse(fs.readFileSync(`./data/${user}/config.json`));
};

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    // यहाँ आप अपना एडमिन डेटाबेस चेक करेंगे
    req.session.user = username;
    res.json({ success: true });
});

app.post('/update-credentials', (req, res) => {
    const { newPass } = req.body;
    const user = req.session.user;
    fs.writeFileSync(`./data/${user}/config.json`, JSON.stringify({ pass: newPass }));
    res.json({ success: true });
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// (बाकी के WhatsApp, Send, और Live Tracking रूट्स यहाँ जोड़ें जैसा पहले था)
app.listen(10000);
