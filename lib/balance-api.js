/**
 * 多平台余额：把「当前会话用的模型/provider」映射到「该平台的余额接口 + 响应解析」。
 *
 * 只收录**已核实过官方文档**的平台；每家的端点、鉴权、返回字段都写在注释里，方便日后复核。
 * 本模块只做纯逻辑（选适配器、拼请求、解析响应），真正发请求由 index.js 负责 —— 这样能单测。
 *
 * 核实时间：2026-09。未核实到的平台宁可不写，也不猜端点。
 */

import { createHmac, randomUUID } from 'node:crypto';

/* 余额响应统一成这个形状：
 *   { currency: 'CNY' | 'USD' | ..., total: '12.34', parts: [{ label, amount }] }
 * currency 缺失时由调用方按站点/域名推断；parts 用来填气泡里的构成行（充值 / 赠金等）。 */

/* 积分套餐的上游数据上限（见下面 workbuddy 的 parse）。
 * 名字长度限制的是下游 creditDisplayName 的前缀剥离开销（O(n²)）：实测 500KB 名字
 * 会让浏览器主线程卡 18 秒。200 字符远大于任何真实包名（最长的也只有 16 字）。
 * 条数限制的是渲染开销：这个列表在底栏的每秒重渲染路径上，没有 memo。 */
const CREDITS_NAME_MAX = 200;
const CREDITS_MAX_PACKAGES = 256;

/**
 * 字符串的短哈希（base36，约 6~7 位），O(n)、无依赖。
 * 只用于给截断后的超长包名加一个「不同原名不会碰撞」的标记 —— 不是密码学哈希，
 * 也不需要抗碰撞攻击：这里要防的是「两个正常上游数据被截成同名」，不是恶意构造。
 */
function nameHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * DeepSeek `GET /user/balance` 响应的唯一解析实现。
 *
 * 为什么抽出来：adapter.parse 与 `index.js` 的 API-key 分支原来各写一份，
 * 一份取 `balance_infos[0]`、一份优先 CNY；两份迟早漂移，而测试只打 adapter.parse
 * 那份（生产走的是另一份），绿了也证明不了线上正确。现在两边共用这一份。
 *
 * 返回 `{ currency, total, parts, balances }`；响应里没有可用余额时返回 null。
 * `balances` 每项都带自己的 toppedUp/granted，供底栏拼「充值 : 赠金」色条。
 */
function parseDeepSeekBalance(data) {
  const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : [];
  const usable = infos.filter((info) => info !== null && info !== undefined && typeof info === 'object');
  if (usable.length === 0) return null;
  /* 历史口径取第一条；但余额界面要的是 CNY 主余额 —— 优先 CNY，没有才退回第一条。 */
  const one = usable.filter((info) => info.currency === 'CNY')[0] ?? usable[0];
  const total = typeof one.total_balance === 'string'
    ? one.total_balance
    : (typeof one.total_balance === 'number' && Number.isFinite(one.total_balance) ? String(one.total_balance) : null);
  if (total === null || total.length === 0) return null;
  const parts = [];
  const partText = (value) => typeof value === 'string'
    ? value
    : (typeof value === 'number' && Number.isFinite(value) ? String(value) : null);
  const toppedUpText = partText(one.topped_up_balance);
  if (toppedUpText !== null) parts.push({ label: 'toppedUp', amount: toppedUpText });
  const grantedText = partText(one.granted_balance);
  if (grantedText !== null) parts.push({ label: 'granted', amount: grantedText });
  /* 分币种余额：只收 total > 0 的（0 与负数都不进 —— 用户拍板「负数也不显示」）。 */
  const balances = [];
  for (const info of usable) {
    const amount = Number(info.total_balance);
    if (Number.isFinite(amount) !== true || amount <= 0) continue;
    balances.push({
      currency: info.currency === 'USD' ? 'USD' : 'CNY',
      total: String(info.total_balance),
      toppedUp: info.topped_up_balance === undefined || info.topped_up_balance === null
        ? '0.00' : String(info.topped_up_balance),
      granted: info.granted_balance === undefined || info.granted_balance === null
        ? '0.00' : String(info.granted_balance),
    });
  }
  return {
    currency: typeof one.currency === 'string' ? one.currency : 'CNY',
    total,
    parts,
    balances: balances.length === 0 ? undefined : balances,
  };
}

/** 金额字段 → 两位小数字符串；字符串/有限数字都认，其余（空、NaN、对象）返回 null。 */
function moneyText(value) {
  const amount = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value.trim()) : NaN);
  if (Number.isFinite(amount) !== true) return null;
  return amount.toFixed(2);
}

/** 环境变量读取（宿主 Node 侧；测试可临时 mock process.env）。 */
function envValue(name) {
  if (typeof process === 'undefined' || process === null || process.env === undefined) return '';
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** 阿里云 RPC 签名要求的 RFC 3986 编码（与官方 Java URLEncoder 示例同口径：空格 %20、* %2A、~ 不编码）。 */
function alibabaPercentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%7E/g, '~')
    .replace(/\+/g, '%20');
}

/** 阿里云 RPC 参数按名称字典序拼成 canonicalized query string。 */
function alibabaCanonicalQuery(params) {
  const keys = Object.keys(params).sort();
  const pairs = [];
  for (let i = 0; i < keys.length; i += 1) {
    pairs.push(alibabaPercentEncode(keys[i]) + '=' + alibabaPercentEncode(params[keys[i]]));
  }
  return pairs.join('&');
}

/**
 * 试验性官方余额的**环境变量契约**（2026-11）。
 *
 * 背景与边界：
 * · 这是 2026-11 的试验性方案，**不改设置页**：不在设置 UI 里新增输入项，也不把密钥写进插件配置；
 *   统一让用户/AI 通过环境变量自行配置，插件只读不写。
 * · 发现入口规划为 `GET /dsh-desktop-statusbar/api/balance-provider-setup`（b2 负责加）：
 *   该接口只返回变量名与 `configured` 布尔值，**绝不返回值本身**，避免把 secret 泄露给前端/日志。
 * · 后续如果做设置 UI，应该从这张表扩展（表是唯一事实源），不要另写一份变量名。
 *
 * 每家为什么需要特殊配置：
 * · xAI：余额属于 team，需要 `XAI_TEAM_ID` 指定团队；Management API Key 与普通推理 key 不通用。
 * · 阿里云：查 BSS 余额用的是云账号 RAM AccessKey ID/Secret（`ALIBABA_CLOUD_ACCESS_KEY_ID` /
 *   `ALIBABA_CLOUD_ACCESS_KEY_SECRET`），**不是**百炼/DashScope 的模型 API Key；
 *   使用 STS 临时凭证时另加 `ALIBABA_CLOUD_SECURITY_TOKEN`（兼容 `ALIBABA_CLOUD_STS_TOKEN`），可选。
 * 小米 MiMo / StepFun 同样不在表里：它们的 key 在 DSH 模型页按 provider 写入 ctx.credentials，不需要额外环境变量。
 */
const BALANCE_PROVIDER_ENV = {
  xai: ['XAI_TEAM_ID', 'XAI_MANAGEMENT_API_KEY'],
  alibaba: ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']
};

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
    parse: (data) => parseDeepSeekBalance(data)
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
    id: 'xiaomi',
    label: 'Xiaomi MiMo',
    /* 核实（MiMo 官方文档 api/asset/balance-get）：GET https://api.xiaomimimo.com/v1/platform/balance
       请求头二选一：`api-key: <普通 API Key（sk- 开头）>` 或 `Authorization: Bearer <key>`。
       响应 { balance_infos: [{ currency, cash_balance, gift_balance, frozen_balance,
       credit_available, total_available }] }，金额都是两位小数字符串。
       总可用 = total_available（现金 + 赠金 + 可用授信，已把冻结部分加回）；
       构成行只列现金/赠金：cash_balance → toppedUp、gift_balance → granted（气泡里就是充值/赠金两行），
       授信不单列，避免把「授信额度」当成用户自己充的钱。
       凭据：模型页按 provider 名写入 ctx.credentials（refs 先查 xiaomi/mimo），
       MIMO_API_KEY / XIAOMI_API_KEY 只是可选的环境变量兜底。 */
    keys: ['xiaomi', 'mimo'],
    refs: ['xiaomi', 'mimo', 'MIMO_API_KEY', 'XIAOMI_API_KEY'],
    request: (key) => ({
      url: 'https://api.xiaomimimo.com/v1/platform/balance',
      headers: { 'api-key': key, accept: 'application/json' }
    }),
    parse: (data) => {
      const infos = data !== null && data !== undefined && Array.isArray(data.balance_infos) ? data.balance_infos : [];
      for (let i = 0; i < infos.length; i += 1) {
        const one = infos[i];
        if (one === null || one === undefined || typeof one !== 'object') continue;
        const total = moneyText(one.total_available);
        if (total === null) continue;
        const parts = [];
        const cash = moneyText(one.cash_balance);
        const gift = moneyText(one.gift_balance);
        if (cash !== null) parts.push({ label: 'toppedUp', amount: cash });
        if (gift !== null) parts.push({ label: 'granted', amount: gift });
        const currency = typeof one.currency === 'string' && one.currency.trim().length > 0
          ? one.currency.trim().toUpperCase()
          : 'CNY';
        return { currency, total, parts };
      }
      return null;
    }
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    /* 核实（StepFun 开放平台 accounts/get）：GET https://api.stepfun.com/v1/accounts
       鉴权 Authorization: Bearer <API Key>；响应
       { object:'account', type:'prepaid'|'postpaid', balance, total_cash_balance, total_voucher_balance }，
       三个金额都是数字。balance 是当前可用余额；total_cash_balance 是累计充值、
       total_voucher_balance 是累计赠送 —— 后两者是累计口径，消费后与 balance 不一定相等，按用户要求照实列出。
       凭据：模型页按 provider 名 stepfun 写入 ctx.credentials；STEPFUN_API_KEY 只是可选环境变量兜底。 */
    keys: ['stepfun'],
    refs: ['stepfun', 'STEPFUN_API_KEY'],
    request: (key, base) => {
      /* 国际站 `api.stepfun.ai` 与国内站 `api.stepfun.com` 的 key/币种不同：
         模型页 baseURL 指向国际站时用 USD，否则默认国内站 CNY。 */
      let host = ''
      try { host = new URL(String(base === undefined || base === null ? '' : base)).hostname.toLowerCase() } catch (error) { host = '' }
      const international = host === 'api.stepfun.ai' || host.endsWith('.api.stepfun.ai')
      return {
        url: (international ? 'https://api.stepfun.ai' : 'https://api.stepfun.com') + '/v1/accounts',
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        currency: international ? 'USD' : 'CNY'
      }
    },
    parse: (data) => {
      if (data === null || data === undefined || typeof data !== 'object') return null;
      const total = moneyText(data.balance);
      if (total === null) return null;
      const parts = [];
      const cash = moneyText(data.total_cash_balance);
      const voucher = moneyText(data.total_voucher_balance);
      if (cash !== null) parts.push({ label: 'toppedUp', amount: cash });
      if (voucher !== null) parts.push({ label: 'granted', amount: voucher });
      return { currency: 'CNY', total, parts };
    }
  },
  {
    id: 'xai',
    label: 'xAI',
    /* 核实（xAI Management API billing）：GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance
       鉴权 Authorization: Bearer <Management API Key>（普通推理 API Key 不被接受）。
       team_id 从环境变量 XAI_TEAM_ID 读取；没有就返回 null（调用方按不可用处理）。
       响应 { changes[], total: { val } }：total.val 是**带符号的 USD 分**，且是倒记账
       （$10 充值样例是 "-1000"），所以余额 = -total.val / 100。没有可解析的 total.val 就给 null：
       不把别的字段猜成金额（拿不准宁可不显示，避免显示一个看起来合理的错数）。 */
    keys: ['xai', 'x-ai', 'grok'],
    refs: ['XAI_MANAGEMENT_API_KEY'],
    request: (key) => {
      const teamId = envValue('XAI_TEAM_ID');
      if (teamId.length === 0) return null;
      return {
        url: 'https://management-api.x.ai/v1/billing/teams/' + encodeURIComponent(teamId) + '/prepaid/balance',
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' }
      };
    },
    parse: (data) => {
      if (data === null || data === undefined || typeof data !== 'object') return null;
      const candidates = [];
      if (data.total !== null && data.total !== undefined) {
        if (typeof data.total === 'object' && data.total.val !== undefined) candidates.push(data.total.val);
        else if (typeof data.total === 'string' || typeof data.total === 'number') candidates.push(data.total);
      }
      if (data.balance !== null && data.balance !== undefined) {
        if (typeof data.balance === 'object' && data.balance.val !== undefined) candidates.push(data.balance.val);
        /* 只有整数（分）才认；带小数点的 balance 更像美元金额，单位拿不准 ⇒ 不使用 */
        else if (typeof data.balance === 'number' && Number.isInteger(data.balance)) candidates.push(data.balance);
        else if (typeof data.balance === 'string' && /^-?\d+$/.test(data.balance.trim())) candidates.push(data.balance.trim());
      }
      for (let i = 0; i < candidates.length; i += 1) {
        const raw = candidates[i];
        const cents = typeof raw === 'number'
          ? raw
          : (typeof raw === 'string' && raw.trim().length > 0 ? Number(raw.trim()) : NaN);
        if (Number.isFinite(cents) !== true) continue;
        return { currency: 'USD', total: (-cents / 100).toFixed(2), parts: [] };
      }
      return null;
    }
  },
  {
    id: 'alibaba',
    label: '阿里云',
    /* 核实（阿里云 BSS OpenAPI 2017-12-14）：GET https://business.aliyuncs.com/?Action=QueryAccountBalance
       + RPC 签名（HMAC-SHA1，参数按字典序、RFC3986 编码）。**这里用的是云账号 AccessKey ID/Secret，
       不是模型 API Key**（百炼/DashScope 的模型 key 不能查余额）：ID/Secret 从
       ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET 读取，可选
       ALIBABA_CLOUD_SECURITY_TOKEN（或 ALIBABA_CLOUD_STS_TOKEN）作为 STS 临时凭证；
       Secret 缺失时 request 返回 null（按不可用处理）。
       响应 { Code:'200', Success:true, Data:{ AvailableAmount, Currency, ... } }；可用额度 = Data.AvailableAmount。 */
    keys: ['alibaba', 'qwen', 'dashscope'],
    refs: ['ALIBABA_CLOUD_ACCESS_KEY_ID'],
    request: (key) => {
      const secret = envValue('ALIBABA_CLOUD_ACCESS_KEY_SECRET');
      const accessKeyId = envValue('ALIBABA_CLOUD_ACCESS_KEY_ID')
        || String(key === undefined || key === null ? '' : key).trim();
      if (secret.length === 0 || accessKeyId.length === 0) return null;
      const params = {
        Action: 'QueryAccountBalance',
        Version: '2017-12-14',
        Format: 'JSON',
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        SignatureNonce: randomUUID(),
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        AccessKeyId: accessKeyId
      };
      const securityToken = envValue('ALIBABA_CLOUD_SECURITY_TOKEN') || envValue('ALIBABA_CLOUD_STS_TOKEN');
      if (securityToken.length > 0) params.SecurityToken = securityToken;
      const canonical = alibabaCanonicalQuery(params);
      const stringToSign = 'GET&' + alibabaPercentEncode('/') + '&' + alibabaPercentEncode(canonical);
      const signature = createHmac('sha1', secret + '&').update(stringToSign, 'utf8').digest('base64');
      return {
        url: 'https://business.aliyuncs.com/?' + canonical + '&Signature=' + alibabaPercentEncode(signature),
        headers: { accept: 'application/json' }
      };
    },
    parse: (data) => {
      if (data === null || data === undefined || typeof data !== 'object') return null;
      if (data.Success === false) return null;
      if (data.Code !== undefined && data.Code !== null && Number(data.Code) !== 200) return null;
      const inner = data.Data !== null && data.Data !== undefined && typeof data.Data === 'object' ? data.Data : null;
      if (inner === null) return null;
      const total = moneyText(inner.AvailableAmount);
      if (total === null) return null;
      const currency = typeof inner.Currency === 'string' && inner.Currency.trim().length > 0
        ? inner.Currency.trim().toUpperCase()
        : 'CNY';
      return { currency, total, parts: [] };
    }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    /* 核实（MiniMax M Plan / Token Plan API，非 Coding Plan）：
       GET https://www.minimax.cn/v1/token_plan/remains
       鉴权 Authorization: Bearer <API Key>；响应
       { base_resp: { status_code, status_msg }, model_remains: [{ model_name,
       current_interval_remaining_percent, current_weekly_remaining_percent,
       current_interval_total_count, current_interval_usage_count, ... }] }。
       字段坑（MiniMax 官方 issue MiniMax-AI/MiniMax-M2#99 确认）：current_interval_usage_count /
       current_weekly_usage_count 名字写着 usage，实际是**剩余额度**，不是已用量；
       已用 = total_count - usage_count。优先用 remaining_percent（若上游给），没有才用计数换算；
       general 桶的 total_count 可能是 0（没有独立计数），这时退周窗口。
       本插件 isPercent 的 total 约定为「已用百分比」（客户端再显示 100-已用），所以统一换算成 100-remaining。
       base_resp.status_code !== 0 一律 null（鉴权失败是 HTTP 200 + 1004/2049）。
       凭据：模型页按 provider 名 minimax 写入 ctx.credentials，不要求 MINIMAX_API_KEY 环境变量。
       说明：M Plan / Token Plan API 已支持；Coding Plan 专用 `coding_plan/remains` 需要 GroupId，暂未接入。 */
    keys: ['minimax'],
    refs: ['minimax'],
    request: (key) => ({
      url: 'https://www.minimax.cn/v1/token_plan/remains',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' }
    }),
    parse: (data) => {
      if (data === null || data === undefined || typeof data !== 'object') return null;
      const base = data.base_resp;
      if (base !== null && base !== undefined && typeof base === 'object') {
        const code = Number(base.status_code);
        if (Number.isFinite(code) && code !== 0) return null;
      }
      const rows = Array.isArray(data.model_remains) ? data.model_remains : [];
      const clampPercent = (value) => Math.max(0, Math.min(100, value));
      const percentFromCounts = (one, totalKey, usageKey) => {
        const total = Number(one[totalKey]);
        const remain = Number(one[usageKey]);
        if (Number.isFinite(total) !== true || Number.isFinite(remain) !== true || total <= 0) return null;
        const safeRemain = Math.max(0, Math.min(total, remain));
        return (safeRemain / total) * 100;
      };
      const percentOf = (one) => {
        if (one === null || one === undefined || typeof one !== 'object') return null;
        const interval = Number(one.current_interval_remaining_percent);
        if (Number.isFinite(interval) === true) return clampPercent(interval);
        const weekly = Number(one.current_weekly_remaining_percent);
        if (Number.isFinite(weekly) === true) return clampPercent(weekly);
        const fromInterval = percentFromCounts(one, 'current_interval_total_count', 'current_interval_usage_count');
        if (fromInterval !== null) return clampPercent(fromInterval);
        const fromWeekly = percentFromCounts(one, 'current_weekly_total_count', 'current_weekly_usage_count');
        return fromWeekly === null ? null : clampPercent(fromWeekly);
      };
      let remaining = null;
      for (let i = 0; i < rows.length; i += 1) {
        const one = rows[i];
        if (one === null || one === undefined || typeof one !== 'object') continue;
        if (String(one.model_name).toLowerCase() !== 'general') continue;
        remaining = percentOf(one);
        if (remaining !== null) break;
      }
      if (remaining === null) {
        for (let i = 0; i < rows.length; i += 1) {
          remaining = percentOf(rows[i]);
          if (remaining !== null) break;
        }
      }
      if (remaining === null) return null;
      return { currency: '', total: (100 - remaining).toFixed(2) + '%', parts: [], isPercent: true };
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
      url: (() => { try { return new URL(String(base)).origin; } catch (error) { return 'https://open.bigmodel.cn'; } })() + '/api/monitor/usage/quota/limit',
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
        /* 数组里可能是 null（上游坏数据）：直接读 one.type 会抛 TypeError，
           整条余额就永久变横杠了，所以先挡一道。 */
        if (one === null || one === undefined || typeof one !== 'object') continue;
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
      const out = { currency: '', total: formatCredits(total), parts: [], isCredits: true };
      /* 套餐列表：新插件（dsh-connect-workbuddy）的 /usage 带 credits.packages，就是官方客户端
         「积分套餐」那一栏的数据。老插件 /status 只有 credits.total，**不产生 rewards** ——
         客户端据此保持现在的纯总数显示，不会因为字段缺失去猜。 */
      const packages = Array.isArray(credits.packages) ? credits.packages : null;
      if (packages === null) return out;
      const rewards = [];
      /* 条数上限：上游返回多少条不由我们决定，而列表渲染在底栏的每秒重渲染路径上
         （无 memo），几万条会把界面拖死（实测 10 万条 ≈ 0.7 秒/帧）。
         真实账号最多二三十个包，256 足够宽松，超出的直接忽略。 */
      const count = Math.min(packages.length, CREDITS_MAX_PACKAGES);
      for (let i = 0; i < count; i += 1) {
        const one = packages[i];
        if (one === null || one === undefined || typeof one !== 'object') continue;
        const size = Number(one.size);
        const remain = Number(one.remain);
        /* size/remain 缺一个就没法算「已用/总量」：跳过这个包，
           不让一条坏数据把整条气泡弄崩（旧插件/上游漂移都可能缺字段）。 */
        if (Number.isFinite(size) !== true || Number.isFinite(remain) !== true || size < 0) continue;
        const rawName = typeof one.packageName === 'string' ? one.packageName : '';
        if (rawName.length === 0) continue;
        /* 包名长度上限：上游是一条外部 API 响应，名字多长不由我们决定。
           下游 creditDisplayName 要按前缀反复剥，超长名字是 O(n²)（实测 500KB 名字
           能让浏览器主线程卡 18 秒）；标签行也放不下。200 字符足够覆盖任何真实包名
           （最长的「CodeBuddy个人版国内运营裂变包」也只有 16 字）。
           **截断必须保证不同原名不碰撞 + 保持截断开销 O(n)**：客户端会把「显示名相邻
           且相同」的包合并成 ×N 一行，若两个前缀相同、后缀不同的超长包被截成同名，
           就会被误合并、显示伪造的合计（防御代码自己制造错误数据）。
           只用「原始长度」不够 —— 长度相同的两个不同名字照样碰撞，所以带上一段
           由全文算出的短哈希。 */
        const name = rawName.length > CREDITS_NAME_MAX
          ? rawName.slice(0, CREDITS_NAME_MAX) + '…(' + rawName.length + ':' + nameHash(rawName) + ')'
          : rawName;
        const monthly = one.monthly === true;
        rewards.push({
          name,
          /* 「已用」与官方同口径：总量 - 剩余（connect 插件已按 CapacitySize/Remain 算好）；
             剩余超过总量这种异常数据夹住到 0，不显示负数。 */
          used: Math.max(0, size - remain),
          total: size,
          /* 一次性包看到期日；月度包看「下期刷新」（官方对月度包不显示「到期」，别编造到期时间） */
          expireAt: monthly ? null : dateOfMs(one.expiresAtMs),
          refreshAt: monthly ? dateOfMs(one.cycleRefreshMs) : null,
          monthly,
        });
      }
      out.rewards = rewards;
      return out;
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
 * 毫秒时间戳 → 北京时间 'YYYY-MM-DD'（套餐气泡里的到期日/刷新日）。
 *
 * 为什么固定按北京时间算、不看运行环境时区：这个项目的所有「日」口径（峰谷计价、
 * 签到日）都按北京时间；套餐到期时间给用户看的是**中国的日期**，跟着机器时区走
 * 会在海外机器上差一天（服务端实测值如 1794056975000 = 北京时间 2026-11-07 21:09）。
 * 取不到/非法值给 null —— 客户端显示「—」，绝不猜一个日期。
 */
function dateOfMs(value) {
  const ms = Number(value);
  if (Number.isFinite(ms) !== true || ms <= 0) return null;
  const bj = new Date(ms + 8 * 3600 * 1000);
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return bj.getUTCFullYear() + '-' + month + '-' + day;
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
  /* Magpie exposes no verified upstream identity; never infer a vendor from its model name. */
  if (providerText.includes('magpie')) return null;
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
 * 与 workbuddy 适配器注释里那条实测教训（拿错平台的 key 去问余额，稳定 401）是同一个原则：
 * 宁可不显示，也不显示错数。
 *
 * 这条防线**唯一的实现处就是各适配器自己的 `parse`**：`index.js` 的 `queryLocalAdapter`
 * 拿到本机路由响应后直接调 `adapter.parse(data)` —— workbuddy 只认 `credits.total`、
 * 智谱配额只认带 `limits` 数组的形状，认不出一律给 null（既不猜字段，也不硬凑）。
 * 回归测试（tests/verify-balance-api.js）打的就是这条生产路径。
 *
 * 历史上这里还有一套 `LOCAL_SHAPE_EXTRACTORS` + `balanceFromLocalDoc`：它只被测试引用、
 * 生产从未调用（2026-10 删除）。测试打生产 `parse` 才是真防线 —— 打只给测试用的旁路函数，
 * 绿了也不代表线上安全。
 */

/* ------------------------------------------------------------------ Magpie 网关 */

/**
 * Magpie 是本机聚合网关：provider 固定是 `magpie`（或 `remote-magpie`），真实上游藏在
 * 模型 id 的 `owned_by` / 前缀里；权威额度源是 `GET <base>/v1/magpie/quotas`
 * （零配置、无需 API Key）。下面只放**纯解析**，发请求由 index.js 负责 —— 这样能单测。
 *
 * 字段语义（2026-11-12 实测，务必别搞反）：
 *   · `window.used` / `window.remaining` 都是 **0–100 的百分比**；
 *   · `window.amount` 是**已用数量**（= limit × used%），**不是剩余**；
 *   · 剩余数量 = `limit - amount`（也等于 `limit × remaining%`，两种算法实测一致）。
 * 调研文档曾把 amount 误写成"剩余金额"，这里以实测为准（拿 used 当余额会显示一个
 * 看起来合理的错数，正是本项目反复强调要避免的事）。
 */
const MAGPIE_CURRENCY_HINTS = [
  ['CNY', ['¥', '￥', 'cny', 'rmb', '元']],
  ['USD', ['$', 'usd']],
  ['EUR', ['€', 'eur']],
  ['GBP', ['£', 'gbp']],
];

/** `/v1/models` 里 `id` → `owned_by`；取不到返回 null（不猜）。 */
function magpieModelProvider(modelsData, model) {
  const want = String(model === undefined || model === null ? '' : model);
  if (want.length === 0) return null;
  const list = modelsData !== null && modelsData !== undefined && Array.isArray(modelsData.data) ? modelsData.data : [];
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one !== null && one !== undefined && one.id === want && typeof one.owned_by === 'string' && one.owned_by.length > 0) {
      return one.owned_by;
    }
  }
  /* 唯一后缀匹配：短名 `gpt-6-astra` 能命中 `selen/gpt-6-astra`；但同一短名属于多个
     owner（orbis 也有 `orbis/gpt-6-astra`）时必须放弃，别的 owner 不能算到 selen 头上。 */
  const suffix = '/' + want;
  const owners = [];
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === null || one === undefined || typeof one.id !== 'string' || one.id.endsWith(suffix) !== true) continue;
    if (typeof one.owned_by !== 'string' || one.owned_by.length === 0) continue;
    if (owners.indexOf(one.owned_by) < 0) owners.push(one.owned_by);
  }
  return owners.length === 1 ? owners[0] : null;
}

/** 模型 id 前缀（`group/deepseek-flash` → `group`、`workbuddy/x` → `workbuddy`）兜底。 */
function magpieModelPrefix(model) {
  const text = String(model === undefined || model === null ? '' : model);
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash) : null;
}

/**
 * 模型 id → quotas 里真实存在的 provider（通用最长前缀匹配，绝不写死任何站名）。
 *
 * 背景：Magpie 的 `/v1/models` 里 `owned_by` 与 quotas 的 `provider` **不一定同名**（实测
 * `owned_by = work`，而 quotas 的 provider 是 `work/codex`）。当 owned_by / 前缀 / hint 都
 * 找不到条目时，用「模型 id 的最长前缀」去和 quotas 的 provider 做**路径前缀**匹配：
 * 模型 `work/codex/gpt-6-luna` 的 `work/codex` 前缀正好等于 provider `work/codex`。
 * 任何形如 `<provider>/<model>` 的模型都适用。
 *
 * 只在**唯一**最长前缀命中时返回（多个 provider 同长度前缀命中则 null，不瞎挑）；
 * 匹配忽略大小写，先转小写再比。
 */
function magpieModelQuotaProvider(quotasData, model) {
  const want = String(model === undefined || model === null ? '' : model).trim().toLowerCase();
  if (want.length === 0) return null;
  const list = quotasData !== null && quotasData !== undefined && Array.isArray(quotasData.data) ? quotasData.data : [];
  const providers = [];
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === null || one === undefined || typeof one.provider !== 'string') continue;
    const name = one.provider.trim().toLowerCase();
    if (name.length === 0) continue;
    if (providers.indexOf(name) < 0) providers.push(name);
  }
  let best = null;
  for (let i = 0; i < providers.length; i += 1) {
    const name = providers[i];
    /* 必须作为「路径段前缀」命中：模型 = provider 或以 provider + '/' 开头。 */
    if (want === name || want.startsWith(name + '/')) {
      if (best === null || name.length > best.length) best = name;
    }
  }
  if (best === null) return null;
  /* 唯一性：长度相同但内容不同的前缀都算命中 ⇒ 拒绝（无法判定）。 */
  const sameLen = providers.filter((one) => one.length === best.length && (want === one || want.startsWith(one + '/')));
  if (sameLen.length > 1) return null;
  return best;
}

/** quotas 里属于某个 provider 的账号条目（provider 名大小写不敏感；orbi 是 DSH 侧对 orbis 的写法）。 */
function magpieQuotaEntries(quotasData, provider) {
  let want = String(provider === undefined || provider === null ? '' : provider).trim().toLowerCase();
  if (want === 'orbi') want = 'orbis';
  const list = quotasData !== null && quotasData !== undefined && Array.isArray(quotasData.data) ? quotasData.data : [];
  if (want.length === 0) return [];
  return list.filter((one) => one !== null && one !== undefined && typeof one.provider === 'string'
    && one.provider.toLowerCase() === want);
}

/** 一个窗口的剩余数量；认不出返回 null（绝不猜）。优先 limit - amount，其次 limit × remaining%。 */
function magpieWindowRemaining(window) {
  if (window === null || window === undefined || typeof window !== 'object') return null;
  const limit = Number(window.limit);
  const amount = Number(window.amount);
  if (Number.isFinite(limit) && Number.isFinite(amount)) return Math.max(0, limit - amount);
  const remainPct = Number(window.remaining);
  if (Number.isFinite(limit) && Number.isFinite(remainPct)) return Math.max(0, (limit * remainPct) / 100);
  return null;
}

/**
 * 账号里代表「剩余积分」的窗口：优先 Total credits，其次 Credits，再到第一个 credits 单位窗口。
 * 积分窗口的判据是 `unit === 'credits'`（token 估算窗口没有 unit，不能当积分）。
 */
function magpiePrimaryCreditsWindow(entry) {
  const windows = entry !== null && entry !== undefined && Array.isArray(entry.windows) ? entry.windows : [];
  const creditWindows = windows.filter((one) => one !== null && one !== undefined && one.unit === 'credits');
  if (creditWindows.length === 0) return null;
  const order = ['Total credits', 'Credits'];
  for (let i = 0; i < order.length; i += 1) {
    const hit = creditWindows.filter((one) => one.name === order[i])[0];
    if (hit !== undefined) return hit;
  }
  return creditWindows[0];
}

/** `'¥0.03'` → `{ currency:'CNY', amount:0.03 }`；认不出币种给空串、认不出数字给 null。 */
function magpieParseMoney(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw.length === 0) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (match === null) return null;
  const amount = Number(match[0]);
  if (Number.isFinite(amount) !== true) return null;
  const lower = raw.toLowerCase();
  let currency = '';
  for (let i = 0; i < MAGPIE_CURRENCY_HINTS.length; i += 1) {
    const code = MAGPIE_CURRENCY_HINTS[i][0];
    const hints = MAGPIE_CURRENCY_HINTS[i][1];
    if (hints.some((hint) => lower.indexOf(hint) >= 0 || raw.indexOf(hint) >= 0)) { currency = code; break; }
  }
  return { currency, amount };
}

/**
 * 订阅型配额窗口里的百分比：窗口同时给出有限数字的 used/remaining（0–100）时认作
 * 「已用/剩余百分比」。判据与积分窗口互斥：
 *   · 带 unit === 'credits' 的窗口是积分，不是百分比（交给上面 credits 那条）；
 *   · image-only / 文本占位窗口（例如 name 含 image、或 used/remaining 不是有限数字）不算。
 * 认不出返回 null。多窗口取「已用最多（剩余最少）」的那个，与 zhipu-quota 取最紧窗口同口径。
 */
function magpieSubscriptionPercentWindow(entry) {
  const list = entry !== null && entry !== undefined && Array.isArray(entry.windows) ? entry.windows : [];
  const windows = [];
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === null || one === undefined || typeof one !== 'object') continue;
    if (one.unit === 'credits') continue;
    const rawName = typeof one.name === 'string' ? one.name : '';
    const name = rawName.toLowerCase();
    if (name.indexOf('image') >= 0) continue;
    const used = Number(one.used);
    const remaining = Number(one.remaining);
    if (Number.isFinite(used) !== true || Number.isFinite(remaining) !== true) continue;
    if (used < 0 || remaining < 0) continue;
    /* 保留有限 limit>0：多账号合并时按 limit 加权（没有 limit 的窗口按账号数等权）。 */
    const limit = Number(one.limit);
    const window = { name: rawName, used: used, remaining: remaining };
    if (Number.isFinite(limit) === true && limit > 0) window.limit = limit;
    windows.push(window);
  }
  if (windows.length === 0) return null;
  /* primary 优先「名字含 5 或 hour」的窗口（五小时额度）；没有五小时再取已用最大窗口。 */
  const fiveHour = windows.filter((one) => {
    const name = one.name.toLowerCase();
    return name.indexOf('5') >= 0 || name.indexOf('hour') >= 0;
  })[0];
  let primary = fiveHour;
  if (primary === undefined) {
    primary = windows[0];
    for (let i = 1; i < windows.length; i += 1) {
      if (windows[i].used > primary.used) primary = windows[i];
    }
  }
  return { primary: primary, windows: windows };
}

/** 一个账号 → 统一口径 `{ mode:'credits', remaining, limit }` / `{ mode:'money', currency, amount }`
 *  / `{ mode:'percent', used, remaining }`；认不出 null。 */
function magpieEntryPrimary(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return null;
  if (typeof entry.balance === 'string' && entry.balance.trim().length > 0) {
    const money = magpieParseMoney(entry.balance);
    if (money !== null) return { mode: 'money', currency: money.currency, amount: money.amount };
  }
  const window = magpiePrimaryCreditsWindow(entry);
  if (window !== null) {
    const remaining = magpieWindowRemaining(window);
    const limit = Number(window.limit);
    if (remaining !== null && Number.isFinite(limit) && limit > 0) return { mode: 'credits', remaining: remaining, limit: limit };
  }
  /* 订阅型：没有 credits 窗口时，used/remaining 百分比窗口就是它的额度口径。 */
  const percent = magpieSubscriptionPercentWindow(entry);
  if (percent !== null) {
    return { mode: 'percent', used: percent.primary.used, remaining: percent.primary.remaining, windows: percent.windows };
  }
  return null;
}

/** 账号列表 → 积分套餐气泡的行（每个账号一行，展示"剩余 / 总量"）。 */
function magpieAccountRows(entries, providerName) {
  const rows = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const primary = magpieEntryPrimary(entry);
    if (primary === null || primary.mode !== 'credits') continue;
    const who = typeof entry.user === 'string' && entry.user.length > 0
      ? entry.user
      : (typeof entry.plan === 'string' && entry.plan.length > 0 ? entry.plan : 'account');
    rows.push({
      name: who + (providerName.length > 0 ? ' · ' + providerName : ''),
      used: Math.max(0, primary.limit - primary.remaining),
      total: primary.limit,
      expireAt: null,
      refreshAt: null,
      monthly: false,
    });
  }
  return rows;
}

/**
 * Magpie quotas + provider/账号 → 余额项口径。
 *
 * @param {object} quotasData  `/v1/magpie/quotas` 的 JSON
 * @param {{provider?:string, providerName?:string, account?:string|null}} options
 * @returns {{ok:true, mode:'credits'|'money'|'percent', currency, total, isCredits?, isPercent?, rewards?, toppedUp?, granted?, parts?, providerName, account}
 *          |{ok:false, reason:string, detail?, providerName}}
 */
function magpieBalanceOf(quotasData, options) {
  const opts = options === undefined || options === null ? {} : options;
  const providerName = typeof opts.providerName === 'string' && opts.providerName.length > 0
    ? opts.providerName
    : String(opts.provider === undefined || opts.provider === null ? '' : opts.provider);
  const entries = magpieQuotaEntries(quotasData, providerName);
  if (entries.length === 0) return { ok: false, reason: 'magpie-provider-not-found', providerName: providerName };

  /* 选中哪个账号：先按 account 精确匹配 user；只有一个账号时直接用它；否则汇总全池。 */
  let chosen = null;
  if (typeof opts.account === 'string' && opts.account.length > 0) {
    const want = opts.account.trim().toLowerCase();
    chosen = entries.filter((one) => typeof one.user === 'string' && one.user.trim().toLowerCase() === want)[0] ?? null;
  }
  if (chosen === null && entries.length === 1) chosen = entries[0];

  const selected = chosen === null ? entries : [chosen];
  /* 选中账号自身带 error（如 ZCode 没有套餐）时如实报错，不显示 0。 */
  if (chosen !== null && typeof chosen.error === 'string' && chosen.error.length > 0) {
    return { ok: false, reason: 'magpie-upstream-error', detail: chosen.error.slice(0, 240), providerName: providerName };
  }

  const primaries = [];
  for (let i = 0; i < selected.length; i += 1) {
    primaryOf(selected[i], primaries);
  }
  if (primaries.length === 0) {
    const errors = entries.filter((one) => typeof one.error === 'string' && one.error.length > 0);
    if (errors.length > 0) {
      return { ok: false, reason: 'magpie-upstream-error', detail: errors[0].error.slice(0, 240), providerName: providerName };
    }
    return { ok: false, reason: 'magpie-no-balance-info', providerName: providerName };
  }

  const mode = primaries[0].mode;
  const same = primaries.filter((one) => one.mode === mode);
  const accountName = chosen !== null && typeof chosen.user === 'string' ? chosen.user : null;
  if (mode === 'money') {
    let sum = 0;
    for (let i = 0; i < same.length; i += 1) sum += same[i].amount;
    const total = sum.toFixed(2);
    return {
      ok: true, mode: 'money', currency: same[0].currency, total: total,
      toppedUp: total, granted: '0.00', parts: [{ label: 'toppedUp', amount: total }],
      providerName: providerName, account: accountName,
    };
  }
  if (mode === 'percent') {
    /* 订阅型配额（多账号综合口径）：收集 selected 所有账号的 percent windows，**按窗口名归为一类**
       （name 含 5/hour → fiveHour，含 7/day → sevenDay，其余按原始 name），同类窗口跨账号合并：
         · 有有限 limit>0 的窗口按 limit 加权平均 used/remaining；
         · 否则按账号数等权平均 used/remaining。
       total = fiveHour 合并后的已用百分比；没有 fiveHour 时取合并后 used 最大的一类。
       返回的 windows 是合并后的列表（每条 name/used/remaining），供 creditsPanel 画条。
       单账号时合并结果 = 该账号原窗口，行为不变。绝不写死任何站名 / 账号。 */
    const classify = (name) => {
      const text = String(name === undefined || name === null ? '' : name).toLowerCase();
      if (text.indexOf('5') >= 0 || text.indexOf('hour') >= 0) return 'fiveHour';
      if (text.indexOf('7') >= 0 || text.indexOf('day') >= 0) return 'sevenDay';
      return String(name === undefined || name === null ? '' : name);
    };
    /* 依出现顺序聚合各类。每类记录：各账号的窗口条目（带账号名）、是否全部带有限 limit>0。
       账号名取 entry.user（其次 entry.plan，最后 'account'），供下钻时逐账号展示。
       ⚠ percent 口径**始终汇总全部账号**（与 WorkBuddy 积分统一口径）：这里遍历 entries，
       而不是 selected —— 否则 Magpie route 返回了某账号时，chosen 会只剩它一个、漏掉其他账号。
       金额/积分分支仍按 chosen/selected 的既有语义，不受此影响。 */
    const whoOf = (entry) => (typeof entry.user === 'string' && entry.user.length > 0
      ? entry.user
      : (typeof entry.plan === 'string' && entry.plan.length > 0 ? entry.plan : 'account'));
    const groups = [];
    const groupOf = {};
    for (let a = 0; a < entries.length; a += 1) {
      const entry = entries[a];
      const who = whoOf(entry);
      const pct = magpieSubscriptionPercentWindow(entry);
      if (pct === null) continue;
      for (let w = 0; w < pct.windows.length; w += 1) {
        const one = pct.windows[w];
        const used = Number(one.used);
        const remaining = Number(one.remaining);
        if (Number.isFinite(used) !== true || Number.isFinite(remaining) !== true) continue;
        const key = classify(one.name);
        let acc = groupOf[key];
        if (acc === undefined) {
          acc = { key: key, name: typeof one.name === 'string' ? one.name : key, entries: [], allLimit: true };
          groupOf[key] = acc;
          groups.push(acc);
        }
        const limit = Number(one.limit);
        const useLimit = Number.isFinite(limit) === true && limit > 0;
        if (useLimit !== true) acc.allLimit = false;
        acc.entries.push({ name: who, used: used, remaining: remaining, limit: useLimit ? limit : 0 });
      }
    }
    const merged = [];
    for (let g = 0; g < groups.length; g += 1) {
      const acc = groups[g];
      if (acc.entries.length === 0) continue;
      let weight = 0;
      let sumUsed = 0;
      let sumRemain = 0;
      for (let e = 0; e < acc.entries.length; e += 1) {
        const one = acc.entries[e];
        /* 全部窗口都有有限 limit>0 ⇒ 按 limit 加权；否则按账号数（条目数）等权。 */
        const wgt = acc.allLimit ? one.limit : 1;
        weight += wgt;
        sumUsed += one.used * wgt;
        sumRemain += one.remaining * wgt;
      }
      if (weight <= 0) continue;
      /* 每个合并窗口带 items（逐账号明细）：name=账号名、used/remaining=该账号本窗口值。 */
      const items = acc.entries.map((one) => ({ name: one.name, used: one.used, remaining: one.remaining }));
      merged.push({ key: acc.key, name: acc.name, used: sumUsed / weight, remaining: sumRemain / weight, items: items });
    }
    if (merged.length === 0) {
      return { ok: false, reason: 'magpie-no-balance-info', providerName: providerName };
    }
    const fiveHour = merged.filter((one) => one.key === 'fiveHour')[0];
    let primary = fiveHour;
    if (primary === undefined) {
      primary = merged[0];
      for (let i = 1; i < merged.length; i += 1) {
        if (merged[i].used > primary.used) primary = merged[i];
      }
    }
    return {
      ok: true, mode: 'percent', isPercent: true, total: primary.used.toFixed(2) + '%', currency: '',
      windows: merged.map((one) => ({ key: one.key, name: one.name, used: one.used, remaining: one.remaining, items: one.items })),
      parts: [], providerName: providerName, account: accountName,
    };
  }
  let remain = 0;
  for (let i = 0; i < same.length; i += 1) remain += same[i].remaining;
  return {
    ok: true, mode: 'credits', currency: '', total: formatCredits(remain), isCredits: true,
    rewards: magpieAccountRows(entries, providerName), providerName: providerName, account: accountName,
  };
}

/* 内部小工具：把一条 entry 的统一口径压进数组（抽出来只为让上面主逻辑短一点）。 */
function primaryOf(entry, out) {
  const primary = magpieEntryPrimary(entry);
  if (primary !== null) out.push(primary);
}

/** `/v1/magpie/route` → 会话语义下的账号名；形状未定，按常见字段稳健提取，认不出 null。 */
function magpieAccountFromRoute(routeData) {
  if (routeData === null || routeData === undefined || typeof routeData !== 'object') return null;
  const route = routeData.route;
  if (typeof route === 'string' && route.length > 0) return route;
  if (route !== null && route !== undefined && typeof route === 'object') {
    const keys = ['providerAccount', 'account', 'user', 'name'];
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof route[keys[i]] === 'string' && route[keys[i]].length > 0) return route[keys[i]];
    }
  }
  if (typeof routeData.providerAccount === 'string' && routeData.providerAccount.length > 0) return routeData.providerAccount;
  return null;
}

export {
  adapters, adapterFor, adaptersFor, BALANCE_PROVIDER_ENV, pluginRoutesIn, parseDeepSeekBalance, LOCAL_READONLY_VERBS, LOCAL_NEVER_PROBE,
  magpieModelProvider, magpieModelPrefix, magpieModelQuotaProvider, magpieQuotaEntries, magpieBalanceOf,
  magpieAccountFromRoute, magpieParseMoney, magpieEntryPrimary,
};
