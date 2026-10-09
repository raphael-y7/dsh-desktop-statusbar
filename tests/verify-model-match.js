/**
 * 模型名 → 价格键匹配规则（v3.2）与 client / host 两侧一致性。
 *
 * 契约：
 *   ① 精确同名（不分大小写）—— 单独先行，最高优先。
 *   ②③ 一次评选：候选 = "键是模型名的子串" ∪ "键的词元在模型名词元里全含"，
 *      在候选里取 weight 最大者，weight = 词元数 * 1000 + 键名长度。
 *      · 词元按 `[^a-z0-9]+` 切分并转小写；词元必须**完全相等**。
 *      · **含数字的价格键只允许①同名与②子串命中，不走词元档**
 *        （所以 `deepseek-v4-pro` 命不中 `deepseek-v4.1-pro` / `deepseek-v41-pro`）。
 *      · ②③ 不能分两轮跑：模型名里含一个短键（如 flash）时，会把只能靠词元档命中的
 *        更具体键（deepseek-flash）挤掉 —— 用例 5 锁的就是这件事。
 *   ④ 分两轮：第一轮跳过"整条全 0（未定价）"的条目；第一轮一无所获时第二轮放开，
 *      让"用户明确把某模型设为 0 价"仍生效。
 *   ⑤ 都不命中 → null（该笔用量记"欠账"，将来补价再补算）。
 *
 * 为什么两侧必须一致：底栏按 client 的价算、活跃总览按 host 的价算，
 * 规则一旦不一致，同一个模型在界面两处会显示两个价钱。
 * 测法：client 直接调 pickPriceKey 取键名；host 没有可调用入口，
 * 就让每个键带一个独有单价，用 HTTP 记账算出来的钱反推命中了哪个键。
 *
 * 全程只用隔离 DSH_HOME（tests/.dsh-test-home-match），不碰真实 ~/.dsh/dsh-status-bar/。
 * 用法：node tests/verify-model-match.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const assert = require('assert');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');
const INDEX = path.join(__dirname, '..', 'lib', 'index.js');
const HOME = path.join(__dirname, '.dsh-test-home-match');

globalThis.setInterval = () => 0;

/* ------------------------------------------------ 共用用例表（两侧同一套输入与预期） */
const M = 1000000;
/** 每个"有价"价格键一个独有单价（空闲档 input，CNY/1M）；host 侧用它反推命中的键。 */
const MARKS = {
  'deepseek-flash': 1,
  'deepseek-v4-pro': 3,
  'Deepseek-V4.1-Flash': 7,
  'deepseek-v4-flash': 11,
  'seek-v4': 13,
  'flash-sg': 17,
  'v4-flash': 19,
  'DeepSeek-Flash': 23,
  'flash': 29,
  'deepseek-sg-flash': 31,
  'DeepSeek-V41-Flash': 37,
};
const MARK_OF = {};
Object.keys(MARKS).forEach((key) => { MARK_OF[MARKS[key]] = key; });

const ZERO_TIER = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
/** 造价格库：blank 里的键给"全 0（未定价）"条目，其余给独有单价。 */
function bookOf(keys, blank) {
  const blanks = blank === undefined ? [] : blank;
  const book = {};
  keys.forEach((key) => {
    if (blanks.indexOf(key) !== -1) {
      book[key] = { peak: Object.assign({}, ZERO_TIER), offPeak: Object.assign({}, ZERO_TIER) };
      return;
    }
    assert.ok(MARKS[key] !== undefined, '用例表里的键 ' + key + ' 缺单价标记');
    book[key] = {
      peak: { input: MARKS[key] * 10, cacheRead: 0, cacheWrite: 0, output: 0 },
      offPeak: { input: MARKS[key], cacheRead: 0, cacheWrite: 0, output: 0 },
    };
  });
  return book;
}

const CASES = [
  /* ---- 词元全含（键不含数字） ---- */
  { name: '词元全含：版本号插在中间', keys: ['deepseek-flash'], model: 'deepseek-v4.1-flash-sg', expect: 'deepseek-flash' },
  { name: '词元全含：v41 连着写', keys: ['deepseek-flash'], model: 'deepseek-v41-flash', expect: 'deepseek-flash' },
  { name: '词元全含：大小写混合', keys: ['deepseek-flash'], model: 'DeepSeek-V4.1-Flash', expect: 'deepseek-flash' },
  { name: '词元全含：空格 + 大写 + 无点号', keys: ['deepseek-flash'], model: 'deepseek V41 fLaSh', expect: 'deepseek-flash' },
  { name: '②③ 合并评选：短键不抢占更具体的键', keys: ['flash', 'deepseek-flash'], model: 'deepseek-v4.1-flash-sg', expect: 'deepseek-flash' },
  { name: '②③ 合并评选：两键都在子串档也取最具体', keys: ['flash', 'deepseek-flash'], model: 'deepseek-flash-sg', expect: 'deepseek-flash' },
  { name: '① 同名单独先行（weight 再大也不抢）', keys: ['flash', 'DeepSeek-V41-Flash'], model: 'flash', expect: 'flash' },
  { name: '②③ 合并评选：取词元最多者', keys: ['deepseek-flash', 'deepseek-sg-flash'], model: 'deepseek v41 sg flash', expect: 'deepseek-sg-flash' },
  { name: '词元必须完全相等（flaslight 不认）', keys: ['flash-sg'], model: 'deepseek-flashlight-sg', expect: null },

  /* ---- 含数字的键只走同名 / 子串 ---- */
  { name: '含数字键不走词元档：v4-pro 不命 v4.1-pro', keys: ['deepseek-v4-pro'], model: 'deepseek-v4.1-pro', expect: null },
  { name: '含数字键不走词元档：v4-pro 不命 v41-pro', keys: ['deepseek-v4-pro'], model: 'deepseek-v41-pro', expect: null },
  { name: '含数字键不走词元档：v4-flash 不命 v41-flash', keys: ['v4-flash'], model: 'deepseek-v41-flash', expect: null },
  { name: '含数字键仍可靠子串命中', keys: ['Deepseek-V4.1-Flash'], model: 'deepseek-v4.1-flash-sg', expect: 'Deepseek-V4.1-Flash' },
  { name: '含数字键靠子串命中（seek-v4）', keys: ['seek-v4'], model: 'deepseek-v4.1-pro', expect: 'seek-v4' },
  { name: '带数字键并存也不误配', keys: ['deepseek-flash', 'deepseek-v4-pro'], model: 'deepseek-v4.1-pro', expect: null },
  { name: 'flash 不得命中有 pro 的模型', keys: ['deepseek-flash'], model: 'deepseek-v4.1-pro', expect: null },
  { name: '精确同名（不分大小写）', keys: ['DeepSeek-Flash'], model: 'deepseek-flash', expect: 'DeepSeek-Flash' },
  { name: '无关模型 → null', keys: ['deepseek-flash'], model: 'glm-5.3-flash', expect: null },

  /* ---- 未定价（整条全 0）---- */
  { name: '第一轮跳过全 0：用户的 1 号误建条目', keys: ['1', 'deepseek-flash'], blank: ['1'], model: 'deepseek-v4.1-flash-sg', expect: 'deepseek-flash' },
  { name: '第二轮回退：明确设 0 的条目仍生效', keys: ['mymodel'], blank: ['mymodel'], model: 'mymodel', expect: 'mymodel' },
];

/* ------------------------------------------------------------------ client 侧 */
function loadClient() {
  let code = fs.readFileSync(CLIENT, 'utf8');
  const marker = '\t\texports.apply = apply;';
  assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
  code = code.replace(marker,
    '\t\texports.__test = { priceOf, pickPriceKey, modelTokens, tokenMatches };\n' + marker);

  const fakeWindow = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }),
  };
  let captured = null;
  fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
  const sandbox = {
    window: fakeWindow,
    document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
    console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
  };
  sandbox.globalThis = sandbox;
  const reactStub = {
    createElement: () => ({}),
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useSyncExternalStore: (subscribe, snapshot) => snapshot(),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: Symbol('Fragment'),
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  return captured.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error('unexpected require: ' + name);
  }).__test;
}

const client = loadClient();

/* 词元切分与词元比对（client 侧直接可见） */
assert.deepStrictEqual(Array.from(client.modelTokens('DeepSeek-V4.1-Flash-SG')),
  ['deepseek', 'v4', '1', 'flash', 'sg'], 'modelTokens 按非字母数字切词并转小写');
assert.deepStrictEqual(Array.from(client.modelTokens('deepseek V41 fLaSh')),
  ['deepseek', 'v41', 'flash'], '空格是词元边界');
assert.deepStrictEqual(Array.from(client.modelTokens('_v41__flash-')), ['v41', 'flash'], '连续分隔符不产生空词元');
assert.deepStrictEqual(Array.from(client.modelTokens('')), [], '空名字没有词元');
assert.strictEqual(client.tokenMatches('flash', 'flash'), true, '完全相等才为真');
assert.strictEqual(client.tokenMatches('flash', 'flashlight'), false, '纯字母词元不许前缀包含');
assert.strictEqual(client.tokenMatches('v4', 'v41'), false, '含数字词元同样只认完全相等（前缀分支已删）');
assert.strictEqual(client.tokenMatches('v4', 'v4'), true, '完全相等');
assert.strictEqual(client.tokenMatches('v4', 'v3'), false, '不相同不为真');
console.log('client 词元规则：切词 / 完全相等 全部通过');

const clientKeys = CASES.map((one) => client.pickPriceKey(bookOf(one.keys, one.blank), one.model));
CASES.forEach((one, index) => {
  assert.strictEqual(clientKeys[index], one.expect,
    'client 匹配：' + one.name + ' → 期望 ' + String(one.expect) + '，实际 ' + String(clientKeys[index]));
});

/* 真实默认价目表（没配过自定义价）：含数字的 deepseek-v4-pro 不会再命中 v4.1-pro */
const defaultFlash = client.priceOf('deepseek-v4.1-flash-sg');
assert.ok(defaultFlash !== null, '默认价目表要能命中 deepseek-v4.1-flash-sg');
assert.strictEqual(defaultFlash.peak.input, 2, '命中的是官方 deepseek-flash 高峰输入价 2');
assert.strictEqual(defaultFlash.offPeak.input, 1, '空闲输入价 1');
assert.strictEqual(client.priceOf('deepseek-v4.1-pro'), null,
  'deepseek-v4-pro 含数字 ⇒ 不走词元档，命不中 v4.1-pro');
assert.strictEqual(client.priceOf('glm-5.3-flash'), null, '默认价目表里没有的模型仍返回 null');
console.log('client 默认价目表：v4.1-flash-sg → deepseek-flash；v4.1-pro → null（含数字键不走词元档）');

/* 已知边界（Lead 确认为预期，不做断言）：库里只剩那条全 0 的 `1` 时，
   `deepseek-v4.1-flash` 仍会在第二轮兜底命中 `1`（`1` 是它子串里的一个字符）→ 算 ¥0。
   只有书里另有一条有价的键时，第一轮才救得回来（见用例「第一轮跳过全 0」）。 */
console.log('边界（预期，非断言）：只有全 0 的 `1` 时 deepseek-v4.1-flash → '
  + String(client.pickPriceKey(bookOf(['1'], ['1']), 'deepseek-v4.1-flash')) + '（第二轮兜底 ⇒ ¥0）');

/* -------------------------------------------------------------------- host 侧 */
/* host 没有可调用的匹配入口，走 HTTP：一个键一份独有单价 ⇒ 记账算出来的钱能反推命中了哪个键。
   时间取「北京时间昨天 20:00」：一定空闲档，且一定落在近 7 天窗口里。 */
const BEIJING = 8 * 3600 * 1000;
const pad2 = (value) => (value < 10 ? '0' + String(value) : String(value));
const bjNow = new Date(Date.now() + BEIJING);
const AT = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 12, 0, 0);
const DAY = (() => {
  const one = new Date(AT + BEIJING);
  return one.getUTCFullYear() + '-' + pad2(one.getUTCMonth() + 1) + '-' + pad2(one.getUTCDate());
})();

function freshHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'dsh-status-bar'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
}
function writeSessionLog(sessionId, model) {
  const dir = path.join(HOME, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: 'assistant/message', seq: 1, time: AT,
    data: {
      turn: 1, step: 1,
      message: { source: { kind: 'model', provider: 'test-provider', model } },
      usage: { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    },
  });
  fs.writeFileSync(path.join(dir, 'usage.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8')));
}

(async () => {
  freshHome();
  process.env.DSH_HOME = HOME;

  const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
  assert.strictEqual(typeof mod.apply, 'function', 'apply exported');
  let handler = null;
  mod.apply({
    logger: { info: () => {} },
    effect: (fn) => fn(),
    sessionProjections: { register: () => () => {} },
    webServer: { register: (r) => { if (r.path === '/dsh-desktop-statusbar/api') handler = r.handler; return () => {}; } },
    credentials: undefined,
  });
  assert.ok(handler !== null, 'host 路由已注册');

  const hit = (pathname, options) => new Promise((resolve) => {
    const opts = options === undefined ? {} : options;
    let status = null, body = null;
    const res = { writeHead: (c) => { status = c; }, end: (t) => { body = t; } };
    const listeners = {};
    const req = {
      url: pathname,
      method: opts.method === undefined ? 'GET' : opts.method,
      on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
      destroy: () => {},
    };
    const pending = Promise.resolve(handler(req, res));
    if (opts.body !== undefined) (listeners.data || []).forEach((fn) => fn(opts.body));
    (listeners.end || []).forEach((fn) => fn());
    pending.then(() => resolve({ status, body: body === null ? null : JSON.parse(body) }));
  });
  const postPrices = (models) => hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', body: JSON.stringify({ models }) });
  const daily = () => hit('/dsh-desktop-statusbar/api/daily-usage?force=1');

  /* 先把 apply() 里那次预热扫描跑完（此时还是空目录），后面每个用例都是干净的一次扫描 */
  await daily();

  const hostKeys = [];
  for (let i = 0; i < CASES.length; i += 1) {
    const one = CASES[i];
    const isBlankKey = one.blank !== undefined && one.expect !== null && one.blank.indexOf(one.expect) !== -1;
    freshHome();
    writeSessionLog('session-match-' + String(i), one.model);
    await postPrices(bookOf(one.keys, one.blank));
    const payload = await daily();
    assert.strictEqual(payload.status, 200, 'daily-usage 200（' + one.name + '）');
    const day = payload.body.days.filter((d) => d.date === DAY)[0];
    assert.ok(day !== undefined, '有 ' + DAY + ' 的日桶（' + one.name + '）');
    const ledger = JSON.parse(fs.readFileSync(path.join(HOME, 'dsh-status-bar', 'usage-ledger.json'), 'utf8'));
    const unpriced = (ledger.days[DAY] || {}).unpriced;
    const hasUnpriced = unpriced !== undefined && unpriced[one.model] !== undefined;
    if (one.expect === null) {
      assert.strictEqual(day.cost, 0, 'host 匹配：' + one.name + ' 不该命中任何键，实际 cost=' + day.cost);
      assert.strictEqual(hasUnpriced, true, 'host 匹配：' + one.name + ' 命中不到价，用量要记进 unpriced');
      hostKeys.push(null);
    } else if (isBlankKey) {
      assert.strictEqual(day.cost, 0, 'host 匹配：' + one.name + ' 命中全 0 条目 ⇒ ¥0，实际 cost=' + day.cost);
      assert.strictEqual(unpriced, undefined, 'host 匹配：' + one.name + ' 命中了条目（哪怕是 0 价）就不该记欠账');
      hostKeys.push(one.expect);
    } else {
      assert.strictEqual(day.cost, MARKS[one.expect],
        'host 匹配：' + one.name + ' 应命中 ' + one.expect + '（¥' + MARKS[one.expect] + '），实际 cost=' + day.cost);
      assert.strictEqual(unpriced, undefined, 'host 匹配：' + one.name + ' 命中了价就不该有欠账');
      hostKeys.push(MARK_OF[day.cost]);
    }
    assert.strictEqual(day.total, M, 'host 记账：token 照记（' + one.name + '）');
    assert.strictEqual(day.calls, 1, 'host 记账：调用次数照记（' + one.name + '）');
  }

  /* 两侧逐例对齐：同一套输入必须得到同一个键 */
  CASES.forEach((one, index) => {
    assert.strictEqual(hostKeys[index], clientKeys[index],
      '两侧不一致：' + one.name + ' client=' + String(clientKeys[index]) + ' host=' + String(hostKeys[index]));
    console.log('= ' + one.name + '：' + one.model + ' → ' + String(one.expect === null ? 'null（记欠账）' : one.expect)
      + '（client / host 一致）');
  });

  console.log('');
  console.log('MODEL MATCH CHECKS PASSED（client 与 host 同一套输入、同一套结果）');
})().catch((error) => {
  console.error('MODEL MATCH CHECKS FAILED: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
