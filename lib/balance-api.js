/**
 * 多平台余额：把「当前会话用的模型/provider」映射到「该平台的余额接口 + 响应解析」。
 *
 * 只收录**已核实过官方文档**的平台；每家的端点、鉴权、返回字段都写在注释里，方便日后复核。
 * 本模块只做纯逻辑（选适配器、拼请求、解析响应），真正发请求由 index.js 负责 —— 这样能单测。
 *
 * 核实时间：2026-09。未核实到的平台宁可不写，也不猜端点。
 */

/* 余额响应统一成这个形状：
 *   { currency: 'CNY' | 'USD' | ..., total: '12.34', parts: [{ label, amount }] }
 * currency 缺失时由调用方按站点/域名推断；parts 用来填气泡里的构成行（充值 / 赠金等）。 */

const adapters = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    /* 核实：GET https://api.deepseek.com/user/balance，Authorization: Bearer <key>
       响应 { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] } */
    keys: ['deepseek', 'deepseek-official'],
    refs: ['DEEPSEEK_API_KEY', 'deepseek-official', 'deepseek'],
    request: (key) => ({
      url: 'https://api.deepseek.com/user/balance',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : [];
      if (infos.length === 0) return null;
      const one = infos[0];
      const total = typeof one.total_balance === 'string' ? one.total_balance : null;
      if (total === null || total.length === 0) return null;
      const parts = [];
      if (typeof one.topped_up_balance === 'string') parts.push({ label: 'toppedUp', amount: one.topped_up_balance });
      if (typeof one.granted_balance === 'string') parts.push({ label: 'granted', amount: one.granted_balance });
      return { currency: typeof one.currency === 'string' ? one.currency : 'CNY', total, parts };
    }
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    /* 核实：GET https://openrouter.ai/api/v1/credits，Authorization: Bearer <key>
       响应 { data: { total_credits, total_usage } }，可用额度 = total_credits - total_usage */
    keys: ['openrouter'],
    refs: ['OPENROUTER_API_KEY'],
    request: (key) => ({
      url: 'https://openrouter.ai/api/v1/credits',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      const inner = data && data.data ? data.data : null;
      if (inner === null) return null;
      const total = Number(inner.total_credits);
      const used = Number(inner.total_usage);
      if (Number.isFinite(total) !== true) return null;
      const left = total - (Number.isFinite(used) ? used : 0);
      return {
        currency: 'USD',
        total: left.toFixed(2),
        parts: [
          { label: 'toppedUp', amount: total.toFixed(2) },
          { label: 'used', amount: (Number.isFinite(used) ? used : 0).toFixed(2) }
        ]
      };
    }
  },
  {
    id: 'bai',
    label: 'B.AI',
    /* 核实：文档 docs.b.ai/llmservice/api/balance/ 给出 GET /v1/balance，
       鉴权 Authorization: Bearer <api_key>，响应含 balance 字段。
       注：文档站是 docs.b.ai，API 域名按 api.b.ai 拼接，未经真实调用验证。 */
    keys: ['b-ai', 'bai', 'b.ai'],
    refs: ['B_AI_API_KEY', 'BAI_API_KEY'],
    request: (key) => ({
      url: 'https://api.b.ai/v1/balance',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      const raw = data && (data.balance ?? (data.data ? data.data.balance : undefined));
      if (raw === undefined || raw === null) return null;
      const total = String(raw);
      if (total.length === 0) return null;
      return { currency: 'CNY', total, parts: [] };
    }
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    /* 核实：GET https://api.siliconflow.com/v1/user/info（国内站 api.siliconflow.cn），
       Authorization: Bearer <key>；响应 data.{balance, chargeBalance, totalBalance}（均为字符串）。
       官方未声明币种，国际站按 USD、国内站按 CNY 处理。 */
    keys: ['siliconflow'],
    refs: ['SILICONFLOW_API_KEY'],
    request: (key, base) => ({
      url: (base || 'https://api.siliconflow.com') + '/v1/user/info',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      const inner = data && data.data ? data.data : null;
      if (inner === null) return null;
      const total = typeof inner.totalBalance === 'string' ? inner.totalBalance : null;
      if (total === null || total.length === 0) return null;
      const parts = [];
      if (typeof inner.chargeBalance === 'string') parts.push({ label: 'toppedUp', amount: inner.chargeBalance });
      if (typeof inner.balance === 'string') parts.push({ label: 'granted', amount: inner.balance });
      return { currency: 'USD', total, parts };
    }
  },
  {
    id: 'moonshot',
    label: 'Kimi',
    /* 核实：GET https://api.moonshot.ai/v1/users/me/balance（国内站 api.moonshot.cn），
       Authorization: Bearer <key>；响应 { code, data: { available_balance, voucher_balance, cash_balance } }。
       两站的 key 不通用，单位也不同：国际站 USD、国内站 CNY。 */
    keys: ['moonshot', 'kimi'],
    refs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    request: (key, base) => ({
      url: (base || 'https://api.moonshot.ai') + '/v1/users/me/balance',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      const inner = data && data.data ? data.data : null;
      if (inner === null) return null;
      const total = inner.available_balance;
      if (typeof total !== 'number' || Number.isFinite(total) !== true) return null;
      const parts = [];
      if (typeof inner.cash_balance === 'number') parts.push({ label: 'toppedUp', amount: inner.cash_balance.toFixed(2) });
      if (typeof inner.voucher_balance === 'number') parts.push({ label: 'granted', amount: inner.voucher_balance.toFixed(2) });
      return { currency: 'USD', total: total.toFixed(2), parts };
    }
  },
  {
    id: 'zhipu',
    label: 'GLM 余额',
    /* 来源：cc-switch PR #6978 的自定义模板（截至 2026-09-27 未合并，社区实测方案）
       GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report
       鉴权：Authorization: Bearer <api_key> —— 注意与 coding plan 配额的「裸 key」不同
       响应 { code, msg, data: { availableBalance, balance, rechargeAmount, totalSpendAmount } }
       code === 200 才算成功；可用余额 = availableBalance ?? balance，单位 CNY。 */
    /* 'zai' 是 DSH 里 z.ai（智谱国际站）的 provider 名，模型为 glm-5.3-*（本机会话实测 2026-10-01）；
       模型名本身也含 glm，这里补上 provider 名，免得模型改名后就匹配不到。 */
    keys: ['zhipu', 'glm', 'bigmodel', 'zai'],
    refs: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
    request: (key) => ({
      /* 实测 2026-09-27：open.bigmodel.cn 与 api.z.ai 同后端，两个域名 + Bearer/裸 key 四种组合都返回 code=200 */
      url: 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
    }),
    parse: (data) => {
      if (data === null || data === undefined) return null;
      if (Number(data.code) !== 200) return null;
      const inner = data.data ? data.data : {};
      const raw = inner.availableBalance !== undefined && inner.availableBalance !== null ? inner.availableBalance : inner.balance;
      const remaining = Number(raw);
      if (Number.isFinite(remaining) !== true) return null;
      const parts = [];
      const recharge = Number(inner.rechargeAmount);
      const gift = Number(inner.giveAmount);
      const spent = Number(inner.totalSpendAmount);
      if (Number.isFinite(recharge)) parts.push({ label: 'toppedUp', amount: recharge.toFixed(2) });
      if (Number.isFinite(gift)) parts.push({ label: 'granted', amount: gift.toFixed(2) });
      if (Number.isFinite(spent)) parts.push({ label: 'spent', amount: spent.toFixed(2) });
      return { currency: 'CNY', total: remaining.toFixed(2), parts };
    }
  },
  {
    id: 'zhipu-quota',
    label: 'GLM 配额',
    /* 核实：cc-switch v3.20.4 的 src-tauri/src/services/coding_plan.rs:332-346
       GET https://open.bigmodel.cn/api/monitor/usage/quota/limit（国际站 https://api.z.ai）
       鉴权：Authorization: <api_key> —— 智谱**不加 Bearer 前缀**（源码注释两次强调）
       响应 { success, data: { level, limits: [{ type: TOKENS_LIMIT|CREDIT_LIMIT, percentage, ... }] } }
       percentage 就是配额使用率，直接当百分比显示，**不换算金额**。注意这是 coding plan
       配额，不是按量计费的现金余额 —— 现金余额只有控制台接口能给，需要网页登录态。 */
    keys: ['zhipu', 'glm', 'bigmodel'],
    refs: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'BIGMODEL_API_KEY'],
    request: (key, base) => ({
      url: (base || 'https://open.bigmodel.cn') + '/api/monitor/usage/quota/limit',
      headers: {
        authorization: key,
        'content-type': 'application/json',
        'accept-language': 'en-US,en'
      }
    }),
    parse: (data) => {
      if (data === null || data === undefined || data.success === false) return null;
      const inner = data.data ? data.data : null;
      const limits = inner !== null && Array.isArray(inner.limits) ? inner.limits : [];
      let percent = null;
      for (let i = 0; i < limits.length; i += 1) {
        const one = limits[i];
        const kind = typeof one.type === 'string' ? one.type.toUpperCase() : '';
        if (kind !== 'TOKENS_LIMIT' && kind !== 'CREDIT_LIMIT') continue;
        const value = Number(one.percentage);
        if (Number.isFinite(value) !== true) continue;
        /* 取用得最紧的那个窗口，保守一点 */
        if (percent === null || value > percent) percent = value;
      }
      if (percent === null) return null;
      return { currency: '', total: percent.toFixed(2) + '%', parts: [], isPercent: true };
    }
  }
];

/** 会话线索（provider + 模型名）里出现这些词就认为是哪一家。 */
function adapterFor(provider, model) {
  const text = (String(provider === undefined || provider === null ? '' : provider) + ' '
    + String(model === undefined || model === null ? '' : model)).toLowerCase();
  if (text.trim().length === 0) return null;
  for (let i = 0; i < adapters.length; i += 1) {
    const one = adapters[i];
    for (let k = 0; k < one.keys.length; k += 1) {
      if (text.includes(one.keys[k])) return one;
    }
  }
  return null;
}

/** 会话模型属于 DeepSeek 时，优先走官方账号通道（账号登录没有 API key 也能查）。 */
function isDeepSeek(provider, model) {
  const text = (String(provider === undefined || provider === null ? '' : provider) + ' '
    + String(model === undefined || model === null ? '' : model)).toLowerCase();
  return text.includes('deepseek');
}

export { adapters, adapterFor, isDeepSeek };
