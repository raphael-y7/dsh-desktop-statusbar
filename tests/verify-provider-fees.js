/*
 * Provider fee regression: drive the real Host projection and HTTP routes with
 * an isolated DSH_HOME and compressed session logs.
 * Run: node tests/verify-provider-fees.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'lib', 'index.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-provider-fees-'));
const STATUS = path.join(HOME, 'dsh-status-bar');
const SESSIONS = path.join(HOME, 'sessions');
const PROFILE_DIR = path.join(HOME, 'profiles', 'desktop');
const LEDGER_FILE = path.join(STATUS, 'usage-ledger.json');
const API = '/dsh-desktop-statusbar/api';
const PROVIDER_A = 'fee-provider-a';
const PROVIDER_B = 'fee-provider-b';
const M = 1000000;
const BEIJING_OFFSET = 8 * 3600 * 1000;

/* Use yesterday at 20:00 Beijing time: always off-peak and inside the ledger window. */
const bjNow = new Date(Date.now() + BEIJING_OFFSET);
const OFF_PEAK_AT = Date.UTC(
  bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 12, 0, 0
);
/* 2025-01-06 was a Monday outside the built-in 2026 holiday calendar. */
const PEAK_AT = Date.UTC(2025, 0, 6, 2, 0, 0);
const DAY = (() => {
  const at = new Date(OFF_PEAK_AT);
  return at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0')
    + '-' + String(at.getDate()).padStart(2, '0');
})();

process.env.DSH_HOME = HOME;
globalThis.setInterval = () => 0;

function writeSession(id, parentSession, events) {
  const dir = path.join(SESSIONS, id);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: 'session', id, parentSession };
  const lines = [header].concat(events).map((event) => JSON.stringify(event));
  fs.writeFileSync(path.join(dir, 'usage.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n')));
}

function assistantMessage(seq, time, provider, model, inputTokens, turn = 1, step = seq) {
  const source = { kind: 'model', model };
  if (provider !== undefined) source.provider = provider;
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, message: { source }, usage: { inputTokens } },
  };
}

function zeroTier() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function tierPrice(input, output = 0) {
  const tier = { input, cacheRead: 0, cacheWrite: 0, output };
  return { tiered: false, currency: 'CNY', feeConfigured: true, feeMultiplier: 1, peak: { ...tier }, offPeak: { ...tier } };
}

/* 把价格库压成台账 `priceFingerprint` 的 fp4 格式，用于模拟"重启后客户端还没上报价格库"。 */
function bookFingerprint(book) {
  const names = Object.keys(book).sort();
  const rows = [];
  const tierOf = (t) => (t === null || t === undefined
    ? null : [t.input, t.cacheRead, t.cacheWrite, t.output]);
  for (const name of names) {
    const one = book[name];
    const peak = tierOf(one.peak);
    const offPeak = tierOf(one.offPeak);
    if (peak === null && offPeak === null) continue;
    rows.push([
      name, peak !== null ? peak : offPeak, offPeak !== null ? offPeak : peak,
      one.tiered === false ? 0 : 1, one.currency === 'USD' ? 'USD' : 'CNY',
      typeof one.feeMultiplier === 'number' ? one.feeMultiplier : null,
      one.feeConfigured === true ? 1 : 0,
    ]);
  }
  return 'fp4:' + JSON.stringify(rows);
}

/* USD 价格条目：USD 历史重算用例用。fee === undefined 表示"没配置倍率"（应转欠账）。 */
function usdTierPrice(input, output = 0, fee) {
  const tier = { input, cacheRead: 0, cacheWrite: 0, output };
  const entry = { tiered: false, currency: 'USD', peak: { ...tier }, offPeak: { ...tier } };
  if (fee !== undefined) {
    entry.feeConfigured = true;
    entry.feeMultiplier = fee;
  }
  return entry;
}

function hit(handler, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const listeners = {};
    const req = {
      url: pathname,
      method: options.method || 'GET',
      headers: {},
      on(name, fn) {
        listeners[name] = (listeners[name] || []).concat(fn);
        return req;
      },
      destroy() {},
    };
    let status = null;
    let text = null;
    const res = {
      writeHead(code) { status = code; },
      end(body) { text = body; },
    };
    Promise.resolve(handler(req, res)).then(() => {
      resolve({ status, body: text === null ? null : JSON.parse(text) });
    }, reject);
    if (options.body !== undefined) {
      for (const fn of listeners.data || []) fn(options.body);
    }
    for (const fn of listeners.end || []) fn();
  });
}

function addUsage(projection, state, event) {
  const next = projection.apply(state, event);
  projection.stateSchema.parse(next);
  return next;
}

async function main() {
  fs.mkdirSync(STATUS, { recursive: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), [
    '- id: llm-pi-ai # provider-fees fixture',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      fee-provider-a:',
    '        baseURL: https://relay-a.invalid/v1',
    '      fee-provider-b:',
    '        baseURL: https://relay-b.invalid/v1',
    '      plain-provider:',
    '        baseURL: http://127.0.0.1:19999/v1',
    '      official-api:',
    '        baseURL: https://api.deepseek.com/v1',
    '      workbuddy-points:',
    '        baseURL: https://relay-points.invalid/v1',
    '      qoder-points:',
    '        baseURL: https://api.qoder.invalid/v1',
  ].join('\n'));
  const nineAm = new Date();
  nineAm.setHours(9, 0, 0, 0);
  fs.writeFileSync(path.join(STATUS, 'exchange-rate.json'), JSON.stringify({
    rate: 6.7,
    fetchedAt: Math.max(Date.now(), nineAm.getTime() + 1000),
    source: 'provider-fees-test',
  }));

  const mod = await import(pathToFileURL(INDEX).href);
  const projections = [];
  let handler = null;
  const secrets = new Map();
  const credentials = {
    resolve: async (ref) => secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : null,
    set: async (ref, value) => { secrets.set(ref, value); },
    unset: async (ref) => { secrets.delete(ref); },
  };
  const realFetchBeforeApply = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    mod.apply({
      logger: { info() {} },
      effect: (fn) => fn(),
      sessionProjections: { register: (projection) => { projections.push(projection); return () => {}; } },
      webServer: { register: (route) => {
        if (route.path === API) handler = route.handler;
        return () => {};
      } },
      credentials,
      get: (name) => name === 'credentials' ? credentials : undefined,
    });
  } finally {
    globalThis.fetch = realFetchBeforeApply;
  }
  assert.equal(typeof handler, 'function', 'Host API route captured through mod.apply');
  const usageProjection = projections.find((projection) => projection.key === 'desktopStatusbarUsage');
  assert.ok(usageProjection, 'sessionUsage projection captured through mod.apply');

  const post = (pathname, body) => hit(handler, pathname, { method: 'POST', body: JSON.stringify(body) });
  const postRelay = async (channelKey, endpoint, feeMultiplier) => {
    const result = await post(API + '/relay-balance-config', {
      channelKey,
      endpoint,
      currency: 'USD',
      balancePath: '$.data.balance',
      feeMultiplier,
      token: 'fixture-token-not-a-secret',
      userId: 'fixture-user',
    });
    assert.equal(result.status, 200, 'relay config write succeeded for ' + channelKey + ': ' + JSON.stringify(result.body));
    return result.body;
  };
  const postMagpie = async (feeMultiplier) => {
    const result = await post(API + '/relay-balance-config', { channelKey: 'Magpie', feeMultiplier });
    assert.equal(result.status, 200, 'Magpie multiplier config write succeeded');
    return result.body;
  };
  const postPrices = (models) => post(API + '/prices', { models });
  const daily = () => hit(handler, API + '/daily-usage?force=1');
  const initialLedger = await daily();
  assert.equal(initialLedger.status, 200, 'startup ledger queue settled through the real route');

  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 2);
  await postRelay(PROVIDER_B, 'https://relay-b.invalid/balance', 4);
  await postMagpie(1.5);

  /* Projection dataflow: message provider, routed attempt provider, summary provider,
     missing-provider default, and a config change between calls. */
  assert.ok(usageProjection.stateVersion > 8, 'usage projection version bumped to replay old states');
  let state = usageProjection.init();
  state = addUsage(usageProjection, state, assistantMessage(1, OFF_PEAK_AT, PROVIDER_A, 'shared-model', 10));
  state = addUsage(usageProjection, state, assistantMessage(2, OFF_PEAK_AT, PROVIDER_B, 'shared-model', 20));
  state = addUsage(usageProjection, state, {
    type: 'model/selection', seq: 3, time: OFF_PEAK_AT + 10,
    data: { provider: PROVIDER_B, model: 'attempt-model' },
  });
  state = addUsage(usageProjection, state, {
    type: 'assistant/attempt', seq: 4, time: OFF_PEAK_AT + 20,
    data: { turn: 1, step: 4, stream: [{ type: 'usage', usage: { inputTokens: 30 } }] },
  });
  state = addUsage(usageProjection, state, {
    type: 'compaction/summary', seq: 5, time: OFF_PEAK_AT + 30,
    data: { model: 'summary-model', provider: PROVIDER_A, usage: { inputTokens: 40 } },
  });
  state = addUsage(usageProjection, state, assistantMessage(6, OFF_PEAK_AT + 40, undefined, 'shared-model', 50));
  state = addUsage(usageProjection, state, {
    type: 'compaction/summary', seq: 7, time: OFF_PEAK_AT + 50,
    data: { model: 'summary-no-provider', usage: { inputTokens: 60 } },
  });
  const changed = await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 5);
  assert.equal(changed.ok, true, 'relay multiplier can change through real route');
  state = addUsage(usageProjection, state, assistantMessage(8, OFF_PEAK_AT + 60, PROVIDER_A, 'shared-model', 70));

  assert.equal(state.calls.length, 7, 'all usage events with a model were projected');
  /* v10 合同：session calls 只持久 provider，倍率由客户端按当前非密配置动态算。
     这里同时反证 calls 上没有 feeMultiplier 快照字段（否则会重新引入事件时刻语义）。 */
  assert.deepEqual(state.calls.map((call) => call.provider), [
    PROVIDER_A, PROVIDER_B, PROVIDER_B, PROVIDER_A, '', '', PROVIDER_A,
  ], 'provider 只取事件来源，不按 model 或旧 route 推断');
  assert.deepEqual(state.calls.map((call) => call.feeMultiplier === undefined), [
    true, true, true, true, true, true, true,
  ], 'session call 不保存事件时刻的 feeMultiplier 快照');
  assert.equal(state.calls[2].model, 'attempt-model', 'assistant/attempt uses its preceding route model');
  assert.equal(state.calls[4].model, 'shared-model', 'same model is retained separately across providers');
  assert.equal(state.calls[5].model, 'summary-no-provider', 'summary model comes from data.model');
  assert.equal(state.overflowByProvider, undefined, 'provider-aware overflow 已删除（客户端零引用）');

  let noRoute = usageProjection.init();
  noRoute = addUsage(usageProjection, noRoute, {
    type: 'assistant/attempt', seq: 9, time: OFF_PEAK_AT,
    data: { turn: 1, step: 1, stream: [{ type: 'usage', usage: { inputTokens: 100 } }] },
  });
  assert.equal(noRoute.calls.length, 0, 'attempt without same-route model is not model-inferred');

  /* Overflow must retain three independent provider/model/multiplier/tier bins. */
  let overflowState = usageProjection.init();
  let seq = 1;
  const overflowCall = (provider, time, step) => ({
    type: 'assistant/message', seq: seq++, time,
    data: {
      turn: 2, step,
      message: { source: { kind: 'model', provider, model: 'overflow-model' } },
      usage: { inputTokens: 1 },
    },
  });
  overflowState = addUsage(usageProjection, overflowState, overflowCall(PROVIDER_A, OFF_PEAK_AT, 1));
  overflowState = addUsage(usageProjection, overflowState, overflowCall(PROVIDER_A, PEAK_AT, 2));
  await postRelay(PROVIDER_B, 'https://relay-b.invalid/balance', 2);
  overflowState = addUsage(usageProjection, overflowState, overflowCall(PROVIDER_B, OFF_PEAK_AT, 3));
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 7);
  overflowState = addUsage(usageProjection, overflowState, overflowCall(PROVIDER_A, OFF_PEAK_AT, 4));
  for (let i = 5; i <= 4004; i += 1) {
    overflowState = addUsage(usageProjection, overflowState, overflowCall('overflow-filler', OFF_PEAK_AT, i));
  }
  assert.equal(overflowState.calls.length, 4000, 'MAX_CALLS tail is retained');
  /* 旧 model-keyed overflow 是客户端真正读取的那份：4 条被挤掉（同属 overflow-model），
     peak 1 条、offPeak 3 条（A/B 两个 provider 按模型合并）。 */
  assert.deepEqual(
    [overflowState.overflow['overflow-model'].peak.input, overflowState.overflow['overflow-model'].offPeak.input],
    [1, 3],
    'overflow 按模型合并两档（同模型不同 provider 合并，客户端只读这一份）'
  );

  /* Ledger route: two providers, same model, hand-computable prices. */
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 2);
  await postRelay(PROVIDER_B, 'https://relay-b.invalid/balance', 3);
  let priceBook = {
    'fee-model': tierPrice(1),
    'sub-model': tierPrice(2),
  };
  let posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'initial prices accepted');
  writeSession('ledger-session', null, [
    assistantMessage(1, OFF_PEAK_AT, PROVIDER_A, 'fee-model', M),
    assistantMessage(2, OFF_PEAK_AT, PROVIDER_B, 'fee-model', M),
  ]);
  let report = await daily();
  assert.equal(report.status, 200, 'daily usage route returned HTTP 200');
  let day = report.body.days.find((entry) => entry.date === DAY);
  assert.ok(day, 'daily usage includes test date ' + DAY);
  assert.equal(day.cost, 5, 'same model: 1 * multiplier 2 + 1 * multiplier 3 = 5');
  assert.equal(day.costByCurrency.CNY, 5, 'costByCurrency also reflects provider multipliers');

  /* A multiplier-only change does not rewrite already settled ledger history. */
  let disk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  disk.days[DAY].legacyCost = 77;
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(disk));
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 5);
  report = await daily();
  day = report.body.days.find((entry) => entry.date === DAY);
  assert.equal(day.cost, 5, 'changing provider multiplier does not reprice historical cost');
  assert.equal(day.costByCurrency.CNY, 5, 'historical costByCurrency is unchanged');
  assert.equal(JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).days[DAY].legacyCost, 77,
    'legacyCost snapshot survives multiplier-only change');

  /* Same-model debt separates provider and multiplier; another model separates the model key. */
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 7);
  const ledgerEvents = [
    assistantMessage(1, OFF_PEAK_AT, PROVIDER_A, 'fee-model', M),
    assistantMessage(2, OFF_PEAK_AT, PROVIDER_B, 'fee-model', M),
    assistantMessage(3, OFF_PEAK_AT, PROVIDER_A, 'fee-model', M),
  ];
  writeSession('ledger-session', null, ledgerEvents);
  report = await daily();
  day = report.body.days.find((entry) => entry.date === DAY);
  assert.equal(day.cost, 12, 'new priced provider-A call adds 7; prior 5 remains');
  const recordDebt = async (seq, provider, model) => {
    ledgerEvents.push(assistantMessage(seq, OFF_PEAK_AT, provider, model, M));
    writeSession('ledger-session', null, ledgerEvents);
    const next = await daily();
    const nextDay = next.body.days.find((entry) => entry.date === DAY);
    assert.equal(nextDay.cost, 12, 'unpriced usage does not alter settled cost');
  };
  await recordDebt(4, PROVIDER_A, 'debt-model');
  await postRelay(PROVIDER_B, 'https://relay-b.invalid/balance', 7);
  await recordDebt(5, PROVIDER_B, 'debt-model');
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 8);
  await recordDebt(6, PROVIDER_A, 'debt-model');
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 7);
  await recordDebt(7, PROVIDER_A, 'alternate-debt-model');

  disk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  const debts = disk.days[DAY].unpricedByProvider;
  assert.equal(debts.length, 3, 'provider/model produce three distinct debt snapshots（relay 缺倍率统一记 1）');
  assert.ok(debts.every((debt) => debt.peak === null && debt.offPeak.input > 0),
    'each debt snapshot preserves peak/offPeak token partitions');
  for (const [provider, model, multiplier, tokens] of [
    [PROVIDER_A, 'debt-model', 1, M * 2],
    [PROVIDER_B, 'debt-model', 1, M],
    [PROVIDER_A, 'alternate-debt-model', 1, M],
  ]) {
    assert.ok(debts.some((debt) => debt.provider === provider
      && debt.model === model && debt.feeMultiplier === multiplier && debt.offPeak.input === tokens),
    'debt key/snapshot includes ' + provider + ' / ' + model + ' / multiplier ' + multiplier + ' / tokens ' + tokens);
  }

  /* Insert a pre-Stage2B model-only legacy debt entry, which must settle at multiplier 1. */
  disk.days[DAY].unpriced = disk.days[DAY].unpriced || {};
  disk.days[DAY].unpriced['legacy-debt-model'] = {
    peak: zeroTier(),
    offPeak: { input: M, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(disk));
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 9);
  await postRelay(PROVIDER_B, 'https://relay-b.invalid/balance', 9);
  report = await daily();
  day = report.body.days.find((entry) => entry.date === DAY);
  assert.equal(day.cost, 12, 'later multiplier change leaves settled history alone before debt settlement');

  priceBook = {
    ...priceBook,
    'debt-model': tierPrice(1),
    'alternate-debt-model': tierPrice(1),
    'legacy-debt-model': tierPrice(1),
  };
  posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'prices route accepted debt model prices');
  assert.equal(posted.body.settled.entries, 4, 'three provider-scoped and one legacy debt entries settle');
  assert.equal(posted.body.settled.amount, 5, 'snapshots 2 + 1 + 1 and legacy multiplier 1 = 5');
  report = await daily();
  day = report.body.days.find((entry) => entry.date === DAY);
  assert.equal(day.cost, 17, 'historical 12 + settled debt 5 = 17');
  assert.equal(day.costByCurrency.CNY, 17, 'debt settlement updates currency bucket by 5');
  assert.equal(JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).days[DAY].legacyCost, 77,
    'legacyCost snapshot is not rewritten by multiplier changes or debt settlement');

  /* A real parent/child session pair exercises the real subagent route. */
  await postRelay(PROVIDER_A, 'https://relay-a.invalid/balance', 9);
  writeSession('parent-session', null, []);
  writeSession('child-session', 'parent-session', [
    assistantMessage(1, OFF_PEAK_AT, PROVIDER_A, 'sub-model', M),
  ]);
  const subagent = await hit(handler, API + '/subagent-usage?sessionId=parent-session&since=0');
  assert.equal(subagent.status, 200, 'real subagent route returned HTTP 200');
  assert.equal(subagent.body.total.calls, 1, 'one child usage call counted');
  assert.equal(subagent.body.total.cost, 18, 'subagent cost = base 2 * provider multiplier 9 exactly once');
  assert.equal(subagent.body.children[0].cost, 18, 'child detail uses the same exact multiplied amount');

  /* Relay matching is exact; the balance amount itself is never fee-multiplied. */
  const realFetch = globalThis.fetch;
  const fetched = [];
  let balanceFixture = { data: { balance: '12.34' } };
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify(balanceFixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const exact = await hit(handler, API + '/balance?provider=' + encodeURIComponent(PROVIDER_A)
      + '&model=fee-model&force=1');
    assert.equal(exact.status, 200, 'exact relay balance route returned HTTP 200');
    assert.equal(exact.body.ok, true, 'exact channel configuration was used');
    assert.equal(exact.body.total, '12.34', 'balance total is not multiplied by feeMultiplier');
    assert.deepEqual(fetched, ['https://relay-a.invalid/balance'], 'provider A exact channel only was fetched');

    /* balanceDivisor: optional per-channel unit divisor, applied before formatting. */
    const divisorWrite = await post(API + '/relay-balance-config', {
      channelKey: PROVIDER_A,
      balanceDivisor: 500000,
    });
    assert.equal(divisorWrite.status, 200,
      'balanceDivisor accepted on ordinary relay channel: ' + JSON.stringify(divisorWrite.body));
    const divisorGet = await hit(handler, API + '/relay-balance-config');
    const channelA = divisorGet.body.channels.find((one) => one.channelKey === PROVIDER_A);
    const channelB = divisorGet.body.channels.find((one) => one.channelKey === PROVIDER_B);
    assert.equal(channelA.balanceDivisor, 500000, 'balanceDivisor round-trips through GET');
    assert.equal(channelA.feeMultiplier, 9, 'unrelated relay fields keep their values');
    assert.equal(channelB.balanceDivisor, 1, 'channels without balanceDivisor default to 1');

    balanceFixture = { data: { balance: '5000000' } };
    const scaled = await hit(handler, API + '/balance?provider=' + encodeURIComponent(PROVIDER_A)
      + '&model=fee-model&force=1');
    assert.equal(scaled.body.ok, true, 'scaled relay balance usable');
    assert.equal(scaled.body.total, '10.00',
      '5000000 / balanceDivisor 500000 = 10.00, not multiplied by feeMultiplier 9');

    const invalidDivisor = await post(API + '/relay-balance-config', { channelKey: PROVIDER_A, balanceDivisor: 0 });
    assert.equal(invalidDivisor.status, 400, 'non-positive balanceDivisor rejected');
    const magpieDivisor = await post(API + '/relay-balance-config', { channelKey: 'Magpie', balanceDivisor: 500000 });
    assert.equal(magpieDivisor.status, 400, 'Magpie channel rejects balanceDivisor');

    /* Model-level relay config: channelKey is the model name, used only when the provider misses. */
    const modelChannel = 'model-channel-probe';
    const modelChannelWrite = await post(API + '/relay-balance-config', {
      channelKey: modelChannel,
      endpoint: 'https://relay-model.invalid/balance',
      currency: 'CNY',
      balancePath: '$.data.balance',
      feeMultiplier: 1,
      token: 'model-channel-token',
      userId: 'model-channel-user',
    });
    assert.equal(modelChannelWrite.status, 200,
      'model-keyed relay channel accepted: ' + JSON.stringify(modelChannelWrite.body));
    balanceFixture = { data: { balance: '7.77' } };
    const modelFallbackMark = fetched.length;
    const byModel = await hit(handler, API + '/balance?provider=' + encodeURIComponent('unknown-relay-provider')
      + '&model=' + encodeURIComponent(modelChannel) + '&force=1');
    assert.equal(byModel.status, 200, 'model fallback returned HTTP 200');
    assert.equal(byModel.body.ok, true, 'model fallback used the model-keyed relay channel');
    assert.equal(byModel.body.total, '7.77', 'model fallback formats the relay balance');
    assert.deepEqual(fetched.slice(modelFallbackMark), ['https://relay-model.invalid/balance'],
      'model fallback fetched only the model-keyed endpoint');

    const providerWinsMark = fetched.length;
    await hit(handler, API + '/balance?provider=' + encodeURIComponent(PROVIDER_A)
      + '&model=' + encodeURIComponent(modelChannel) + '&force=1');
    assert.deepEqual(fetched.slice(providerWinsMark), ['https://relay-a.invalid/balance'],
      'exact provider channel wins over a model-keyed channel');

    const magpieMark = fetched.length;
    await hit(handler, API + '/balance?provider=Magpie&model=' + encodeURIComponent(modelChannel) + '&force=1');
    assert.equal(fetched.length, magpieMark, 'Magpie never falls back to a model-keyed channel');

    const beforeNoFetch = fetched.length;
    await hit(handler, API + '/balance?provider=Magpie&model=fee-model&force=1');
    await hit(handler, API + '/balance?provider=unconfigured-provider&model=deepseek-flash&force=1');
    await hit(handler, API + '/balance?provider=' + encodeURIComponent(PROVIDER_A + '-suffix')
      + '&model=fee-model&force=1');
    assert.equal(fetched.length, beforeNoFetch, 'Magpie and unknown explicit providers never fetch or fall back by model');
  } finally {
    globalThis.fetch = realFetch;
  }

  /* Price-entry feeMultiplier: the client relay station stores it on each model entry. */
  const dayCostNow = async () => {
    const next = await daily();
    const entry = next.body.days.find((one) => one.date === DAY);
    assert.ok(entry, 'daily usage still has test date ' + DAY);
    return entry.cost;
  };
  const costBeforeEntryFee = await dayCostNow();
  priceBook = {
    ...priceBook,
    'fee-entry-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2 }),
    'plain-entry-model': tierPrice(1, 0),
    'zero-fee-entry-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 0 }),
    'negative-fee-entry-model': Object.assign(tierPrice(1, 0), { feeMultiplier: -1 }),
    'string-fee-entry-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 'x' }),
  };
  posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'price book with feeMultiplier entries accepted');
  writeSession('price-entry-fee-session', null, [
    assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'fee-entry-model', M),
    assistantMessage(2, OFF_PEAK_AT, 'plain-provider', 'plain-entry-model', M),
    assistantMessage(3, OFF_PEAK_AT, 'plain-provider', 'zero-fee-entry-model', M),
    assistantMessage(4, OFF_PEAK_AT, 'plain-provider', 'negative-fee-entry-model', M),
    assistantMessage(5, OFF_PEAK_AT, 'plain-provider', 'string-fee-entry-model', M),
  ]);
  const costAfterEntryFee = await dayCostNow();
  assert.equal(costAfterEntryFee - costBeforeEntryFee, 6,
    'feeMultiplier 2 doubles one call; missing/0/-1/"x" fall back to 1 (2 + 1 + 1 + 1 + 1 = 6)');

  /* The provider channel multiplier and the price-entry multiplier multiply. */
  const costBeforeProduct = await dayCostNow();
  writeSession('price-entry-fee-product-session', null, [
    assistantMessage(1, OFF_PEAK_AT, PROVIDER_A, 'fee-entry-model', M),
  ]);
  const costAfterProduct = await dayCostNow();
  assert.equal(costAfterProduct - costBeforeProduct, 18,
    'channel multiplier 9 * price-entry multiplier 2 = 18 for a 1 CNY call');

  /* Debt settlement applies the price-entry multiplier on both debt paths.
     The model name must not token-match any priced key, or it would be priced instead of debited. */
  writeSession('price-entry-fee-debt-session', null, [
    assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'zzz-debt-probe', M),
  ]);
  const costWithDebt = await dayCostNow();
  assert.equal(costWithDebt, costAfterProduct, 'unpriced model does not change settled cost');

  disk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  disk.days[DAY].unpriced = disk.days[DAY].unpriced || {};
  disk.days[DAY].unpriced['legacy-fee-debt-model'] = {
    peak: zeroTier(),
    offPeak: { input: M, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(disk));

  priceBook = {
    ...priceBook,
    'zzz-debt-probe': Object.assign(tierPrice(1, 0), { feeMultiplier: 2 }),
    'legacy-fee-debt-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2 }),
  };
  posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'prices for fee debts accepted');
  assert.equal(posted.body.settled.entries, 2, 'provider-scoped and legacy debts both settle');
  assert.equal(posted.body.settled.amount, 4,
    'each 1 CNY debt * price-entry multiplier 2 = 2, total 4');
  const costAfterDebt = await dayCostNow();
  assert.equal(costAfterDebt - costWithDebt, 4, 'settled debt adds the multiplied amount to day cost');

  /* Tolerant model-name matching: provider prefix + separator variants hit the same price entry. */
  const tolerantBefore = await dayCostNow();
  priceBook = {
    ...priceBook,
    'claude-opus-5.5': tierPrice(1, 0),
  };
  posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'tolerant-matching price book accepted');
  writeSession('tolerant-match-session', null, [
    assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'remote-magpie/group/claude-opus-5-5', M),
  ]);
  const tolerantAfter = await dayCostNow();
  assert.equal(tolerantAfter - tolerantBefore, 1,
    'prefixed + dashed model name hits the claude-opus-5.5 price entry (compact-name match)');

  /* Compact match must be exact: deepseek-v4 must not borrow the deepseek-v4-pro price. */
  const mismatchBefore = await dayCostNow();
  priceBook = {
    ...priceBook,
    'deepseek-v4-pro': tierPrice(1, 0),
  };
  posted = await postPrices(priceBook);
  assert.equal(posted.status, 200, 'mismatch-guard price book accepted');
  writeSession('tolerant-mismatch-session', null, [
    assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'deepseek-v4', M),
  ]);
  const mismatchAfter = await dayCostNow();
  assert.equal(mismatchAfter, mismatchBefore,
    'deepseek-v4 must not borrow deepseek-v4-pro price (compact strings differ)');
  const mismatchLedger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  assert.equal((mismatchLedger.days[DAY].unpricedByProvider || []).some((one) => one.model === 'deepseek-v4'),
    true, 'deepseek-v4 is recorded as unpriced debt instead of borrowing a similar key');
  console.log('Tolerant matching: prefixed/dashed names hit the same price; deepseek-v4 stays unpriced.');


  /* ---- task-10：provider 归属（official / points / relay）与按归属计价 ---- */
  const affiliationBefore = await dayCostNow();
  const affiliationBook = Object.assign({}, priceBook, {
    'aff-official-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2, feeConfigured: true }),
  });
  let affPosted = await postPrices(affiliationBook);
  assert.equal(affPosted.status, 200, 'affiliation price book accepted');
  writeSession('aff-official-session', null, [assistantMessage(1, OFF_PEAK_AT, 'official-api', 'aff-official-model', M)]);
  let affAfter = await dayCostNow();
  assert.equal(affAfter - affiliationBefore, 1, 'official provider 忽略价格条目倍率，按官方价 1 计费');
  writeSession('aff-relay-session', null, [assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'aff-official-model', M)]);
  affAfter = await dayCostNow();
  assert.equal(affAfter - affiliationBefore, 3, 'relay provider 按价格条目倍率 2 计费（1 + 2）');
  writeSession('aff-points-session', null, [assistantMessage(1, OFF_PEAK_AT, 'workbuddy-points', 'aff-official-model', M)]);
  writeSession('aff-qoder-session', null, [assistantMessage(1, OFF_PEAK_AT, 'qoder-points', 'aff-official-model', M)]);
  affAfter = await dayCostNow();
  assert.equal(affAfter - affiliationBefore, 5, 'WorkBuddy / Qoder 积分制仍按官方价（各 1）');

  /* relay 缺倍率：不按官方价结算，记 provider 欠账；补 feeConfigured 后按倍率结算并触发指纹变更 */
  const missingBefore = await dayCostNow();
  const missingBook = Object.assign({}, affiliationBook, {
    'aff-relay-missing': { tiered: false, currency: 'CNY', peak: { ...zeroTier(), input: 1 }, offPeak: { ...zeroTier(), input: 1 } },
  });
  affPosted = await postPrices(missingBook);
  assert.equal(affPosted.status, 200, 'relay missing-fee price book accepted');
  writeSession('aff-missing-session', null, [assistantMessage(1, OFF_PEAK_AT, 'plain-provider', 'aff-relay-missing', M)]);
  const missingAfter = await dayCostNow();
  assert.equal(missingAfter, missingBefore, 'relay 缺 feeConfigured 不产生官方价费用');
  const missingLedger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  const missingDebt = (missingLedger.days[DAY].unpricedByProvider || []).filter((one) => one.provider === 'plain-provider' && one.model === 'aff-relay-missing');
  assert.equal(missingDebt.length, 1, 'relay 缺倍率记录 provider 欠账');
  assert.equal(missingDebt[0].feeMultiplier, 1, '缺倍率欠账的 feeMultiplier 记为 1');
  const missingFixed = Object.assign({}, missingBook, {
    'aff-relay-missing': Object.assign(tierPrice(1, 0), { feeMultiplier: 3, feeConfigured: true }),
  });
  affPosted = await postPrices(missingFixed);
  assert.equal(affPosted.body.changed, true, 'feeConfigured / feeMultiplier 变化触发价格指纹变更并结算');
  assert.equal(affPosted.body.settled.entries, 1, '补齐倍率后结算 1 条欠账');
  assert.equal(affPosted.body.settled.amount, 3, '按补上的倍率 3 结算');
  const missingAfterFix = await dayCostNow();
  assert.equal(missingAfterFix - missingBefore, 3, '补齐倍率后费用增加 3');

  console.log('Provider affiliation: official 忽略条目倍率；relay 按条目倍率；WorkBuddy/Qoder 按官方价；缺倍率记欠账。');

  /* ---- task-11：一次性历史重算（relay 历史按倍率修正，官方/points/缺日志保留） ---- */
  const auditAtConfigured = OFF_PEAK_AT - 3 * 24 * 3600 * 1000;
  const auditAtMissing = OFF_PEAK_AT - 4 * 24 * 3600 * 1000;
  const auditAtOfficial = OFF_PEAK_AT - 5 * 24 * 3600 * 1000;
  const auditAtPoints = OFF_PEAK_AT - 6 * 24 * 3600 * 1000;
  const dateOf = (at) => { const d = new Date(at); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const auditDayConfigured = dateOf(auditAtConfigured);
  const auditDayMissing = dateOf(auditAtMissing);
  const auditDayOfficial = dateOf(auditAtOfficial);
  const auditDayPoints = dateOf(auditAtPoints);
  const auditDayNoLog = dateOf(auditAtPoints - 24 * 3600 * 1000);
  priceBook = Object.assign({}, priceBook, {
    'audit-relay-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2, feeConfigured: true }),
    'audit-missing-model': { tiered: false, currency: 'CNY', peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } },
    'audit-official-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2, feeConfigured: true }),
    'audit-points-model': Object.assign(tierPrice(1, 0), { feeMultiplier: 2, feeConfigured: true }),
  });
  affPosted = await postPrices(priceBook);
  assert.equal(affPosted.status, 200, 'audit price book accepted');
  writeSession('audit-configured-session', null, [assistantMessage(1, auditAtConfigured, 'plain-provider', 'audit-relay-model', M)]);
  writeSession('audit-missing-session', null, [assistantMessage(1, auditAtMissing, 'plain-provider', 'audit-missing-model', M)]);
  writeSession('audit-official-session', null, [assistantMessage(1, auditAtOfficial, 'official-api', 'audit-official-model', M)]);
  writeSession('audit-points-session', null, [assistantMessage(1, auditAtPoints, 'workbuddy-points', 'audit-points-model', M)]);
  const auditLedger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  auditLedger.providerPricingAuditVersion = '';
  const seedAuditDay = (cost) => ({ input: M, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1, cost: cost, costByCurrency: { CNY: cost } });
  auditLedger.days[auditDayConfigured] = seedAuditDay(1);
  auditLedger.days[auditDayMissing] = seedAuditDay(1);
  auditLedger.days[auditDayOfficial] = seedAuditDay(1);
  auditLedger.days[auditDayPoints] = seedAuditDay(1);
  auditLedger.days[auditDayNoLog] = seedAuditDay(7);
  auditLedger.seen['audit-configured-session'] = [1];
  auditLedger.seen['audit-missing-session'] = [1];
  auditLedger.seen['audit-official-session'] = [1];
  auditLedger.seen['audit-points-session'] = [1];
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(auditLedger));
  const auditBackupPath = LEDGER_FILE + '.bak-provider-pricing';
  try { fs.rmSync(auditBackupPath, { force: true }); } catch (error) { /* none */ }
  const auditBeforeRaw = fs.readFileSync(LEDGER_FILE, 'utf8');
  report = await daily();
  const auditCost = (dayKey) => { const diskNow = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); return diskNow.days[dayKey] === undefined ? undefined : diskNow.days[dayKey].cost; };
  assert.equal(auditCost(auditDayConfigured), 2, 'relay 已配倍率：历史官方价 1 → 官方价 × 2 = 2');
  assert.equal(auditCost(auditDayMissing), 0, 'relay 缺倍率：移除原官方价成本');
  assert.equal(auditCost(auditDayOfficial), 1, 'official 历史成本保持原样');
  assert.equal(auditCost(auditDayPoints), 1, 'points 历史成本保持原样');
  assert.equal(auditCost(auditDayNoLog), 7, '缺日志日期保留原值');
  const auditDisk = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  const auditDebt = (auditDisk.days[auditDayMissing].unpricedByProvider || []).filter((one) => one.provider === 'plain-provider' && one.model === 'audit-missing-model');
  assert.equal(auditDebt.length, 1, 'relay 缺倍率历史写入 unpricedByProvider 欠账');
  assert.equal(auditDebt[0].feeMultiplier, 1, '历史欠账 feeMultiplier 记 1');
  assert.equal(auditDisk.providerPricingAuditVersion, 2, '历史重算一次性标记置 2');
  const auditBackup = fs.readFileSync(auditBackupPath, 'utf8');
  assert.equal(auditBackup, auditBeforeRaw, '重算前备份 usage-ledger.json.bak-provider-pricing 且只备份一次');
  assert.deepStrictEqual(auditDisk.seen['audit-configured-session'], [1], '历史重算保留 seen');
  const auditBeforeSecond = auditCost(auditDayConfigured);
  report = await daily();
  assert.equal(auditCost(auditDayConfigured), auditBeforeSecond, '重复执行幂等：日期费用不再变化');
  const auditDiskSecond = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  assert.equal(auditDiskSecond.providerPricingAuditVersion, 2, '重复执行不重复迁移');

  console.log('History audit: relay 已配倍率重算 / 缺倍率转欠账 / official+points 不动 / 缺日志保留 / 幂等。');

  /* ---- task-13：USD 历史重算（relay USD 有倍率→改、无倍率→转欠账、official/points 不动、v1→v2 不重复扣 CNY） ---- */
  const auditUsdAtFee = OFF_PEAK_AT - 8 * 24 * 3600 * 1000;
  const auditUsdAtDebt = OFF_PEAK_AT - 9 * 24 * 3600 * 1000;
  const auditUsdAtOfficial = OFF_PEAK_AT - 10 * 24 * 3600 * 1000;
  const auditUsdAtPoints = OFF_PEAK_AT - 11 * 24 * 3600 * 1000;
  const auditUsdAtV1 = OFF_PEAK_AT - 12 * 24 * 3600 * 1000;
  const auditUsdAtPrefix = OFF_PEAK_AT - 13 * 24 * 3600 * 1000;
  const auditUsdAtOrbi = OFF_PEAK_AT - 14 * 24 * 3600 * 1000;
  const auditUsdDayFee = dateOf(auditUsdAtFee);
  const auditUsdDayDebt = dateOf(auditUsdAtDebt);
  const auditUsdDayOfficial = dateOf(auditUsdAtOfficial);
  const auditUsdDayPoints = dateOf(auditUsdAtPoints);
  const auditUsdDayV1 = dateOf(auditUsdAtV1);
  const auditUsdDayPrefix = dateOf(auditUsdAtPrefix);
  const auditUsdDayOrbi = dateOf(auditUsdAtOrbi);
  priceBook = Object.assign({}, priceBook, {
    'audit-usd-relay-fee': usdTierPrice(1, 0, 2),
    'audit-usd-relay-debt': usdTierPrice(1),
    'audit-usd-official': usdTierPrice(1, 0, 2),
    'audit-usd-points': usdTierPrice(1, 0, 2),
    'audit-usd-v1-model': usdTierPrice(1),
    'audit-usd-prefix-model': usdTierPrice(1, 0, 2),
    'audit-usd-orbi-model': usdTierPrice(1),
    /* 和内置表同名的 CNY 模型，用来验证 v1→v2 迁移不会把 v1 已扣过的 CNY 再扣一次。 */
    'deepseek-flash': tierPrice(1, 0),
  });
  affPosted = await postPrices(priceBook);
  assert.equal(affPosted.status, 200, 'USD audit price book accepted');
  /* 模拟真实故障现场：台账指纹里记着完整价目表（含 USD 模型），但 host 重启后
     `clientPrices` 为空、当前价库只剩内置 CNY 表。把客户端当前价库换成一个不含
     USD 审计模型的版本，历史重算必须靠指纹还原单价，不能靠当前价库。 */
  const auditUsdHistoryBook = priceBook;
  const auditUsdActiveBook = Object.assign({}, priceBook);
  for (const name of ['audit-usd-relay-fee', 'audit-usd-relay-debt', 'audit-usd-official',
    'audit-usd-points', 'audit-usd-v1-model', 'audit-usd-prefix-model', 'audit-usd-orbi-model']) {
    delete auditUsdActiveBook[name];
  }
  affPosted = await postPrices(auditUsdActiveBook);
  assert.equal(affPosted.status, 200, 'restart-like price book accepted');
  writeSession('audit-usd-fee-session', null, [assistantMessage(1, auditUsdAtFee, 'plain-provider', 'audit-usd-relay-fee', M)]);
  writeSession('audit-usd-debt-session', null, [assistantMessage(1, auditUsdAtDebt, 'plain-provider', 'audit-usd-relay-debt', M)]);
  writeSession('audit-usd-official-session', null, [assistantMessage(1, auditUsdAtOfficial, 'official-api', 'audit-usd-official', M)]);
  writeSession('audit-usd-points-session', null, [assistantMessage(1, auditUsdAtPoints, 'workbuddy-points', 'audit-usd-points', M)]);
  writeSession('audit-usd-v1-cny-session', null, [assistantMessage(1, auditUsdAtV1, 'plain-provider', 'deepseek-flash', M)]);
  writeSession('audit-usd-v1-usd-session', null, [assistantMessage(1, auditUsdAtV1, 'plain-provider', 'audit-usd-v1-model', M)]);
  /* 老日志 provider 为空：只能靠模型命名空间前缀判 relay。 */
  writeSession('audit-usd-prefix-session', null, [assistantMessage(1, auditUsdAtPrefix, undefined, 'remote-magpie/group/audit-usd-prefix-model', M)]);
  /* provider 配置缺失：只能靠 provider 短名兜底判 relay。 */
  writeSession('audit-usd-orbi-session', null, [assistantMessage(1, auditUsdAtOrbi, 'orbi', 'audit-usd-orbi-model', M)]);
  const usdSeed = (usd, cny = 0) => ({
    input: M, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1,
    cost: usd + cny, costByCurrency: { CNY: cny, USD: usd },
  });
  const seedUsdAuditLedger = (version) => {
    const next = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    next.providerPricingAuditVersion = version;
    next.priceFingerprint = bookFingerprint(auditUsdHistoryBook);
    next.days[auditUsdDayFee] = usdSeed(1);
    next.days[auditUsdDayDebt] = usdSeed(1);
    next.days[auditUsdDayOfficial] = usdSeed(1);
    next.days[auditUsdDayPoints] = usdSeed(1);
    next.days[auditUsdDayV1] = usdSeed(1, 5);
    next.days[auditUsdDayPrefix] = usdSeed(1);
    next.days[auditUsdDayOrbi] = usdSeed(1);
    next.seen['audit-usd-fee-session'] = [1];
    next.seen['audit-usd-debt-session'] = [1];
    next.seen['audit-usd-official-session'] = [1];
    next.seen['audit-usd-points-session'] = [1];
    next.seen['audit-usd-v1-cny-session'] = [1];
    next.seen['audit-usd-v1-usd-session'] = [1];
    next.seen['audit-usd-prefix-session'] = [1];
    next.seen['audit-usd-orbi-session'] = [1];
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(next));
  };
  const usdDayOnDisk = (key) => JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).days[key];
  const assertUsdAuditDays = (tag) => {
    assert.equal(usdDayOnDisk(auditUsdDayFee).cost, 2, tag + ': relay USD 有倍率 → 1 × 2 = 2');
    assert.equal(usdDayOnDisk(auditUsdDayFee).costByCurrency.USD, 2, tag + ': relay USD 费用写进 USD 桶');
    assert.equal(usdDayOnDisk(auditUsdDayDebt).cost, 0, tag + ': relay USD 缺倍率 → 官方价移除');
    assert.equal(usdDayOnDisk(auditUsdDayDebt).costByCurrency.USD, 0, tag + ': relay USD 缺倍率 → USD 桶清零');
    assert.ok((usdDayOnDisk(auditUsdDayDebt).unpricedByProvider || []).some((one) =>
      one.provider === 'plain-provider' && one.model === 'audit-usd-relay-debt'),
    tag + ': relay USD 缺倍率写入 provider 欠账');
    assert.equal(usdDayOnDisk(auditUsdDayOfficial).cost, 1, tag + ': official USD 历史保持');
    assert.equal(usdDayOnDisk(auditUsdDayOfficial).costByCurrency.USD, 1, tag + ': official USD 桶保持');
    assert.equal(usdDayOnDisk(auditUsdDayPoints).cost, 1, tag + ': WorkBuddy points USD 历史保持');
    assert.equal(usdDayOnDisk(auditUsdDayPoints).costByCurrency.USD, 1, tag + ': points USD 桶保持');
    assert.equal(usdDayOnDisk(auditUsdDayPrefix).cost, 2, tag + ': provider 为空的 remote-magpie 模型按前缀判 relay 并重算');
    assert.equal(usdDayOnDisk(auditUsdDayPrefix).costByCurrency.USD, 2, tag + ': 前缀兜底的 USD 桶正确');
    assert.equal(usdDayOnDisk(auditUsdDayOrbi).cost, 0, tag + ': 配置缺失的 orbi provider 按短名兜底判 relay');
    assert.ok((usdDayOnDisk(auditUsdDayOrbi).unpricedByProvider || []).some((one) =>
      one.provider === 'orbi' && one.model === 'audit-usd-orbi-model'),
    tag + ': orbi 缺倍率 USD 欠账已记录');
  };

  /* v1→v2 迁移：v1 已修正过的 CNY 不再扣，USD 缺口补上。 */
  seedUsdAuditLedger(1);
  report = await daily();
  assertUsdAuditDays('v1→v2');
  assert.equal(usdDayOnDisk(auditUsdDayV1).cost, 5, 'v1→v2: 已修正的 CNY 历史不重复扣');
  assert.equal(usdDayOnDisk(auditUsdDayV1).costByCurrency.CNY, 5, 'v1→v2: CNY 桶保持 5');
  assert.equal(usdDayOnDisk(auditUsdDayV1).costByCurrency.USD, 0, 'v1→v2: 漏掉的 USD 桶被修正为 0');
  assert.ok((usdDayOnDisk(auditUsdDayV1).unpricedByProvider || []).some((one) =>
    one.provider === 'plain-provider' && one.model === 'audit-usd-v1-model'),
  'v1→v2: 补记 USD 欠账');
  assert.ok((usdDayOnDisk(auditUsdDayV1).unpricedByProvider || []).every((one) => one.model !== 'deepseek-flash'),
    'v1→v2: 不重复记 deepseek-flash 欠账');

  /* 全新台账（无版本标记）：USD 用例同样成立。 */
  seedUsdAuditLedger('');
  report = await daily();
  assertUsdAuditDays('fresh');
  assert.equal(JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')).providerPricingAuditVersion, 2,
    'USD 历史重算完成后标记 v2');
  const usdAfterSecond = JSON.stringify(usdDayOnDisk(auditUsdDayFee));
  report = await daily();
  assert.equal(JSON.stringify(usdDayOnDisk(auditUsdDayFee)), usdAfterSecond, '重复执行幂等：USD 日费用不再变化');
  console.log('USD history audit: relay 有倍率重算 / 缺倍率转欠账 / official+points 保持 / 前缀与 provider 兜底 / 幂等。');
  console.log('PROVIDER FEE CHECKS PASSED');
  console.log('Projection: message/attempt/summary providers, missing-provider defaults, provider-only calls (no event multiplier), replay version.');
  console.log('Overflow: 4004 calls retain 4000 and keep provider/model/peak buckets separate.');
  console.log('Ledger: provider rates, immutable history, provider debt snapshot, legacy multiplier=1 settlement.');
  console.log('Routes: real parent/child subagent cost and exact relay matching; balance total remains unscaled.');
  console.log('Price entries: per-model feeMultiplier multiplies cost and debt; missing/0/-1/"x" fall back to 1.');
}

main().catch((error) => {
  console.error('PROVIDER FEE CHECKS FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (error) { /* best effort test cleanup */ }
});
