/**
 * 「填了」与「没填」必须逐格区分：没填的格子存成 null、显示成空白；填了（哪怕填 0）才显示数字。
 *
 * 背景（用户实测反馈的两轮问题）：
 *   · 第一版把"没填"也转成 0 → 用户只填一格保存后，其余格被写成 0；
 *   · 加 `filled` 标记也不够 → 全清空再点「修改」又全是 0。
 * 现方案（`filled` 标记已撤销）：
 *   · 未填的格子保存为 `null`（EMPTY_TIER / normalizeTier / normalizePrice 的 flatten 都保留 null）；
 *   · `saveDraft`：逐格 `""`（没填）或非法输入 → null，否则存数字（填 0 就是 0）；两档全部没填 → 删除该条目（= 取消添加）；
 *   · `startEdit`：新建 → 全空；此外**唯一**的"整条没填过"判据 = 该条目所有格都是**数字 0**
 *     （旧版本遗留数据没有 null，分不清"没填"与"填了 0"，只能按没填过处理 → 显示空白）；
 *     **只要有一格是 null 就照实显示**（null → 空白，数字 → 数字）。
 * 另：只收窄**价格输入框**（`.dsb-settings .dsb-field input`）：高 24px、宽 52px（"够放 XX.XX 就行"）；
 * 通用 `.dsb-settings input[type=text]` / `input[type=number]` / `select` **仍是 28px**，
 * 按钮 `.dsb-action` 28px、编辑浮层 `.dsb-edit-pop` 保持 gap:8px / padding:10px 12px；
 * 单档价格行（没有档位名的那种）三组字段双边对齐，有档位名的两行仍整体贴右。
 * 这些"适用范围 / 保持原值"的口径都一并断言，防止以后改一处忘一处。
 *
 * 用法：node tests/verify-price-filled.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const INDEX = path.join(__dirname, '..', 'lib', 'index.js');
const HOME = path.join(__dirname, '.dsh-test-home-filled');

globalThis.setInterval = () => 0;
/* host 那段要隔离：先指到 tests/ 下的目录，别碰真实 ~/.dsh/dsh-status-bar/ */
process.env.DSH_HOME = HOME;

/* ============================================================ client 侧：设置页 harness */
const cssText = fs.readFileSync(PLUGIN, 'utf8');
let code = cssText;
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
code = code.replace(marker,
	'\t\texports.__test = { SettingsSection, STORAGE_KEY, priceIsBlank, pickPriceKey, normalizePrice, normalizeTier, tierValue, isLegacyZeroEntry, hasAnyPriceValue, linkedTierValue, priceOf, costOf, isPeakTime };\n' + marker);

const CONFIG_KEY = 'dsh.desktopStatusBar.v1';
const N4 = { input: null, cacheRead: null, cacheWrite: null, output: null };
const Z4 = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const store = new Map();
/* 手写价格库：覆盖"旧数据的全 0""只填一格""明确填 0""有价""用来清空"五种形态 */
store.set(CONFIG_KEY, JSON.stringify({
	/* priceVersion 给当前值（2）：否则 loadConfig 会并入内置参考价，把同名条目顶掉 */
	version: 6, priceVersion: 2, enabled: true, wrap: true, currency: 'CNY',
	models: {
		/* 旧版本遗留：四格全是数字 0（没有 null）⇒ 编辑时整栏空白 */
		'legacy-zeros': { tiered: true, peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) },
		/* 只填了 output=5 ⇒ 只有 output 显示 5，其余空白（不是 0） */
		'only-output': {
			tiered: false,
			peak: { input: null, cacheRead: null, cacheWrite: null, output: 5 },
			offPeak: Object.assign({}, N4)
		},
		/* 用户明确填了 0（其余没填 = null）⇒ 0 要显示出来 */
		'zero-real': {
			tiered: false,
			peak: { input: 0, cacheRead: null, cacheWrite: null, output: null },
			offPeak: Object.assign({}, N4)
		},
		/* 有价 ⇒ 照实回填（回归） */
		'paid-real': {
			tiered: false,
			peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
			offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
		},
		/* 勾了峰谷计价、两档不同价：给"单档 = 全天一个价"做对照 */
		'tiered-two': {
			tiered: true,
			peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
			offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
		},
		/* 用来验"全清空保存 = 删掉这条" */
		'clear-me': {
			tiered: false,
			peak: { input: 3, cacheRead: null, cacheWrite: null, output: null },
			offPeak: Object.assign({}, N4)
		}
	}
}));

const fakeWindow = {
	localStorage: {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, v); },
		removeItem: (k) => { store.delete(k); }
	},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) }),
	setInterval: () => 0, clearInterval: () => {},
	setTimeout: () => 0, clearTimeout: () => {},
	addEventListener: () => {}, removeEventListener: () => {},
	requestAnimationFrame: (fn) => { rafSeq += 1; rafQueue.set(rafSeq, fn); return rafSeq; },
	cancelAnimationFrame: (id) => { rafQueue.delete(id); },
	innerWidth: 1280, innerHeight: 800
};
/* task-19：底部自动滚入不再用 scrollIntoView，而是"找最近的可滚祖先 → 按底边差值加 scrollTop"，
   所以替身要给：滚动容器的假几何 + 浮层的假矩形。`POP.box` 可改，用来测"没被裁就不动"。 */
const MARGIN = 12;
const SCROLLER = {
	clientHeight: 300, scrollHeight: 900, _top: 0,
	get scrollTop() { return this._top; },
	set scrollTop(value) { this._top = value; scrollCalls += 1; scrollWrites.push(value); },
	getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300, left: 0, right: 100, width: 100 })
};
const POP = { box: { top: 100, bottom: 400, height: 300, left: 0, right: 100, width: 100 } };
/* task-21：币种菜单也走同一个钩子。菜单底边与"按钮"底边**故意不同**（420 vs 170），
   用来确保量的是菜单节点本身 —— 量错节点时滚动量会变成 0。 */
const MENU = {
	box: { top: 150, bottom: 420, height: 270, left: 0, right: 100, width: 100 },
	buttonBox: { top: 120, bottom: 170, height: 50, left: 0, right: 100, width: 100 }
};
let rafSeq = 0;
const rafQueue = new Map();
/** 手动跑掉排队中的 rAF 回调（复现"稳定后补滚一次"）。 */
function flushRaf() {
	const list = Array.from(rafQueue.values());
	rafQueue.clear();
	list.forEach((fn) => fn());
}
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
		head: { appendChild() {} },
		scrollingElement: SCROLLER,
		addEventListener: () => {}, removeEventListener: () => {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout: () => 0, clearTimeout: () => {}
};
sandbox.globalThis = sandbox;

/* hooks 替身：按组件分桶保存 state，点击后重新渲染就能读到最新值（同 tests/verify.js） */
let activeHooks = null;
function makeHooks() { return { values: [], index: 0 }; }
function withHooks(bucket, fn) {
	const prev = activeHooks;
	activeHooks = bucket;
	bucket.index = 0;
	try { return fn(); } finally { activeHooks = prev; }
}
function hookSlot(init) {
	if (activeHooks === null) return { get: () => undefined, set: () => {} };
	const bucket = activeHooks;
	const at = bucket.index;
	bucket.index += 1;
	if (bucket.values.length <= at) bucket.values[at] = typeof init === 'function' ? init() : init;
	return {
		get: () => bucket.values[at],
		set: (value) => { bucket.values[at] = typeof value === 'function' ? value(bucket.values[at]) : value; }
	};
}
/* 编辑浮层的滚动 effect 要能真跑：只挑"会调 revealBottom"的那个 effect 执行，
   别的 effect（拉活跃模型 / 点外部收起 / 拉假期）不跑，免得替身里触发异步 setState。 */
let pendingEffects = [];
let effectDeps = [];
let scrollCalls = 0;
const scrollWrites = [];
const reactStub = {
	createElement: (type, props, ...children) => {
		const node = {
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
		};
		const cls = typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
		if (cls.indexOf('dsb-edit-pop') !== -1) {
			node.getBoundingClientRect = () => POP.box;
			const box = node.props.ref;
			if (box !== null && typeof box === 'object') box.current = node;
		}
		/* task-21：币种菜单（ref 挂在**菜单节点**上，不是那个按钮） */
		if (cls.indexOf('dsb-select-menu') !== -1) {
			node.getBoundingClientRect = () => MENU.box;
			const box = node.props.ref;
			if (box !== null && typeof box === 'object') box.current = node;
		}
		return node;
	},
	useState: (init) => { const slot = hookSlot(init); return [slot.get(), slot.set]; },
	useEffect: (fn, deps) => { hookSlot(undefined); pendingEffects.push({ fn: fn, deps: deps }); },
	useRef: (init) => hookSlot({ current: init === undefined ? null : init }).get(),
	useSyncExternalStore: (subscribe, snapshot) => { hookSlot(undefined); return snapshot(); },
	useCallback: (fn) => { hookSlot(undefined); return fn; },
	useMemo: (fn) => { hookSlot(undefined); return fn(); },
	Fragment: Symbol('Fragment')
};
/** 按 React 的规矩比依赖：变了才跑（只跑滚动那个 effect，见上面注释）。 */
function flushEffects() {
	const next = [];
	pendingEffects.forEach((one, at) => {
		const deps = one.deps;
		const prev = effectDeps[at];
		const same = Array.isArray(deps) && Array.isArray(prev) && deps.length === prev.length
			&& deps.every((value, index) => value === prev[index]);
		next[at] = Array.isArray(deps) ? deps.slice() : undefined;
		if (same === true) return;
		if (String(one.fn).indexOf('revealBottom') === -1) return;
		one.fn();
	});
	effectDeps = next;
	pendingEffects = [];
}

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

/* 替身 i18n：只备断言要用到的几个键，其余回退成键名（不影响渲染路径） */
const DICT = {
	segCounts: '轮次＆步数', secPrices: '自定义模型价格',
	priceEdit: '修改', priceSave: '保存', priceRemove: '删除', priceAdd: '添加', priceNewModel: '自定义模型',
	priceTierAllDay: '全时段', priceTierPeak: '高峰时段', priceTierOffPeak: '空闲时段', priceTiered: '峰谷计价'
};
const t = (key, params) => {
	let out = DICT[key] !== undefined ? DICT[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return textOf(node.children);
}
function collectByClass(tree, className) {
	const out = [];
	(function walk(node) {
		if (node === null || node === undefined || typeof node !== 'object') return;
		if (Array.isArray(node)) { node.forEach(walk); return; }
		const cls = node.props === undefined ? undefined : node.props.className;
		if (typeof cls === 'string' && cls.split(' ').indexOf(className) !== -1) out.push(node);
		walk(node.children);
	})(tree);
	return out;
}
function findInput(node, type) {
	let found = null;
	(function walk(current) {
		if (found !== null || current === null || current === undefined || typeof current !== 'object') return;
		if (Array.isArray(current)) { current.forEach(walk); return; }
		if (current.type === 'input' && current.props.type === type) { found = current; return; }
		walk(current.children);
	})(node);
	return found;
}
const modelCards = (tree) => collectByClass(tree, 'dsb-model');
const cardByKey = (tree, key) => modelCards(tree).filter((card) => card.props.key === key)[0];
const buttonByLabel = (tree, label) => collectByClass(tree, 'dsb-action').filter((node) => textOf(node) === label)[0];
const fieldsOf = (card) => collectByClass(card, 'dsb-field').map((label) => findInput(label, 'number'));
const numberValues = (card) => fieldsOf(card).map((input) => input.props.value);
const savedModels = () => JSON.parse(store.get(CONFIG_KEY)).models;

const props = {
	t, useProjection: () => undefined, useSession: () => undefined,
	useSessions: () => undefined, useChat: () => undefined, sessionId: 'verify-filled'
};
const settingsHooks = makeHooks();
const renderSettings = () => {
	pendingEffects = [];
	const tree = withHooks(settingsHooks, () => api.SettingsSection(props));
	flushEffects();
	return tree;
};
/** 打开某条目的编辑区并返回它那张卡 */
const openCard = (key) => {
	const tree = renderSettings();
	buttonByLabel(cardByKey(tree, key), t('priceEdit')).props.onClick();
	return renderSettings();
};

/* -------------------------------------------- 1/2/3/4：四种条目点「修改」各显示什么 */
let tree = renderSettings();
assert.ok(cardByKey(tree, 'legacy-zeros') !== undefined, '价格库里应渲染出 legacy-zeros 那张卡');

const legacyValues = numberValues(openCard('legacy-zeros'));
assert.strictEqual(legacyValues.length, 6, '峰谷两档共 6 个输入框，实际 ' + legacyValues.length);
assert.deepStrictEqual(legacyValues, ['', '', '', '', '', ''],
	'1) 旧数据形态（四格全是数字 0、没有 null）：点「修改」要整栏空白，实际 ' + JSON.stringify(legacyValues));

assert.deepStrictEqual(numberValues(openCard('only-output')), ['', '', '5'],
	'2) 只填了 output=5：只有它显示 5，其余格是空白（不是 0）');

assert.deepStrictEqual(numberValues(openCard('zero-real')), ['', '0', ''],
	'3) 明确填了 0（其余是 null）：0 要照实显示出来');

assert.deepStrictEqual(numberValues(openCard('paid-real')), ['0.04', '2', '8'],
	'4) 有价的条目仍照实回填（回归：新逻辑不能把已有价格藏起来）');
console.log('1/2/3/4 旧数据全 0=整栏空白 · 只填一格=其余空白 · 填了 0=显示 0 · 有价=回填真实值');

/* -------------------------------------------- 5：新建 → 只填一格 → 保存：其余格必须是 null */
tree = renderSettings();
findInput(tree, 'text').props.onChange({ target: { value: 'partial' } });
tree = renderSettings();
buttonByLabel(tree, t('priceAdd')).props.onClick();
tree = renderSettings();
assert.deepStrictEqual(numberValues(cardByKey(tree, 'partial')), ['', '', ''], '新建条目草稿全空');
/* 字段顺序：缓存命中(cacheRead) / 输入(input) / 输出(output) */
fieldsOf(cardByKey(tree, 'partial'))[2].props.onChange({ target: { value: '5' } });
tree = renderSettings();
buttonByLabel(cardByKey(tree, 'partial'), t('priceSave')).props.onClick();
const partial = savedModels()['partial'];
assert.ok(partial !== undefined, '填过一格就该落库');
assert.strictEqual(partial.peak.output, 5, '填过的格子保留数字');
assert.strictEqual(partial.peak.cacheRead, null, '没填的格子要存成 null（不是 0）');
assert.strictEqual(partial.peak.input, null, '没填的格子要存成 null（不是 0）');
assert.strictEqual(partial.peak.cacheWrite, null, '没填的格子要存成 null（不是 0）');
assert.deepStrictEqual(partial.offPeak, { input: null, cacheRead: null, cacheWrite: null, output: null },
	'用户没碰过的那一档整档都是 null');
assert.deepStrictEqual(numberValues(openCard('partial')), ['', '', '5'],
	'5) 再点「修改」：只显示填过的那个 5，其余空白');
console.log('5 只填一格保存：未填格存成 null、再打开只显示填过的那格');

/* -------------------------------------------- 6：全清空保存 → 该条目从价格库消失 */
const cleared = openCard('clear-me');
assert.deepStrictEqual(numberValues(cleared), ['', '3', ''],
	'前置：clear-me 只填过 input=3，其余空白');
fieldsOf(cardByKey(cleared, 'clear-me'))[1].props.onChange({ target: { value: '' } });
tree = renderSettings();
buttonByLabel(cardByKey(tree, 'clear-me'), t('priceSave')).props.onClick();
assert.strictEqual(Object.prototype.hasOwnProperty.call(savedModels(), 'clear-me'), false,
	'6) 全部格子清空后保存 ⇒ 该条目不留在价格库里');
tree = renderSettings();
assert.strictEqual(cardByKey(tree, 'clear-me'), undefined, '6) 列表里也不该再有这张卡');
console.log('6 全清空保存：条目从价格库与列表里一起消失（等于取消添加）');

/* -------------------------------------------- 7：逐格语义 + 匹配层（全 0 / 全 null 都算"没定价"） */
/* tierValue：没填（null / undefined / ""）→ null；填了就是数字 —— 明确填的 0 是数字 0，不是"没填" */
assert.strictEqual(api.tierValue(null), null, 'null = 没填');
assert.strictEqual(api.tierValue(undefined), null, 'undefined = 没填');
assert.strictEqual(api.tierValue(''), null, '空字符串 = 没填');
assert.strictEqual(api.tierValue(0), 0, '数字 0 = 明确填了 0');
assert.strictEqual(api.tierValue('0'), 0, '字符串 "0" = 明确填了 0');
assert.strictEqual(api.tierValue('5'), 5, '字符串 "5" → 5');
assert.strictEqual(api.tierValue('0.02'), 0.02, '小数照收');
/* 非法输入（手改配置 / 粘进字母）当"没填"：压成 0 会被当成"用户明确把价定成了 0"，
   第二轮匹配就会拿它算钱 —— 所以这里必须是 null */
assert.strictEqual(api.tierValue('abc'), null, '非法输入按没填处理（不能压成 0）');
/* 逐格保留 null：只填一格时其余仍是 null（读配置 / 规范化都不能把它洗成 0） */
assert.deepStrictEqual(Object.assign({}, api.normalizeTier({ input: null, cacheRead: '', cacheWrite: undefined, output: 5 })),
	{ input: null, cacheRead: null, cacheWrite: null, output: 5 }, 'normalizeTier 逐格保留 null');
const normalized = api.normalizePrice({
	peak: { input: null, cacheRead: null, cacheWrite: null, output: 5 },
	offPeak: Object.assign({}, N4)
});
assert.strictEqual(normalized.peak.output, 5, 'normalizePrice 保留填过的数字');
assert.strictEqual(normalized.peak.input, null, 'normalizePrice 保留没填的 null');
assert.strictEqual(normalized.offPeak.output, null, '整档没填就整档 null');
assert.deepStrictEqual(Object.assign({}, normalized.peak),
	{ input: null, cacheRead: null, cacheWrite: null, output: 5 }, 'normalizePrice 出来的档位逐格是 null / 数字');
/* isLegacyZeroEntry：八格**全是数字 0** 才算"旧数据、没填过"；有一格是 null 或非 0 就不是 */
assert.strictEqual(api.isLegacyZeroEntry({ peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) }), true,
	'八格全数字 0 = 旧数据形态（编辑时整栏留空）');
assert.strictEqual(api.isLegacyZeroEntry({ peak: { input: 0, cacheRead: null, cacheWrite: 0, output: 0 }, offPeak: Object.assign({}, Z4) }),
	false, '有一格是 null 就不算旧数据形态');
assert.strictEqual(api.isLegacyZeroEntry({ peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: Object.assign({}, Z4) }),
	false, '有一格非 0 更不算');
assert.strictEqual(api.isLegacyZeroEntry({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }), true,
	'平铺形态（旧数据没有两档）同样是全 0');
assert.strictEqual(api.isLegacyZeroEntry({}), false, '空条目不算旧数据形态');
/* 匹配层：整条全 null 与全 0 都不算"有价"；含 null 的条目也不会抢占能算出价的键 */
assert.strictEqual(api.priceIsBlank({ peak: Object.assign({}, N4), offPeak: Object.assign({}, N4) }), true,
	'整条全 null = 没定价');
assert.strictEqual(api.priceIsBlank({ peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) }), true,
	'整条全数字 0 = 没定价（旧数据形态）');
assert.strictEqual(api.priceIsBlank({ peak: { input: 0, cacheRead: null, cacheWrite: null, output: 5 }, offPeak: Object.assign({}, N4) }),
	false, '有一格填过就不算没定价');
const scratch = {
	'blank-key': { tiered: false, peak: Object.assign({}, N4), offPeak: Object.assign({}, N4) },
	'deepseek-flash': { tiered: true, peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } }
};
assert.strictEqual(api.pickPriceKey(scratch, 'deepseek-v4.1-flash-sg'), 'deepseek-flash',
	'全 null 的条目在第一轮被跳过，不会抢占能算出价的键');
/* hasAnyPriceValue：这条价格里"有没有任何一格是数字"。全 null = 没有；明确填的 0 = 有数字格 */
assert.strictEqual(api.hasAnyPriceValue({ peak: Object.assign({}, N4), offPeak: Object.assign({}, N4) }), false,
	'八格全 null：一个数字格都没有');
assert.strictEqual(api.hasAnyPriceValue({ peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) }), true,
	'八格全数字 0：有数字格（用户明确填了 0）');
assert.strictEqual(api.hasAnyPriceValue({ peak: { input: 0, cacheRead: null, cacheWrite: null, output: null }, offPeak: Object.assign({}, N4) }),
	true, '只要有一格是数字就算有');
/* 两轮匹配：全 null 的条目两轮都不参选；明确填 0 的条目第一轮跳过、第二轮生效 */
assert.strictEqual(api.pickPriceKey({ same: { tiered: false, peak: Object.assign({}, N4), offPeak: Object.assign({}, N4) } }, 'same'),
	null, '八格全 null 的同名条目两轮都不参选（第二轮兜底也不能把它当 0 价用）');
assert.strictEqual(api.pickPriceKey({ same: { tiered: false, peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) } }, 'same'),
	'same', '明确填过 0（有数字格、总和 0）的同名条目：第一轮跳过、第二轮命中');
/* 空字符串价格键不能命中任何模型（否则它会子串命中一切） */
assert.strictEqual(api.pickPriceKey({ '': { tiered: false, peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 } } }, 'anything'),
	null, '空字符串价格键不命中任何模型');
console.log('7 逐格语义：tierValue 区分 null 与 0 · normalizeTier/normalizePrice 逐格保留 null · '
	+ 'isLegacyZeroEntry 只认八格全 0 · 匹配层全 null 或全 0 都算没定价');

/* -------------------------------------------- 8：样式口径（只收窄价格填写框 + 三组字段双边对齐） */
const declOf = (selector) => {
	const start = cssText.indexOf('"' + selector + '{');
	assert.ok(start >= 0, '样式里找不到规则 ' + selector);
	const end = cssText.indexOf('"', start + 1);
	assert.ok(end > start, '规则 ' + selector + ' 没闭合');
	return cssText.slice(start + selector.length + 2, end - 1);
};
const propOf = (selector, prop) => {
	const hit = new RegExp('(?:^|;)' + prop + ':([^;]+)').exec(declOf(selector));
	return hit === null ? null : hit[1];
};
/**
 * 选择器特异性 → [id 数, 类+属性+伪类数, 元素数]（CSS 的 (a,b,c)）。
 * 用来断言"价格框那条比通用规则更具体"，这样即便通用规则排在后面也压不住它。
 */
const specificity = (selector) => {
	const ids = (selector.match(/#[A-Za-z0-9_-]+/g) || []).length;
	const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).length;
	const attrs = (selector.match(/\[[^\]]*\]/g) || []).length;
	const pseudos = (selector.match(/::?[A-Za-z-]+(\([^)]*\))?/g) || []).length;
	const stripped = selector
		.replace(/\.[A-Za-z0-9_-]+/g, ' ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/::?[A-Za-z-]+(\([^)]*\))?/g, ' ');
	const elements = (stripped.match(/[A-Za-z][A-Za-z0-9-]*/g) || []).length;
	return [ids, classes + attrs + pseudos, elements];
};
const moreSpecific = (left, right) => {
	const one = specificity(left);
	const two = specificity(right);
	for (let i = 0; i < 3; i += 1) {
		if (one[i] !== two[i]) return one[i] > two[i];
	}
	return false;
};
const PRICE_RULE = '.dsb-settings .dsb-field input[type=text],.dsb-settings .dsb-field input[type=number]';
assert.strictEqual(propOf(PRICE_RULE, 'height'), '24px',
	'价格输入框高度 24px（用户澄清：只收窄价格输入框）');
assert.strictEqual(propOf(PRICE_RULE, 'width'), '52px', '价格输入框宽度 52px（够放 XX.XX 就行）');
assert.strictEqual(propOf(PRICE_RULE, 'text-align'), 'right', '价格输入框数字右对齐（保持原样）');
assert.strictEqual(propOf('.dsb-settings input[type=text],.dsb-settings input[type=number],.dsb-settings select', 'height'),
	'28px', '通用输入框 / select 仍是 28px（自定义模型名称框也走这条）');
/* 覆盖 bug 的防回归：价格框那条必须比通用规则更具体 —— 否则后者排在后面就把 24px 覆盖成 28px
   （实测踩过：用户看到"价格框又变高了"）。所以选择器一定要带 input[type=...]、不能只写 `.dsb-field input`。 */
[['.dsb-settings .dsb-field input[type=text]', '.dsb-settings input[type=text]'],
	['.dsb-settings .dsb-field input[type=number]', '.dsb-settings input[type=number]']].forEach((pair) => {
	assert.ok(moreSpecific(pair[0], pair[1]),
		'价格框的选择器必须比通用规则更具体：' + pair[0] + ' ' + JSON.stringify(specificity(pair[0]))
		+ ' vs ' + pair[1] + ' ' + JSON.stringify(specificity(pair[1])));
});
assert.strictEqual(specificity('.dsb-settings .dsb-field input[type=number]')[1],
	specificity('.dsb-settings input[type=number]')[1] + 1, '价格框比通用规则正好多一个类（.dsb-field）');
assert.strictEqual(propOf('.dsb-settings .dsb-fields', 'margin-left'), 'auto', '价格三组字段默认整体贴右（左边留给档位名）');
assert.strictEqual(propOf('.dsb-settings .dsb-fields', 'display'), 'flex', '价格三组字段是 flex 行');
/* task-19：单档价格行改用「全时段」档位名 + 常规规则；靠"没有档位名"判断的双边对齐规则已被舍弃。
   这里作为**负断言**钉住，防止它被加回来（加回来会让单档行与两档行的对齐方式不一致）。 */
assert.strictEqual(cssText.indexOf('dsb-tier:not(:has(.dsb-tier-name))'), -1,
	'单档价格行的双边对齐规则（:not(:has(.dsb-tier-name))）已被舍弃，不该再出现');
assert.strictEqual(propOf('.dsb-settings .dsb-action', 'height'), '28px', '按钮高度保持 28px（不被这轮改动波及）');
assert.strictEqual(propOf('.dsb-settings .dsb-edit-pop', 'gap'), '8px', '编辑浮层 gap 保持 8px');
assert.strictEqual(propOf('.dsb-settings .dsb-edit-pop', 'padding'), '10px 12px', '编辑浮层 padding 保持 10px 12px');
console.log('8 样式：价格输入框 24px 高 / 52px 宽；通用输入框与按钮 28px、浮层 gap:8px/padding:10px 12px'
	+ '（单档行的 :not(:has(.dsb-tier-name)) 双边对齐规则已按 task-19 舍弃）');

/* -------------------------------------------- 10：峰谷联动 linkedTierValue */
assert.strictEqual(api.linkedTierValue(50, true), '25', '填高峰 50 → 空闲 25（÷2）');
assert.strictEqual(api.linkedTierValue(25, false), '50', '填空闲 25 → 高峰 50（×2）');
assert.strictEqual(api.linkedTierValue('', true), '', '空串原样返回（清空一档，另一档也清空）');
assert.strictEqual(api.linkedTierValue('', false), '', '空串原样返回');
assert.strictEqual(api.linkedTierValue('abc', true), '', '非法输入留空（宁可留空也不写错价）');
assert.strictEqual(api.linkedTierValue('abc', false), '', '非法输入留空');
assert.strictEqual(api.linkedTierValue(0.07, false), '0.14', '0.07×2 = 0.14，不留浮点尾巴');
assert.strictEqual(api.linkedTierValue(0.1, true), '0.05', '0.1÷2 = 0.05');
console.log('10 峰谷联动：高峰→空闲 ÷2、空闲→高峰 ×2；空串/非法输入留空；0.07×2 = 0.14 无浮点尾巴');

/* -------------------------------------------- 11：没勾「峰谷计价」= 全天一个价（两档都取 peak） */
const ONE_M_INPUT = { input: 1000000, cacheRead: 0, cacheWrite: 0, output: 0 };
/* 北京时间昨天 20:00（空闲）与 10:00（高峰）；用昨天是为了稳稳落在峰谷判断与近 7 天窗口里 */
const bjToday = new Date(Date.now() + 8 * 3600 * 1000);
const atOffPeak = Date.UTC(bjToday.getUTCFullYear(), bjToday.getUTCMonth(), bjToday.getUTCDate() - 1, 20 - 8, 0, 0);
const atPeak = Date.UTC(bjToday.getUTCFullYear(), bjToday.getUTCMonth(), bjToday.getUTCDate() - 1, 10 - 8, 0, 0);
assert.strictEqual(api.isPeakTime(atOffPeak), false, '前置：20:00 是空闲时段');
assert.strictEqual(api.isPeakTime(atPeak), true, '前置：10:00 是高峰时段');
assert.strictEqual(api.priceOf('paid-real').tiered, false, 'priceOf 要把 tiered 带出来');
assert.strictEqual(api.priceOf('tiered-two').tiered, true, '勾了峰谷计价的条目 tiered=true');
assert.strictEqual(api.costOf(ONE_M_INPUT, 'paid-real', atOffPeak), 2,
	'单档条目：空闲时段也按 peak（¥2，不是那个没填/不用的空闲价 ¥1）');
assert.strictEqual(api.costOf(ONE_M_INPUT, 'paid-real', atPeak), 2, '单档条目：高峰时段同样 ¥2');
assert.strictEqual(api.costOf(ONE_M_INPUT, 'tiered-two', atOffPeak), 1, '对照：两档条目空闲时段走 offPeak（¥1）');
assert.strictEqual(api.costOf(ONE_M_INPUT, 'tiered-two', atPeak), 2, '对照：两档条目高峰时段走 peak（¥2）');
console.log('11 单档价：没勾峰谷的条目空闲时段也按 peak 计价（两档条目仍照旧分峰谷）');

/* -------------------------------------------- 12：编辑浮层滚动 effect 的依赖里带 draft.tiered */
const beforeOpen = scrollCalls;
openCard('paid-real');
assert.strictEqual(scrollCalls, beforeOpen + 1, '打开编辑区滚一次，实际 ' + (scrollCalls - beforeOpen));
renderSettings();
assert.strictEqual(scrollCalls, beforeOpen + 1, '依赖没变就不重复滚');
const tierCard = cardByKey(renderSettings(), 'paid-real');
findInput(collectByClass(tierCard, 'dsb-inline-check')[0], 'checkbox').props.onChange({ target: { checked: true } });
renderSettings();
assert.strictEqual(scrollCalls, beforeOpen + 2,
	'勾上「峰谷计价」后浮层长高一截，要再滚一次（依赖里带 draft.tiered），实际 ' + (scrollCalls - beforeOpen));
console.log('12 自动滚动：打开编辑区滚一次 · 依赖没变不重滚 · 勾上峰谷计价后再滚一次');

/* -------------------------------------------- 13：勾「峰谷计价」时单档填过的值必须清空 + 未勾时有「全时段」名 */
/* 第 12 节已经把 paid-real 这张卡打开了（且被勾成了两档），这里直接用它，别再点一次「修改」。 */
if (collectByClass(cardByKey(renderSettings(), 'paid-real'), 'dsb-tier-name').length > 1) {
	findInput(collectByClass(cardByKey(renderSettings(), 'paid-real'), 'dsb-inline-check')[0], 'checkbox')
		.props.onChange({ target: { checked: false } });
}
let toggleCard = cardByKey(renderSettings(), 'paid-real');
assert.deepStrictEqual(collectByClass(toggleCard, 'dsb-tier-name').map(textOf), ['全时段'],
	'未勾峰谷计价时价格行前面要有「全时段」档位名（task-19）');
assert.strictEqual(numberValues(toggleCard).length, 3, '未勾时只有三个价格框');
fieldsOf(toggleCard).forEach((input) => input.props.onChange({ target: { value: '7' } }));
toggleCard = cardByKey(renderSettings(), 'paid-real');
assert.deepStrictEqual(numberValues(toggleCard), ['7', '7', '7'], '前置：单档三个框都填上了 7');
findInput(collectByClass(toggleCard, 'dsb-inline-check')[0], 'checkbox').props.onChange({ target: { checked: true } });
const tieredCard = cardByKey(renderSettings(), 'paid-real');
const tieredValues = numberValues(tieredCard);
assert.ok(tieredValues.length >= 4, '勾上峰谷计价后应至少四个价格框，实际 ' + tieredValues.length);
assert.deepStrictEqual(tieredValues, tieredValues.map(() => ''),
	'勾上「峰谷计价」后所有价格框必须全空（单档填过的 7 不得出现在高峰/空闲行里）');
assert.strictEqual(JSON.stringify(tieredValues).indexOf('7'), -1, '渲染结果里不许残留单档填过的 7');
assert.deepStrictEqual(collectByClass(tieredCard, 'dsb-tier-name').map(textOf), ['空闲时段', '高峰时段'],
	'勾上后两档都带档位名，且不再有「全时段」');
console.log('13 勾「峰谷计价」：单档填过的值全部清空（' + tieredValues.length + ' 个框全为 ""）· 未勾时有「全时段」名');

/* -------------------------------------------- 14：底部自动滚入（task-19）—— 按差值滚 / 没被裁不动 / rAF 补一次 */
rafQueue.clear();
POP.box = { top: 100, bottom: 400, height: 300, left: 0, right: 100, width: 100 };   /* 被裁 */
const beforeWrites14 = scrollCalls;
const beforeTop14 = SCROLLER.scrollTop;
/* 触发一次滚动 effect：切换勾选（依赖里带 draft.tiered） */
findInput(collectByClass(cardByKey(renderSettings(), 'paid-real'), 'dsb-inline-check')[0], 'checkbox')
	.props.onChange({ target: { checked: false } });
renderSettings();
assert.strictEqual(scrollCalls, beforeWrites14 + 1, '被裁时滚一次，实际 ' + (scrollCalls - beforeWrites14));
assert.strictEqual(SCROLLER.scrollTop - beforeTop14, POP.box.bottom + MARGIN - 300,
	'每次滚的量 = 浮层底边 + 12px 余量 − 容器可视底边（不是"底部对齐"那样平白上滚）');
/* 没被裁：浮层底边收进容器内 ⇒ 一动不动 */
POP.box = { top: 40, bottom: 240, height: 200, left: 0, right: 100, width: 100 };
const beforeInside = scrollCalls;
findInput(collectByClass(cardByKey(renderSettings(), 'paid-real'), 'dsb-inline-check')[0], 'checkbox')
	.props.onChange({ target: { checked: false } });
renderSettings();
assert.strictEqual(scrollCalls, beforeInside, '浮层完全在视野里时一动不动（旧版会平白上滚）');
/* 稳定后补一次：下一帧再测，仍被裁就再补一笔 */
POP.box = { top: 100, bottom: 400, height: 300, left: 0, right: 100, width: 100 };
rafQueue.clear();
const beforeRaf = scrollCalls;
findInput(collectByClass(cardByKey(renderSettings(), 'paid-real'), 'dsb-inline-check')[0], 'checkbox')
	.props.onChange({ target: { checked: true } });
renderSettings();
assert.strictEqual(scrollCalls, beforeRaf + 1, '依赖变化后立刻滚一次');
flushRaf();
assert.strictEqual(scrollCalls, beforeRaf + 2, '下一帧再补一次（rAF，不是定时器）');
assert.strictEqual(rafQueue.size, 0, '补滚走的是 rAF，不新增定时器');
console.log('14 底部自动滚入：被裁时按"底边 + 12px − 容器底"滚 · 没被裁一动不动 · 下一帧补一次（rAF）');

/* -------------------------------------------- 15：币种菜单的底部自动滚入（task-21 钩子的第二处调用） */
const selectBtn = () => collectByClass(renderSettings(), 'dsb-select-btn')[0];
const toggleMenu = () => { selectBtn().props.onClick(); renderSettings(); };
/* ① 菜单被裁：滚动量按**菜单节点**底边算（按按钮算会是 0，因为按钮本身在视野内） */
MENU.box = { top: 150, bottom: 420, height: 270, left: 0, right: 100, width: 100 };
rafQueue.clear();
const beforeMenu = scrollCalls;
const beforeMenuTop = SCROLLER.scrollTop;
toggleMenu();
assert.strictEqual(collectByClass(renderSettings(), 'dsb-select-menu').length, 1, '前置：菜单已展开');
assert.ok(MENU.buttonBox.bottom + MARGIN - 300 <= 0, '前置：按钮本身没被裁（按按钮算会是 0）');
assert.strictEqual(scrollCalls, beforeMenu + 1, '菜单被裁时滚一次，实际 ' + (scrollCalls - beforeMenu));
assert.strictEqual(SCROLLER.scrollTop - beforeMenuTop, MENU.box.bottom + MARGIN - 300,
	'滚动量 = 菜单节点底边 + 12px 余量 − 容器可视底边：' + (SCROLLER.scrollTop - beforeMenuTop));
/* ② 没被裁：菜单底边收进容器内 ⇒ 一动不动 */
MENU.box = { top: 40, bottom: 240, height: 200, left: 0, right: 100, width: 100 };
rafQueue.clear();
const beforeMenuInside = scrollCalls;
toggleMenu();   /* 收起 */
toggleMenu();   /* 再展开（依赖 true → false → true，effect 会重跑） */
assert.strictEqual(scrollCalls, beforeMenuInside, '菜单完全在视野里时一动不动，实际多了 ' + (scrollCalls - beforeMenuInside));
/* ③ 首帧没被裁、下一帧长高 ⇒ rAF 补滚一次；再 flush 不重复滚（幂等） */
MENU.box = { top: 40, bottom: 240, height: 200, left: 0, right: 100, width: 100 };
rafQueue.clear();
const beforeGrow = scrollCalls;
toggleMenu();   /* 收起 */
toggleMenu();   /* 再展开：第一帧还没被裁 */
assert.strictEqual(scrollCalls, beforeGrow, '第一帧没被裁 ⇒ 先不滚');
MENU.box = { top: 150, bottom: 420, height: 270, left: 0, right: 100, width: 100 };   /* 下一帧长高 */
flushRaf();
assert.strictEqual(scrollCalls, beforeGrow + 1, '下一帧复测发现被裁 ⇒ 补滚一次，实际 ' + (scrollCalls - beforeGrow));
const grownTop = SCROLLER.scrollTop;
flushRaf();
assert.strictEqual(scrollCalls, beforeGrow + 1, 'rAF 已消费完，再 flush 不重复滚（幂等）');
assert.strictEqual(SCROLLER.scrollTop, grownTop, '滚动位置也不再变');
console.log('15 币种菜单：按**菜单节点**底边滚（按钮在视野内 → 按它算会是 0）· 没被裁不动 · 下一帧长高补滚一次且幂等');

/* -------------------------------------------- 9：host 收到带 null 的价格库照样只按数值计价 */
const BEIJING = 8 * 3600 * 1000;
const pad2 = (value) => (value < 10 ? '0' + String(value) : String(value));
const bjNow = new Date(Date.now() + BEIJING);
const AT = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 12, 0, 0);
const DAY = (() => {
	const one = new Date(AT + BEIJING);
	return one.getUTCFullYear() + '-' + pad2(one.getUTCMonth() + 1) + '-' + pad2(one.getUTCDate());
})();

(async () => {
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	let handler = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (r) => { if (r.path === '/dsh-desktop-statusbar/api') handler = r.handler; return () => {}; } },
		credentials: undefined
	});
	assert.ok(handler !== null, 'host 路由已注册');
	const hit = (pathname, options) => new Promise((resolve) => {
		const opts = options === undefined ? {} : options;
		let status = null, body = null;
		const res = { writeHead: (c) => { status = c; }, end: (t2) => { body = t2; } };
		const listeners = {};
		const req = {
			url: pathname,
			method: opts.method === undefined ? 'GET' : opts.method,
			on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
			destroy: () => {}
		};
		const pending = Promise.resolve(handler(req, res));
		if (opts.body !== undefined) (listeners.data || []).forEach((fn) => fn(opts.body));
		(listeners.end || []).forEach((fn) => fn());
		pending.then(() => resolve({ status, body: body === null ? null : JSON.parse(body) }));
	});
	const postPrices = (models) => hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', body: JSON.stringify({ models }) });
	const daily = () => hit('/dsh-desktop-statusbar/api/daily-usage?force=1');
	/* 这一份是两档计价（tiered:true）：空闲时段走 offPeak，用来单独验"null 格按 0 不炸"；
	   单档（tiered:false）的按 peak 计价由 9f/9g 单独覆盖。 */
	const BOOK_NULLS = {
		'alpha-x': {
			tiered: true,
			peak: { input: 8, cacheRead: null, cacheWrite: null, output: null },
			offPeak: { input: 4, cacheRead: null, cacheWrite: null, output: null }
		}
	};
	const unpricedOf = () => {
		const file = path.join(HOME, 'dsh-status-bar', 'usage-ledger.json');
		if (fs.existsSync(file) !== true) return {};
		const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
		const day = ledger.days === undefined ? undefined : ledger.days[DAY];
		return day === undefined || day.unpriced === undefined ? {} : day.unpriced;
	};
	/** 每个用例先铺一份干净的隔离目录 + 一条 1M 输入用量 */
	const setupUsage = (caseName, model) => {
		fs.rmSync(HOME, { recursive: true, force: true });
		fs.mkdirSync(path.join(HOME, 'dsh-status-bar'), { recursive: true });
		const dir = path.join(HOME, 'sessions', 'session-' + caseName);
		fs.mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({
			type: 'assistant/message', seq: 1, time: AT,
			data: {
				turn: 1, step: 1,
				message: { source: { kind: 'model', provider: 'test-provider', model: model } },
				usage: { inputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
			}
		});
		fs.writeFileSync(path.join(dir, 'usage.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8')));
	};
	/** 一个用例：铺用量 → POST 价格库 → force 扫一次 */
	const runCase = async (caseName, model, book) => {
		setupUsage(caseName, model);
		const posted = await postPrices(book);
		const payload = await daily();
		const day = payload.body.days.filter((one) => one.date === DAY)[0];
		return { status: posted.status, day: day, unpriced: unpricedOf() };
	};
	await daily();   /* 先把 apply() 里那次预热扫描跑完（此刻目录是干净的），后面每个用例都是独立一次扫描 */

	/* 9a：带 null 格子的价格库照样按数值计价 */
	const numeric = await runCase('numeric', 'alpha-x', BOOK_NULLS);
	assert.strictEqual(numeric.status, 200, '带 null 格子的价格库照样收下（200）');
	assert.ok(numeric.day !== undefined, '有 ' + DAY + ' 的日桶');
	assert.strictEqual(numeric.day.cost, 4, 'host 只按数值计价：1M × 空闲价 4 = ¥4（null 格按 0），实际 ' + numeric.day.cost);	assert.strictEqual(numeric.unpriced['alpha-x'], undefined, '命中了价就不该记欠账');

	/* 9b：八格全 null 的条目在**两轮**里都不参选 ⇒ 该笔记欠账，而不是被当成 0 价 */
	const allNull = await runCase('allnull', 'alpha-x', {
		'alpha-x': { tiered: false, peak: Object.assign({}, N4), offPeak: Object.assign({}, N4) }
	});
	assert.strictEqual(allNull.status, 200, '全 null 的价格库也能收下（200）');
	assert.strictEqual(allNull.day.cost, 0, '全 null 条目不参选 ⇒ 算不出钱，实际 ' + allNull.day.cost);
	assert.ok(allNull.unpriced['alpha-x'] !== undefined,
		'全 null 条目不参选 ⇒ 该笔要记进欠账（若被当成 0 价就不会有欠账）');

	/* 9c：明确填 0（有数字格）的同名条目 ⇒ 第二轮生效，¥0 且**不**记欠账 */
	const zeroReal = await runCase('zeroreal', 'alpha-x', {
		'alpha-x': { tiered: false, peak: Object.assign({}, Z4), offPeak: Object.assign({}, Z4) }
	});
	assert.strictEqual(zeroReal.day.cost, 0, '明确设 0 的条目照样能算出 0 价，实际 ' + zeroReal.day.cost);
	assert.strictEqual(zeroReal.unpriced['alpha-x'], undefined, '明确设 0 是"有价" ⇒ 不该记欠账');

	/* 9d：空字符串价格键要被丢掉（留着的话它会子串命中一切，把这笔算成 99） */
	const emptyKey = await runCase('emptykey', 'unrelated-model', {
		'other-x': { tiered: false, peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } },
		'': { tiered: false, peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 0 } }
	});
	assert.strictEqual(emptyKey.status, 200, '含空键的价格库仍收下（空键被丢弃，库不至于变空）');
	assert.strictEqual(emptyKey.day.cost, 0, '空键不命中任何模型 ⇒ 不该算出 99，实际 ' + emptyKey.day.cost);
	assert.ok(emptyKey.unpriced['unrelated-model'] !== undefined, '空键不命中 ⇒ 该笔记欠账');

	/* 9e：含 null 的价格库重报 → changed=false（指纹能算、settled 语义不变） */
	const first = await postPrices(BOOK_NULLS);
	const second = await postPrices(BOOK_NULLS);
	assert.strictEqual(first.status, 200, '含 null 的价格库第一次上报 200');
	assert.strictEqual(second.status, 200, '同一份重报 200');
	assert.strictEqual(second.body.changed, false, '同一份含 null 的价格库重报不算变更（指纹没坏）');
	assert.strictEqual(second.body.settled.entries, 0, '没有欠账时不结算任何条目');
	assert.strictEqual(second.body.settled.amount, 0, '也没有金额被补记');
	const ledgerFile = path.join(HOME, 'dsh-status-bar', 'usage-ledger.json');
	assert.strictEqual(typeof JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).priceFingerprint, 'string',
	'含 null 的价格库也能算出指纹');

	/* 9f：单档条目（tiered:false）在空闲时段也按 peak 计价（host 的 tokenCost 尊重 tiered） */
	const flat = await runCase('flat', 'alpha-x', {
		'alpha-x': {
			tiered: false,
			peak: { input: 8, cacheRead: 0, cacheWrite: 0, output: 0 },
			offPeak: { input: 4, cacheRead: 0, cacheWrite: 0, output: 0 }
		}
	});
	assert.strictEqual(flat.status, 200, '单档价格库收下（200）');
	assert.strictEqual(flat.day.cost, 8,
		'单档条目空闲时段按 peak：1M × 8 = ¥8（不是空闲价 ¥4）——host 保留了 tiered，实际 ' + flat.day.cost);
	assert.strictEqual(flat.unpriced['alpha-x'], undefined, '算得出钱就不记欠账');

	/* 9g：settleUnpriced 也尊重 tiered —— 先无价记欠账，再报"全天一个价"的库 → 按 peak 补 ¥8 */
	setupUsage('settle', 'alpha-x');
	await postPrices({ 'other-x': { tiered: false, peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } });
	await daily();
	assert.ok(unpricedOf()['alpha-x'] !== undefined, '前置：没有 alpha-x 的价格，这笔记进欠账');
	const settledPost = await postPrices({
		'alpha-x': {
			tiered: false,
			peak: { input: 8, cacheRead: 0, cacheWrite: 0, output: 0 },
			offPeak: { input: 4, cacheRead: 0, cacheWrite: 0, output: 0 }
		}
	});
	assert.strictEqual(settledPost.body.changed, true, '价格库变了');
	assert.strictEqual(settledPost.body.settled.entries, 1, '补价后结算这条欠账');
	assert.strictEqual(settledPost.body.settled.amount, 8,
		'结算也按 peak 价 ¥8（不是空闲价 ¥4），实际 ' + settledPost.body.settled.amount);
	const settledDay = (await daily()).body.days.filter((one) => one.date === DAY)[0];
	assert.strictEqual(settledDay.cost, 8, '补记后当天费用 ¥8，实际 ' + settledDay.cost);
	assert.strictEqual(settledDay.total, 1000000, 'token 不重复计，实际 ' + settledDay.total);
	assert.strictEqual(unpricedOf()['alpha-x'], undefined, '结算完不再留欠账');

	console.log('9 host 侧：带 null 的库按数值计价 · 全 null 条目不参选（进欠账）· 明确设 0 仍生效 · '
		+ '空键被丢弃 · 重报 changed=false · 单档条目按 peak（计价与结算都是）');
	console.log('');
	console.log('PRICE FILLED CHECKS PASSED');
})().catch((error) => {
	console.error('PRICE FILLED CHECKS FAILED: ' + (error && error.message ? error.message : error));
	process.exitCode = 1;
});
