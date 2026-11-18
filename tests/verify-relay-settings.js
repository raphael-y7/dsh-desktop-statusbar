/**
 * 价格设置 UI + 「第三方平台」独立区块回归测试（task-39 最终口径）。
 *
 * 覆盖：
 *   ① i18n 中英键对齐、setInterval 恰好 2 处、代码/文案不出现「通道」概念；
 *   ② 官方模型默认全部加入价格表（v4 播种 / v6+v8 补播新增，已有条目一律不动）；目录只有价格卡，
 *      删除后行消失、「恢复默认」找回（数据来自 docs/official-models.json）；
 *   ③ 模型价格气泡里**不再有**第三方平台字段（勾选 / 请求头 / 令牌 / 用户 ID / 地址 / 余额字段 / 倍率），
 *      改为价格卡下方独立的「第三方平台」区块：平台增删改、适用模型**自由输入行** → 按模型倍率写进价格条目、
 *      secret 一次性（不回显 / 不落 localStorage）、地址留空仍保存（endpoint 保持空，首次查询再自动探测）、档案里没填的字段存空
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
const assert = require('assert');
const os = require('os');
const hostLib = require('./_host-lib');
const { findAll, hasClass, textOf, makeFakeDocument, runPlugin } = require('./helpers/client-harness');

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

function loadClient(fetchImpl, initialStore, options) {
	/* initialStore：模拟"用户机器上已有的 localStorage"（[key, value] 数组），用来测迁移播种 */
	/* options.dom：传入 { platformNode } 时启用滚动模拟（给 getComputedStyle，并把平台编辑区
	   节点挂到 platformEditRef 上），供 task-14 的「打开编辑区不滚动」回归测试使用。 */
	const domOpt = options === undefined || options === null || options.dom === undefined ? null : options.dom;
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
		getComputedStyle: domOpt === null ? undefined : (node) => ({ overflowY: node !== null && node !== undefined && typeof node.__overflowY === 'string' ? node.__overflowY : '' }),
		fetch: (url, init) => {
			fetchLog.push({ url: String(url), init: init });
			return fetchImpl === undefined
				? Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) })
				: fetchImpl(String(url), init);
		}
	};


	const reactStub = {
		createElement: (type, props, ...children) => {
			const node = {
				type: type,
				props: props === null || props === undefined ? {} : props,
				children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
			};
			/* domOpt：模拟 React 把平台编辑区 DOM 节点挂到 ref 上（滚动回归测试用） */
			if (domOpt !== null && node.props.ref !== null && node.props.ref !== undefined && typeof node.props.ref === 'object'
				&& typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsb-platform-pop') !== -1) {
				node.props.ref.current = domOpt.platformNode;
			}
			return node;
		},
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

	const { document: fakeDocument, docClicks } = makeFakeDocument();
	const api = runPlugin(injected, reactStub, fakeWindow, fakeDocument);
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

const buttonsByLabel = (tree, label) => findAll(tree, (node) => node.type === 'button'
	&& hasClass(node, 'dsb-action') && textOf(node) === label);
const findLabelInput = (tree, label) => {
	/* 中转站字段行（dsb-relay-line）与费用倍率行（dsb-field）都是「标签 + 输入框」 */
	const row = findAll(tree, (node) => (node.type === 'label' || node.type === 'div')
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
		/* 官方 USD 源表入价格库：显示值折 CNY，base 保留官网 USD 原值 */
		tiered: false, currency: 'CNY',
		peak: { input: 26.97, cacheRead: 1.35, cacheWrite: 33.71, output: 134.85 },
		offPeak: { input: 26.97, cacheRead: 1.35, cacheWrite: 33.71, output: 134.85 },
		base: { currency: 'USD', peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 } },
	}, '未配置过的官方模型按官网价播种（单档，USD 基准价 + CNY 显示价）');
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
		/* 3.0.4 起：USD 显示值折成 CNY（4 × 6.742424 = 26.97 …），原始 USD 值进 base。 */
		tiered: false, currency: 'CNY',
		peak: { input: 26.97, cacheRead: 1.35, cacheWrite: 33.71, output: 134.85 },
		offPeak: { input: 26.97, cacheRead: 1.35, cacheWrite: 33.71, output: 134.85 },
		base: { currency: 'USD', peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }, offPeak: null }
	}, 'v7 迁移：USD 条目显示值折 CNY、base 保留原始 USD 值');
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
const SECRET = 'sk-test-placeholder-0001';
const USER_SECRET = 'user-42';
{
	/* 模拟 Host relayConfigView：非密字段会带运行时默认值（New-Api-User / data.quota / 500000），
	   这些默认值不是用户填过的值，编辑区不得据此回填。 */
	const channels = [{
		channelKey: 'my-relay',
		endpoint: '',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: 'data.quota',
		currency: 'CNY',
		feeMultiplier: 1,
		balanceDivisor: 500000,
		tokenConfigured: true,
		userIdConfigured: false
	}];
	const postBodies = [];
	let relayPostOutcome = 'ok';
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') !== -1) {
			if (init !== undefined && init.method === 'POST') {
				postBodies.push(JSON.parse(init.body));
				if (relayPostOutcome === 'fail') {
					return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'relay-config-failed' }) });
				}
				if (relayPostOutcome === 'throw') return Promise.reject(new Error('relay network down'));
				const body = postBodies[postBodies.length - 1];
				return Promise.resolve({ json: () => Promise.resolve({
					ok: true,
					channels: body.remove === true ? [] : [{
						channelKey: body.channelKey,
						endpoint: body.endpoint,
						tokenHeader: body.tokenHeader,
						userIdHeader: body.userIdHeader,
						tokenPrefix: body.tokenPrefix,
						balancePath: body.balancePath,
						currency: body.currency,
						feeMultiplier: body.feeMultiplier,
						balanceDivisor: body.balanceDivisor,
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
	const modelLabelLines = (row) => findAll(row, (node) => (node.type === 'label' || node.type === 'div') && hasClass(node, 'dsb-relay-line')
		&& findAll(node, (one) => hasClass(one, 'dsb-modelrow-select')).length > 0);
	const feeLabelLines = (row) => findAll(row, (node) => (node.type === 'label' || node.type === 'div') && hasClass(node, 'dsb-relay-line')
		&& textOf(node).indexOf(t('priceFeeMultiplier')) !== -1
		&& findAll(node, (one) => one.type === 'input' && one.props.type === 'number').length > 0);
	/* task-15：模型控件由 button 改为原生 input（可输入筛选），查找器按 input 找 */
	const rowModelTrigger = (row, index) => findAll(modelLabelLines(row)[index], (node) => node.type === 'input' && hasClass(node, 'dsb-select-btn'))[0];
	const rowModelMenu = (row, index) => findAll(modelLabelLines(row)[index], (node) => hasClass(node, 'dsb-select-menu'))[0];
	const rowModelItems = (row, index) => findAll(rowModelMenu(row, index), (node) => node.type === 'button' && hasClass(node, 'dsb-select-item'));
	/* row 允许传节点或「返回当前树节点的函数」：菜单打开后树会重渲染，函数能取到带菜单的新节点 */
	const rowNodeOf = (row) => (typeof row === 'function' ? row() : row);
	/* 3.0.4 起的下拉按 DOM 测量定位：事件要带 closest/getBoundingClientRect 替身。 */
	const menuEvent = (rowNode) => {
		const rect = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 };
		const target = Object.assign(rowNode, { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => rect });
		const anchor = { getBoundingClientRect: () => rect, closest: (sel) => (sel === '.dsb-model' ? target : null) };
		return { stopPropagation: () => {}, currentTarget: { closest: (sel) => (sel === '.dsb-select' ? anchor : null) } };
	};
	const clickModelTrigger = (row, index) => rowModelTrigger(rowNodeOf(row), index).props.onFocus(menuEvent(rowNodeOf(row)));
	const openModelMenu = (state, row, index) => {
		clickModelTrigger(row, index);
		rerender(state);
	};
	const pickModel = (state, row, index, name) => {
		/* 已打开时不要再点一次（会把菜单关闭）；只有关闭状态才点触发按钮 */
		if (rowModelMenu(rowNodeOf(row), index) === undefined) {
			clickModelTrigger(row, index);
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
	const platformHead = (node) => findAll(node, (one) => hasClass(one, 'dsb-platform-head'))[0];
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
	assert.strictEqual(noticeShown(state, 'platformNameRequired'), false, '成功添加后空名提示已清空');
	/* 3.0.4 基线：添加平台只落库，不自动展开；点平台头才进编辑。 */
	platformHead(row()).props.onClick();
	rerender(state);
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-platform-pop')).length, 1,
		'新平台直接展开编辑气泡（3.0.4 基线口径）');
	assert.strictEqual(findAll(row(), (node) => hasClass(node, 'dsb-platform-edit')).length, 0,
		'3.0.4 基线没有行内 dsb-platform-edit 类');
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
	assert.ok(modelTrigger !== undefined, '每行有可输入筛选的模型框（原生 input）');
	assert.strictEqual(modelTrigger.props.type, 'text', '模型框是原生文本输入');
	assert.strictEqual(modelTrigger.props.role, 'combobox', '模型框保留 combobox 语义');
	assert.strictEqual(modelTrigger.props.placeholder, t('platformModelSelectPh'), '新行显示「请选择模型」占位');
	openModelMenu(state, row, 0);
	const modelItems = rowModelItems(row(), 0);
	const modelItemKeys = modelItems.map((node) => node.props.key);
	assert.strictEqual(modelItemKeys.indexOf('__empty'), -1, '菜单不再有「请选择模型」空值占位项');
	assert.ok(modelItemKeys.indexOf('deepseek-flash') !== -1, '菜单选项来自价格库（按 catalogOrder 的厂商顺序）');
	assert.strictEqual(textOf(modelItems[0]), 'DeepSeek-Flash', '菜单只含价格库模型名（displayModelName 显示）');
	pickModel(state, row, 0, 'deepseek-flash');
	assert.strictEqual(rowModelTrigger(row(), 0).props.value, 'DeepSeek-Flash', '选中后输入框显示模型名');
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
	clickModelTrigger(row, 0);
	rerender(state);
	addModelRow(state, row());
	/* 第 2 行完全空白：保存时忽略 */
	addModelRow(state, row());
	/* 第 3 行：其他行已选中的 deepseek-flash 从下拉列表动态移除（不显示，不是灰显） */
	openModelMenu(state, row, 2);
	const dupItem = rowModelItems(row(), 2).filter((node) => node.props.key === 'deepseek-flash')[0];
	assert.strictEqual(dupItem, undefined, '其他行已选中的模型从第三行下拉列表移除');
	assert.strictEqual(rowModelItems(row(), 2).length, 0, '夹具唯一模型已被其他行占用 ⇒ 无候选可选');
	assert.strictEqual(rowModelMenu(row(), 2), undefined, '无候选时完全不渲染 listbox');
	assert.strictEqual(rowModelTrigger(row(), 2).props['aria-expanded'], 'false', '无候选时 aria-expanded=false');
	rowModelTrigger(row(), 2).props.onChange({ target: { value: 'Custom-Model' } });
	rerender(state);
	assert.strictEqual(rowModelTrigger(row(), 2).props.value, 'Custom-Model', '自定义模型输入保留在筛选框');
	assert.strictEqual(rowModelMenu(row(), 2), undefined, '自定义筛选文本不自动加入候选');
	rowModelTrigger(row(), 2).props.onBlur({ currentTarget: { value: 'Custom-Model' } });
	rerender(state);
	assert.strictEqual(rowModelTrigger(row(), 2).props.value, 'Custom-Model', '失焦并重渲染后仍显示自定义模型');
	assert.strictEqual(rowModelMenu(row(), 2), undefined, '失焦后关闭无匹配筛选菜单');
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
		models: [{ model: 'deepseek-flash', feeMultiplier: 2 }, { model: 'Custom-Model', feeMultiplier: 0.5 }]
	}, '平台档案存非密字段（没填就是空）+ 适用模型 + 倍率；空行忽略、同名宽容去重');
	platformHead(row()).props.onClick();
	rerender(state);
	assert.strictEqual(rowModelTrigger(row(), 1).props.value, 'Custom-Model', '保存后重新打开平台编辑区仍回显自定义模型');
	openModelMenu(state, row, 1);
	assert.strictEqual(rowModelMenu(row(), 1), undefined, '重开后未知自定义模型不应进入下拉候选');
	assert.strictEqual(rowModelTrigger(row(), 1).props['aria-expanded'], 'false', '重开后未知自定义模型菜单保持关闭');
	rowModelTrigger(row(), 1).props.onChange({ target: { value: '' } });
	rerender(state);
	const reopenedItems = rowModelItems(row(), 1);
	assert.strictEqual(reopenedItems.length, 0, '清空筛选后当前夹具无可用候选');
	assert.strictEqual(reopenedItems.filter((node) => node.props.key === 'Custom-Model').length, 0, '清空筛选后候选仍不含未知自定义模型');
	rowModelTrigger(row(), 1).props.onKeyDown({ key: 'Escape', preventDefault: () => {} });
	rerender(state);
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
	platformHead(row()).props.onClick();
	rerender(state);
	assert.strictEqual(findLabelInput(row(), t('priceEndpoint')).props.value, 'https://relay.example.com/balance', '地址回填');
	assert.strictEqual(findLabelInput(row(), t('priceBalanceField')).props.value, '¥data.quota / 500000', '余额字段反拼回填');
	assert.strictEqual(findLabelInput(row(), t('priceTokenHeader')).props.value, 'New-Api-User',
		'地址可用（saved.endpoint 非空）→ Host 默认请求头能查到余额，回填 New-Api-User');
	assert.strictEqual(modelLabelLines(row()).length, 2, '适用模型行按档案回填 2 行');
	assert.strictEqual(rowModelTrigger(row(), 0).props.value, 'DeepSeek-Flash', '已保存的模型在输入框中回填');
	assert.strictEqual(rowFeeIn(row(), 0).props.value, '2', '已存倍率回填');
	assert.strictEqual(rowModelTrigger(row(), 1).props.value, 'Custom-Model', '保存的自定义模型在重开后回显');
	assert.strictEqual(rowFeeIn(row(), 1).props.value, '0.5', '自定义模型倍率重开后回显');
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
	platformHead(row()).props.onClick();
	rerender(state);
	rowFeeIn(row(), 0).props.onChange({ target: { value: '' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const blankFee = plain(savedModels(inst)['deepseek-flash']);
	assert.strictEqual(blankFee.feeMultiplier, undefined, '留空 → feeMultiplier 清掉');
	assert.strictEqual(blankFee.feeConfigured, undefined, '留空 → feeConfigured 清掉');
	platformHead(row()).props.onClick();
	rerender(state);

	/* 删掉适用模型行 → 保存：价格条目上的倍率被清掉（平台档案里也不再列该模型） */
	buttonsByLabel(feeLabelLines(row())[0], t('priceRemove'))[0].props.onClick();
	rerender(state);
	assert.strictEqual(modelLabelLines(row()).length, 1, '删除 DeepSeek 后自定义模型行仍在');
	assert.strictEqual(rowModelTrigger(row(), 0).props.value, 'Custom-Model', '删除顺序留下自定义模型');
	buttonsByLabel(feeLabelLines(row())[0], t('priceRemove'))[0].props.onClick();
	rerender(state);
	assert.strictEqual(modelLabelLines(row()).length, 0, '删除两行后模型行全部消失');
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '移除适用模型 → 条目倍率清掉');
	assert.deepStrictEqual(plain(savedPlatforms()['my-relay'].models), [], '平台档案里不再列该模型');

	/* 校验（3.0.4 基线口径）：字段非法只给顶部提示、**不拦截保存**；非法倍率按 1 落库。 */
	platformHead(row()).props.onClick();
	rerender(state);
	addModelRow(state, row());
	pickModel(state, row, 0, 'deepseek-flash');
	rerender(state);
	rowFeeIn(row(), 0).props.onChange({ target: { value: '0' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.ok(noticeShown(state, 'priceFeeMultiplierInvalid'), '倍率非法 → 顶部提示');
	assert.strictEqual(plain(savedPlatforms()['my-relay'].models).length, 1, '非法倍率不拦截保存（平台档案保留模型）');
	assert.strictEqual(plain(savedPlatforms()['my-relay'].models)[0].feeMultiplier, 1, '非法倍率按 1 落库');
	platformHead(row()).props.onClick();
	rerender(state);
	rowFeeIn(row(), 0).props.onChange({ target: { value: '' } });
	rerender(state);
	findLabelInput(row(), t('priceEndpoint')).props.onChange({ target: { value: 'not-a-url' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.strictEqual(noticeShown(state, 'priceEndpointInvalid'), false, '地址非法 → 不显示顶部提示');
	assert.strictEqual(plain(savedPlatforms()['my-relay']).endpoint, '', '非法地址按空地址落库（不拦截保存）');
	platformHead(row()).props.onClick();
	rerender(state);
	findLabelInput(row(), t('priceEndpoint')).props.onChange({ target: { value: 'https://relay.example.com/balance' } });
	rerender(state);
	findLabelInput(row(), t('priceBalanceField')).props.onChange({ target: { value: '¥' } });
	rerender(state);
	buttonsByLabel(row(), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.ok(noticeShown(state, 'priceBalanceFieldInvalid'), '余额字段非法 → 顶部提示');
	assert.strictEqual(savedModels(inst)['deepseek-flash'].feeMultiplier, undefined, '非法输入不写价格条目倍率');

	/* 改回合法值保存：倍率 1 不写字段（按旧格式存） */
	platformHead(row()).props.onClick();
	rerender(state);
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

	/* 只按倍率计费（地址留空）：仍要 POST（endpoint 空，Host 保存空地址；
	   首次查询再用平台配置探测余额端点），倍率仍写进条目；档案里没填的请求头 / 余额字段保持空 */
	const beforeLite = postBodies.length;
	addPlatform(state, 'magpie-like');
	const maggieRow = () => platformRow(state.tree, 'magpie-like');
	platformHead(maggieRow()).props.onClick();
	rerender(state);
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
	assert.strictEqual(postBodies.length, beforeLite + 1, '地址留空仍提交（endpoint 空，交给 Host 保存并在首次查询时探测）');
	assert.strictEqual(postBodies[postBodies.length - 1].endpoint, '', '地址留空 → POST 空 endpoint');
	const maggieHead = findAll(maggieRow(), (node) => hasClass(node, 'dsb-model-head'))[0];
	assert.ok(textOf(maggieHead).indexOf('magpie-like') !== -1, '平台头部只显示平台名');
	assert.strictEqual(textOf(maggieHead).indexOf('DeepSeek-Flash'), -1, '平台头部不显示适用模型名摘要');
	assert.strictEqual(textOf(maggieHead).indexOf('只按倍率计费'), -1, '平台头部不再显示「只按倍率计费」');
	assert.strictEqual(textOf(maggieHead).indexOf('未填适用模型'), -1, '平台头部不再显示「未填适用模型」');

	/* 空白地址 + 令牌 + 用户 ID：令牌只随 POST 走，地址没填也必须提交；重新打开显示已保存占位。 */
	const openPlatform = (name) => {
		platformHead(platformRow(state.tree, name)).props.onClick();
		rerender(state);
	};
	const beforeBlankSecret = postBodies.length;
	addPlatform(state, 'blank-secret');
	openPlatform('blank-secret');
	findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceToken')).props.onChange({ target: { value: SECRET } });
	rerender(state);
	findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceUserId')).props.onChange({ target: { value: USER_SECRET } });
	rerender(state);
	buttonsByLabel(platformRow(state.tree, 'blank-secret'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const blankSecretPost = postBodies[postBodies.length - 1];
	assert.strictEqual(postBodies.length, beforeBlankSecret + 1, '空白地址 + 令牌 + 用户 ID → 仍发一条 POST');
	assert.strictEqual(blankSecretPost.endpoint, '', '空白地址 → payload.endpoint 空串（Host 保存为空）');
	assert.strictEqual(blankSecretPost.token, SECRET, '空白地址也要带上令牌');
	assert.strictEqual(blankSecretPost.userId, USER_SECRET, '空白地址也要带上用户 ID');
	assert.strictEqual(blankSecretPost.balancePath, 'data.quota', '空白地址 → 其余字段仍补默认 data.quota');
	assert.strictEqual(blankSecretPost.balanceDivisor, 500000, '空白地址 → 其余字段仍补默认 500000');
	openPlatform('blank-secret');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceToken')).props.value, '', '重新打开：令牌框不回显明文');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceToken')).props.placeholder, t('platformSecretSaved'), '重新打开：令牌显示「已保存」占位');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceUserId')).props.value, '', '重新打开：用户 ID 不回显明文');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceUserId')).props.placeholder, t('platformSecretSaved'), '重新打开：用户 ID 显示「已保存」占位');
	/* 只填了令牌 / 用户 ID，请求头 / 地址 / 余额字段保持空：Host relayConfigView 回传的运行时默认值
	   （New-Api-User / data.quota / 500000）不能当成用户填过的值回填。 */
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceTokenHeader')).props.value, '', '重新打开：请求头仍为空（Host 默认值不回填）');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceEndpoint')).props.value, '', '重新打开：地址仍为空');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-secret'), t('priceBalanceField')).props.value, '', '重新打开：余额字段仍为空（Host 默认值不回填）');

	/* task-26：空地址但已配 token/userId 的平台，删除也必须发幂等 remove。
	   旧逻辑只在 endpoint 非空时 remove，空地址平台会跳过 → Host 不清 credential →
	   同名重建仍残留 token/userId。这里补回归：删除空地址+已配 secret 的平台要发 remove。 */
	const beforeBlankSecretRemove = postBodies.length;
	buttonsByLabel(platformRow(state.tree, 'blank-secret'), t('priceRemove'))[0].props.onClick();
	await settle();
	rerender(state);
	assert.deepStrictEqual(plain(postBodies[postBodies.length - 1]), { remove: true, channelKey: 'blank-secret' },
		'空地址+已配 token/userId 的平台删除 → 仍发 remove');
	assert.strictEqual(postBodies.length, beforeBlankSecretRemove + 1, '空地址删除只发一条 remove');
	assert.strictEqual(plain(savedPlatforms())['blank-secret'], undefined, '空地址平台删除后本地档案消失');

	/* 只填部分字段：只填令牌 / 只填用户 ID 也必须保存，另一个保持未配置。 */
	addPlatform(state, 'blank-token-only');
	openPlatform('blank-token-only');
	findLabelInput(platformRow(state.tree, 'blank-token-only'), t('priceToken')).props.onChange({ target: { value: 'sk-only-token' } });
	rerender(state);
	buttonsByLabel(platformRow(state.tree, 'blank-token-only'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const tokenOnlyPost = postBodies[postBodies.length - 1];
	assert.strictEqual(tokenOnlyPost.endpoint, '', '只填令牌：地址仍为空也要 POST');
	assert.strictEqual(tokenOnlyPost.token, 'sk-only-token', '只填令牌：令牌要保存');
	assert.strictEqual(tokenOnlyPost.userId, undefined, '只填令牌：不伪造用户 ID');
	openPlatform('blank-token-only');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-token-only'), t('priceToken')).props.placeholder, t('platformSecretSaved'), '只填令牌：重新打开显示已保存');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-token-only'), t('priceUserId')).props.placeholder, t('priceUserIdHint'), '只填令牌：用户 ID 仍是未配置提示');

	addPlatform(state, 'blank-user-only');
	openPlatform('blank-user-only');
	findLabelInput(platformRow(state.tree, 'blank-user-only'), t('priceUserId')).props.onChange({ target: { value: 'user-only-7' } });
	rerender(state);
	buttonsByLabel(platformRow(state.tree, 'blank-user-only'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const userOnlyPost = postBodies[postBodies.length - 1];
	assert.strictEqual(userOnlyPost.endpoint, '', '只填用户 ID：地址仍为空也要 POST');
	assert.strictEqual(userOnlyPost.userId, 'user-only-7', '只填用户 ID：用户 ID 要保存');
	assert.strictEqual(userOnlyPost.token, undefined, '只填用户 ID：不伪造令牌');
	openPlatform('blank-user-only');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-user-only'), t('priceUserId')).props.placeholder, t('platformSecretSaved'), '只填用户 ID：重新打开显示已保存');
	assert.strictEqual(findLabelInput(platformRow(state.tree, 'blank-user-only'), t('priceToken')).props.placeholder, t('priceTokenHint'), '只填用户 ID：令牌仍是未配置提示');

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
	platformHead(clearRow()).props.onClick();
	rerender(state);
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
	platformHead(clearRow()).props.onClick();
	rerender(state);
	assert.strictEqual(findLabelInput(clearRow(), t('priceBalanceField')).props.value, '¥data.quota / 500000',
		'再次打开：地址可用 → 默认余额字段能查到余额，回填默认值');
	assert.strictEqual(findLabelInput(clearRow(), t('priceTokenHeader')).props.value, 'New-Api-User',
		'再次打开：地址可用 → 默认请求头能查到余额，回填默认值');
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
	assert.deepStrictEqual(plain(migratedSnap.relayPlatformOrder), ['deepseek-flash'],
		'独立数组初始化：旧 relay 迁移出的平台进入显示顺序');
	const reloaded = loadClient(undefined, [[CONFIG_KEY, migrated.store.get(CONFIG_KEY)]]);
	assert.deepStrictEqual(plain(reloaded.api.snapshot().relayPlatforms), plain(migratedSnap.relayPlatforms),
		'二次加载平台档案保持不变（迁移幂等）');
	assert.deepStrictEqual(plain(reloaded.api.snapshot().relayPlatformOrder), ['deepseek-flash'],
		'二次加载显示顺序保持不变');

	/* 旧档案兼容：平台里已有但价格库没有的旧模型名只回显，不进入该行下拉选项 */
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
	findAll(legacyRow(), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
	legacyRender();
	const legacyTrigger = findAll(legacyRow(), (node) => node.type === 'input' && hasClass(node, 'dsb-select-btn'))[0];
	legacyTrigger.props.onFocus(menuEvent(legacyRow()));
	legacyRender();
	const legacyMenu = findAll(legacyRow(), (node) => hasClass(node, 'dsb-select-menu'))[0];
	const legacyOptions = findAll(legacyMenu, (node) => node.type === 'button' && hasClass(node, 'dsb-select-item')).map((node) => node.props.key);
	assert.strictEqual(legacyOptions.indexOf('old-model'), -1, '旧档案未知模型不进入下拉候选');
	const legacyTriggers = findAll(legacyRow(), (node) => node.type === 'input' && hasClass(node, 'dsb-select-btn'));
	assert.strictEqual(legacyTriggers.length, 3, '旧档案三行模型都渲染');
	assert.strictEqual(legacyTriggers[1].props.value, 'Mimo-V2.6-Pro-Ultraspeed', '24 字符长模型名完整保留（原生 input value）');
	assert.strictEqual(legacyTriggers[2].props.value, 'Mimo-V2.6-Pro-Ultraspeed-Plus', '超长模型名完整保留（原生 input value）');
	/* 原生 input 不再按容器宽度缩字号：长名靠 CSS 省略号截断显示，数据层保留全名 */
	legacyTriggers.forEach((trigger) => {
		assert.strictEqual(trigger.type, 'input', '模型控件是原生 input');
		assert.strictEqual(trigger.props.type, 'text', '模型控件是原生文本输入');
		assert.strictEqual(trigger.props.role, 'combobox', '模型控件保留 combobox 语义');
		assert.strictEqual(typeof trigger.props.onChange, 'function', '模型控件支持输入筛选');
	});
	/* Host 同步失败 / 抛错：只在 console.warn 留日志，平台区块不出现任何用户可见提示。
	   成功与字段校验提示不受影响。 */
	const relayFailureNotice = (reason) => t('priceRelaySyncFailed', { reason: reason });
	const relayNoticeShown = () => {
		const text = textOf(section(state.tree));
		return text.indexOf(relayFailureNotice('relay-config-failed')) !== -1
			|| text.indexOf(relayFailureNotice('failed')) !== -1
			|| text.indexOf('第三方平台配置同步失败') !== -1;
	};
	const withWarnCapture = async (fn) => {
		const lines = [];
		const original = console.warn;
		console.warn = (...args) => { lines.push(args.map((one) => String(one)).join(' ')); };
		try { await fn(); } finally { console.warn = original; }
		return lines;
	};
	const saveNewPlatform = async (name, endpoint) => {
		addPlatform(state, name);
		const target = () => platformRow(state.tree, name);
		platformHead(target()).props.onClick();
		rerender(state);
		if (endpoint !== undefined) {
			findLabelInput(target(), t('priceEndpoint')).props.onChange({ target: { value: endpoint } });
			rerender(state);
		}
		buttonsByLabel(target(), t('priceSave'))[0].props.onClick();
		await settle();
		rerender(state);
	};
	/* 成功：不显示同步失败提示 */
	relayPostOutcome = 'ok';
	await saveNewPlatform('sync-ok', 'https://relay.example.com/balance');
	assert.strictEqual(relayNoticeShown(), false, '同步成功不显示 priceRelaySyncFailed');
	/* postRelayState 返回 ok:false：不显示提示，只写 console.warn */
	relayPostOutcome = 'fail';
	const failWarns = await withWarnCapture(async () => { await saveNewPlatform('sync-fail', 'https://relay.example.com/balance'); });
	assert.strictEqual(relayNoticeShown(), false, 'postRelayState 返回失败时平台编辑区不出现 priceRelaySyncFailed');
	assert.ok(failWarns.some((line) => line.indexOf(relayFailureNotice('relay-config-failed')) !== -1),
		'同步失败只写 console.warn（带 Host 返回的 reason）');
	/* postRelayState 抛错：同样不显示提示，只写 console.warn */
	relayPostOutcome = 'throw';
	const throwWarns = await withWarnCapture(async () => { await saveNewPlatform('sync-throw', 'https://relay.example.com/balance'); });
	assert.strictEqual(relayNoticeShown(), false, 'postRelayState 抛错时平台编辑区不出现 priceRelaySyncFailed');
	assert.ok(throwWarns.some((line) => line.indexOf(relayFailureNotice('failed')) !== -1),
		'同步抛错只写 console.warn（reason=failed）');
	/* 字段校验提示不受影响：同步失败的同一轮仍显示地址非法提示 */
	relayPostOutcome = 'fail';
	await saveNewPlatform('sync-validation', 'not-a-url');
	assert.strictEqual(relayNoticeShown(), false, '同步失败不出现 priceRelaySyncFailed');
	assert.strictEqual(noticeShown(state, 'priceEndpointInvalid'), false, '同步失败时不显示 priceEndpointInvalid');
	relayPostOutcome = 'ok';
	console.log('      同步失败/抛错只 console.warn，不显示 priceRelaySyncFailed；校验提示照常');
	console.log('      气泡无第三方字段；平台增删改；模型下拉→倍率落库；secret 一次性；地址留空=只按倍率；旧 relay 迁移成平台；旧档案模型只回显');
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
	assert.deepStrictEqual(findAll(head(), (node) => hasClass(node, 'dsb-platform-title')).map(textOf), ['empty-one'], '平台头部只显示平台名');
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
		/* 添加只落库；点平台头进入编辑。 */
		findAll(row, (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
		rerender();
		assert.strictEqual(findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-pop')).length, 1,
			'「' + name + '」点平台头后出现可编辑气泡');
		return platformRow(name);
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
	findAll(platformRow('blank-one'), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
	rerender();
	assert.strictEqual(findLabelInput(platformRow('blank-one'), t('priceTokenHeader')).props.value, '', '再打开：请求头不回填默认值');
	assert.strictEqual(findLabelInput(platformRow('blank-one'), t('priceBalanceField')).props.value, '', '再打开：余额字段不回填默认值');
	/* 关键回归：编辑行开着时点别处不得把它取消掉（平台已落库，点「修改」打开既有平台） */
	findAll(platformRow('123'), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
	rerender();
	assert.strictEqual(findAll(platformRow('123'), (node) => hasClass(node, 'dsb-platform-pop')).length, 1, '前置：123 的编辑气泡开着');
	assert.strictEqual(inst.docClickCount(), 0, '平台编辑打开时不挂「点别处收起」的文档监听（价格气泡专属）');
	inst.outsideClick();
	rerender();
	const afterClick = platformRow('123');
	assert.ok(afterClick !== undefined, '点别处后平台行还在');
	assert.strictEqual(findAll(afterClick, (node) => hasClass(node, 'dsb-platform-pop')).length, 1,
		'点别处不会把刚打开、还没落库的平台编辑气泡取消掉（「添加不出来」的根因）');
	console.log('      123 / abcXYZ / My Relay 2.0 / a_b-c 都能添加并出现编辑行；空平台存空；点别处不取消');
}

/* ====================================================================
   ③-2b 平台显示顺序：纯数字名排最后 / 旧配置迁移 / 删除重加
   ==================================================================== */
console.log('\n===== ③-2b 平台显示顺序（纯数字名 35326 排最后） =====');
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
	const rowNames = () => findAll(section(), (node) => hasClass(node, 'dsb-model') && typeof node.props.key === 'string').map((node) => node.props.key);
	const typeName = (value) => {
		const input = findAll(section(), (node) => node.type === 'input' && node.props.placeholder === t('platformNewPh'))[0];
		input.props.onChange({ target: { value: value } });
		rerender();
	};
	const clickAdd = () => { buttonsByLabel(section(), t('platformAdd'))[0].props.onClick(); rerender(); };
	const addPlatform = (name) => { typeName(name); clickAdd(); };

	addPlatform('alpha');
	addPlatform('beta');
	addPlatform('35326');
	assert.deepStrictEqual(plain(api.snapshot().relayPlatformOrder), ['alpha', 'beta', '35326'],
		'添加顺序写进 relayPlatformOrder');
	assert.deepStrictEqual(rowNames(), ['alpha', 'beta', '35326'],
		'渲染顺序：纯数字平台 35326 排最后（不因 JS 键序跑到前面）');

	/* 保存平台不改顺序 */
	findAll(platformRow('alpha'), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
	rerender();
	buttonsByLabel(platformRow('alpha'), t('priceSave'))[0].props.onClick();
	rerender();
	assert.deepStrictEqual(plain(api.snapshot().relayPlatformOrder), ['alpha', 'beta', '35326'],
		'保存平台不改顺序');

	/* 删除中间平台 → 数组同步移除；重加同名平台 → 回到末尾 */
	buttonsByLabel(platformRow('beta'), t('priceRemove'))[0].props.onClick();
	rerender();
	assert.ok(platformRow('beta') === undefined, '删除平台后行消失');
	assert.deepStrictEqual(plain(api.snapshot().relayPlatformOrder), ['alpha', '35326'],
		'删除平台从 relayPlatformOrder 移除');
	addPlatform('beta');
	assert.deepStrictEqual(plain(api.snapshot().relayPlatformOrder), ['alpha', '35326', 'beta'],
		'重新添加同名平台回到末尾');
	assert.deepStrictEqual(rowNames(), ['alpha', '35326', 'beta'],
		'渲染顺序同步（重加不插回原位置）');

	/* setConfig 更新其它字段时保留顺序 */
	api.setConfig({ models: CNY_BASE });
	assert.deepStrictEqual(plain(api.snapshot().relayPlatformOrder), ['alpha', '35326', 'beta'],
		'setConfig 更新价格库时保留 relayPlatformOrder');

	/* 持久化重载：顺序与平台表一起存进 localStorage，重载后不丢 */
	const reloaded = loadClient(undefined, [[api.STORAGE_KEY, inst.store.get(api.STORAGE_KEY)]]);
	assert.deepStrictEqual(plain(reloaded.api.snapshot().relayPlatformOrder), ['alpha', '35326', 'beta'],
		'持久化重载后平台顺序保持不变');
	assert.deepStrictEqual(Object.keys(plain(reloaded.api.snapshot().relayPlatforms)).sort(), ['35326', 'alpha', 'beta'],
		'持久化重载后平台不丢');
	console.log('      35326 添加后排最后；保存不改顺序；删除移除、重加回末尾；重载顺序保持');
}

/* 旧配置没有 relayPlatformOrder：按当前 Object.keys(relayPlatforms) 初始化，保留既有显示顺序 */
{
	const probe = loadClient();
	const CONFIG_KEY = probe.api.STORAGE_KEY;
	const LEGACY_ORDER_CONFIG = JSON.stringify({
		version: 6,
		priceVersion: 8,
		currency: 'CNY',
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		relayPlatforms: {
			zeta: { endpoint: '', models: [] },
			alpha: { endpoint: '', models: [] },
			beta: { endpoint: '', models: [] }
		}
	});
	const legacyInst = loadClient(undefined, [[CONFIG_KEY, LEGACY_ORDER_CONFIG]]);
	const legacyApi = legacyInst.api;
	const legacySnap = legacyApi.snapshot();
	assert.deepStrictEqual(plain(legacySnap.relayPlatformOrder), ['zeta', 'alpha', 'beta'],
		'旧配置迁移：按 Object.keys(relayPlatforms) 初始化，保留既有显示顺序');
	assert.deepStrictEqual(Object.keys(plain(legacySnap.relayPlatforms)).sort(), ['alpha', 'beta', 'zeta'],
		'迁移不丢任何平台');
	const legacyT = translator(legacyApi);
	const legacyTree = withHooks(legacyInst.hooks(), () => legacyApi.SettingsSection({ t: legacyT, useProjection: () => undefined }));
	const legacySection = findAll(legacyTree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const legacyNames = findAll(legacySection, (node) => hasClass(node, 'dsb-model') && typeof node.props.key === 'string').map((node) => node.props.key);
	assert.deepStrictEqual(legacyNames, ['zeta', 'alpha', 'beta'], '迁移后渲染顺序与旧显示顺序一致');

	/* 手改配置：数组只列了部分平台（还带已删除的脏名字）→ 仍存在的按数组顺序，缺的按 Object.keys 补末尾 */
	const PARTIAL_CONFIG = JSON.stringify({
		version: 6,
		priceVersion: 8,
		currency: 'CNY',
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		relayPlatforms: {
			alpha: { endpoint: '', models: [] },
			beta: { endpoint: '', models: [] },
			gamma: { endpoint: '', models: [] }
		},
		relayPlatformOrder: ['ghost', 'beta']
	});
	const partial = loadClient(undefined, [[CONFIG_KEY, PARTIAL_CONFIG]]);
	assert.deepStrictEqual(plain(partial.api.snapshot().relayPlatformOrder), ['beta', 'alpha', 'gamma'],
		'手改配置：数组里缺的平台按 Object.keys 补末尾，脏名字丢弃');
	console.log('      旧配置迁移保留 zeta→alpha→beta；缺项按 Object.keys 补末尾且不丢平台');
}

/* ====================================================================
   ③-3 Host 默认值只在 saved.endpoint 非空（地址可用）时回显
   ==================================================================== */
console.log('\n===== ③-3 Host 默认值仅在地址可用时回显 =====');
{
	const inst = loadClient((url) => {
		if (String(url).indexOf('/api/relay-balance-config') !== -1) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: [
				{
					channelKey: 'probed',
					endpoint: 'https://relay.example.com/balance',
					tokenHeader: 'authorization',
					userIdHeader: 'New-Api-User',
					tokenPrefix: 'Bearer ',
					balancePath: 'data.quota',
					currency: 'CNY',
					feeMultiplier: 1,
					balanceDivisor: 500000,
					tokenConfigured: true,
					userIdConfigured: true
				},
				{
					channelKey: 'unprobed',
					endpoint: '',
					tokenHeader: 'authorization',
					userIdHeader: 'New-Api-User',
					tokenPrefix: 'Bearer ',
					balancePath: 'data.quota',
					currency: 'CNY',
					feeMultiplier: 1,
					balanceDivisor: 500000,
					tokenConfigured: true,
					userIdConfigured: true
				}
			] }) });
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	api.setConfig({
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		priceConfigured: true,
		relayPlatforms: { probed: plain(emptyPlatform), unprobed: plain(emptyPlatform) }
	});
	await api.ensureRelayState();
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const open = (name) => {
		findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
		rerender();
	};
	open('probed');
	assert.strictEqual(findLabelInput(platformRow('probed'), t('priceTokenHeader')).props.value, 'New-Api-User',
		'地址可用 → 回显宿主默认请求头 New-Api-User');
	assert.strictEqual(findLabelInput(platformRow('probed'), t('priceBalanceField')).props.value, '¥data.quota / 500000',
		'地址可用 → 回显宿主默认余额字段 ¥data.quota / 500000');
	assert.strictEqual(findLabelInput(platformRow('probed'), t('priceEndpoint')).props.value, 'https://relay.example.com/balance',
		'地址可用 → 回显宿主可用地址');
	assert.strictEqual(findLabelInput(platformRow('probed'), t('priceToken')).props.placeholder, t('platformSecretSaved'),
		'地址可用 → 令牌仍是已保存状态');
	assert.strictEqual(findLabelInput(platformRow('probed'), t('priceUserId')).props.placeholder, t('platformSecretSaved'),
		'地址可用 → 用户 ID 仍是已保存状态');
	open('unprobed');
	assert.strictEqual(findLabelInput(platformRow('unprobed'), t('priceTokenHeader')).props.value, '',
		'地址为空 → 不回显默认请求头');
	assert.strictEqual(findLabelInput(platformRow('unprobed'), t('priceBalanceField')).props.value, '',
		'地址为空 → 不回显默认余额字段');
	assert.strictEqual(findLabelInput(platformRow('unprobed'), t('priceEndpoint')).props.value, '',
		'地址为空 → 地址保持空');
	assert.strictEqual(findLabelInput(platformRow('unprobed'), t('priceToken')).props.placeholder, t('platformSecretSaved'),
		'地址为空 → 令牌仍是已保存状态');
	assert.strictEqual(findLabelInput(platformRow('unprobed'), t('priceUserId')).props.placeholder, t('platformSecretSaved'),
		'地址为空 → 用户 ID 仍是已保存状态');
	console.log('      saved.endpoint 非空 → 显示 Host 默认值；endpoint 为空 → 只显示本地显式值（空）');
}
/* ====================================================================
   ③-4 清空 Host 自动探测地址：不残留运行时默认值 / 显式值保留 / 真 remove
   ==================================================================== */
console.log('\n===== ③-4 清空 Host 探测地址：不残留默认值 / 显式值保留 / 真 remove =====');
{
	/* fake 宿主：只维护一个 channel 内存表；GET 返回它，POST 按 payload 更新 / remove。
	   用于模拟「Host 自动探测写入 endpoint，而本地旧档案 endpoint 为空」。 */
	const hostChannels = new Map();
	const posts = [];
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') === -1) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
		}
		if (init !== undefined && init !== null && init.method === 'POST') {
			const body = JSON.parse(init.body);
			posts.push(body);
			if (body.remove === true) {
				hostChannels.delete(body.channelKey);
			} else {
				hostChannels.set(body.channelKey, {
					channelKey: body.channelKey,
					endpoint: body.endpoint,
					tokenHeader: body.tokenHeader,
					userIdHeader: body.userIdHeader,
					tokenPrefix: body.tokenPrefix,
					balancePath: body.balancePath,
					currency: body.currency,
					feeMultiplier: body.feeMultiplier,
					balanceDivisor: body.balanceDivisor,
					tokenConfigured: body.token !== undefined && body.token !== '',
					userIdConfigured: body.userId !== undefined && body.userId !== ''
				});
			}
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: Array.from(hostChannels.values()) }) });
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: Array.from(hostChannels.values()) }) });
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	/* Host 已自动探测出可用地址（endpoint 非空），但本地旧档案 endpoint 为空、默认字段也为空 */
	const probedChannel = (key) => ({
		channelKey: key,
		endpoint: 'https://host.example.com/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: 'data.quota',
		currency: 'CNY',
		feeMultiplier: 1,
		balanceDivisor: 500000,
		tokenConfigured: true,
		userIdConfigured: true
	});
	hostChannels.set('probed-clear', probedChannel('probed-clear'));
	hostChannels.set('probed-explicit', probedChannel('probed-explicit'));
		hostChannels.set('probed-retype-user', probedChannel('probed-retype-user'));
		hostChannels.set('probed-retype-balance', probedChannel('probed-retype-balance'));
	/* task-29：Host 自动探测出 credits 余额（balanceKind=credits，balancePath 保留原始 '$.balance'，精确 divisor/currency） */
	hostChannels.set('probed-credits', {
		channelKey: 'probed-credits',
		endpoint: 'https://credits.example.com/api/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: '$.balance',
		currency: 'USD',
		feeMultiplier: 1,
		balanceDivisor: 1,
		balanceKind: 'credits',
		tokenConfigured: true,
		userIdConfigured: true
	});
	api.setConfig({
		models: CNY_BASE,
		modelOrder: ['deepseek-flash'],
		priceConfigured: true,
			relayPlatforms: { 'probed-clear': plain(emptyPlatform), 'probed-explicit': plain(emptyPlatform), 'probed-retype-user': plain(emptyPlatform), 'probed-retype-balance': plain(emptyPlatform), 'probed-credits': plain(emptyPlatform) }
	});
	await api.ensureRelayState();
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const open = (name) => {
		findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick();
		rerender();
	};
	const savedPlatforms = () => JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms;

	/* —— 场景一：清空 Host 探测地址 → 真 remove，且本地不残留运行时默认值 —— */
	open('probed-clear');
	assert.strictEqual(findLabelInput(platformRow('probed-clear'), t('priceTokenHeader')).props.value, 'New-Api-User',
		'前置：地址可用 → 回显 Host 默认请求头');
	findLabelInput(platformRow('probed-clear'), t('priceEndpoint')).props.onChange({ target: { value: '' } });
	rerender();
	buttonsByLabel(platformRow('probed-clear'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender();
	assert.deepStrictEqual(plain(posts[posts.length - 1]), { remove: true, channelKey: 'probed-clear' },
		'Host 当前有地址、本地为空 → 清空时必须是 remove，不能 POST 空 endpoint');
	const cleared = plain(savedPlatforms()['probed-clear']);
	assert.strictEqual(cleared.endpoint, '', '本地 endpoint 保持空');
	assert.deepStrictEqual([cleared.userIdHeader, cleared.balancePath, cleared.currency, cleared.balanceDivisor], ['', '', '', null],
		'Host 预填的请求头 / 余额字段不能变成永久本地值');
	open('probed-clear');
	assert.strictEqual(findLabelInput(platformRow('probed-clear'), t('priceTokenHeader')).props.value, '', '清空后重开：不再残留默认请求头');
	assert.strictEqual(findLabelInput(platformRow('probed-clear'), t('priceBalanceField')).props.value, '', '清空后重开：不再残留默认余额字段');
	assert.strictEqual(findLabelInput(platformRow('probed-clear'), t('priceEndpoint')).props.value, '', '清空后重开：地址仍为空');

	/* —— 场景二：用户明确改过的值仍保留（自动值不残留） —— */
	open('probed-explicit');
	findLabelInput(platformRow('probed-explicit'), t('priceTokenHeader')).props.onChange({ target: { value: 'X-Custom-Id' } });
	rerender();
	findLabelInput(platformRow('probed-explicit'), t('priceEndpoint')).props.onChange({ target: { value: '' } });
	rerender();
	const beforeExplicit = posts.length;
	buttonsByLabel(platformRow('probed-explicit'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender();
	assert.deepStrictEqual(plain(posts[posts.length - 1]), { remove: true, channelKey: 'probed-explicit' },
		'显式改过请求头后清空地址 → 仍是 remove');
	assert.strictEqual(posts.length, beforeExplicit + 1, '清空地址只发一条 remove');
	const explicitSaved = plain(savedPlatforms()['probed-explicit']);
	assert.strictEqual(explicitSaved.userIdHeader, 'X-Custom-Id', '用户明确改过的请求头保留');
	assert.deepStrictEqual([explicitSaved.balancePath, explicitSaved.currency, explicitSaved.balanceDivisor], ['', '', null],
		'未改动的默认余额字段不残留');
	open('probed-explicit');
	assert.strictEqual(findLabelInput(platformRow('probed-explicit'), t('priceTokenHeader')).props.value, 'X-Custom-Id',
		'重开：显式请求头保留');
	assert.strictEqual(findLabelInput(platformRow('probed-explicit'), t('priceBalanceField')).props.value, '',
		'重开：自动余额字段仍为空');
	/* —— 场景三：重新输入的请求头恰好等于 Host 默认值 → 仍作为显式值保留 —— */
	open('probed-retype-user');
	findLabelInput(platformRow('probed-retype-user'), t('priceTokenHeader')).props.onChange({ target: { value: 'New-Api-User' } });
	rerender();
	findLabelInput(platformRow('probed-retype-user'), t('priceEndpoint')).props.onChange({ target: { value: '' } });
	rerender();
	buttonsByLabel(platformRow('probed-retype-user'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender();
	assert.deepStrictEqual(plain(posts[posts.length - 1]), { remove: true, channelKey: 'probed-retype-user' }, '重新输入默认请求头后清空地址 → remove');
	const retypeUser = plain(savedPlatforms()['probed-retype-user']);
	assert.strictEqual(retypeUser.userIdHeader, 'New-Api-User', '明确重新输入的默认请求头必须保留（不因等于 Host 默认而被清）');
	assert.deepStrictEqual([retypeUser.balancePath, retypeUser.currency, retypeUser.balanceDivisor], ['', '', null], '未改动的余额字段仍不残留');
	open('probed-retype-user');
	assert.strictEqual(findLabelInput(platformRow('probed-retype-user'), t('priceTokenHeader')).props.value, 'New-Api-User', '重开：保留重新输入的默认请求头');

	/* —— 场景四：重新输入的余额字段恰好等于 Host 默认值 → 仍作为显式值保留 —— */
	open('probed-retype-balance');
	findLabelInput(platformRow('probed-retype-balance'), t('priceBalanceField')).props.onChange({ target: { value: '¥data.quota / 500000' } });
	rerender();
	findLabelInput(platformRow('probed-retype-balance'), t('priceEndpoint')).props.onChange({ target: { value: '' } });
	rerender();
	buttonsByLabel(platformRow('probed-retype-balance'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender();
	assert.deepStrictEqual(plain(posts[posts.length - 1]), { remove: true, channelKey: 'probed-retype-balance' }, '重新输入默认余额字段后清空地址 → remove');
	const retypeBal = plain(savedPlatforms()['probed-retype-balance']);
	assert.deepStrictEqual([retypeBal.balancePath, retypeBal.currency, retypeBal.balanceDivisor], ['data.quota', 'CNY', 500000], '明确重新输入的默认余额字段必须保留');
	assert.strictEqual(retypeBal.userIdHeader, '', '未改动的请求头不残留');
	open('probed-retype-balance');
	assert.strictEqual(findLabelInput(platformRow('probed-retype-balance'), t('priceBalanceField')).props.value, '¥data.quota / 500000', '重开：保留重新输入的默认余额字段');
	assert.strictEqual(findLabelInput(platformRow('probed-retype-balance'), t('priceTokenHeader')).props.value, '', '重开：未改动请求头仍为空');

	/* —— 场景五（task-29）：Host 自动探测 credits 余额，打开后未触碰字段直接保存 ——
	   POST 必须沿用 Host 的精确解析字段（$.balance / 1 / USD），不得回填 data.quota/500000；
	   否则 Server 视为解析字段变化会清 balanceKind → 后续同 endpoint 查询永久 invalid-balance。 */
	open('probed-credits');
	const beforeCreditsSave = posts.length;
	buttonsByLabel(platformRow('probed-credits'), t('priceSave'))[0].props.onClick();
	await settle();
	rerender(state);
	const creditsPost = posts[posts.length - 1];
	assert.strictEqual(posts.length, beforeCreditsSave + 1, 'credits 平台自动保存发出一条 POST');
	assert.strictEqual(creditsPost.channelKey, 'probed-credits', 'POST 目标是 credits 平台');
	assert.strictEqual(creditsPost.endpoint, 'https://credits.example.com/api/balance', '地址保持 Host 已探测地址');
	assert.strictEqual(creditsPost.balancePath, '$.balance', '保留 Host 原始 balancePath($.balance)，不回退 data.quota');
	assert.strictEqual(creditsPost.balanceDivisor, 1, '保留 Host 精确 balanceDivisor(1)，不回退 500000');
	assert.strictEqual(creditsPost.currency, 'USD', '保留 Host 精确 currency(USD)');
	assert.strictEqual(creditsPost.balanceKind, undefined, '客户端不把 balanceKind 写给 Host（服务端按相同字段自然保留）');
	const creditsLocal = plain(savedPlatforms()['probed-credits']);
	assert.deepStrictEqual([creditsLocal.balancePath, creditsLocal.currency, creditsLocal.balanceDivisor], ['', '', null],
		'本地档案仍不写入 Host 解析字段（运行时默认不落本地）');
	assert.strictEqual(creditsLocal.endpoint, 'https://credits.example.com/api/balance', '本地档案记录已探测地址');
	open('probed-credits');
	assert.strictEqual(findLabelInput(platformRow('probed-credits'), t('priceBalanceField')).props.value, '$balance',
		'重开：仍显示 Host 原始余额字段，未变成 ¥data.quota / 500000');
	console.log('      credits 自动探测：自动保存 POST 保留 $.balance/1/USD，不回退 data.quota/500000');
	console.log('      清空 Host 探测地址 → remove；自动默认值不残留；显式值保留');
}

/* ====================================================================
   ③-6 打开平台前强制刷新 Host 快照（task-31：陈旧空快照不得覆盖自动探测结果）
   ==================================================================== */
console.log('\n===== ③-6 已加载空快照后 Host 自动探测 credits：打开平台强制刷新 =====');
{
	/* 初始 Host 快照为空：客户端先加载到空快照（模拟设置页挂载后只 GET 一次）。 */
	let hostList = [];
	const posts = [];
	const creditChannel = {
		channelKey: 'stale-credits',
		endpoint: 'https://credits.example.com/api/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: '$.balance',
		currency: 'USD',
		feeMultiplier: 1,
		balanceDivisor: 1,
		balanceKind: 'credits',
		tokenConfigured: true,
		userIdConfigured: true
	};
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') === -1) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
		}
		if (init !== undefined && init !== null && init.method === 'POST') {
			posts.push(JSON.parse(init.body));
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: hostList }) });
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: { 'stale-credits': plain(emptyPlatform) } });
	await api.ensureRelayState();  /* 客户端加载“空快照” */
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const open = (name) => { findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0].props.onClick(); rerender(); };
	/* 服务端后台自动探测完成：Host 快照出现 credits channel，而客户端仍是旧的空快照 */
	hostList = [ JSON.parse(JSON.stringify(creditChannel)) ];
	/* 打开平台：应强制刷新 Host 快照并用最新数据初始化 draft（不是旧空快照） */
	open('stale-credits');
	await settle();
	rerender();
	assert.strictEqual(findLabelInput(platformRow('stale-credits'), t('priceEndpoint')).props.value,
		'https://credits.example.com/api/balance', '打开平台强制刷新：draft 用最新 Host endpoint（不是空/旧地址）');
	assert.strictEqual(findLabelInput(platformRow('stale-credits'), t('priceBalanceField')).props.value,
		'$balance', '打开平台强制刷新：draft 用最新 Host 解析字段（$balance）');
	/* 点击头部触发自动保存（与“点外部 → savePlatform”同一保存路径） */
	const beforeSave = posts.length;
	open('stale-credits');
	await settle();
	rerender();
	const saved = posts[posts.length - 1];
	assert.strictEqual(posts.length, beforeSave + 1, '自动保存发出一条 POST');
	assert.strictEqual(saved.endpoint, 'https://credits.example.com/api/balance', '保存保留 Host endpoint，不被空地址覆盖');
	assert.strictEqual(saved.balancePath, '$.balance', '保存保留 $.balance，不回退 data.quota');
	assert.strictEqual(saved.balanceDivisor, 1, '保存保留 divisor 1，不回退 500000');
	assert.strictEqual(saved.currency, 'USD', '保存保留 currency USD');
	assert.strictEqual(saved.balanceKind, undefined, '客户端不写 balanceKind（由服务端按相同字段保留）');
	const localPlatform = plain(JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms['stale-credits']);
	assert.deepStrictEqual([localPlatform.balancePath, localPlatform.currency, localPlatform.balanceDivisor], ['', '', null],
		'本地档案仍不落 Host 运行时默认值');
	assert.strictEqual(localPlatform.endpoint, 'https://credits.example.com/api/balance', '本地档案记录已探测地址');
	console.log('      空快照→后台探测 credits→打开强制刷新→自动保存：保留 endpoint/$.balance/1/USD');
}

/* ====================================================================
   ③-7 刷新尚未返回时立即点外部保存的竞态（task-33）
   ==================================================================== */
console.log('\n===== ③-7 刷新未返回即点外部保存：不用旧空快照覆盖自动探测结果 =====');
{
	let hostList = [];
	const posts = [];
	const creditChannel = {
		channelKey: 'race-credits',
		endpoint: 'https://credits.example.com/api/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: '$.balance',
		currency: 'USD',
		feeMultiplier: 1,
		balanceDivisor: 1,
		balanceKind: 'credits',
		tokenConfigured: true,
		userIdConfigured: true
	};
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') === -1) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
		}
		if (init !== undefined && init !== null && init.method === 'POST') {
			posts.push(JSON.parse(init.body));
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: hostList }) });
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: { 'race-credits': plain(emptyPlatform) } });
	await api.ensureRelayState();  /* 客户端加载“空快照” */
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const headOf = (name) => findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0];
	/* 服务端后台自动探测完成：Host 快照出现 credits channel，而客户端仍是旧空快照 */
	hostList = [ JSON.parse(JSON.stringify(creditChannel)) ];
	/* 打开平台：触发强制刷新，但**不等待 GET 返回** */
	headOf('race-credits').props.onClick();
	rerender();
	/* 刷新尚未返回就立即点头部保存（= 点外部 pointerdown 自动保存的同一 savePlatform 路径） */
	const before = posts.length;
	headOf('race-credits').props.onClick();
	await settle();
	rerender();
	const saved = posts[posts.length - 1];
	assert.strictEqual(posts.length, before + 1, '竞态下仍只发一条保存 POST');
	assert.strictEqual(saved.endpoint, 'https://credits.example.com/api/balance', '竞态保存不发送空 endpoint（不覆盖 Host 已探测地址）');
	assert.strictEqual(saved.balancePath, '$.balance', '竞态保存保留 $.balance，不回退 data.quota');
	assert.strictEqual(saved.balanceDivisor, 1, '竞态保存保留 divisor 1，不回退 500000');
	assert.strictEqual(saved.currency, 'USD', '竞态保存保留 currency USD');
	assert.strictEqual(saved.balanceKind, undefined, '竞态保存不写 balanceKind（服务端按相同字段保留 credits）');
	const local = plain(JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms['race-credits']);
	assert.deepStrictEqual([local.balancePath, local.currency, local.balanceDivisor], ['', '', null], '本地仍不落 Host 默认');
	assert.strictEqual(local.endpoint, 'https://credits.example.com/api/balance', '本地记录已探测地址');
	console.log('      刷新未回→立即保存：仍保留 endpoint/$.balance/1/USD（未用空快照覆盖）');
}

/* ====================================================================
   ③-8 强制刷新 GET 失败：不发送 fallback，交给 Host existing 合并（task-35）
   ==================================================================== */
console.log('\n===== ③-8 强制刷新 GET 失败：不发 fallback，Host existing 保留自动探测 =====');
{
	let hostChannel = null;            /* Host 服务端已有（自动探测）credits channel，客户端起初不知道 */
	const failGet = { on: false };
	const posts = [];
	const creditsChannel = {
		channelKey: 'failing-credits',
		endpoint: 'https://credits.example.com/api/balance',
		tokenHeader: 'authorization',
		userIdHeader: 'New-Api-User',
		tokenPrefix: 'Bearer ',
		balancePath: '$.balance',
		currency: 'USD',
		feeMultiplier: 1,
		balanceDivisor: 1,
		balanceKind: 'credits',
		tokenConfigured: true,
		userIdConfigured: true
	};
	/* 模拟 Host updateRelayConfig 的 existing 合并：payload 未提供的字段沿用现有配置。 */
	const hostMerge = (body) => {
		const existing = hostChannel === null ? {} : hostChannel;
		const pick = (key, fallback) => body[key] === undefined ? (existing[key] === undefined ? fallback : existing[key]) : body[key];
		const next = {
			channelKey: body.channelKey,
			endpoint: pick('endpoint', ''),
			tokenHeader: pick('tokenHeader', 'authorization'),
			userIdHeader: pick('userIdHeader', 'x-user-id'),
			tokenPrefix: pick('tokenPrefix', 'Bearer '),
			balancePath: pick('balancePath', '$.balance'),
			currency: pick('currency', 'CNY'),
			balanceDivisor: pick('balanceDivisor', 1),
			balanceKind: pick('balanceKind', undefined),
			feeMultiplier: 1,
			tokenConfigured: body.token === undefined ? (existing.tokenConfigured === true) : body.token !== '',
			userIdConfigured: body.userId === undefined ? (existing.userIdConfigured === true) : body.userId !== ''
		};
		hostChannel = next;
		return next;
	};
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') === -1) return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
		if (init !== undefined && init !== null && init.method === 'POST') {
			const body = JSON.parse(init.body);
			posts.push(body);
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: [hostMerge(body)] }) });
		}
		if (failGet.on === true) return Promise.reject(new Error('relay-config GET failed'));
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: hostChannel === null ? [] : [hostChannel] }) });
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: { 'failing-credits': plain(emptyPlatform) } });
	await api.ensureRelayState();   /* 客户端读到“空快照”（Host 此刻返回空） */
	/* Host 后台自动探测出 credits；随后编辑时的强制 GET 失败 */
	hostChannel = JSON.parse(JSON.stringify(creditsChannel));
	failGet.on = true;
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const headOf = (name) => findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0];
	headOf('failing-credits').props.onClick();  /* 打开：触发强制刷新（将失败） */
	await settle();
	rerender();
	/* 未编辑，直接保存（点头部 = savePlatform） */
	const before = posts.length;
	headOf('failing-credits').props.onClick();
	await settle();
	rerender();
	const post = posts[posts.length - 1];
	assert.strictEqual(posts.length, before + 1, '刷新失败时未编辑保存仍发一条 POST');
	assert.strictEqual('endpoint' in post, false, '刷新失败：POST 不发送 endpoint（不覆盖 Host 已探测地址）');
	assert.strictEqual('balancePath' in post, false, '刷新失败：POST 不发送 balancePath');
	assert.strictEqual('currency' in post, false, '刷新失败：POST 不发送 currency');
	assert.strictEqual('balanceDivisor' in post, false, '刷新失败：POST 不发送 balanceDivisor');
	assert.strictEqual('balanceKind' in post, false, '刷新失败：客户端也不写 balanceKind');
	assert.strictEqual(hostChannel.endpoint, 'https://credits.example.com/api/balance', 'Host existing merge 保留 endpoint');
	assert.strictEqual(hostChannel.balancePath, '$.balance', 'Host existing merge 保留 balancePath');
	assert.strictEqual(hostChannel.currency, 'USD', 'Host existing merge 保留 currency');
	assert.strictEqual(hostChannel.balanceDivisor, 1, 'Host existing merge 保留 divisor');
	assert.strictEqual(hostChannel.balanceKind, 'credits', 'Host existing merge 保留 balanceKind=credits（解析逻辑不变）');
	const local = plain(JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms['failing-credits']);
	assert.deepStrictEqual([local.balancePath, local.currency, local.balanceDivisor], ['', '', null], '本地仍不落 runtime 默认值');
	console.log('      GET 失败→未编辑保存：不发 fallback，Host existing 保留 endpoint/$.balance/USD/1/credits');
}

/* ====================================================================
   ③-9 stale-empty-channel / 本地显式 parser 对照（task-37）
   ==================================================================== */
console.log('\n===== ③-9 快照已有空 endpoint channel：GET 失败保存不覆盖；本地显式保留 =====');
{
	/* 模拟“客户端已加载一个 endpoint='' 的 channel” + “服务端后台已探测 credits” + “打开时 GET 失败”。 */
	const buildScenario = (opts) => {
		const st = { snapshot: opts.snapshot, server: opts.server, fail: false, posts: [] };
		const hostMerge = (body) => {
			const existing = st.server === null ? {} : st.server;
			const pick = (key, fallback) => body[key] === undefined ? (existing[key] === undefined ? fallback : existing[key]) : body[key];
			const parseProvided = body.balancePath !== undefined || body.balanceDivisor !== undefined;
			const next = {
				channelKey: body.channelKey,
				endpoint: pick('endpoint', ''),
				tokenHeader: pick('tokenHeader', 'authorization'),
				userIdHeader: pick('userIdHeader', 'x-user-id'),
				tokenPrefix: pick('tokenPrefix', 'Bearer '),
				balancePath: pick('balancePath', '$.balance'),
				currency: pick('currency', 'CNY'),
				balanceDivisor: pick('balanceDivisor', 1),
				balanceKind: parseProvided ? undefined : pick('balanceKind', undefined),
				feeMultiplier: 1,
				tokenConfigured: body.token === undefined ? existing.tokenConfigured === true : body.token !== '',
				userIdConfigured: body.userId === undefined ? existing.userIdConfigured === true : body.userId !== ''
			};
			st.server = next;
			return next;
		};
		const inst = loadClient((url, init) => {
			if (String(url).indexOf('/api/relay-balance-config') === -1) return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
			if (init !== undefined && init !== null && init.method === 'POST') {
				const body = JSON.parse(init.body);
				st.posts.push(body);
				return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: [hostMerge(body)] }) });
			}
			if (st.fail === true) return Promise.reject(new Error('relay-config GET failed'));
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: st.snapshot }) });
		});
		return { inst: inst, st: st };
	};
	const mountScenario = async (sc, platformName, localPlatform) => {
		const api = sc.inst.api;
		const t = translator(api);
		api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: { [platformName]: plain(localPlatform) } });
		await api.ensureRelayState();   /* 客户端先加载快照（此时 snapshot 里已有一个 endpoint='' 的 channel） */
		sc.st.fail = true;              /* 之后编辑时强制 GET 失败 */
		const props = { t: t, useProjection: () => undefined };
		const bucket = sc.inst.hooks();
		const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
		const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
		const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
		const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
		const headOf = (name) => findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0];
		headOf(platformName).props.onClick();   /* 打开：触发强制刷新（GET 失败） */
		await settle();
		rerender();
		const before = sc.st.posts.length;
		headOf(platformName).props.onClick();   /* 未编辑直接保存 */
		await settle();
		rerender();
		return { api: api, t: t, posts: sc.st.posts, before: before };
	};
	/* 场景 A：本地空，Host existing 应保留 credits endpoint / 解析字段 / balanceKind。 */
	{
		const emptyChannelSnap = {
			channelKey: 'stale-empty', endpoint: '', tokenHeader: 'authorization', userIdHeader: '',
			tokenPrefix: 'Bearer ', balancePath: '$.balance', currency: 'CNY', balanceDivisor: 1,
			tokenConfigured: true, userIdConfigured: false
		};
		const sc = buildScenario({
			snapshot: [ JSON.parse(JSON.stringify(emptyChannelSnap)) ],
			server: { channelKey: 'stale-empty', endpoint: 'https://credits.example.com/api/balance', tokenHeader: 'authorization', userIdHeader: 'New-Api-User', tokenPrefix: 'Bearer ', balancePath: '$.balance', currency: 'USD', balanceDivisor: 1, balanceKind: 'credits', feeMultiplier: 1, tokenConfigured: true, userIdConfigured: true }
		});
		const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
		const run = await mountScenario(sc, 'stale-empty', emptyPlatform);
		const post = run.posts[run.posts.length - 1];
		assert.strictEqual(run.posts.length, run.before + 1, 'A：未编辑保存仍发一条 POST');
		assert.strictEqual('endpoint' in post, false, 'A：snapshot 已有空 channel（GET 失败）→ POST 不发 endpoint，交给 existing 合并');
		assert.strictEqual('balancePath' in post, false, 'A：POST 不发 balancePath');
		assert.strictEqual('currency' in post, false, 'A：POST 不发 currency');
		assert.strictEqual('balanceDivisor' in post, false, 'A：POST 不发 balanceDivisor');
		const serverA = sc.st.server;
		assert.strictEqual(serverA.endpoint, 'https://credits.example.com/api/balance', 'A：existing merge 保留 endpoint');
		assert.strictEqual(serverA.balancePath, '$.balance', 'A：保留 balancePath');
		assert.strictEqual(serverA.currency, 'USD', 'A：保留 currency');
		assert.strictEqual(serverA.balanceDivisor, 1, 'A：保留 divisor');
		assert.strictEqual(serverA.balanceKind, 'credits', 'A：保留 balanceKind=credits');
		const localA = plain(JSON.parse(sc.inst.store.get(run.api.STORAGE_KEY)).relayPlatforms['stale-empty']);
		assert.deepStrictEqual([localA.balancePath, localA.currency, localA.balanceDivisor], ['', '', null], 'A：本地仍不落 runtime 默认值');
		console.log('      A 快照已有空 channel→GET失败保存：不发 fallback，existing 保留 credits endpoint/kind');
	}
	/* 场景 B：本地已有显式 header / parser，必须照常发给 Host（不被 omit 丢掉）。 */
	{
		const emptyChannelSnap = {
			channelKey: 'explicit-local', endpoint: '', tokenHeader: 'authorization', userIdHeader: '',
			tokenPrefix: 'Bearer ', balancePath: '', currency: '', balanceDivisor: null,
			tokenConfigured: true, userIdConfigured: false
		};
		const sc = buildScenario({
			snapshot: [ JSON.parse(JSON.stringify(emptyChannelSnap)) ],
			server: { channelKey: 'explicit-local', endpoint: 'https://credits.example.com/api/balance', tokenHeader: 'authorization', userIdHeader: 'New-Api-User', tokenPrefix: 'Bearer ', balancePath: '$.balance', currency: 'USD', balanceDivisor: 1, balanceKind: 'credits', feeMultiplier: 1, tokenConfigured: true, userIdConfigured: true }
		});
		const explicitLocal = { endpoint: '', tokenHeader: 'authorization', userIdHeader: 'X-Custom-User', balancePath: 'data.custom', currency: 'CNY', balanceDivisor: 2, models: [] };
		const run = await mountScenario(sc, 'explicit-local', explicitLocal);
		const post = run.posts[run.posts.length - 1];
		assert.strictEqual('endpoint' in post, false, 'B：仍不发送 endpoint（本地地址空、未更改）');
		assert.strictEqual(post.userIdHeader, 'X-Custom-User', 'B：本地显式请求头必须照常发出（不丢配置）');
		assert.strictEqual(post.balancePath, 'data.custom', 'B：本地显式 balancePath 必须照常发出');
		assert.strictEqual(post.currency, 'CNY', 'B：本地显式 currency 必须照常发出');
		assert.strictEqual(post.balanceDivisor, 2, 'B：本地显式 divisor 必须照常发出');
		const serverB = sc.st.server;
		assert.strictEqual(serverB.endpoint, 'https://credits.example.com/api/balance', 'B：endpoint 仍由 existing 保留');
		assert.strictEqual(serverB.balancePath, 'data.custom', 'B：显式 parser 已写入 Host');
		assert.strictEqual(serverB.currency, 'CNY', 'B：显式 currency 已写入 Host');
		assert.strictEqual(serverB.balanceDivisor, 2, 'B：显式 divisor 已写入 Host');
		const localB = plain(JSON.parse(sc.inst.store.get(run.api.STORAGE_KEY)).relayPlatforms['explicit-local']);
		assert.deepStrictEqual([localB.userIdHeader, localB.balancePath, localB.currency, localB.balanceDivisor], ['X-Custom-User', 'data.custom', 'CNY', 2], 'B：本地显式配置保留');
		console.log('      B 本地显式 header/parser→GET失败保存：照常发送，不丢配置');
	}
}

/* ====================================================================
   ③-10 首次 GET 也未成功（无快照）：GET 一直失败时保存仍交给 Host existing（task-39）
   ==================================================================== */
console.log('\n===== ③-10 首次 GET 从未成功、无快照：GET 一直失败保存仍保留 Host 自动探测 =====');
{
	/* Host 服务端已有 credits channel；客户端连首次 ensure GET 都失败，从未拿到任何快照。 */
	let serverChannel = {
		channelKey: 'never-loaded',
		endpoint: 'https://credits.example.com/api/balance',
		tokenHeader: 'authorization', userIdHeader: 'New-Api-User', tokenPrefix: 'Bearer ',
		balancePath: '$.balance', currency: 'USD', balanceDivisor: 1, balanceKind: 'credits',
		feeMultiplier: 1, tokenConfigured: true, userIdConfigured: true
	};
	const posts = [];
	const hostMerge = (body) => {
		const existing = serverChannel;
		const pick = (key, fallback) => body[key] === undefined ? (existing[key] === undefined ? fallback : existing[key]) : body[key];
		const parseProvided = body.balancePath !== undefined || body.balanceDivisor !== undefined;
		const next = {
			channelKey: body.channelKey,
			endpoint: pick('endpoint', ''),
			tokenHeader: pick('tokenHeader', 'authorization'),
			userIdHeader: pick('userIdHeader', 'x-user-id'),
			tokenPrefix: pick('tokenPrefix', 'Bearer '),
			balancePath: pick('balancePath', '$.balance'),
			currency: pick('currency', 'CNY'),
			balanceDivisor: pick('balanceDivisor', 1),
			balanceKind: parseProvided ? undefined : pick('balanceKind', undefined),
			feeMultiplier: 1,
			tokenConfigured: body.token === undefined ? true : body.token !== '',
			userIdConfigured: body.userId === undefined ? true : body.userId !== ''
		};
		serverChannel = next;
		return next;
	};
	const inst = loadClient((url, init) => {
		if (String(url).indexOf('/api/relay-balance-config') === -1) return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
		if (init !== undefined && init !== null && init.method === 'POST') {
			const body = JSON.parse(init.body);
			posts.push(body);
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, channels: [hostMerge(body)] }) });
		}
		return Promise.reject(new Error('relay-config GET always fails'));
	});
	const api = inst.api;
	const t = translator(api);
	const emptyPlatform = { endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '', currency: '', balanceDivisor: null, models: [] };
	api.setConfig({ models: CNY_BASE, modelOrder: ['deepseek-flash'], priceConfigured: true, relayPlatforms: { 'never-loaded': plain(emptyPlatform) } });
	await api.ensureRelayState();   /* 首次 GET reject：从未拿到快照 */
	const props = { t: t, useProjection: () => undefined };
	const bucket = inst.hooks();
	const state = { bucket: bucket, tree: withHooks(bucket, () => api.SettingsSection(props)) };
	const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
	const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
	const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
	const headOf = (name) => findAll(platformRow(name), (node) => hasClass(node, 'dsb-platform-head'))[0];
	headOf('never-loaded').props.onClick();   /* 打开：强制 refresh 也 reject */
	await settle();
	rerender();
	const before = posts.length;
	headOf('never-loaded').props.onClick();   /* 未编辑直接保存 */
	await settle();
	rerender();
	const post = posts[posts.length - 1];
	assert.strictEqual(posts.length, before + 1, '首次 GET 也失败时未编辑保存仍发一条 POST');
	assert.strictEqual('endpoint' in post, false, '无快照+GET失败：不发 endpoint，交给 existing 合并');
	assert.strictEqual('balancePath' in post, false, '不发 balancePath');
	assert.strictEqual('currency' in post, false, '不发 currency');
	assert.strictEqual('balanceDivisor' in post, false, '不发 balanceDivisor');
	assert.strictEqual(serverChannel.endpoint, 'https://credits.example.com/api/balance', 'Host existing merge 保留 endpoint');
	assert.strictEqual(serverChannel.balancePath, '$.balance', '保留 balancePath');
	assert.strictEqual(serverChannel.currency, 'USD', '保留 currency');
	assert.strictEqual(serverChannel.balanceDivisor, 1, '保留 divisor');
	assert.strictEqual(serverChannel.balanceKind, 'credits', '保留 balanceKind=credits');
	const local = plain(JSON.parse(inst.store.get(api.STORAGE_KEY)).relayPlatforms['never-loaded']);
	assert.deepStrictEqual([local.balancePath, local.currency, local.balanceDivisor], ['', '', null], '本地仍不落 runtime 默认值');
	console.log('      首次 GET 也失败+无快照：未编辑保存不发 fallback，Host existing 保留 credits');
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
	assert.strictEqual(totalText(api, debtSrc, t), '总计 -', '无价时总计给横杠');
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

/* ====================================================================
   ⑧ Host：空白 endpoint 保存为空（不预填默认地址），token/userId 仍保存
   ==================================================================== */
console.log('\n===== ⑧ Host 空白 endpoint 保持为空 =====');
{
	const HOST_TMP = path.join(__dirname, '.tmp-host-relay-settings');
	const source = hostLib.prepare(HOST_TMP, ['updateRelayConfig', 'readRelayConfig']);
	try {
		const host = await hostLib.loadHost(source, 'relay-default-endpoint');
		const secrets = new Map();
		const credentials = {
			resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : null),
			set: async (ref, value) => { secrets.set(ref, value); },
			unset: async (ref) => { secrets.delete(ref); }
		};
		const settings = {
			describe: () => [{
				ns: 'include:llm-pi-ai',
				value: { providers: { orbi: { baseURL: 'https://orbi.example/v1' } } }
			}]
		};
		const ctx = {
			credentials: credentials,
			get: (name) => name === 'settings' ? settings : (name === 'credentials' ? credentials : undefined)
		};
		const saved = await host.updateRelayConfig(ctx, {
			channelKey: 'orbi', endpoint: '', token: 'orbi-token-sentinel', userId: 'orbi-user-sentinel',
			userIdHeader: 'New-Api-User', balancePath: 'data.quota', currency: 'CNY', balanceDivisor: 500000, feeMultiplier: 1
		});
		assert.strictEqual(saved.status, 200, '空白 endpoint + token/userId 保存成功');
		const channel = host.readRelayConfig().channels.find((one) => one.channelKey === 'orbi');
		assert.ok(channel !== undefined, 'orbi 平台档案已写入');
		assert.strictEqual(channel.endpoint, '', '地址为空就保持空（不预填 /api/user/self）');
		assert.strictEqual(secrets.size, 1, 'token/userId 已写入凭据服务');
		const envelope = JSON.parse(Array.from(secrets.values())[0]);
		assert.strictEqual(envelope.token, 'orbi-token-sentinel', 'token 已保存');
		assert.strictEqual(envelope.userId, 'orbi-user-sentinel', 'userId 已保存');
		/* 没有 provider baseURL 时不能因为地址空就拒绝保存/清空 */
		const noBase = await host.updateRelayConfig(ctx, { channelKey: 'no-base', endpoint: '', token: 'no-base-token', userId: 'no-base-user' });
		assert.strictEqual(noBase.status, 200, '没有 provider baseURL 也能保存');
		const noBaseChannel = host.readRelayConfig().channels.find((one) => one.channelKey === 'no-base');
		assert.ok(noBaseChannel !== undefined, '无 baseURL 的平台档案保留');
		assert.strictEqual(noBaseChannel.endpoint, '', '没有 provider baseURL 时 endpoint 也保持空');
		console.log('      空白 endpoint：保存为空；token/userId 仍保存');
	} finally {
		hostLib.cleanup(HOST_TMP);
	}
}

	/* ====================================================================
	   ③-5 打开已有平台编辑区不自动滚动（task-14）；加模型行仍自动露出
	   ==================================================================== */
	console.log('\n===== ③-5 打开已有平台：scrollTop 不变；加模型行仍露出 =====');
	{
		const scroller = {
			__overflowY: 'auto', scrollHeight: 2000, clientHeight: 500, scrollTop: 300, parentElement: null,
			getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 100, width: 900, height: 500 })
		};
		const platformNode = {
			parentElement: scroller,
			getBoundingClientRect: () => ({ left: 0, top: 200, right: 900, bottom: 600, width: 900, height: 400 })
		};
		const inst = loadClient(undefined, undefined, { dom: { platformNode: platformNode } });
		const api = inst.api;
		const t = translator(api);
		const props = { t: t, useProjection: () => undefined };
		const state = { bucket: inst.hooks(), tree: null };
		const rerender = () => { state.tree = withHooks(state.bucket, () => api.SettingsSection(props)); };
		const section = () => findAll(state.tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
		const platformRow = (name) => findAll(section(), (node) => hasClass(node, 'dsb-model') && node.props.key === name)[0];
		const platformHead = (name) => findAll(platformRow(name), (one) => hasClass(one, 'dsb-platform-head'))[0];
		rerender();
		/* 新建平台并落库（addPlatform 即写 config）；随后点头部 = 打开已有平台编辑区 */
		const nameInput = findAll(section(), (node) => node.type === 'input' && node.props.placeholder === t('platformNewPh'))[0];
		nameInput.props.onChange({ target: { value: 'existing-relay' } });
		rerender();
		buttonsByLabel(section(), t('platformAdd'))[0].props.onClick();
		rerender();
		assert.ok(platformRow('existing-relay') !== undefined, '前置：平台行已存在（已落库）');
		/* 用户原本滚到某个位置：打开编辑区不得把它挪走 */
		scroller.scrollTop = 300;
		platformHead('existing-relay').props.onClick();
		rerender();
		assert.strictEqual(findAll(platformRow('existing-relay'), (node) => hasClass(node, 'dsb-platform-pop')).length, 1, '前置：编辑区已打开');
		assert.strictEqual(scroller.scrollTop, 300, '打开已有平台编辑区不得滚动（scrollTop 必须保持原值）');
		/* 保留原行为：点「添加模型」新增行后仍把编辑区底边带进视野 */
		buttonsByLabel(platformRow('existing-relay'), t('platformAddModel'))[0].props.onClick();
		rerender();
		assert.ok(scroller.scrollTop > 300, '新增模型行仍应把编辑区底边带进视野（保留原露出行为）');
		console.log('      打开已有平台 scrollTop 保持不变（300）；加模型行后自动露出（' + scroller.scrollTop + '）');
	}

console.log('\n全部通过');
}

main().finally(() => {
	try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch (error) { /* best effort */ }
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
