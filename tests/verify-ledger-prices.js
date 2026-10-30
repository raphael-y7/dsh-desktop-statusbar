/**
 * 台账按客户端价格库记账（台账 v3 + v3.1 匹配规则）：
 *   ① 没有客户端价格库时，回退到内置参考价 —— 且 v3.1 的词元匹配要能让内置键
 *      `deepseek-flash` 命中会话日志里的 `deepseek-v4.1-flash-sg`（版本号插在中间的那种），
 *      否则默认价等于白配；
 *   ② 客户端上报价格库后，**新**用量按客户端那份价目表记账；
 *   ③ 已经算好的历史 cost 一分不动：改价不重算历史，补价只结算欠账（响应体 settled）；
 *   ④ 价格库没变化时 POST 返回 changed=false，台账数字照旧。
 *
 * 背景（实测 2026-10-07）：活跃总览的 cost 是 host 扫会话日志时算好写进台账的，
 * 以前只认硬编码的 TOKEN_PRICES、而且只做精确名 + 子串匹配，用户在设置页加的
 * Deepseek-V4.1-Flash 在底栏能算、活跃总览却恒为 0；后来改成"价格一变就整本重扫"，
 * 又会把历史费用改写。现在的口径：历史只增不减，缺价的单独记欠账，匹配分三档。
 *
 * 用法：node tests/verify-ledger-prices.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');
const HOME = path.join(__dirname, '.dsh-test-home');

globalThis.setInterval = () => 0;

/* 造一份隔离的 DSH_HOME，里面放一条会话日志 */
const SESSIONS = path.join(HOME, 'sessions', 'session-test-1');
const LOG_FILE = path.join(SESSIONS, 'usage.jsonl.zstd');
fs.rmSync(path.join(HOME, 'sessions'), { recursive: true, force: true });
fs.rmSync(path.join(HOME, 'dsh-status-bar'), { recursive: true, force: true });
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(path.join(HOME, 'dsh-status-bar'), { recursive: true });
process.env.DSH_HOME = HOME;

const BEIJING = 8 * 3600 * 1000;
const pad2 = (value) => (value < 10 ? '0' + String(value) : String(value));
/** 北京时间（UTC+8）的日期键 'YYYY-MM-DD'。 */
function dateKeyOf(ms) {
  const one = new Date(ms + BEIJING);
  return one.getUTCFullYear() + '-' + pad2(one.getUTCMonth() + 1) + '-' + pad2(one.getUTCDate());
}

/* 北京时间「昨天 20:00」：20 点不在高峰窗（09-12 / 14-18）里 ⇒ 一定是空闲价；
   又永远落在 daily-usage 的近 7 天窗口内 —— 固定日期过几天就会跑到窗口外，测试会假失败。 */
const bjNow = new Date(Date.now() + BEIJING);
const AT = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 12, 0, 0);
const DAY = dateKeyOf(AT);

/* 一条 assistant/message 事件：模型是 WorkBuddy 上的 deepseek-v4.1-flash-sg */
function eventFor(seq, model, usage) {
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time: AT,
    data: {
      turn: 1,
      step: seq,
      message: { source: { kind: 'model', provider: 'workbuddy-ai', model } },
      usage,
    },
  });
}

/* 100 万未命中输入 + 100 万输出：便于心算核对 */
const USAGE = { inputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000000 };
let logged = [
  eventFor(1, 'deepseek-v4.1-flash-sg', USAGE),
  eventFor(2, 'deepseek-v4.1-flash', USAGE),
];
/** 写回会话日志（文件大小/mtime 变化 ⇒ 下次扫描会重读；台账按 seq 去重不会重复计）。 */
function writeLog(events) {
  fs.writeFileSync(LOG_FILE, zlib.zstdCompressSync(Buffer.from(events.join('\n') + '\n', 'utf8')));
}
writeLog(logged);

const ledgerFile = path.join(HOME, 'dsh-status-bar', 'usage-ledger.json');
const readLedgerFile = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));

/* 客户端上报的价格库：Deepseek-V4.1-Flash 空闲价 input 1 / output 2 ⇒ 1M+1M = ¥3 */
const BOOK_SMALL = {
  'deepseek-flash': {
    peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
  },
  'Deepseek-V4.1-Flash': {
    peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 2 },
  },
};
/* 同上但把 Deepseek-V4.1-Flash 的价格 ×3（验证「改价只影响新用量，不改历史」） */
const BOOK_TRIPLED = JSON.parse(JSON.stringify(BOOK_SMALL));
BOOK_TRIPLED['Deepseek-V4.1-Flash'] = {
  peak: { input: 6, cacheRead: 0.12, cacheWrite: 0, output: 24 },
  offPeak: { input: 3, cacheRead: 0.06, cacheWrite: 0, output: 6 },
};

(async () => {
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
  const dayOf = (payload) => payload.days.filter((d) => d.date === DAY)[0];

  /* ---------- 1. 没有客户端价格库：回退内置参考价，且词元匹配要命中 ---------- */
  /* 两个模型名都不是内置键本身：`deepseek-v4.1-flash-sg` / `deepseek-v4.1-flash` 与
     `deepseek-flash` 差着版本号。v3.1 的词元匹配（[deepseek, flash] 全含）必须命中，
     于是按内置空闲价 input 1 / output 4 记账：每笔 1M+1M = ¥5，两笔 ¥10。 */
  const before = await daily();
  assert.strictEqual(before.status, 200, 'daily-usage 200');
  const dayBefore = dayOf(before.body);
  assert.ok(dayBefore !== undefined, '有 ' + DAY + ' 的日桶');
  assert.strictEqual(dayBefore.cost, 10, '内置 deepseek-flash 的价要能命中这两个模型名（每笔 ¥5、两笔 ¥10），实际 ' + dayBefore.cost);
  assert.strictEqual(dayBefore.total, 4000000, '两笔 1M 输入 + 1M 输出都要记着，实际 ' + dayBefore.total);
  assert.strictEqual(dayBefore.calls, 2, '两次调用都要记着，实际 ' + dayBefore.calls);
  const ledgerAfterOne = readLedgerFile();
  assert.strictEqual(ledgerAfterOne.days[DAY].unpriced, undefined,
    '命中内置价就没有缺价欠账，实际 ' + JSON.stringify(ledgerAfterOne.days[DAY].unpriced));
  assert.ok(typeof ledgerAfterOne.priceFingerprint === 'string' && ledgerAfterOne.priceFingerprint.length > 0,
    '没收到客户端价格库时指纹记的是内置价目表');
  console.log('内置价 + 词元匹配：tokens=' + dayBefore.total + ' cost=' + dayBefore.cost
    + '（两笔各 ¥5，无欠账）');

  /* ---------- 2. 上报客户端价格库：没有欠账可结算，历史一分不动 ---------- */
  const posted = await postPrices(BOOK_SMALL);
  assert.strictEqual(posted.status, 200, 'prices POST 200');
  assert.strictEqual(posted.body.changed, true, '首次上报算变更');
  assert.strictEqual(posted.body.count, 2, '收到 2 条价格');
  const settled = posted.body.settled;
  assert.ok(settled !== null && typeof settled === 'object', '响应体要有 settled');
  assert.strictEqual(settled.entries, 0, '这次没有缺价欠账，不该结算任何条目，实际 ' + settled.entries);
  assert.strictEqual(settled.amount, 0, '也不该补记金额，实际 ' + settled.amount);
  const afterPost = dayOf((await daily()).body);
  assert.strictEqual(afterPost.cost, 10, '补价不改已经算好的历史 cost，实际 ' + afterPost.cost);
  assert.strictEqual(afterPost.total, 4000000, '补价不改 token，实际 ' + afterPost.total);
  console.log('上报客户端价格库：changed=true settled.entries=0，历史 cost 仍是 ¥' + afterPost.cost);

  /* ---------- 3. 新用量按客户端那份价目表记账（这就是当初修的核心） ---------- */
  /* 追加第三笔：同一个模型名 deepseek-v4.1-flash-sg，子串档命中键 Deepseek-V4.1-Flash
     ⇒ 空闲价 input 1 / output 2 = ¥3（不是内置价 ¥5） */
  logged = logged.concat([eventFor(3, 'deepseek-v4.1-flash-sg', USAGE)]);
  writeLog(logged);
  const afterAppend = dayOf((await daily()).body);
  assert.strictEqual(afterAppend.cost, 13, '¥10 历史 + 新用量 ¥3（客户端价）= ¥13，实际 ' + afterAppend.cost);
  assert.strictEqual(afterAppend.total, 6000000, '第三笔 token 照记，实际 ' + afterAppend.total);
  assert.strictEqual(afterAppend.calls, 3, '第三次调用照记，实际 ' + afterAppend.calls);
  console.log('新用量按客户端价：cost=' + afterAppend.cost + '（新那笔 ¥3，不是内置 ¥5）');

  /* ---------- 4. 价格没变时不该反复结算（契约 D） ---------- */
  const again = await postPrices(BOOK_SMALL);
  assert.strictEqual(again.body.changed, false, '同一份价格重报不算变更');
  assert.strictEqual(again.body.settled.entries, 0, '没变更就不该有欠账被结算');
  assert.strictEqual(again.body.settled.amount, 0, '没变更就不该有金额被补记');
  const afterSame = dayOf((await daily()).body);
  assert.strictEqual(afterSame.cost, 13, '同价重报后台账 cost 不变，实际 ' + afterSame.cost);
  assert.strictEqual(afterSame.total, 6000000, '同价重报后台账 token 不变，实际 ' + afterSame.total);
  assert.strictEqual(afterSame.calls, 3, '同价重报后台账 calls 不变，实际 ' + afterSame.calls);
  console.log('同价重报：changed=false，cost/tokens/calls 全部不变');

  /* ---------- 5. 改价不改历史，但影响之后的新用量（契约 C） ---------- */
  const tripled = await postPrices(BOOK_TRIPLED);
  assert.strictEqual(tripled.body.changed, true, '改价算变更');
  assert.strictEqual(tripled.body.settled.entries, 0, '已经没有欠账，改价不结算任何条目');
  assert.strictEqual(tripled.body.settled.amount, 0, '改价不补记任何金额');
  const afterTriple = dayOf((await daily()).body);
  assert.strictEqual(afterTriple.cost, 13, '价格×3 后历史 cost 必须仍是 ¥13（改价不改历史），实际 ' + afterTriple.cost);
  logged = logged.concat([eventFor(4, 'deepseek-v4.1-flash-sg', USAGE)]);
  writeLog(logged);
  const afterNew = dayOf((await daily()).body);
  assert.strictEqual(afterNew.cost, 22, '历史 ¥13 + 新笔按新价 ¥9（3+6）= ¥22，实际 ' + afterNew.cost);
  assert.strictEqual(afterNew.calls, 4, '第四笔调用照记，实际 ' + afterNew.calls);
  console.log('改价后：历史仍 ¥13，新用量按新价 → 合计 ¥' + afterNew.cost);

  /* ---------- 6. 台账里记下了价格指纹，供迁移回扫还原旧价目表（契约 H） ---------- */
  const ledger = readLedgerFile();
  assert.ok(typeof ledger.priceFingerprint === 'string' && ledger.priceFingerprint.length > 0, '台账带上价格指纹');
  /* v4（task-52）：台账版本升到 4，日桶开始写 costByCurrency 分币种金额 */
  assert.strictEqual(ledger.version, 4, '台账版本是 4（按币种分桶），实际 ' + ledger.version);
  assert.strictEqual(ledger.days[DAY].cost, 22, '台账里的 cost 已固化 ¥22，实际 ' + ledger.days[DAY].cost);
  console.log('台账指纹已落盘：' + ledger.priceFingerprint.slice(0, 60) + '…');

  /* ---------- 7. 价格上报与在途扫描不混价（换库与"读台账→结算→写盘"串在同一队列里） ---------- */
  /* 两个并发上报同一份价格库：恰好一个 changed=true。
     判据快照（模块级 `activePriceFingerprint`）在 queueLedgerJob 内读写，所以第二个请求
     一定是拿"第一个请求刚写下的"指纹去比 ⇒ false。以前快照取在入队之前，两个请求会
     双双报 true（残留），这里把它钉死。 */
  const [postA, postB] = await Promise.all([postPrices(BOOK_SMALL), postPrices(BOOK_SMALL)]);
  assert.strictEqual(postA.status, 200, '并发上报 A 返回 200');
  assert.strictEqual(postB.status, 200, '并发上报 B 返回 200');
  assert.deepStrictEqual([postA.body.changed, postB.body.changed].sort(), [false, true],
    '并发上报同一份价格库：恰好一个 changed=true，实际 '
    + JSON.stringify([postA.body.changed, postB.body.changed]));
  assert.strictEqual(postA.body.settled.entries + postB.body.settled.entries, 0,
    '并发上报时没有欠账可结算（settled 语义不变）');
  assert.strictEqual(postA.body.settled.amount + postB.body.settled.amount, 0, '也没有金额被补记');
  const concurrent = dayOf((await daily()).body);
  assert.strictEqual(concurrent.cost, 22, '并发上报后台账数字不变，实际 ' + concurrent.cost);
  assert.strictEqual(concurrent.total, 8000000, '并发上报不重记 token，实际 ' + concurrent.total);
  console.log('7 并发上报：A.changed=' + postA.body.changed + ' / B.changed=' + postB.body.changed
    + '（恰好一个 true，settled 与台账数字均不受影响）');

  console.log('');
  console.log('LEDGER PRICE CHECKS PASSED');
})().catch((error) => {
  console.error('LEDGER PRICE CHECKS FAILED: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
