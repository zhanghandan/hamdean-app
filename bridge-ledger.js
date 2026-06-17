// Hamdean-Ledger 互通桥接模块
// 在 Hamdean main.js 中 require 此文件即可注册记账工具

module.exports = function(server) {
  const LEDGER_URL = 'http://localhost:4198';

  // ===== Hamdean 工具注册 =====
  // 以下工具需要手动添加到 main.js 的 executeTool switch 中

  const ledgerTools = {
    // 添加交易
    ledger_add: {
      name: 'ledger_add',
      description: '添加一条记账记录',
      parameters: { type:'object', properties:{ type:{type:'string',enum:['income','expense']}, amount:{type:'number'}, category:{type:'string'}, description:{type:'string'}, source:{type:'string',default:'wechat'} }, required:['type','amount'] },
      handler: async (args) => {
        const res = await fetch(`${LEDGER_URL}/api/transactions`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(args)
        });
        return res.json();
      }
    },

    // 查询交易
    ledger_query: {
      name: 'ledger_query',
      description: '查询记账记录，可按月份、分类筛选',
      parameters: { type:'object', properties:{ month:{type:'string'}, category:{type:'string'}, type:{type:'string'}, limit:{type:'number'} } },
      handler: async (args) => {
        const params = new URLSearchParams(args).toString();
        const res = await fetch(`${LEDGER_URL}/api/transactions?${params}`);
        return res.json();
      }
    },

    // 月度汇总
    ledger_summary: {
      name: 'ledger_summary',
      description: '获取月度收支汇总和分类统计',
      parameters: { type:'object', properties:{ month:{type:'string'} } },
      handler: async (args) => {
        const month = args.month || new Date().toISOString().slice(0,7);
        const res = await fetch(`${LEDGER_URL}/api/summary?month=${month}`);
        return res.json();
      }
    },

    // AI分析
    ledger_analyze: {
      name: 'ledger_analyze',
      description: 'AI智能分析月度财务状况，给出建议',
      parameters: { type:'object', properties:{ month:{type:'string'} } },
      handler: async (args) => {
        const res = await fetch(`${LEDGER_URL}/api/ai/analyze`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({month: args.month})
        });
        return res.json();
      }
    },

    // 微信同步
    ledger_sync_wechat: {
      name: 'ledger_sync_wechat',
      description: '同步微信收付款记录到记账软件',
      parameters: { type:'object', properties:{ transactions:{type:'array'} } },
      handler: async (args) => {
        const res = await fetch(`${LEDGER_URL}/api/transactions/batch`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({transactions: args.transactions})
        });
        return res.json();
      }
    }
  };

  // 健康检查代理
  server.get('/api/ledger/health', async (req, res) => {
    try {
      const resp = await fetch(`${LEDGER_URL}/api/health`);
      const data = await resp.json();
      res.json(data);
    } catch(e) {
      res.json({ ok: false, error: 'Ledger service not running on port 4198' });
    }
  });

  // 代理所有 ledger API
  server.all('/api/ledger/*', async (req, res) => {
    try {
      const targetUrl = `${LEDGER_URL}${req.url.replace('/api/ledger', '/api')}`;
      const resp = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
      });
      const data = await resp.json();
      res.json(data);
    } catch(e) {
      res.json({ ok: false, error: 'Ledger service unavailable' });
    }
  });

  console.log('📒 Hamdeen Ledger 互通桥接已加载');
  console.log('   工具: ledger_add | ledger_query | ledger_summary | ledger_analyze | ledger_sync_wechat');
  console.log('   代理: /api/ledger/* → http://localhost:4198');

  return ledgerTools;
};
