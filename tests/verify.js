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
  '\t\texports.__test = { segmentView, segmentText, detectLocale, formatDuration, formatSeconds, formatThroughput, SEGMENTS, DEFAULT_SEGMENTS, STORAGE_KEY, snapshot, StatusBar, SettingsSection, dropIndexAt, moveItem };\n' + marker);

const store = new Map();
/* 预置一份"乱序 + 只勾四段 + 非默认币种"的旧配置：出厂默认要从这种状态拉回来 */
const CONFIG_KEY = 'dsh.desktopStatusBar.v1';
const MESSY_SEGMENTS = ['cost', 'sessionTime', 'status', 'counts'];
store.set(CONFIG_KEY, JSON.stringify({
	version: 5, enabled: true, wrap: false,
	/* task-22 起 `currency` 降级为"**新增条目的默认币种**"（不再是全局计价单位）：迁移时用它给已有条目定币种，
	   此后的切换只作用被切的那一条，不改写这里，也不改写别的条目。这里种 CNY 与出厂默认一致。 */
	segments: MESSY_SEGMENTS.slice(), currency: 'CNY', models: {}
}));
const fakeWindow = {
	/* 「去 GitHub 点 star」按钮点下去要开默认浏览器：这里只记下 window.open 收到了什么 */
	open: (url, target) => { fakeWindow.opened.push([url, target]); },
	opened: [],
	localStorage: {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, v); },
		removeItem: (k) => { store.delete(k); }
	},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) }),
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout: () => 0,
	clearTimeout: () => {},
	addEventListener: () => {},
	removeEventListener: () => {},
	/* 气泡定位替身：面板宽度与圆圈灰底的左边界由测试按需给（见下面「气泡水平位置」那一段） */
	innerWidth: 1280,
	innerHeight: 800
};

let captured = null;
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
		head: { appendChild() {} },
		addEventListener: () => {},
		removeEventListener: () => {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	/* 悬停浮层的收起是延后 110ms 的（防相邻格子之间闪断）：这里给空壳，不让真定时器吊住进程 */
	setTimeout: () => 0, clearTimeout: () => {}
};
sandbox.globalThis = sandbox;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

/* React 替身：hooks 按组件分桶保存，点击后重新渲染就能读到最新 state */
let activeHooks = null;
function makeHooks() { return { values: [], deps: [], index: 0 }; }
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

/* 行的假几何：拖动时组件要量各行位置，替身按渲染顺序给递增的 top（每行 40 高） */
let rowSeq = 0;
/* 定位 effect 平时不跑（替身里的 useEffect 只占位），要验气泡坐标的那一段再打开 */
let runEffects = false;
/* 气泡面板的宽度与圆圈灰底的左边界：由测试按需改，模拟真实 DOM 量出来的值 */
let stubTipWidth = 0;
let stubRingLeft = 120;
const stubRect = (left, width) => ({ left: left, width: width, right: left + width, top: 700, height: 20, bottom: 720 });
/* 圆环**按钮**（灰底就是它画的：padding 3px + border-radius 50% → 20px 的圆）。
   气泡左对齐的基准是它，不是里面那个 14px 的 .dsb-ring SVG。 */
const stubRing = { getBoundingClientRect: () => stubRect(stubRingLeft, 20) };
/* 底栏最右那一项（末尾字段）：右对齐/宽度上限都按它的右边界算 */
let stubBarRight = 985;
const stubLastSeg = { getBoundingClientRect: () => stubRect(stubBarRight - 170, 170) };
const reactStub = {
	createElement(type, props, ...children) {
		const node = {
			type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
		};
		const cls = typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
		if (typeof node.props.className === 'string' && node.props.className.indexOf('dsb-row') !== -1) {
			rowSeq += 1;
			const at = rowSeq;
			node.getBoundingClientRect = () => {
				/* 行高 40、行距 48：真实设置页的 .dsb-section 有 gap，替身也得留着这个间隔，
				   否则"按序号×行高推算槽位"这种错法在测试里永远看不出来 */
				const top = 100 + (at - 1) * 48;
				return { top: top, height: 40, bottom: top + 40, left: 0, width: 300 };
			};
		}
		/* 气泡面板：宽度由 CSS 的 max-content 决定，替身里由 stubTipWidth 给 */
		if (cls.indexOf('dsb-tip') !== -1) node.getBoundingClientRect = () => stubRect(0, stubTipWidth);
		/* 状态栏根节点：定位要按它里面的圆圈灰底量左边界，按最右那一项量右边界 */
		if (cls.indexOf('dsb-root') !== -1) {
			node.querySelector = (selector) => (selector === '.dsb-ring-btn' ? stubRing : null);
			node.querySelectorAll = (selector) => (selector === '.dsb-seg' ? [stubLastSeg] : []);
		}
		if (typeof node.props.ref === 'function') node.props.ref(node);
		/* 对象 ref 在替身里也要真的挂上节点（只认气泡/根节点这几个，别的 ref 装着别的东西） */
		const box = node.props.ref;
		const mountable = cls.indexOf('dsb-tip') !== -1 || cls.indexOf('dsb-root') !== -1;
		if (mountable === true && box !== null && typeof box === 'object'
			&& (box.current === null || box.current === undefined)) {
			box.current = node;
		}
		return node;
	},
	useState: (init) => {
		const slot = hookSlot(init);
		return [slot.get(), slot.set];
	},
	useEffect: (fn, deps) => {
		const at = activeHooks === null ? -1 : activeHooks.index;
		hookSlot(undefined);
		if (runEffects !== true || typeof fn !== 'function' || at < 0) return;
		/* 依赖数组照 React 的规矩判：不写依赖数组 = 每次渲染都跑；
		   写了就逐项比，全等才跳过 —— 定位那条 effect 少了依赖数组才量得到新宽度 */
		const prev = activeHooks.deps[at];
		const same = Array.isArray(deps) === true && Array.isArray(prev) === true
			&& deps.length === prev.length && deps.every((one, index) => one === prev[index]);
		activeHooks.deps[at] = Array.isArray(deps) ? deps.slice() : undefined;
		if (same === true) return;
		fn();
	},
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
	segStatus: '峰谷判断', segCounts: '轮次＆步数', segTtft: '首字延迟',
	segContext: '上下文占用',
	segCacheHit: '缓存命中率', segTokens: 'Token计数', segTps: '输出速度', segSessionTime: '运行用时',
	segCost: '会话费用', segLastCost: '本次费用', segBalance: '余额',
	f_status_running: '运行中', f_status_idle: '空闲', f_status_error: '出错',
	f_counts: '{turns} 轮 {steps} 步',
	f_ttft: '首字平均 {duration}', f_cacheHit: '综合命中 {percent}%',
	f_peak: '高峰', f_valley: '低谷', f_approval: '待批准',
	f_tokens: '{total} tokens',
	f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出',
	f_speed: '综合速度 {throughput}t/s', f_sessionTime: '总用时 {duration}',
	f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
	f_balance: '余额 {symbol}{amount}', f_balanceLoading: '余额 查询中', f_balanceFailed: '余额 失败({reason})',
	unitCountTurns: ' 轮', unitCountSteps: ' 步',
	unitCountCalls: ' 次',
	tipCountsTitle: '会话数据', tipCountsSkills: '技能注入', tipCountsToolCalls: '工具调用',
	tipCountsCompactAt: '上下文压缩',
	tipCompactItem: '第{index}次压缩', tipCompactWhere: '第{turn}轮{step}步', tipCompactTurnOnly: '第{turn}轮',
	unitCost: '', unitSeconds: ' s', unitSpeed: ' t/s', unitMinutes: ' m',
	modelUnknown: '未识别',
	segContextHint: '当前会话的运行状态与上下文占用。',
	secSegments: '数据字段', secPrices: '自定义模型价格', secPreview: '预览（示例数据）',
	secSegmentsHint: '勾选显示；按住拖动调整顺序。',
	intro: '接管对话区底部的统计行。勾选要显示的字段、拖动调整顺序或配置模型费用单价。',
	priceCurrent: '当前会话使用：', priceConfigured: '已配置', priceNotConfigured: '未配置价格，费用段显示横杠占位',
	priceAdd: '添加', priceNewModel: '新模型', priceRemove: '删除', priceEmpty: '价格库为空', reset: '恢复默认设置',
	starRepo: 'GitHub支持', starTip: '你的支持是我最大的动力！请帮我点亮Star吧~',
	holidayUpdateOk: '已写入 {year} 年 {count} 个节假日',
	priceInput: '输入(缓存未命中)', priceCacheRead: '输入(缓存命中)', priceOutput: '输出',
	priceTierPeak: '高峰时段', priceTierOffPeak: '空闲时段', priceTiered: '峰谷计价',
	priceTierAllDay: '全时段',
	priceEdit: '修改', priceSave: '保存', priceCurrency: '币种',
	secPricesHint: '填写你使用的模型单价。', peakNow: '当前处于{period}', offPeakNow: '当前处于{period}',
	peakPeriod: '高峰期', offPeakPeriod: '空闲时段',
	dragHint: '拖动排序', diagChecking: '余额接口：查询中…',
	f_balanceDash: '余额 {symbol}-', balanceAt: '余额数据时间 {time}'
};
const t = (key, params) => {
	let out = zh[key] !== undefined ? zh[key] : ('<' + key + '>');
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
assert.strictEqual(api.detectLocale(t), 'zh', 'locale detection should resolve zh');

/* 出厂默认 = 全部段 + 截图顺序；下面所有渲染都用这一份 */
const FACTORY_ORDER = ['status', 'counts', 'cacheHit', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'];
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
assert.ok(bar.includes('综合命中 - %'), 'cacheHit placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('首字平均 - s'), 'ttft placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('综合速度 -'), 'tps placeholder, got: ' + bar.join(' | '));
assert.ok(bar.includes('总用时 -m -s'), 'sessionTime placeholder, got: ' + bar.join(' | '));
/* 会话刚开跑（running）时本轮就该是 0.00；空闲又没数据才退回占位横杠 */
assert.ok(bar.includes('本轮 ¥-'), 'lastCost shows a dash before the turn produces any call, got: ' + bar.join(' | '));
const idleBar = render(Object.assign({}, emptySrc, { running: false }));
/* 空闲又没数据时本轮也给 ¥0.00：底栏长度稳定，不会整段消失 */
assert.ok(idleBar.some((one) => one.includes('本轮 ¥-')), 'lastCost shows 0.00 when idle without data, got: ' + idleBar.join(' | '));
/* 总计从第一轮起就显示金额：没有可计价的调用时给 ¥0.00，不用占位横杠（底栏宽度也稳定） */
assert.ok(emptyAll.some((one) => one.includes('总计 ¥-')), 'cost shows 0.00 without priced calls, got: ' + emptyAll.join(' | '));
/* 这份 src 没有 sessionModel：非 DeepSeek 会话里余额整段不出现，连占位符都不留 */
/* 非 DeepSeek 会话：余额段仍在栏里（余额 -），只是不给账户数字 */
assert.ok(emptyAll.some((one) => one.includes('余额 ¥-')), 'balance stays in the bar for non-DeepSeek sessions, got: ' + emptyAll.join(' | '));
assert.ok(!emptyAll.some((x) => x.includes('tokens')), 'token 段已并入总计，不该再单独占一段：' + emptyAll.join(' | '));

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
assert.ok(fullBar.includes('首字平均 9.3s'), 'ttft 按秒显示（92500/10 = 9250ms → 9.3s），got: ' + fullBar.join(' | '));
assert.ok(fullBar.includes('总用时 1h30m'), 'sessionTime switches to h/m, got: ' + fullBar.join(' | '));
/* 总用时不足一分钟：只给整数秒，不带小数点 */
const shortSrc = Object.assign({}, fullSrc, { timeRange: { turns: 40400, since: null, steps: 0, stepSince: null } });
const shortBar = render(shortSrc, allSegs);
assert.ok(shortBar.includes('总用时 40s'), 'sub-minute sessionTime shows whole seconds, got: ' + shortBar.join(' | '));
assert.ok(!/总用时 \d+\.\d+s/.test(shortBar.join(' | ')), 'sub-minute sessionTime has no decimal point, got: ' + shortBar.join(' | '));
assert.ok(/98\.46%/.test(fullBar.join(' | ')), 'cache percent, got: ' + fullBar.join(' | '));
assert.ok(/\d+t\/s/.test(fullBar.join(' | ')), 'throughput has no space before unit, got: ' + fullBar.join(' | '));
assert.ok(fullBar.includes('余额 ¥12.34'), 'balance value');
assert.ok(fullBar.includes('总计 ¥0.23'), 'session cost, got: ' + fullBar.join(' | '));

/* ---------------------------------------------------------------- 格式函数 */
assert.strictEqual(api.formatDuration(0), null, 'zero duration is null');
assert.strictEqual(api.formatDuration(4500), '5s', 'sub-minute rounds to whole seconds');
assert.strictEqual(api.formatDuration(27000), '27s', '27s');
assert.strictEqual(api.formatDuration(455000), '7m35s', '7m35s, no space');
assert.strictEqual(api.formatDuration(155000), '2m35s', '2m35s');
assert.strictEqual(api.formatSeconds(9250), '9.3', '9250ms → 9.3s（一位小数）');
assert.strictEqual(api.formatSeconds(1402.7), '1.4', '小数毫秒四舍五入到一位小数');
assert.strictEqual(api.formatSeconds(299), '0.3', '不足 0.5 秒也保留一位小数');
assert.strictEqual(api.formatSeconds(0), null, 'zero ttft is null');
assert.strictEqual(api.formatDuration(5400000), '1h30m', '1.5h -> 1h30m');
assert.strictEqual(api.formatDuration(3600000), '1h0m', 'exactly 1h');
assert.strictEqual(api.formatDuration(3599000), '59m59s', 'just under 1h');
assert.strictEqual(api.formatDuration(125000), '2m5s', '125s -> 2m5s');
assert.strictEqual(api.formatDuration(40400), '40s', '40.4s renders as 40s, no decimal');
assert.strictEqual(api.formatDuration(45500), '46s', 'rounds to the nearest second');
assert.strictEqual(api.formatThroughput(12345.6), '12346', 'throughput no k abbreviation');

/* ------------------------------------------------------------ 余额异常分支 */
/* 余额分支要 DeepSeek 会话才渲染（非 DeepSeek 会话里余额整段不出现） */
const deepSeekSrc = { ...emptySrc, sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' } };
const midBar = render({ ...deepSeekSrc, balance: null }, allSegs);
console.log('余额查询中：', midBar.join(' | '));
assert.ok(midBar.includes('余额 ¥-'), 'balance loading shows label + dash, got: ' + midBar.join(' | '));
const failBar = render({ ...deepSeekSrc, balance: { ok: false, reason: 'fetch-failed' } }, allSegs);
console.log('余额失败：', failBar.join(' | '));
assert.ok(failBar.includes('余额 ¥-'), 'balance failure shows label + dash, got: ' + failBar.join(' | '));

/* ---------------------------------------------------- WorkBuddy 积分口径 */
/* 实测 2026-10-07：WorkBuddy 会话的余额是积分，不是钱。
   积分不能带货币符号（否则显示成「余额 ¥177」），而且整个气泡都不该出现。 */
const wbSrc = { ...emptySrc, sessionModel: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash-sg' } };
const wbBar = render({ ...wbSrc, balance: { ok: true, total: '177', currency: '', isCredits: true } }, allSegs);
console.log('WorkBuddy 积分：', wbBar.join(' | '));
assert.ok(wbBar.includes('余额 177'), '积分总数照常显示，got: ' + wbBar.join(' | '));
assert.ok(!wbBar.includes('¥177'), '积分不带货币符号（不能显示成 ¥177），got: ' + wbBar.join(' | '));
/* 积分没有构成可展开 ⇒ 不给 tip。渲染处按 tip !== null 决定 className 与 onClick，
   没有 tip 就不是可点击项、点不出气泡、悬停也不弹。 */
const wbView = api.segmentView('balance', { ...wbSrc, balance: { ok: true, total: '177', currency: '', isCredits: true } }, t);
assert.strictEqual(wbView.tip, undefined, '积分不给气泡（没有可展开的内容，弹空气泡会误以为能点）');
/* 失败态 / 查询中：也要按积分口径显示，别又冒出一个 ¥，同样不给气泡 */
const wbMid = render({ ...wbSrc, balance: null }, allSegs);
assert.ok(wbMid.includes('余额 -') && !wbMid.includes('¥'), 'WorkBuddy 查询中也按积分口径（无 ¥），got: ' + wbMid.join(' | '));
assert.strictEqual(api.segmentView('balance', { ...wbSrc, balance: null }, t).tip, undefined, '查询中也不给气泡');
const wbFail = render({ ...wbSrc, balance: { ok: false, reason: 'no-credits' } }, allSegs);
assert.ok(wbFail.includes('余额 -') && !wbFail.includes('¥'), 'WorkBuddy 失败态同样无 ¥，got: ' + wbFail.join(' | '));
assert.strictEqual(api.segmentView('balance', { ...wbSrc, balance: { ok: false, reason: 'no-credits' } }, t).tip, undefined, '失败态也不给气泡');
/* 非积分平台不受影响：DeepSeek 会话仍带 ¥，且气泡照旧 */
assert.ok(fullBar.includes('余额 ¥12.34'), 'DeepSeek 等货币口径仍带 ¥');
const dsView = api.segmentView('balance', { ...deepSeekSrc, balance: { ok: true, total: '12.34', currency: 'CNY' } }, t);
assert.ok(dsView.tip !== undefined, 'DeepSeek 货币口径仍要有气泡');
assert.ok(dsView.tip.rows.length > 0, '货币口径的气泡仍有构成行');

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
/* 替身的位置每次渲染都从同一套几何重新开始：真实 DOM 的行本来就不动，
   不重置的话「按下时量到的位置」和「下一次渲染量到的位置」会差出好几行。 */
const renderSettings = () => {
	rowSeq = 0;
	return withHooks(settingsHooks, () => api.SettingsSection(props));
};
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
assert.ok(settings.includes('按住拖动调整顺序'), 'settings hint should describe drag reorder');
assert.ok(!settings.includes('基础'), '设置页不再有「基础」区块');
assert.ok(!settings.includes('启用状态栏') && !settings.includes('允许换行'), '启用状态栏 / 允许换行 两个开关已移除');
/* task-19：编辑浮层底部自动滚入改成"按底边差值滚最近的可滚祖先 + 下一帧补一次"，
   不再用浏览器自带的 scrollIntoView（它只保证顶部对齐，且滚不动面板内部的可滚容器）。 */
assert.ok(!code.includes('scrollIntoView('), '编辑浮层不该再用 scrollIntoView（task-19 已换实现）');
assert.ok(code.includes('function revealBottom(node)'), '底部自动滚入要有独立实现');
assert.ok(code.includes('scroller.scrollTop = (typeof scroller.scrollTop === "number" ? scroller.scrollTop : 0) + overflow'),
	'按"底边 + 余量 − 容器可视底边"的差值加 scrollTop');
assert.ok(code.includes('if (overflow <= 0) return;'), '没被遮住时一动不动（不平白往上滚）');
assert.ok(code.includes('window.requestAnimationFrame(retry)'), '稳定后补滚一次走 rAF（不是定时器）');
/* task-21：底边滚入统一成一个钩子 `useRevealBottom(ref, active, extraKey)`，**恰好两处调用**
   （价格编辑浮层 / 币种菜单）；气泡、跟手浮层、悬停提示有意不接。 */
const revealLines = code.split('\n').filter((one) => one.indexOf('useRevealBottom(') !== -1);
assert.strictEqual(revealLines.length, 3,
	'useRevealBottom 恰好三处调用（定义那行是 `useRevealBottom = (`，不匹配）：价格浮层 / 条目币种菜单 / 默认币种菜单，实际 ' + revealLines.length);
assert.strictEqual((code.match(/const useRevealBottom = \(ref, active, extraKey\)/g) || []).length, 1,
	'只有一份实现（不要各写一份）');
assert.ok(code.includes('useRevealBottom(editPopRef, editing !== null'), '第一处：价格编辑浮层');
assert.ok(code.includes('useRevealBottom(currencyMenuRef, currencyOpen === true, null)'), '第二处：条目币种菜单');
assert.ok(code.includes('useRevealBottom(defaultCurrencyMenuRef, defaultCurrencyOpen === true, null)'),
	'第三处：新增条目的默认币种菜单（task-22 新加）');
const wiredRefs = ['editPopRef', 'currencyMenuRef', 'defaultCurrencyMenuRef'];
revealLines.forEach((one) => {
	assert.ok(wiredRefs.some((ref) => one.indexOf(ref) !== -1),
		'useRevealBottom 只允许接在这三个下拉/浮层上，实际这行：' + one.trim());
});
['dsb-tip', 'dsb-drag-card', 'dsb-star-tip'].forEach((cls) => {
	assert.ok(revealLines.every((one) => one.indexOf(cls) === -1),
		cls + ' 不该接 useRevealBottom（气泡向上展开、跟手浮层跟指针、悬停提示会抢用户操作）');
});
assert.strictEqual((code.match(/setInterval\(/g) || []).length, 2, '定时器仍只有两处（时钟 + 余额轮询）');
assert.ok(code.includes('className: "dsb-select-menu", role: "listbox", ref: menuRef'),
	'币种菜单的 ref 挂在**菜单节点**上（不是那个按钮）');
assert.ok(code.includes('currencySelect("__entrycur", { kind: "entry", draft: draft }, currencyOpen, setCurrencyOpen, currencyMenuRef'),
	'条目级选择器把菜单 ref 传进 currencySelect');
assert.ok(code.includes('currencySelect("__defcurpick", { kind: "default" }, defaultCurrencyOpen, setDefaultCurrencyOpen, defaultCurrencyMenuRef'),
	'默认币种选择器把菜单 ref 传进 currencySelect');
assert.ok(settings.includes('上下文占用'), '设置页要出现上下文占用开关');

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
assert.strictEqual(saved.currency, 'CNY', '恢复默认设置应恢复**默认币种**（task-22 起它只是新增条目的默认值）');
assert.strictEqual(saved.contextMeter, true, '恢复默认设置应恢复上下文占用开关');
assert.deepStrictEqual(segmentNames(renderSettings()), factoryLabels, '恢复默认设置后设置页顺序应等于出厂顺序');
console.log('恢复默认设置后：', saved.segments.join(' → '));

/* 「恢复默认」只回**界面配置**，不得动用户的价格库：改过的官方模型、自造模型、明确填的 0 都要原样还在。
   关键：插件的 config 是**模块加载时读一次**（`let config = loadConfig()`），之后 `setConfig` 只合并
   内存里那一份并写回 store —— 所以"加载后再 store.set 换配置"是无效的（那份新配置进不了内存）。
   这里按"**先种配置、再加载模块**"另起一份沙箱 + 独立 store 来验，免得动到上面主流程的夹具。 */
{
	const store2 = new Map();
	const USER_MODELS = {
		'deepseek-flash': {
			tiered: false,
			peak: { input: 1.5, cacheRead: 0, cacheWrite: 0, output: 8 },
			offPeak: { input: 0.02, cacheRead: 0.02, cacheWrite: 0, output: 0.1 }
		},
		'my-own-model': {
			tiered: true,
			peak: { input: 9, cacheRead: 1, cacheWrite: 0, output: 20 },
			offPeak: { input: 4.5, cacheRead: 0.5, cacheWrite: 0, output: 10 }
		},
		'zero-model': {
			tiered: false,
			peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
			offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null }
		}
	};
	store2.set(CONFIG_KEY, JSON.stringify({
		version: 5, priceVersion: 2, enabled: true, wrap: false,
		segments: MESSY_SEGMENTS.slice(), hidden: ['counts'],
		/* task-22 起 `currency` 只是"新增条目的默认币种"（不再全局换算）；恢复默认仍不得动价格库。 */
		currency: 'USD', contextMeter: false, models: USER_MODELS
	}));
	let captured2 = null;
	const window2 = Object.assign({}, fakeWindow, {
		opened: [],
		localStorage: {
			getItem: (k) => (store2.has(k) ? store2.get(k) : null),
			setItem: (k, v) => { store2.set(k, v); },
			removeItem: (k) => { store2.delete(k); }
		}
	});
	window2.__ModuleLoader__ = { load: (entry) => { captured2 = entry; } };
	const sandbox2 = {
		window: window2,
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
			head: { appendChild() {} },
			addEventListener: () => {}, removeEventListener: () => {}
		},
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
		setTimeout: () => 0, clearTimeout: () => {}
	};
	sandbox2.globalThis = sandbox2;
	vm.createContext(sandbox2);
	vm.runInContext(code, sandbox2, { filename: 'client.js' });
	const api2 = captured2.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
	const modelsInMemory = api2.snapshot().models;   /* 加载后内存里那一份（可能被归一化过，所以拿它当基准） */
	assert.deepStrictEqual(Object.keys(modelsInMemory).sort(), ['deepseek-flash', 'my-own-model', 'zero-model'],
		'前置：内存里的价格库就是用户那份（3 个模型，没被官方参考价合并）');
	const hooks2 = makeHooks();
	const resetBtn2 = (function find(node) {
		let found = null;
		(function walk(n) {
			if (found !== null || n === null || n === undefined || typeof n !== 'object') return;
			if (Array.isArray(n)) { n.forEach(walk); return; }
			if (n.type === 'button' && textOf(n) === t('reset')) { found = n; return; }
			walk(n.children);
		})(node);
		return found;
	})(withHooks(hooks2, () => api2.SettingsSection(props)));
	assert.ok(resetBtn2 !== null, '（独立沙箱）恢复默认按钮仍在');
	resetBtn2.props.onClick();
	const afterReset = JSON.parse(store2.get(CONFIG_KEY));
	assert.deepStrictEqual(afterReset.segments, FACTORY_ORDER, '界面配置仍要回到出厂顺序');
	assert.deepStrictEqual(afterReset.hidden, [], '界面配置仍要清空未勾选标记');
	assert.strictEqual(afterReset.currency, 'CNY', '界面配置仍要回到默认**币种**（task-22 起只是新增条目的默认值）');
	assert.strictEqual(afterReset.contextMeter, true, '界面配置仍要回到默认开关');
	/* 价格库逐字段不变（用加载后的内存那份当基准，避免把归一化当成 bug）。
	   注意 vm 出来的对象原型与主域不同，deepStrictEqual 会因此失败 —— 两边都先 JSON 化。 */
	const plain = (value) => JSON.parse(JSON.stringify(value));
	assert.deepStrictEqual(plain(afterReset.models), plain(modelsInMemory),
		'「恢复默认」不得动价格库：改过的官方模型 / 自造模型 / 明确填的 0 都要逐字段还在');
	assert.strictEqual(afterReset.models['deepseek-flash'].peak.input, 1.5, '用户改过的官方模型价还在');
	assert.strictEqual(afterReset.models['deepseek-flash'].peak.cacheRead, 0, '用户明确填的 0 还在（不是 null）');
	assert.deepStrictEqual(afterReset.models['my-own-model'].peak, { input: 9, cacheRead: 1, cacheWrite: 0, output: 20 },
		'自造模型两档价原样保留');
	assert.strictEqual(afterReset.models['zero-model'].peak.cacheRead, 0, '明确填 0 的条目仍是 0');
	console.log('恢复默认：界面配置回默认，价格库逐字段不变（' + Object.keys(afterReset.models).length + ' 个模型）');
}

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
/* 按显示名取价格卡；价格卡里每个 dsb-field 恰好一个数字输入框。
   cardByKey 用卡片的 key（= 价格库里的模型名）取，避免去猜显示名的大小写规则。 */
const cardByName = (tree, display) => modelCards(tree)
	.filter((card) => textOf(collectByClass(card, 'dsb-model-name')[0]) === display)[0];
const cardByKey = (tree, key) => modelCards(tree).filter((card) => card.props.key === key)[0];
const numberValues = (card) => collectByClass(card, 'dsb-field')
	.map((label) => findInput(label, 'number').props.value);

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
assert.deepStrictEqual(collectByClass(cards[0], 'dsb-tier-name').map(textOf), ['全时段'], '全天同价要显示「全时段」档位名（task-19：不再靠"没有档位名"做双边对齐）');

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
/* 全天同价只影响"用哪一档"（tiered），取消勾选**不丢已填值**：
   单档显示/使用的就是 peak 那一行（peak → peak 同一行，不存在串档），
   "只在勾上时清空"是 Lead 的裁决（双向清空会静默丢掉用户没动过的价格）。 */
assert.strictEqual(flash.offPeak.cacheRead, 0.02, '取消勾选峰谷计价后，空闲价仍保留原值');

/* 计价单位（task-22：币种改成**每个条目自带**）：
   ① 条目级选择器在编辑浮层里，切换只换算**被切的那一条**（数值按参考价比例、6 位小数）；
   ② 顶部选择器只管"新增条目的默认币种"，一个已有条目都不许动；
   ③ 全局 `currency` 字段（迁移后的默认值）在两处切换里都不被改写。 */
const RATE = 6.742424242424242;   /* 人民币 ÷ 该值 = 美元（官方两张参考价表推出来的） */
const proCard = modelCards(priceTree).filter((one) => textOf(one).indexOf('V4-Pro') !== -1)[0];
buttonByLabel(proCard, '修改').props.onClick();
priceTree = renderSettings();
assert.strictEqual(collectByClass(priceTree, 'dsb-default-currency').length, 1,
	'价格区顶部有「新增条目的默认币种」那个选择器');
const entryPick = collectByClass(collectByClass(cardByKey(priceTree, 'deepseek-v4-pro'), 'dsb-edit-pop')[0], 'dsb-currency-pick')[0];
assert.ok(entryPick !== undefined, '条目级选择器在**编辑浮层里**（不是顶部那个）');
const entryBtn = collectByClass(entryPick, 'dsb-select-btn')[0];
assert.strictEqual(textOf(entryBtn), 'CNY', '条目币种初值 = 迁移落下来的默认币种');
assert.strictEqual(collectByClass(entryBtn, 'dsb-select-menu').length, 0, '没点开时不渲染菜单');
const beforeModels = JSON.parse(store.get(api.STORAGE_KEY)).models;
assert.strictEqual(beforeModels['deepseek-v4-pro'].currency, 'CNY', '前置：迁移把已有条目落成显式 currency');
entryBtn.props.onClick();
priceTree = renderSettings();
const usdItem = collectByClass(priceTree, 'dsb-select-item').filter((one) => textOf(one) === 'USD')[0];
assert.ok(usdItem !== undefined, '菜单里有 USD');
usdItem.props.onClick();
const afterEntry = JSON.parse(store.get(api.STORAGE_KEY));
assert.strictEqual(afterEntry.models['deepseek-v4-pro'].currency, 'USD', '被切的那一条改成 USD');
assert.deepStrictEqual(afterEntry.models['deepseek-v4-pro'].peak,
	{ input: 1.334831, cacheRead: 0.044494, cacheWrite: 0, output: 4.004494 },
	'该条目的数字按参考价比例换算（¥9 / 0.3 / 27 ÷ ' + RATE + '，6 位小数）');
assert.deepStrictEqual(afterEntry.models['deepseek-v4-pro'].offPeak,
	{ input: 0.667416, cacheRead: 0.022247, cacheWrite: 0, output: 2.002247 }, '空闲档同样换算');
assert.deepStrictEqual(afterEntry.models['deepseek-flash'], beforeModels['deepseek-flash'],
	'其它条目**逐字段不变**（切换只作用被切的那一条）');
assert.strictEqual(afterEntry.currency, 'CNY', '切换条目币种**不改写**默认币种字段');
/* 打开着的这张卡立刻显示新币种的数字 */
priceTree = renderSettings();
const editPop = collectByClass(priceTree, 'dsb-edit-pop')[0];
assert.ok(editPop !== undefined, '编辑区渲染成毛玻璃浮层');
const shownValues = [];
(function walkInputs(node) {
	if (node === null || node === undefined || typeof node !== 'object') return;
	if (Array.isArray(node)) { node.forEach(walkInputs); return; }
	if (node.type === 'input') shownValues.push(node.props.value);
	walkInputs(node.children);
})(editPop);
assert.ok(shownValues.indexOf('4.004494') !== -1,
	'正在编辑的这张卡立刻换成新币种的数字，实际 ' + JSON.stringify(shownValues));
/* 顶部选择器：只管"新增条目的默认币种"，一个已有条目都不动 */
const defaultBtn = collectByClass(collectByClass(renderSettings(), 'dsb-default-currency')[0], 'dsb-select-btn')[0];
assert.strictEqual(textOf(defaultBtn), 'CNY', '顶部默认币种初值 CNY');
defaultBtn.props.onClick();
priceTree = renderSettings();
collectByClass(priceTree, 'dsb-select-item').filter((one) => textOf(one) === 'USD')[0].props.onClick();
const afterDefault = JSON.parse(store.get(api.STORAGE_KEY));
assert.strictEqual(afterDefault.currency, 'USD', '默认币种写进配置（它只管新增条目）');
assert.deepStrictEqual(afterDefault.models, afterEntry.models, '切换默认币种**一个已有条目都不动**');
console.log('计价单位：条目级切换只换算这一条（¥9→$1.334831）· 其它条目逐字段不变 · 顶部选择器只管新增条目的默认币种');

/* 点别处收起编辑浮层并丢弃草稿：effect 里挂 document click → 落在浮层外就 cancelEdit。
   这里的效果钩子在测试沙箱里是空实现，所以用源码契约守住这两步。 */
assert.ok(code.includes('const inside = (event) => {'), '点浮层外面才收起（先判断在不在里面）');
assert.ok(code.includes('target.closest(".dsb-model") !== null'), '价格卡里的控件不算"外面"（切币种时编辑区不该被收掉）');
assert.ok(code.includes('cancelEdit();'), '收起时丢弃草稿（不保留改了一半的数字）');
assert.ok(code.includes('event.stopPropagation();'), '头部按钮拦截冒泡，点保存/修改不会被"点别处"顺手收掉');
console.log('编辑浮层：点别处收起并丢弃草稿（契约守住）');
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
assert.strictEqual(savedModels()['glm-5.3-flash'].currency, 'USD',
	'新增条目带上「新增条目的默认币种」（上一节已把它切成 USD）');
assert.strictEqual(collectByClass(priceTree, 'dsb-models').length, 1, '模型列表应有一个容器');
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash'], '新模型应排在列表最后');
/* 需求 1：刚新增的条目展开时三个框留空等用户输入，不预填 0 */
assert.deepStrictEqual(numberValues(added), ['', '', ''],
	'新条目展开时三个框要留空，实际 ' + JSON.stringify(numberValues(added)));

/* 整数样式的模型名（如 "1"）也不能跑到最前 */
findInput(priceTree, 'text').props.onChange({ target: { value: '1' } });
priceTree = renderSettings();
buttonByLabel(priceTree, '添加').props.onClick();
priceTree = renderSettings();
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash', '1'], '纯数字模型名同样排最后');

/* 需求 C（task-5）：两档所有字段都是空字符串 = 用户什么都没填 ⇒ 不写入价格库
   （新增条目等于取消添加）；只要明确填过数字（**包括明确填 0**）就写入，空着的格子按 0。
   此刻展开的是刚加的那条「1」，草稿全空 —— 正好用来验第一件事。 */
const justAdded = cardByName(priceTree, '1');
assert.deepStrictEqual(numberValues(justAdded), ['', '', ''],
	'新加的条目展开时三个框要留空，实际 ' + JSON.stringify(numberValues(justAdded)));
buttonByLabel(justAdded, '保存').props.onClick();
assert.strictEqual(Object.prototype.hasOwnProperty.call(savedModels(), '1'), false,
	'一个字都没填就保存 ⇒ 不写入价格库（新增等于取消添加）');
priceTree = renderSettings();
assert.strictEqual(cardByName(priceTree, '1'), undefined, '取消添加后卡片也不该留在列表里');
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash'], '列表回到添加之前的样子');

/* 明确填一个 0、另一个填 5：条目要写入，填过的格子保数字、没填的格子留 null */
const numberInputs = (card) => collectByClass(card, 'dsb-field').map((label) => findInput(label, 'number'));
const setNumberField = (key, index, value) => {
	priceTree = renderSettings();
	numberInputs(cardByKey(priceTree, key))[index].props.onChange({ target: { value: value } });
};
findInput(priceTree, 'text').props.onChange({ target: { value: 'zero-kept' } });
priceTree = renderSettings();
buttonByLabel(priceTree, '添加').props.onClick();
priceTree = renderSettings();
assert.deepStrictEqual(numberValues(cardByKey(priceTree, 'zero-kept')), ['', '', ''], '新条目草稿同样留空');
setNumberField('zero-kept', 0, '0');   /* 缓存命中：明确填 0 */
setNumberField('zero-kept', 1, '5');   /* 输入：有值 */
priceTree = renderSettings();
buttonByLabel(cardByKey(priceTree, 'zero-kept'), '保存').props.onClick();
const zeroSaved = savedModels()['zero-kept'];
assert.ok(zeroSaved !== undefined, '填过数字就该写入价格库');
assert.deepStrictEqual(zeroSaved.peak, { input: 5, cacheRead: 0, cacheWrite: null, output: null },
	'明确填的 0 保留成数字 0、没填的格子留 null（不再被写成 0）');
assert.deepStrictEqual(zeroSaved.offPeak, { input: null, cacheRead: null, cacheWrite: null, output: null },
	'单档条目里用户没碰过的那一档整档 null');
priceTree = renderSettings();
buttonByLabel(cardByKey(priceTree, 'zero-kept'), '修改').props.onClick();
priceTree = renderSettings();
assert.deepStrictEqual(numberValues(cardByKey(priceTree, 'zero-kept')), ['0', '5', ''],
	'再打开时逐格回显：填过的显示数字（0 也显示 0），没填的留空，实际 '
	+ JSON.stringify(numberValues(cardByKey(priceTree, 'zero-kept'))));

/* 非 0 的真实数值同样按原样回填，顺序是 缓存命中 / 输入 / 输出（分档时先空闲后高峰） */
buttonByLabel(cardByName(priceTree, 'DeepSeek-V4-Pro'), '修改').props.onClick();
priceTree = renderSettings();
const proStored = savedModels()['deepseek-v4-pro'];
const proTierKeys = proStored.tiered === false ? ['peak'] : ['offPeak', 'peak'];
const proExpected = [];
proTierKeys.forEach((tier) => ['cacheRead', 'input', 'output']
	.forEach((field) => proExpected.push(String(proStored[tier][field]))));
assert.deepStrictEqual(numberValues(cardByName(priceTree, 'DeepSeek-V4-Pro')), proExpected,
	'编辑已有条目按真实数值回填（' + proTierKeys.join('/') + '），实际 '
	+ JSON.stringify(numberValues(cardByName(priceTree, 'DeepSeek-V4-Pro'))));
console.log('价格库草稿：新增留空 / 全空保存不落库 / 明确填 0 保留 / 已有回填真实数值');

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

/* ------------------------------------ 拖动：自绘 + 松手才落盘（原生 DnD 会吃掉滚轮） */
/* 落点算法先单独测：纯函数，不碰 DOM。
   9 个槽位、行高 40、行距 48（行间有 gap）→ 中线 216/264/312/.../552 */
const slotList = (tops) => tops.map((top) => ({ top: top, height: 40 }));
const nine = slotList([148, 196, 244, 292, 340, 388, 436, 484, 532]);
assert.strictEqual(api.dropIndexAt(nine, 0, 0, 148, 216), 0, '下边界刚好到中线不换位');
assert.strictEqual(api.dropIndexAt(nine, 0, 0, 148, 217), 1, '压过第一行中线 → 索引 1');
assert.strictEqual(api.dropIndexAt(nine, 0, 0, 148, 545), 7, 'gap 累积不会让影子提前落到最后一行');
assert.strictEqual(api.dropIndexAt(nine, 0, 0, 148, 553), 8, '再压一点才落到最后一行');
assert.strictEqual(api.dropIndexAt(nine, 0, 5, 300, 340), 3, '上边界举过上一行中线 → 索引 3');
assert.strictEqual(api.dropIndexAt(nine, 100, 0, 148, 645), 7, '页面滚动 100px 后判定照样成立');
assert.deepStrictEqual(api.moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'], 'moveItem 落位正确');
console.log('落点算法：边界压过中线即换位，gap 与滚动都不影响');

settingsHooks.values.length = 0;
let dragTree = renderSettings();
let dragRows = collectByClass(dragTree, 'dsb-row');
assert.strictEqual(dragRows.length, 10, '上下文占用 1 行 + 段 9 行，实际 ' + dragRows.length);
assert.strictEqual(dragRows[0].props.onPointerDown, undefined, '上下文占用固定在栏首，不参与拖拽');
const rowByKey = (rows, key) => rows.filter((row) => row.props.key === key)[0];
const beforeDrag = JSON.parse(store.get(CONFIG_KEY)).segments;
/* 只有右侧六个点能抓：点行内其他位置不该起浮层 */
rowByKey(dragRows, 'status').props.onPointerDown({
	button: 0, clientY: 160, pointerId: 9,
	target: { tagName: 'SPAN', className: 'dsb-check' },
	currentTarget: {}
});
assert.strictEqual(collectByClass(renderSettings(), 'dsb-drag-card').length, 0, '点行内空白不启动拖动');
/* 按住六点往下拖 90px：下边界越过下面两行的中线 → 落到索引 2 */
rowByKey(dragRows, 'status').props.onPointerDown({
	button: 0, clientY: 160, pointerId: 1,
	target: { tagName: 'SPAN', className: 'dsb-handle' },
	currentTarget: {}
});
dragTree = renderSettings();
dragRows = collectByClass(dragTree, 'dsb-row');
assert.strictEqual(collectByClass(dragTree, 'dsb-drag-card').length, 1, '跟手的浮层已经起来');
assert.ok(String(rowByKey(dragRows, 'status').props.className).indexOf('dsb-dragging') !== -1, '原位留的是淡影');
rowByKey(dragRows, 'status').props.onPointerMove({ clientY: 250 });
assert.deepStrictEqual(JSON.parse(store.get(CONFIG_KEY)).segments, beforeDrag, '拖动过程中不落盘');
dragTree = renderSettings();
dragRows = collectByClass(dragTree, 'dsb-row');
assert.deepStrictEqual(dragRows.slice(1).map((row) => row.props.key),
	['counts', 'cacheHit', 'status', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'],
	'拖动中就按落点排好，实际 ' + JSON.stringify(dragRows.slice(1).map((row) => row.props.key)));
rowByKey(dragRows, 'status').props.onPointerUp({});
assert.deepStrictEqual(JSON.parse(store.get(CONFIG_KEY)).segments,
	['counts', 'cacheHit', 'status', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'],
	'松手才落盘，实际 ' + JSON.stringify(JSON.parse(store.get(CONFIG_KEY)).segments));
assert.strictEqual(collectByClass(renderSettings(), 'dsb-drag-card').length, 0, '松手后浮层收掉');
console.log('拖动：浮层跟手 / 原位留影 / 松手才落盘');

/* ------------------------------------------------ 跟手浮层必须 portal 到 body */
/* 实测 2026-10-07（真机 + 无头 Chrome 复现）：壁纸引擎给设置面板挂了 backdrop-filter
   （body[data-we-glass-window] [role="dialog"]:has([data-slot="settings.section"])），
   而非 none 的 backdrop-filter 会让该元素成为 position:fixed 后代的**包含块** ——
   浮层于是改成相对设置面板定位（实测偏移 dx=220/dy=80），又被面板的 overflow:hidden 裁掉。
   修法是 portal 到 body。这里用一个能 portal 的替身渲染一次，锁住这条路径。 */
{
	const portalCalls = [];
	const bodyNode = { nodeType: 1, tagName: 'BODY' };
	const domStub = {
		createPortal: (node, container) => {
			portalCalls.push({ node: node, container: container });
			return { type: '__portal', props: { node: node, container: container }, children: [] };
		}
	};
	const mod2 = captured.factory((name) => {
		if (name === 'react') return reactStub;
		if (name === 'react-dom') return domStub;
		throw new Error('unexpected require: ' + name);
	});
	const api2 = mod2.__test;
	/* document.body 要存在，代码才会走 portal 分支 */
	const prevBody = sandbox.document.body;
	sandbox.document.body = bodyNode;
	try {
		const rows2 = collectByClass(withHooks(settingsHooks, () => api2.SettingsSection(props)), 'dsb-row');
		rowByKey(rows2, 'status').props.onPointerDown({
			button: 0, clientY: 160, pointerId: 9,
			target: { tagName: 'SPAN', className: 'dsb-handle' },
			currentTarget: {}
		});
		withHooks(settingsHooks, () => api2.SettingsSection(props));
		assert.strictEqual(portalCalls.length, 1, '拖动浮层走 createPortal 渲染，实际调用 ' + portalCalls.length + ' 次');
		assert.strictEqual(portalCalls[0].container, bodyNode, 'portal 容器必须是 document.body（脱离被 backdrop-filter 改锚的祖先）');
		assert.ok(String(portalCalls[0].node.props.className).indexOf('dsb-drag-card') !== -1, 'portal 里送的是浮层节点');
		/* 浮层内部那几件也要跟着过去，否则 portal 后它们会失去样式 */
		const inner = collectByClass(portalCalls[0].node, 'dsb-check');
		assert.strictEqual(inner.length, 1, '浮层里带着勾选框（它的样式已挂到 .dsb-drag-card 名下）');
	} finally {
		sandbox.document.body = prevBody;
	}
	/* 收尾：把这次拖动结束掉，免得影响后面的用例 */
	const rows3 = collectByClass(withHooks(settingsHooks, () => api2.SettingsSection(props)), 'dsb-row');
	rowByKey(rows3, 'status').props.onPointerUp({});
	console.log('拖动浮层：portal 到 body（避开 backdrop-filter 包含块），内部样式随行');
}

/* 指针已被系统吞掉（微信截屏那种）：左键其实已松开，再收到移动就按取消处理 */
const keptOrder = JSON.parse(store.get(CONFIG_KEY)).segments;
rowByKey(dragRows, 'status').props.onPointerDown({
	button: 0, clientY: 160, pointerId: 2,
	target: { tagName: 'SPAN', className: 'dsb-handle' },
	currentTarget: {}
});
dragTree = renderSettings();
dragRows = collectByClass(dragTree, 'dsb-row');
rowByKey(dragRows, 'status').props.onPointerMove({ clientY: 320, buttons: 0 });
dragTree = renderSettings();
assert.strictEqual(collectByClass(dragTree, 'dsb-drag-card').length, 0, '左键已松开时浮层立刻收掉');
assert.deepStrictEqual(JSON.parse(store.get(CONFIG_KEY)).segments, keptOrder, '打断算取消，不写配置');
console.log('拖动被打断：回原位，不落盘');

/* 底部只剩「去 GitHub 点 star」+「恢复默认设置」（恢复默认在后），版本号贴右；
   「更新节假峰谷」已挪到价格卡「当前会话使用」那一行的右端 */
const footTree = renderSettings();
const foot = collectByClass(footTree, 'dsb-foot')[0];
assert.ok(foot !== undefined, '底部区存在');
assert.deepStrictEqual(collectByClass(foot, 'dsb-action').map((one) => one.props.key), ['__star', '__reset'],
	'底部按钮顺序：去 GitHub / 恢复默认（恢复默认在后）');
const currentAct = collectByClass(footTree, 'dsb-current-act')[0];
assert.ok(currentAct !== undefined, '价格卡那一行右端有动作区');
assert.deepStrictEqual(collectByClass(currentAct, 'dsb-action').map((one) => one.props.key), ['__holiday'],
	'「更新节假峰谷」在价格卡的当前会话行里');
/* 点一下后的状态提示要排在按钮**前面** —— 它出现时按钮右边界不动（按钮钉在卡右端）；
   按钮不挂 title，悬停不弹气泡 */
const holidayBtn = collectByClass(currentAct, 'dsb-action')[0];
assert.strictEqual(holidayBtn.props.title, undefined, '按钮不挂 title（悬停不弹气泡）');
holidayBtn.props.onClick();
const actedTree = renderSettings();
const actedAct = collectByClass(actedTree, 'dsb-current-act')[0];
assert.deepStrictEqual(actedAct.children.map((one) => one.props.key), ['__holidaystatus', '__holiday'],
	'状态提示在按钮前面（实际 ' + JSON.stringify(actedAct.children.map((one) => one.props.key)) + '）');
const star = buttonByLabel(footTree, 'GitHub支持');
assert.ok(star !== undefined, 'GitHub 支持按钮文案与词条一致');
/* 悬停提示：毛玻璃沿用 .dsb-tip，文字是那句邀请，左边界贴按钮左边界（left:0 由样式保证） */
const starWrap = collectByClass(foot, 'dsb-star-wrap')[0];
assert.ok(starWrap !== undefined, '按钮外层有定位容器');
const starTip = collectByClass(starWrap, 'dsb-star-tip')[0];
assert.ok(starTip !== undefined, '悬停提示节点存在');
assert.strictEqual(textOf(starTip), '你的支持是我最大的动力！请帮我点亮Star吧~', '提示文案');
assert.ok(String(starTip.props.className).indexOf('dsb-tip') !== -1, '提示沿用主气泡那套毛玻璃材质');
assert.deepStrictEqual(collectByClass(starWrap, 'dsb-action').map((one) => one.props.key), ['__star'], '外层里是那颗按钮');
assert.strictEqual(starWrap.children[0].props.key, '__startip', '提示在按钮前面');
fakeWindow.opened.length = 0;
star.props.onClick();
assert.deepStrictEqual(fakeWindow.opened, [['https://github.com/raphael-y7/dsh-desktop-statusbar', '_blank']],
	'点 star 按钮开项目主页（实际 ' + JSON.stringify(fakeWindow.opened) + '）');
console.log('底部：去 GitHub + 恢复默认（后者在后）；更新节假峰谷在价格卡行右端；star 点击开项目主页');

/* 会话数据气泡：三行都能点开下钻（技能注入 / 工具调用 / 压缩次数）。
   点开是同一个气泡换内容 —— 标题变成子视图名、内容换成明细列表，点标题回上一层。
   老的「悬停技能注入弹二次气泡」已去掉，这里顺带守住它不再回来。 */
const progressView = {
	turn: 3, turnSteps: 2, toolCalls: 12,
	toolCounts: { read: 7, edit: 3, pwsh: 2 },
	skills: ['ponytail', 'my-dow-theory', 'ponytail'],
	/* 全局提示词（~/.dsh/AGENTS.md 这类）：排进技能注入子视图第一位，并计入那一行的数 */
	globalInstruction: 'AGENTS.md',
	compactCount: 2, compactTurn: 32, compactStep: 2,
	compacts: [{ turn: 12, step: 3 }, { turn: 32, step: 2 }]
};
const withProgress = (progress) => Object.assign({}, props, {
	useProjection: (key) => {
		if (key === 'desktopStatusbarProgress') return progress;
		/* 轮次项要有官方 sessionStats 才出现（没步数就整段不显示） */
		return key === 'sessionStats' ? { turns: 3, steps: 12 } : undefined;
	}
});
const skillProps = withProgress(progressView);
const clickEvent = () => ({
	currentTarget: { getBoundingClientRect: () => ({ left: 200, top: 700, width: 80, height: 20, right: 280 }) },
	stopPropagation: noop
});
/* 指定触发项位置的事件：验「居中会越界」这类要控制触发项离底栏两端多远 */
const clickAt = (left, width) => ({
	currentTarget: { getBoundingClientRect: () => ({ left: left, top: 700, width: width, height: 20, right: left + width }) },
	stopPropagation: noop
});
const renderCounts = (progress) => withHooks(barHooks, () => api.StatusBar(progress === undefined ? skillProps : withProgress(progress)));
const panelTitle = (tree) => {
	const head = collectByClass(tree, 'dsb-meter-headline')[0];
	return head === undefined ? '' : textOf(head);
};
const rowAt = (tree, label) => collectByClass(tree, 'dsb-meter-row').filter((one) => textOf(one).indexOf(label) !== -1)[0];
const listRows = (tree) => collectByClass(tree, 'dsb-meter-row').map((one) => ({
	name: textOf(collectByClass(one, 'dsb-meter-name')[0]),
	value: textOf(collectByClass(one, 'dsb-meter-value')[0])
}));

barHooks.values.length = 0;
const countsCell = collectByClass(renderCounts(), 'dsb-seg-click').filter((one) => one.props.key === '__segcounts')[0];
assert.ok(countsCell !== undefined, '轮次项可点开');
countsCell.props.onClick(clickEvent());
let tree = renderCounts();
assert.strictEqual(panelTitle(tree), '会话数据', '根视图标题仍是会话数据');
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 0, '根视图不收紧间隙（仍是 5ch）');
const skillRow = rowAt(tree, '技能注入');
assert.ok(skillRow !== undefined, '会话数据气泡里有技能注入那一行');
assert.deepStrictEqual(listRows(tree).map((one) => one.name), ['上下文压缩', '技能注入', '工具调用'], '行序：上下文压缩 → 技能注入 → 工具调用');
assert.deepStrictEqual(listRows(tree).map((one) => one.value), ['2', '4', '12'], '三个数都不带单位；技能注入把全局提示词也计入（3 次技能 + AGENTS.md）');
assert.strictEqual(typeof skillRow.props.onMouseEnter, 'undefined', '技能注入那行不再有悬停回调');
assert.strictEqual(typeof skillRow.props.onClick, 'function', '技能注入那行可点开');
assert.ok(textOf(skillRow).indexOf('›') === -1, '可点行不带箭头（只靠底色与光标表示可点）');


/* 点开技能注入 → 同一个气泡换成子视图，不再有二次气泡 */
skillRow.props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '技能注入', '子视图标题变成技能注入');
assert.ok(collectByClass(tree, 'dsb-meter-back').length > 0, '子视图标题可点返回');
assert.ok(textOf(collectByClass(tree, 'dsb-meter-back')[0]).indexOf('‹') === -1, '返回入口不带箭头');
assert.strictEqual(collectByClass(tree, 'dsb-hovercard').length, 0, '不再出现二次气泡');
assert.deepStrictEqual(listRows(tree).map((one) => one.name), ['AGENTS.md', 'ponytail', 'my-dow-theory'], '全局提示词排第一，技能按注入顺序去重，实际 ' + JSON.stringify(listRows(tree)));
assert.deepStrictEqual(listRows(tree).map((one) => one.value), ['', '', ''], '技能注入只列名字、不带次数');
assert.strictEqual(collectByClass(tree, 'dsb-meter-cols').length, 0, '三个技能不分列');
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 0, '技能注入子视图不收紧间隙');
console.log('技能注入子视图:', listRows(tree).map((one) => one.name).join(' / '));

/* 点标题返回上一层 */
collectByClass(tree, 'dsb-meter-back')[0].props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '会话数据', '点标题回到会话数据');
assert.deepStrictEqual(listRows(tree).map((one) => one.name), ['上下文压缩', '技能注入', '工具调用'], '根视图仍是那三行');

/* 工具调用子视图：中文名 + 按显示名长度升序、同长度按次数降序，带次数与单位 */
rowAt(tree, '工具调用').props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '工具调用', '工具调用子视图标题');
/* toolCounts = { read: 7, edit: 3, pwsh: 2 }：pwsh→命令行(3 字)最短；
   read→读取文件(4 字) 与 edit→修改文件(4 字) 同长，再按次数降序 read 7 > edit 3。
   （手算后写死，不借实现的排序函数） */
assert.deepStrictEqual(listRows(tree), [
	{ name: '命令行', value: '2 次' },
	{ name: '读取文件', value: '7 次' },
	{ name: '修改文件', value: '3 次' }
], '工具名用中文名，按显示名长度升序、同长度按次数降序，实际 ' + JSON.stringify(listRows(tree)));
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 1, '工具调用子视图挂 dsb-meter-tight（间隙收到 1ch）');
console.log('工具调用子视图:', listRows(tree).map((one) => one.name + ' ' + one.value).join(' / '));

/* 压缩次数子视图：逐条列出每次压缩落在第几轮第几步（中文序数） */
collectByClass(tree, 'dsb-meter-back')[0].props.onClick(clickEvent());
tree = renderCounts();
rowAt(tree, '上下文压缩').props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '上下文压缩', '上下文压缩子视图标题');
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 0, '上下文压缩子视图不收紧间隙');
assert.deepStrictEqual(listRows(tree), [
	{ name: '第一次压缩', value: '第12轮3步' },
	{ name: '第二次压缩', value: '第32轮2步' }
], '压缩明细按发生顺序逐条列，实际 ' + JSON.stringify(listRows(tree)));
console.log('上下文压缩子视图:', listRows(tree).map((one) => one.name + ' ' + one.value).join(' / '));

/* 分列：每一竖列最多三行，超过就多开一竖列 */
const manyTools = (n) => {
	const counts = {};
	for (let i = 1; i <= n; i += 1) counts['tool' + i] = i;
	return { turn: 1, turnSteps: 1, toolCalls: n, toolCounts: counts, skills: [], globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: [] };
};
const openTools = (progress) => {
	barHooks.values.length = 0;
	const cell = collectByClass(renderCounts(progress), 'dsb-seg-click').filter((one) => one.props.key === '__segcounts')[0];
	cell.props.onClick(clickEvent());
	rowAt(renderCounts(progress), '工具调用').props.onClick(clickEvent());
	return renderCounts(progress);
};
const columnsOf = (tree) => collectByClass(tree, 'dsb-meter-col');
assert.strictEqual(columnsOf(openTools(manyTools(3))).length, 0, '3 行正好一列，不分列');
const twoCols = openTools(manyTools(4));
assert.strictEqual(columnsOf(twoCols).length, 2, '4 行开两列（每列最多三行）');
assert.strictEqual(collectByClass(twoCols, 'dsb-meter-row').length, 4, '两列合起来还是 4 行');
const fiveCols = openTools(manyTools(13));
assert.strictEqual(columnsOf(fiveCols).length, 5, '13 行开五列');
assert.ok(columnsOf(fiveCols).every((one) => collectByClass(one, 'dsb-meter-row').length <= 3), '每列不超过三行');
assert.strictEqual(collectByClass(fiveCols, 'dsb-meter-row').length, 13, '五列合起来还是 13 行');
console.log('分列：3 行一列 / 4 行两列 / 13 行五列，每列最多三行');

/* 气泡水平位置：以触发项自身居中（替身里触发项是 200~280，中线 240），
   再夹在「圆圈灰底的左边」与视口右边之间。换子视图后宽度变了必须重算 ——
   沿用上一个宽度就会偏到一边（2026-10-04 报过这个毛病）。 */
const tipLeft = () => {
	const pos = barHooks.values.filter((one) => one !== null && typeof one === 'object'
		&& typeof one.left === 'number' && typeof one.bottom === 'number')[0];
	return pos === undefined ? null : pos.left;
};
runEffects = true;
try {
	/* 替身里的 effect 是在渲染过程中就地跑的，节点 ref 要到这一遍渲染结束才挂上，
	   所以状态一变就渲染两遍：第一遍挂节点，第二遍才量得到宽度。 */
	const paint = () => { renderCounts(); return renderCounts(); };
	const panelMaxWidth = () => {
		const panel = collectByClass(renderCounts(), 'dsb-tip')[0];
		return panel === undefined || panel.props.style === undefined ? undefined : panel.props.style.maxWidth;
	};
	const openSeg = (key, event) => {
		barHooks.values.length = 0;
		collectByClass(renderCounts(), 'dsb-seg-click').filter((one) => one.props.key === key)[0]
			.props.onClick(event === undefined ? clickEvent() : event);
		paint();
	};
	/* 基准：圆环按钮（灰底）左边 120，气泡自带 0.5px 描边 → border-box 至少 120.5，可见边 120 */
	stubRingLeft = 120;
	stubBarRight = 985;
	stubTipWidth = 160;
	openSeg('__segcounts');
	assert.strictEqual(tipLeft(), 160, '根视图：触发项中线 240 − 半宽 80 = 160，实际 ' + tipLeft());
	stubTipWidth = 100;
	rowAt(renderCounts(), '技能注入').props.onClick(clickEvent());
	paint();
	assert.strictEqual(tipLeft(), 190, '换子视图后按新宽度重新居中（240 − 50），实际 ' + tipLeft());
	/* 居中会越过灰圆左边：贴上去，可见左边缘正好压在灰圆左边（300） */
	stubRingLeft = 300;
	stubTipWidth = 400;
	paint();
	assert.strictEqual(tipLeft(), 300.5, '左边界贴灰圆（border-box 300.5），实际 ' + tipLeft());
	assert.strictEqual(tipLeft() - 0.5, 300, '可见左边缘 = 300 = 圆环按钮灰底左边');
	/* 右边界：可见右边缘压在最右那一项灰底的右边（985） */
	stubRingLeft = 120;
	stubTipWidth = 400;
	openSeg('__segbalance', clickAt(900, 85));
	assert.strictEqual(tipLeft(), 985 - 0.5 - 400, '末尾项可见右边缘压在自己灰底右边（984.5 − 400），实际 ' + tipLeft());
	assert.strictEqual(tipLeft() + 400 + 0.5, 985, '可见右边缘 = 985（含 0.5 描边）');
	/* 气泡比底栏还宽：宽度上限 = 两侧可见边之间的跨度（984.5 − 120.5 = 864） */
	stubTipWidth = 975;
	openSeg('__segcounts');
	assert.strictEqual(panelMaxWidth(), '864px', '超宽气泡按两侧可见边之间的跨度压宽度，实际 ' + panelMaxWidth());
	assert.strictEqual(tipLeft(), 120.5, '超宽气泡可见左边缘压在灰圆左边，实际 ' + tipLeft());
	console.log('气泡水平位置：根视图 160 / 换子视图后 190 / 越界贴灰圆 300.5（可见边 300）/ 末尾项可见右边 985 / 超宽上限 864px');
} finally {
	runEffects = false;
	stubTipWidth = 0;
	stubRingLeft = 120;
	barHooks.values.length = 0;
}

/* 抓不到「下一年」的安排（官方还没发布，host 回空 days）：状态行照常显示已写入的本年数量，
   不出现"国务院还没发布 X 年放假安排"那句。抓取回包是异步的，等一拍再断言。 */
fakeWindow.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ days: [] }) });
const quietTree = freshSettings();
collectByClass(collectByClass(quietTree, 'dsb-current-act')[0], 'dsb-action')[0].props.onClick();
renderSettings();
setImmediate(() => {
	const settled = renderSettings();
	const hint = collectByClass(settled, 'dsb-hint').filter((one) => one.props.key === '__holidaystatus')[0];
	assert.ok(hint !== undefined, '状态行出现');
	const text = textOf(hint);
	assert.ok(/^已写入 \d{4} 年 \d+ 个节假日$/.test(text), '未发布时显示已写入的本年数量，实际 ' + text);
	assert.strictEqual(text.indexOf('国务院'), -1, '不出现"国务院还没发布"那句');
	console.log('下一年未发布：状态行显示本年已写入数量（' + text + '）');

	console.log('\nALL CHECKS PASSED');
});
