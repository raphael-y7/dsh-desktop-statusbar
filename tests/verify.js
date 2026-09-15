/**
 * 验证 dsh-desktop-statusbar 的占位与格式改动。
 * 做法：用最小替身加载真实 client.js（window.localStorage / ModuleLoader / React），
 * 从 factory 内部导出被测函数，直接跑真实渲染路径。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');

// 暴露闭包内的被测符号
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker,
  '\t\texports.__test = { segmentView, segmentText, detectLocale, formatDuration, formatSeconds, formatTokens, formatThroughput, SEGMENTS, DEFAULT_SEGMENTS, STORAGE_KEY, snapshot, StatusBar, SettingsSection };\n' + marker);

const store = new Map();
/* 预置一份"乱序 + 只勾四段 + 非默认币种"的旧配置：出厂默认要从这种状态拉回来 */
const CONFIG_KEY = 'dsh.desktopStatusBar.v1';
const MESSY_SEGMENTS = ['cost', 'sessionTime', 'status', 'counts'];
store.set(CONFIG_KEY, JSON.stringify({
	version: 5, enabled: true, wrap: false,
	segments: MESSY_SEGMENTS.slice(), currency: 'USD', models: {}
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
	setTimeout: () => 0,
	clearTimeout: () => {}
};

let captured = null;
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
		head: { appendChild() {} }
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

/* React 替身：hooks 按组件分桶保存，点击后重新渲染就能读到最新 state */
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

const reactStub = {
	createElement(type, props, ...children) {
		return {
			type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
		};
	},
	useState: (init) => {
		const slot = hookSlot(init);
		return [slot.get(), slot.set];
	},
	useEffect: () => { hookSlot(undefined); },
	useRef: (init) => hookSlot({ current: init === undefined ? null : init }).get(),
	useSyncExternalStore: (subscribe, snapshot) => {
		hookSlot(undefined);
		return snapshot();
	},
	useCallback: (fn) => { hookSlot(undefined); return fn; },
	useMemo: (fn) => { hookSlot(undefined); return fn(); },
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
assert.ok(captured !== null && captured.id === 'dsh-desktop-statusbar', 'plugin entry not captured');

const mod = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
});
const api = mod.__test;
assert.ok(api !== undefined, '__test export missing');

/* ------------------------------------------------------------------ 替身 i18n */
const zh = {
	segStatus: '会话状态', segCounts: '轮次＆步数', segDurations: '模型与工具耗时', segTtft: '首字延迟',
	segCacheHit: '缓存命中率', segTokens: 'Token计数', segTps: '输出速度', segSessionTime: '运行用时',
	segCost: '会话费用', segLastCost: '本次费用', segBalance: '余额',
	f_status_running: '运行中', f_status_idle: '空闲', f_status_error: '出错',
	f_counts: '{turns} 轮 {steps} 步', f_llm: '模型 {duration}', f_tool: '工具 {duration}',
	f_ttft: '首字平均 {duration}', f_cacheHit: '缓存命中 {percent}%',
	f_peak: '高峰', f_valley: '低谷', f_approval: '待批准',
	f_tokens: '{total} tokens', f_context: '上下文 {percent}%',
	f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出',
	f_speed: '输出速度 {throughput}t/s', f_sessionTime: '总用时 {duration}',
	f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
	f_balance: '余额 {symbol}{amount}', f_balanceLoading: '余额 查询中', f_balanceFailed: '余额 失败({reason})',
	unitCountTurns: ' 轮', unitCountSteps: ' 步', unitCost: '', unitSeconds: ' s', unitSpeed: ' t/s', unitMinutes: ' m',
	modelUnknown: '未识别',
	secSegments: '数据字段', secBasic: '基础', secPrices: '自定义模型价格', secPreview: '预览（示例数据）',
	secSegmentsHint: '勾选显示；按住拖动可调整顺序。',
	intro: '接管对话区底部的统计行。',
	enabled: '启用状态栏', enabledHint: '关闭后底栏整体隐藏。', wrap: '允许换行', wrapHint: '开启后统计段自动折行。',
	priceCurrent: '当前会话使用：', priceConfigured: '已配置', priceNotConfigured: '未配置价格，费用段显示横杠占位',
	priceAdd: '添加', priceNewModel: '新模型', priceRemove: '删除', priceEmpty: '价格库为空', reset: '恢复默认设置',
	priceInput: '输入(缓存未命中)', priceCacheRead: '输入(缓存命中)', priceOutput: '输出',
	priceTierPeak: '高峰时段', priceTierOffPeak: '空闲时段', priceTiered: '峰谷计价',
	priceEdit: '修改', priceSave: '保存', priceCurrency: '币种',
	secPricesHint: '填写你使用的模型单价。', peakNow: '当前处于{period}', offPeakNow: '当前处于{period}',
	peakPeriod: '高峰期', offPeakPeriod: '空闲时段',
	dragHint: '拖动排序', diagChecking: '余额接口：查询中…',
	f_balanceDash: '余额 -', balanceAt: '余额数据时间 {time}'
};
const t = (key, params) => {
	let out = zh[key] !== undefined ? zh[key] : ('<' + key + '>');
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
assert.strictEqual(api.detectLocale(t), 'zh', 'locale detection should resolve zh');

/* 出厂默认 = 全部段 + 截图顺序；下面所有渲染都用这一份 */
const FACTORY_ORDER = ['status', 'counts', 'cacheHit', 'ttft', 'tps', 'sessionTime', 'lastCost', 'cost', 'balance', 'tokens'];
/** sandbox realm 里的数组要转成宿主数组，否则 deepStrictEqual 会因原型不同而失败 */
const toHost = (arr) => Array.prototype.slice.call(arr);
assert.strictEqual(api.STORAGE_KEY, CONFIG_KEY, 'storage key 与验证脚本不一致');
assert.deepStrictEqual(toHost(api.SEGMENTS.map((s) => s.id)), FACTORY_ORDER, 'SEGMENTS 声明顺序应等于出厂顺序');
assert.deepStrictEqual(toHost(api.DEFAULT_SEGMENTS), FACTORY_ORDER, '出厂默认应是全部段且按截图顺序');
const MIGRATED_REST = FACTORY_ORDER.filter((id) => MESSY_SEGMENTS.indexOf(id) === -1);
assert.deepStrictEqual(toHost(api.snapshot().segments), MESSY_SEGMENTS.concat(MIGRATED_REST), '前置：旧配置迁移后段序 = 原顺序 + 补全的段');
assert.deepStrictEqual(toHost(api.snapshot().hidden), MIGRATED_REST, '前置：迁移把补进来的段标为未勾选');

const order = api.DEFAULT_SEGMENTS.slice();
const render = (src, segs) => (segs || order).map((id) => api.segmentText(id, api.segmentView(id, src, t), t));

/* --------------------------------------------------- 空会话：只有余额可查 */
const emptySrc = {
	stats: undefined, usage: undefined, pressure: undefined,
	sessionModel: undefined, sessionUsage: undefined, timeRange: undefined,
	running: true, partial: null, runningCalls: [], lastAgentError: null,
	timeline: undefined, now: Date.now(),
	balance: { ok: true, total: '5.43', currency: 'CNY' },
	turnUsage: null, currency: 'CNY'
};
const bar = render(emptySrc);
console.log('无数据底栏：', bar.join(' | '));

const allSegs = api.SEGMENTS.map((s) => s.id);
const emptyAll = render({ ...emptySrc, balance: undefined }, allSegs);
console.log('无数据全段：', emptyAll.join(' | '));

const flat = bar.concat(emptyAll);
assert.ok(!flat.some((x) => x.includes('–') || x.includes('—')), 'placeholder symbol still rendered');
assert.ok(!flat.some((x) => x.includes('暂无')), 'old placeholder wording still rendered');
assert.ok(bar[0] === '高峰' || bar[0] === '低谷', 'status segment shows period text, got: ' + bar[0]);
assert.ok(bar.includes('- 轮 - 步'), 'counts placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('缓存命中 - %'), 'cacheHit placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('首字平均 - s'), 'ttft placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('输出速度 - t/s'), 'tps placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('总用时 -m -s'), 'sessionTime placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('本轮 -'), 'lastCost placeholder, got: ' + bar.join(' | '));
assert.ok(emptyAll.includes('总计 -'), 'cost placeholder, got: ' + emptyAll.join(' | '));
assert.ok(emptyAll.includes('余额 -'), 'balance keeps its label even without data, got: ' + emptyAll.join(' | '));
assert.ok(emptyAll.includes('- tokens'), 'tokens placeholder is dash + unit, got: ' + emptyAll.join(' | '));

/* ------------------------------------------------------------ 有数据：不变样 */
const fullSrc = {
	stats: { turns: 2, steps: 51, llmMs: 125000, toolMs: 45000, ttftMs: 92500, ttftSteps: 10, decodeMs: 13000, decodeTokens: 2963000 },
	usage: { uncachedInputTokens: 29631, cacheReadTokens: 1900000, cacheWriteTokens: 0, outputTokens: 41007 },
	pressure: { pressureTokens: 620000, contextWindow: 1000000 },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	sessionUsage: {
		models: { 'deepseek-flash': { input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 } },
		calls: [{ at: Date.now(), model: 'deepseek-flash', input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 }],
		current: null, last: null
	},
	running: true, partial: null, runningCalls: [], lastAgentError: null,
	timeline: undefined, now: Date.now(),
	timeRange: { turns: 5400000, since: null, steps: 0, stepSince: null },
	balance: { ok: true, total: '12.34', currency: 'CNY' },
	turnUsage: { input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 },
	currency: 'CNY'
};
const fullBar = render(fullSrc, allSegs);
console.log('有数据全段：', fullBar.join(' | '));
assert.ok(!fullBar.some((x) => x.includes(' -')), 'placeholder leaked into data path');
assert.ok(fullBar.includes('2 轮 51 步'), 'counts value');
assert.ok(fullBar.includes('首字平均 9.3s'), 'ttft stays in seconds, got: ' + fullBar.join(' | '));
assert.ok(fullBar.includes('总用时 1h30m'), 'sessionTime switches to h/m, got: ' + fullBar.join(' | '));
assert.ok(/98\.46%/.test(fullBar.join(' | ')), 'cache percent, got: ' + fullBar.join(' | '));
assert.ok(fullBar.includes('1,970,638 tokens'), 'tokens shows the sum of three parts, got: ' + fullBar.join(' | '));
assert.ok(/\d+t\/s/.test(fullBar.join(' | ')), 'throughput has no space before unit, got: ' + fullBar.join(' | '));
assert.ok(fullBar.includes('余额 ¥12.34'), 'balance value');
assert.ok(fullBar.includes('总计 ¥0.23'), 'session cost, got: ' + fullBar.join(' | '));

/* ---------------------------------------------------------------- 格式函数 */
assert.strictEqual(api.formatDuration(0), null, 'zero duration is null');
assert.strictEqual(api.formatDuration(4500), '4.5s', '4.5s stays in seconds');
assert.strictEqual(api.formatDuration(27000), '27s', '27s');
assert.strictEqual(api.formatDuration(455000), '7m35s', '7m35s, no space');
assert.strictEqual(api.formatDuration(155000), '2m35s', '2m35s');
assert.strictEqual(api.formatSeconds(9250), '9.3', 'ttft keeps one decimal');
assert.strictEqual(api.formatSeconds(0), null, 'zero ttft is null');
assert.strictEqual(api.formatDuration(5400000), '1h30m', '1.5h -> 1h30m');
assert.strictEqual(api.formatDuration(3600000), '1h0m', 'exactly 1h');
assert.strictEqual(api.formatDuration(3599000), '59m59s', 'just under 1h');
assert.strictEqual(api.formatDuration(125000), '2m5s', '125s -> 2m5s');
assert.strictEqual(api.formatTokens(1929631), '1,929,631', 'tokens exact with thousands separators');
assert.strictEqual(api.formatTokens(999999999), '999,999,999', 'no M abbreviation');
assert.strictEqual(api.formatThroughput(12345.6), '12346', 'throughput no k abbreviation');

/* ------------------------------------------------------------ 余额异常分支 */
const midBar = render({ ...emptySrc, balance: null }, allSegs);
console.log('余额查询中：', midBar.join(' | '));
assert.ok(midBar.includes('余额 -'), 'balance loading shows label + dash, got: ' + midBar.join(' | '));
const failBar = render({ ...emptySrc, balance: { ok: false, reason: 'fetch-failed' } }, allSegs);
console.log('余额失败：', failBar.join(' | '));
assert.ok(failBar.includes('余额 -'), 'balance failure shows label + dash, got: ' + failBar.join(' | '));

/* ------------------------------------------------------- 组件与设置页渲染 */
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return textOf(node.children);
}
const noop = () => {};
const props = { t, useProjection: () => undefined, useSession: () => undefined, useSessions: () => undefined, useChat: () => undefined, sessionId: 'verify-session' };
const barHooks = makeHooks();
const settingsHooks = makeHooks();
const renderBar = () => withHooks(barHooks, () => api.StatusBar(props));
const renderSettings = () => withHooks(settingsHooks, () => api.SettingsSection(props));
const rendered = textOf(renderBar());
console.log('组件渲染：', rendered.replace(/\s+/g, ' ').trim());
assert.ok(!rendered.includes('–') && !rendered.includes('—'), 'component still renders placeholder symbol');
assert.ok(rendered.includes('- 轮 - 步') && rendered.includes('总用时 -m -s'), 'component placeholder template');

/* 接管官方状态栏：认自己的标记，不依赖官方组件的构建 hash（DSH 更新会换 hash，2.0.10 踩过） */
assert.strictEqual(renderBar().props['data-dsb'], 'bar', '底栏根节点要带 data-dsb 排查标记');
const sourceCss = code.slice(code.indexOf('\t\tconst CSS = ['), code.indexOf('].join("");'));
assert.ok(sourceCss.includes('> *:not(.dsb-root):not(:has(.dsb-root))'),
	'CSS 要同时判自身与后代，否则连自己的行一起藏掉（2.0.10 踩过）');
assert.ok(!/\[class\*="/.test(sourceCss), 'CSS 不应再依赖官方组件的构建 hash 类名');
console.log('官方状态栏：按 .dsb-root 认自己，隐藏其余');

const settings = textOf(renderSettings());
assert.ok(settings.includes('数据字段'), 'settings section should render');
assert.ok(settings.includes('按住拖动可调整顺序'), 'settings hint should describe drag reorder');

/* ------------------------------------------- 出厂默认：点「恢复默认设置」的顺序与勾选 */
/** 设置页里段标题的渲染顺序 */
function segmentNames(tree) {
	const labels = FACTORY_ORDER.map((id) => zh[api.SEGMENTS.filter((s) => s.id === id)[0].label]);
	const names = [];
	(function walk(node) {
		if (node === null || node === undefined || typeof node !== 'object') return;
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (node.type === 'span' && node.props !== undefined && node.props.className === 'dsb-name') {
			const text = textOf(node);
			if (labels.indexOf(text) !== -1) names.push(text);
		}
		walk(node.children);
	})(tree);
	return names;
}
const factoryLabels = FACTORY_ORDER.map((id) => zh[api.SEGMENTS.filter((s) => s.id === id)[0].label]);
assert.notDeepStrictEqual(segmentNames(renderSettings()), factoryLabels, '前置：重置前的设置页顺序应是乱的');

const resetBtn = (function find(node) {
	let found = null;
	(function walk(n) {
		if (found !== null || n === null || n === undefined || typeof n !== 'object') return;
		if (Array.isArray(n)) { n.forEach(walk); return; }
		if (n.type === 'button' && textOf(n) === t('reset')) { found = n; return; }
		walk(n.children);
	})(node);
	return found;
})(renderSettings());
assert.ok(resetBtn !== null, '设置页应有「恢复默认设置」按钮');

resetBtn.props.onClick();
const saved = JSON.parse(store.get(api.STORAGE_KEY));
assert.deepStrictEqual(saved.segments, FACTORY_ORDER, '恢复默认设置后应回到出厂顺序且全部勾选，实际 ' + JSON.stringify(saved.segments));
assert.deepStrictEqual(saved.hidden, [], '恢复默认设置应清空未勾选标记');
assert.strictEqual(saved.wrap, true, '恢复默认设置应恢复换行开关');
assert.strictEqual(saved.enabled, true, '恢复默认设置应恢复启用开关');
assert.strictEqual(saved.currency, 'CNY', '恢复默认设置应恢复币种');
assert.deepStrictEqual(segmentNames(renderSettings()), factoryLabels, '恢复默认设置后设置页顺序应等于出厂顺序');
console.log('恢复默认设置后：', saved.segments.join(' → '));

/* ------------------------------------------- 价格库：折叠两态 / 峰谷计价 / 草稿 */
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
const buttonByLabel = (tree, label) => collectByClass(tree, 'dsb-action').filter((node) => textOf(node) === label)[0];
const modelCards = (tree) => collectByClass(tree, 'dsb-model');
function freshSettings() {
	settingsHooks.values.length = 0;   /* 清空 state，回到刚打开设置页的样子 */
	return renderSettings();
}
const savedModels = () => JSON.parse(store.get(CONFIG_KEY)).models;

let priceTree = freshSettings();
let cards = modelCards(priceTree);
assert.strictEqual(cards.length, 2, '价格库应有 2 个默认模型，实际 ' + cards.length);
assert.deepStrictEqual(cards.map((card) => textOf(collectByClass(card, 'dsb-model-name')[0])),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro'], '模型名应按首字母大写规则显示');
assert.strictEqual(collectByClass(priceTree, 'dsb-field').length, 0, '默认收起时不该有价格输入框');
assert.ok(buttonByLabel(cards[0], '修改') !== undefined, '收起态应有「修改」');
assert.ok(buttonByLabel(cards[0], '删除') !== undefined, '收起态应有「删除」');

/* 展开：空闲价在上、高峰价在下，每档三栏 */
buttonByLabel(cards[0], '修改').props.onClick();
priceTree = renderSettings();
cards = modelCards(priceTree);
const fields = collectByClass(cards[0], 'dsb-field');
assert.strictEqual(fields.length, 6, '峰谷两档应各有 3 个输入框，实际 ' + fields.length);
assert.deepStrictEqual(collectByClass(cards[0], 'dsb-tier-name').map(textOf), ['空闲时段', '高峰时段'], '空闲时段应在高峰时段之前');
assert.deepStrictEqual(fields.slice(0, 3).map(textOf), ['输入(缓存命中)', '输入(缓存未命中)', '输出'], '三栏顺序与文案');
assert.ok(buttonByLabel(cards[0], '保存') !== undefined, '展开态应有「保存」');

/* 取消峰谷计价 → 全天同价，只剩三个输入框 */
const tieredLabel = collectByClass(cards[0], 'dsb-inline-check')[0];
assert.strictEqual(textOf(tieredLabel), '峰谷计价', '应有峰谷计价勾选');
findInput(tieredLabel, 'checkbox').props.onChange({ target: { checked: false } });
priceTree = renderSettings();
cards = modelCards(priceTree);
assert.strictEqual(collectByClass(cards[0], 'dsb-field').length, 3, '全天同价应只有 3 个输入框');
assert.strictEqual(collectByClass(cards[0], 'dsb-tier-name').length, 0, '全天同价不显示档位标签');

/* 改值 → 保存 → 写入配置并收起 */
findInput(cards[0], 'number').props.onChange({ target: { value: '1.5' } });
priceTree = renderSettings();
cards = modelCards(priceTree);
buttonByLabel(cards[0], '保存').props.onClick();
priceTree = renderSettings();
cards = modelCards(priceTree);
assert.strictEqual(collectByClass(priceTree, 'dsb-field').length, 0, '保存后卡片应收起');
assert.ok(buttonByLabel(cards[0], '修改') !== undefined, '收起后应回到「修改」');
const flash = savedModels()['deepseek-flash'];
assert.strictEqual(flash.tiered, false, '全天同价标记应写入配置');
assert.strictEqual(flash.peak.cacheRead, 1.5, '输入(缓存命中) 的值应写入 peak');
assert.deepStrictEqual(flash.offPeak, flash.peak, '全天同价时两档应一致');
assert.strictEqual(flash.peak.cacheWrite, 0, '缓存写入不再显示，字段保留 0');
assert.strictEqual(flash.peak.output, 8, '未改动的栏位保持原值');

/* 未保存的草稿：切到另一个模型即丢弃 */
buttonByLabel(cards[0], '修改').props.onClick();
priceTree = renderSettings();
findInput(modelCards(priceTree)[0], 'number').props.onChange({ target: { value: '99' } });
priceTree = renderSettings();
buttonByLabel(modelCards(priceTree)[1], '修改').props.onClick();
priceTree = renderSettings();
assert.strictEqual(savedModels()['deepseek-flash'].peak.cacheRead, 1.5, '未保存的草稿不应写入配置');

/* 新添加的模型默认展开 */
findInput(priceTree, 'text').props.onChange({ target: { value: 'glm-5.3-flash' } });
priceTree = renderSettings();
buttonByLabel(priceTree, '添加').props.onClick();
priceTree = renderSettings();
const added = modelCards(priceTree).filter((card) => textOf(collectByClass(card, 'dsb-model-name')[0]) === 'GLM-5.3-Flash')[0];
assert.ok(added !== undefined, '新模型应按 GLM 全大写规则显示');
assert.strictEqual(collectByClass(added, 'dsb-field').length, 3, '新模型应默认展开且为单档（3 个输入框）');
assert.strictEqual(savedModels()['glm-5.3-flash'].tiered, false, '新模型默认不勾峰谷计价');
assert.ok(savedModels()['glm-5.3-flash'] !== undefined, '新模型应写入配置');
assert.strictEqual(collectByClass(priceTree, 'dsb-models').length, 1, '模型列表应有一个容器');
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash'], '新模型应排在列表最后');

/* 整数样式的模型名（如 "1"）也不能跑到最前 */
findInput(priceTree, 'text').props.onChange({ target: { value: '1' } });
priceTree = renderSettings();
buttonByLabel(priceTree, '添加').props.onClick();
priceTree = renderSettings();
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash', '1'], '纯数字模型名同样排最后');
console.log('价格库交互：折叠 / 峰谷 / 草稿 / 顺序全部通过');

/* ------------------------------------------- 段勾选：取消勾选后留在原位 */
settingsHooks.values.length = 0;
let segTree = renderSettings();
const namesBefore = collectByClass(segTree, 'dsb-name').map(textOf);
const cacheRow = collectByClass(segTree, 'dsb-row')
	.filter((row) => textOf(collectByClass(row, 'dsb-name')[0]) === zh.segCacheHit)[0];
assert.ok(cacheRow !== undefined, '设置页应有缓存命中率那一行');
findInput(cacheRow, 'checkbox').props.onChange({ target: { checked: false } });
const afterToggle = JSON.parse(store.get(CONFIG_KEY));
assert.deepStrictEqual(afterToggle.hidden, ['cacheHit'], '取消勾选应写进 hidden');
assert.strictEqual(afterToggle.segments.indexOf('cacheHit'), FACTORY_ORDER.indexOf('cacheHit'), '取消勾选后段序位置不变');
segTree = renderSettings();
assert.deepStrictEqual(collectByClass(segTree, 'dsb-name').map(textOf), namesBefore, '取消勾选后设置页顺序应保持不变');
const barAfterToggle = textOf(renderBar()).replace(/\s+/g, ' ');
assert.ok(!barAfterToggle.includes('缓存命中'), '取消勾选的段不应再出现在底栏，实际：' + barAfterToggle);
console.log('段勾选：取消后仍在原位');

/* ------------------------------------------- 拖动：上/下半区决定落点（方案 A） */
settingsHooks.values.length = 0;
let dragTree = renderSettings();
let dragRows = collectByClass(dragTree, 'dsb-row');
assert.strictEqual(dragRows.length, 12, '基础 2 行 + 段 10 行，实际 ' + dragRows.length);
dragRows[2].props.onDragStart({ dataTransfer: { effectAllowed: '', setData() {} } });   /* 拖 status */
dragTree = renderSettings();
dragRows = collectByClass(dragTree, 'dsb-row');
dragRows[5].props.onDragOver({                                                            /* 目标 ttft 的下半区 */
	preventDefault() {},
	currentTarget: { getBoundingClientRect: () => ({ top: 100, height: 40 }) },
	clientY: 135,
	dataTransfer: { dropEffect: '' }
});
dragTree = renderSettings();
dragRows = collectByClass(dragTree, 'dsb-row');
const highlighted = dragRows.filter((row) => String(row.props.className).indexOf('dsb-over-after') !== -1);
assert.strictEqual(highlighted.length, 1, '下半区应有一条底边高亮，实际 ' + highlighted.length);
highlighted[0].props.onDrop({ preventDefault() {} });
const afterDrag = JSON.parse(store.get(CONFIG_KEY)).segments;
assert.deepStrictEqual(afterDrag,
	['counts', 'cacheHit', 'ttft', 'status', 'tps', 'sessionTime', 'lastCost', 'cost', 'balance', 'tokens'],
	'拖到下半区应插在目标之后，实际 ' + JSON.stringify(afterDrag));
console.log('拖动：下半区落点正确');

console.log('\nALL CHECKS PASSED');
