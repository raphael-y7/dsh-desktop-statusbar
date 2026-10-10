/**
 * client / host 价格实现的**差分测试**：同一批输入，两侧必须逐例给出相同结果。
 *
 * 为什么要它：底栏按 `lib/client.js` 的价算、活跃总览按 `lib/index.js` 的价算，两份实现
 * （客户端不能加载本地文件，没法共用一份代码）一旦哪边改了、另一边忘了，同一个模型在两处
 * 会显示两个价钱。所以这里不写死期望值，只断言"两侧逐例相等"。
 *
 * 覆盖：
 *   · `normalizeModels`(client) ↔ `sanitizePriceBook`(host)：哪些键活下来、逐格 null/数字、
 *     两档互相补全、`tiered` 标记 —— 形状必须完全一致；
 *   · `priceIsBlank` / `hasAnyPriceValue`：同一批条目两侧结论一致
 *     （client 吃原始条目、host 吃它门口 sanitize 后的产物，各自走自己的真实管线）；
 *   · `pickPriceKey`：同一价格库 × 同一批模型名（含大小写变体、带数字键、带版本号、
 *     子串/词元档、两轮兜底、空键、全 null 条目）逐例给出同一个键名；
 *   · `fingerprintOf`：client 规范化后的库与 host 门口的产物算出同一个指纹；
 *     指纹往返（`parseFingerprint` → `fingerprintOf`）必须回到原串。
 *
 * 随机部分用固定 seed（可复现）：任何一例不等就打印该例（价格库、模型名、两侧结果）并失败。
 *
 * 三条"已知边界"（两侧口径确实不同，但**线上不会出现**，所以不参与差分；留档防止误判）：
 *   ① 空键：client 的存储里留得住（`normalizeModels` 保留 `""` 这个键），但匹配时两侧都不参选
 *      （client 的 `matchPriceKeyOnce` 要求 `key.length > 0`，host 在 `sanitizePriceBook` 门口直接丢）；
 *   ② 整条两档皆 null/缺省：client 规范化后保留成"八格全 null"的条目，host 丢整条 ——
 *      client POST 出去的是 `normalizeModels` 之后的形态（两档一律是对象），那种原始形态传不过去；
 *   ③ 非法格（非数字字符串 / NaN / Infinity）：client 载入时就归一成 `null`，host 的 `numOrZero`
 *      会把它压成 0 —— 差异同样只存在于"原始形态"，POST 的是 JSON，host 永远收不到这些值。
 *
 * 全程只用隔离 DSH_HOME（tests/.dsh-test-home-parity），不碰真实 ~/.dsh/dsh-status-bar/。
 * 用法：node tests/verify-price-parity.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const hostLib = require('./_host-lib.js');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
/* host 侧要直接调内部函数：把 lib/ 复制到 tests/ 下的临时目录再 patch 导出（见 _host-lib.js），用完删掉。 */
const TMP = path.join(__dirname, '.dsh-test-home-parity-lib');
const HOME = path.join(__dirname, '.dsh-test-home-parity');
const HOST_EXPORTS = ['sanitizePriceBook', 'fingerprintOf', 'parseFingerprint', 'pickPriceKey',
	'priceIsBlank', 'hasAnyPriceValue', 'tokenCost', 'modelNameTokens', 'tokenMatches'];

globalThis.setInterval = () => 0;
process.env.DSH_HOME = HOME;   /* 只 import 纯函数、不调 apply()，但按惯例仍隔离 */

const SEED = 20261009;
const BOOKS = 3000;

/* ---------------------------------------------------------------- client 侧（vm 载入） */
function loadClient() {
	let code = fs.readFileSync(CLIENT, 'utf8');
	const marker = '\t\texports.apply = apply;';
	assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
	code = code.replace(marker,
		'\t\texports.__test = { modelTokens, tokenMatches, priceIsBlank, hasAnyPriceValue, pickPriceKey, normalizeModels, normalizePrice, normalizeTier, tierValue, isTiered };\n' + marker);

	const fakeWindow = {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		setInterval: () => 0, clearInterval: () => {},
		setTimeout: () => 0, clearTimeout: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
	const sandbox = {
		window: fakeWindow,
		document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
		setTimeout: () => 0, clearTimeout: () => {}
	};
	sandbox.globalThis = sandbox;
	const reactStub = {
		createElement: (type, props, ...children) => ({ type: type, props: props === null || props === undefined ? {} : props, children: children }),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {}, useRef: (init) => ({ current: init === undefined ? null : init }),
		useSyncExternalStore: (subscribe, snapshot) => snapshot(),
		useCallback: (fn) => fn, useMemo: (fn) => fn(), Fragment: Symbol('Fragment')
	};
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	const api = captured.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
	assert.ok(api !== undefined, 'client __test 导出缺失');
	return api;
}

/* ---------------------------------------------------------------- 工具 */
/** 键序无关的规范化，用来把两侧对象压成可比字符串。 */
function canon(value) {
	if (Array.isArray(value)) return value.map(canon);
	if (value !== null && typeof value === 'object') {
		const out = {};
		Object.keys(value).sort().forEach((key) => { out[key] = canon(value[key]); });
		return out;
	}
	return value;
}
const show = (value) => JSON.stringify(canon(value));
const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
/** mulberry32：小巧的可复现随机源（失败时照 seed 复现同一批用例）。 */
function mulberry32(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_POOL = [
	'deepseek-flash', 'DeepSeek-Flash', 'DEEPSEEK-FLASH',
	'deepseek-v4-pro', 'deepseek-v4.1-pro', 'deepseek-v4.1-flash',
	'deepseek V41 fLaSh', 'deepseek-v4.1-flash-sg',
	'glm-5.3-flash', 'GLM-5.3-Flash', 'glm-53-flash',
	'1', 'v41', 'flash', 'seek-v4', 'my-model', 'zzz-unrelated'
];
const MODEL_POOL = [
	'deepseek-v4.1-flash-sg', 'deepseek V41 fLaSh', 'deepseek-v4-pro', 'deepseek-v4.1-pro',
	'DeepSeek-Flash', 'deepseek-flash', 'glm-5.3-flash', 'GLM-53-Flash', 'my-model', 'zzz-unrelated',
	'1', '', 'unrelated-model', 'deepseek-v41-flash', 'seek-v4', 'deepseek-v4.1-flash', 'Zzz-Unrelated'
];
const CELL_POOL = [null, '', 0, 0.02, 1, 2, 8, 27, '0', '5', '0.02', true, false];
const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

/** 造一个"线上可能出现"的原始价格库：条目一定带至少一档对象（两档全 null 的形态见"已知边界"）。 */
function makeBook(rand) {
	const book = {};
	const count = 1 + Math.floor(rand() * 4);
	for (let i = 0; i < count; i += 1) {
		const key = rand() < 0.15
			? 'k' + Math.floor(rand() * 1000)
			: KEY_POOL[Math.floor(rand() * KEY_POOL.length)];
		const entry = {};
		if (rand() < 0.5) entry.tiered = rand() < 0.5;
		const style = rand();
		const makeTier = () => {
			const tier = {};
			FIELDS.forEach((field) => {
				if (rand() < 0.18) return;                       /* 字段缺省 = 没填 */
				tier[field] = CELL_POOL[Math.floor(rand() * CELL_POOL.length)];
			});
			return tier;
		};
		if (style < 0.12) {
			entry.peak = {};                                     /* 全缺省档 → 八格全 null */
			entry.offPeak = makeTier();
		} else if (style < 0.24) {
			const zero = {};
			FIELDS.forEach((field) => { zero[field] = 0; });
			entry.peak = zero;                                   /* 明确填 0 */
			entry.offPeak = makeTier();
		} else if (style < 0.34) {
			const one = {};
			FIELDS.forEach((field) => { one[field] = null; });
			one.output = 5;                                      /* 只填一格 */
			entry.peak = one;
			entry.offPeak = {};
		} else if (style < 0.44) {
			entry.peak = makeTier();                             /* 只给一档，另一档缺省 */
		} else {
			entry.peak = makeTier();
			entry.offPeak = makeTier();
		}
		book[key] = entry;
	}
	if (rand() < 0.12) book[''] = { peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 } };
	return book;
}

let compared = 0;
const failures = [];
function compare(label, left, right, context) {
	compared += 1;
	if (left === right) return;
	if (failures.length < 5) {
		failures.push(label + '\n  client: ' + show(left) + '\n  host  : ' + show(right)
			+ '\n  用例  : ' + JSON.stringify(context));
	}
}
function compareJson(label, left, right, context) {
	compare(label, show(left), show(right), context);
}
/** 把一个价格库的两侧结论全部比一遍。 */
function compareBook(client, host, raw) {
	const context = { book: raw };
	const cBook = client.normalizeModels(clone(raw));
	const sanitized = host.sanitizePriceBook(clone(raw));
	const hBook = sanitized === null ? {} : sanitized;

	/* 形状：哪些键活下来、逐格的值、tiered 标记。
	   task-22 起 client 读配置时会**把入口的默认币种落成显式 `currency`**，而 host 的
	   `sanitizePriceBook` **不补**（没带就保持"没带"，见文件头第 ④ 条边界）——
	   比对前把两侧的 `currency` 都摘掉，这两条口径另有专门用例钉住。 */
	const cNames = Object.keys(cBook).filter((name) => name.length > 0).sort();
	const hNames = Object.keys(hBook).sort();
	compareJson('活下来的键', cNames, hNames, context);
	const shapeOf = (entry) => {
		if (entry === null || entry === undefined || typeof entry !== 'object') return entry;
		const copy = Object.assign({}, entry);
		delete copy.currency;
		return copy;
	};
	cNames.forEach((name) => {
		compareJson('条目形状 ' + JSON.stringify(name), shapeOf(cBook[name]), shapeOf(hBook[name]), context);
		/* 谓词：client 吃原始条目、host 吃它门口 sanitize 后的产物（各自真实管线） */
		compare('priceIsBlank ' + JSON.stringify(name),
			client.priceIsBlank(raw[name]), host.priceIsBlank(hBook[name]), context);
		compare('hasAnyPriceValue ' + JSON.stringify(name),
			client.hasAnyPriceValue(raw[name]), host.hasAnyPriceValue(hBook[name]), context);
	});
	/* 匹配：同一批模型名逐例比命中的键 */
	MODEL_POOL.forEach((model) => {
		compare('pickPriceKey ' + JSON.stringify(model),
			client.pickPriceKey(cBook, model), host.pickPriceKey(hBook, model), context);
	});
	/* 指纹：client 规范化后（去掉 host 门口会丢的空键）与 host 门口产物必须算成同一串 */
	const withoutEmpty = {};
	Object.keys(cBook).forEach((name) => { if (name.length > 0) withoutEmpty[name] = cBook[name]; });
	const fingerprint = host.fingerprintOf(hBook);
	compare('指纹', host.fingerprintOf(withoutEmpty), fingerprint, context);
	/* 往返：指纹 → 价格库 → 指纹，必须回到原串 */
	compare('指纹往返', host.fingerprintOf(host.parseFingerprint(fingerprint)), fingerprint, context);
}

(async () => {
	const client = loadClient();
	const hostSource = hostLib.prepare(TMP, HOST_EXPORTS);
	let host = null;
	try {
		host = await hostLib.loadHost(hostSource, 'parity');
		['sanitizePriceBook', 'pickPriceKey', 'priceIsBlank', 'hasAnyPriceValue', 'fingerprintOf', 'parseFingerprint']
			.forEach((name) => assert.strictEqual(typeof host[name], 'function', 'host 未导出 ' + name));

		/* ------------------------------------------------ 0. 词元切分：两侧同一个口径 */
		const nameSamples = KEY_POOL.concat(MODEL_POOL).concat(['DeepSeek-V4.1-Flash-SG', 'a--b__c.d e']);
		nameSamples.forEach((name) => {
			compareJson('词元 ' + JSON.stringify(name), client.modelTokens(name), host.modelNameTokens(name), { name: name });
			compareJson('词元比较 ' + JSON.stringify(name), client.tokenMatches(name, name), host.tokenMatches(name, name), { name: name });
		});
		console.log('0 词元切分：' + nameSamples.length + ' 个名字两侧一致');

		/* ------------------------------------------------ 1. 固定用例（不依赖随机源，保证覆盖） */
		const PINNED = [
			{ keys: { 'deepseek-flash': { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } } }, models: ['deepseek-v4.1-flash-sg', 'deepseek V41 fLaSh'] },
			{ keys: { 'deepseek-v4-pro': { peak: { input: 3, cacheRead: 0, cacheWrite: 0, output: 3 }, offPeak: { input: 3, cacheRead: 0, cacheWrite: 0, output: 3 } }, 'deepseek-v4.1-pro': { peak: { input: 9, cacheRead: 0, cacheWrite: 0, output: 9 }, offPeak: { input: 9, cacheRead: 0, cacheWrite: 0, output: 9 } } }, models: ['deepseek-v4.1-pro', 'deepseek-v41-pro', 'deepseek-v4-pro'] },
			{ keys: { '1': { peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }, 'deepseek-flash': { peak: { input: 2, cacheRead: 0, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 4 } } }, models: ['deepseek-v4.1-flash-sg'] },
			{ keys: { '': { peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 } }, 'my-model': { peak: { input: null, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } } }, models: ['my-model', 'anything'] },
			{ keys: { 'GLM-5.3-Flash': { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } }, models: ['glm-5.3-flash', 'GLM-5.3-FLASH'] },
			{ keys: { 'my-model': { tiered: false, peak: { input: 0, cacheRead: null, cacheWrite: null, output: 5 }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } } }, models: ['my-model', 'MY-MODEL'] },
			{ keys: { 'seek-v4': { peak: { input: 4, cacheRead: 0, cacheWrite: 0, output: 4 }, offPeak: { input: 4, cacheRead: 0, cacheWrite: 0, output: 4 } }, 'deepseek-v4.1-flash': { peak: { input: null, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } } }, models: ['deepseek-v4.1-flash-sg'] }
		];
		PINNED.forEach((one, index) => {
			compareBook(client, host, one.keys);
			one.models.forEach((model) => {
				const cBook = client.normalizeModels(clone(one.keys));
				const hBook = host.sanitizePriceBook(clone(one.keys)) || {};
				compare('固定用例 ' + index + ' 命中 ' + JSON.stringify(model),
					client.pickPriceKey(cBook, model), host.pickPriceKey(hBook, model), one.keys);
			});
		});
		console.log('1 固定用例：' + PINNED.length + ' 组（含大小写、带数字键、空键、全 null、只填一格）两侧一致');

		/* ------------------------------------------------ 2. 随机差分 */
		const rand = mulberry32(SEED);
		for (let i = 0; i < BOOKS; i += 1) {
			compareBook(client, host, makeBook(rand));
			if (failures.length >= 5) break;
		}
		console.log('2 随机差分：seed=' + SEED + '，' + BOOKS + ' 个价格库 × '
			+ (MODEL_POOL.length + 2) + ' 项，两侧逐例比较');

		/* ------------------------------------------------ 3. 已知边界（线上不会出现的形态，显式记录） */
		/* ① 空键：client 的存储里留得住，但匹配时明确不参选；host 在门口直接丢掉 —— 行为一致。 */
		const emptyKeyBook = { '': { peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 } } };
		compare('空键：两侧都不命中', client.pickPriceKey(client.normalizeModels(emptyKeyBook), 'anything'),
			host.pickPriceKey(host.sanitizePriceBook(emptyKeyBook) || {}, 'anything'), emptyKeyBook);
		assert.strictEqual(host.sanitizePriceBook(emptyKeyBook), null, 'host 丢掉空键后整本为空 → null');
		/* ② 整条两档都是 null/缺省：client 规范化后保留成"八格全 null"的条目，host 丢整条。
		      线上不会出现 —— client POST 出去的是 `normalizeModels` 之后的形态，两档一律是对象。 */
		const bothNull = { x: { peak: null, offPeak: null } };
		const cBothNull = client.normalizeModels(bothNull);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(cBothNull.x)),
			{ tiered: true, currency: 'CNY', peak: { input: null, cacheRead: null, cacheWrite: null, output: null }, offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null } },
			'client 把两档皆 null 的条目保留成八格全 null（task-22 起还带入口默认币种 currency）');
		assert.strictEqual(host.sanitizePriceBook(bothNull), null, 'host 丢掉两档皆 null 的条目');
		assert.strictEqual(client.pickPriceKey(cBothNull, 'x'), null, '八格全 null 的条目两侧都不参选（client）');
		assert.strictEqual(host.pickPriceKey({}, 'x'), null, '八格全 null 的条目两侧都不参选（host）');
		/* ④ 币种（task-22）：client 读配置时把入口默认币种落成显式 `currency`；
		      host 的 `sanitizePriceBook` 只保留合法值、**不补默认** —— 有意的不对称，
		      好处是缺省条目二次往返不会凭空多出键（幂等）。 */
		const noCur = { x: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null } };
		assert.strictEqual(client.normalizeModels(noCur).x.currency, 'CNY', 'client 缺币种 ⇒ 落成入口默认 CNY');
		assert.strictEqual(host.sanitizePriceBook(noCur).x.currency, undefined, 'host 不给缺币种的条目补默认值');
		const usdCur = { x: { currency: 'USD', peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null } };
		assert.strictEqual(client.normalizeModels(usdCur).x.currency, 'USD', '显式 USD 原样保留（client）');
		assert.strictEqual(host.sanitizePriceBook(usdCur).x.currency, 'USD', '显式 USD 原样保留（host）');
		const junkCur = { x: { currency: 'JPY', peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null } };
		assert.strictEqual(client.normalizeModels(junkCur).x.currency, 'CNY', '非法币种回落 CNY（client）');
		assert.strictEqual(host.sanitizePriceBook(junkCur).x.currency, undefined, '非法币种 host 直接不带这个键');
		const once = host.sanitizePriceBook(noCur);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(host.sanitizePriceBook(once))), JSON.parse(JSON.stringify(once)),
			'host 二次往返幂等（缺省条目不凭空多出 currency）');
		/* ③ 非法输入（非数字字符串 / 非有限数）：client 载入时就归一成 null ——
		      host 的 `numOrZero` 会把它们压成 0，两侧口径不同，但**线上收不到**这种格：
		      client POST 的是 `normalizeModels` 之后的形态（只有 null 与数字）。这里把该前提锁住。 */
		['abc', NaN, Infinity, -Infinity, {}].forEach((bad) => {
			assert.strictEqual(client.tierValue(bad), null, 'client 把非法格归一成 null：' + String(bad));
		});
		const dirty = {
			x: {
				peak: { input: 'abc', cacheRead: NaN, cacheWrite: Infinity, output: {} },
				offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null }
			}
		};
		const cDirty = client.normalizeModels(dirty);
		FIELDS.forEach((field) => {
			const one = cDirty.x.peak[field];
			assert.ok(one === null || typeof one === 'number',
				'规范化后不许留下非法格：' + field + '=' + String(one));
		});
		console.log('3 已知边界：空键（两侧都不参选）· 两档皆 null（client 留成空条目、host 丢整条，线上不会出现）· 非法格 client 载入即归一');

		/* ------------------------------------------------ 结果 */
		console.log('4 共比较 ' + compared + ' 项；失败 ' + failures.length + ' 例');
		if (failures.length > 0) {
			console.error('\n===== 两侧结果不一致（前 ' + failures.length + ' 例）=====');
			failures.forEach((one, index) => console.error('[' + (index + 1) + '] ' + one));
		}
		assert.strictEqual(failures.length, 0, 'client 与 host 的价格实现必须逐例一致（见上方打印的用例）');
		console.log('');
		console.log('PRICE PARITY CHECKS PASSED（client / host 逐例一致）');
	} finally {
		hostLib.cleanup(TMP);
	}
})().catch((error) => {
	console.error('PRICE PARITY CHECKS FAILED: ' + (error && error.message ? error.message : error));
	process.exitCode = 1;
});
