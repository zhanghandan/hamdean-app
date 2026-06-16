// Hamdean Auth Server — standalone, deploy to ECS
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { readSecure, writeSecure } = require('./crypto-utils');

const server = express();
const PORT = process.env.AUTH_PORT || 4198;
const DATA_DIR = path.join(__dirname, '.hamdean-auth');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

server.use(cors());
server.use(express.json({ limit: '10mb' }));

process.on('uncaughtException', (err) => { console.error('[AUTH CRASH]', err.message); });

// ===== JSON Helpers =====
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CODES_FILE = path.join(DATA_DIR, 'activation_codes.json');

function loadJSON(fp) {
  try {
    if ([USERS_FILE, SESSIONS_FILE, CONFIG_FILE].includes(fp)) {
      const secured = readSecure(fp);
      if (secured) return JSON.parse(secured);
    }
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch { return {}; }
}
function saveJSON(fp, obj) {
  const json = JSON.stringify(obj, null, 2);
  if ([USERS_FILE, SESSIONS_FILE, CONFIG_FILE].includes(fp)) writeSecure(fp, json);
  fs.writeFileSync(fp, json);
}

// ===== Auth State =====
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
  if (Date.now() > s.expiresAt) {
    sessionStore.sessions = sessionStore.sessions.filter(x => x.token !== token);
    saveJSON(SESSIONS_FILE, sessionStore);
    return null;
  }
  return s;
}
function findUser(id) { return userStore.users.find(u => u.id === id); }

// ===== SMTP =====
let appConfig = loadJSON(CONFIG_FILE);
if (!appConfig.smtp) appConfig.smtp = {
  host: 'smtp.163.com', port: 465, user: 'REDACTED@email.com',
  pass: 'REDACTED', from: 'Hamdean <REDACTED@email.com>'
};

let _mailer = null; let _mailerCfg = '';
function getMailer() {
  if (!appConfig.smtp.host || !appConfig.smtp.user) return null;
  const cfg = appConfig.smtp.host + appConfig.smtp.port + appConfig.smtp.user + appConfig.smtp.pass;
  if (_mailer && _mailerCfg === cfg) return _mailer;
  _mailer = nodemailer.createTransport({
    host: appConfig.smtp.host, port: appConfig.smtp.port,
    secure: appConfig.smtp.port === 465,
    auth: { user: appConfig.smtp.user, pass: appConfig.smtp.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  _mailerCfg = cfg;
  return _mailer;
}

// ===== Verification Codes =====
const verifyCodes = new Map();
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function cleanCodes() {
  for (const [k, v] of verifyCodes) { if (Date.now() > v.expires) verifyCodes.delete(k); }
}

// ===== Rate Limiting =====
const rateLimit = new Map();
const lockouts = new Map();
function getIP(req) { return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'; }
function checkRate(key, maxAttempts = 10, windowMs = 60000) {
  const now = Date.now();
  let entry = rateLimit.get(key);
  if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; rateLimit.set(key, entry); }
  entry.count++;
  return entry.count <= maxAttempts;
}
function checkLockout(email) {
  const entry = lockouts.get(email);
  if (!entry) return null;
  if (Date.now() > entry.lockUntil) { lockouts.delete(email); return null; }
  const mins = Math.ceil((entry.lockUntil - Date.now()) / 60000);
  return `账户已锁定。请在 ${mins} 分钟后重试。`;
}
function recordFailure(email) {
  let entry = lockouts.get(email);
  if (!entry || Date.now() > entry.lockUntil) { entry = { failures: 0, lockUntil: 0 }; }
  entry.failures++;
  if (entry.failures >= 5) { entry.lockUntil = Date.now() + 15 * 60000; }
  else if (entry.failures >= 3) { entry.lockUntil = Date.now() + 60000; }
  lockouts.set(email, entry);
}
function clearLockout(email) { lockouts.delete(email); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimit) { if (now > v.resetAt) rateLimit.delete(k); }
  for (const [k, v] of lockouts) { if (now > v.lockUntil + 3600000) lockouts.delete(k); }
  cleanCodes();
}, 600000);

// ===== Membership =====
let activationCodes = loadJSON(CODES_FILE);
if (!activationCodes.codes) activationCodes.codes = {};

function checkMembership(user) {
  if (!user) return { active: false, tier: 'free', reason: 'No user' };
  const now = Date.now();
  if (user.memberUntil > now) return { active: true, tier: 'pro', expiresAt: user.memberUntil };
  if (user.trialUntil > now) return { active: true, tier: 'trial', expiresAt: user.trialUntil };
  return { active: false, tier: 'free', reason: user.trialUntil ? '试用已过期，请升级到 Pro。' : '无会员。' };
}

// ===== ROUTES =====

server.get('/api/status', (req, res) => res.json({ ok: true, service: 'hamdean-auth' }));

// Register
server.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    const ip = getIP(req);
    if (!checkRate('reg_ip_' + ip, 5, 300000)) return res.status(429).json({ error: '注册过于频繁，请稍后再试。' });
    const existing = userStore.users.find(u => u.email === email);
    if (existing) {
      if (existing.verified) return res.status(409).json({ error: '该邮箱已注册' });
      userStore.users = userStore.users.filter(u => u.id !== existing.id);
      saveJSON(USERS_FILE, userStore);
    }
    const { salt, hash } = hashPassword(password);
    const user = {
      id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      email, passwordHash: hash, salt, createdAt: Date.now(), verified: false,
      membership: 'trial', trialUntil: Date.now() + 3 * 24 * 3600 * 1000, memberUntil: 0
    };
    userStore.users.push(user);
    saveJSON(USERS_FILE, userStore);
    const code = genCode();
    cleanCodes();
    verifyCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    // Return immediately, send email in background
    res.json({ ok: true, needVerify: true, email, message: '验证码已发送至 ' + email });
    const mailer = getMailer();
    if (mailer) {
      mailer.sendMail({
        from: appConfig.smtp.from || appConfig.smtp.user,
        to: email,
        subject: 'Hamdean — 验证码',
        text: 'Your code: ' + code + ' (expires in 5 min)',
        html: '<h2>Hamdean</h2><h1>' + code + '</h1><p>5分钟内有效。</p>'
      }).then(() => console.log('[SMTP] Sent to', email))
        .catch(e => console.error('[SMTP] Failed:', e.message));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend code
server.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!checkRate('resend_' + email, 3, 300000)) return res.status(429).json({ error: '请求过于频繁，请 5 分钟后再试。' });
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: '该邮箱未注册' });
    if (user.verified) return res.status(400).json({ error: '邮箱已验证，请登录。' });
    const code = genCode();
    cleanCodes();
    verifyCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    res.json({ ok: true, message: '验证码已重新发送至 ' + email });
    const mailer = getMailer();
    if (mailer) {
      mailer.sendMail({
        from: appConfig.smtp.from || appConfig.smtp.user,
        to: email,
        subject: 'Hamdean — 邮箱验证码',
        text: '你的验证码是: ' + code + '\n\n5分钟内有效。\n\n— Hamdean',
        html: '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;"><h2 style="color:#f0a346;">Hamdean</h2><p>你的验证码:</p><h1 style="letter-spacing:8px;color:#333;">' + code + '</h1><p style="color:#888;font-size:12px;">5分钟内有效。</p></div>'
      }).then(() => console.log('[SMTP] Resent to', email))
        .catch(e => console.error('[SMTP] Resend failed:', e.message));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify email
server.post('/api/auth/verify-email', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
    if (!checkRate('verify_' + email, 10, 300000)) return res.status(429).json({ error: '尝试次数过多，请稍后再试。' });
    cleanCodes();
    const vc = verifyCodes.get(email);
    if (!vc) return res.status(400).json({ error: '验证码未找到或已过期，请重新注册。' });
    if (vc.attempts >= 5) { verifyCodes.delete(email); return res.status(429).json({ error: '尝试次数过多，请重新注册。' }); }
    vc.attempts++;
    if (vc.code !== code) return res.status(400).json({ error: '验证码错误，剩余 ' + (5 - vc.attempts) + ' 次尝试。' });
    verifyCodes.delete(email);
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: '用户未找到' });
    user.verified = true;
    saveJSON(USERS_FILE, userStore);
    const token = newToken();
    sessionStore.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    saveJSON(SESSIONS_FILE, sessionStore);
    const ms = checkMembership(user);
    res.json({ ok: true, user: { id: user.id, email: user.email, membership: ms }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Login
server.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const ip = getIP(req);
    if (!checkRate('login_ip_' + ip, 20, 60000)) return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
    const lockMsg = checkLockout(email);
    if (lockMsg) return res.status(423).json({ error: lockMsg });
    if (!checkRate('login_em_' + email, 10, 60000)) return res.status(429).json({ error: '尝试次数过多，请稍后再试。' });
    const user = userStore.users.find(u => u.email === email);
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      recordFailure(email);
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
    clearLockout(email);
    if (!user.verified) return res.status(403).json({ error: '邮箱未验证', needVerify: true, email: user.email });
    const token = newToken();
    sessionStore.sessions = sessionStore.sessions.filter(s => s.userId !== user.id);
    sessionStore.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
    saveJSON(SESSIONS_FILE, sessionStore);
    const ms = checkMembership(user);
    res.json({ ok: true, user: { id: user.id, email: user.email, membership: ms }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Session check
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

// Logout
server.post('/api/auth/logout', (req, res) => {
  try {
    const { token } = req.body;
    if (token) {
      sessionStore.sessions = sessionStore.sessions.filter(s => s.token !== token);
      saveJSON(SESSIONS_FILE, sessionStore);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Membership status
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

// Activate membership
server.post('/api/auth/activate', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and activation code required' });
    const ac = activationCodes.codes[code.toUpperCase()];
    if (!ac) return res.status(400).json({ error: '无效的激活码' });
    if (ac.used) return res.status(400).json({ error: '激活码已被使用' });
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: '用户未找到' });
    ac.used = true; ac.usedBy = email; ac.usedAt = Date.now();
    user.membership = 'pro';
    user.memberUntil = Math.max(user.memberUntil, Date.now()) + 30 * 24 * 3600 * 1000;
    saveJSON(CODES_FILE, activationCodes);
    saveJSON(USERS_FILE, userStore);
    res.json({ ok: true, memberUntil: user.memberUntil });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generate codes (admin)
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
    saveJSON(CODES_FILE, activationCodes);
    res.json({ ok: true, codes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SMTP status
server.get('/api/auth/smtp-status', (req, res) => {
  res.json({ configured: !!(appConfig.smtp.host && appConfig.smtp.user), host: appConfig.smtp.host, user: appConfig.smtp.user, from: appConfig.smtp.from });
});

// SMTP config update
server.post('/api/auth/smtp-config', (req, res) => {
  try {
    const { host, port, user, pass, from } = req.body;
    if (host) appConfig.smtp.host = host;
    if (port) appConfig.smtp.port = port;
    if (user) appConfig.smtp.user = user;
    if (pass) appConfig.smtp.pass = pass;
    if (from) appConfig.smtp.from = from;
    _mailer = null; _mailerCfg = ''; // Reset cached transporter
    saveJSON(CONFIG_FILE, appConfig);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start
server.listen(PORT, '0.0.0.0', () => {
  console.log('Hamdean Auth Server :' + PORT);
  console.log('SMTP:', appConfig.smtp.host ? appConfig.smtp.host + ':' + appConfig.smtp.port : 'not configured');
  console.log('Users:', userStore.users.length);
});
