/**
 * 验证价格库全 0 时的自愈：加载配置就该回退到官方价，费用不再显示 ¥0.00。
 * 场景来自真实故障：设置页添加过 deepseek-flash，条目被建成全 0。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { pricesMissing, loadConfig, segmentView };\n\t\texports.apply = apply;');

const ZERO_BOOK = {
	'deepseek-flash': {
		peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
	}
};
const STORAGE_KEY = 'dsh.desktopStatusBar.v1';

function boot(stored) {
	const store = new Map();
	if (stored !== undefined) store.set(STORAGE_KEY, JSON.stringify(stored));
	let cap = null;
	const w = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, v),
			removeItem: (k) => store.delete(k)
		},
		setInterval: () => 0,
		clearInterval: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
		__ModuleLoader__: { load: (e) => { cap = e; } }
	};
	const sb = {
		window: w,
		document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
	};
	sb.globalThis = sb;
	vm.createContext(sb);
	vm.runInContext(code, sb, { filename: 'client.js' });
	return cap.factory((n) => {
		if (n !== 'react') throw new Error('unexpected require: ' + n);
		return {
			createElement: () => ({}), useState: (v) => [v, () => {}], useRef: () => ({}),
			useSyncExternalStore: (s, g) => g(), useEffect: () => {}, Fragment: Symbol('F')
		};
	}).__t;
}

const api = boot({ version: 4, enabled: true, models: ZERO_BOOK });

/* 1. 全 0 要判定为"缺失" */
assert.strictEqual(api.pricesMissing(ZERO_BOOK), true, 'all-zero book counts as missing');
assert.strictEqual(api.pricesMissing({}), true, 'empty book counts as missing');
assert.strictEqual(api.pricesMissing({ x: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } }), false, 'non-zero book is kept');
console.log('判定正确：全 0 / 空 → 缺失；有非 0 → 保留');

/* 2. loadConfig 必须把全 0 价格库换回官方价 */
const cfg = api.loadConfig();
console.log('自愈后的价格库:', JSON.stringify(cfg.models));
const flash = cfg.models['deepseek-flash'];
assert.ok(flash !== undefined, 'flash present after self-heal');
assert.strictEqual(flash.peak.output, 8, 'peak output price filled');
assert.strictEqual(flash.offPeak.cacheRead, 0.02, 'off-peak cache read price filled');

/* 3. 真实用量下费用不再是 0 */
const calls = [
	{ at: Date.now(), model: 'deepseek-flash', input: 0, cacheRead: 1000000, cacheWrite: 0, output: 20000 },
	{ at: Date.now(), model: 'deepseek-flash', input: 0, cacheRead: 2000000, cacheWrite: 0, output: 30000 }
];
const t = (key, params) => {
	const dict = { f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}' };
	let out = dict[key] !== undefined ? dict[key] : '<' + key + '>';
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
const view = api.segmentView('cost', {
	sessionUsage: { models: {}, calls, current: null, last: null, turn: 1 },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	currency: 'CNY', now: Date.now(), turnUsage: null
}, t);
console.log('费用段:', JSON.stringify(view));
assert.ok(view !== null, 'cost renders');
const amount = Number(String(view.text).replace(/[^\d.]/g, ''));
assert.ok(amount > 0, 'cost is no longer zero: ' + view.text);
const tier = (new Date().getTimezoneOffset() === -480) && (() => {
	const bj = new Date(Date.now() + 8 * 3600 * 1000);
	const day = bj.getUTCDay();
	const hour = bj.getUTCHours() + bj.getUTCMinutes() / 60;
	return day !== 0 && day !== 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
})();
const unit = tier ? { cacheRead: 0.04, output: 8 } : { cacheRead: 0.02, output: 4 };
const expect = (3000000 * unit.cacheRead + 50000 * unit.output) / 1e6;
assert.ok(Math.abs(amount - expect) < 0.02, 'amount matches official price: got ' + amount + ' expect ' + expect.toFixed(2));

/* 4. 用户自己填过的非 0 价格不能被覆盖 */
const custom = { version: 4, enabled: true, models: { 'my-model': { peak: { input: 3, cacheRead: 0, cacheWrite: 0, output: 6 }, offPeak: { input: 1.5, cacheRead: 0, cacheWrite: 0, output: 3 } } } };
const api2 = boot(custom);
const cfg2 = api2.loadConfig();
assert.strictEqual(cfg2.models['my-model'].peak.input, 3, 'custom price kept');
assert.ok(cfg2.models['my-model'] !== undefined, 'custom model kept');
console.log('自定义价格未被覆盖:', JSON.stringify(cfg2.models['my-model']));

console.log('\nPRICE SELF-HEAL CHECKS PASSED');
