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
    /* 它是 `zhipu` 的**第二条独立的路**，不是替代品：两者 keys 完全重叠，而 `adapterFor`
       按数组顺序命中即返回，所以配额这条永远选不中 —— 必须靠 `fallbackOf` 显式挂成
       链上的下一跳（见 adaptersFor），否则 coding plan 用户永远只看到现金余额那条路
       的结果（实测症状：余额显示 ¥- 或 ¥0.00）。 */
    fallbackOf: 'zhipu',
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
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    /* WorkBuddy / WorkBuddy AI 的余额是**积分**，且不在这里查：凭据由 connect 类插件
       解密持有，上游鉴权与计费解析都由它实现，它把结论挂在本机 Web 路由上。
       所以本适配器不发外部请求，只读那条本机路由（local: true），本插件不碰凭据、
       也不重复实现上游协议。
       实测 2026-10-07：国际版路由返回 credits.total = 177。
       实测 2026-10-12：`credits.total` 这个口径在**新旧两个插件上一致**
       （新 dsh-connect-workbuddy 的 /usage 与老 dsh-workbuddy-connect 的 /status
       都是顶层 credits.total），所以解析器一份就够，变的只是**路径**。 */
    local: true,
    keys: ['workbuddy', 'codebuddy'],
    refs: [],
    /* 候选路由**按新旧插件依次尝试**（见 pathsOf）：第一个能解析出结果的胜出。
       为什么不能只留一条：两个插件是不同作者的两套实现，用户可能同时装着、
       也可能只用其中一个（实测本机同时装着，当前生效的是新插件）。
       为什么新插件要带 region：它的路由按区域分账号（cn / global），
       不带参数默认 cn，区域给错会拿到另一个区域的账号余额。 */
    pathsOf: (provider) => {
      const text = String(provider === undefined || provider === null ? '' : provider).toLowerCase()
      /* 国际版：新插件用 region=global，老插件用 /ai/status；
         实测 provider 名有三种形态：workbuddy（国内）、workbuddy-ai、workbuddy-global */
      const global = text.includes('-ai') || text.includes('global')
      const region = global ? 'global' : 'cn'
      return [
        '/plugins/dsh-connect-workbuddy/usage?region=' + region,
        global ? '/plugins/dsh-workbuddy-connect/ai/status' : '/plugins/dsh-workbuddy-connect/status'
      ]
    },
    parse: (data) => {
      const credits = data !== null && data !== undefined && data.credits !== undefined ? data.credits : null;
      if (credits === null) return null;
      const total = Number(credits.total);
      if (Number.isFinite(total) !== true) return null;
      /* 积分不是货币：currency 留空让客户端不拼货币符号；不给 parts，
         气泡因此只显示总数、不列套餐构成。 */
      return { currency: '', total: formatCredits(total), parts: [], isCredits: true };
    }
  }
];

/**
 * 积分数值的显示文本：整数按千分位分组，非整数保留两位小数。
 * 积分不带货币单位，所以这里不拼 ¥ / $（与 formatBalanceAmount 的区别就在这）。
 */
function formatCredits(value) {
  const n = Number(value);
  if (Number.isFinite(n) !== true) return '0';
  const rounded = Number.isInteger(n) ? n : Math.round(n * 100) / 100;
  const text = String(rounded);
  const dot = text.indexOf('.');
  const whole = dot < 0 ? text : text.slice(0, dot);
  const rest = dot < 0 ? '' : text.slice(dot);
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + rest;
}

/**
 * 会话线索 → 平台适配器。
 *
 * **provider 优先于模型名**：先只用 provider 匹配一轮，没命中才把模型名并进来匹配。
 * 为什么必须分两轮：模型名常常带别家厂商的词，混在一起匹配会让会话被认成错的平台 ——
 * 实测 2026-10-07，WorkBuddy AI 会话（provider=workbuddy-ai）跑 deepseek-v4.1-flash-sg，
 * 旧写法把 "deepseek" 从模型名里匹到，于是拿 DeepSeek 的 API key 去问官方余额接口，
 * 稳定拿到 HTTP 401，底栏余额永远是横杠。provider 是会话实际走的计费通道，以它为准。
 */
function adapterFor(provider, model) {
  const providerText = String(provider === undefined || provider === null ? '' : provider).toLowerCase().trim();
  const modelText = String(model === undefined || model === null ? '' : model).toLowerCase().trim();
  const pick = (text) => {
    if (text.length === 0) return null;
    for (let i = 0; i < adapters.length; i += 1) {
      const one = adapters[i];
      for (let k = 0; k < one.keys.length; k += 1) {
        if (text.includes(one.keys[k])) return one;
      }
    }
    return null;
  };
  const byProvider = pick(providerText);
  if (byProvider !== null) return byProvider;
  /* provider 还没上报（或名字认不出）时才退回模型名，保持对自定义 provider 名的兼容 */
  return pick(modelText);
}

/**
 * 会话线索 → **要按顺序依次尝试的适配器链**（第一个是主选，其后是回退）。
 *
 * 为什么需要"链"而不是单个适配器：智谱有两种**互相独立**的计费通道，接口与响应结构
 * 完全不同，而且 keys 完全重叠（都是 zhipu/glm/bigmodel）：
 *   · 按量计费 → `zhipu`（现金余额，控制台接口，Bearer）
 *   · coding plan → `zhipu-quota`（配额百分比，monitor 接口，裸 key）
 * 单选的 `adapterFor` 按数组顺序命中即返回，`zhipu-quota` 永远选不中 —— 于是 coding plan
 * 用户永远拿不到配额，客户端 `isPercent` 分支恒不可达（用户实测：智谱 coding plan 显示"余额 ¥-"）。
 * 用户明确要求**按实际调用的模型/凭据决定显示余额还是配额**，两种是独立的路、不能二选一。
 *
 * 实现就是"两个端点都试、按返回结构决定显示什么"：调用方按这个顺序逐个请求，**第一个
 * 解析出结果的胜出**（余额接口对 coding plan 返回不了 code=200 的余额 → parse 给 null →
 * 自动落到配额；反过来按量计费账号在配额接口上拿不到 limits → 也给 null）。
 * 判定完全交给各家自己的 `parse`（那是已经核实过上游协议的**唯一**权威），不在这里另立规则。
 *
 * 非智谱平台没有 `fallbackOf`，链长恒为 1 —— 行为与旧版逐字节一致。
 */
function adaptersFor(provider, model) {
  const first = adapterFor(provider, model);
  if (first === null) return [];
  const chain = [first];
  /* 跟着 `fallbackOf` 往下走：它的语义是"**我是**某条适配器的后备"
     （`zhipu-quota.fallbackOf === 'zhipu'` = 配额是余额的后备），
     所以这里找的是"谁声明了以当前这条为后备"，而不是当前这条的后备。
     visited 兜住配置写错造成的环（否则会转不出来）。 */
  const visited = new Set([first.id]);
  let current = first;
  for (;;) {
    const next = adapters.filter((one) => one.fallbackOf === current.id && visited.has(one.id) !== true)[0];
    if (next === undefined) break;
    visited.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
}

/* ------------------------------------------------- connect 类插件的通用发现 */

/**
 * 允许探测的**动词白名单**。只探"读余额/状态"这一类，且都是只读语义。
 *
 * 为什么不放开：可行性调研实测到同族插件还有 `refresh` / `probe` / `checkin` /
 * `transfer` / `oauth` / `__save` / `pool` 等路由，其中多数是**写操作**
 * （签到会真的领奖励、probe 会真的花积分、__save 会写配置）。
 * "GET 无副作用"是路由所有者的选择、不是保证 —— 所以这里只列明确只读的三条。
 */
const LOCAL_READONLY_VERBS = ['usage', 'status', 'account-credits'];

/** 永不探测的路径：`/plugins/events` 是 SSE，GET 会挂住不返回（实测 15s 超时）。 */
const LOCAL_NEVER_PROBE = ['/plugins/events'];

/**
 * 从一张路由表（Map）里挑出"形如 `/plugins/<id>/<动词>` 且动词在白名单里"的路径。
 *
 * 只做筛选、不发请求；调用方负责确认可达性。返回按插件 id 去重、保留全部动词候选。
 * `table` 不是 Map（宿主改实现 / 字段被改名）时返回空数组 —— 调用方据此回退声明表。
 */
function pluginRoutesIn(table) {
  const out = [];
  if (table === null || table === undefined || typeof table.forEach !== 'function') return out;
  table.forEach((value, key) => {
    if (typeof key !== 'string') return;
    if (LOCAL_NEVER_PROBE.indexOf(key) >= 0) return;
    const hit = /^\/plugins\/([^/]+)\/([^/]+)$/.exec(key);
    if (hit === null) return;
    if (LOCAL_READONLY_VERBS.indexOf(hit[2]) < 0) return;
    out.push({ pluginId: hit[1], verb: hit[2], path: key });
  });
  return out;
}

/**
 * 本机路由响应 → 余额/配额。**只认明确命名的结构，绝不自由猜字段。**
 *
 * 为什么这条约束是硬性的：可行性调研实测过同族三个插件的返回结构 ——
 *   · workbuddy：顶层 `credits.total` **就是余额**
 *   · qoder    ：`usage.userQuota.total` 是**配额容量**，`remaining` 才是余额（语义正好相反）
 *   · trae     ：同时有 `total` / `available` / `workAvailable`
 * 若写成"找任意名为 total 的数字"，在 qoder 上会稳定显示一个**看起来合理的错数**。
 * 本文件第 253 行那条实测教训（拿错平台的 key 去问余额，稳定 401）与
 * "宁可不显示，也不显示错数"是同一个原则。
 *
 * 抽取器按优先级排列，命中即返回；全部不命中返回 null（调用方显示空）。
 */
const LOCAL_SHAPE_EXTRACTORS = [
  /* workbuddy（新 /usage 与老 /status 都是这个形状）：顶层 credits.total 是余额 */
  (data) => {
    const credits = data !== null && data !== undefined ? data.credits : null;
    if (credits === null || credits === undefined || typeof credits !== 'object') return null;
    const total = Number(credits.total);
    if (Number.isFinite(total) !== true) return null;
    return { currency: '', total: formatCredits(total), parts: [], isCredits: true };
  },
  /* 配额百分比（智谱那条路的形状）：明确带 limits 数组才算，避免把别的 total 当配额 */
  (data) => {
    const inner = data !== null && data !== undefined && data.data !== null && data.data !== undefined
      ? data.data
      : null;
    if (inner === null || inner === undefined || Array.isArray(inner.limits) !== true) return null;
    let percent = null;
    for (let i = 0; i < inner.limits.length; i += 1) {
      const one = inner.limits[i];
      if (one === null || one === undefined) continue;
      const kind = typeof one.type === 'string' ? one.type.toUpperCase() : '';
      if (kind !== 'TOKENS_LIMIT' && kind !== 'CREDIT_LIMIT') continue;
      const value = Number(one.percentage);
      if (Number.isFinite(value) !== true) continue;
      if (percent === null || value > percent) percent = value;
    }
    if (percent === null) return null;
    return { currency: '', total: percent.toFixed(2) + '%', parts: [], isPercent: true };
  }
];

/**
 * 本机路由文档 → 余额。抽取器全部不命中就给 null（**不猜**）。
 * 导出是为了让测试能直接钉住"qoder 那种结构必须给 null"这条防线。
 */
function balanceFromLocalDoc(data) {
  if (data === null || data === undefined || typeof data !== 'object') return null;
  for (let i = 0; i < LOCAL_SHAPE_EXTRACTORS.length; i += 1) {
    const value = LOCAL_SHAPE_EXTRACTORS[i](data);
    if (value !== null) return value;
  }
  return null;
}

export { adapters, adapterFor, adaptersFor, pluginRoutesIn, balanceFromLocalDoc, LOCAL_READONLY_VERBS, LOCAL_NEVER_PROBE };
