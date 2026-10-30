/**
 * 台账 v3「历史不丢、只补欠账」端到端测试。
 *
 * 覆盖契约：
 *   A  缺价事件：token 与 calls 照记、cost 不变，用量记进 days[日期].unpriced[模型名]
 *      （按 peak/offPeak 两档各累计 input / cacheRead / cacheWrite / output 四项）
 *   B  补价：只结算 unpriced 里「现在能算出价」的条目，cost 加上对应金额、条目移除，
 *      响应体带 settled { entries, amount }
 *   D  价格库没变化时 POST → changed=false，台账数字不变
 *   E  删掉会话日志后再 force 拉 daily-usage，days 里的 token / cost / calls 一个都不许少
 *   F  v2 台账迁移 + 回扫：days 原样保留、unpricedBackfill='pending' → 下一次扫描回扫日志，
 *      用 priceFingerprint 还原的旧价目表判断「当时有没有价」：
 *        当时缺价、现在补价 → cost 补算（不重记 token）；
 *        仍缺价 → 进 unpriced 等以后补；
 *        当时有价的（seen 里已记账）→ 绝不重复计入
 *      （v1 变体：更早的台账连指纹都没有，此时按内置参考价判断，同样不许重复计入）
 *   G  主文件 usage-ledger.json 损坏/删除 → 回退同目录 usage-ledger.json.bak
 *   H  台账顶层字段齐全：version=3 / updatedAt / priceFingerprint / unpricedBackfill /
 *      days / seen / sessions / files
 *   J  台账被外部写坏时 /api/daily-usage 不许崩：days[key] 是 null / 'oops' / 0 / []、
 *      某天某个字段是 null、unpriced[模型] 是 null 或其某一档是 null、
 *      days 本身是字符串或数组 —— 十种坏法各跑一轮，每种都必须 200 + ok:true。
 *      （旧写法 `ledger.days[key] ?? 默认值` 只挡 null/undefined，挡不住 'oops' 与 0；
 *       `one = bucket[name]` 只判键在不在，unpriced[模型] 为 null 时 `one.offPeak` 直接抛。
 *       一抛，整条路由恒返回 ledger-failed，活跃总览永久打不开。契约来源：task-73 E 项。）
 *
 * 全程只在 tests/ 下的隔离目录里跑（.dsh-test-home-keep / -migrate / -v1 / -bak / -race /
 * -harden-1…10），
 * 绝不碰真实 ~/.dsh/dsh-status-bar/。
 * 用法：node tests/verify-ledger-keep.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const os = require('os');
const { pathToFileURL } = require('url');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');
const HOME_KEEP = path.join(__dirname, '.dsh-test-home-keep');      /* A/B/D/E/H */
const HOME_MIGRATE = path.join(__dirname, '.dsh-test-home-migrate'); /* F */
const HOME_BAK = path.join(__dirname, '.dsh-test-home-bak');        /* G */
const HOME_V1 = path.join(__dirname, '.dsh-test-home-v1');          /* F 的 v1 变体 */
const HOME_RACE = path.join(__dirname, '.dsh-test-home-race');      /* F 顺序变体 */
const HOME_LEGACY = path.join(__dirname, '.dsh-test-home-legacy');  /* F 回扫判据（当年规则） */
const HOME_BAK2 = path.join(__dirname, '.dsh-test-home-bak2');      /* G 的 .bak 污染补测 */
const HOME_BILL = path.join(__dirname, '.dsh-test-home-bill');      /* I：v4 分币种 + 迁移重扫 */
const HOME_YIELD = path.join(__dirname, '.dsh-test-home-yield');    /* I-7：让出事件循环 */

/* 契约 J：每种坏法各要一份**全新的 home + 全新的模块实例**（单变量隔离），
   所以给它留一组目录，编号即坏法编号。 */
const HOME_HARDEN = (n) => path.join(__dirname, '.dsh-test-home-harden-' + n);

globalThis.setInterval = () => 0;

/* setImmediate 计数桩：v4 重算（rebuildCostByDay）每 4 个文件让出一次事件循环，
   靠它证明"让出真的发生了"（否则重扫 197MB 会把宿主主线程钉住好几秒）。
   **必须在 import index.js 之前装**：模块里的 `setImmediate` 是全局查找，
   运行时替换全局即可被计数到。真实现仍调用原函数，不影响调度语义。 */
let immediateCalls = 0;
const realSetImmediate = globalThis.setImmediate;
globalThis.setImmediate = function patchedSetImmediate(fn, ...rest) {
	immediateCalls += 1;
	return realSetImmediate.call(this, fn, ...rest);
};

const BEIJING = 8 * 3600 * 1000;
const M = 1000000;
const pad2 = (value) => (value < 10 ? '0' + String(value) : String(value));
/** 北京时间（UTC+8）的日期键 'YYYY-MM-DD'。 */
function dateKeyOf(ms) {
  const one = new Date(ms + BEIJING);
  return one.getUTCFullYear() + '-' + pad2(one.getUTCMonth() + 1) + '-' + pad2(one.getUTCDate());
}
/** 北京时间某天某点 → epoch ms（month 从 0 起，day 允许 0 / 负数做跨月回退）。 */
function beijingStamp(y, m, d, hour) {
  return Date.UTC(y, m, d, hour - 8, 0, 0);
}

/* 北京时间「昨天 20:00」：20 点不在高峰窗（09-12 / 14-18）里 ⇒ 一定是空闲价；
   又永远落在 daily-usage 的近 7 天窗口内（固定日期过几天就会跑到窗口外，测试会假失败）。 */
const bjNow = new Date(Date.now() + BEIJING);
const AT = beijingStamp(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 20);
const DAY = dateKeyOf(AT);

const LEDGER_NAME = path.join('dsh-status-bar', 'usage-ledger.json');
const ledgerFileOf = (home) => path.join(home, LEDGER_NAME);
const readLedgerOf = (home) => JSON.parse(fs.readFileSync(ledgerFileOf(home), 'utf8'));

/** 重置一个隔离的 DSH_HOME（只动 tests/ 下的目录）。 */
function freshHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'dsh-status-bar'), { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  return home;
}

/** 造一条会话日志（zstd 帧）。返回文件绝对路径。 */
function writeSessionLog(home, sessionId, events) {
  const dir = path.join(home, 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const text = events.map((one) => JSON.stringify(one)).join('\n') + '\n';
  const file = path.join(dir, 'usage.jsonl.zstd');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  return file;
}

/** 一条 assistant/message 用量事件（turn/step 决定台账里的去重键）。 */
function usageEvent(seq, step, model, usage) {
  return {
    type: 'assistant/message',
    seq,
    time: AT,
    data: {
      turn: 1,
      step,
      message: { source: { kind: 'model', provider: 'test-provider', model } },
      usage,
    },
  };
}

const U1 = { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: M };

/* 官方参考价里的 deepseek-flash 空闲档：input 1 / output 4（CNY 每百万）⇒ 1M+1M = ¥5 */
const FLASH_OFFPEAK = { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 };
const FLASH_PEAK = { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 };
/* alpha-x 空闲档 input 3 / output 6 ⇒ 1M+1M = ¥9 */
const ALPHA_OFFPEAK = { input: 3, cacheRead: 0.06, cacheWrite: 0, output: 6 };
const ALPHA_PEAK = { input: 6, cacheRead: 0.12, cacheWrite: 0, output: 8 };
const BOOK_OLD = { 'deepseek-flash': { peak: FLASH_PEAK, offPeak: FLASH_OFFPEAK } };
const BOOK_ALPHA = {
  'deepseek-flash': { peak: FLASH_PEAK, offPeak: FLASH_OFFPEAK },
  'alpha-x': { peak: ALPHA_PEAK, offPeak: ALPHA_OFFPEAK },
};

/** 只取日桶里跟契约有关的数字，便于整体比对。 */
const numbersOf = (day) => ({
  input: day.input,
  cacheRead: day.cacheRead,
  cacheWrite: day.cacheWrite,
  output: day.output,
  total: day.total,
  calls: day.calls,
  cost: day.cost,
});

/** 台账文件里的日桶没有现成的 total（那是接口层算的），这里只取落盘的字段。 */
const ledgerNumbersOf = (day) => ({
  input: day.input,
  cacheRead: day.cacheRead,
  cacheWrite: day.cacheWrite,
  output: day.output,
  calls: day.calls,
  cost: day.cost,
});

(async () => {
  freshHome(HOME_KEEP);
  process.env.DSH_HOME = HOME_KEEP;

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

  /* 调一次路由。**reject 必须传出去**：契约 J 要断言「handler 的 Promise 不 reject」，
     旧写法 `pending.then(() => resolve(...))` 少了 reject 分支 —— handler 一 reject，
     外层 Promise 既不 resolve 也不 reject，测试会永久挂起而不是报红（挂起比红更难查）。 */
  const hit = (pathname, options) => new Promise((resolve, reject) => {
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
    pending.then(
      () => resolve({ status, body: body === null ? null : JSON.parse(body) }),
      (error) => reject(error),
    );
  });

  const postPrices = (models) => hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', body: JSON.stringify({ models }) });
  const daily = () => hit('/dsh-desktop-statusbar/api/daily-usage?force=1');
  const dayOf = (payload) => payload.days.filter((d) => d.date === DAY)[0];
  /** 按指定日期挑日桶（I 组用"今天/去年"两个日期，不能只认固定的 DAY） */
  const dayOn = (payload, key) => payload.days.filter((d) => d.date === key)[0];
  const useHome = (home) => { process.env.DSH_HOME = home; };

  /* ==================================================================
   * 契约 A：缺价先记欠账（tokens / calls 照记，cost 不变）
   * ================================================================== */
  /* 先让 apply 里的预热扫描跑完（此刻还没有会话日志），再报一份只有 deepseek-flash
     有价的价目表，最后才落日志 —— 这样「有价的那笔」与「缺价的那笔」同处一天。 */
  await daily();
  await postPrices(BOOK_OLD);
  writeSessionLog(HOME_KEEP, 'session-keep-a', [
    usageEvent(1, 1, 'deepseek-flash', U1),
    usageEvent(2, 2, 'alpha-x', U1),
  ]);

  const first = await daily();
  assert.strictEqual(first.status, 200, 'daily-usage 200');
  const dayA = dayOf(first.body);
  assert.ok(dayA !== undefined, '有 ' + DAY + ' 的日桶');
  assert.strictEqual(dayA.total, 2 * 2 * M, '两笔各 1M 输入 + 1M 输出都要记着，实际 ' + dayA.total);
  assert.strictEqual(dayA.calls, 2, '两次调用都要记着，实际 ' + dayA.calls);
  assert.strictEqual(dayA.cost, 5, '只有 deepseek-flash 那笔算得出价（空闲档 ¥5），实际 ' + dayA.cost);

  const ledgerA = readLedgerOf(HOME_KEEP);
  assert.strictEqual(ledgerA.days[DAY].cost, 5, '台账里 cost 也不含缺价那笔');
  const unpricedA = ledgerA.days[DAY].unpriced;
  assert.ok(unpricedA !== undefined && unpricedA !== null, '台账里要有 ' + DAY + ' 的 unpriced');
  assert.strictEqual(unpricedA['alpha-x'] !== undefined, true, 'alpha-x 缺价，要记进 unpriced');
  assert.strictEqual(unpricedA['deepseek-flash'], undefined, 'deepseek-flash 当时有价，不该进 unpriced');
  const alphaA = unpricedA['alpha-x'];
  assert.strictEqual(alphaA.offPeak.input, M, 'alpha-x 空闲档 input 欠账');
  assert.strictEqual(alphaA.offPeak.cacheRead, 0, 'alpha-x 空闲档 cacheRead 欠账');
  assert.strictEqual(alphaA.offPeak.cacheWrite, 0, 'alpha-x 空闲档 cacheWrite 欠账');
  assert.strictEqual(alphaA.offPeak.output, M, 'alpha-x 空闲档 output 欠账');
  const alphaPeakSum = alphaA.peak.input + alphaA.peak.cacheRead + alphaA.peak.cacheWrite + alphaA.peak.output;
  assert.strictEqual(alphaPeakSum, 0, '20:00 北京在空闲档，高峰档不该有欠账');
  console.log('A 缺价记欠账：calls=' + dayA.calls + ' tokens=' + dayA.total
    + ' cost=' + dayA.cost + '，unpriced.alpha-x.offPeak=' + JSON.stringify(alphaA.offPeak));

  /* 契约 H：台账顶层字段 */
  assert.strictEqual(ledgerA.version, 4, 'version=4（v4 起按币种分桶），实际 ' + ledgerA.version);
  assert.strictEqual(typeof ledgerA.updatedAt, 'number', 'updatedAt 是数字');
  assert.ok(ledgerA.updatedAt > 0, 'updatedAt 已写入，实际 ' + ledgerA.updatedAt);
  assert.strictEqual(typeof ledgerA.priceFingerprint, 'string', 'priceFingerprint 是字符串');
  assert.ok(ledgerA.priceFingerprint.length > 0, 'priceFingerprint 非空');
  assert.strictEqual(typeof ledgerA.unpricedBackfill, 'string', 'unpricedBackfill 是字符串');
  for (const field of ['days', 'seen', 'sessions', 'files']) {
    assert.ok(ledgerA[field] !== null && typeof ledgerA[field] === 'object', '顶层字段 ' + field + ' 存在');
  }
  console.log('H 顶层字段齐全：version=' + ledgerA.version
    + ' fingerprint=' + ledgerA.priceFingerprint.slice(0, 40) + '…');

  /* ==================================================================
   * 契约 B：补价只结算欠账
   * ================================================================== */
  const posted = await postPrices(BOOK_ALPHA);
  assert.strictEqual(posted.status, 200, 'prices POST 200');
  assert.strictEqual(posted.body.changed, true, '补上 alpha-x 的价格算变更');
  assert.ok(posted.body.settled !== null && typeof posted.body.settled === 'object', '响应体要有 settled');
  assert.strictEqual(posted.body.settled.entries, 1, '只结算 alpha-x 这一条欠账，实际 ' + posted.body.settled.entries);
  assert.strictEqual(posted.body.settled.amount, 9, 'alpha-x 空闲档 1M×3 + 1M×6 = ¥9，实际 ' + posted.body.settled.amount);

  const second = await daily();
  const dayB = dayOf(second.body);
  assert.strictEqual(dayB.cost, 14, '原 ¥5 + 欠账 ¥9 = ¥14，实际 ' + dayB.cost);
  assert.strictEqual(dayB.total, 4 * M, '结算不改 token 数，实际 ' + dayB.total);
  assert.strictEqual(dayB.calls, 2, '结算不改调用次数，实际 ' + dayB.calls);
  const ledgerB = readLedgerOf(HOME_KEEP);
  assert.ok(ledgerB.days[DAY].unpriced === undefined || ledgerB.days[DAY].unpriced['alpha-x'] === undefined,
    '结算完的欠账条目要从 unpriced 移除');
  console.log('B 补价只结算欠账：settled.entries=' + posted.body.settled.entries
    + ' settled.amount=' + posted.body.settled.amount + ' → 日 cost=' + dayB.cost + '（tokens 未变）');

  /* ==================================================================
   * 契约 D：价格库没变化 → changed=false，台账数字不变
   * ================================================================== */
  const again = await postPrices(BOOK_ALPHA);
  assert.strictEqual(again.body.changed, false, '同一份价格重报不算变更');
  assert.strictEqual(again.body.settled.entries, 0, '没变更就不该结算任何欠账');
  assert.strictEqual(again.body.settled.amount, 0, '没变更就不该补记任何金额');
  const third = await daily();
  const dayD = dayOf(third.body);
  assert.deepStrictEqual(numbersOf(dayD), numbersOf(dayB), 'changed=false 时台账数字不许动');
  console.log('D 同价重报：changed=false，台账数字不变（cost=' + dayD.cost + '）');

  /* 顺带再验一次「改价不改历史」：价格 ×3 后日 cost 仍是 ¥14 */
  const tripled = await postPrices({
    'deepseek-flash': { peak: FLASH_PEAK, offPeak: FLASH_OFFPEAK },
    'alpha-x': { peak: { input: 18, cacheRead: 0.36, cacheWrite: 0, output: 24 }, offPeak: { input: 9, cacheRead: 0.18, cacheWrite: 0, output: 18 } },
  });
  assert.strictEqual(tripled.body.changed, true, '改价算变更');
  assert.strictEqual(tripled.body.settled.amount, 0, '没有欠账时改价不补记金额');
  const fourth = await daily();
  const dayC = dayOf(fourth.body);
  assert.strictEqual(dayC.cost, 14, '改价后历史 cost 必须还是 ¥14，实际 ' + dayC.cost);
  console.log('C 复验：改价后历史 cost 不动（' + dayC.cost + '）');

  /* ==================================================================
   * 契约 E：删掉会话日志，历史数字一个都不许少
   * ================================================================== */
  const beforeDelete = dayOf((await daily()).body);
  const sessionDir = path.join(HOME_KEEP, 'sessions');
  fs.rmSync(sessionDir, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(sessionDir), false, '会话日志目录确实被删掉了');
  const afterDelete = dayOf((await daily()).body);
  assert.ok(afterDelete !== undefined, '日志删掉后日桶还在');
  assert.deepStrictEqual(numbersOf(afterDelete), numbersOf(beforeDelete),
    '删掉会话日志后 token / cost / calls 都不许变少');
  const ledgerE = readLedgerOf(HOME_KEEP);
  assert.strictEqual(ledgerE.days[DAY].calls, beforeDelete.calls, '台账文件里的 calls 也没缩水');
  assert.strictEqual(ledgerE.days[DAY].cost, 14, '台账文件里的 cost 也没缩水，实际 ' + ledgerE.days[DAY].cost);
  console.log('E 删日志不缩水：' + JSON.stringify(numbersOf(afterDelete)));

  /* ==================================================================
   * 契约 F：v2 台账迁移 + 回扫
   * ================================================================== */
  freshHome(HOME_MIGRATE);
  const logMigrate = writeSessionLog(HOME_MIGRATE, 'session-migrate', [
    usageEvent(1, 1, 'alpha-x', U1),        /* 当时缺价 */
    usageEvent(2, 2, 'deepseek-flash', U1), /* 当时有价（按旧价算过 ¥5） */
    usageEvent(3, 3, 'beta-y', U1),         /* 一直缺价 */
  ]);
  useHome(HOME_MIGRATE);

  /* 1) 先造一份「旧价目表」下记出来的台账：只有 deepseek-flash 有价 */
  await postPrices(BOOK_OLD);
  const migrateBase = await daily();
  const dayM0 = dayOf(migrateBase.body);
  assert.strictEqual(dayM0.cost, 5, '旧价目表下只有 deepseek-flash 算得出 ¥5，实际 ' + dayM0.cost);
  assert.strictEqual(dayM0.total, 6 * M, '三笔用量都记着，实际 ' + dayM0.total);
  assert.strictEqual(dayM0.calls, 3, '三次调用都记着，实际 ' + dayM0.calls);

  /* 2) 手写成 v2 台账：没有 unpriced 明细、没有 unpricedBackfill（旧版本就是这样的） */
  const v2 = readLedgerOf(HOME_MIGRATE);
  v2.version = 2;
  delete v2.unpricedBackfill;
  for (const key of Object.keys(v2.days)) delete v2.days[key].unpriced;
  fs.writeFileSync(ledgerFileOf(HOME_MIGRATE), JSON.stringify(v2), 'utf8');
  const written = readLedgerOf(HOME_MIGRATE);
  assert.strictEqual(written.version, 2, 'v2 台账已就位');
  assert.strictEqual(written.days[DAY].unpriced, undefined, 'v2 台账里没有欠账明细');
  assert.strictEqual(written.days[DAY].cost, 5, 'v2 台账里的 cost 是 ¥5');
  assert.ok(written.seen['session-migrate'].length === 3, 'v2 台账的 seen 记了三条事件');
  assert.ok(written.files[logMigrate] !== undefined, 'v2 台账的 files 记了日志文件');

  /* 3) 迁移后第一次扫描（此时价格库还是旧的：alpha-x / beta-y 仍缺价） */
  const migrated = await daily();
  const dayM1 = dayOf(migrated.body);
  assert.deepStrictEqual(numbersOf(dayM1), numbersOf(dayM0), '迁移 + 回扫不许改动历史 token / cost / calls');
  const ledgerM1 = readLedgerOf(HOME_MIGRATE);
  assert.strictEqual(ledgerM1.version, 4, '读入 v2 后台账版本升到 4，实际 ' + ledgerM1.version);
  assert.strictEqual(ledgerM1.unpricedBackfill, 'done', '回扫做过一次后标成 done，实际 ' + ledgerM1.unpricedBackfill);
  const unpricedM1 = ledgerM1.days[DAY].unpriced;
  assert.ok(unpricedM1 !== undefined, '回扫要把「当时缺价」的用量补进 unpriced');
  assert.ok(unpricedM1['alpha-x'] !== undefined, 'alpha-x 当时缺价 → 进 unpriced');
  assert.ok(unpricedM1['beta-y'] !== undefined, 'beta-y 当时缺价 → 进 unpriced');
  assert.strictEqual(unpricedM1['deepseek-flash'], undefined, '当时有价的 deepseek-flash 不该进 unpriced');
  assert.strictEqual(unpricedM1['alpha-x'].offPeak.input, M, '回扫补的 alpha-x input 欠账');
  assert.strictEqual(unpricedM1['alpha-x'].offPeak.output, M, '回扫补的 alpha-x output 欠账');
  assert.strictEqual(ledgerM1.days[DAY].cost, 5, '回扫本身不补钱（价格还没补），实际 ' + ledgerM1.days[DAY].cost);
  console.log('F 回扫（当时缺价 → 欠账）：unpriced=' + Object.keys(unpricedM1).join(',')
    + '，历史 cost 仍是 ' + ledgerM1.days[DAY].cost);

  /* 4) 用户补上 alpha-x 的价 → 结算回扫出来的欠账（只补 ¥9，不重记 token） */
  const settleBackfill = await postPrices(BOOK_ALPHA);
  assert.strictEqual(settleBackfill.body.settled.entries, 1, '结算回扫出来的 1 条欠账，实际 ' + settleBackfill.body.settled.entries);
  assert.strictEqual(settleBackfill.body.settled.amount, 9, '补算 alpha-x ¥9，实际 ' + settleBackfill.body.settled.amount);
  const afterBackfill = await daily();
  const dayM2 = dayOf(afterBackfill.body);
  assert.strictEqual(dayM2.cost, 14, '¥5（当时有价，不重复计）+ ¥9（当时缺价补算）= ¥14，实际 ' + dayM2.cost);
  assert.strictEqual(dayM2.total, 6 * M, '补算不改 token（三笔仍是 6M），实际 ' + dayM2.total);
  assert.strictEqual(dayM2.calls, 3, '补算不改 calls，实际 ' + dayM2.calls);
  const ledgerM2 = readLedgerOf(HOME_MIGRATE);
  assert.ok(ledgerM2.days[DAY].unpriced === undefined || ledgerM2.days[DAY].unpriced['alpha-x'] === undefined,
    '结算后的 alpha-x 欠账要移除');
  assert.ok(ledgerM2.days[DAY].unpriced !== undefined && ledgerM2.days[DAY].unpriced['beta-y'] !== undefined,
    '仍缺价的 beta-y 要留在 unpriced 等下次补价');
  console.log('F 补价后补算：cost=' + dayM2.cost + '（¥5 历史 + ¥9 补算，未重复计），'
    + '仍欠账=' + Object.keys(ledgerM2.days[DAY].unpriced).join(','));

  /* 5) 再补 beta-y 的价：回扫出来的欠账照样能结算 */
  const betaOffPeak = { input: 5, cacheRead: 0.1, cacheWrite: 0, output: 10 };
  const betaPeak = { input: 10, cacheRead: 0.2, cacheWrite: 0, output: 20 };
  const settleBeta = await postPrices({
    'deepseek-flash': { peak: FLASH_PEAK, offPeak: FLASH_OFFPEAK },
    'alpha-x': { peak: ALPHA_PEAK, offPeak: ALPHA_OFFPEAK },
    'beta-y': { peak: betaPeak, offPeak: betaOffPeak },
  });
  assert.strictEqual(settleBeta.body.settled.entries, 1, 'beta-y 一条欠账被结算，实际 ' + settleBeta.body.settled.entries);
  assert.strictEqual(settleBeta.body.settled.amount, 15, 'beta-y 空闲档 1M×5 + 1M×10 = ¥15，实际 ' + settleBeta.body.settled.amount);
  const finalM = dayOf((await daily()).body);
  assert.strictEqual(finalM.cost, 29, '¥14 + ¥15 = ¥29，实际 ' + finalM.cost);
  assert.strictEqual(finalM.total, 6 * M, 'token 依旧 6M，实际 ' + finalM.total);
  console.log('F 回扫欠账可继续结算：cost=' + finalM.cost);

  /* ==================================================================
   * 契约 G：主文件坏了 / 删了 → 回退 usage-ledger.json.bak
   * ================================================================== */
  freshHome(HOME_BAK);
  useHome(HOME_BAK);
  /* .bak 里的日桶放在「昨天」：保证落在 daily-usage 的近 7 天窗口里 */
  const DAY_BEFORE_BAK = DAY;
  const bakLedger = {
    version: 3,
    updatedAt: Date.now() - 3600 * 1000,
    priceFingerprint: '',
    unpricedBackfill: 'done',
    days: {
      [DAY_BEFORE_BAK]: {
        input: 1000, cacheRead: 20, cacheWrite: 30, output: 2000, calls: 7, cost: 42,
        peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      },
    },
    seen: {}, sessions: {}, files: {},
  };
  fs.writeFileSync(ledgerFileOf(HOME_BAK) + '.bak', JSON.stringify(bakLedger), 'utf8');
  fs.writeFileSync(ledgerFileOf(HOME_BAK), '{ 这不是合法 JSON', 'utf8');

  const fromBak = await daily();
  const dayG = fromBak.body.days.filter((d) => d.date === DAY_BEFORE_BAK)[0];
  assert.ok(dayG !== undefined, '主文件坏掉后要能从 .bak 读出日桶');
  assert.strictEqual(dayG.cost, 42, '回退读到的是 .bak 里的 ¥42，实际 ' + dayG.cost);
  assert.strictEqual(dayG.calls, 7, '回退读到的是 .bak 里的 7 次调用，实际 ' + dayG.calls);
  assert.strictEqual(dayG.total, 3050, '回退读到的是 .bak 里的 3050 token，实际 ' + dayG.total);
  console.log('G 主文件损坏回退 .bak：cost=' + dayG.cost + ' calls=' + dayG.calls);

  fs.rmSync(ledgerFileOf(HOME_BAK), { force: true });
  assert.strictEqual(fs.existsSync(ledgerFileOf(HOME_BAK)), false, '主文件已删除');
  const fromBak2 = await daily();
  const dayG2 = fromBak2.body.days.filter((d) => d.date === DAY_BEFORE_BAK)[0];
  assert.ok(dayG2 !== undefined, '主文件删掉后也要能从 .bak 读出日桶');
  assert.strictEqual(dayG2.cost, 42, '主文件删掉后回退读到 ¥42，实际 ' + dayG2.cost);
  console.log('G 主文件删除回退 .bak：cost=' + dayG2.cost);

  /* ==================================================================
   * 契约 F 补充：v2 台账「读入后」的落盘中间态
   *   version=3、unpricedBackfill='pending'、days 一个数字都不动。
   * 说明：daily-usage 的扫描在同一次请求里就把回扫做完了（pending → done），
   * 所以只有「价格上报」这条会读台账的路径能看到刚读入、还没回扫的状态。
   * ================================================================== */
  freshHome(HOME_RACE);
  writeSessionLog(HOME_RACE, 'session-race', [usageEvent(1, 1, 'gamma-z', U1)]);
  useHome(HOME_RACE);
  await postPrices(BOOK_OLD);            /* 旧价目表：没有 gamma-z */
  const raceBase = dayOf((await daily()).body);
  const raceLedger = readLedgerOf(HOME_RACE);
  raceLedger.version = 2;
  delete raceLedger.unpricedBackfill;
  for (const key of Object.keys(raceLedger.days)) delete raceLedger.days[key].unpriced;
  const v2DayNumbers = ledgerNumbersOf(raceLedger.days[DAY]);
  fs.writeFileSync(ledgerFileOf(HOME_RACE), JSON.stringify(raceLedger), 'utf8');

  /* 价格上报会读入这份 v2 台账（gamma-z 此时才有价） */
  const racePosted = await postPrices({
    'deepseek-flash': { peak: FLASH_PEAK, offPeak: FLASH_OFFPEAK },
    'gamma-z': { peak: { input: 4, cacheRead: 0.08, cacheWrite: 0, output: 8 }, offPeak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 4 } },
  });
  const migratedNow = readLedgerOf(HOME_RACE);
  assert.strictEqual(migratedNow.version, 4, 'v2 读入后版本号升到 4，实际 ' + migratedNow.version);
  assert.strictEqual(migratedNow.unpricedBackfill, 'pending', 'v2 读入后标成待回扫，实际 ' + migratedNow.unpricedBackfill);
  assert.deepStrictEqual(ledgerNumbersOf(migratedNow.days[DAY]), v2DayNumbers, '迁移不许动 days 里的数字');
  assert.ok(migratedNow.priceFingerprint.length > 0, 'v2 台账的价格指纹原样带过来了');
  console.log('F 补充：v2 读入后 version=3、unpricedBackfill=pending、days 原样保留');

  /* ------------------------------------------------------------------
   * 契约 F 的顺序变体：价格 POST 抢在首次回扫之前，欠账也不能丢。
   * 真实客户端挂载时就会 POST 价格库，与 host 启动扫描是并发关系；
   * 回扫只能靠台账里那份「上次记账用的旧价目表指纹」判断当时有没有价，
   * 价格上报如果抢先改写它，这笔钱就永远补不回来。
   * 这里断言结果：gamma-z 当时缺价（raceBase.cost=0），补价 + 回扫后按新价补算 ¥6（2+4），
   * token 只记一次，不留欠账。
   * ------------------------------------------------------------------ */
  const raceDay = dayOf((await daily()).body);
  assert.strictEqual(raceBase.cost, 0, '前置：v2 台账里 gamma-z 当时算不出钱（cost=0），实际 ' + raceBase.cost);
  assert.strictEqual(raceDay.cost, 6, 'POST 先到也要按新价补算 ¥6（空闲 2+4），实际 ' + raceDay.cost);
  assert.strictEqual(raceDay.total, 2 * M, '补算不重记 token，实际 ' + raceDay.total);
  assert.strictEqual(raceDay.calls, 1, '补算不重记调用次数，实际 ' + raceDay.calls);
  const raceUnpriced = (readLedgerOf(HOME_RACE).days[DAY] || {}).unpriced;
  assert.strictEqual(raceUnpriced, undefined, '补算完不该再留欠账，实际 ' + JSON.stringify(raceUnpriced));
  console.log('F 顺序变体：POST 先到 → changed=' + racePosted.body.changed
    + '，回扫仍按旧指纹判定缺价并补算 → cost=' + raceDay.cost);

  /* ==================================================================
   * 契约 F 补：回扫判"当时有没有价"必须用**当年那套规则**（精确键名 + 子串）。
   * 用新规则（词元全含）去判会把"当年因为命不中键而记 0"的用量当成"当时有价"跳过，
   * 那笔历史欠账就永远补不回来（独立审查报出的真实缺陷）。
   * 场景：v2 台账（没有指纹）+ 两条 seen 已记账、cost 都是 0 的事件 ——
   *   · `deepseek-v4.1-flash-sg`：当年精确键/子串都命不中 ⇒ 回扫后应进 unpriced；
   *   · `deepseek-flash`：当年精确命中内置键 ⇒ 判成"当时有价"，**不得**进 unpriced。
   * 当前价格库里只有 `zzz-x`，两条都算不出钱 ⇒ 回扫出来的欠账不会被立刻结算掉，能直接观察。
   * ================================================================== */
  freshHome(HOME_LEGACY);
  writeSessionLog(HOME_LEGACY, 'session-legacy', [
    usageEvent(1, 1, 'deepseek-v4.1-flash-sg', U1),
    usageEvent(2, 2, 'deepseek-flash', U1),
  ]);
  useHome(HOME_LEGACY);
  await postPrices({ 'zzz-x': { peak: { input: 4, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 } } });
  await daily();
  const legacyLedger = readLedgerOf(HOME_LEGACY);
  legacyLedger.version = 2;
  delete legacyLedger.priceFingerprint;
  delete legacyLedger.unpricedBackfill;
  for (const key of Object.keys(legacyLedger.days)) delete legacyLedger.days[key].unpriced;
  assert.strictEqual(legacyLedger.days[DAY].cost, 0, '前置：v2 台账里这两笔当时都算不出钱');
  fs.writeFileSync(ledgerFileOf(HOME_LEGACY), JSON.stringify(legacyLedger), 'utf8');

  const legacyAfter = dayOf((await daily()).body);
  assert.strictEqual(legacyAfter.cost, 0, '没有现价时回扫不该凭空补钱，实际 ' + legacyAfter.cost);
  const legacyUnpriced = readLedgerOf(HOME_LEGACY).days[DAY].unpriced;
  assert.ok(legacyUnpriced !== undefined && legacyUnpriced['deepseek-v4.1-flash-sg'] !== undefined,
    '当年命不中键、被记 0 的用量，回扫后要进 unpriced（不能用新规则判成"当时有价"跳过）');
  assert.strictEqual(legacyUnpriced['deepseek-flash'], undefined,
    '当年精确命中的用量算"当时有价"，回扫不该把它塞进 unpriced');
  console.log('F 回扫判据：当年命不中的进欠账、当年命中的不重复计');

  /* ==================================================================
   * 契约 G 补：主文件损坏 → 回退 .bak 成功；之后再落盘一次，.bak 里仍必须是**好数据**。
   * 旧实现写盘前会把主文件复制成 .bak，主文件坏着的时候就把坏 JSON 复制了进去，
   * 那份唯一备份当场被污染（独立审查报出的真实缺陷）。
   * ================================================================== */
  freshHome(HOME_BAK2);
  useHome(HOME_BAK2);
  const goodLedger = {
    version: 3,
    updatedAt: Date.now() - 3600 * 1000,
    priceFingerprint: '',
    unpricedBackfill: 'done',
    days: {
      [DAY]: {
        input: 1000, cacheRead: 20, cacheWrite: 30, output: 2000, calls: 7, cost: 42,
        peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      },
    },
    seen: {}, sessions: {}, files: {},
  };
  fs.writeFileSync(ledgerFileOf(HOME_BAK2) + '.bak', JSON.stringify(goodLedger), 'utf8');
  fs.writeFileSync(ledgerFileOf(HOME_BAK2), '{ 这不是合法 JSON', 'utf8');
  const bakFirst = dayOf((await daily()).body);
  assert.strictEqual(bakFirst.cost, 42, '前置：主文件坏了要先从 .bak 读到 ¥42，实际 ' + bakFirst.cost);

  /* 追加一条新用量逼一次落盘（writeLedger 会走"要不要把主文件复制成 .bak"这一步）。
     用一个当前价格库里没有的模型名：它只会进欠账、不加钱，方便断言 .bak 里的 ¥42 没被动过。 */
  writeSessionLog(HOME_BAK2, 'session-bak2', [usageEvent(1, 1, 'plain-model', U1)]);
  await daily();
  const bakRaw = fs.readFileSync(ledgerFileOf(HOME_BAK2) + '.bak', 'utf8');
  let bakParsed = null;
  try { bakParsed = JSON.parse(bakRaw); } catch (error) { bakParsed = null; }
  assert.ok(bakParsed !== null, '.bak 必须仍是合法 JSON（不能把损坏的主文件复制进去），实际 ' + bakRaw.slice(0, 40));
  assert.strictEqual(bakParsed.days[DAY].cost, 42, '.bak 里仍应是那份好数据（cost ¥42），实际 ' + bakParsed.days[DAY].cost);

  /* 再把主文件弄坏一次：仍要能从 .bak 恢复（坏数据没有把唯一备份吃掉） */
  fs.writeFileSync(ledgerFileOf(HOME_BAK2), '{ 又坏了', 'utf8');
  const bakSecond = dayOf((await daily()).body);
  assert.strictEqual(bakSecond.cost, 42, '再次损坏后仍要能从 .bak 恢复 ¥42，实际 ' + bakSecond.cost);
  console.log('G .bak 不被损坏内容污染：回退 → 落盘一次 → 再损坏仍可从 .bak 恢复');


  /* ==================================================================
   * 契约 F 的 v1 变体：比 v2 更早的台账没有 version / priceFingerprint。
   * 契约 F 的底线是「当时有价的（seen 中已记账）一律不重复计入」；
   * 没有指纹时实现按注释约定回退到内置参考价判断「当时有没有价」，
   * 这条对内置模型同样成立：迁移 + 回扫不许把已经算过的历史再算一遍。
   * 放在最后跑：它失败时前面的契约照样能报出结果。
   * ================================================================== */
  freshHome(HOME_V1);
  writeSessionLog(HOME_V1, 'session-v1', [usageEvent(1, 1, 'deepseek-flash', U1)]);
  useHome(HOME_V1);
  await postPrices(BOOK_OLD);
  const v1Base = dayOf((await daily()).body);
  assert.strictEqual(v1Base.cost, 5, 'v1 台账里 deepseek-flash 已经算过 ¥5，实际 ' + v1Base.cost);
  const v1Ledger = readLedgerOf(HOME_V1);
  delete v1Ledger.version;
  delete v1Ledger.priceFingerprint;
  delete v1Ledger.unpricedBackfill;
  for (const key of Object.keys(v1Ledger.days)) delete v1Ledger.days[key].unpriced;
  fs.writeFileSync(ledgerFileOf(HOME_V1), JSON.stringify(v1Ledger), 'utf8');

  const v1After = dayOf((await daily()).body);
  assert.deepStrictEqual(numbersOf(v1After), numbersOf(v1Base),
    '无指纹的老台账迁移后不许把已经算过的历史再补一遍（契约 F：当时有价的不重复计入）');
  console.log('F v1 变体：无指纹台账迁移后 cost=' + v1After.cost + '（历史未被重复计入）');

  /* ==================================================================
   * 契约 I（task-52）：按币种分桶 + v4 迁移重扫
   *   用户要求：活跃总览的金额"各自算各自"，美元 7.77 + 人民币 145.66
   *   要显示成 ¥145.66+$7.77，而不是把两个数直接加成一个混合值。
   *   三条红线：写盘前备份 / 绝不清空 days / 重扫失败的天不许变 0。
   * ================================================================== */
  freshHome(HOME_BILL);
  useHome(HOME_BILL);

  const BIJ = 8 * 3600 * 1000;
  const bijKey = (ms) => dateKeyOf(ms);
  const bijStamp = (daysAgo, hour) => {
    const n = new Date(Date.now() + BIJ);
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - daysAgo, hour - 8, 0, 0);
  };
  /* 今年内的一天（落在重扫窗口里）与去年的一天（**在**窗口外） */
  const TODAY_AT = bijStamp(1, 20);
  const TODAY_KEY = bijKey(TODAY_AT);
  const LAST_YEAR_AT = (() => {
    const n = new Date(Date.now() + BIJ);
    /* 去年 12 月 20 日：一定在「今年 1 月 1 日」之前 ⇒ 重扫永远覆盖不到 */
    return Date.UTC(n.getUTCFullYear() - 1, 11, 20, 12, 0, 0);
  })();
  const LAST_YEAR_KEY = bijKey(LAST_YEAR_AT);

  /* 人民币模型（alpha-cny，CNY）与美元模型（beta-usd，USD）各一笔，同一天 */
  const CNY_MODEL = 'alpha-cny';
  const USD_MODEL = 'beta-usd';
  const BOOK_TWO = {
    [CNY_MODEL]: { currency: 'CNY', peak: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 } },
    [USD_MODEL]: { currency: 'USD', peak: { input: 7.77, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 7.77, cacheRead: 0, cacheWrite: 0, output: 0 } },
  };
  /* 人民币：1M input × 100/1M = ¥100；美元：1M input × 7.77/1M = $7.77 */
  const evCny = (seq) => ({ type: 'assistant/message', seq, time: TODAY_AT, data: { turn: 1, step: seq, message: { source: { kind: 'model', provider: 'p', model: CNY_MODEL } }, usage: { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } });
  const evUsd = (seq) => ({ type: 'assistant/message', seq, time: TODAY_AT, data: { turn: 1, step: seq, message: { source: { kind: 'model', provider: 'p', model: USD_MODEL } }, usage: { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } } });
  writeSessionLog(HOME_BILL, 'mix-session', [evCny(1), evUsd(2)]);

  /* 预置一份 v3 老台账：去年那天有 cost（重扫窗口外）、今年这天也有 cost（会被重扫） */
  const legacyDays = {
    [LAST_YEAR_KEY]: {
      input: 500, cacheRead: 0, cacheWrite: 0, output: 0, calls: 3, cost: 88.88,
      peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
    [TODAY_KEY]: {
      input: 2 * M, cacheRead: 0, cacheWrite: 0, output: 0, calls: 2, cost: 107.77,
      peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  };
  const v3Ledger = {
    version: 3, updatedAt: Date.now() - 60000, priceFingerprint: '',
    unpricedBackfill: 'done',
    days: legacyDays,
    seen: {}, sessions: {}, files: {},
  };
  fs.writeFileSync(ledgerFileOf(HOME_BILL), JSON.stringify(v3Ledger), 'utf8');

  /* 先报价格库（v4 迁移发生在读台账时，价格库要在扫描前就位，否则算不出钱） */
  const postedTwo = await postPrices(BOOK_TWO);
  assert.strictEqual(postedTwo.status, 200, '混币价格库上报成功');

  const mixed = await daily();
  const dayMix = dayOf(mixed.body);
  assert.ok(dayMix !== undefined, '混币日桶存在');

  /* 契约 I-1：同一天既有美元模型又有人民币模型 ⇒ 两个独立数 */
  assert.deepStrictEqual(dayMix.costByCurrency, { CNY: 100, USD: 7.77 },
    'costByCurrency 必须是 {CNY:100, USD:7.77} 两个独立数，实际 ' + JSON.stringify(dayMix.costByCurrency));
  /* 契约 I-4：cost 仍是两币种之和（老字段语义一个字不动） */
  assert.strictEqual(dayMix.cost, 107.77, 'cost 仍是 100 + 7.77 = 107.77（老客户端照旧读它），实际 ' + dayMix.cost);
  console.log('I-1 混币日桶：costByCurrency=' + JSON.stringify(dayMix.costByCurrency) + ' · cost=' + dayMix.cost);

  /* 契约 I-2：重扫窗口外（去年）的那天，cost 与迁移前一致 —— **绝不被清零** */
  const lastYearLedger = readLedgerOf(HOME_BILL).days[LAST_YEAR_KEY];
  assert.ok(lastYearLedger !== undefined, '去年那天的日桶还在（days 不许被清空）');
  assert.strictEqual(lastYearLedger.cost, 88.88,
    '【证据 1】重扫窗口外的天 cost 迁移前后一致（88.88），实际 ' + lastYearLedger.cost);
  assert.strictEqual(lastYearLedger.input, 500, '去年的 token 一个都不许丢，实际 ' + lastYearLedger.input);
  assert.strictEqual(lastYearLedger.calls, 3, '去年的 calls 一个都不许丢，实际 ' + lastYearLedger.calls);
  console.log('I-2 【证据1】窗口外（' + LAST_YEAR_KEY + '）cost=' + lastYearLedger.cost
    + ' token=' + lastYearLedger.input + ' calls=' + lastYearLedger.calls + '（迁移前后一致）');

  /* 契约 I-3：v4 迁移后台账版本、标记、token 不丢 */
  const billLedger = readLedgerOf(HOME_BILL);
  assert.strictEqual(billLedger.version, 4, '迁移后台账版本是 4，实际 ' + billLedger.version);
  assert.strictEqual(billLedger.costByCurrencyBackfill, 'done', '重扫跑完标记成 done，实际 ' + billLedger.costByCurrencyBackfill);
  assert.strictEqual(billLedger.days[TODAY_KEY].legacyCost, 107.77,
    '迁移时给有 cost 的天存了快照，实际 ' + String(billLedger.days[TODAY_KEY].legacyCost));
  /* 只有 cost > 0 的天才存快照（体积控制） */
  assert.strictEqual(billLedger.days[LAST_YEAR_KEY].legacyCost, 88.88, '去年那天也有快照');
  console.log('I-3 v4 迁移：version=' + billLedger.version + ' backfill=' + billLedger.costByCurrencyBackfill
    + ' legacyCost(今天)=' + billLedger.days[TODAY_KEY].legacyCost);

  /* 契约 I-3b：磁盘上必须有 .bak 备份（写盘前备份红线） */
  assert.ok(fs.existsSync(ledgerFileOf(HOME_BILL) + '.bak'), '写盘前必须留下 .bak 备份');
  console.log('I-3b 备份存在：' + path.basename(ledgerFileOf(HOME_BILL)) + '.bak');

  /* 契约 I-5：本周 / 当月 / 当年三处聚合都带 costByCurrency */
  assert.ok(mixed.body.totals.costByCurrency !== undefined && mixed.body.totals.costByCurrency !== null,
    'totals 要带 costByCurrency');
  assert.strictEqual(mixed.body.totals.costByCurrency.CNY, 100, '本周 totals 的人民币合计，实际 ' + JSON.stringify(mixed.body.totals.costByCurrency));
  assert.strictEqual(mixed.body.totals.costByCurrency.USD, 7.77, '本周 totals 的美元合计');
  const monthOfDay = mixed.body.month.days.filter((d) => d.date === TODAY_KEY)[0];
  assert.ok(monthOfDay !== undefined, '当月里找得到今天');
  assert.deepStrictEqual(monthOfDay.costByCurrency, { CNY: 100, USD: 7.77 }, '当月每天的 costByCurrency 正确');
  const yearMonth = mixed.body.year.months[new Date(TODAY_AT + BIJ).getUTCMonth()];
  assert.ok(yearMonth !== undefined, '当年里找得到这个月');
  assert.strictEqual(yearMonth.costByCurrency.CNY, 100, '当年该月的 CNY 合计，实际 ' + JSON.stringify(yearMonth.costByCurrency));
  assert.strictEqual(yearMonth.costByCurrency.USD, 7.77, '当年该月的 USD 合计');
  console.log('I-5 三处聚合都带 costByCurrency：周 ' + JSON.stringify(mixed.body.totals.costByCurrency)
    + ' · 月未定义项 ' + JSON.stringify(monthOfDay.costByCurrency) + ' · 年 ' + JSON.stringify(yearMonth.costByCurrency));

  /* 契约 I-6【证据 2】：重扫时日志已删的天，cost 不许被清零 —— legacyCost 顶回去。
     必须真的让重扫发生一次（把标记打回 pending），否则走的是增量、什么都没重算，
     那样这条断言等于没测（踩过：删了日志但标记已 done，cost 保持原值纯属"没动过"）。 */
  fs.rmSync(path.join(HOME_BILL, 'sessions', 'mix-session'), { recursive: true, force: true });
  const beforeDeleteI = readLedgerOf(HOME_BILL);
  beforeDeleteI.costByCurrencyBackfill = "pending"
  beforeDeleteI.files = {}
  fs.writeFileSync(ledgerFileOf(HOME_BILL), JSON.stringify(beforeDeleteI), "utf8")
  const afterDeleteI = await daily();
  const dayAfterDelete = dayOn(afterDeleteI.body, TODAY_KEY);
  assert.ok(dayAfterDelete !== undefined, '日志删掉后日桶仍在');
  assert.strictEqual(dayAfterDelete.cost, 107.77,
    '【证据 2】日志已删的天 cost 保持不变（legacyCost 兜底），实际 ' + dayAfterDelete.cost);
  /* 日志没了 ⇒ 分不出币种。这里只钉住"cost 绝不被清零"，
     costByCurrency 可能是空、也可能残留上一次的值 —— 两者对客户端都安全
     （有值就按值显示，没值走「¥ + 混合数」），所以不做强断言。 */
  console.log('I-6 【证据2】日志删掉后重扫 cost=' + dayAfterDelete.cost + '（legacyCost 顶回，未变 0）');

  /* 契约 I-7【task-55】：v4 重算不许把宿主主线程钉住。
     判据是**用户体感**，不是实现细节：重算期间主线程最长一次不被让出多久。
     （这里曾经数 setImmediate 调用次数、要求"每 4 个文件让出一次"，
     那是旧同步实现的细节；解压改异步后 `await` 本身就是让出点，
     文件间那套让出已删除，旧计数断言只会永远红。） */
  freshHome(HOME_YIELD);
  useHome(HOME_YIELD);

  const YIELD_FILES = 20;
  /* 每个文件塞够多的用量事件，让"同步解压一段"有可测量的耗时 */
  for (let i = 1; i <= YIELD_FILES; i += 1) {
    const events = [];
    for (let k = 1; k <= 300; k += 1) {
      events.push(usageEvent(k, k, CNY_MODEL, { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }));
    }
    writeSessionLog(HOME_YIELD, 'yield-' + i, events);
  }
  /* 预置一份 v3 台账（触发 v4 重算） */
  const yieldLedger = {
    version: 3, updatedAt: Date.now() - 60000, priceFingerprint: '',
    unpricedBackfill: 'done', days: {}, seen: {}, sessions: {}, files: {},
  };
  fs.writeFileSync(ledgerFileOf(HOME_YIELD), JSON.stringify(yieldLedger), 'utf8');
  await postPrices(BOOK_TWO);

  /* 计时探针：记录"两次采样之间的最大间隔"= 最长同步块。
     **不能用 setInterval**：本文件顶部把 `globalThis.setInterval` 换成了空实现
     （防止插件的定时器把进程吊住），用它采样会拿到全 0。
     改用 `setTimeout` 自递归 —— 回调只在主线程空闲时才执行，
     相邻两次回调的间隔即一段同步执行的时长。 */
  let blockStart = Date.now();
  let longestBlock = 0;
  let sampling = true;
  const sample = () => {
    if (sampling !== true) return;
    const now = Date.now();
    const spent = now - blockStart;
    if (spent > longestBlock) longestBlock = spent;
    blockStart = now;
    setTimeout(sample, 1);
  };
  setTimeout(sample, 1);
  immediateCalls = 0;
  const yieldStarted = Date.now();
  const yieldRun = await daily();
  const yieldTotal = Date.now() - yieldStarted;
  sampling = false;
  const tailBlock = Date.now() - blockStart;
  if (tailBlock > longestBlock) longestBlock = tailBlock;

  assert.ok(yieldRun.status === 200 && yieldRun.body.ok === true, '重算这轮 daily-usage 正常返回');
  /* 这里曾经断言「每 4 个文件 setImmediate 一次（≥5 次）」，那是**旧实现的细节**。
     解压改成异步之后，`await` 本身就是让出点，文件间那套让出已删除（YIELD_SLICE_MS 已移除），
     所以 setImmediate 只被调用 1 次 —— 旧断言测的是一个不存在的实现，只会永远红。
     改成测**用户真正关心的东西**：重算期间主线程最长一次不被让出多久。
     实测该值从同步时代的 1188ms 降到 200ms 量级；100ms 是"用户几乎无感"的阈值。 */
  assert.ok(longestBlock < 100,
    '重算期间最长同步块应 < 100ms（界面不卡），实际 ' + longestBlock + ' ms');
  console.log('I-7 让出：' + YIELD_FILES + ' 个文件重算 ⇒ 最长单次同步块 ' + longestBlock
    + ' ms / 总耗时 ' + yieldTotal + ' ms · setImmediate 调用 ' + immediateCalls + ' 次（仅供参考，不断言）');

  /* ==================================================================
   * 契约 J（task-73 E 项）：台账被外部写坏，/api/daily-usage 不许崩。
   *
   * 要防的是这条链：坏值 → 记账时抛 TypeError → queueLedgerJob 的 Promise reject
   * → 路由 catch 成 `{ ok: false, reason: 'ledger-failed' }` → 活跃总览永久打不开，
   * 用户只能手删台账文件。所以每种坏法的判据都是**同一件事故的入口与出口**：
   *   ① `hitWith()` 返回的 Promise 不许 reject（handler 自己不许抛）；
   *   ② HTTP 200 且 `ok: true`（不许退化成 ledger-failed）。
   *
   * 为什么十种坏法各跑一轮、而不是塞进同一份台账：第一处抛错就中断整轮，
   * 后面的坏法根本没被执行 —— 一盏灯只能证明一种坏法。
   *
   * **单变量隔离**：每种坏法重新载入一次 host 模块（模块级缓存 weekUsageCache /
   * weekUsageScan / activePriceBook 都必须是干净的），并用一个新的隔离 home。
   * 重载用的是 lib/index.js 的**源码副本**：模块一旦加载，内容已在内存里，
   * 副本只用来骗过 ESM 的 URL 缓存（同 URL 再 import 直接拿旧实例）。
   * 副本与源文件逐字相同（只把相对 import 换成绝对 file URL），绝不改 lib/。
   * ================================================================== */
  const INDEX_SRC = fs.readFileSync(INDEX, 'utf8');
  /* lib/index.js 里 `from './balance-api.js'` 这类相对路径，在副本所在目录（隔离 home）里
     会解析失败 ⇒ 换成绝对 file URL。只动 import 说明符，不动任何逻辑。 */
  const INDEX_FOR_COPY = INDEX_SRC.replace(/from '(\.\/[^']+)'/g, (whole, rel) => {
    return "from '" + pathToFileURL(path.join(path.dirname(INDEX), rel)).href + "'";
  });

  /** 载入一份全新的模块实例并挂上路由（照抄本文件顶部 apply 的写法）。 */
  async function loadHost(home) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, 'dsh-status-bar'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    useHome(home);
    const copy = path.join(home, 'index.copy.mjs');
    fs.writeFileSync(copy, INDEX_FOR_COPY, 'utf8');
    const fresh = await import(pathToFileURL(copy).href + '?v=' + Date.now() + '-' + Math.random());
    let route = null;
    fresh.apply({
      logger: { info: () => {} },
      effect: (fn) => fn(),
      sessionProjections: { register: () => () => {} },
      webServer: { register: (r) => { if (r.path === '/dsh-desktop-statusbar/api') route = r.handler; return () => {}; } },
      credentials: undefined,
    });
    assert.ok(route !== null, '隔离实例的 host 路由已注册');
    return route;
  }

  /** 用指定 handler 调一次路由：reject 直接抛给调用方（契约 J 的第 ① 条判据）。 */
  function hitWith(route, pathname) {
    return new Promise((resolve, reject) => {
      let status = null, body = null;
      const res = { writeHead: (c) => { status = c; }, end: (t) => { body = t; } };
      const req = { url: pathname, method: 'GET', on: () => req, destroy: () => {} };
      Promise.resolve(route(req, res)).then(
        () => resolve({ status, body: body === null ? null : JSON.parse(body) }),
        (error) => reject(error),
      );
    });
  }

  const HARDEN_URL = '/dsh-desktop-statusbar/api/daily-usage?force=1';
  const HARDEN_MODEL = 'alpha-x';   /* 内置价目表里没有它 ⇒ 一定走 addUnpriced */

  /** 往隔离 home 里放一条会话日志：一条缺价模型的用量事件（一定会走 addUnpriced）。 */
  function writeHardenLog(home, tag, at) {
    writeSessionLog(home, tag, [{
      type: 'assistant/message',
      seq: 1,
      time: at,
      data: {
        turn: 1, step: 1,
        message: { source: { kind: 'model', provider: 'p', model: HARDEN_MODEL } },
        usage: U1,
      },
    }]);
  }

  /* 坏值必须落在"记账真的会读到它"的那一天、那一档：
       · 当天日期要在近 7 天窗口里（否则主循环连看都不看）；
       · 事件要落在**北京工作日高峰窗**里（09-12 / 14-18），isPeakTime 才是 true，
         才会同时走到 `days[key].peak` 与 `unpriced[模型].peak` 两个分支 —— 坏法 6 / 8 才真被读到。
     "哪种时点是高峰"不在这里另抄一份节假日表去猜（抄了就会与 host 漂移）：
     直接**实测**——拿一份干净台账跑一遍，看 host 自己把 peak 记成了几。 */
  const HARDEN_AT = (() => {
    const now = Date.now();
    const bjNow = new Date(now + BEIJING);
    const candidates = [];
    for (let back = 0; back < 7; back += 1) {
      /* 同一北京日期的 10:00 与 15:00 各试一次：至少有一个落在高峰窗里 */
      for (const hour of [10, 15]) {
        const at = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - back, hour, 0, 0) - BEIJING;
        if (at > now - 60 * 1000) continue;
        candidates.push(at);
      }
    }
    return candidates;
  })();

  const HARDEN_DAY = await (async () => {
    const probeHome = HOME_HARDEN('probe');
    const probeRoute = await loadHost(probeHome);
    await hitWith(probeRoute, HARDEN_URL);      /* 先让预热扫描跑完（空 home） */
    const events = HARDEN_AT.map((at, i) => ({
      type: 'assistant/message',
      seq: i + 1,
      time: at,
      data: {
        turn: 1, step: i + 1,
        message: { source: { kind: 'model', provider: 'p', model: HARDEN_MODEL } },
        usage: U1,
      },
    }));
    writeSessionLog(probeHome, 'harden-probe', events);
    await hitWith(probeRoute, HARDEN_URL);
    const probeLedger = readLedgerOf(probeHome);
    const hitKey = Object.keys(probeLedger.days).filter((key) => {
      const day = probeLedger.days[key];
      return day !== null && typeof day === 'object' && day.peak !== null && typeof day.peak === 'object'
        && Number(day.peak.input) > 0;
    })[0];
    assert.ok(hitKey !== undefined,
      '契约 J 前置：近 7 天内找不到被 host 判成高峰的时点（peak 全为 0），无法覆盖坏法 6 / 8');
    return hitKey;
  })();

  /* 底座台账的日期就用实测出来的那一天：坏值正好落在会被记账读到的那一格。 */
  const baseLedger = () => ({
    version: 4,
    updatedAt: Date.now() - 3600 * 1000,
    priceFingerprint: '',
    unpricedBackfill: 'done',
    costByCurrencyBackfill: 'done',
    days: {
      [HARDEN_DAY]: {
        input: 2 * M, cacheRead: 0, cacheWrite: 0, output: M, calls: 2, cost: 5,
        peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unpriced: {
          [HARDEN_MODEL]: {
            peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
            offPeak: { input: M, cacheRead: 0, cacheWrite: 0, output: M },
          },
        },
      },
    },
    seen: {}, sessions: {}, files: {},
  });

  /* 十种坏法。**一种一条，不许合并、不许删**：合并会互相遮挡（第一处抛错后面就不跑了）。 */
  const BROKEN_LEDGERS = [
    { n: 1, name: 'days[key] = null', build: () => { const l = baseLedger(); l.days[HARDEN_DAY] = null; return l; } },
    { n: 2, name: "days[key] = 'oops'", build: () => { const l = baseLedger(); l.days[HARDEN_DAY] = 'oops'; return l; } },
    { n: 3, name: 'days[key] = 0', build: () => { const l = baseLedger(); l.days[HARDEN_DAY] = 0; return l; } },
    { n: 4, name: 'days[key] = []', build: () => { const l = baseLedger(); l.days[HARDEN_DAY] = []; return l; } },
    { n: 5, name: 'days[key].input = null', build: () => { const l = baseLedger(); l.days[HARDEN_DAY].input = null; return l; } },
    { n: 6, name: 'days[key].peak = null', build: () => { const l = baseLedger(); l.days[HARDEN_DAY].peak = null; return l; } },
    { n: 7, name: 'days[key].unpriced[model] = null', build: () => { const l = baseLedger(); l.days[HARDEN_DAY].unpriced[HARDEN_MODEL] = null; return l; } },
    { n: 8, name: 'days[key].unpriced[model].peak = null', build: () => { const l = baseLedger(); l.days[HARDEN_DAY].unpriced[HARDEN_MODEL].peak = null; return l; } },
    { n: 9, name: 'ledger.days 本身是字符串', build: () => { const l = baseLedger(); l.days = 'oops'; return l; } },
    { n: 10, name: 'ledger.days 是数组', build: () => { const l = baseLedger(); l.days = []; return l; } },
  ];

  const hardenResults = [];
  for (const one of BROKEN_LEDGERS) {
    const tag = '契约 J-' + one.n + '（' + one.name + '）';
    const home = HOME_HARDEN(one.n);
    const route = await loadHost(home);
    /* 先把 apply 里的预热扫描跑完（此刻 home 是空的，什么都扫不到）。
       顺序很关键：**必须在预热之后**才写坏台账 —— 否则预热会读到坏台账、
       按修复逻辑把它重写回磁盘，路由随后读到的是修好的那份，测试会假绿。 */
    await hitWith(route, HARDEN_URL);
    /* 只写这一种坏台账 —— 单变量 */
    fs.writeFileSync(ledgerFileOf(home), JSON.stringify(one.build()), 'utf8');
    /* 再放一条"正在发生"的新用量：没有它，主循环整份跳过、坏值读都读不到（假绿） */
    writeHardenLog(home, 'harden-' + one.n, HARDEN_AT[0]);

    /* ①② 一次拿全：hitWith 的 reject 直接冒到这里，不在测试里吞掉。 */
    let res = null;
    try {
      res = await hitWith(route, HARDEN_URL);
    } catch (error) {
      /* 这里是**重抛**（补上坏法名字），不是吞掉：路由 reject 必须让整轮测试红。 */
      throw new Error(tag + ' 路由 handler 抛了错（应该自己兜住）：'
        + String(error && error.message ? error.message : error));
    }
    assert.strictEqual(res.status, 200, tag + ' 必须返回 HTTP 200，实际 ' + res.status);
    assert.ok(res.body !== null && typeof res.body === 'object', tag + ' 响应体要是对象');
    assert.strictEqual(res.body.ok, true,
      tag + ' 必须 ok:true（不许退化成 ledger-failed），实际 '
      + JSON.stringify({ ok: res.body.ok, reason: res.body.reason }));
    hardenResults.push({ n: one.n, name: one.name, ok: res.body.ok, status: res.status });
    console.log('J-' + one.n + ' 坏台账「' + one.name + '」⇒ status=' + res.status + ' ok=' + res.body.ok);
  }

  assert.strictEqual(hardenResults.length, 10, '十种坏法必须全部覆盖，实际 ' + hardenResults.length + ' 种');
  for (const one of BROKEN_LEDGERS) {
    assert.ok(hardenResults.some((r) => r.n === one.n), '坏法 ' + one.n + '（' + one.name + '）漏跑了');
  }
  console.log('J 台账写坏不影响路由：' + hardenResults.length + ' 种坏法（实测高峰日 ' + HARDEN_DAY + '）全部 200 + ok:true');

  console.log('');
  console.log('LEDGER KEEP CHECKS PASSED');
})().catch((error) => {
  console.error('LEDGER KEEP CHECKS FAILED: ' + (error && error.message ? error.message : error));
  console.error(error);
  process.exitCode = 1;
});
