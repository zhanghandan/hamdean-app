// Hamdean v4 — AI Desktop Agent
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const nodemailer = require('nodemailer');
const { readSecure, writeSecure } = require('./crypto-utils');

const server = express();
const HOME = process.env.HOME || process.env.USERPROFILE || 'C:/Users/Administrator';
const DESKTOP = path.join(HOME, 'Desktop');
const PORT = 4199;

server.use(cors());
server.use(express.json({ limit: '50mb' }));
server.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8'));
});
process.on('uncaughtException', (err) => { console.error('[CRASH]', err.message); });

// ===== Auth Proxy to ECS =====
const https = require('https');
const AUTH_SERVER = process.env.AUTH_SERVER || 'https://47.93.39.27';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Proxy all /api/auth/* requests to the remote auth server
server.all('/api/auth/*', (req, res) => {
  let resSent = false;
  const sendOnce = (status, data) => {
    if (resSent) return;
    resSent = true;
    res.status(status).json(data);
  };
  const targetUrl = AUTH_SERVER.replace(/\/+$/, '') + req.originalUrl;
  const urlObj = new URL(targetUrl);
  const body = req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : null;

  const opts = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname + urlObj.search,
    method: req.method,
    agent: httpsAgent,
    timeout: 15000,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': req.ip
    }
  };
  if (req.headers.authorization) opts.headers['Authorization'] = req.headers.authorization;
  if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

  const proxyReq = https.request(opts, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try {
        sendOnce(proxyRes.statusCode, JSON.parse(data));
      } catch {
        if (!resSent) { resSent = true; res.status(proxyRes.statusCode).send(data); }
      }
    });
  });
  proxyReq.on('error', (e) => {
    console.error('[AUTH PROXY]', e.message);
    sendOnce(502, { error: 'Auth server unreachable: ' + e.message });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    sendOnce(504, { error: 'Auth server timeout' });
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
});

// ===== System Prompt Builder =====
function buildSysPrompt() {
  const now = new Date();
  const ds = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const dateISO = now.toISOString().slice(0, 10);

  return `你是 Hamdean，运行在张涵 Windows 电脑上的高智能 AI 助手。你能搜索网页、读写文件、执行终端命令。

## ⚡ 第一铁律：先做后说，禁止空回

收到用户消息后，你的第一反应**绝对不能是回复文字**。你必须先分析：

1. 用户要的东西是否需要**实时数据**（金价、股价、天气、新闻、汇率等）？→ 直接调工具，不要先回"让我查一下"
2. 用户要的东西是否需要**读取文件/查看目录/搜索文件**？→ 直接调工具，不要先回"我来看看"
3. 用户要的东西是否需要**执行命令/操作电脑**？→ 直接调工具，不要先回"好的我来做"
4. 用户要的是否是**复杂多步骤任务**？→ 先调plan_thinking列出计划，再逐步执行

**关键规则：如果你打算回复的第一句话包含"让我"、"我来"、"我帮你"、"好的"、"我先"——停，不要回复文字，直接调用工具。工具返回结果后再说话。**

## 🎯 任务聚焦：只做用户要的，不自行加戏

收到用户消息后，画一个明确边界：**用户要你做什么，你就只做什么。** 不是用户要求的，一件都不多做。

- 用户发图片问你"这是什么"，你就调用视觉识别然后回答。不要顺便搜代码、不要改配置、不要打安装包、不要git
- 用户要你写一个HTML文件，你就写那个文件。不要顺便优化项目结构、不要清理无关文件、不要改版本号
- 用户问金价，你就查金价并回答。不要顺便搜其他财经数据、不要分析走势
- **永远不要主动修改 Hamdean 自身的代码** — 那是张涵的项目，不是你的任务
- **永远不要主动执行 npm/pip install、electron-builder、打包、构建** — 除非用户明确要求
- **永远不要主动 git commit/push** — 除非用户明确要求
- 如果你发现自己跑偏了 → 立刻停，只输出用户要的结果

只有以下情况可以直接文字回复（无需调工具）：
- 纯聊天/问候（"你好"、"今天心情不错"）
- 对已有知识的简单确认（"1+1等于几"）
- 对你上一轮已获取数据的小追问（用户引用了你刚刚查到的数据）
- 用户明确说"不用查"、"直接说"

## 当前时间
${ds}（北京时间），年份 2026。
你的训练数据已过时。所有实时信息必须通过工具获取，禁止使用训练数据。

## 核心操作原则

**做事不预告**: 要查东西就直接查，不要在回复里预告你要查。查完拿到结果再说话。

**事实高于记忆**: 工具返回的数据是绝对权威。即使与你的训练记忆冲突，以工具数据为准。

**自我质疑**: 回答前问自己：这个数字/日期/事实是哪来的？工具返回的？还是训练数据？如果是训练数据，必须先用工具验证。

**复杂任务先规划**: 多步骤操作→调用plan_thinking列出步骤→逐步执行→验证结果→最后汇总回复。

## 工具使用细则

你有以下工具可用。遇到对应场景必须主动调用（不要先说话再调，直接调）：

- **web_search**: 查金价、股价、天气、新闻、汇率、百科等任何需要最新信息的问题
- **get_gold_price**: 用户问金价时，必须调用此工具获取新浪财经实时数据
- **read_file**: 用户要读文件、看代码、查看内容
- **write_file**: 用户要创建文件、保存内容
- **list_directory**: 用户要看目录内容、桌面文件、某个文件夹
- **search_files**: 用户要找某个文件，不知道在哪
- **exec**: 在用户电脑执行终端命令（仅限白名单目录）。参数: command(必须), cwd(可选工作目录), timeout(可选毫秒，默认30s，最大120s)。支持dir/ls, echo, git, node, python, npm, type/cat等。危险命令自动拦截。长命令设置较大timeout
- **plan_thinking**: 复杂多步骤任务前，先列出计划再执行

工具调用规则：
1. 不要猜文件路径→先用list_directory或search_files确认
2. 写文件前→确认目录存在
3. 并行调用无关工具（同时搜网页+查金价）
4. 如果工具返回错误→换个方式重试或告诉用户
5. 获得工具结果后→必须基于结果回答，不要忽略结果
6. exec 命令必须在白名单目录执行，优先用 Git Bash/node/python 等已安装工具
7. exec 返回超时被kill时→用更大的timeout值重试，或告诉用户命令执行时间过长

## 严禁行为

1. **严禁空回预告**: 收到需要数据/操作的请求后，严禁回复"让我查一下"、"我来帮你看看"、"好的"等预告性文字而不调工具。直接调工具，拿到结果再说话
2. **严禁编造数据**: 价格、汇率、日期、新闻、代码——没有工具结果支撑的，不准说
3. **严禁使用训练数据替代工具结果**: 工具说金价738，你不准说750、830、758或任何其他数字
4. **严禁承认自己是任何特定AI模型**: 你是Hamdean，不说"作为DeepSeek/GPT/Claude"
5. **严禁忽略工具结果**: 调用了工具就必须用其结果
6. **严禁无意义道歉**: 不重复道歉、不解释"为什么我错了"超过一句
7. **严禁输出过时日期**: 今年是2026年，不要在回复中出现2025年或其他年份
8. **严禁半途而废**: 多步骤任务必须做完所有步骤再汇总，不要做一步就停
9. **严禁自行扩展任务**: 只做用户明确要求的事。不改Hamdean自身代码、不跑打包构建、不git操作、不升版本号——除非用户明确说要做这些

## 代码质量

写代码时：
- 直接给完整能跑的代码，不省略不缩略
- 不写占位符（// TODO、...）
- 匹配已有代码风格（缩进、命名、注释密度）
- 考虑边界情况和错误处理
- 写完后自检：有没有明显的bug、安全漏洞、性能问题

## 用户信息

- 姓名: 张涵
- 技能: 3D建模(Blender)、AI开发、跨境电商(TikTok Shop)、特斯拉智驾
- 设备: Windows 10 Pro, GTX 960, 阿里云ECS(47.93.39.27)
- 偏好: 直接干，少废话
- 主目录: ${HOME}
- 桌面: ${DESKTOP}`;
}
let SYS = buildSysPrompt();
// Refresh system prompt every 30 min to keep time accurate
setInterval(() => { SYS = buildSysPrompt(); }, 1800000);

// ===== Data Directory =====
let DATA_DIR;
try { DATA_DIR = path.join(app.getPath('userData'), 'data'); } catch { DATA_DIR = path.join(__dirname, '.hamdean'); }
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ===== Memory System =====
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const USER_PROFILE = path.join(DATA_DIR, 'user_profile.md');

if (!fs.existsSync(MEMORY_INDEX)) {
  fs.writeFileSync(MEMORY_INDEX, `# Hamdean Memory Index

- [用户档案](user-profile.md) — 张涵，技能:3D建模/AI开发/跨境电商

> 每次对话结束后，重要信息会自动存为记忆文件。
> 相关记忆会在后续对话中自动加载。
`);
}

if (!fs.existsSync(USER_PROFILE)) {
  fs.writeFileSync(USER_PROFILE, `---
name: user-profile
description: 用户张涵的基本档案
metadata:
  type: user
---

# 用户档案
- 姓名: 张涵
- 技能: 3D建模(Blender)、AI开发、跨境电商(TikTok Shop)
- 设备: Windows 10 Pro, GTX 960, 阿里云ECS(47.93.39.27)
- 偏好: 直接干，少废话
- 主项目: Tesla Vision纯视觉智驾、Hamdean AI Agent、A股追踪
`);
}

function loadMemoryIndex() {
  try { return fs.readFileSync(MEMORY_INDEX, 'utf-8'); } catch { return ''; }
}

function loadMemories() {
  const index = loadMemoryIndex();
  const refs = index.match(/\[([^\]]+)\]\(([^)]+)\)/g) || [];
  const memories = [];
  for (const ref of refs) {
    const m = ref.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      const [_, title, filename] = m;
      const fp = path.join(MEMORY_DIR, filename);
      if (fs.existsSync(fp)) {
        try {
          const content = fs.readFileSync(fp, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          if (fmMatch) {
            memories.push({ title, filename, frontmatter: fmMatch[1], body: fmMatch[2].slice(0, 2000) });
          } else {
            memories.push({ title, filename, frontmatter: '', body: content.slice(0, 2000) });
          }
        } catch {}
      }
    }
  }
  return memories;
}

function findRelevantMemories(query) {
  const keywords = query.toLowerCase().split(/[\s,，。！？]+/).filter(w => w.length > 1);
  const all = loadMemories();
  if (!keywords.length) return all.slice(0, 5);
  const scored = all.map(m => {
    const text = (m.title + ' ' + m.frontmatter + ' ' + m.body).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score += 10;
      if (m.title.toLowerCase().includes(kw)) score += 5;
    }
    return { ...m, score };
  });
  return scored.filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
}

function saveMemory(name, description, content, type) {
  const filename = name.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') + '.md';
  const fp = path.join(MEMORY_DIR, filename);
  const frontmatter = `---
name: ${name}
description: ${description}
metadata:
  type: ${type || 'project'}
---
`;
  fs.writeFileSync(fp, frontmatter + '\n' + content);
  let index = loadMemoryIndex();
  const line = `- [${description}](${filename}) — ${type || 'project'}`;
  if (!index.includes(filename)) {
    index = index.trimEnd() + '\n' + line + '\n';
    fs.writeFileSync(MEMORY_INDEX, index);
  }
  return { name, filename, description };
}

// ===== Project Context Auto-Loader =====
function loadProjectContext() {
  const files = [];
  for (const fp of [path.join(HOME, 'CLAUDE.md'), path.join(HOME, '.claude', 'CLAUDE.md'), path.join(DESKTOP, 'CLAUDE.md')]) {
    if (fs.existsSync(fp)) {
      try { files.push({ path: fp, content: fs.readFileSync(fp, 'utf-8').slice(0, 3000) }); } catch {}
    }
  }
  if (!files.length) return '';
  return '\n\n## 项目上下文\n' + files.map(f => `### ${f.path}\n${f.content}`).join('\n\n');
}

// ===== Task Store =====
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
let taskStore = loadJSON(TASKS_FILE);
if (!taskStore.tasks) taskStore.tasks = [];
function saveTasks() { saveJSON(TASKS_FILE, taskStore); }

server.get('/api/tasks', (req, res) => {
  res.json({ ok: true, tasks: taskStore.tasks });
});
server.post('/api/tasks', (req, res) => {
  const { subject, status } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject required' });
  const task = { id: 't_' + Date.now().toString(36), subject, status: status || 'pending', createdAt: Date.now() };
  taskStore.tasks.push(task);
  saveTasks();
  res.json({ ok: true, task });
});
server.patch('/api/tasks/:id', (req, res) => {
  const t = taskStore.tasks.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (req.body.status) t.status = req.body.status;
  if (req.body.subject) t.subject = req.body.subject;
  saveTasks();
  res.json({ ok: true, task: t });
});
server.delete('/api/tasks/:id', (req, res) => {
  taskStore.tasks = taskStore.tasks.filter(t => t.id !== req.params.id);
  saveTasks();
  res.json({ ok: true });
});

// ===== Precise Time API =====
server.get('/api/time', (req, res) => {
  const now = new Date();
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  res.json({
    ok: true,
    beijing: bj.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    iso: now.toISOString(),
    unix_s: Math.floor(now.getTime() / 1000),
    unix_ms: now.getTime(),
    tz: 'Asia/Shanghai',
    precision: 'millisecond'
  });
});

// ===== Exec API — Safe command execution =====
const EXEC_WHITELIST_DIRS = [
  HOME,
  'C:/Users/Administrator/hamdean2',
  'C:/Users/Administrator/tesla-vision',
  'C:/Users/Administrator/stock-tracker',
  'C:/Users/Administrator/claude-dispatcher',
  'C:/Users/Administrator/ai-chat',
];
const EXEC_BLOCKED = ['format', 'del /f', 'rm -rf', 'shutdown', 'restart', 'logoff', ':(){', '> /dev/sda'];

server.post('/api/exec', (req, res) => {
  const { command, cwd, timeout } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ ok: false, error: 'command 不能为空' });
  }

  const lower = command.toLowerCase();
  for (const blocked of EXEC_BLOCKED) {
    if (lower.includes(blocked.toLowerCase())) {
      return res.status(403).json({ ok: false, error: `命令被阻止: ${blocked}` });
    }
  }

  const workDir = cwd || HOME;
  if (EXEC_WHITELIST_DIRS.length > 0) {
    const normalized = path.normalize(workDir).toLowerCase();
    const allowed = EXEC_WHITELIST_DIRS.some(d => normalized.startsWith(path.normalize(d).toLowerCase()));
    if (!allowed) {
      return res.status(403).json({ ok: false, error: `目录不在白名单: ${workDir}` });
    }
  }

  const opts = {
    cwd: workDir,
    timeout: Math.min(timeout || 30000, 120000),
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  };

  exec(command, opts, (err, stdout, stderr) => {
    if (err) {
      res.json({
        ok: false,
        error: err.message,
        code: err.code,
        killed: err.killed,
        stdout: stdout.slice(0, 5000),
        stderr: stderr.slice(0, 5000),
      });
    } else {
      res.json({
        ok: true,
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 5000),
      });
    }
  });
});

// ===== Context Builder =====
function buildContext(userQuery, toolResult, conversationHistory) {
  const ctx = { systemPrompt: SYS, memories: '', knowledge: '', skills: '', history: '' };
  let memCount = 0;

  const mems = findRelevantMemories(userQuery || '');
  if (mems.length) {
    ctx.memories = '\n\n## 相关记忆\n' + mems.map(m =>
      `### ${m.title}\n${m.body.slice(0, 1500)}`
    ).join('\n\n');
    memCount = mems.length;
  }

  try {
    const recent = knowledgeStore.entries.slice(0, 20);
    if (recent.length) {
      ctx.knowledge = '\n\n## 已学知识\n' + recent.map(e =>
        `- **${e.title}** [${(e.tags || []).join(', ')}]\n  ${(e.content || '').slice(0, 300)}`
      ).join('\n');
    }
  } catch {}

  try {
    const active = skillsStore.skills.filter(s => s.enabled);
    if (active.length) {
      ctx.skills = '\n\n## 激活技能\n' + active.map(s =>
        `### ${s.name}\n${s.prompt}`
      ).join('\n\n');
    }
  } catch {}

  if (conversationHistory && conversationHistory.length > 1) {
    const recent = conversationHistory.slice(-6);
    ctx.history = '\n\n## 最近对话\n' + recent.map(m =>
      `**${m.role === 'user' ? '用户' : 'Hamdean'}**: ${m.content.slice(0, 200)}`
    ).join('\n\n');
  }

  const parts = [ctx.systemPrompt];
  const projCtx = loadProjectContext();
  if (projCtx) parts.push(projCtx);
  if (ctx.memories) parts.push(ctx.memories);
  if (ctx.knowledge) parts.push(ctx.knowledge);
  if (ctx.skills) parts.push(ctx.skills);
  if (ctx.history) parts.push(ctx.history);

  return { systemPrompt: parts.join('\n'), memories: memCount, knowledgeEntries: 0 };
}

// ===== Response Verifier =====
function verifyResponse(aiText, toolResult) {
  if (!toolResult) return null;

  const apiPriceMatch = toolResult.match(/人民币金价\s*([\d.]+)\s*元\/克/);
  if (apiPriceMatch) {
    const realPrice = parseFloat(apiPriceMatch[1]);
    const aiPrices = aiText.match(/(\d{2,4}(?:\.\d{1,2})?)\s*(?:元|块)\s*[\/每]?\s*(?:克|g)/g);
    if (aiPrices) {
      for (const p of aiPrices) {
        const num = parseFloat(p.match(/\d+(?:\.\d+)?/)[0]);
        if (Math.abs(num - realPrice) / realPrice > 0.05 && num > 100) {
          console.log('[verify] WARNING: AI said', num, 'but real price is', realPrice);
          return { conflict: true, realPrice, aiPrice: num, note: 'AI使用了训练数据中的价格而非API数据' };
        }
      }
    }
  }
  return null;
}

// ===== JSON Helpers =====
function loadJSON(fp) {
  try {
    const sensitiveFiles = [USERS_FILE, SESSIONS_FILE, path.join(DATA_DIR, 'config.json')];
    if (sensitiveFiles.includes(fp)) {
      const secured = readSecure(fp);
      if (secured) return JSON.parse(secured);
    }
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch { return {}; }
}
function saveJSON(fp, obj) {
  const json = JSON.stringify(obj, null, 2);
  const sensitiveFiles = [USERS_FILE, SESSIONS_FILE, path.join(DATA_DIR, 'config.json')];
  if (sensitiveFiles.includes(fp)) {
    writeSecure(fp, json);
    return;
  }
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
async function validateSessionViaECS(token) {
  if (!token) return null;
  try {
    const r = await fetch(AUTH_SERVER + '/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      agent: httpsAgent
    });
    const d = await r.json();
    return d.ok ? d.user : null;
  } catch (e) {
    console.error('[ECS Session]', e.message);
    return null;
  }
}

// ===== SMTP Config =====
let appConfig = loadJSON(CONFIG_FILE);
if (!appConfig.smtp) appConfig.smtp = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || ''
};

function getMailer() {
  if (!appConfig.smtp.host || !appConfig.smtp.user) return null;
  // Create fresh transporter — avoids stale connection issues
  return nodemailer.createTransport({
    host: appConfig.smtp.host,
    port: appConfig.smtp.port,
    secure: appConfig.smtp.port === 465,
    auth: { user: appConfig.smtp.user, pass: appConfig.smtp.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    pool: false
  });
}

// ===== Verification Codes =====
const verifyCodes = new Map();
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function cleanCodes() {
  for (const [k, v] of verifyCodes) { if (Date.now() > v.expires) verifyCodes.delete(k); }
}

// ===== Rate Limiting & Brute Force Protection =====
const rateLimit = new Map();
const lockouts = new Map();

function getIP(req) { return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1'; }

function checkRate(key, maxAttempts = 10, windowMs = 60000) {
  const now = Date.now();
  let entry = rateLimit.get(key);
  if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; rateLimit.set(key, entry); }
  entry.count++;
  if (entry.count > maxAttempts) return false;
  return true;
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

// ===== Auth Routes =====
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
    // Fire and forget — dont block the user
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
if (!activationCodes.codes) activationCodes.codes = {};

function checkMembership(user) {
  if (!user) return { active: false, tier: 'free', reason: 'No user' };
  const now = Date.now();
  if (user.memberUntil > now) return { active: true, tier: 'pro', expiresAt: user.memberUntil };
  if (user.trialUntil > now) return { active: true, tier: 'trial', expiresAt: user.trialUntil };
  return { active: false, tier: 'free', reason: user.trialUntil ? '试用已过期，请升级到 Pro。' : '无会员。' };
}

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
    saveJSON(ACTIVATION_CODES_FILE, activationCodes);
    saveJSON(USERS_FILE, userStore);
    res.json({ ok: true, memberUntil: user.memberUntil });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    if (!checkRate('resend_' + email, 3, 300000)) return res.status(429).json({ error: '请求过于频繁，请 5 分钟后再试。' });
    const user = userStore.users.find(u => u.email === email);
    if (!user) return res.status(404).json({ error: '该邮箱未注册' });
    if (user.verified) return res.status(400).json({ error: '邮箱已验证，请登录。' });
    const code = genCode();
    cleanCodes();
    verifyCodes.set(email, { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
    // Return immediately, send in background
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
    if (token) {
      sessionStore.sessions = sessionStore.sessions.filter(s => s.token !== token);
      saveJSON(SESSIONS_FILE, sessionStore);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Google OAuth =====
const oauthStates = new Map();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT = `http://localhost:${PORT}/api/auth/google-callback`;

server.get('/api/auth/google-url', (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.json({ url: null, error: 'Google OAuth not configured.' });
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
      return res.status(400).send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#ef4444;">登录失败</h3><p>无效请求</p></div></body></html>');
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
    res.send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#22c55e;">登录成功！</h3><p>返回 Hamdean</p><p style="color:#888;font-size:12px;">可以关闭此窗口</p></div></body></html>');
  } catch (err) {
    res.status(500).send('<html><body style="background:#0f0f13;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center;"><h3 style="color:#ef4444;">登录失败</h3><p>' + err.message + '</p></div></body></html>');
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

// ===== Fast File Search =====
function fSearch(kw, dirs) {
  const r = [], sk = new Set(['node_modules', '.git', 'AppData', 'Application Data', 'Windows', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'Temp', 'Cache', 'Microsoft', 'assembly', 'installer', 'locales', 'resources', 'WinSxS', 'Fonts', 'Migration', 'MSBuild', 'WindowsApps']);
  const t = Date.now(), q = kw.toLowerCase(); let n = 0;
  function w(d, dp) {
    if (dp > 3 || Date.now() - t > 8000 || r.length > 40 || n > 5000) return;
    let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) {
      if (Date.now() - t > 8000 || r.length > 40 || n > 5000) break; n++;
      try {
        if (x.isDirectory() && !sk.has(x.name) && !x.name.startsWith('.') && !x.name.startsWith('$')) {
          if (x.name.toLowerCase().includes(q)) r.push('DIR ' + path.join(d, x.name));
          w(path.join(d, x.name), dp + 1);
        } else if (x.isFile() && x.name.toLowerCase().includes(q)) {
          r.push('FILE ' + path.join(d, x.name) + ' ' + (fs.statSync(path.join(d, x.name)).size / 1024).toFixed(0) + 'KB');
        }
      } catch {}
    }
  }
  for (const d of dirs) if (fs.existsSync(d)) w(d, 0);
  return r;
}

// ===== Knowledge Base =====
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
let knowledgeStore = loadJSON(KNOWLEDGE_FILE);
if (!knowledgeStore.entries) knowledgeStore.entries = [];
if (!knowledgeStore.nodes) knowledgeStore.nodes = [];
if (!knowledgeStore.edges) knowledgeStore.edges = [];

function saveKnowledge() { saveJSON(KNOWLEDGE_FILE, knowledgeStore); }

if (!knowledgeStore.nodes.length) {
  knowledgeStore.nodes.push({ id: 'core', label: 'Hamdean', group: 'core', val: 12, color: '#f0a346' });
  saveKnowledge();
}

function addKnowledge(title, content, tags, source, fromChat) {
  const exists = knowledgeStore.entries.find(e => e.title === title || (content && e.content && e.content.slice(0, 100) === content.slice(0, 100)));
  if (exists) {
    exists.updatedAt = Date.now();
    exists.tags = [...new Set([...(exists.tags || []), ...tags])];
    saveKnowledge();
    return exists;
  }
  const entry = { id: 'ke_' + Date.now().toString(36), title, content: content.slice(0, 5000), tags, source, fromChat: fromChat || '', createdAt: Date.now(), updatedAt: Date.now() };
  knowledgeStore.entries.unshift(entry);
  if (knowledgeStore.entries.length > 500) knowledgeStore.entries.length = 500;

  for (const tag of tags) {
    const existing = knowledgeStore.nodes.find(n => n.label.toLowerCase() === tag.toLowerCase());
    if (existing) { existing.val = Math.min(existing.val + 1, 30); }
    else {
      const colors = { skill: '#3b82f6', topic: '#ef4444', interest: '#8b5cf6', tech: '#22c55e', finance: '#f59e0b' };
      const group = /(react|vue|python|rust|docker|kubernetes|typescript|golang|java|blender|three|webgl|建模|3d|nginx|redis)/i.test(tag) ? 'skill'
        : /(股票|基金|金价|投资|黄金|金融|经济|汇率)/i.test(tag) ? 'finance'
        : /(游戏|steam|dota|lol|原神|minecraft|gaming)/i.test(tag) ? 'interest'
        : 'topic';
      const node = { id: 'gn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), label: tag, group, val: 2, color: colors[group] || '#ef4444' };
      knowledgeStore.nodes.push(node);
      knowledgeStore.edges.push({ from: 'core', to: node.id, weight: 1 });
    }
  }
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const nA = knowledgeStore.nodes.find(n => n.label.toLowerCase() === tags[i].toLowerCase());
      const nB = knowledgeStore.nodes.find(n => n.label.toLowerCase() === tags[j].toLowerCase());
      if (nA && nB) {
        const existingEdge = knowledgeStore.edges.find(e =>
          (e.from === nA.id && e.to === nB.id) || (e.from === nB.id && e.to === nA.id));
        if (existingEdge) existingEdge.weight = Math.min(existingEdge.weight + 1, 10);
        else knowledgeStore.edges.push({ from: nA.id, to: nB.id, weight: 1 });
      }
    }
  }
  saveKnowledge();
  logActivity('learned', `"${title.slice(0, 50)}" [${tags.join(', ')}]`, 'discovery');
  return entry;
}

function extractTopics(text) {
  const topics = [];
  const patterns = [
    { re: /(?:什么是|怎么|如何|介绍|了解|学习|帮我).{0,10}([A-Za-z一-鿿]{2,20})(?:是|怎么|如何|？|\?|$)/g, clean: true },
    { re: /\b(react|vue|angular|typescript|python|rust|golang|docker|kubernetes|nginx|redis|postgres|mysql|mongodb|graphql|rest|api|aws|azure|linux|git|github|node\.?js|next\.?js|tailwind|prisma|tRPC)\b/gi, clean: false },
    { re: /\b(blender|unity|unreal|webgl|three\.?js|建模|3D|shader|渲染|动画|骨骼|rig)\b/gi, clean: false },
    { re: /\b(金价|黄金|股票|基金|A股|港股|美股|比特币|投资|理财|期货|外汇)\b/gi, clean: false },
    { re: /\b(tiktok|抖音|电商|shopify|amazon|跨境|temu|选品|供应链|物流|短视频)\b/gi, clean: false },
    { re: /\b(AI|GPT|LLM|transformer|深度学习|机器学习|神经网络|大模型|fine.?tuning|RAG|embedding|vector|agent)\b/gi, clean: false },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(text)) && topics.length < 10) {
      const kw = (p.clean ? (m[1] || m[0]) : m[0]).toLowerCase().trim();
      if (kw.length >= 2 && kw.length < 30 && !/^(什么|怎么|如何|是|的|了|吗|呢|啊|吧|这|那|我|你|他)$/.test(kw)) {
        topics.push(kw);
      }
    }
  }
  return [...new Set(topics)];
}

// ===== Activity Log =====
const activityLog = [];
function logActivity(action, detail, type = 'info') {
  activityLog.unshift({ time: Date.now(), action, detail, type });
  if (activityLog.length > 300) activityLog.length = 300;
}

// ===== Knowledge API =====
server.get('/api/knowledge', (req, res) => {
  res.json({ nodes: knowledgeStore.nodes, edges: knowledgeStore.edges, entries: knowledgeStore.entries.slice(0, 100) });
});

server.get('/api/knowledge/entries', (req, res) => {
  const { q, limit } = req.query;
  let entries = knowledgeStore.entries;
  if (q) {
    const kw = q.toLowerCase();
    entries = entries.filter(e => e.title.toLowerCase().includes(kw) || (e.tags && e.tags.some(t => t.toLowerCase().includes(kw))));
  }
  res.json({ ok: true, entries: entries.slice(0, parseInt(limit) || 50) });
});

server.delete('/api/knowledge/entries/:id', (req, res) => {
  knowledgeStore.entries = knowledgeStore.entries.filter(e => e.id !== req.params.id);
  saveKnowledge();
  res.json({ ok: true });
});

// ===== Real Learning: analyze chat + search web =====
server.post('/api/learn', async (req, res) => {
  try {
    const { userMessage, aiResponse } = req.body;
    const text = (userMessage || '') + ' ' + (aiResponse || '');
    if (!text.trim()) return res.status(400).json({ error: 'No content' });

    const topics = extractTopics(text);
    logActivity('analyze', '分析中: 发现 ' + topics.length + ' 个话题', 'info');

    let learned = [];
    for (const topic of topics.slice(0, 3)) {
      try {
        const sq = encodeURIComponent(topic);
        const r = await fetch('https://www.bing.com/search?q=' + sq + '&setlang=zh-cn', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' },
          signal: AbortSignal.timeout(10000)
        });
        const html = await r.text();
        const snippets = [];
        const snipRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
        let m;
        while ((m = snipRe.exec(html)) && snippets.length < 5) {
          const s = m[1].replace(/<[^>]+>/g, '').replace(/&ensp;|&nbsp;|&emsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
          if (s.length > 30) snippets.push(s);
        }
        const titles = [];
        const titleRe = /<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi;
        while ((m = titleRe.exec(html)) && titles.length < 5) {
          const t = m[1].replace(/<[^>]+>/g, '').trim();
          if (t && t.length > 3) titles.push(t);
        }

        if (snippets.length || titles.length) {
          const content = (titles.length ? '📪 ' + titles.join('\n') + '\n\n' : '') + snippets.join('\n');
          addKnowledge(topic, content, [topic, ...topics.filter(t => t !== topic).slice(0, 3)], 'web-search', userMessage.slice(0, 100));
          learned.push({ topic, sources: titles.length + snippets.length });
          logActivity('search', `搜索 "${topic}": ${titles.length + snippets.length} 条结果`, 'action');
        }
      } catch (e) {
        logActivity('error', `搜索 "${topic}" 失败: ${e.message}`, 'info');
      }
    }

    if (topics.length > 0 && userMessage && userMessage.length > 20) {
      addKnowledge(
        userMessage.slice(0, 100),
        aiResponse ? aiResponse.slice(0, 2000) : '',
        topics.slice(0, 5),
        'chat-analysis',
        userMessage.slice(0, 100)
      );
      learned.push({ topic: '对话', sources: 1 });
    }

    res.json({ ok: true, topics, learned, totalEntries: knowledgeStore.entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Auto-Learn =====
let autoLearnRunning = false;
let autoLearnTimer = null;

server.get('/api/auto-learn/activity', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });
  const user = await validateSessionViaECS(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  const since = parseInt(req.query.since) || 0;
  res.json({ running: autoLearnRunning, activities: activityLog.filter(a => a.time > since), totalKnowledge: knowledgeStore.entries.length, totalNodes: knowledgeStore.nodes.length });
});

server.post('/api/auto-learn/start', async (req, res) => {
  try {
    const token = req.body.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token required' });
    const user = await validateSessionViaECS(token);
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    if (autoLearnRunning) return res.json({ ok: true, message: '已在运行中' });

    autoLearnRunning = true;
    logActivity('start', '知识引擎已激活 — 从对话中学习', 'info');
    res.json({ ok: true, message: '学习引擎已启动', totalKnowledge: knowledgeStore.entries.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/auto-learn/stop', (req, res) => {
  autoLearnRunning = false;
  if (autoLearnTimer) { clearTimeout(autoLearnTimer); autoLearnTimer = null; }
  logActivity('stop', '学习引擎已停止', 'info');
  res.json({ ok: true, totalKnowledge: knowledgeStore.entries.length });
});

// ===== Gold/Finance Price API =====
server.get('/api/gold-price', async (req, res) => {
  try {
    const goldR = await fetch('https://hq.sinajs.cn/list=hf_XAU', {
      headers: { 'Referer': 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(8000)
    });
    const goldText = await goldR.text();
    const goldM = goldText.match(/"([^"]+)"/);
    if (!goldM) return res.json({ ok: false, error: '金价数据解析失败' });
    const goldParts = goldM[1].split(',');
    const usdPerOz = parseFloat(goldParts[0]);
    const goldName = goldParts[goldParts.length - 1] || '伦敦现货黄金';

    const fxR = await fetch('https://hq.sinajs.cn/list=fx_susdcny', {
      headers: { 'Referer': 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(8000)
    });
    const fxText = await fxR.text();
    const fxM = fxText.match(/"([^"]+)"/);
    let usdCny = 7.2;
    if (fxM && fxM[1]) {
      const fxParts = fxM[1].split(',');
      usdCny = parseFloat(fxParts[1]) || parseFloat(fxParts[0]) || 7.2;
    }

    const cnyPerGram = Math.round(usdPerOz * usdCny / 31.1035 * 100) / 100;
    const usdPerGram = Math.round(usdPerOz / 31.1035 * 100) / 100;

    res.json({
      ok: true,
      source: `新浪财经 (${goldName})`,
      updated: new Date().toLocaleString('zh-CN'),
      usdPerOz: Math.round(usdPerOz * 100) / 100,
      usdPerGram: Math.round(usdPerGram * 100) / 100,
      cnyPerGram,
      usdCny: Math.round(usdCny * 10000) / 10000,
      formula: `${usdPerOz} USD/oz ÷ 31.1 × ${usdCny} 汇率 = ${cnyPerGram} 元/克`,
      note: '此为伦敦现货金价（不含国内溢价和工艺费），金店零售价在此基础上+100~200元/克'
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== Web Search =====
server.post('/api/web-search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });
    const q = encodeURIComponent(query);
    let results = [];
    const isPriceQuery = /(金价|黄金|股价|价格|多少钱|汇率|多少钱)/.test(query);

    try {
      const r = await fetch('https://www.bing.com/search?q=' + q + '&setlang=zh-cn', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        },
        signal: AbortSignal.timeout(12000)
      });
      const html = await r.text();

      // Direct answer box
      const ansRe = /<div[^>]*class="[^"]*b_ans[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
      let am;
      while ((am = ansRe.exec(html))) {
        const ansText = am[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
        if (ansText.length > 10) results.push({ title: '直接答案', snippet: ansText });
      }

      // Search result blocks
      const algoRe = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
      let m;
      while ((m = algoRe.exec(html)) && results.length < 10) {
        const block = m[1];
        const tM = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
        const sM = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
               || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
               || block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (tM) {
          const title = tM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
          const snippet = sM ? sM[1].replace(/<[^>]+>/g, '').replace(/&ensp;|&nbsp;|&emsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
          if (title && title.length > 2) results.push({ title, snippet: snippet || title });
        }
      }

      // Deep fetch for price queries
      if (isPriceQuery && results.length > 0) {
        try {
          const urlM = html.match(/<li[^>]*class="b_algo"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i);
          if (urlM && urlM[1] && !urlM[1].includes('bing.com')) {
            const pageR = await fetch(urlM[1], {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(8000)
            });
            const pageHtml = await pageR.text();
            const bodyText = pageHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').slice(0, 3000);
            const priceRe = /(\d{2,4}\s*(?:\.\d{1,2})?\s*(?:元|块)\s*[\/每]?\s*(?:克|g|盎司|oz))/gi;
            const prices = bodyText.match(priceRe);
            if (prices && prices.length) {
              results.unshift({ title: '当前价格（从网页提取）', snippet: prices.slice(0, 5).join(' | ') + ' | 来源: ' + urlM[1] });
            } else {
              const meaningful = bodyText.slice(0, 500).trim();
              if (meaningful.length > 50) {
                results.unshift({ title: '网页详情', snippet: meaningful + '... | 来源: ' + urlM[1] });
              }
            }
          }
        } catch (e) { console.log('Deep page fetch failed:', e.message); }
      }

      // Fallback
      if (!results.length) {
        const cnRe = /(?:<p[^>]*>|<div[^>]*>)([一-鿿][^<]{20,200})</gi;
        while ((m = cnRe.exec(html)) && results.length < 8) {
          results.push({ title: query, snippet: m[1].replace(/&nbsp;/g, ' ').trim() });
        }
      }
    } catch (e) { console.log('Bing search failed:', e.message); }

    res.json({ ok: true, results });
  } catch (err) {
    res.json({ ok: false, error: err.message, results: [] });
  }
});

// ===== File Tools API =====
server.post('/api/tools/read-file', (req, res) => {
  try {
    const { path: fp } = req.body;
    if (!fp) return res.status(400).json({ error: 'Path required' });
    const resolved = fp.includes(':') ? fp : path.join(HOME, fp);
    if (/Windows|System32|ntuser|SAM|SECURITY/i.test(resolved)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: '文件未找到: ' + fp });
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.json({ ok: true, isDir: true, name: path.basename(resolved), contents: fs.readdirSync(resolved).slice(0, 100) });
    const content = fs.readFileSync(resolved, 'utf-8').slice(0, 50000);
    res.json({ ok: true, path: resolved, size: stat.size, content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/tools/write-file', (req, res) => {
  try {
    const { path: fp, content } = req.body;
    if (!fp || content === undefined) return res.status(400).json({ error: 'Path and content required' });
    const resolved = fp.includes(':') ? fp : path.join(DESKTOP, fp);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, path: resolved, size: content.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/tools/edit-file', (req, res) => {
  try {
    const { path: fp, find, replace } = req.body;
    if (!fp || !find) return res.status(400).json({ error: 'Path and find required' });
    const resolved = fp.includes(':') ? fp : path.join(HOME, fp);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    let content = fs.readFileSync(resolved, 'utf-8');
    if (!content.includes(find)) return res.json({ ok: false, error: '查找文本在文件中未找到' });
    content = content.replace(find, replace || '');
    fs.writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, path: resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/tools/list-dir', (req, res) => {
  try {
    const { path: fp } = req.body;
    const target = fp ? (fp.includes(':') ? fp : path.join(HOME, fp)) : HOME;
    if (!fs.existsSync(target)) return res.status(404).json({ error: '目录未找到' });
    const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 200);
    const items = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? (() => { try { return fs.statSync(path.join(target, e.name)).size } catch { return 0 } })() : 0 }));
    res.json({ ok: true, path: target, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/tools/search-files', (req, res) => {
  try {
    const { keyword, dirs } = req.body;
    if (!keyword || keyword.length < 2) return res.status(400).json({ error: '关键词太短' });
    const searchDirs = dirs || [HOME, DESKTOP, 'C:/Program Files'];
    const results = fSearch(keyword, searchDirs);
    res.json({ ok: true, keyword, results: results.slice(0, 50) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Skills API =====
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');
let skillsStore = loadJSON(SKILLS_FILE);
if (!skillsStore.skills) skillsStore.skills = [
  { id: 'skill_1', name: '代码专家', prompt: '你是代码专家。看代码、写代码、修bug、做架构。直接给能跑的代码。', enabled: true, builtin: true },
  { id: 'skill_2', name: '调试专家', prompt: '你是调试专家。分析报错、找根因、给修复方案。先看日志再看代码。', enabled: true, builtin: true },
  { id: 'skill_3', name: '文件管理', prompt: '你是文件管理专家。帮用户整理、搜索、批量改名、分析磁盘空间。', enabled: true, builtin: true },
  { id: 'skill_4', name: '前端开发', prompt: '你是前端专家。HTML/CSS/JS/React/Vue。写出的界面直接能用，好看。', enabled: true, builtin: true },
  { id: 'skill_5', name: '写作专家', prompt: '你是写作专家。帮写文案、邮件、报告、文档。语言精准有力。', enabled: true, builtin: true }
];

function saveSkills() { saveJSON(SKILLS_FILE, skillsStore); }

server.get('/api/skills', (req, res) => {
  res.json({ ok: true, skills: skillsStore.skills });
});

server.post('/api/skills', (req, res) => {
  try {
    const { id, name, prompt, enabled } = req.body;
    if (!name || !prompt) return res.status(400).json({ error: 'Name and prompt required' });
    if (id) {
      const idx = skillsStore.skills.findIndex(s => s.id === id);
      if (idx >= 0) {
        skillsStore.skills[idx] = { ...skillsStore.skills[idx], name, prompt, enabled: enabled !== undefined ? enabled : skillsStore.skills[idx].enabled };
        saveSkills();
        return res.json({ ok: true, skill: skillsStore.skills[idx] });
      }
    }
    const skill = { id: 'skill_' + Date.now().toString(36), name, prompt, enabled: enabled !== false, builtin: false };
    skillsStore.skills.push(skill);
    saveSkills();
    res.json({ ok: true, skill });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.delete('/api/skills/:id', (req, res) => {
  try {
    const s = skillsStore.skills.find(s => s.id === req.params.id);
    if (s && s.builtin) return res.status(400).json({ error: '不能删除内置技能' });
    skillsStore.skills = skillsStore.skills.filter(s => s.id !== req.params.id);
    saveSkills();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.post('/api/skills/toggle/:id', (req, res) => {
  try {
    const s = skillsStore.skills.find(s => s.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Skill not found' });
    s.enabled = !s.enabled;
    saveSkills();
    res.json({ ok: true, enabled: s.enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function getActiveSkillsContext() {
  const active = skillsStore.skills.filter(s => s.enabled);
  if (!active.length) return '';
  return '\n\n[启用的技能]\n' + active.map(s => `【${s.name}】${s.prompt}`).join('\n');
}

// ===== Intent Detection =====
async function detectIntent(text) {
  const t = text.toLowerCase();

  // Gold price — always use dedicated API
  if (/(金价|黄金|gold|au99|AU99)/i.test(text)) {
    try {
      const goldR = await fetch('http://localhost:' + PORT + '/api/gold-price', { signal: AbortSignal.timeout(10000) });
      const goldD = await goldR.json();
      if (goldD.ok) {
        return {
          tool: 'gold_api',
          result: `【实时金价 — 可靠数据源: ${goldD.source}】\n更新时间: ${goldD.updated}\n伦敦现货黄金: ${goldD.usdPerOz} USD/盎司 (${goldD.usdPerGram} USD/克)\n人民币金价: ${goldD.cnyPerGram} 元/克（基础金价）\n汇率: ${goldD.usdCny}\n计算: ${goldD.formula}\n${goldD.note}\n\n⚠️ 以上是新浪财经实时API数据，你必须使用这个价格回答，不要用任何训练数据或搜索引擎中的价格！`
        };
      }
    } catch (e) { console.log('Gold API failed:', e.message); }
  }

  // Web search trigger
  if (/(股价|股票|天气|新闻|汇率|比特币|最新|实时|今天|今日|现在|当前).{0,10}(多少|什么|怎么|如何|是|搜索|查一下|搜一下|帮我查)/.test(t)) {
    const sq = text.replace(/搜索|查一下|搜一下|帮我查|搜索一下/g, '').replace(/['"]/g, '').trim().slice(0, 50);

    // Also try gold API for gold-related queries
    if (/(金价|黄金)/i.test(text)) {
      try {
        const goldR = await fetch('http://localhost:' + PORT + '/api/gold-price', { signal: AbortSignal.timeout(8000) });
        const goldD = await goldR.json();
        if (goldD.ok) {
          return {
            tool: 'gold_api',
            result: `【实时金价 — 可靠数据源: ${goldD.source}】\n更新时间: ${goldD.updated}\n伦敦现货黄金: ${goldD.usdPerOz} USD/盎司 (${goldD.usdPerGram} USD/克)\n人民币金价: ${goldD.cnyPerGram} 元/克（基础金价）\n汇率: ${goldD.usdCny}\n计算: ${goldD.formula}\n${goldD.note}`
          };
        }
      } catch (e) { /* fall through */ }
    }

    try {
      const r = await fetch('http://localhost:' + PORT + '/api/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sq }),
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (d.ok && d.results.length) {
        return { tool: 'web_search', result: '网页搜索结果:\n' + d.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n\n') };
      }
    } catch (e) { /* fall through to file tools */ }
  }

  // File search
  const SD = [DESKTOP, path.join(HOME, 'Downloads'), 'C:/Program Files', 'C:/Program Files (x86)'];
  const GD = [...SD, 'D:/Program Files', 'D:/Program Files (x86)', 'D:/Games', 'D:/Steam'];
  if (/(?:搜索|搜|找|查查|有没有|帮我[找搜]|扫描)/.test(t)) {
    const km = text.match(/(?:有没有|查看|找|搜|扫描)\s*(?:一下|电脑里|本地)?\s*['"]?([^\s"'，。！？]{1,12})['"]?/);
    const kw = km ? km[1].replace(/[的吗了呢啊吧]$/, '') : '';
    if (kw && kw.length >= 2 && !/游戏|game|软件|exe|程序/.test(kw)) {
      const r = fSearch(kw, /游戏|game/i.test(t) ? GD : SD);
      return r.length ? { tool: 'search_files', result: `找到 ${r.length} 个 "${kw}":\n` + r.slice(0, 30).join('\n') } : { tool: 'search_files', result: `未找到 "${kw}"` };
    }
    if (/游戏|game/i.test(t)) {
      const a = [];
      for (const gk of ['steam', 'epic', 'ubisoft', 'riot', 'battle', 'origin', 'gog', 'game', 'Thunder', 'War']) {
        const r = fSearch(gk, GD);
        if (r.length) a.push('[' + gk + '] ' + r.length + ':\n' + r.slice(0, 8).join('\n'));
      }
      return a.length ? { tool: 'search_files', result: '游戏扫描:\n\n' + a.join('\n\n') } : { tool: 'search_files', result: '未找到游戏' };
    }
    return null;
  }
  if (/(桌面|desktop).{0,10}(文件|有什么|列出|看看|查看)/.test(t) || /(列出|看看|查看|有什么).{0,10}(桌面|desktop)/.test(t)) {
    try {
      const e = fs.readdirSync(DESKTOP, { withFileTypes: true });
      return { tool: 'list_dir', result: DESKTOP + ' [' + e.length + ']:\n' + e.map(x => (x.isDirectory() ? 'DIR ' : 'FILE ') + x.name).join('\n') };
    } catch (e) { return { tool: 'list_dir', result: '错误: ' + e.message }; }
  }
  if (/^(列出|看看|查看|有什么).{0,5}(文件|目录)/.test(t) && !/桌面|找|搜/.test(t)) {
    try {
      const e = fs.readdirSync(HOME, { withFileTypes: true });
      return { tool: 'list_dir', result: HOME + ' [' + e.length + ']:\n' + e.slice(0, 30).map(x => (x.isDirectory() ? 'DIR ' : 'FILE ') + x.name).join('\n') };
    } catch (e) { return { tool: 'list_dir', result: '错误: ' + e.message }; }
  }
  const rm = text.match(/(?:读|读取|查看|打开)\s*(?:文件)?\s*['"]?([A-Za-z]:[^\s"']+|\S+\.\w{2,6})['"]?/);
  if (rm && rm[1].length > 2) {
    const fp = rm[1].includes(':') ? rm[1] : path.join(DESKTOP, rm[1].split(/[/\\]/).pop());
    if (fs.existsSync(fp)) {
      try { return { tool: 'read_file', result: fs.readFileSync(fp, 'utf-8').slice(0, 5000) }; }
      catch (e) { return { tool: 'read_file', result: '错误: ' + e.message }; }
    }
  }
  return null;
}

// ===== Tool Definitions =====
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取实时信息。当用户询问金价、股价、新闻、天气、汇率等需要最新数据的问题时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，中文' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取用户电脑上的文件内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，如 C:/Users/Administrator/Desktop/test.txt 或 Desktop/test.txt' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入内容到用户电脑上的文件',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: '列出目录中的文件和文件夹',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，如 Desktop 或 C:/Users/Administrator/Documents' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在电脑中搜索文件',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '文件名关键词' },
          directory: { type: 'string', description: '搜索起始目录，默认用户主目录' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_gold_price',
      description: '获取实时国际金价（伦敦现货黄金），返回人民币元/克',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_thinking',
      description: '复杂任务前使用此工具进行规划思考。先列出步骤计划，再执行。只在多步骤复杂任务时调用。',
      parameters: {
        type: 'object',
        properties: { steps: { type: 'string', description: '计划步骤，每步一行' } },
        required: ['steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前精确北京时间（毫秒级），返回ISO、Unix、中文格式。任何需要知道"现在几点"的场景都调用此工具。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: '在用户Windows电脑上执行终端命令（仅限白名单目录）。支持: dir/ls(列出文件), echo(测试), git(版本控制), node(JS运行), python(Python脚本), npm(包管理), curl/wget(下载), type/cat(查看文件)等。危险命令自动拦截。适合做文件操作、安装依赖、运行脚本、编译构建等。注意：执行耗时可能较长，需要耐心等待结果。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          cwd: { type: 'string', description: '工作目录，默认用户主目录' },
          timeout: { type: 'number', description: '超时毫秒，默认30s，最大120s。长任务设大些' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_operation',
      description: '执行Git操作。支持: status(查看状态), diff(查看改动), log(查看日志), branch(查看分支)。返回命令输出。',
      parameters: {
        type: 'object',
        properties: {
          repo_path: { type: 'string', description: 'Git仓库路径，默认用户主目录' },
          operation: { type: 'string', description: 'status, diff, log, branch' }
        },
        required: ['operation']
      }
    }
  }
];

// ===== Tool Executor =====
async function executeTool(name, args) {
  switch (name) {
    case 'web_search': {
      const sq = encodeURIComponent(args.query || '');
      try {
        const r = await fetch('http://localhost:' + PORT + '/api/web-search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: args.query }),
          signal: AbortSignal.timeout(12000)
        });
        const d = await r.json();
        return d.ok ? JSON.stringify(d.results.slice(0, 6).map(r => ({ title: r.title, snippet: r.snippet }))) : '搜索失败';
      } catch (e) { return '搜索超时或失败: ' + e.message; }
    }
    case 'read_file': {
      const fp = args.path || '';
      const resolved = fp.includes(':') ? fp : path.join(HOME, fp);
      try {
        if (!fs.existsSync(resolved)) return '文件不存在: ' + resolved;
        return fs.readFileSync(resolved, 'utf-8').slice(0, 10000);
      } catch (e) { return '读取失败: ' + e.message; }
    }
    case 'write_file': {
      const fp = args.path || '';
      const resolved = fp.includes(':') ? fp : path.join(DESKTOP, fp);
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, args.content || '', 'utf-8');
        return '写入成功: ' + resolved + ' (' + (args.content || '').length + ' 字符)';
      } catch (e) { return '写入失败: ' + e.message; }
    }
    case 'list_directory': {
      const fp = args.path || '';
      const target = fp ? (fp.includes(':') ? fp : path.join(HOME, fp)) : HOME;
      try {
        if (!fs.existsSync(target)) return '目录不存在: ' + target;
        const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 100);
        return JSON.stringify(entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })));
      } catch (e) { return '列出失败: ' + e.message; }
    }
    case 'search_files': {
      try {
        const results = fSearch(args.keyword || '', [args.directory || HOME]);
        return JSON.stringify(results.slice(0, 30));
      } catch (e) { return '搜索失败: ' + e.message; }
    }
    case 'get_gold_price': {
      try {
        const r = await fetch('http://localhost:' + PORT + '/api/gold-price', { signal: AbortSignal.timeout(8000) });
        const d = await r.json();
        if (d.ok) return `${d.cnyPerGram} 元/克（伦敦现货黄金，${d.usdPerOz} USD/oz，汇率${d.usdCny}）`;
        return '金价API暂不可用';
      } catch (e) { return '金价查询失败: ' + e.message; }
    }
    case 'plan_thinking': {
      return `计划已记录:\n${args.steps || ''}\n\n现在按步骤执行。`;
    }
    case 'git_operation': {
      const repo = args.repo_path || HOME;
      const op = args.operation || 'status';
      const cmd = `git -C "${repo}" ${op === 'status' ? 'status --short' : op === 'diff' ? 'diff --stat' : op === 'log' ? 'log --oneline -20' : 'branch'}`;
      try {
        const out = require('child_process').execSync(cmd, { encoding: 'utf-8', timeout: 10000, cwd: repo });
        return out.slice(0, 3000) || '(empty)';
      } catch (e) { return `Git ${op} 失败: ${e.message}. 路径: ${repo}`; }
    }
    case 'get_current_time': {
      const now = new Date();
      const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
      return `北京时间: ${bj.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}\nISO: ${now.toISOString()}\nUnix秒: ${Math.floor(now.getTime() / 1000)}\nUnix毫秒: ${now.getTime()}`;
    }
    case 'exec': {
      const cmd = args.command || '';
      if (!cmd) return '错误: command 不能为空';
      const opts = {
        command: cmd,
        cwd: args.cwd || HOME,
        timeout: Math.min(args.timeout || 30000, 120000)
      };
      try {
        const r = await fetch('http://localhost:' + PORT + '/api/exec', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
          signal: AbortSignal.timeout(130000)
        });
        const d = await r.json();
        if (d.ok) {
          const out = d.stdout || '';
          const truncated = out.length >= 10000 ? '\n[输出已截断，可能需要继续执行]' : '';
          return `命令: ${cmd}\n退出码: 0\n${out}${truncated}`;
        }
        const killedNote = d.killed ? '\n⚠️ 命令因超时被终止。如果需要继续，请用更大的timeout值重新执行。' : '';
        return `命令: ${cmd}\n失败: ${d.error || '未知错误'}\n${d.stdout || ''}\n${d.stderr || ''}${killedNote}`;
      } catch (e) { return `exec 请求失败: ${e.message}`; }
    }
    default:
      return '未知工具: ' + name;
  }
}

// ===== Multi-Provider API Adapters =====
function detectProvider(baseUrl) {
  const u = (baseUrl || '').toLowerCase();
  if (u.includes('anthropic.com')) return 'claude';
  if (u.includes('googleapis.com') || u.includes('generativelanguage')) return 'gemini';
  return 'openai';
}

// Claude: convert OpenAI messages to Anthropic format
function toClaudeMessages(messages) {
  let system = '';
  const claudeMsgs = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + (typeof m.content === 'string' ? m.content : m.content.map(c => c.text || '').join(''));
      continue;
    }
    let content = m.content;
    if (Array.isArray(content)) {
      const blocks = [];
      for (const part of content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image_url') {
          const img = part.image_url.url;
          const [header, data] = img.split(',');
          const mediaType = (header.match(/data:(.+);base64/) || ['', 'image/jpeg'])[1];
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
        }
      }
      content = blocks;
    }
    claudeMsgs.push({ role: m.role, content });
  }
  return { system: system || undefined, messages: claudeMsgs };
}

function toClaudeTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

async function callClaude(apiKey, model, messages, systemPrompt, tools) {
  const { system, messages: cMsgs } = toClaudeMessages(messages);
  const finalSystem = systemPrompt + (system ? '\n' + system : '');

  const body = { model, max_tokens: 8192, messages: cMsgs };
  if (finalSystem) body.system = finalSystem;
  if (tools) body.tools = toClaudeTools(tools);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Claude ' + r.status + ': ' + e.slice(0, 300)); }
  return r.json();
}

function toGeminiContents(messages, systemPrompt) {
  const contents = [];
  let sysInstr = systemPrompt || '';
  for (const m of messages) {
    if (m.role === 'system') {
      sysInstr += '\n' + (typeof m.content === 'string' ? m.content : '');
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts = [];
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') parts.push({ text: part.text });
        else if (part.type === 'image_url') {
          const img = part.image_url.url;
          const [header, data] = img.split(',');
          const mimeType = (header.match(/data:(.+);base64/) || ['', 'image/jpeg'])[1];
          parts.push({ inline_data: { mime_type: mimeType, data } });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return { contents, systemInstruction: sysInstr ? { parts: [{ text: sysInstr }] } : undefined };
}

function toGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;
  return [{ functionDeclarations: tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  })) }];
}

async function callGemini(apiKey, model, messages, systemPrompt, tools) {
  const { contents, systemInstruction } = toGeminiContents(messages, systemPrompt);
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (tools) body.tools = toGeminiTools(tools);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Gemini ' + r.status + ': ' + e.slice(0, 300)); }
  return r.json();
}

function parseClaudeResponse(data) {
  const textParts = [];
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') textParts.push(block.text);
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) }
      });
    }
  }
  return { content: textParts.join(''), tool_calls: toolCalls.length ? toolCalls : undefined };
}

function parseGeminiResponse(data) {
  const candidates = data.candidates || [];
  const textParts = [];
  const toolCalls = [];
  for (const c of candidates) {
    for (const part of c.content?.parts || []) {
      if (part.text) textParts.push(part.text);
      else if (part.functionCall) {
        toolCalls.push({
          id: 'gc_' + Math.random().toString(36).slice(2, 6),
          type: 'function',
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
        });
      }
    }
  }
  return { content: textParts.join(''), tool_calls: toolCalls.length ? toolCalls : undefined };
}

// ===== Self-Verification & Code Review =====
async function checkCompleteness(provider, apiKey, model, apiUrl, userQuery, aiResponse, toolSummary) {
  const prompt = `你的唯一任务是判断：以下AI回复是否**真正完成了用户的所有要求**？

用户原始要求: ${userQuery.slice(0, 500)}
${toolSummary ? '已执行的工具: ' + toolSummary.slice(0, 800) : '(未使用工具)'}
AI的回复: ${aiResponse.slice(0, 1500)}

严格判断标准：
- 如果用户要求创建项目/文件/代码，AI是否真的创建了？回复中说"已创建"但实际没执行写文件工具 = 未完成
- 如果用户要求多个步骤，所有步骤是否都完成了？
- 如果AI的回复主要是"我会..."/"让我..."等计划性内容，没有任何实质性结果 = 未完成
- 如果AI回复很短（<100字）且之前调用了工具，可能还有后续工作 = 未完成

只回复一个JSON: {"complete": true/false, "reason": "简要说明"}`;

  try {
    const msgs = [{ role: 'user', content: prompt }];
    let text = '';
    if (provider === 'claude') {
      const d = await callClaude(apiKey, model, msgs, '', null);
      text = parseClaudeResponse(d).content || '';
    } else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else {
      const r = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model, messages: msgs, stream: false, max_tokens: 512, temperature: 0 }),
        signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const j = await r.json();
        text = j.choices?.[0]?.message?.content || '';
      }
    }
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const j = JSON.parse(m[0]);
        if (!j.complete) { console.log('[check] Incomplete:', j.reason); return j.reason || '任务未完成'; }
      }
    } catch {}
    // Fallback: if text contains keywords suggesting incomplete
    if (/未完|还需|还要|尚未|没完成|不全|缺少|遗漏|missing|incomplete|未完成/.test(text)) {
      return text.slice(0, 200);
    }
    return null;
  } catch (e) { console.log('[check] Error:', e.message); return null; }
}

async function selfVerify(provider, apiKey, model, apiUrl, userQuery, aiResponse, toolResults) {
  if (!aiResponse || aiResponse.length < 50) return null;
  const checkPrompt = `你是事实核查员。检查以下AI回复是否有编造或幻觉。

用户问题: ${userQuery.slice(0, 200)}
工具数据: ${(toolResults || '').slice(0, 1000)}
AI回复: ${aiResponse.slice(0, 2000)}

判断: 回复中的事实是否与工具数据一致？有没有编造的数字、日期？回复"通过"或"有问题: <具体指出>"。`;

  try {
    const msgs = [{ role: 'user', content: checkPrompt }];
    let text = '';
    if (provider === 'claude') {
      const d = await callClaude(apiKey, model, msgs, '', null);
      text = parseClaudeResponse(d).content || '';
    } else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else {
      const r = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model, messages: msgs, stream: false, max_tokens: 1024 }),
        signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const j = await r.json();
        text = j.choices?.[0]?.message?.content || '';
      }
    }
    if (text.includes('有问题')) return text;
    return null;
  } catch (e) { return null; }
}

async function codeReview(provider, apiKey, model, apiUrl, aiResponse) {
  const codeBlocks = aiResponse.match(/```[\s\S]*?```/g);
  if (!codeBlocks || !codeBlocks.length) return null;

  const reviewPrompt = `审查以下代码，找出Bug、安全漏洞、效率问题。简洁指出，用中文。如果没有问题说"通过"。

${codeBlocks.join('\n\n').slice(0, 4000)}`;

  try {
    const msgs = [{ role: 'user', content: reviewPrompt }];
    let text = '';
    if (provider === 'claude') {
      const d = await callClaude(apiKey, model, msgs, '', null);
      text = parseClaudeResponse(d).content || '';
    } else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else {
      const r = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model, messages: msgs, stream: false, max_tokens: 1024 }),
        signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const j = await r.json();
        text = j.choices?.[0]?.message?.content || '';
      }
    }
    if (text && !text.includes('通过')) return text;
    return null;
  } catch (e) { return null; }
}

// ===== Chat API — Native Function Calling + Agentic Loop =====
server.post('/api/chat', async (req, res) => {
  try {
    const { base_url, api_key, model, messages, system_prompt, stream } = req.body;
    if (!base_url || !api_key || !model || !messages) return res.status(400).json({ error: 'Missing' });
    const useSSE = !!stream;
    if (useSSE) {
      req.setTimeout(1800000); // 30min for long agentic tasks (up to 100 rounds)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
    }
    function sse(data) { if (useSSE) res.write('data: ' + JSON.stringify(data) + '\n\n'); }
    const apiUrl = base_url.replace(/\/+$/, '') + '/chat/completions';

    const lu = [...messages].reverse().find(m => m.role === 'user');
    const userQuery = lu ? lu.content : '';

    const ctx = buildContext(userQuery, null, messages);

    // Vision Router: if image attached but model doesn't support vision
    const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    let visionDescription = '';
    if (hasImage) {
      const visionModel = req.body.vision_model || '';
      const visionKey = req.body.vision_key || api_key;
      const visionUrl = req.body.vision_url || base_url;

      if (visionModel || model.includes('gpt-4o') || model.includes('claude') || model.includes('gemini') || model.includes('vision') || model.includes('vl')) {
        try {
          console.log('[vision] Analyzing image with model:', visionModel || model);
          const visionMsgs = messages.filter(m => Array.isArray(m.content)).map(m => ({
            role: 'user',
            content: [{ type: 'text', text: '请详细描述这张图片的内容。如果包含文字，逐字抄录。如果包含界面，描述布局和元素。如果包含代码/报错，抄录完整内容。只输出描述，不要给建议或回答。' }, ...m.content.filter(p => p.type === 'image_url')]
          }));

          const vProvider = detectProvider(visionUrl || base_url);
          let vText = '';
          if (vProvider === 'claude') {
            const d = await callClaude(visionKey || api_key, visionModel || 'claude-sonnet-4-6', [{ role: 'system', content: 'You are an image describer. Describe images in detail in Chinese.' }, ...visionMsgs], '', null);
            vText = parseClaudeResponse(d).content || '';
          } else if (vProvider === 'gemini') {
            const d = await callGemini(visionKey || api_key, visionModel || 'gemini-2.5-flash', visionMsgs, 'Describe this image in Chinese.', null);
            vText = parseGeminiResponse(d).content || '';
          } else {
            const vr = await fetch((visionUrl || base_url).replace(/\/+$/, '') + '/chat/completions', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (visionKey || api_key) },
              body: JSON.stringify({ model: visionModel || 'gpt-4o', messages: visionMsgs, stream: false, max_tokens: 1024 }),
              signal: AbortSignal.timeout(60000)
            });
            if (vr.ok) { const vj = await vr.json(); vText = vj.choices?.[0]?.message?.content || ''; }
          }
          if (vText) {
            visionDescription = vText;
            console.log('[vision] Got description:', vText.slice(0, 100));
          }
        } catch (e) { console.log('[vision] Failed:', e.message); }
      }
    }

    // Normalize messages, replacing images with vision description
    const normMsgs = messages.map(m => {
      if (Array.isArray(m.content)) {
        let text = '';
        let hasImg = false;
        for (const p of m.content) {
          if (p.type === 'text') text += p.text + ' ';
          else if (p.type === 'image_url') hasImg = true;
        }
        if (hasImg && visionDescription) {
          return { role: m.role, content: text.trim() + '\n\n[图片描述: ' + visionDescription + ']' };
        }
        if (hasImg && !visionDescription) {
          return { role: m.role, content: text.trim() + '\n\n[用户附带了图片，但当前模型不支持视觉，图片已忽略]' };
        }
        return { role: m.role, content: text.trim() };
      }
      return { role: m.role, content: m.content };
    });

    let ml = [{ role: 'system', content: ctx.systemPrompt }, ...normMsgs];

    const provider = detectProvider(base_url);
    const MAX_ROUNDS = 15;
    const MAX_AUTO_CONTINUE = 100;
    let allToolCalls = [];
    let allFinalTexts = [];
    let finalText = '';
    sse({ type: 'status', text: '开始分析...' });

    // Outer auto-continue loop
    for (let autoRound = 0; autoRound < MAX_AUTO_CONTINUE; autoRound++) {
      let gotToolCalls = false;
      let roundText = '';

      // Inner agentic loop: AI calls tools until ready to respond
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let msg = {};

        try {
          if (provider === 'claude') {
            const data = await callClaude(api_key, model, ml, ctx.systemPrompt, TOOLS);
            msg = parseClaudeResponse(data);
          } else if (provider === 'gemini') {
            const data = await callGemini(api_key, model, ml, ctx.systemPrompt, TOOLS);
            msg = parseGeminiResponse(data);
          } else {
            const body = { model, messages: ml, stream: false, max_tokens: 8192 };
            body.tools = TOOLS; body.tool_choice = 'auto';
            const ac = new AbortController();
            const tm = setTimeout(() => ac.abort('timeout'), 300000);
            const r = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key },
              body: JSON.stringify(body),
              signal: ac.signal
            });
            clearTimeout(tm);
            if (!r.ok) { const e = await r.text(); return res.status(502).json({ error: 'API ' + r.status + ': ' + e.slice(0, 300) }); }
            const raw = await r.text();
            if (raw.trim().startsWith('data: ')) {
              let text = '';
              for (const l of raw.split('\n')) { if (!l.startsWith('data: ')) continue; const d = l.slice(6).trim(); if (d === '[DONE]') continue; try { text += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch {} }
              msg = { content: text };
            } else { try { msg = JSON.parse(raw).choices?.[0]?.message || {}; } catch {} }
          }
        } catch (e) { return res.status(502).json({ error: e.message }); }

        // No tool calls = final answer
        if (!msg.tool_calls || !msg.tool_calls.length) {
          roundText = msg.content || '';
          break;
        }

        gotToolCalls = true;
        console.log(`[agent] Round ${round + 1}: ${msg.tool_calls.map(t => t.function.name).join(', ')}`);

        // Execute all tool calls in PARALLEL
        const execPromises = msg.tool_calls.map(async tc => {
          const fn = tc.function;
          let args = {};
          try { args = JSON.parse(fn.arguments || '{}'); } catch {}
          const result = await executeTool(fn.name, args);
          return { id: tc.id, name: fn.name, args, result };
        });
        const results = await Promise.all(execPromises);
        for (const r of results) {
          allToolCalls.push({ tool: r.name, arg: JSON.stringify(r.args).slice(0, 100), result: r.result.slice(0, 500) });
          sse({ type: 'tool', name: r.name, args: JSON.stringify(r.args).slice(0, 100), result: r.result.slice(0, 200) });
        }

        // Append tool results (provider-specific format)
        if (provider === 'claude') {
          ml.push({ role: 'assistant', content: msg.tool_calls.map(tc => ({
            type: 'tool_use', id: tc.id, name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
          })) });
          ml.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.result })) });
        } else if (provider === 'gemini') {
          const lastIdx = ml.length - 1;
          const newParts = [];
          for (const r of results) {
            newParts.push({ functionResponse: { name: r.name, response: { result: r.result } } });
          }
          ml.push({ role: 'user', parts: newParts });
        } else {
          ml.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
          ml.push(...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.result })));
        }
      }

      if (!roundText) roundText = '(系统未生成回复)';
      allFinalTexts.push(roundText);
      finalText = roundText;

      // ── Auto-continue decision ──
      // Rule 1: Tools were called → ALWAYS continue (AI had work to do)
      // Rule 2: Tools called + short response → definitely more work
      // Rule 3: Model-based completeness check (last resort)
      let needsMore = false;
      let forceContinueReason = '';

      if (gotToolCalls) {
        // If AI used tools this round, it HAD work. Always continue.
        needsMore = true;
        forceContinueReason = '工具调用后需继续';
      }

      // If we're still not sure, run completeness check
      if (!needsMore && autoRound > 0) {
        // AI stopped calling tools and thinks it's done — verify
        const toolSummary = allToolCalls.map(t => t.tool + ':' + t.result.slice(0, 200)).join(' | ');
        const incomplete = await checkCompleteness(provider, api_key, model, apiUrl, userQuery, roundText, toolSummary);
        if (incomplete) {
          needsMore = true;
          forceContinueReason = '完整性检查未通过: ' + incomplete.slice(0, 100);
          console.log('[auto] Completeness check failed, forcing continue:', incomplete.slice(0, 150));
        }
      }

      // Multi-step task detection (backup for first round where completeness check is skipped)
      if (!needsMore && autoRound === 0 && userQuery && userQuery.length > 20) {
        const multiStepRe = [
          /安装.*[并和]|部署.*[并和]|创建.*[并和]|搭建.*[并和]|配置.*[并和]|下载.*[并和]|编译.*[并和]|构建.*[并和]/,
          /先.*然后|先.*再|首先.*然后|第一步.*第二步/,
          /完整|全套|整个|全部|所有|帮我[做搞].*项目/,
          /生成.*项目|创建.*项目|初始化.*项目/,
          /自动化|自动部署|一键|批量/,
          /扫描|检查|审查|审计|排查|巡检|分析|修复|优化|重构/,
        ];
        if (gotToolCalls && roundText && roundText.length < 200) {
          needsMore = true;
          forceContinueReason = '工具调用后回复过短(<200字)';
        } else {
          for (const re of multiStepRe) {
            if (re.test(userQuery)) { needsMore = true; forceContinueReason = '多步骤任务'; console.log('[auto] Multi-step task detected'); break; }
          }
        }
      }

      if (autoRound < MAX_AUTO_CONTINUE - 1 && needsMore) {
        console.log('[auto] Round ' + (autoRound + 1) + ' → continue (' + forceContinueReason + ')');
        sse({ type: 'auto_continue', round: autoRound + 2, total: MAX_AUTO_CONTINUE });
        const continueMsg = forceContinueReason.includes('完整性')
          ? `[系统自动继续] ⚠️ 你的任务尚未完成！原因: ${forceContinueReason}。请立即继续执行未完成的工作步骤，不要发送结束语。直接调用工具做事。`
          : '[系统自动继续] ⚠️ 任务未完成，禁止发送最终回复！直接调用工具继续工作，不要写总结、不要道歉、不要解释为什么停。';
        ml.push({ role: 'user', content: continueMsg });
        continue;
      }
      break;
    }

    if (!finalText) finalText = '(系统未生成回复)';

    // Self-verification
    if (finalText.length > 100) {
      const toolSummary = allToolCalls.map(t => t.result).join(' | ').slice(0, 2000);
      const issue = await selfVerify(provider, api_key, model, apiUrl, userQuery, finalText, toolSummary);
      if (issue) {
        console.log('[verify] Issue found, forcing re-answer:', issue.slice(0, 150));
        ml.push({ role: 'user', content: `[系统核查] 你的上一条回复存在以下问题:\n${issue}\n\n请根据工具数据修正你的回答。只输出修正后的内容，不要道歉。` });
        try {
          if (provider === 'claude') {
            const d = await callClaude(api_key, model, ml, ctx.systemPrompt, null);
            finalText = parseClaudeResponse(d).content || finalText;
          } else if (provider === 'gemini') {
            const d = await callGemini(api_key, model, ml, ctx.systemPrompt, null);
            finalText = parseGeminiResponse(d).content || finalText;
          } else {
            const fixR = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key },
              body: JSON.stringify({ model, messages: ml, stream: false, max_tokens: 8192 }),
              signal: AbortSignal.timeout(120000) });
            if (fixR.ok) { const fj = await fixR.json(); finalText = fj.choices?.[0]?.message?.content || finalText; }
          }
        } catch (e) { console.log('[verify] Fix failed:', e.message); }
      }
    }

    // Code review
    if (finalText.includes('```')) {
      const crIssues = await codeReview(provider, api_key, model, apiUrl, finalText);
      if (crIssues) {
        finalText = `> 🔳 代码审查:\n> ${crIssues.replace(/\n/g, '\n> ')}\n\n${finalText}`;
      }
    }

    // Auto-learn from conversation
    if (autoLearnRunning && userQuery.length > 10 && finalText.length > 20) {
      fetch('http://localhost:' + PORT + '/api/learn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: userQuery, aiResponse: finalText }),
        signal: AbortSignal.timeout(30000)
      }).then(r => r.json()).then(d => {
        if (d.ok && d.learned.length) logActivity('learn', '学到: ' + d.topics.slice(0, 3).join(', '), 'discovery');
      }).catch(e => {});
    }

    // Auto-save important memories
    if (userQuery.length > 30 && finalText.length > 100 && /(记住|别忘了|重要|项目|要做|计划|决定|以后|每次|总是|永远|不再)/.test(userQuery)) {
      try {
        const name = userQuery.slice(0, 40).replace(/[^a-z0-9一-鿿]/gi, '-').replace(/-+/g, '-').toLowerCase();
        saveMemory(name, userQuery.slice(0, 60), '用户: ' + userQuery + '\n\nHamdean: ' + finalText.slice(0, 1000), 'project');
      } catch {}
    }

    const resp = { type: 'done', content: finalText, context: { memories: ctx.memories, knowledge: ctx.knowledgeEntries } };
    if (allToolCalls.length) resp.tools = allToolCalls;
    if (useSSE) { sse(resp); res.end(); }
    else { delete resp.type; res.json(resp); }
  } catch (err) {
    console.error('[chat]', err.message);
    if (res.headersSent) { try { res.write('data: ' + JSON.stringify({ type: 'error', error: err.message }) + '\n\n'); res.end(); } catch {} }
    else { try { res.status(500).json({ error: err.message }); } catch {} }
  }
});

server.get('/api/status', (req, res) => res.json({ ok: true }));

// SMTP diagnostic endpoint

// ===== Electron =====
let mw, tray;
function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYiGBMDAwMDIwMTLgFGRj+M8BJDGog2AEwQUDCXMmBAQAkGgHhGVb80wAAAABJRU5ErkJggg==');
  tray = new Tray(icon);
  tray.setToolTip('Hamdean');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Hamdean', click: () => { mw?.show(); mw?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { mw?.show(); mw?.focus(); });
}

function cw() {
  mw = new BrowserWindow({
    width: 1100, height: 750, minWidth: 600, minHeight: 400,
    backgroundColor: '#0f0f13', title: 'Hamdean', frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mw.webContents.on('context-menu', (e, p) => {
    const i = [];
    if (p.isEditable) { i.push({ label: 'Paste', role: 'paste' }, { label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy' }); }
    else if (p.selectionText) i.push({ label: 'Copy', role: 'copy' });
    i.push({ label: 'Select All', role: 'selectAll' });
    if (i.length) Menu.buildFromTemplate(i).popup({ window: mw });
  });
  mw.loadURL('http://localhost:' + PORT);
  mw.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mw.hide(); }
  });
}

ipcMain.handle('win-min', () => mw?.minimize());
ipcMain.handle('win-max', () => { mw?.isMaximized() ? mw.unmaximize() : mw?.maximize(); });
ipcMain.handle('win-close', () => { app.isQuitting = true; mw?.close(); });
ipcMain.handle('win-ismax', () => mw?.isMaximized() ?? false);

// Auto-updater
autoUpdater.autoDownload = false;
autoUpdater.setFeedURL("https://47.93.39.27/download/");
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

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Hamdean http://localhost:' + PORT);
    createTray();
    cw();
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
  });
});
app.on('window-all-closed', () => { if (!app.isQuitting) return; app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; });
