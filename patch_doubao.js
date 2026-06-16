// Hamdean Doubao Vision Patch — 豆包视觉模型接入
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, 'main.js');
const original = fs.readFileSync(MAIN, 'utf-8');
let content = original;
let changes = 0;

// ====== 1. detectProvider: add doubao ======
const oldDetect = `function detectProvider(baseUrl) {
  const u = (baseUrl || '').toLowerCase();
  if (u.includes('anthropic.com')) return 'claude';
  if (u.includes('googleapis.com') || u.includes('generativelanguage')) return 'gemini';
  return 'openai';
}`;

const newDetect = `function detectProvider(baseUrl) {
  const u = (baseUrl || '').toLowerCase();
  if (u.includes('anthropic.com')) return 'claude';
  if (u.includes('googleapis.com') || u.includes('generativelanguage')) return 'gemini';
  if (u.includes('volces.com') || u.includes('ark.cn')) return 'doubao';
  return 'openai';
}`;

if (content.includes(oldDetect)) {
  content = content.replace(oldDetect, newDetect);
  changes++;
  console.log('[√] 1: detectProvider 已添加 doubao');
} else {
  console.log('[×] 1: detectProvider 锚点未匹配');
}

// ====== 2. parseDoubaoResponse (OpenAI compatible) ======
const oldParseGemini = `function parseGeminiResponse(data) {`;
const doubaoParser = `
// Doubao: OpenAI-compatible response parser
function parseDoubaoResponse(data) {
  const text = data.choices?.[0]?.message?.content || '';
  const toolCalls = data.choices?.[0]?.message?.tool_calls || [];
  return {
    content: text,
    tool_calls: toolCalls.length ? toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments }
    })) : undefined
  };
}

`;

if (content.includes(oldParseGemini) && !content.includes('parseDoubaoResponse')) {
  content = content.replace(oldParseGemini, doubaoParser + oldParseGemini);
  changes++;
  console.log('[√] 2: parseDoubaoResponse 已添加');
} else {
  console.log('[×] 2: parseDoubaoResponse 跳过');
}

// ====== 3. callDoubao function ======
const oldCallGeminiFn = `async function callGemini(apiKey, model, messages, systemPrompt, tools) {`;
const callDoubaoFn = `
// Doubao (Ark / Volces): OpenAI-compatible API
async function callDoubao(apiKey, model, messages, systemPrompt, tools) {
  const apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  const sysMsg = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  const body = {
    model,
    messages: [...sysMsg, ...messages],
    max_tokens: 8192,
    stream: false
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Doubao ' + r.status + ': ' + e.slice(0, 300)); }
  return r.json();
}

`;

if (content.includes(oldCallGeminiFn) && !content.includes('callDoubao')) {
  content = content.replace(oldCallGeminiFn, callDoubaoFn + oldCallGeminiFn);
  changes++;
  console.log('[√] 3: callDoubao 已添加');
} else {
  console.log('[×] 3: callDoubao 跳过');
}

// ====== 4. Vision Router: add doubao vision ======
const oldVisionElse = `          } else {
            const vr = await fetch((visionUrl || base_url).replace(/\\/+$/, '') + '/chat/completions', {`;

if (content.includes(oldVisionElse) && !content.includes("vProvider === 'doubao'")) {
  const doubaoVisionBlock = `          } else if (vProvider === 'doubao') {
            const d = await callDoubao(visionKey || api_key, visionModel || 'doubao-seed-2-0-lite-260428', [{ role: 'system', content: 'You are an image describer. Describe images in detail in Chinese.' }, ...visionMsgs], '', null);
            vText = parseDoubaoResponse(d).content || '';
          } else {
            const vr = await fetch((visionUrl || base_url).replace(/\\/+$/, '') + '/chat/completions', {`;

  content = content.replace(oldVisionElse, doubaoVisionBlock);
  changes++;
  console.log('[√] 4: Vision Router 已添加 doubao');
} else {
  console.log('[×] 4: Vision Router 跳过');
}

// ====== 5. Chat flow: add doubao handler ======
const oldChatGemini = `          } else if (provider === 'gemini') {
            const data = await callGemini(api_key, model, ml, ctx.systemPrompt, TOOLS);
            msg = parseGeminiResponse(data);
          } else {`;

if (content.includes(oldChatGemini) && !content.includes("provider === 'doubao'")) {
  const doubaoChatBlock = `          } else if (provider === 'gemini') {
            const data = await callGemini(api_key, model, ml, ctx.systemPrompt, TOOLS);
            msg = parseGeminiResponse(data);
          } else if (provider === 'doubao') {
            const data = await callDoubao(api_key, model, ml, ctx.systemPrompt, TOOLS);
            msg = parseDoubaoResponse(data);
          } else {`;

  content = content.replace(oldChatGemini, doubaoChatBlock);
  changes++;
  console.log('[√] 5: Chat flow 已添加 doubao');
} else {
  console.log('[×] 5: Chat flow 跳过');
}

// ====== 6. Tool results append: add doubao (same as OpenAI format) ======
const oldToolGemini = `        } else if (provider === 'gemini') {
          const lastIdx = ml.length - 1;
          const newParts = [];
          for (const r of results) {
            newParts.push({ functionResponse: { name: r.name, response: { result: r.result } } });
          }
          ml.push({ role: 'user', parts: newParts });
        } else {`;

if (content.includes(oldToolGemini) && !content.includes("provider === 'doubao'")) {
  const doubaoToolBlock = `        } else if (provider === 'gemini') {
          const lastIdx = ml.length - 1;
          const newParts = [];
          for (const r of results) {
            newParts.push({ functionResponse: { name: r.name, response: { result: r.result } } });
          }
          ml.push({ role: 'user', parts: newParts });
        } else if (provider === 'doubao') {
          // Doubao uses OpenAI format
          ml.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
          ml.push(...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.result })));
        } else {`;

  content = content.replace(oldToolGemini, doubaoToolBlock);
  changes++;
  console.log('[√] 6: Tool results 已添加 doubao (OpenAI format)');
} else {
  console.log('[×] 6: Tool results 跳过');
}

// ====== 7. checkCompleteness: add doubao ======
const oldCheckGemini = `    } else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else {`;

if (content.includes(oldCheckGemini) && !content.includes("provider === 'doubao'")) {
  const doubaoCheckBlock = `    } else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else if (provider === 'doubao') {
      const d = await callDoubao(apiKey, model, msgs, '', null);
      text = parseDoubaoResponse(d).content || '';
    } else {`;

  // This pattern appears 3 times (checkCompleteness, selfVerify, codeReview)
  // Use regex with g flag to replace all occurrences
  const beforeCount = (content.match(/\} else if \(provider === 'gemini'\) \{/g) || []).length;
  content = content.replace(/\} else if \(provider === 'gemini'\) \{/g, '} else if (provider === \'gemini\') {');
  
  let replaceCount = 0;
  content = content.replace(
    /} else if \(provider === 'gemini'\) \{\s+const d = await callGemini\(apiKey, model, msgs, '', null\);\s+text = parseGeminiResponse\(d\)\.content \|\| '';\s+\} else \{/g,
    (match) => {
      replaceCount++;
      return `} else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else if (provider === 'doubao') {
      const d = await callDoubao(apiKey, model, msgs, '', null);
      text = parseDoubaoResponse(d).content || '';
    } else {`;
    }
  );
  
  // Alternative: try exact string replacement for each occurrence
  if (replaceCount === 0) {
    // Try the original oldCheckGemini pattern
    const re = /\} else if \(provider === 'gemini'\) \{\s+const d = await callGemini\(apiKey, model, msgs, '', null\);\s+text = parseGeminiResponse\(d\)\.content \|\| '';\s+\} else \{/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      replaceCount++;
    }
    content = content.replace(re, `} else if (provider === 'gemini') {
      const d = await callGemini(apiKey, model, msgs, '', null);
      text = parseGeminiResponse(d).content || '';
    } else if (provider === 'doubao') {
      const d = await callDoubao(apiKey, model, msgs, '', null);
      text = parseDoubaoResponse(d).content || '';
    } else {`);
  }
  
  changes++;
  console.log(`[√] 7: checkCompleteness/selfVerify/codeReview 已添加 doubao (${replaceCount} 处)`);
} else {
  console.log('[×] 7: 验证函数跳过');
}

// ====== 8. Self-verify fix: add doubao ======
const oldSelfFixGemini = `          } else if (provider === 'gemini') {
            const d = await callGemini(api_key, model, ml, ctx.systemPrompt, null);
            finalText = parseGeminiResponse(d).content || finalText;
          } else {`;

if (content.includes(oldSelfFixGemini) && !content.includes("provider === 'doubao' &&")) {
  const doubaoSelfFixBlock = `          } else if (provider === 'gemini') {
            const d = await callGemini(api_key, model, ml, ctx.systemPrompt, null);
            finalText = parseGeminiResponse(d).content || finalText;
          } else if (provider === 'doubao') {
            const d = await callDoubao(api_key, model, ml, ctx.systemPrompt, null);
            finalText = parseDoubaoResponse(d).content || finalText;
          } else {`;

  content = content.replace(oldSelfFixGemini, doubaoSelfFixBlock);
  changes++;
  console.log('[√] 8: selfVerify fix 已添加 doubao');
} else {
  console.log('[×] 8: selfVerify fix 跳过');
}

// ====== 9. Claude tool format: add doubao (same as OpenAI) ======
const oldClaudeTool = `        if (provider === 'claude') {
          ml.push({ role: 'assistant', content: msg.tool_calls.map(tc => ({`;

if (content.includes(oldClaudeTool) && !content.includes("provider === 'doubao'")) {
  const doubaoClaudeToolBlock = `        if (provider === 'claude') {
          ml.push({ role: 'assistant', content: msg.tool_calls.map(tc => ({
            type: 'tool_use', id: tc.id, name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
          })) });
          ml.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.result })) });
        } else if (provider === 'doubao') {
          // Doubao uses OpenAI format
          ml.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
          ml.push(...results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.result })));
        } else if (provider === 'gemini') {
          const lastIdx = ml.length - 1;
          const newParts = [];
          for (const r of results) {
            newParts.push({ functionResponse: { name: r.name, response: { result: r.result } } });
          }
          ml.push({ role: 'user', parts: newParts });
        } else {`;

  content = content.replace(oldClaudeTool, doubaoClaudeToolBlock);
  changes++;
  console.log('[√] 9: Claude tool block 已扩展 doubao');
} else {
  console.log('[×] 9: Claude tool block 跳过');
}

// ====== Save ======
if (changes > 0) {
  // Backup
  fs.writeFileSync(MAIN + '.bak_doubao', original);
  
  // Bump version in package.json
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  pkg.version = '4.0.3';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  
  fs.writeFileSync(MAIN, content);
  console.log(`\n✅ 完成 ${changes}/9 处修改`);
  console.log('   备份: main.js.bak_doubao');
  console.log('   版本: 4.0.2 → 4.0.3');
  console.log('\n⚠️  请重启 Hamdean 使视觉模型生效');
  console.log('   Ark API Key 已内置到 callDoubao 函数');
} else {
  console.log('\n❌ 无修改，可能已打过补丁');
}
