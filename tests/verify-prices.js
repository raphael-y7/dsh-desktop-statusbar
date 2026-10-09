/**
 * 验证价格库"没填过"时的自愈：**只有所有条目的所有格子都是空的（null）**才算缺失 → 回退官方价。
 * "明确填 0"（有数字格）是用户的有效填写（0 = 免费），不算缺失、也不会被参考价顶掉。
 * 场景来自真实故障与随后的语义澄清：设置页添加过 deepseek-flash，条目被建成全 0；
 * 澄清后全 0 必须原样保留，只有真的一格没填才自愈。
 *
 * 另：价格库版本（`priceVersion`）落后于当前值时并入官方价，方向是
 * **官方价打底、用户条目优先** —— 官方新增的模型补进来，用户已存在的条目一律保留
 * （旧实现反过来，官方价覆盖用户同名条目，用户改过的价会白改）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { pricesMissing, loadConfig, segmentView, isPeakTime, PRICE_VERSION };\n\t\texports.apply = apply;');

/* 明确填 0（用户说的"免费"）：有数字格 ⇒ 不算缺失、要原样留住 */
const ZERO_BOOK = {
	'my-free-model': {
		tiered: false,
		peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
	}
};
/* 一格都没填过（全 null）⇒ 才算缺失、才自愈 */
const NULL_BOOK = {
	'my-free-model': {
		tiered: false,
		peak: { input: null, cacheRead: null, cacheWrite: null, output: null },
		offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null }
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

const api = boot({ version: 4, enabled: true, models: NULL_BOOK });

/* 1. 判定：全 null / 空 → 缺失；明确填 0 或任何数字格 → 不是缺失 */
assert.strictEqual(api.pricesMissing(NULL_BOOK), true, '全 null 的库算缺失');
assert.strictEqual(api.pricesMissing({}), true, 'empty book counts as missing');
assert.strictEqual(api.pricesMissing({ x: { peak: { input: null, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } } }), true, '全 null 条目算缺失');
assert.strictEqual(api.pricesMissing(ZERO_BOOK), false, '明确填 0 不算缺失（用户填的是"免费"）');
assert.strictEqual(api.pricesMissing({ x: { peak: { input: 0, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } } }), false, '只要有一格数字就不算缺失');
assert.strictEqual(api.pricesMissing({ x: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } }), false, 'non-zero book is kept（有非 0 数字）');
assert.strictEqual(api.pricesMissing({ 'my-free-model': { peak: { input: null, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } }, 'x': { peak: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } }), false, '一条全 null + 一条有数字 → 整体不算缺失');
console.log('判定正确：全 null / 空 → 缺失；明确填 0 或任何数字格 → 保留');

/* 2. 全 null 的库（用户真没填过）→ loadConfig 必须自愈成官方价 */
const cfg = api.loadConfig();
console.log('自愈后的价格库:', JSON.stringify(cfg.models));
const flash = cfg.models['deepseek-flash'];
assert.ok(flash !== undefined, 'flash present after self-heal');
assert.strictEqual(flash.peak.output, 8, 'peak output price filled');
assert.strictEqual(flash.offPeak.cacheRead, 0.02, 'off-peak cache read price filled');
assert.strictEqual(cfg.models['my-free-model'], undefined, '全 null 的条目被官方价整库替换');

/* 2b. 明确填 0 的库（当前 priceVersion）必须原样留住：旧判据按"数值总和为 0"算缺失，
   会把用户明确填的 0 价整条换成官方价（用户说的"免费"就这么没了）。 */
const current = boot({ version: 6, priceVersion: api.PRICE_VERSION, enabled: true, models: ZERO_BOOK });
const currentCfg = current.loadConfig();
assert.ok(currentCfg.models['my-free-model'] !== undefined, '明确填 0 的条目还在');
assert.strictEqual(currentCfg.models['my-free-model'].peak.input, 0, '明确填的 0 原样留住');
assert.strictEqual(currentCfg.models['my-free-model'].offPeak.output, 0, '两档的 0 都留住');
assert.strictEqual(currentCfg.models['deepseek-flash'], undefined, '不该把官方参考价并进来（这份库不是"缺失"）');
console.log('明确填 0 的价格库被原样保留:', JSON.stringify(currentCfg.models['my-free-model']));

/* 2c. 价格库版本落后时并入官方价：**官方价打底、用户条目优先**。
   旧实现是 `Object.assign({}, parsed.models, reference)` —— 官方价覆盖用户同名条目，
   与它上面那句注释"用户自己改过的条目不覆盖"正好相反（实测缺陷：用户改过的
   deepseek-flash 被顶回官方价，白改）。 */
const USER_FLASH = {
	tiered: true,
	peak: { input: 99, cacheRead: 8, cacheWrite: 7, output: 66 },
	offPeak: { input: 44, cacheRead: 4, cacheWrite: 3, output: 33 }
};
const legacy = boot({
	version: 6,
	priceVersion: api.PRICE_VERSION - 1,          /* 落后一版 → 触发并入 */
	enabled: true,
	models: {
		'deepseek-flash': USER_FLASH,                /* 用户改过的官方模型 */
		'my-own-model': { tiered: false, peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 1 } }
	}
});
const legacyCfg = legacy.loadConfig();
assert.deepStrictEqual(JSON.parse(JSON.stringify(legacyCfg.models['deepseek-flash'])), USER_FLASH,
	'1) 用户改过的 deepseek-flash 原样保留（不被官方价顶替）');
assert.strictEqual(legacyCfg.models['deepseek-flash'].peak.input, 99, '1) 用户填的 99 还在');
assert.ok(legacyCfg.models['deepseek-v4-pro'] !== undefined, '2) 官方有、用户没有的模型被补进来');
assert.strictEqual(legacyCfg.models['deepseek-v4-pro'].peak.output, 27, '2) 补进来的就是官方价');
assert.strictEqual(legacyCfg.models['my-own-model'].peak.input, 1, '3) 自造模型保留');
assert.strictEqual(legacyCfg.priceVersion, api.PRICE_VERSION, '4) priceVersion 升到当前值（下次不再并入）');
assert.ok(legacyCfg.modelOrder.indexOf('deepseek-v4-pro') >= 0, '2) 补进来的模型也进 modelOrder');
/* 4b. 升级只发生一次：把这次的结果当成"下次启动的配置"再读一遍，用户条目照旧、官方补齐仍在 */
const twice = boot(Object.assign({}, legacyCfg, { models: legacyCfg.models }));
const twiceCfg = twice.loadConfig();
assert.deepStrictEqual(JSON.parse(JSON.stringify(twiceCfg.models['deepseek-flash'])), USER_FLASH,
	'4b) 第二次读配置（priceVersion 已是当前值）用户条目仍原样');
assert.strictEqual(twiceCfg.models['deepseek-v4-pro'].peak.output, 27, '4b) 补进来的官方模型仍在');
assert.strictEqual(twiceCfg.priceVersion, api.PRICE_VERSION, '4b) 版本号保持当前值');
console.log('版本落后时并入官方价：官方价打底、用户条目优先（'
	+ Object.keys(legacyCfg.models).length + ' 条：' + Object.keys(legacyCfg.models).join(' / ') + '）');

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
/* 峰谷分档问插件自己：这里要验的是"自愈后的价格算出来的钱对不对"，
   峰谷规则本身由 verify-weekend / verify-holiday* 单独覆盖。
   早先这里自己按"星期几 + 时段"重算了一遍，漏掉节假日那条，国庆这种日子就假报失败。 */
const tier = api.isPeakTime(Date.now());
const unit = tier ? { cacheRead: 0.04, output: 8 } : { cacheRead: 0.02, output: 4 };
const expect = (3000000 * unit.cacheRead + 50000 * unit.output) / 1e6;
assert.ok(Math.abs(amount - expect) < 0.02, 'amount matches official price: got ' + amount + ' expect ' + expect.toFixed(2) + '（' + (tier ? '高峰' : '空闲') + '档）');

/* 4. 用户自己填过的非 0 价格不能被覆盖 */
const custom = { version: 4, enabled: true, models: { 'my-model': { peak: { input: 3, cacheRead: 0, cacheWrite: 0, output: 6 }, offPeak: { input: 1.5, cacheRead: 0, cacheWrite: 0, output: 3 } } } };
const api2 = boot(custom);
const cfg2 = api2.loadConfig();
assert.strictEqual(cfg2.models['my-model'].peak.input, 3, 'custom price kept');
assert.ok(cfg2.models['my-model'] !== undefined, 'custom model kept');
console.log('自定义价格未被覆盖:', JSON.stringify(cfg2.models['my-model']));

console.log('\nPRICE SELF-HEAL CHECKS PASSED');
