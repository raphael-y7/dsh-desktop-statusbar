/**
 * 验证「补上单价后，之前没算的历史调用会自动补算」。
 * 做法：同一份会话数据，先在缺价格的情况下渲染，再写入价格重渲染，比较费用段。
 * 用法：node verify-reprice.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker, '\t\texports.__test = { segmentView, segmentText, setConfig, snapshot };\n' + marker);

const store = new Map();
/** 初始价格库：只有 deepseek-flash */
store.set('dsh.desktopStatusBar.v1', JSON.stringify({
	version: 6, enabled: true, wrap: true, hidden: [],
	segments: null, currency: 'CNY',
	models: { 'deepseek-flash': { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } } },
	modelOrder: ['deepseek-flash']
}));

const fakeWindow = {
	localStorage: {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, v); },
		removeItem: (k) => { store.delete(k); }
	},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) }),
	setInterval: () => 0,
	clearInterval: () => {},
	requestAnimationFrame: (fn) => { fn(); return 0; }
};

let captured = null;
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
		head: { appendChild() {} },
		body: {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

const reactStub = {
	createElement: () => ({}),
	useState: (init) => [init, () => {}],
	useEffect: () => {},
	useRef: () => ({ current: null }),
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

const zh = {
	f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
	unitCost: '', modelUnknown: '未识别'
};
const t = (key, params) => {
	let out = zh[key] === undefined ? key : zh[key];
	if (params !== undefined) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

/* 挑一个北京周六中午（周末整天空闲价，避免时段影响断言） */
let at = Date.UTC(2026, 8, 1, 4, 0);
while (new Date(at + 8 * 3600 * 1000).getUTCDay() !== 6) at += 86400000;

const million = 1000000;
const src = {
	sessionUsage: {
		models: {},
		calls: [
			{ model: 'deepseek-flash', at: at, input: million, cacheRead: 0, cacheWrite: 0, output: 0 },
			{ model: 'glm-5.3-flash', at: at + 1000, input: million, cacheRead: 0, cacheWrite: 0, output: 0 }
		]
	},
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	currency: 'CNY', now: at + 2000
};

const costText = () => api.segmentText('cost', api.segmentView('cost', src, t), t);

/* 1. 价格库里没有 glm：只算 flash 那一笔（1M 未命中输入 × 空闲价 1 元 = ¥1.00） */
const before = costText();
console.log('缺 glm 价格时：', before);
assert.strictEqual(before, '总计 ¥1.00', '缺价格的模型应被跳过，实际 ' + before);

/* 2. 补上 glm 单价（1M 未命中输入 × 空闲价 3 元 = ¥3.00），重算历史调用 */
api.setConfig({
	models: {
		'deepseek-flash': { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } },
		'glm-5.3-flash': { peak: { input: 6, cacheRead: 0.1, cacheWrite: 0, output: 12 }, offPeak: { input: 3, cacheRead: 0.05, cacheWrite: 0, output: 6 } }
	}
});
const after = costText();
console.log('补上 glm 价格后：', after);
assert.strictEqual(after, '总计 ¥4.00', '补上价格后历史调用应立刻计入，实际 ' + after);

/* 3. 再改一次价格：仍然实时反映在历史调用上 */
api.setConfig({
	models: {
		'deepseek-flash': { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } },
		'glm-5.3-flash': { peak: { input: 6, cacheRead: 0.1, cacheWrite: 0, output: 12 }, offPeak: { input: 10, cacheRead: 0.05, cacheWrite: 0, output: 6 } }
	}
});
const changed = costText();
console.log('把 glm 空闲价改成 10 元后：', changed);
assert.strictEqual(changed, '总计 ¥11.00', '改价同样立即作用于历史调用，实际 ' + changed);

console.log('\nREPRICE CHECKS PASSED（缺价的跳过、补价后自动补算、改价即时生效）');
