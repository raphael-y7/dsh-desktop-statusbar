/**
 * 价格设置 UI + 「第三方平台」独立区块回归测试（task-39 最终口径）。
 *
 * 覆盖：
 *   ① i18n 中英键对齐、setInterval 恰好 2 处、代码/文案不出现「通道」概念；
 *   ② 官方模型默认全部加入价格表（v4 播种 / v6+v8 补播新增，已有条目一律不动）；目录只有价格卡，
 *      删除后行消失、「恢复默认」找回（数据来自 docs/official-models.json）；
 *   ③ 模型价格气泡里**不再有**第三方平台字段（勾选 / 请求头 / 令牌 / 用户 ID / 地址 / 余额字段 / 倍率），
 *      改为价格卡下方独立的「第三方平台」区块：平台增删改、适用模型**自由输入行** → 按模型倍率写进价格条目、
 *      secret 一次性（不回显 / 不落 localStorage）、地址留空 = 只按倍率计费、档案里没填的字段存空
 *      （默认值只在向宿主 POST 余额配置时补）、旧 relay 配置迁移成平台；
 *   ③-2 平台名 123 / 英文 / 符号都能添加并立刻出现编辑行；「点别处」不会取消刚打开的平台编辑（task-41）；
 *   ④ 开发模式 0 次真实 fetch（中转站 GET 也要遵守）；
 *   ⑤ 费用倍率在本轮与总计生效、默认 1、子智能体不乘、欠账也乘、改倍率触发总计重算；
 *   ⑥ 价格库上报自动带 feeMultiplier；
 *   ⑦ 余额请求按「会话模型 → 归属平台」追加 `&relay=平台名`（宽容匹配，取不到归属就不加）。
 *
 * 用法：node tests/verify-relay-settings.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const os = require('os');

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-test-home-relay-settings-'));
process.env.DSH_HOME = TEMP_HOME;

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(PLUGIN, 'utf8');

/* 官方目录数据（内嵌进 client.js 的同一份来源）：核对播种内容与厂商顺序 */
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'official-models.json'), 'utf8'));
const CATALOG_VENDORS = CATALOG.vendors;
const CATALOG_NAMES = [];
CATALOG_VENDORS.forEach((vendor) => { vendor.models.forEach((model) => { CATALOG_NAMES.push(model.name); }); });
/* 厂商默认顺序 = AA 智力指数（docs/vendor-intelligence-order.json） */
const AA_VENDOR_ORDER = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'vendor-intelligence-order.json'), 'utf8'))
	.map((one) => one.vendorId);

const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
const injected = code.replace(marker,
	'\t\texports.__test = { zh: zh, en: en, SettingsSection: SettingsSection, StatusBar: StatusBar, '
	+ 'segmentView: segmentView, segmentText: segmentText, setConfig: setConfig, snapshot: snapshot, '
	+ 'DEFAULT_PRICES: DEFAULT_PRICES, STORAGE_KEY: STORAGE_KEY, ensureRelayState: ensureRelayState, '
	+ 'relaySnapshot: relaySnapshot, setDevMode: setDevMode };\n' + marker);
assert.ok(injected !== code, '插桩导出失败（找不到 exports.apply 那行）');

/* ------------------------------------------------------------ 最小替身 */
let activeHooks = null;
function makeHooks(presets) {
	return { values: [], refs: [], deps: [], index: 0, stateIndex: 0, pending: [], presets: presets === undefined ? null : presets };
}
function withHooks(bucket, fn) {
	const prev = activeHooks;
	activeHooks = bucket;
	bucket.index = 0;
	bucket.stateIndex = 0;
	bucket.pending = [];
	let out;
	try {
		out = fn();
	} finally {
		activeHooks = prev;
	}
	const queued = bucket.pending;
	bucket.pending = [];
	queued.forEach((one) => one());
	return out;
}
/* 非 useState 的 hook 只占一个调用位（不碰 values —— 那里只按 useState 序号存值） */
function hookSlot() {
	if (activeHooks === null) return;
	activeHooks.index += 1;
}
/* useState 单独计数：presets 的下标 = 第几个 useState，与 tools/shot.cjs 的口径一致 */
function useStateSlot(init) {
	if (activeHooks === null) return [undefined, () => {}];
	const bucket = activeHooks;
	const at = bucket.stateIndex;
	bucket.stateIndex += 1;
	bucket.index += 1;
	if (bucket.values.length <= at) {
		const preset = bucket.presets !== null && bucket.presets[at] !== undefined ? bucket.presets[at] : undefined;
		bucket.values[at] = preset !== undefined ? preset : (typeof init === 'function' ? init() : init);
	}
	return [
		bucket.values[at],
		(value) => { bucket.values[at] = typeof value === 'function' ? value(bucket.values[at]) : value; }
	];
}

function loadClient(fetchImpl, initialStore) {
	/* initialStore：模拟"用户机器上已有的 localStorage"（[key, value] 数组），用来测迁移播种 */
	const store = new Map(initialStore === undefined ? [] : initialStore);
	const fetchLog = [];
	const fakeWindow = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => { store.set(k, v); },
			removeItem: (k) => { store.delete(k); }
		},
		innerWidth: 1200, innerHeight: 900,
		setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
		addEventListener: () => {}, removeEventListener: () => {},
		requestAnimationFrame: (fn) => { fn(); return 0; },
		cancelAnimationFrame: () => {},
		fetch: (url, init) => {
			fetchLog.push({ url: String(url), init: init });
			return fetchImpl === undefined
				? Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) })
				: fetchImpl(String(url), init);
		}
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

	const reactStub = {
		createElement: (type, props, ...children) => ({
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
		}),
		useState: (init) => useStateSlot(init),
		useEffect: (fn, deps) => {
			if (activeHooks === null || typeof fn !== 'function') return;
			const at = activeHooks.index;
			hookSlot();
			const prev = activeHooks.deps[at];
			const same = Array.isArray(deps) === true && Array.isArray(prev) === true
				&& deps.length === prev.length && deps.every((one, index) => one === prev[index]);
			activeHooks.deps[at] = Array.isArray(deps) ? deps.slice() : undefined;
			if (same === true) return;
			const cleanup = fn();
			if (typeof cleanup === 'function') activeHooks.pending.push(cleanup);
		},
		useLayoutEffect: (fn) => {
			if (activeHooks === null || typeof fn !== 'function') return;
			hookSlot();
			const cleanup = fn();
			if (typeof cleanup === 'function') activeHooks.pending.push(cleanup);
		},
		useRef: (init) => {
			if (activeHooks === null) return { current: init === undefined ? null : init };
			const at = activeHooks.index;
			hookSlot();
			if (activeHooks.refs[at] === undefined) activeHooks.refs[at] = { current: init === undefined ? null : init };
			return activeHooks.refs[at];
		},
		useMemo: (fn) => { hookSlot(); return fn(); },
		useCallback: (fn) => { hookSlot(); return fn; },
		useSyncExternalStore: (subscribe, snapshot) => { hookSlot(); return snapshot(); },
		Fragment: Symbol('Fragment')
	};

	/* 文档级 click 监听：页面上的「点别处收起编辑区」靠它。测试里可以主动派发一次
	   「点在编辑区外面」的点击，验证它不会把刚打开的平台编辑行顺手取消掉。 */
	const docClicks = [];
	const fakeDocument = {
		documentElement: { classList: { add() {}, remove() {} } },
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {}, className: '' }),
		body: {}, head: { appendChild() {} },
		addEventListener: (name, fn) => { if (name === 'click' && docClicks.indexOf(fn) === -1) docClicks.push(fn); },
		removeEventListener: (name, fn) => {
			const at = docClicks.indexOf(fn);
			if (at !== -1) docClicks.splice(at, 1);
		}
	};
	const sandbox = {
		window: fakeWindow,
		document: fakeDocument,
		MutationObserver: class { observe() {} disconnect() {} },
		react: reactStub,
		console: console, Promise: Promise, Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array,
		Number: Number, String: String, Boolean: Boolean, Symbol: Symbol, Set: Set, Map: Map, Error: Error,
		setTimeout: setTimeout, clearTimeout: clearTimeout,
		requestAnimationFrame: (fn) => { fn(); return 0; },
		cancelAnimationFrame: () => {}
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(injected, sandbox, { filename: 'client.js' });
	assert.ok(captured !== null && captured.factory !== undefined, '插件工厂没被捕获');
	const api = captured.factory((name) => {
		if (name === 'react') return reactStub;
		if (name === 'react-dom') throw new Error('no react-dom');
		throw new Error('unexpected require: ' + name);
	}).__test;
	assert.ok(api !== undefined, '__test 插桩导出没拿到');
	return {
		api: api, store: store, fetchLog: fetchLog, hooks: makeHooks,
		/* 派发一次「点在编辑区外面」的文档点击（target 不是 DOM 节点 = 不在任何浮层里） */
		outsideClick: () => docClicks.slice().forEach((fn) => fn({ target: null, clientX: 0, clientY: 0 })),
		docClickCount: () => docClicks.length
	};
}

function translator(api) {
	const table = api.zh;
	return (key, params) => {
		let out = table[key] === undefined ? key : table[key];
		if (params !== undefined && params !== null) {
			out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
		}
		return out;
	};
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function textOf(node) {
	const out = [];
	(function step(one) {
		if (typeof one === 'string' || typeof one === 'number') { out.push(String(one)); return; }
		if (one === null || one === undefined || one === false || one === true) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		(one.children || []).forEach(step);
	})(node);
	return out.join('');
}
function findAll(node, pred) {
	const out = [];
	(function step(one) {
		if (one === null || one === undefined || one === false || one === true) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		if (pred(one)) out.push(one);
		(one.children || []).forEach(step);
	})(node);
	return out;
}
const classOf = (node) => (typeof node.props.className === 'string' ? node.props.className : '');
const hasClass = (node, name) => classOf(node).split(' ').indexOf(name) !== -1;
const buttonsByLabel = (tree, label) => findAll(tree, (node) => node.type === 'button'
	&& hasClass(node, 'dsb-action') && textOf(node) === label);
const findLabelInput = (tree, label) => {
	/* 中转站字段行（dsb-relay-line）与费用倍率行（dsb-field）都是「标签 + 输入框」 */
	const row = findAll(tree, (node) => node.type === 'label'
		&& (hasClass(node, 'dsb-relay-line') || hasClass(node, 'dsb-field'))
		&& textOf(node) === label)[0];
	return row === undefined ? undefined : findAll(row, (one) => one.type === 'input')[0];
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* 北京时间周三 20:00（空闲）：deepseek-flash 空闲输出 4 元/M，25 万 token = ¥1.00 */
const OFF_PEAK = Date.UTC(2026, 9, 14, 12, 0, 0);
const callOf = (model, output) => ({
	at: OFF_PEAK, model: model, provider: 'deepseek-official',
	input: 0, cacheRead: 0, cacheWrite: 0, output: output
});
const holdOf = () => ({
	sessionId: null, seen: new Map(), cost: 0, tokens: null,
	priced: false, subCostSettled: 0, debts: new Map(), feeFingerprint: ""
});
const CNY_BASE = {
	'deepseek-flash': {
		tiered: true, currency: 'CNY',
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
	}
};
function totalSrc(api, calls, extra) {
	const book = api.snapshot().models;
	return Object.assign({
		sessionUsage: { models: book, calls: calls, overflow: {}, summaryParts: null },
		sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
		usage: null, subagent: null,
		currency: 'CNY', defaultCurrency: 'CNY', models: book, now: OFF_PEAK,
		sessionId: 'relay-session', totalHold: holdOf()
	}, extra === undefined ? {} : extra);
}
function totalText(api, src, t) {
	const view = api.segmentView('cost', src, t);
	return api.segmentText('cost', view, t, 'CNY');
}
function lastCostText(api, src, t) {
	const view = api.segmentView('lastCost', src, t);
	return api.segmentText('lastCost', view, t, 'CNY');
}
const savedModels = (inst) => JSON.parse(inst.store.get(inst.api.STORAGE_KEY)).models;

async function main() {
/* ====================================================================
   ① i18n 键对齐 / setInterval / 无「通道」概念
   ==================================================================== */
console.log('===== ① i18n / setInterval / 无「通道」概念 =====');
{
	const inst = loadClient();
	const zhKeys = Object.keys(inst.api.zh).sort();
	const enKeys = Object.keys(inst.api.en).sort();
	assert.deepStrictEqual(zhKeys, enKeys, 'zh / en 文案键必须一一对应');
	['secPlatforms', 'secPlatformsBadge', 'secPlatformsHint', 'platformNewPh', 'platformAdd', 'platformEmpty',
		'platformModels', 'platformModelSelectPh', 'platformFeePh', 'platformAddModel',
		'platformNameRequired', 'platformNameDuplicate',
		'platformSecretSaved', 'priceFeeMultiplier', 'priceFeeMultiplierInvalid',
		'priceTokenHeader', 'priceTokenHeaderHint', 'priceToken', 'priceTokenHint', 'priceUserId', 'priceUserIdHint',
		'priceEndpoint', 'priceEndpointHint', 'priceBalanceField', 'priceBalanceFieldHint', 'priceBalanceFieldInvalid',
		'priceEndpointInvalid', 'priceRelaySyncFailed'].forEach((key) => {
		assert.ok(zhKeys.indexOf(key) !== -1, '缺少第三方平台文案键：' + key);
	});
	/* 旧「模型气泡里的第三方平台」专用键已随 UI 一起删掉（deadcode 会盯着未引用键） */
	['priceRelay', 'priceRelayMagpieNote'].forEach((key) => {
		assert.strictEqual(zhKeys.indexOf(key), -1, '旧的气泡专用文案键应删除：' + key);
	});
	assert.strictEqual(code.indexOf('通道'), -1, 'UI/文案/注释里不出现「通道」概念');
	assert.ok(code.indexOf('/api/relay-balance-config') !== -1, '恢复中转站余额查询路由');
	const intervalCount = (code.match(/setInterval\(/g) || []).length;
	assert.strictEqual(intervalCount, 2, 'lib/client.js 里 setInterval( 必须恰好 2 处，实际 ' + intervalCount);
	console.log('      ' + zhKeys.length + ' 个文案键中英一致；setInterval = ' + intervalCount + '；无「通道」字样');
}

/* ====================================================================
   ② 官方目录：默认全部已加入（价格卡），无点名字加入
   ==================================================================== */
console.log('\n===== ② 官方目录：默认全部已加入（价格卡），无点名字加入 =====');
{
	/* 模拟真实老用户：价格库版本 3、已有改过的官方条目 + 自建条目 */
	const OLD_CONFIG = JSON.stringify({
		version: 6,
		priceVersion: 3,
		currency: 'CNY',
		contextMeter: true,
		segments: ['status', 'counts', 'cacheHit', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'],
		hidden: [],
		models: {
			'deepseek-flash': {
				tiered: true, currency: 'CNY', feeMultiplier: 2,
				peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 },
				offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
			},
			'my-model': {
				tiered: false, currency: 'CNY', feeMultiplier: 3,
				peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 },
				offPeak: null
			}
		},
		modelOrder: ['deepseek-flash', 'my-model'],
		holidayDays: []
	});
	const probe = loadClient();
	const CONFIG_KEY = probe.api.STORAGE_KEY;
	const inst = loadClient(undefined, [[CONFIG_KEY, OLD_CONFIG]]);
	const api = inst.api;
	const t = translator(api);
	const models = api.snapshot().models;

	/* 播种：官方模型全部进价格库；已有条目一律不动 */
	assert.strictEqual(api.snapshot().priceVersion, 8, '迁移后价格库版本应为 8');
	CATALOG_NAMES.forEach((name) => {
		assert.ok(models[name] !== undefined, '官方模型应默认加入价格库：' + name);
	});
	assert.deepStrictEqual(plain(models['deepseek-flash']), {
		tiered: true, currency: 'CNY', feeMultiplier: 2,
		peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
		/* v7：基准价 = 官网原值 + 官网币种 */
		base: { currency: 'CNY', peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } },
	}, '用户改过的官方条目迁移时不许覆盖（含 feeMultiplier）');
	assert.deepStrictEqual(plain(models['my-model']), {
		tiered: false, currency: 'CNY', feeMultiplier: 3,
		peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 },
		offPeak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 },
		base: { currency: 'CNY', peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 }, offPeak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 } },
	}, '自建条目迁移时原样保留（价格与费用倍率）');
	assert.deepStrictEqual(plain(models['claude-opus-5.5']), {
		tiered: false, currency: 'USD',
		peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
		offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
		base: { currency: 'USD', peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } },
	}, '未配置过的官方模型按官网价播种（单档）');
	assert.deepStrictEqual(plain(models['GLM-5.3']), {
		tiered: false, currency: 'CNY',
		peak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
		offPeak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 },
		base: { currency: 'CNY', peak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 }, offPeak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 } },
	}, '未配置过的官方模型按官网价播种（CNY）');
	assert.strictEqual(models['qwen3.8-flash'].peak.cacheRead, null, '官网未公布的字段保持 null');
	assert.strictEqual(models['mimo-v2.6-pro-ultraspeed'].peak.input, 30, '小米顶配按官网价播种');

	/* v5 清理：旧版目录点选加入的已下架官方模型，迁移时按**确切名字**删除；自建条目与当前官方模型保留 */
	const RETIRED_CONFIG = JSON.stringify({
		version: 6,
		priceVersion: 4,
		currency: 'CNY',
		models: {
			'GLM-5.2': { tiered: false, currency: 'CNY', peak: { input: 1, cacheRead: null, cacheWrite: null, output: 2 }, offPeak: null },
			'muse-spark-1.1': { tiered: false, currency: 'USD', peak: { input: 1, cacheRead: null, cacheWrite: null, output: 2 }, offPeak: null },
			'my-model': { tiered: false, currency: 'CNY', peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 }, offPeak: null },
			'GLM-5.3': { tiered: false, currency: 'CNY', peak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 }, offPeak: null }
		},
		modelOrder: ['GLM-5.2', 'muse-spark-1.1', 'my-model', 'GLM-5.3'],
		holidayDays: []
	});
	const migrated = loadClient(undefined, [[CONFIG_KEY, RETIRED_CONFIG]]);
	const migratedApi = migrated.api;
	const migratedModels = migratedApi.snapshot().models;
	assert.strictEqual(migratedApi.snapshot().priceVersion, 8, '旧配置迁移后价格库版本应为 8');
	assert.strictEqual(migratedModels['GLM-5.2'], undefined, '已下架官方模型迁移时应被清理');
	assert.strictEqual(migratedModels['muse-spark-1.1'], undefined, '小写 muse 键同样按确切名字清理');
	assert.ok(migratedModels['my-model'] !== undefined, '真正自建条目必须保留');
	assert.ok(migratedModels['GLM-5.3'] !== undefined, '当前官方目录模型必须保留');
	assert.strictEqual(plain(migratedApi.snapshot().modelOrder).indexOf('GLM-5.2'), -1, 'modelOrder 同步移除已下架官方模型');
	const migratedTree = withHooks(migrated.hooks(), () => migratedApi.SettingsSection({ t: translator(migratedApi), useProjection: () => undefined }));
	const migratedCustom = findAll(migratedTree, (node) => hasClass(node, 'dsb-catalog-vendor') && node.props.key === '__custom')[0];
	assert.ok(migratedCustom !== undefined, '仍有自建模型所以自定义模型组保留');
	assert.deepStrictEqual(findAll(migratedCustom, (one) => hasClass(one, 'dsb-model')).map((one) => one.props.key), ['my-model'],
		'自定义模型组里只剩真正的自建模型（旧官方残留已清走）');
	/* 恢复默认只加回当前 MODEL_PRESENTATION，不会把已下架官方模型加回来 */
	const migratedBefore = JSON.stringify(savedModels(migrated));
	buttonsByLabel(migratedTree, t('reset'))[0].props.onClick();
	assert.strictEqual(savedModels(migrated)['GLM-5.2'], undefined, '恢复默认不会加回已下架官方模型');
	assert.ok(savedModels(migrated)['my-model'] !== undefined, '恢复默认保留自建条目');
	assert.ok(JSON.stringify(savedModels(migrated)).length > 0 && migratedBefore.length > 0, '配置非空');


	/* v6/v8 补播：老用户的 priceVersion=5 价格库（官方目录 27 条里缺 kimi-k3）→ 自动补上 kimi-k3；
	   已有条目一律不动；已下架模型不会被补回来。 */
	const catalogModelOf = (name) => {
		for (let i = 0; i < CATALOG_VENDORS.length; i += 1) {
			const found = CATALOG_VENDORS[i].models.filter((one) => one.name === name)[0];
			if (found !== undefined) return found;
		}
		return undefined;
	};
	const fixtureEntry = (model) => {
		const tier = (one) => ({ input: one.input, cacheRead: one.cacheRead, cacheWrite: one.cacheWrite, output: one.output });
		return model.tiered === true
			? { tiered: true, currency: model.currency, peak: tier(model.peak), offPeak: tier(model.offPeak) }
			: { tiered: false, currency: model.currency, peak: tier(model), offPeak: null };
	};
	const V5_MODELS = {};
	CATALOG_NAMES.filter((name) => name !== 'kimi-k3').forEach((name) => {
		V5_MODELS[name] = fixtureEntry(catalogModelOf(name));
	});
	V5_MODELS['deepseek-flash'] = {
		tiered: true, currency: 'CNY', feeMultiplier: 2,
		peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
	};
	V5_MODELS['my-model'] = {
		tiered: false, currency: 'CNY',
		peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 }, offPeak: null
	};
	const V5_CONFIG = JSON.stringify({
		version: 6, priceVersion: 5, currency: 'CNY', models: V5_MODELS,
		modelOrder: Object.keys(V5_MODELS), holidayDays: []
	});
	const backfilled = loadClient(undefined, [[CONFIG_KEY, V5_CONFIG]]);
	const backfilledModels = backfilled.api.snapshot().models;
	assert.strictEqual(backfilled.api.snapshot().priceVersion, 8, 'v5 → v8 迁移后版本号升到 8');
	assert.deepStrictEqual(plain(backfilledModels['kimi-k3']), {
		tiered: false, currency: 'CNY',
		peak: { input: 20, cacheRead: 2, cacheWrite: 20, output: 100 },
		offPeak: { input: 20, cacheRead: 2, cacheWrite: 20, output: 100 },
		/* 播种时就带基准价 = 官网原值 + 官网币种 */
		base: { currency: 'CNY', peak: { input: 20, cacheRead: 2, cacheWrite: 20, output: 100 }, offPeak: { input: 20, cacheRead: 2, cacheWrite: 20, output: 100 } }
	}, 'v6 补播：缺失的 kimi-k3 按官网价补进价格库');
	assert.deepStrictEqual(plain(backfilledModels['deepseek-flash']), {
		tiered: true, currency: 'CNY', feeMultiplier: 2,
		peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
		base: { currency: 'CNY', peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } }
	}, 'v6 补播不动用户改过的官方条目（含 feeMultiplier）');
	assert.deepStrictEqual(plain(backfilledModels['my-model']), {
		tiered: false, currency: 'CNY',
		peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 },
		offPeak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 },
		base: { currency: 'CNY', peak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 }, offPeak: { input: 7, cacheRead: null, cacheWrite: null, output: 11 } }
	}, 'v6 补播不动自建条目');
	assert.strictEqual(backfilledModels['GLM-5.2'], undefined, 'v6 补播不会把已下架的官方模型加回来');
	assert.deepStrictEqual(Object.keys(backfilledModels).sort(), CATALOG_NAMES.concat(['my-model']).sort(),
		'v6/v8 补播只补当前官方目录缺失项：27 条官方 + 1 条自建');
	/* 二次加载：版本已是 6，不再补播、也不改动 */
	const reloaded = loadClient(undefined, [[CONFIG_KEY, backfilled.store.get(CONFIG_KEY)]]);
	assert.strictEqual(reloaded.api.snapshot().priceVersion, 8, '已迁移配置再次加载不回退版本');
	assert.deepStrictEqual(Object.keys(reloaded.api.snapshot().models).sort(), CATALOG_NAMES.concat(['my-model']).sort(),
		'二次加载模型集合不变（不会重复补播）');
	console.log('      v6/v8 补播：v5 价格库自动补上 kimi-k3（27 条），用户条目不动、已下架模型不回流');


	/* v7 迁移：缺 base 的旧条目补「当前值 + 当前币种」，数值一字不动 */
	const NO_BASE_CONFIG = JSON.stringify({
		version: 6, priceVersion: 6, currency: 'CNY',
		models: {
			'my-usd': { tiered: false, currency: 'USD', peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, offPeak: null },
			'deepseek-flash': { tiered: true, currency: 'CNY', peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } }
		},
		modelOrder: ['my-usd', 'deepseek-flash'], holidayDays: []
	});
	const noBase = loadClient(undefined, [[CONFIG_KEY, NO_BASE_CONFIG]]);
	const noBaseModels = noBase.api.snapshot().models;
	assert.strictEqual(noBase.api.snapshot().priceVersion, 8, 'v6 → v8 迁移后版本号升到 8');
	assert.deepStrictEqual(plain(noBaseModels['my-usd']), {
		tiered: false, currency: 'USD',
		peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
		offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
		base: { currency: 'USD', peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } }
	}, 'v7 迁移：缺 base 的条目补「当前值 + 当前币种」，价格数值一字不动');
	assert.deepStrictEqual(plain(noBaseModels['deepseek-flash']), {
		tiered: true, currency: 'CNY',
		peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
		base: { currency: 'CNY', peak: { input: 99, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } }
	}, 'v7 迁移不改数值，只补基准价');
	console.log('      v7 迁移：旧条目补基准价（= 当前值 + 当前币种，数值不变）');

	/* 目录渲染：10 厂商，每个官方模型直接是价格卡（无点名字按钮） */
	const bucket = inst.hooks();
	const props = { t: t, useProjection: () => undefined };
	const render = () => withHooks(bucket, () => api.SettingsSection(props));
	let tree = render();
	const vendors = findAll(tree, (node) => hasClass(node, 'dsb-catalog-vendor'));
	assert.deepStrictEqual(vendors.map((one) => one.props.key), AA_VENDOR_ORDER.concat(['__custom']),
		'目录按 AA 智力指数顺序分组（自定义组在最后）');
	assert.strictEqual(findAll(tree, (one) => hasClass(one, 'dsb-catalog-title')).length, 0, '「官方模型目录」标题已删除');
	assert.strictEqual(findAll(tree, (one) => hasClass(one, 'dsb-catalog-count')).length, 0, '「N 个模型」计数已删除');
	assert.strictEqual(textOf(tree).indexOf('个模型'), -1, '界面上不再出现「个模型」字样');
	assert.strictEqual(textOf(tree).indexOf('官方模型目录'), -1, '界面上不再出现「官方模型目录」标题');
	assert.deepStrictEqual(AA_VENDOR_ORDER.slice().sort(), CATALOG_VENDORS.map((one) => one.id).sort(),
		'AA 顺序里的厂商集合必须与官方目录数据一致（不许漏也不许多）');
	assert.strictEqual(findAll(tree, (node) => hasClass(node, 'dsb-catalog-pick')).length, 0,
		'目录里不再有可点模型名（官方模型默认已加入）');
	const vendorByKey = (key) => findAll(tree, (node) => hasClass(node, 'dsb-catalog-vendor') && node.props.key === key)[0];
	CATALOG_VENDORS.forEach((vendor) => {
		const node = vendorByKey(vendor.id);
		assert.ok(node !== undefined, '厂商分组缺失：' + vendor.id);
		const names = vendor.models.map((one) => one.name);
		assert.deepStrictEqual(findAll(node, (one) => hasClass(one, 'dsb-catalog-model')).map((one) => findAll(one, (card) => hasClass(card, 'dsb-model'))[0].props.key), names,
			'厂商组里按数据顺序列出该厂商的官方模型卡：' + vendor.id);
		names.forEach((name) => {
			const card = findAll(node, (one) => hasClass(one, 'dsb-model') && one.props.key === name)[0];
			assert.ok(card !== undefined, '官方模型应直接显示价格卡：' + name);
			assert.strictEqual(buttonsByLabel(card, t('priceEdit')).length, 1, '价格卡有「修改」：' + name);
			assert.strictEqual(buttonsByLabel(card, t('priceRemove')).length, 1, '价格卡有「删除」：' + name);
		});
		assert.strictEqual(findAll(node, (one) => hasClass(one, 'dsb-catalog-pick')).length, 0, '组内无点名字按钮：' + vendor.id);
		assert.strictEqual(findAll(node, (one) => hasClass(one, 'dsb-catalog-source')).length, 0, '不再有来源链接：' + vendor.id);
		assert.strictEqual(findAll(node, (one) => hasClass(one, 'dsb-catalog-rate')).length, 0, '不再有费率说明：' + vendor.id);
		assert.strictEqual(findAll(node, (one) => hasClass(one, 'dsb-catalog-actions')).length, 0, '不再有添加按钮容器：' + vendor.id);
		assert.strictEqual(findAll(node, (one) => hasClass(one, 'dsb-action')).length, names.length * 2, '每张卡只有修改/删除：' + vendor.id);
	});
	const customVendor = vendorByKey('__custom');
	assert.ok(customVendor !== undefined, '自建模型进入自定义分组');
	assert.deepStrictEqual(findAll(customVendor, (one) => hasClass(one, 'dsb-model')).map((one) => one.props.key), ['my-model']);
	assert.strictEqual(findAll(tree, (one) => one.type === 'input' && one.props.placeholder === t('priceNewModel')).length, 1,
		'自定义模型输入框保留');

	/* 删除：官方模型从价格库移除后，目录里那一行消失 */
	const zhipuNode = vendorByKey('zhipu');
	const glmCard = findAll(zhipuNode, (one) => hasClass(one, 'dsb-model') && one.props.key === 'GLM-5.3')[0];
	buttonsByLabel(glmCard, t('priceRemove'))[0].props.onClick();
	assert.strictEqual(savedModels(inst)['GLM-5.3'], undefined, '删除后价格库里不再有该官方模型');
	tree = render();
	assert.deepStrictEqual(findAll(vendorByKey('zhipu'), (one) => hasClass(one, 'dsb-model')).map((one) => one.props.key),
		['GLM-5.3-Flash', 'GLM-5.3-FlashX'], '被删除的官方模型不再显示');

	/* 恢复默认：删掉的官方模型按官网价全部找回；自建条目与 feeMultiplier 保留 */
	buttonsByLabel(tree, t('reset'))[0].props.onClick();
	tree = render();
	assert.deepStrictEqual(plain(savedModels(inst)['GLM-5.3']), {
		tiered: false, currency: 'CNY',
		peak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 }, offPeak: null,
		/* v7：恢复默认写基准价 = 官网原值 + 官网币种 */
		base: { currency: 'CNY', peak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 }, offPeak: { input: 8, cacheRead: 2, cacheWrite: 0, output: 28 } }
	}, '恢复默认把删掉的官方模型按官网价找回');
	assert.ok(savedModels(inst)['my-model'] !== undefined, '恢复默认保留自建条目');
	assert.strictEqual(savedModels(inst)['my-model'].feeMultiplier, 3, '恢复默认保留自建条目的费用倍率');
	assert.deepStrictEqual(findAll(vendorByKey('zhipu'), (one) => hasClass(one, 'dsb-model')).map((one) => one.props.key),
		['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-FlashX'], '恢复默认后目录行回来');
	console.log('      播种 ' + CATALOG_NAMES.length + ' 个官方模型（已有条目不动）；目录只有价格卡；删除后行消失；恢复默认找回');
}

/* ====================================================================
   ③ 第三方平台区块：增删改 / 适用模型 → 倍率落库 / secret 一次性 / 迁移
   ==================================================================== */
console.log('\n===== ③ 第三方平台区块（独立于模型价格气泡） =====');
const SECRET = 'sk-relay-secret-123';
const USER_SECRET = 'user-42';
{
	const channels = [{ channelKey: 'my-relay', tokenConfigured: true, userIdConfigured: false }];
	const postBodies = [];
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') !== -1) {
			if (init !== undefined && init.method === 'POST') {
				postBodies.push(JSON.parse(init.body));
				const body = postBodies[postBodies.length - 1];
				return Promise.resolve({ json: () => Promise.resolve({
					ok: true,
					channels: body.remove === true ? [] : [{
						channelKey: body.channelKey,
						tokenConfigured: body.token !== undefined && body.token !== '',
						userIdConfigured: body.userId !== undefined && body.userId !== ''
					}]
				}) });
			}
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: channels }) });
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
	});
	const api = inst.api;
	const t = translator(api);
	api.setConfig({
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		priceConfigured: true,
		relayPlatforms: {}
	});
	await api.ensureRelayState();

	const props = { t: t, useProjection: () => undefined };
	const render = () => {
		const bucket = inst.hooks();
		return { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	};
	const rerender = (state) => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = (tree) => findAll(tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (tree, name) => findAll(section(tree), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const savedPlatforms = () => JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms;
	/* 适用模型行：每行 = 一个 `dsb-relay-row dsb-modelrow`，内含左右两条 `dsb-relay-line`（左半「适用模型」+下拉；右半「费用倍率」+倍率输入+删除按钮） */
	const modelLabelLines = (row) => findAll(row, (node) => node.type === 'label' && hasClass(node, 'dsb-relay-line')
		&& findAll(node, (one) => hasClass(one, 'dsb-modelrow-select')).length > 0);
	const feeLabelLines = (row) => findAll(row, (node) => node.type === 'label' && hasClass(node, 'dsb-relay-line')
		&& textOf(node).indexOf(t('priceFeeMultiplier')) !== -1
		&& findAll(node, (one) => one.type === 'input' && one.props.type === 'number').length > 0);
	const rowModelTrigger = (row, index) => findAll(modelLabelLines(row)[index], (node) => node.type === 'button' && hasClass(node, 'dsb-select-btn'))[0];
	const rowModelMenu = (row, index) => findAll(modelLabelLines(row)[index], (node) => hasClass(node, 'dsb-select-menu'))[0];
	const rowModelItems = (row, index) => findAll(rowModelMenu(row, index), (node) => node.type === 'button' && hasClass(node, 'dsb-select-item'));
	/* row 允许传节点或「返回当前树节点的函数」：菜单打开后树会重渲染，函数能取到带菜单的新节点 */
	const rowNodeOf = (row) => (typeof row === 'function' ? row() : row);
	const openModelMenu = (state, row, index) => {
		rowModelTrigger(rowNodeOf(row), index).props.onClick({ stopPropagation: () => {} });
		rerender(state);
	};
	const pickModel = (state, row, index, name) => {
		/* 已打开时不要再点一次（会把菜单关闭）；只有关闭状态才点触发按钮 */
		if (rowModelMenu(rowNodeOf(row), index) === undefined) {
			rowModelTrigger(rowNodeOf(row), index).props.onClick({ stopPropagation: () => {} });
			rerender(state);
		}
		const item = rowModelItems(rowNodeOf(row), index).filter((node) => node.props.key === name)[0];
		assert.ok(item !== undefined, '下拉选项应存在：' + name);
		item.props.onClick({ stopPropagation: () => {} });
		rerender(state);
	};
	const rowFeeIn = (row, index) => findAll(feeLabelLines(row)[index], (node) => node.type === 'input' && node.props.type === 'number')[0];
	const addModelRow = (state, row) => {
		buttonsByLabel(row, t('platformAddModel'))[0].props.onClick();
		rerender(state);
	};
	const noticeShown = (state, key) => textOf(section(state.tree)).indexOf(t(key)) !== -1;
	/* 字段级校验提示（红框 + 就地提示）：文案渲染在平台编辑区里，不是顶部那条 notice */
	const textInRow = (row, text) => textOf(row).indexOf(text) !== -1;
	const addPlatform = (state, name) => {
		const input = findAll(section(state.tree), (node) => node.type === 'input' && node.props.placeholder === t('platformNewPh'))[0];
		assert.ok(input !== undefined, '第三方平台区块必须有「平台名称」输入框');
		input.props.onChange({ target: { value: name } });
		rerender(state);
		buttonsByLabel(section(state.tree), t('platformAdd'))[0].props.onClick();
		rerender(state);
	};
	const row = () => platformRow(state.tree, 'my-relay');

	/* 价格气泡里不再有第三方平台字段：只剩「峰谷计价」一个勾选 + 价格框 + 币种下拉 */
	const state = render();
	const flashCard = findAll(state.tree, (node) => hasClass(node, 'dsb-model') && node.props.key === 'deepseek-flash')[0];
	buttonsByLabel(flashCard, t('priceEdit'))[0].props.onClick();
	rerender(state);
	const cardAgain = findAll(state.tree, (node) => hasClass(node, 'dsb-model') && node.props.key === 'deepseek-flash')[0];
	assert.strictEqual(findAll(cardAgain, (node) => hasClass(node, 'dsb-relay-line')).length, 0,
		'模型气泡里不再有第三方平台字段（请求头 / 令牌 / 用户 ID / 地址 / 余额字段 / 倍率）');
	assert.strictEqual(findAll(cardAgain, (node) => node.type === 'label' && hasClass(node, 'dsb-inline-check')).length, 1,
		'模型气泡里只剩「峰谷计价」一个勾选（第三方平台勾选已删除）');
	assert.strictEqual(textOf(cardAgain).indexOf('第三方平台'), -1, '模型气泡里不再出现「第三方平台」字样');
	assert.strictEqual(api.zh.priceRelay, undefined, '旧的气泡勾选文案键 priceRelay 已删除');
	assert.strictEqual(api.zh.priceRelayMagpieNote, undefined, '旧 Magpie 说明键 priceRelayMagpieNote 已删除');

	/* 新平台：空名称必须提示且不落库 */
	addPlatform(state, '');
	assert.ok(noticeShown(state, 'platformNameRequired'), '空平台名要点出提示');
	assert.deepStrictEqual(plain(savedPlatforms()), {}, '校验失败不落库');

	/* 添加平台 → **行内**展开编辑区（不是 absolute 浮层）：五个字段 + 适用模型自由行 */
	addPlatform(state, 'my-relay');
	assert.ok(platformRow(state.tree, 'my-relay') !== undefined, '添加后平台行出现');
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-platform-edit')).length, 1,
		'新平台直接展开编辑区（行内）');
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-edit-pop')).length, 0,
		'平台编辑区不用 absolute 浮层（会被设置页滚容器裁掉 → 用户看不到「添加出来」的东西）');
	['priceTokenHeader', 'priceToken', 'priceUserId', 'priceEndpoint', 'priceBalanceField'].forEach((key) => {
		assert.ok(textOf(row()).indexOf(t(key)) !== -1, '平台编辑区应有：' + key);
	});
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-relay-line')).length, 7,
		'平台编辑区五个字段行（请求头 / 用户 ID / 令牌 / 地址 / 余额字段）+ 新平台默认「适用模型」左右两半行');
	assert.strictEqual(findLabelInput(row(), t('priceToken')).props.value, '', '令牌不回显（本次输入才提交）');
	assert.strictEqual(findLabelInput(row(), t('priceUserId')).props.value, '', '用户 ID 不回显（本次输入才提交）');
	assert.strictEqual(findLabelInput(row(), t('priceUserId')).props.type, 'text', '用户 ID 输入框明文显示');
	assert.strictEqual(findLabelInput(row(), t('priceTokenHeader')).props.value, '', '请求头没填就回填空（不预填 New-Api-User）');
	assert.strictEqual(modelLabelLines(row()).length, 1, '新平台默认就有一行空白模型行（不再显示空提示）');
	assert.strictEqual(findAll(row(), (node) => node.type === 'input' && node.props.type === 'checkbox').length, 0,
		'平台编辑里不再有「适用模型」勾选框');
	assert.strictEqual(textInRow(row(), t('platformModelsEmpty')), false, '不再出现「还没填适用模型」空提示');

	/* 填字段 + 自由输入「适用模型」行（含空行 / 同名宽容去重）→ 保存 */
	findLabelInput(row(), t('priceEndpoint')).props.onChange({ target: { value: 'https://relay.example.com/balance' } });
	rerender(state);
	findLabelInput(row(), t('priceBalanceField')).props.onChange({ target: { value: '¥data.quota / 500000' } });
	rerender(state);
	findLabelInput(row(), t('priceToken')).props.onChange({ target: { value: SECRET } });
	rerender(state);
	findLabelInput(row(), t('priceUserId')).props.onChange({ target: { value: USER_SECRET } });
	rerender(state);
	addModelRow(state, row());
	assert.strictEqual(modelLabelLines(row()).length, 2, '新建平台自带 1 行 + 点「添加模型」再加 1 行');
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-modelrow-head')).length, 0, '不再有整行表头（dsb-modelrow-head 已删除，每行自带标签）');
	assert.ok(textOf(modelLabelLines(row())[0]).indexOf(t('platformModels')) === 0, '模型行自带「适用模型」标签（标签在左、下拉紧随其后）');
	assert.ok(textOf(feeLabelLines(row())[0]).indexOf(t('priceFeeMultiplier')) === 0, '右半行以「费用倍率」标签开头（标签在左、输入框紧随其后）');
	const modelTrigger = rowModelTrigger(row(), 0);
	assert.ok(modelTrigger !== undefined, '每行有自定义下拉按钮');
	assert.strictEqual(textOf(modelTrigger), t('platformModelSelectPh'), '新行显示「请选择模型」占位');
	openModelMenu(state, row, 0);
	const modelItems = rowModelItems(row(), 0);
	const modelItemKeys = modelItems.map((node) => node.props.key);
	assert.strictEqual(modelItemKeys.indexOf('__empty'), -1, '菜单不再有「请选择模型」空值占位项');
	assert.ok(modelItemKeys.indexOf('deepseek-flash') !== -1, '菜单选项来自价格库（按 catalogOrder 的厂商顺序）');
	assert.strictEqual(textOf(modelItems[0]), 'DeepSeek-Flash', '菜单只含价格库模型名（displayModelName 显示）');
	pickModel(state, row, 0, 'deepseek-flash');
	assert.strictEqual(textOf(rowModelTrigger(row(), 0)), 'DeepSeek-Flash', '选中后按钮显示模型名');
	assert.ok(rowFeeIn(row(), 0) !== undefined, '模型行仍有费用倍率输入框');
	assert.strictEqual(rowFeeIn(row(), 0).props.value, '', '倍率留空 = 1（不预填）');
	assert.strictEqual(rowFeeIn(row(), 0).props.placeholder, t('platformFeePh'), '倍率输入框提示文案「如 0.02」');
	/* 平台编辑六个输入：Enter 后 preventDefault + blur，不再残留光标 */
	['priceTokenHeader', 'priceUserId', 'priceToken', 'priceEndpoint', 'priceBalanceField'].forEach((key) => {
		const input = findLabelInput(row(), t(key));
		assert.ok(input !== undefined, '输入框存在：' + key);
		assert.strictEqual(typeof input.props.onKeyDown, 'function', '输入框应有 Enter 失焦处理：' + key);
		let prevented = false; let blurred = false;
		input.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; }, target: { blur: () => { blurred = true; } } });
		assert.strictEqual(prevented, true, 'Enter 必须 preventDefault：' + key);
		assert.strictEqual(blurred, true, 'Enter 必须 blur：' + key);
		let otherPrevented = false; let otherBlurred = false;
		input.props.onKeyDown({ key: 'a', preventDefault: () => { otherPrevented = true; }, target: { blur: () => { otherBlurred = true; } } });
		assert.strictEqual(otherPrevented, false, '非 Enter 不拦截：' + key);
		assert.strictEqual(otherBlurred, false, '非 Enter 不失焦：' + key);
	});
	const feeInput = rowFeeIn(row(), 0);
	assert.strictEqual(typeof feeInput.props.onKeyDown, 'function', '费用倍率输入框应有 Enter 失焦处理');
	let feePrevented = false; let feeBlurred = false;
	feeInput.props.onKeyDown({ key: 'Enter', preventDefault: () => { feePrevented = true; }, target: { blur: () => { feeBlurred = true; } } });
	assert.strictEqual(feePrevented, true, '费用倍率 Enter 必须 preventDefault');
	assert.strictEqual(feeBlurred, true, '费用倍率 Enter 必须 blur');
	rowFeeIn(row(), 0).props.onChange({ target: { value: '2' } });
	rerender(state);
	/* 当前行自己的已选模型正常显示、不灰显 */
	openModelMenu(state, row, 0);
	const ownItem = rowModelItems(row(), 0).filter((node) => node.props.key === 'deepseek-flash')[0];
	assert.ok(hasClass(ownItem, 'dsb-select-item-on'), '当前行已选模型高亮');
	assert.ok(ownItem.props.disabled !== true, '当前行自己的已选模型不禁用');
	rowModelTrigger(row(), 0).props.onClick({ stopPropagation: () => {} });
	rerender(state);
	addModelRow(state, row());
	/* 第 2 行完全空白：保存时忽略 */
	addModelRow(state, row());
	/* 第 3 行：其他行已选中的 deepseek-flash 从下拉列表动态移除（不显示，不是灰显） */
	openModelMenu(state, row, 2);
	const dupItem = rowModelItems(row(), 2).filter((node) => node.props.key === 'deepseek-flash')[0];
	assert.strictEqual(dupItem, undefined, '其他行已选中的模型从第三行下拉列表移除');
	assert.strictEqual(rowModelItems(row(), 2).length, 0, '夹具唯一模型已被其他行占用 ⇒ 该行菜单为空（占位项已删，无项可选）');
	rowModelTrigger(row(), 2).props.onClick({ stopPropagation: () => {} });
	rerender(state);
	rowFeeIn(row(), 2).props.onChange({ target: { value: '0.5' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);

	const platform = plain(savedPlatforms()['my-relay']);
	assert.deepStrictEqual(platform, {
		endpoint: 'https://relay.example.com/balance',
		tokenHeader: 'authorization',
		/* 请求头没填 → **档案里存空**（默认值只在向宿主 POST 时补） */
		userIdHeader: '',
		balancePath: 'data.quota',
		currency: 'CNY',
		balanceDivisor: 500000,
		models: [{ model: 'deepseek-flash', feeMultiplier: 2 }]
	}, '平台档案存非密字段（没填就是空）+ 适用模型 + 倍率；空行忽略、同名宽容去重');
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, 2, '适用模型写进价格条目倍率（宽容同名匹配到条目键）');
	assert.strictEqual(JSON.stringify(Array.from(inst.store.values())).indexOf(SECRET), -1, '令牌不写 localStorage');
	assert.strictEqual(JSON.stringify(Array.from(inst.store.values())).indexOf(USER_SECRET), -1, '用户 ID 不写 localStorage');
	const savePost = postBodies[postBodies.length - 1];
	assert.deepStrictEqual(Object.keys(savePost).sort(),
		['balanceDivisor', 'balancePath', 'channelKey', 'currency', 'endpoint', 'feeMultiplier', 'token',
			'tokenHeader', 'tokenPrefix', 'userId', 'userIdHeader'].sort(),
		'保存时 POST 字段完整');
	assert.strictEqual(savePost.channelKey, 'my-relay', 'channelKey = 平台名');
	assert.strictEqual(savePost.feeMultiplier, 1, 'POST 的 feeMultiplier 固定 1（避免 Host 二次相乘）');
	assert.strictEqual(savePost.tokenHeader, 'authorization', '令牌请求头固定 authorization（界面不暴露）');
	assert.strictEqual(savePost.tokenPrefix, 'Bearer ', '令牌前缀固定 Bearer ');
	assert.strictEqual(savePost.userIdHeader, 'New-Api-User', '请求头没填 → POST 补默认 New-Api-User（档案里仍是空）');
	assert.strictEqual(savePost.token, SECRET, '令牌只在本次 POST 里带上');
	assert.strictEqual(savePost.userId, USER_SECRET, '用户 ID 只在本次 POST 里带上');
	assert.strictEqual(savePost.balancePath, 'data.quota');
	assert.strictEqual(savePost.balanceDivisor, 500000);
	assert.strictEqual(savePost.currency, 'CNY');
	/* 收起后：卡片头部只显示平台名，不显示地址 / 适用模型摘要，界面上不出现密文 */
	rerender(state);
	assert.strictEqual(textOf(row()).indexOf(SECRET), -1, '保存后界面上不出现令牌');
	assert.strictEqual(textOf(row()).indexOf('https://relay.example.com/balance'), -1, '平台行不显示地址摘要');
	assert.strictEqual(textOf(row()).indexOf('DeepSeek-Flash'), -1, '平台行不显示适用模型名摘要');
	assert.strictEqual(textOf(section(state.tree)).indexOf('个模型'), -1, '平台行不显示「N 个模型」计数标签');

	/* 重名：提示且不新增第二个平台 */
	addPlatform(state, 'my-relay');
	assert.ok(noticeShown(state, 'platformNameDuplicate'), '平台重名要点出提示');
	assert.deepStrictEqual(Object.keys(plain(savedPlatforms())), ['my-relay'], '重名不新增平台');

	/* 重新打开：非密字段**原样**回填 —— 没填过的仍是空，不会回填示例值；令牌 / 用户 ID 仍空 */
	buttonsByLabel(row(), t('priceEdit'))[0].props.onClick();
	rerender(state);
	assert.strictEqual(findLabelInput(row(), t('priceEndpoint')).props.value, 'https://relay.example.com/balance', '地址回填');
	assert.strictEqual(findLabelInput(row(), t('priceBalanceField')).props.value, '¥data.quota / 500000', '余额字段反拼回填');
	assert.strictEqual(findLabelInput(row(), t('priceTokenHeader')).props.value, '',
		'请求头没填过 → 打开时仍为空（不再回填 New-Api-User）');
	assert.strictEqual(modelLabelLines(row()).length, 1, '适用模型行按档案回填 1 行');
	assert.strictEqual(textOf(rowModelTrigger(row(), 0)), 'DeepSeek-Flash', '已保存的模型在下拉按钮中回填');
	assert.strictEqual(rowFeeIn(row(), 0).props.value, '2', '已存倍率回填');
	assert.strictEqual(findLabelInput(row(), t('priceToken')).props.value, '', '令牌打开时仍为空');
	assert.strictEqual(findLabelInput(row(), t('priceUserId')).props.value, '', '用户 ID 打开时仍为空');
	assert.strictEqual(findLabelInput(row(), t('priceToken')).props.placeholder, t('platformSecretSaved'),
		'已保存令牌：placeholder 说明「留空保持不变」');

	/* feeConfigured：明确填 1 与留空必须可区分（Host 按它决定 relay 是否按倍率计价） */
	rowFeeIn(row(), 0).props.onChange({ target: { value: '1' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const explicitOne = plain(savedModels(inst)['deepseek-flash']);
	assert.strictEqual(explicitOne.feeMultiplier, 1, '明确填 1 → 条目保留 feeMultiplier=1');
	assert.strictEqual(explicitOne.feeConfigured, true, '明确填 1 → 条目带 feeConfigured=true');
	buttonsByLabel(row(), t('priceEdit'))[0].props.onClick();
	rerender(state);
	rowFeeIn(row(), 0).props.onChange({ target: { value: '' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const blankFee = plain(savedModels(inst)['deepseek-flash']);
	assert.strictEqual(blankFee.feeMultiplier, undefined, '留空 → feeMultiplier 清掉');
	assert.strictEqual(blankFee.feeConfigured, undefined, '留空 → feeConfigured 清掉');
	buttonsByLabel(row(), t('priceEdit'))[0].props.onClick();
	rerender(state);

	/* 删掉适用模型行 → 保存：价格条目上的倍率被清掉（平台档案里也不再列该模型） */
	buttonsByLabel(feeLabelLines(row())[0], t('priceRemove'))[0].props.onClick();
	rerender(state);
	assert.strictEqual(modelLabelLines(row()).length, 0, '行尾删除 → 该行消失');
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '移除适用模型 → 条目倍率清掉');
	assert.deepStrictEqual(plain(savedPlatforms()['my-relay'].models), [], '平台档案里不再列该模型');

	/* 校验：**字段级**提示（红框 + 就地文案）+ 不落库 —— 用户实测「点保存没反应」指的就是这里 */
	buttonsByLabel(row(), t('priceEdit'))[0].props.onClick();
	rerender(state);
	addModelRow(state, row());
	pickModel(state, row, 0, 'deepseek-flash');
	rerender(state);
	rowFeeIn(row(), 0).props.onChange({ target: { value: '0' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.ok(textInRow(row(), '1. ' + t('priceFeeMultiplierInvalid')), '倍率非法 → 就地提示「1. 哪条规则」');
	assert.strictEqual(rowFeeIn(row(), 0).props.className, 'dsb-invalid', '非法倍率的输入框标红');
	assert.strictEqual(textOf(rowModelTrigger(row(), 0)), 'DeepSeek-Flash', '校验失败不丢用户输入（行还在）');
	assert.deepStrictEqual(plain(savedPlatforms()['my-relay'].models), [], '倍率非法不落库');
	rowFeeIn(row(), 0).props.onChange({ target: { value: '' } });
	rerender(state);
	findLabelInput(row(), t('priceEndpoint')).props.onChange({ target: { value: 'not-a-url' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.ok(textInRow(row(), t('priceEndpointInvalid')), '地址非法 → 就地提示');
	assert.strictEqual(findLabelInput(row(), t('priceEndpoint')).props.className, 'dsb-invalid', '非法地址输入框标红');
	findLabelInput(row(), t('priceEndpoint')).props.onChange({ target: { value: 'https://relay.example.com/balance' } });
	rerender(state);
	findLabelInput(row(), t('priceBalanceField')).props.onChange({ target: { value: '¥' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.ok(textInRow(row(), t('priceBalanceFieldInvalid')), '余额字段非法 → 就地提示');
	assert.strictEqual(findLabelInput(row(), t('priceBalanceField')).props.className, 'dsb-invalid', '非法余额字段输入框标红');
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '非法输入不写价格条目');

	/* 改回合法值保存：倍率 1 不写字段（按旧格式存） */
	findLabelInput(row(), t('priceBalanceField')).props.onChange({ target: { value: '¥data.quota / 500000' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '倍率 1 不写 feeMultiplier 字段');
	assert.deepStrictEqual(plain(savedPlatforms()['my-relay'].models), [{ model: 'deepseek-flash', feeMultiplier: 1 }],
		'平台档案记录该模型（倍率 1）');

	/* 删除平台 → 档案消失、条目倍率清掉、宿主侧 remove */
	const beforeRemove = postBodies.length;
	buttonsByLabel(row(), t('priceRemove'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.deepStrictEqual(plain(savedPlatforms()), {}, '删除平台后档案消失');
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '删除平台后条目倍率清掉');
	assert.deepStrictEqual(plain(postBodies[postBodies.length - 1]), { remove: true, channelKey: 'my-relay' },
		'删除平台 → POST remove');
	assert.strictEqual(postBodies.length, beforeRemove + 1, '只发一条 remove');

	/* 只按倍率计费（地址留空）：不查余额、不发余额配置请求，但倍率仍写进条目；
	   档案里没填的请求头 / 余额字段保持空（默认值只在向宿主 POST 时补） */
	const beforeLite = postBodies.length;
	addPlatform(state, 'magpie-like');
	const maggieRow = () => platformRow(state.tree, 'magpie-like');
	addModelRow(state, maggieRow());
	pickModel(state, maggieRow, 0, 'deepseek-flash');
	rerender(state);
	rowFeeIn(maggieRow(), 0).props.onChange({ target: { value: '0.02' } });
	rerender(state);
	buttonsByLabel(maggieRow(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.deepStrictEqual(plain(savedPlatforms()['magpie-like']), {
		endpoint: '',
		tokenHeader: 'authorization',
		userIdHeader: '',
		balancePath: '',
		currency: '',
		balanceDivisor: null,
		models: [{ model: 'deepseek-flash', feeMultiplier: 0.02 }]
	}, '地址为空 = 只按倍率计费；没填的余额字段与请求头**存空**，不塞默认值');
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, 0.02, '折扣倍率 0.02 落库');
	assert.strictEqual(postBodies.length, beforeLite, '地址留空不发余额配置请求');
	const maggieHead = findAll(maggieRow(), (node) => hasClass(node, 'dsb-model-head'))[0];
	assert.ok(textOf(maggieHead).indexOf('magpie-like') !== -1, '平台头部只显示平台名');
	assert.strictEqual(textOf(maggieHead).indexOf('DeepSeek-Flash'), -1, '平台头部不显示适用模型名摘要');
	assert.strictEqual(textOf(maggieHead).indexOf('只按倍率计费'), -1, '平台头部不再显示「只按倍率计费」');
	assert.strictEqual(textOf(maggieHead).indexOf('未填适用模型'), -1, '平台头部不再显示「未填适用模型」');

	/* 删模型：平台档案保留，但该模型从「适用模型」里摘掉（不会连带丢掉无关平台） */
	const priceFlashCard = findAll(state.tree, (node) => hasClass(node, 'dsb-model') && node.props.key === 'deepseek-flash')[0];
	assert.ok(priceFlashCard !== undefined, '前置：deepseek-flash 价格卡在');
	buttonsByLabel(priceFlashCard, t('priceRemove'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(savedModels(inst)['deepseek-flash'], undefined, '删除模型后价格库不再有该条目');
	assert.deepStrictEqual(plain(savedPlatforms()['magpie-like'].models), [], '删除模型时从平台「适用模型」里摘掉');
	assert.ok(savedPlatforms()['magpie-like'] !== undefined, '删除模型只摘模型，平台档案保留');

	/* 地址清空：已配过余额查询的平台 → POST remove，档案保留为「只按倍率计费」 */
	addPlatform(state, 'clear-me');
	const clearRow = () => platformRow(state.tree, 'clear-me');
	findLabelInput(clearRow(), t('priceEndpoint')).props.onChange({ target: { value: 'https://relay.example.com/balance' } });
	rerender(state);
	buttonsByLabel(clearRow(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(postBodies[postBodies.length - 1].channelKey, 'clear-me', '地址非空 → 保存余额查询配置');
	/* 地址非空但余额字段留空：**档案存空、POST 补默认**（¥data.quota / 500000，用户确认的口径） */
	const clearPost = postBodies[postBodies.length - 1];
	assert.strictEqual(clearPost.balancePath, 'data.quota', '余额字段留空 → POST 默认 balancePath=data.quota');
	assert.strictEqual(clearPost.currency, 'CNY', '余额字段留空 → POST 默认 currency=CNY');
	assert.strictEqual(clearPost.balanceDivisor, 500000, '余额字段留空 → POST 默认 balanceDivisor=500000');
	assert.strictEqual(clearPost.userIdHeader, 'New-Api-User', '请求头留空 → POST 默认 New-Api-User');
	assert.deepStrictEqual([savedPlatforms()['clear-me'].userIdHeader, savedPlatforms()['clear-me'].balancePath,
		savedPlatforms()['clear-me'].currency, savedPlatforms()['clear-me'].balanceDivisor], ['', '', '', null],
		'档案里这四项仍是空（默认值只在 POST 时补，不写回档案）');
	buttonsByLabel(clearRow(), t('priceEdit'))[0].props.onClick();
	rerender(state);
	assert.strictEqual(findLabelInput(clearRow(), t('priceBalanceField')).props.value, '', '再次打开：余额字段仍为空');
	assert.strictEqual(findLabelInput(clearRow(), t('priceTokenHeader')).props.value, '', '再次打开：请求头仍为空');
	findLabelInput(clearRow(), t('priceEndpoint')).props.onChange({ target: { value: '' } });
	rerender(state);
	const beforeClear = postBodies.length;
	buttonsByLabel(clearRow(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.deepStrictEqual(plain(postBodies[postBodies.length - 1]), { remove: true, channelKey: 'clear-me' },
		'地址清空 → POST remove');
	assert.strictEqual(postBodies.length, beforeClear + 1, '地址清空只发一条 remove');
	assert.strictEqual(savedPlatforms()['clear-me'].endpoint, '', '地址清空后平台保留，变成只按倍率计费');

	/* 迁移：旧价格条目上的 relay → 平台档案（平台名默认 = 模型名），条目上不再保留 relay */
	const LEGACY_CONFIG = JSON.stringify({
		version: 6,
		priceVersion: 7,
		currency: 'CNY',
		models: {
			'deepseek-flash': {
				tiered: true, currency: 'CNY', feeMultiplier: 2,
				peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
				offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
				relay: {
					endpoint: 'https://legacy.example.com/balance',
					tokenHeader: 'authorization',
					userIdHeader: 'x-user-id',
					balancePath: '$.balance',
					currency: 'CNY',
					balanceDivisor: 1
				}
			}
		},
		modelOrder: ['deepseek-flash']
	});
	const CONFIG_KEY = api.STORAGE_KEY;
	const migrated = loadClient(undefined, [[CONFIG_KEY, LEGACY_CONFIG]]);
	const migratedSnap = migrated.api.snapshot();
	assert.strictEqual(migratedSnap.models['deepseek-flash'].relay, undefined, '迁移后条目上不再保留 relay');
	assert.strictEqual(migratedSnap.models['deepseek-flash'].feeMultiplier, 2, '迁移不改条目倍率');
	assert.deepStrictEqual(plain(migratedSnap.relayPlatforms), {
		'deepseek-flash': {
			endpoint: 'https://legacy.example.com/balance',
			tokenHeader: 'authorization',
			userIdHeader: 'x-user-id',
			balancePath: '$.balance',
			currency: 'CNY',
			balanceDivisor: 1,
			models: [{ model: 'deepseek-flash', feeMultiplier: 2 }]
		}
	}, '旧 relay 迁移成平台档案（平台名 = 模型名）');
	const reloaded = loadClient(undefined, [[CONFIG_KEY, migrated.store.get(CONFIG_KEY)]]);
	assert.deepStrictEqual(plain(reloaded.api.snapshot().relayPlatforms), plain(migratedSnap.relayPlatforms),
		'二次加载平台档案保持不变（迁移幂等）');

	/* 旧档案兼容：平台里已有但价格库没有的旧模型名，也必须出现在该行下拉选项里 */
	const LEGACY_PLATFORM_CONFIG = JSON.stringify({
		version: 6, priceVersion: 7, currency: 'CNY',
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		relayPlatforms: {
			'legacy-p': {
				endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '',
				currency: '', balanceDivisor: null, models: [
					{ model: 'old-model', feeMultiplier: 1.5 },
					{ model: 'Mimo-V2.6-Pro-Ultraspeed', feeMultiplier: 1 },
					{ model: 'Mimo-V2.6-Pro-Ultraspeed-Plus', feeMultiplier: 1 }
				]
			}
		}
	});
	const legacyInst = loadClient(undefined, [[api.STORAGE_KEY, LEGACY_PLATFORM_CONFIG]]);
	const legacyApi = legacyInst.api;
	const legacyT = translator(legacyApi);
	const legacyState = { bucket: legacyInst.hooks(), tree: null };
	const legacyRender = () => {
		legacyState.tree = withHooks(legacyState.bucket, () => legacyApi.SettingsSection({ t: legacyT, useProjection: () => undefined }));
		return legacyState.tree;
	};
	legacyRender();
	const legacyRow = () => findAll(legacyState.tree, (node) => hasClass(node, 'dsb-model') && node.props.key === 'legacy-p')[0];
	buttonsByLabel(legacyRow(), legacyT('priceEdit'))[0].props.onClick();
	legacyRender();
	const legacyTrigger = findAll(legacyRow(), (node) => node.type === 'button' && hasClass(node, 'dsb-select-btn'))[0];
	legacyTrigger.props.onClick({ stopPropagation: () => {} });
	legacyRender();
	const legacyMenu = findAll(legacyRow(), (node) => hasClass(node, 'dsb-select-menu'))[0];
	const legacyOptions = findAll(legacyMenu, (node) => node.type === 'button' && hasClass(node, 'dsb-select-item')).map((node) => node.props.key);
	assert.ok(legacyOptions.indexOf('old-model') !== -1, '旧档案模型不在价格库时，下拉仍并入该选项');
	const legacyTriggers = findAll(legacyRow(), (node) => node.type === 'button' && hasClass(node, 'dsb-select-btn'));
	assert.strictEqual(legacyTriggers.length, 3, '旧档案三行模型都渲染');
	assert.strictEqual(textOf(legacyTriggers[1]), 'Mimo-V2.6-Pro-Ultraspeed', '24 字符长模型名完整显示');
	assert.strictEqual(textOf(legacyTriggers[2]), 'Mimo-V2.6-Pro-Ultraspeed-Plus', '超长模型名完整显示');
	/* 按容器宽度实测：scrollWidth 随当前字号等比缩放，模拟真实文本排版 */
	const measureBtn = (baseWidth, clientWidth) => {
		const el = { style: {}, clientWidth: clientWidth };
		Object.defineProperty(el, 'scrollWidth', { get() { const size = parseFloat(el.style.fontSize || '13'); return Math.round(baseWidth * size / 13); } });
		return el;
	};
	const shortBtn = measureBtn(120, 240);
	legacyTriggers[0].props.ref(shortBtn);
	assert.strictEqual(shortBtn.style.fontSize, '13px', '短名不缩小，默认 13px');
	const midBtn = measureBtn(210, 200);
	legacyTriggers[1].props.ref(midBtn);
	assert.strictEqual(midBtn.style.fontSize, '12px', '长名按容器宽度自适应缩小（12px 能放下）');
	const longBtn = measureBtn(400, 180);
	legacyTriggers[2].props.ref(longBtn);
	assert.strictEqual(longBtn.style.fontSize, '10px', '超长名最多缩到 10px 下限');
	const resetBtn = measureBtn(120, 240);
	resetBtn.style.fontSize = '10px';
	legacyTriggers[0].props.ref(resetBtn);
	assert.strictEqual(resetBtn.style.fontSize, '13px', '每次重渲染重置 13px 再量');
	assert.strictEqual(typeof legacyTriggers[0].props.ref, 'function', '模型按钮挂载 ref 自适应回调');
	console.log('      气泡无第三方字段；平台增删改；模型下拉→倍率落库；secret 一次性；地址留空=只按倍率；旧 relay 迁移成平台；旧档案模型可选');
}

/* ====================================================================
   ③-1 空平台：添加即落库；无地址无模型时不显示摘要
   ==================================================================== */
console.log('\\n===== ③-1 空平台添加即落库；空摘要不显示 =====');
{
	const inst = loadClient();
	const api = inst.api;
	const t = translator(api);
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: {} });
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const input = findAll(section(), (node) => node.type === 'input' && node.props.placeholder === t('platformNewPh'))[0];
	input.props.onChange({ target: { value: 'empty-one' } });
	rerender();
	buttonsByLabel(section(), t('platformAdd'))[0].props.onClick();
	rerender();
	const saved = () => JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms;
	assert.deepStrictEqual(plain(saved()['empty-one']), {
		endpoint: '', tokenHeader: 'authorization', userIdHeader: '',
		balancePath: '', currency: '', balanceDivisor: null, models: []
	}, '空平台在点「添加平台」时就写入 config（不依赖保存）');
	const row = () => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === 'empty-one')[0];
	const head = () => findAll(row(), (node) => hasClass(node, 'dsb-model-head'))[0];
	assert.strictEqual(findAll(head(), (node) => hasClass(node, 'dsb-hint')).length, 0, '平台头部不显示任何摘要');
	assert.deepStrictEqual(findAll(head(), (node) => hasClass(node, 'dsb-model-name')).map(textOf), ['empty-one'], '平台头部只显示平台名');
	/* 点别处（打开价格编辑会把平台编辑收起）→ 平台仍在列表里 */
	const flashCard = findAll(state.tree, (node) => hasClass(node, 'dsb-model') && node.props.key === 'deepseek-flash')[0];
	buttonsByLabel(flashCard, t('priceEdit'))[0].props.onClick();
	rerender();
	assert.strictEqual(findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === 'empty-one').length, 1,
		'点别处关闭编辑后空平台仍保留');
	assert.deepStrictEqual(plain(saved()['empty-one']).models, [], '空平台档案仍在 config 里');
	console.log('      空平台添加即落库；空摘要不显示；点别处后仍保留');
}

/* ====================================================================
   ③-2 平台名输入容错 + 文档点击不再取消编辑行（用户实测「添加不出来」）
   ==================================================================== */
console.log('\n===== ③-2 平台名 123/英文/符号都能添加；点别处不取消编辑行 =====');
{
	const inst = loadClient();
	const api = inst.api;
	const t = translator(api);
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: {} });
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const typeName = (value) => {
		const input = findAll(section(), (node) => node.type === 'input' && node.props.placeholder === t('platformNewPh'))[0];
		input.props.onChange({ target: { value: value } });
		rerender();
	};
	const clickAdd = () => { buttonsByLabel(section(), t('platformAdd'))[0].props.onClick(); rerender(); };
	const addAndCheck = (name) => {
		typeName(name);
		clickAdd();
		const row = platformRow(name);
		assert.ok(row !== undefined, '合法平台名「' + name + '」必须能添加出行');
		assert.strictEqual(findAll(row, (node) => hasClass(node, 'dsb-platform-edit')).length, 1,
			'「' + name + '」添加后立刻出现可编辑行');
		return row;
	};
	/* 用户实测的场景：纯数字 / 随便的英文 / 带空格和符号 */
	['123', 'abcXYZ', 'My Relay 2.0', 'a_b-c'].forEach((name) => addAndCheck(name));
	/* 纯空白仍要拒绝（名字只 trim + 去重，不做别的限制） */
	typeName('   ');
	clickAdd();
	assert.strictEqual(platformRow('   '), undefined, '纯空白名字不加行');
	assert.ok(textOf(section()).indexOf(t('platformNameRequired')) !== -1, '纯空白 → 提示名称不能为空');
	/* 空平台直接保存：档案字段全空（不写示例值），再打开编辑仍是空 */
	addAndCheck('blank-one');
	buttonsByLabel(platformRow('blank-one'), t('priceSave'))[0].props.onClick();
	rerender();
	const savedBlank = JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms['blank-one'];
	assert.deepStrictEqual(savedBlank, {
		endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: []
	}, '空平台保存后档案字段全空（不存默认/示例值）');
	buttonsByLabel(platformRow('blank-one'), t('priceEdit'))[0].props.onClick();
	rerender();
	assert.strictEqual(findLabelInput(platformRow('blank-one'), t('priceTokenHeader')).props.value, '', '再打开：请求头不回填默认值');
	assert.strictEqual(findLabelInput(platformRow('blank-one'), t('priceBalanceField')).props.value, '', '再打开：余额字段不回填默认值');
	/* 关键回归：编辑行开着时点别处不得把它取消掉（平台已落库，点「修改」打开既有平台） */
	buttonsByLabel(platformRow('123'), t('priceEdit'))[0].props.onClick();
	rerender();
	assert.strictEqual(findAll(platformRow('123'), (node) => hasClass(node, 'dsb-platform-edit')).length, 1, '前置：123 的编辑行开着');
	assert.strictEqual(inst.docClickCount(), 0, '平台编辑打开时不挂「点别处收起」的文档监听（价格气泡专属）');
	inst.outsideClick();
	rerender();
	const afterClick = platformRow('123');
	assert.ok(afterClick !== undefined, '点别处后平台行还在');
	assert.strictEqual(findAll(afterClick, (node) => hasClass(node, 'dsb-platform-edit')).length, 1,
		'点别处不会把刚打开、还没落库的平台编辑区取消掉（「添加不出来」的根因）');
	console.log('      123 / abcXYZ / My Relay 2.0 / a_b-c 都能添加并出现编辑行；空平台存空；点别处不取消');
}

/* ====================================================================
   ④ 开发模式 0 次真实 fetch（中转站 GET 也要遵守）
   ==================================================================== */
console.log('\n===== ④ 开发模式 0 次真实 fetch =====');
{
	const inst = loadClient((url) => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) }));
	inst.api.setDevMode(true);
	inst.fetchLog.length = 0;
	const t = translator(inst.api);
	const bucket = inst.hooks();
	withHooks(bucket, () => inst.api.SettingsSection({ t: t, useProjection: () => undefined }));
	assert.deepStrictEqual(inst.fetchLog, [], '开发模式渲染设置页不得发任何真实请求');
	console.log('      设置页渲染：真实 fetch = 0');
}

/* ====================================================================
   ⑤ 费用倍率在「本轮」「总计」生效 + 默认 1 + 队友不乘 + 改倍率重算
   ==================================================================== */
console.log('\n===== ⑤ 倍率在「本轮」「总计」生效 / 默认 1 / 队友不乘 / 改倍率重算 =====');
{
	const inst = loadClient();
	const api = inst.api;
	const t = translator(api);
	const withMultiplier = (multiplier) => {
		const entry = plain(CNY_BASE['deepseek-flash']);
		if (multiplier !== 1) entry.feeMultiplier = multiplier;
		return { 'deepseek-flash': entry };
	};

	api.setConfig({ models: withMultiplier(1) });
	let src = totalSrc(api, [callOf('deepseek-flash', 250000)]);
	assert.strictEqual(totalText(api, src, t), '总计 ¥1.00', '没有倍率时总计按 1 计');

	api.setConfig({ models: withMultiplier(2) });
	src = totalSrc(api, [callOf('deepseek-flash', 250000)]);
	assert.strictEqual(totalText(api, src, t), '总计 ¥2.00', '总计按模型条目倍率 2 计');
	const turnSrc = totalSrc(api, [], {
		sessionUsage: { models: api.snapshot().models, calls: [], current: { calls: [callOf('deepseek-flash', 250000)] }, overflow: {} },
		lastCostHold: { sessionId: null, turnKey: null, value: 0 }, lastCostTurn: 'turn-1', running: false
	});
	assert.strictEqual(lastCostText(api, turnSrc, t), '本轮 ¥2.00', '本轮按模型条目倍率 2 计');

	const withSub = totalSrc(api, [callOf('deepseek-flash', 250000)], {
		subagent: { session: { ok: true, total: { cost: 1, costByCurrency: { CNY: 1 }, tokens: null } } }
	});
	assert.strictEqual(totalText(api, withSub, t), '总计 ¥3.00', '队友金额不再乘倍率');

	/* 欠账补价也乘倍率 */
	api.setConfig({ models: {} });
	const debtHold = holdOf();
	const debtSrc = totalSrc(api, [callOf('deepseek-flash', 250000)], { totalHold: debtHold });
	assert.strictEqual(totalText(api, debtSrc, t), '总计 ¥-', '无价时总计给横杠');
	api.setConfig({ models: withMultiplier(2) });
	assert.strictEqual(totalText(api, debtSrc, t), '总计 ¥2.00', '欠账补价按条目倍率 2 结算');

	/* 改倍率触发总计整份重算：先按 1 结算 → 改 2 → 翻倍且不重复计 */
	api.setConfig({ models: withMultiplier(1) });
	const reHold = holdOf();
	const reCalls = [callOf('deepseek-flash', 250000)];
	const reTick = () => totalText(api, totalSrc(api, reCalls, { totalHold: reHold }), t);
	assert.strictEqual(reTick(), '总计 ¥1.00', '前置：倍率 1 时结算 ¥1.00');
	api.setConfig({ models: withMultiplier(2) });
	assert.strictEqual(reTick(), '总计 ¥2.00', '改倍率后必须重算');
	assert.strictEqual(reTick(), '总计 ¥2.00', '重算后再渲染不得重复计费');
	console.log('      本轮/总计/欠账都乘条目倍率；默认 1；队友不乘；改倍率重算 ¥1.00→¥2.00 且不重复');

	/* 折扣倍率 0.02（用户常见场景）：<1 合法，计价同样相乘 */
	api.setConfig({ models: withMultiplier(0.02) });
	src = totalSrc(api, [callOf('deepseek-flash', 250000)]);
	assert.strictEqual(totalText(api, src, t), '总计 ¥0.02', '倍率 0.02 按折扣价计（¥1.00 × 0.02）');
}

/* ====================================================================
   ⑥ 价格库上报自动带 feeMultiplier 与 relay 非密字段
   ==================================================================== */
console.log('\n===== ⑥ 价格库上报带 feeMultiplier =====');
{
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/prices') !== -1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
	});
	const api = inst.api;
	const t = translator(api);
	const entry = plain(CNY_BASE['deepseek-flash']);
	entry.feeMultiplier = 2;
	/* v7：条目带内部基准价，但上报给 Host 的 models 里必须剥掉它（Host 只认价格字段） */
	entry.base = { currency: entry.currency, peak: entry.peak, offPeak: entry.offPeak };
	api.setConfig({ models: { 'deepseek-flash': entry } });
	const bucket = inst.hooks();
	withHooks(bucket, () => api.StatusBar({
		t: t, sessionId: 's1',
		useProjection: () => undefined,
		useSession: () => undefined,
		useSessions: () => undefined,
		useChat: () => undefined
	}));
	const pricePosts = inst.fetchLog.filter((one) => one.url.indexOf('/api/prices') !== -1 && one.init !== undefined && one.init.method === 'POST');
	assert.strictEqual(pricePosts.length, 1, '底栏应把价格库上报一次');
	const body = JSON.parse(pricePosts[0].init.body);
	assert.strictEqual(body.models['deepseek-flash'].feeMultiplier, 2, '价格库上报要带上模型条目的 feeMultiplier');
	assert.strictEqual(body.models['deepseek-flash'].base, undefined, '上报 Host 的 models 里不带内部字段 base');
	assert.deepStrictEqual(body.models['deepseek-flash'].peak, plain(CNY_BASE['deepseek-flash'].peak),
		'剥掉 base 不影响价格数值');
	console.log('      POST /api/prices 的 models 里带 feeMultiplier=2');
}


	/* ====================================================================
   ⑦ 余额请求带 relay 参数：会话模型 → 归属平台（宽容匹配）
   ==================================================================== */
console.log('\n===== ⑦ 余额请求追加 &relay=平台名 =====');
{
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/balance') !== -1) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, total: '1.00', currency: 'CNY', at: OFF_PEAK }) });
		}
		if (init !== undefined && init.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
		return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
	});
	const api = inst.api;
	const t = translator(api);
	const PLATFORM = '我的平台';
	const platform = {
		endpoint: 'https://relay.example.com/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		balancePath: 'data.quota',
		currency: 'CNY',
		balanceDivisor: 500000,
		models: [{ model: 'deepseek-flash', feeMultiplier: 1 }]
	};
	api.setConfig({
		models: { 'deepseek-flash': plain(CNY_BASE['deepseek-flash']) },
		modelOrder: ['deepseek-flash'],
		relayPlatforms: { [PLATFORM]: platform }
	});
	const balanceUrls = () => inst.fetchLog.filter((one) => one.url.indexOf('/api/balance') !== -1).map((one) => one.url);
	const seen = [];
	const renderBar = (model) => withHooks(inst.hooks(), () => api.StatusBar({
		t: t, sessionId: 'relay-session',
		useProjection: (name) => { seen.push(name); return name === 'desktopStatusbarModel' ? { provider: 'deepseek-official', model: model } : undefined; seen.push('CODES:' + Array.from(name).map(function (c) { return c.charCodeAt(0); }).join(',')); return out; },
		useSession: () => undefined,
		useSessions: () => undefined,
		useChat: () => undefined
	}));
	/* 宽容匹配：会话模型名 DeepSeek_Flash → 价格键 deepseek-flash → 归属「我的平台」 */
	renderBar('DeepSeek_Flash');
	await settle();
	const urls = balanceUrls();
	assert.ok(urls.length >= 1, '底栏应查询余额，实际请求：' + JSON.stringify(inst.fetchLog.map((one) => one.url)));
	assert.ok(urls[0].indexOf('relay=' + encodeURIComponent(PLATFORM)) !== -1, '余额请求带 &relay=平台名：' + urls[0]);
	assert.ok(urls[0].indexOf('model=DeepSeek_Flash') !== -1, '原有 provider / model 参数不变：' + urls[0]);
	/* 取不到归属：没有平台档案时不加 relay */
	api.setConfig({ relayPlatforms: {} });
	inst.fetchLog.length = 0;
	renderBar('deepseek-flash');
	await settle();
	const plainUrls = balanceUrls();
	assert.ok(plainUrls.length >= 1, '无平台档案时仍然查询余额');
	assert.strictEqual(plainUrls[0].indexOf('relay='), -1, '取不到归属就不带 relay：' + plainUrls[0]);
	console.log('      归属平台 → &relay=' + PLATFORM + '；无归属 → 不带 relay');
}

console.log('\n全部通过');
}

main().finally(() => {
	try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch (error) { /* best effort */ }
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
