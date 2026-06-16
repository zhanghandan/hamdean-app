// Fix: "Cannot set headers after they are sent" in auth proxy
// Root cause: timeout calls proxyReq.destroy() which triggers error event,
// so both timeout and error handlers try to send response.
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, 'main.js');
let content = fs.readFileSync(MAIN, 'utf-8');
const original = content;

// Fix: add resSent guard to auth proxy
const oldProxy = `server.all('/api/auth/*', (req, res) => {
  const targetUrl = AUTH_SERVER.replace(/\\/+$/, '') + req.originalUrl;`;

const newProxy = `server.all('/api/auth/*', (req, res) => {
  let resSent = false;
  const sendOnce = (status, data) => {
    if (resSent) return;
    resSent = true;
    res.status(status).json(data);
  };
  const targetUrl = AUTH_SERVER.replace(/\\/+$/, '') + req.originalUrl;`;

if (content.includes(oldProxy) && !content.includes('resSent')) {
  content = content.replace(oldProxy, newProxy);

  // Replace res.status(proxyRes.statusCode).json(...) in end handler
  content = content.replace(
    `try {
        res.status(proxyRes.statusCode).json(JSON.parse(data));
      } catch {
        res.status(proxyRes.statusCode).send(data);
      }`,
    `try {
        sendOnce(proxyRes.statusCode, JSON.parse(data));
      } catch {
        if (!resSent) { resSent = true; res.status(proxyRes.statusCode).send(data); }
      }`
  );

  // Replace error handler
  content = content.replace(
    `proxyReq.on('error', (e) => {
    console.error('[AUTH PROXY]', e.message);
    res.status(502).json({ error: 'Auth server unreachable: ' + e.message });
  });`,
    `proxyReq.on('error', (e) => {
    console.error('[AUTH PROXY]', e.message);
    sendOnce(502, { error: 'Auth server unreachable: ' + e.message });
  });`
  );

  // Replace timeout handler
  content = content.replace(
    `proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'Auth server timeout' });
  });`,
    `proxyReq.on('timeout', () => {
    proxyReq.destroy();
    sendOnce(504, { error: 'Auth server timeout' });
  });`
  );

  fs.writeFileSync(MAIN, content);
  console.log('✅ Fixed double-response bug in auth proxy');
  console.log('   Backup: main.js.bak_doubleres');
  fs.writeFileSync(MAIN + '.bak_doubleres', original);
} else if (content.includes('resSent')) {
  console.log('⚠️  Already patched (resSent found)');
} else {
  console.log('❌ Could not find auth proxy code to patch');
}
