/**
 * 峰谷分时计价测试。
 * 口径（官方 2026-09 价格页）：高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00，
 * 空闲价为高峰价的一半；deepseek-flash 空闲价 = 输入 1 / 缓存命中 0.02 / 输出 4 元每 1M token。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker,
  '\t\texports.__test = { isPeakTime, normalizePrice, priceOf, costOf, segmentView, segmentText, SEGMENTS, StatusBar };\n' + marker);

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0,
	clearInterval: () => {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
};
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
const sandbox = {
	window: fakeWindow,
	document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;

const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useRef: (init) => ({ current: init === undefined ? null : init }),
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useEffect: () => {},
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

const TEMPLATES = {
	f_cost: '总计 {symbol}{cost}',
	f_lastCost: '本轮 {symbol}{cost}',
	f_status_running: '运行中',
	segCounts: '轮次与步数'
};
const t = (key, params) => {
	let out = TEMPLATES[key] !== undefined ? TEMPLATES[key] : '<' + key + '>';
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

/** 北京时间某日某时 → epoch ms（UTC+8） */
function beijingMs(y, m, d, hour, minute) {
	return Date.UTC(y, m - 1, d, hour - 8, minute || 0, 0);
}

/* 2026-09-14 是周一 */
const peakTimes = [
	['周一 09:00', beijingMs(2026, 9, 14, 9, 0), true],
	['周一 11:59', beijingMs(2026, 9, 14, 11, 59), true],
	['周一 12:00', beijingMs(2026, 9, 14, 12, 0), false],
	['周一 13:59', beijingMs(2026, 9, 14, 13, 59), false],
	['周一 14:00', beijingMs(2026, 9, 14, 14, 0), true],
	['周一 17:59', beijingMs(2026, 9, 14, 17, 59), true],
	['周一 18:00', beijingMs(2026, 9, 14, 18, 0), false],
	['周一 23:30', beijingMs(2026, 9, 14, 23, 30), false],
	['周二 03:00', beijingMs(2026, 9, 15, 3, 0), false],
	['周五 10:00', beijingMs(2026, 9, 18, 10, 0), true],
	['周六 10:00', beijingMs(2026, 9, 19, 10, 0), false],
	['周日 15:00', beijingMs(2026, 9, 20, 15, 0), false]
];
for (const [label, ms, want] of peakTimes) {
	assert.strictEqual(api.isPeakTime(ms), want, label + ' peak=' + String(want));
}
console.log('时段判定 ' + peakTimes.length + ' 项通过');

/* 价格取值：缓存命中 0.02（空闲）/ 0.04（高峰）；输出 4 / 8 */
const offPeakAt = beijingMs(2026, 9, 14, 22, 0);   // 周一晚 空闲
const peakAt = beijingMs(2026, 9, 14, 10, 0);      // 周一上午 高峰
const call = { at: offPeakAt, model: 'deepseek-flash', input: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 };

const flatPrice = { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 };
assert.strictEqual(api.normalizePrice(flatPrice).peak.input, 1, 'flat structure mirrors into both tiers');

const cacheOff = api.costOf({ cacheRead: 1000000 }, 'deepseek-flash', offPeakAt);
const cachePeak = api.costOf({ cacheRead: 1000000 }, 'deepseek-flash', peakAt);
console.log('缓存命中 1M：空闲 ¥' + cacheOff + ' / 高峰 ¥' + cachePeak);
assert.strictEqual(cacheOff, '0.02', 'off-peak cache read price');
assert.strictEqual(cachePeak, '0.04', 'peak cache read price');

const inputOff = api.costOf({ input: 1000000 }, 'deepseek-flash', offPeakAt);
const inputPeak = api.costOf({ input: 1000000 }, 'deepseek-flash', peakAt);
assert.strictEqual(inputOff, '1.00', 'off-peak input');
assert.strictEqual(inputPeak, '2.00', 'peak input');

const outOff = api.costOf({ output: 1000000 }, 'deepseek-flash', offPeakAt);
const outPeak = api.costOf({ output: 1000000 }, 'deepseek-flash', peakAt);
assert.strictEqual(outOff, '4.00', 'off-peak output');
assert.strictEqual(outPeak, '8.00', 'peak output');

/* pro 模型：高峰输入 9 元 / 空闲 4.5 元 */
assert.strictEqual(api.costOf({ input: 1000000 }, 'deepseek-v4-pro', peakAt), '9.00', 'pro peak input');
assert.strictEqual(api.costOf({ input: 1000000 }, 'deepseek-v4-pro', offPeakAt), '4.50', 'pro off-peak input');

/* 旧格式价格库（两档同价）不应因峰谷而变价 */
const legacy = { input: 3, cacheRead: 0, cacheWrite: 0, output: 6 };
const legacyPeak = api.isPeakTime(peakAt) ? 3 : 1;
console.log('旧格式兜底（同价）按 ' + legacyPeak + ' 元/1M 输入计');
assert.strictEqual(api.normalizePrice(legacy).peak.input, api.normalizePrice(legacy).offPeak.input, 'legacy flat stays flat');

/* 会话总费用：跨时段的三条调用 */
const usageCalls = [
	{ at: offPeakAt, model: 'deepseek-flash', input: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 },  // 0.02
	{ at: peakAt, model: 'deepseek-flash', input: 0, cacheRead: 1000000, cacheWrite: 0, output: 0 },     // 0.04
	{ at: peakAt, model: 'deepseek-flash', input: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 }      // 2.00
];
const src = {
	sessionUsage: { models: { 'deepseek-flash': { input: 1000000, cacheRead: 2000000, cacheWrite: 0, output: 0 } }, calls: usageCalls, current: null, last: null },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	currency: 'CNY', now: peakAt
};
const costView = api.segmentView('cost', src, t);
console.log('会话总费用：', JSON.stringify(costView));
assert.ok(costView !== null && costView.text.indexOf('2.06') >= 0, 'total mixes peak and off-peak: ' + JSON.stringify(costView));

/* 本轮费用：current.calls 两条（高峰） */
const srcTurn = {
	sessionUsage: { models: {}, calls: usageCalls, current: { calls: [usageCalls[1], usageCalls[2]] }, last: null },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	currency: 'CNY', now: peakAt, turnUsage: null
};
const turnView = api.segmentView('lastCost', srcTurn, t);
console.log('本轮费用：', JSON.stringify(turnView));
assert.ok(turnView !== null && turnView.text.indexOf('2.04') >= 0, 'turn cost sums its own calls: ' + JSON.stringify(turnView));

/* 状态点：segmentView 的 state 不能被占位逻辑吃掉 */
const statusView = api.segmentView('status', { running: true }, t);
assert.strictEqual(statusView.state, 'running', 'status view keeps state');
const rendered = [];
api.SEGMENTS.filter((s) => s.def).forEach((s) => rendered.push(api.segmentText(s.id, api.segmentView(s.id, { running: true, currency: 'CNY', now: Date.now() }, t), t)));
assert.ok(rendered[0] === t('f_peak') || rendered[0] === t('f_valley'), 'status segment carries the period text, got ' + rendered[0]);

console.log('\nPEAK/OFF-PEAK CHECKS PASSED');
