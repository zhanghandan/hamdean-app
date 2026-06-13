// Hamdean v4 — fast fs search, no shell commands
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const server = express();
const HOME = process.env.HOME || process.env.USERPROFILE || 'C:/Users/Administrator';
const DESKTOP = path.join(HOME, 'Desktop');
const PORT = 4199;

server.use(cors());
server.use(express.json({ limit: '50mb' }));
server.get('/', (req, res) => { res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(fs.readFileSync(path.join(__dirname,'public','index.html'),'utf-8')); });
process.on('uncaughtException',(err)=>{console.error('[CRASH]',err.message);});

const SYS = `你是 Hamdean，用户的 AI 助手。系统自动执行文件操作并把结果给你。直接用结果回答，用中文。主目录: ${HOME}  桌面: ${DESKTOP}`;

// ===== Auth: user storage =====
const DATA_DIR = path.join(__dirname, '.hamdean');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
function loadJSON(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return {}; } }
function saveJSON(fp, data) { try { fs.writeFileSync(fp, JSON.stringify(data, null, 2)); } catch {} }

let userStore = loadJSON(USERS_FILE);
let sessionStore = loadJSON(SESSIONS_FILE);
if (!userStore.users) userStore.users = [];
if (!sessionStore.sessions) sessionStore.sessions = [];

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex') === hash;
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function findSession(token) {
  const s = sessionStore.sessions.find(s => s.token === token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessionStore.sessions = sessionStore.sessions.filter(x => x.token !== token); saveJSON(SESSIONS_FILE, sessionStore); return null; }
  return s;
}
function findUser(id) { return userStore.users.find(u => u.id === id); }

// OAuth pending states
const oauthStates = new Map();

// SMTP config for email verification
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let appConfig = loadJSON(CONFIG_FILE);
if (!appConfig.smtp) appConfig.smtp = { host: '', port: 587, user: '', pass: '', from: '' };

function getMailer() {
  if (!appConfig.smtp.host || !appConfig.smtp.user) return null;
  return nodemailer.createTransport({
    host: appConfig.smtp.host,
    port: appConfig.smtp.port,
    secure: appConfig.smtp.port === 465,
    auth: { user: appConfig.smtp.user, pass: appConfig.smtp.pass }
  });
}

// Verification codes (in-memory, 5min expiry)
const verifyCodes = new Map(); // email -> { code, expires, attempts }
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function cleanCodes() {
  for (const [k, v] of verifyCodes) { if (Date.now() > v.expires) verifyCodes.delete(k); }
}

// ===== Security: rate limiting & brute force protection =====
const rateLimit = new Map(); // key -> { count, resetAt }
const lockouts = new Map();  // email -> { failures, lockUntil }

function getIP(req) { return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'; }

function checkRate(key, maxAttempts = 10, windowMs = 60000) {
  const now = Date.now();
  let entry = rateLimit.get(key);
  if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; rateLimit.set(key, entry); }
  entry.count++;
  if (entry.count > maxAttempts) return false; // rate limited
  return true;
}

function checkLockout(email) {
  const entry = lockouts.get(email);
  if (!entry) return null;
  if (Date.now() > entry.lockUntil) { lockouts.delete(email); return null; }
  const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
  return `Account locked. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`;
}

function recordFailure(email) {
  let entry = lockouts.get(email);
  if (!entry || Date.now() > entry.lockUntil) { entry = { failures: 0, lockUntil: 0 }; }
  entry.failures++;
  if (entry.failures >= 5) { entry.lockUntil = Date.now() + 15 * 60000; } // 15 min lock
  else if (entry.failures >= 3) { entry.lockUntil = Date.now() + 60000; } // 1 min cooldown
  lockouts.set(email, entry);
}

function clearLockout(email) { lockouts.delete(email); }

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimit) { if (now > v.resetAt) rateLimit.delete(k); }
  for (const [k, v] of lockouts) { if (now > v.lockUntil + 3600000) lockouts.delete(k); }
  cleanCodes();
}, 600000);

// ===== Auth routes =====
server.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    const ip = getIP(req);
    if (!checkRate('reg_ip_' + ip, 5, 300000)) return res.status(429).json({ error: 'Too many registrations. Please wait.' });
    const existing = userStore.users.find(u => u.email === email);
    if (existing) {
      if (existing.verified) return res.status(409).json({ error: 'Email already registered' });
      // Re-send code for unverified user
      userStore.users = userStore.users.filter(u => u.id !== existing.id);
      saveJSON(USERS_FILE, userStore);
    }
    const { salt, hash } = hashPassword(password);
    const user = { id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), email, passwordHash: hash, salt, createdAt: Date.now(), verified: false, membership: 'trial', trialUntil: Date.now() + 3 * 24 * 3600 * 1000, memberUntil: 0 };
    userStore.users.push(user);
    saveJSON(USERS_FILE, userStore);
    const code = genCode();
    cleanCodes();
    verifyCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    let sent = false; let sendErr = null;
    const mailer = getMailer();
    if (mailer) {
      try {
        await mailer.sendMail({
          from: appConfig.smtp.from || appConfig.smtp.user,
          to: email,
          subject: 'Hamdean — Verification Code',
          text: 'Your code: ' + code + ' (expires in 5 min)',
          html: '<h2>Hamdean</h2><h1>' + code + '</h1><p>Expires in 5 minutes.</p>'
        });
        sent = true;
      } catch (e) { sendErr = e.message; console.error('SMTP send error:', e.message); }
    }
    res.json({ ok: true, needVerify: true, email, sent, sendErr, message: sent ? 'Code sent to ' + email : (sendErr || 'SMTP not configured') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.get('/api/auth/smtp-status', (req, res) => {
  const configured = !!(appConfig.smtp.host && appConfig.smtp.user);
  res.json({ configured, host: appConfig.smtp.host, user: appConfig.smtp.user, from: appConfig.smtp.from });
});
server.post('/api/auth/smtp-config', (req, res) => {
  try {
    const { host, port, user, pass, from } = req.body;
    if (host) appConfig.smtp.host = host;
    if (port) appConfig.smtp.port = port;
    if (user) appConfig.smtp.user = user;
    if (pass) appConfig.smtp.pass = pass;
    if (from) appConfig.smtp.from = from;
    saveJSON(CONFIG_FILE, appConfig);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Membership & Activation =====
const ACTIVATION_CODES_FILE = path.join(DATA_DIR, 'activation_codes.json');
let activationCodes = loadJSON(ACTIVATION_CODES_FILE);
if (!activationCodes.codes) activationCodes.codes = {}; // code -> { used, createdBy, createdAt, usedBy, usedAt }

function checkMembership(user) {
  if (!user) return { active: false, tier: 'free', reason: 'No user' };
  const now = Date.now();
  if (user.memberUntil > now) return { active: true, tier: 'pro', expiresAt: user.memberUntil };
  if (user.trialUntil > now) return { active: true, tier: 'trial', expiresAt: user.trialUntil };
  return { active: false, tier: 'free', reason: user.trialUntil ? 'Trial expired. Upgrade to Pro.' : 'No membership.' };
}

// Generate activation codes (admin only in production)
server.post('/api/auth/generate-codes', (req, res) => {
  try {
    const { count = 1, masterKey } = req.body;
    if (masterKey !== 'hamdean-admin-2024') return res.status(403).json({ error: 'Unauthorized' });
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = 'HD-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      activationCodes.codes[code] = { used: false, createdAt: Date.now() };
      codes.push(code);
    }
    saveJSON(ACTIVATION_CODES_FILE, activationCodes);
    res.json({ ok: true, codes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Activate membership with code
server.post('/api/auth/activate', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and activation code required' });
    const ac = activationCodes.codes[code.toUpperCase()];
    if (!ac) return res.status(400).json({ error: 'Invalid activation code' });
    if (ac.used) return res.status(400).json({ error: 'Code already used' });
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    ac.used = true; ac.usedBy = email; ac.usedAt = Date.now();
    user.membership = 'pro';
    user.memberUntil = Math.max(user.memberUntil, Date.now()) + 30 * 24 * 3600 * 1000; // +30 days from now or extend
    saveJSON(ACTIVATION_CODES_FILE, activationCodes);
    saveJSON(USERS_FILE, userStore);
    res.json({ ok: true, memberUntil: user.memberUntil });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get membership status
server.get('/api/auth/membership', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const sess = findSession(token);
    if (!sess) return res.status(401).json({ error: 'Invalid session' });
    const user = findUser(sess.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ms = checkMembership(user);
    res.json({ ok: true, membership: ms, email: user.email, trialUntil: user.trialUntil, memberUntil: user.memberUntil });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!checkRate('resend_' + email, 3, 300000)) return res.status(429).json({ error: 'Too many requests. Wait 5 minutes.' });
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'No account with this email' });
    if (user.verified) return res.status(400).json({ error: 'Email already verified. Please login.' });
    const code = genCode();
    cleanCodes();
    verifyCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    let sent = false;
    const mailer = getMailer();
    if (mailer) {
      try {
        await mailer.sendMail({
          from: appConfig.smtp.from || appConfig.smtp.user,
          to: email,
          subject: 'Hamdean — Email Verification Code',
          text: `Your verification code is: ${code}\n\nIt expires in 5 minutes.\n\n— Hamdean`,
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;"><h2 style="color:#f0a346;">Hamdean</h2><p>Your verification code:</p><h1 style="letter-spacing:8px;color:#333;">${code}</h1><p style="color:#888;font-size:12px;">Expires in 5 minutes.</p></div>`
        });
        sent = true;
      } catch (e) { console.error('Send email failed:', e.message); }
    }
    res.json({ ok: true, sent, message: sent ? 'Verification code re-sent to ' + email : 'SMTP not configured. Contact administrator.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auth/verify-email', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
    if (!checkRate('verify_' + email, 10, 300000)) return res.status(429).json({ error: 'Too many attempts. Please wait.' });
    cleanCodes();
    const vc = verifyCodes.get(email);
    if (!vc) return res.status(400).json({ error: 'No verification code found or code expired. Please register again.' });
    if (vc.attempts >= 5) { verifyCodes.delete(email); return res.status(429).json({ error: 'Too many attempts. Please register again.' }); }
    vc.attempts++;
    if (vc.code !== code) return res.status(400).json({ error: 'Invalid code. ' + (5 - vc.attempts) + ' attempts remaining.' });
    verifyCodes.delete(email);
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.verified = true;
    saveJSON(USERS_FILE, userStore);
    const token = newToken();
    sessionStore.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    saveJSON(SESSIONS_FILE, sessionStore);
    const ms = checkMembership(user);
    res.json({ ok: true, user: { id: user.id, email: user.email, membership: ms }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const ip = getIP(req);
    // Check IP rate limit
    if (!checkRate('login_ip_' + ip, 20, 60000)) return res.status(429).json({ error: 'Too many requests. Please wait.' });
    // Check account lockout
    const lockMsg = checkLockout(email);
    if (lockMsg) return res.status(423).json({ error: lockMsg });
    // Check per-email rate limit
    if (!checkRate('login_em_' + email, 10, 60000)) return res.status(429).json({ error: 'Too many attempts. Please wait.' });
    const user = userStore.users.find(u => u.email === email);
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      recordFailure(email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    clearLockout(email);
    if (!user.verified) return res.status(403).json({ error: 'Email not verified', needVerify: true, email: user.email });
    const token = newToken();
    sessionStore.sessions = sessionStore.sessions.filter(s => s.userId !== user.id);
    sessionStore.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    saveJSON(SESSIONS_FILE, sessionStore);
    const ms = checkMembership(user);
    res.json({ ok: true, user: { id: user.id, email: user.email, membership: ms }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auth/session', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const sess = findSession(token);
    if (!sess) return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    const user = findUser(sess.userId);
    if (!user) return res.status(401).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auth/logout', (req, res) => {
  try {
    const { token } = req.body;
    if (token) { sessionStore.sessions = sessionStore.sessions.filter(s => s.token !== token); saveJSON(SESSIONS_FILE, sessionStore); }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT = `http://localhost:${PORT}/api/auth/google-callback`;

server.get('/api/auth/google-url', (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.json({ url: null, error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.' });
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { provider: 'google', createdAt: Date.now() });
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      'client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID) +
      '&redirect_uri=' + encodeURIComponent(GOOGLE_REDIRECT) +
      '&response_type=code&scope=openid%20email%20profile&state=' + state +
      '&access_type=offline&prompt=consent';
    res.json({ url, state });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.get('/api/auth/google-callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) {
      return res.status(400).send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#ef4444;">Login Failed</h3><p>Invalid request</p></div></body></html>');
    }
    oauthStates.delete(state);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=' + encodeURIComponent(code) + '&client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID) + '&client_secret=' + encodeURIComponent(GOOGLE_CLIENT_SECRET) + '&redirect_uri=' + encodeURIComponent(GOOGLE_REDIRECT) + '&grant_type=authorization_code'
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) throw new Error('No id_token');
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());
    const email = payload.email;
    let user = userStore.users.find(u => u.email === email);
    if (!user) {
      user = { id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), email, provider: 'google', createdAt: Date.now() };
      userStore.users.push(user);
      saveJSON(USERS_FILE, userStore);
    }
    const token = newToken();
    sessionStore.sessions = sessionStore.sessions.filter(s => s.userId !== user.id);
    sessionStore.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    saveJSON(SESSIONS_FILE, sessionStore);
    oauthStates.set(state + '_result', { token, user: { id: user.id, email: user.email } });
    res.send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#22c55e;">Login Successful!</h3><p>Return to Hamdean</p><p style="color:#888;font-size:12px;">You can close this window</p></div></body></html>');
  } catch (err) {
    res.status(500).send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#ef4444;">Login Failed</h3><p>' + err.message + '</p></div></body></html>');
  }
});

server.get('/api/auth/pending-oauth', (req, res) => {
  try {
    const { state } = req.query;
    if (!state) return res.status(400).json({ error: 'State required' });
    const result = oauthStates.get(state + '_result');
    if (result) {
      oauthStates.delete(state + '_result');
      return res.json({ ready: true, token: result.token, user: result.user });
    }
    if (oauthStates.has(state)) return res.json({ ready: false });
    res.json({ ready: false, error: 'Unknown state' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fast Node.js file search (no shell)
function fSearch(kw, dirs) {
  const r=[], sk=new Set(['node_modules','.git','AppData','Application Data','Windows','ProgramData','$Recycle.Bin','System Volume Information','Temp','Cache','Microsoft','assembly','installer','locales','resources','WinSxS','Fonts','Migration','MSBuild','WindowsApps']);
  const t=Date.now(), q=kw.toLowerCase(); let n=0;
  function w(d,dp) {
    if(dp>3||Date.now()-t>8000||r.length>40||n>5000)return;
    let e;try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
    for(const x of e){if(Date.now()-t>8000||r.length>40||n>5000)break;n++;
      try{
        if(x.isDirectory()&&!sk.has(x.name)&&!x.name.startsWith('.')&&!x.name.startsWith('$')){if(x.name.toLowerCase().includes(q))r.push('DIR '+path.join(d,x.name));w(path.join(d,x.name),dp+1)}
        else if(x.isFile()&&x.name.toLowerCase().includes(q))r.push('FILE '+path.join(d,x.name)+' '+(fs.statSync(path.join(d,x.name)).size/1024).toFixed(0)+'KB')
      }catch{}
    }
  }
  for(const d of dirs)if(fs.existsSync(d))w(d,0);
  return r;
}

async function detectIntent(text) {
  const t=text.toLowerCase();
  const SD=[DESKTOP,path.join(HOME,'Downloads'),'C:/Program Files','C:/Program Files (x86)'];
  const GD=[...SD,'D:/Program Files','D:/Program Files (x86)','D:/Games','D:/Steam'];
  if(/(?:搜索|搜|找|查|有没有|帮我[找搜]|扫描)/.test(t)){
    const km=text.match(/(?:有没有|查看|找|搜|扫描)\s*(?:一下|电脑里|本地)?\s*['"]?([^\s"'，。！？]{1,12})['"]?/);
    const kw=km?km[1].replace(/[的吗了呢啊吧]$/,''):'';
    if(kw&&kw.length>=2&&!/游戏|game|软件|exe|程序/.test(kw)){
      const r=fSearch(kw,/游戏|game/i.test(t)?GD:SD);
      return r.length?'Found '+r.length+' for "'+kw+'":\n'+r.slice(0,30).join('\n'):'No results for "'+kw+'"';
    }
    if(/游戏|game/i.test(t)){
      const a=[];
      for(const gk of['steam','epic','ubisoft','riot','battle','origin','gog','game','Thunder','War']){const r=fSearch(gk,GD);if(r.length)a.push('['+gk+'] '+r.length+':\n'+r.slice(0,8).join('\n'))}
      return a.length?'Game scan:\n\n'+a.join('\n\n'):'No games found';
    }
    return null;
  }
  if(/(桌面|desktop).{0,10}(文件|有什么|列出|看看|查看)/.test(t)||/(列出|看看|查看|有什么).{0,10}(桌面|desktop)/.test(t)){try{const e=fs.readdirSync(DESKTOP,{withFileTypes:true});return DESKTOP+' ['+e.length+']:\n'+e.map(x=>(x.isDirectory()?'DIR ':'FILE ')+x.name).join('\n')}catch(e){return'Error: '+e.message}}
  if(/^(列出|看看|查看|有什么).{0,5}(文件|目录)/.test(t)&&!/桌面|找|搜/.test(t)){try{const e=fs.readdirSync(HOME,{withFileTypes:true});return HOME+' ['+e.length+']:\n'+e.slice(0,30).map(x=>(x.isDirectory()?'DIR ':'FILE ')+x.name).join('\n')}catch(e){return'Error: '+e.message}}
  const rm=text.match(/(?:读|读取|查看|打开)\s*(?:文件)?\s*['"]?([A-Za-z]:[^\s"']+|\S+\.\w{2,6})['"]?/);
  if(rm&&rm[1].length>2){const fp=rm[1].includes(':')?rm[1]:path.join(DESKTOP,rm[1].split(/[/\\]/).pop());if(fs.existsSync(fp)){try{return fs.readFileSync(fp,'utf-8').slice(0,5000)}catch(e){return'Error: '+e.message}}}
  return null;
}

// Knowledge graph
let kN=[{id:'core',label:'Hamdean',group:'core',val:10,color:'#f0a346'},{id:'ai',label:'AI',group:'topic',val:5,color:'#ef4444'},{id:'code',label:'Code',group:'skill',val:4,color:'#3b82f6'},{id:'3d',label:'3D',group:'skill',val:3,color:'#8b5cf6'},{id:'game',label:'Games',group:'topic',val:3,color:'#ef4444'}];
let kE=kN.filter(n=>n.id!=='core').map(n=>({from:'core',to:n.id,weight:n.val}));
function addK(text){const kn=kN.map(n=>n.label.toLowerCase());const ps=[{re:/\b(react|vue|angular|svelte|next\.?js|typescript|python|rust|golang|java|c\+\+|docker|kubernetes|aws|azure|linux|nginx|redis|postgres|mysql)\b/gi,g:'skill',c:'#3b82f6'},{re:/\b(blender|unity|unreal|webgl|opengl|three\.?js|建模|3d)\b/gi,g:'skill',c:'#8b5cf6'},{re:/\b(深度学习|神经网络|transformer|llm|gpt|ai|机器学习)\b/gi,g:'topic',c:'#ef4444'},{re:/\b(steam|epic|游戏|gaming|dota|lol|原神|minecraft)\b/gi,g:'topic',c:'#ef4444'},{re:/\b(tiktok|电商|shopify|amazon|跨境|temu)\b/gi,g:'topic',c:'#ef4444'},{re:/\b(股票|基金|投资|crypto|bitcoin|量化)\b/gi,g:'topic',c:'#ef4444'}];for(const p of ps){const ms=text.match(p.re);if(!ms)continue;for(const m of[...new Set(ms)]){if(!kn.includes(m.toLowerCase())&&m.length>1&&m.length<25){kN.push({id:'k_'+Date.now().toString(36)+Math.random().toString(36).slice(2,4),label:m,group:p.g,val:3,color:p.c});kE.push({from:'core',to:kN[kN.length-1].id,weight:3});kn.push(m.toLowerCase())}}}}
server.get('/api/knowledge',(req,res)=>res.json({nodes:kN,edges:kE}));
// ===== Auto-Learn Engine =====
let autoLearnRunning = false;
let autoLearnInterval = null;
const activityLog = []; // [{ time, action, detail, type: 'info'|'discovery'|'action' }]

function logActivity(action, detail, type = 'info') {
  activityLog.unshift({ time: Date.now(), action, detail, type });
  if (activityLog.length > 200) activityLog.length = 200;
}

server.get('/api/auto-learn/activity', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });
  const sess = findSession(token);
  if (!sess) return res.status(401).json({ error: 'Invalid session' });
  const user = findUser(sess.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  const ms = checkMembership(user);
  if (!ms.active) return res.status(403).json({ error: 'Membership required for auto-learn', membership: ms });
  const since = parseInt(req.query.since) || 0;
  res.json({ running: autoLearnRunning, activities: activityLog.filter(a => a.time > since) });
});

server.post('/api/auto-learn/start', async (req, res) => {
  try {
    const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token required' });
    const sess = findSession(token);
    if (!sess) return res.status(401).json({ error: 'Invalid session' });
    const user = findUser(sess.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const ms = checkMembership(user);
    if (!ms.active) return res.status(403).json({ error: 'Membership required. Upgrade to Pro.', membership: ms });
    if (autoLearnRunning) return res.json({ ok: true, message: 'Already running' });

    const { base_url, api_key, model } = req.body;
    if (!base_url || !api_key || !model) return res.status(400).json({ error: 'API config required' });

    autoLearnRunning = true;
    logActivity('start', 'Auto-learn engine started', 'info');
    logActivity('scan', 'Analyzing knowledge graph patterns...', 'action');

    autoLearnInterval = setInterval(async () => {
      if (!autoLearnRunning) { clearInterval(autoLearnInterval); return; }
      try {
        logActivity('cycle', 'Learning cycle initiated', 'info');
        // Feed existing knowledge to AI for pattern discovery
        const knowSummary = kN.map(n => n.label).join(', ');
        const learnPrompt = `You are an AI knowledge extractor. Based on the current knowledge graph nodes: [${knowSummary}], suggest 1-2 new related topics or connections that would be valuable for a general AI assistant. Return ONLY a JSON array: [{"label":"TopicName","group":"skill|topic|interest","reason":"short reason"}]. Groups: skill (technical abilities), topic (knowledge domains), interest (hobbies/areas). Be creative and diverse.`;

        const apiUrl = base_url.replace(/\/+$/, '') + '/chat/completions';
        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: learnPrompt }], stream: false, max_tokens: 512 }),
          signal: AbortSignal.timeout(15000)
        });
        if (r.ok) {
          const raw = await r.text();
          let text = '';
          try {
            if (raw.trim().startsWith('data: ')) {
              for (const l of raw.split('\n')) {
                if (!l.startsWith('data: ')) continue;
                const d = l.slice(6).trim();
                if (d === '[DONE]') continue;
                try { text += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch {}
              }
            } else { text = JSON.parse(raw).choices?.[0]?.message?.content || ''; }
          } catch {}
          // Parse JSON from response
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const suggestions = JSON.parse(jsonMatch[0]);
            for (const s of suggestions) {
              if (!kN.find(n => n.label.toLowerCase() === s.label.toLowerCase())) {
                const node = { id: 'k_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), label: s.label, group: s.group || 'topic', val: 3, color: s.group === 'skill' ? '#3b82f6' : s.group === 'interest' ? '#8b5cf6' : '#ef4444' };
                kN.push(node);
                kE.push({ from: 'core', to: node.id, weight: 3 });
                logActivity('discovery', `New node: "${s.label}" — ${s.reason || 'AI suggested'}`, 'discovery');
              }
            }
          }
        }
      } catch (e) {
        logActivity('error', 'Learning cycle failed: ' + e.message, 'info');
      }
    }, 15000); // Every 15 seconds

    logActivity('running', 'Learning loop active (15s interval)', 'action');
    res.json({ ok: true, message: 'Auto-learn started' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auto-learn/stop', (req, res) => {
  autoLearnRunning = false;
  if (autoLearnInterval) { clearInterval(autoLearnInterval); autoLearnInterval = null; }
  logActivity('stop', 'Auto-learn engine stopped', 'info');
  res.json({ ok: true });
});

// Chat
server.post('/api/chat',async(req,res)=>{
  try{
    const{base_url,api_key,model,messages,system_prompt}=req.body;
    if(!base_url||!api_key||!model||!messages)return res.status(400).json({error:'Missing'});
    const apiUrl=base_url.replace(/\/+$/,'')+'/chat/completions';
    const lu=[...messages].reverse().find(m=>m.role==='user');
    const tr=lu?await detectIntent(lu.content):null;
    let ml=[{role:'system',content:system_prompt||SYS},...messages];
    if(tr)ml.push({role:'user',content:'[Tool result]\n'+tr.slice(0,3000)+'\n\nReply based on this.'});
    const ac=new AbortController();const tm=setTimeout(()=>ac.abort('timeout'),300000);
    const r=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+api_key},body:JSON.stringify({model,messages:ml,stream:false,max_tokens:8192}),signal:ac.signal});
    clearTimeout(tm);
    if(!r.ok){const e=await r.text();return res.status(502).json({error:'API '+r.status+': '+e.slice(0,300)})}
    const raw=await r.text();let text='';
    if(raw.trim().startsWith('data: ')){for(const l of raw.split('\n')){if(!l.startsWith('data: '))continue;const d=l.slice(6).trim();if(d==='[DONE]')continue;try{text+=JSON.parse(d).choices?.[0]?.delta?.content||''}catch{}}}
    else{try{text=JSON.parse(raw).choices?.[0]?.message?.content||''}catch{}}
    addK(lu.content+' '+text.slice(0,300));
    const resp={content:text};if(tr)resp.tools=[{tool:'auto',arg:lu.content.slice(0,40),result:tr.slice(0,500)}];
    res.json(resp);
  }catch(err){console.error('[chat]',err.message);try{res.status(500).json({error:err.message})}catch{}}
});

server.get('/api/status',(req,res)=>res.json({ok:true}));

// Electron
let mw;
function cw(){mw=new BrowserWindow({width:1100,height:750,minWidth:600,minHeight:400,backgroundColor:'#0f0f13',title:'Hamdean',frame:false,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  mw.webContents.on('context-menu',(e,p)=>{const i=[];if(p.isEditable){i.push({label:'Paste',role:'paste'},{label:'Cut',role:'cut'},{label:'Copy',role:'copy'});}else if(p.selectionText)i.push({label:'Copy',role:'copy'});i.push({label:'Select All',role:'selectAll'});if(i.length)Menu.buildFromTemplate(i).popup({window:mw})});
  mw.loadURL('http://localhost:'+PORT)}
ipcMain.handle('win-min',()=>mw?.minimize());ipcMain.handle('win-max',()=>{mw?.isMaximized()?mw.unmaximize():mw?.maximize()});ipcMain.handle('win-close',()=>mw?.close());ipcMain.handle('win-ismax',()=>mw?.isMaximized()??false);
// Auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
});
ipcMain.handle('check-update', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return result ? { updateAvailable: true, version: result.updateInfo.version } : { updateAvailable: false };
  } catch (e) { return { updateAvailable: false, error: e.message }; }
});
ipcMain.handle('download-update', async () => {
  autoUpdater.on('download-progress', (p) => { mw?.webContents.send('update-progress', p.percent); });
  await autoUpdater.downloadUpdate();
  return { ok: true };
});
ipcMain.handle('install-update', () => { autoUpdater.quitAndInstall(); });

app.whenReady().then(()=>{server.listen(PORT,'127.0.0.1',()=>{console.log('Hamdean http://localhost:'+PORT);cw();setTimeout(()=>{autoUpdater.checkForUpdates().catch(()=>{})},5000)})});
app.on('window-all-closed',()=>app.quit());
