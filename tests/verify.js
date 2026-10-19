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
  /* `setConfig` 要导出：「总计」那批用例得走**真实改价路径**（设置页改价 = setConfig({models})），
     手工改 config 是另一条路。`applyTotalFloor` 不再导出 —— 它是「总计」的实现细节，
     测试只该看渲染出来的文字，不该看它的内部账本（否则又会退化成绕过真实路径的纯函数测试）。
     `rowsPanel` 要导出：它是**唯一**给「标题下色条」定 `dsb-bar` / `dsb-bar-hoverable` 的地方，
     而令牌面板（tokens）走的是另一条渲染路径（meterBar 里类名硬编码），
     想真切到那个三元表达式，只能直接把 rowsPanel 调起来渲染。 */
  '\t\texports.__test = { segmentView, segmentText, detectLocale, formatDuration, formatSeconds, formatThroughput, SEGMENTS, DEFAULT_SEGMENTS, STORAGE_KEY, DEFAULT_PRICES, snapshot, setConfig, StatusBar, SettingsSection, dropIndexAt, moveItem, creditsPanel, BALANCE_COLORS, creditsLabel, formatCredits, plainBoundsOf, clampPlainLeft, plainFits, creditDisplayName, TOOL_BAR_COLORS, rowsPanel, creditsSort, creditsSortGroup, creditsSortDate, LIST_ROWS_PER_COLUMN_MAX };\n' + marker);

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
function makeHooks() { return { values: [], deps: [], index: 0, pending: [] }; }
/**
 * 跑一轮渲染。**layout effect 延迟到整棵树建完之后再执行** —— 这是真实 React 的顺序：
 * 渲染 → 挂 DOM（ref 赋值）→ 跑 layout effect。替身若在渲染中途同步跑 effect，
 * 那时子节点还没建出来、ref 还是 null，凡是「先拿节点再量尺寸」的逻辑全都测不到
 * （悬停提示的定位就有这个问题）。
 */
function withHooks(bucket, fn) {
	const prev = activeHooks;
	activeHooks = bucket;
	bucket.index = 0;
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
/* 悬停纯文字提示的**自然宽度**。测试按需改大到放不下，用来触发「整组关掉悬停」。 */
let stubHoverPlainWidth = 60;
/* 悬停提示定位 effect 要量的三个盒子（宽度够用即可，只关心相对关系）：
   标题行 head（算垂直居中）、标题文字 headline（算水平左界）、色条 bar（算水平右界）。 */
let stubHeadWidth = 300;
let stubHeadlineWidth = 60;
let stubBarWidth = 273;
/* 工具调用列数自适应的假几何：列网格 nowrap，放不下的表现是**内容宽 > 容器宽**。
   stubWrapOn 时容器只放得下 stubWrapCap 列（stubColWidth 是每列的假宽度）——
   列数按当前渲染树里的 .dsb-meter-col 数量算，行数每加一档列数就少一档，溢出自然消失。 */
let stubWrapOn = false;
let stubWrapCap = 3;
/* 每列的假宽度：只要"总宽 = 列数 × 它"这个关系成立，取值不影响判定（用 170 与真实列宽同量级） */
const stubColWidth = 170;
/** 树里某个类名出现了几次（给气泡的假 querySelectorAll 用） */
function countClass(node, cls) {
	if (node === null || node === undefined) return 0;
	if (Array.isArray(node)) return node.reduce((sum, one) => sum + countClass(one, cls), 0);
	if (typeof node !== 'object') return 0;
	const className = node.props === undefined || node.props.className === undefined ? '' : String(node.props.className);
	let count = className.split(' ').indexOf(cls) !== -1 ? 1 : 0;
	(node.children || []).forEach((one) => { count += countClass(one, cls); });
	return count;
}
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
		/* 气泡面板：宽度由 CSS 的 max-content 决定，替身里由 stubTipWidth 给；
		   同时给一个假的列网格几何，让 toolColumnsOverflow 能按当前渲染树判"横向放不下" */
		if (cls.indexOf('dsb-tip') !== -1) {
			node.getBoundingClientRect = () => stubRect(0, stubTipWidth);
			node.querySelector = (selector) => {
				if (selector === '.dsb-meter-tight') return countClass(node, 'dsb-meter-tight') > 0 ? {} : null;
				/* 悬停纯文字提示的定位 effect 要量标题行与色条：
				   分别给一个盒子，才能算出 top（标题行居中）与水平区间（标题右 → 色条右）。 */
				if (selector === '.dsb-meter-head') return { getBoundingClientRect: () => stubRect(0, stubHeadWidth) };
				if (selector === '.dsb-meter-headline') return { getBoundingClientRect: () => stubRect(0, stubHeadlineWidth) };
				if (selector === '.dsb-bar') return { getBoundingClientRect: () => stubRect(0, stubBarWidth) };
				return null;
			};
			/* 工具调用子视图只有一个列网格。列网格是 flex-wrap:nowrap（绝不折行），
			   所以"放不下"的表现是**内容比容器宽**（scrollWidth > clientWidth），不是列被折到下一排。
			   替身按渲染树里的列数造这个几何：每列按 stubColWidth 算总宽，
			   容器只放得下 stubWrapCap 列 —— 列数多于容量就判溢出，行数加上去列数变少就放得下。 */
			node.querySelectorAll = (selector) => {
				if (selector !== '.dsb-meter-cols') return [];
				const total = countClass(node, 'dsb-meter-col');
				if (total < 2) return [];
				return [{
					scrollWidth: total * stubColWidth,
					clientWidth: stubWrapOn === true ? stubWrapCap * stubColWidth : total * stubColWidth
				}];
			};
		}
		/* 状态栏根节点：定位要按它里面的圆圈灰底量左边界，按最右那一项量右边界 */
		if (cls.indexOf('dsb-root') !== -1) {
			node.querySelector = (selector) => (selector === '.dsb-ring-btn' ? stubRing : null);
			node.querySelectorAll = (selector) => (selector === '.dsb-seg' ? [stubLastSeg] : []);
		}
		/* 悬停纯文字提示（.dsb-hover-plain）：必须给 `style`，否则 onHoverMove 一进来就
		   `if (node.style === undefined) return`，段内移动那条路径**一行都测不到**。
		   宽度只暴露 offsetWidth（布局宽度）：提示不再做缩放，替身也就不必模拟
		   transform 对 getBoundingClientRect 的影响 —— 那套模拟是缩放时代的产物。 */
		if (cls.indexOf('dsb-hover-plain') !== -1) {
			node.style = {};
			/* 宽度**动态读** stubHoverPlainWidth：用例会在渲染之间改它来模拟「工具名变长」，
			   快照下来就会量到建档时的旧宽度，判定永远不触发（实测踩过）。 */
			Object.defineProperty(node, 'naturalWidth', {
				configurable: true,
				get: () => stubHoverPlainWidth
			});
			node.naturalHeight = 15;
			node.getBoundingClientRect = () => ({
				left: 0, top: 700,
				width: node.naturalWidth,
				height: node.naturalHeight,
				right: node.naturalWidth, bottom: 700 + node.naturalHeight
			});
			/* offsetWidth 是整数 —— 真实浏览器语义 */
			Object.defineProperty(node, 'offsetWidth', {
				configurable: true,
				get: () => Math.round(node.naturalWidth)
			});
		}
		if (typeof node.props.ref === 'function') node.props.ref(node);
		/* 对象 ref 在替身里也要真的挂上节点（只认气泡/根节点这几个，别的 ref 装着别的东西）。
		   每次都更新到最新树：量测（宽度 / 折行）必须量这一遍渲染的结果，首次挂上后就不再更新会量到旧树。 */
		const box = node.props.ref;
		/* 对象 ref 要真的挂上节点：气泡/根节点之外，`.dsb-hover-plain` 也必须挂 ——
		   悬停提示的定位与「放不下就关」判定全靠 hoverRef.current 拿到那个节点，
		   不挂的话 effect 一进来就 `if (node === null) return`，整段逻辑一行都测不到。 */
		const mountable = cls.indexOf('dsb-tip') !== -1 || cls.indexOf('dsb-root') !== -1
			|| cls.indexOf('dsb-hover-plain') !== -1;
		if (mountable === true && box !== null && typeof box === 'object') box.current = node;
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
	/* 真 React 一定有 useLayoutEffect（插件用它做绘制前定位）。替身必须提供，
	   否则 useTipLayout 会退回 useEffect，而那条路径在替身里还要额外满足 runEffects 时序 ——
	   更要紧的是：不提供的话「定位 effect」这段在测试里根本不会走，B3/M14 的变异就抓不到。
	   回调**排队到整棵树渲染完之后**再跑（真实 React 顺序：渲染 → 挂 DOM → layout effect），
	   否则 effect 里拿 hoverRef.current 之类的节点引用永远是 null。 */
	useLayoutEffect: (fn, deps) => {
		const at = activeHooks === null ? -1 : activeHooks.index;
		hookSlot(undefined);
		if (runEffects !== true || typeof fn !== 'function' || at < 0) return;
		const prev = activeHooks.deps[at];
		const same = Array.isArray(deps) === true && Array.isArray(prev) === true
			&& deps.length === prev.length && deps.every((one, index) => one === prev[index]);
		activeHooks.deps[at] = Array.isArray(deps) ? deps.slice() : undefined;
		if (same === true) return;
		activeHooks.pending.push(fn);
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
	/* 积分口径的套餐气泡（WorkBuddy）：标题 / 月度备注 / 刷新与到期备注 / 已用数值 */
	tipCreditsTitle: '积分套餐', tipCreditsMonthly: '（每月刷新）', tipCreditsRefresh: ' · {date} 刷新',
	tipCreditsExpire: ' · {date} 到期', tipCreditsRefreshLatest: ' · {date} 刷新(最近)',
	tipCreditsExpireLatest: ' · {date} 到期(最近)', tipCreditsUsed: '已用 {used} / {total}',
	unitCountTurns: ' 轮', unitCountSteps: ' 步',
	unitCountCalls: ' 次',
	tipCountsTitle: '会话数据', tipCountsSkills: '技能注入', tipCountsToolCalls: '工具调用',
	tipCountsCompactAt: '上下文压缩',
	tipCompactItem: '第{index}次压缩', tipCompactWhere: '第{turn}轮{step}步', tipCompactTurnOnly: '第{turn}轮',
	tipCompactAfter: '第{turn}轮后',
	tipManual: '手动触发',
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
/* 时刻必须**钉死**，不能用 Date.now()：金额同时取决于「用量」与「发生时刻是高峰还是空闲」，
   deepseek-flash 空闲价是高峰价的一半。用当前时刻会让这条用例一天里有 8 小时失败
   （实测：下午 14:48 跑得 ¥0.46，而期望写的是空闲价的 ¥0.23）。
   这里固定为北京时间周三 20:00（空闲时段），与期望值 ¥0.23 对应。
   2026-10-14 是周三；20:00 CST = 12:00 UTC。 */
const FIXED_NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const fullSrc = {
	stats: { turns: 2, steps: 51, llmMs: 125000, toolMs: 45000, ttftMs: 92500, ttftSteps: 10, decodeMs: 13000, decodeTokens: 2963000 },
	usage: { uncachedInputTokens: 29631, cacheReadTokens: 1900000, cacheWriteTokens: 0, outputTokens: 41007 },
	pressure: { pressureTokens: 620000, contextWindow: 1000000 },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	sessionUsage: {
		models: { 'deepseek-flash': { input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 } },
		calls: [{ at: FIXED_NOW, model: 'deepseek-flash', input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 }],
		current: null, last: null
	},
	running: true, partial: null, runningCalls: [], lastAgentError: null,
	timeline: undefined, now: FIXED_NOW,
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
/* 实测 2026-10-07：WorkBuddy 会话的余额是积分，不是钱（不能显示成「余额 ¥177」）。
   2026-10：宿主额外给 rewards（积分套餐）时，点开是「积分套餐」面板：每个套餐一行 + 一条已用进度条；
   没有 rewards（旧插件 / 查询中 / 失败）时保持原状 —— 不给 tip、点不开，不弹空气泡。 */
const wbSrc = { ...emptySrc, sessionModel: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash-sg' } };
const wbBar = render({ ...wbSrc, balance: { ok: true, total: '177', currency: '', isCredits: true } }, allSegs);
console.log('WorkBuddy 积分：', wbBar.join(' | '));
assert.ok(wbBar.includes('余额 177'), '积分总数照常显示，got: ' + wbBar.join(' | '));
assert.ok(!wbBar.includes('¥177'), '积分不带货币符号（不能显示成 ¥177），got: ' + wbBar.join(' | '));
/* 没有 rewards（旧插件 / 宿主没给）：仍然不给 tip。渲染处按 tip !== null 决定 className 与 onClick，
   没有 tip 就不是可点击项、点不出气泡、悬停也不弹。 */
const wbView = api.segmentView('balance', { ...wbSrc, balance: { ok: true, total: '177', currency: '', isCredits: true } }, t);
assert.strictEqual(wbView.tip, undefined, '没有 rewards 时不给气泡（没有可展开的内容，弹空气泡会误以为能点）');
/* 非空 rewards：给「积分套餐」气泡（credits 面板）；值 = 已用/总数。
   夹具用宿主真实数据（used/total 是原始 number，可能带浮点尾数，客户端要格式化到两位小数去尾零）。
   顺序按 2.2.2 的三档规则：月度刷新包置顶 → 其余按到期时间升序 → 裂变包置底（本夹具没有裂变包）。 */
const REWARDS = [
	{ name: 'CodeBuddy个人体验版', used: 500, total: 500, expireAt: null, refreshAt: '2026-11-01', monthly: true },
	{ name: '拉新权益包', used: 552.42999936, total: 1500, expireAt: '2026-11-07', refreshAt: null, monthly: false },
	{ name: 'Bonus Pack', used: 12.389999979999999, total: 250, expireAt: '2026-10-26', monthly: false },
	{ name: 'Free Plan Subscription', used: 0, total: 100, refreshAt: '2026-11-01', monthly: true }
];
const wbRewardView = api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: REWARDS }
}, t);
assert.strictEqual(wbRewardView.tip.kind, 'credits', '积分套餐用 credits 面板（每个套餐一行 + 一条进度条）');
assert.strictEqual(wbRewardView.tip.title, '积分套餐', '气泡标题走 tipCreditsTitle（中性词）');
assert.strictEqual(wbRewardView.tip.panel.totalText, '177', '面板右侧显示总积分');
assert.deepStrictEqual(Array.from(wbRewardView.tip.panel.rewards, (one) => ({ label: one.label, valueText: one.valueText })), [
	{ label: '个人体验版 · 11-01 刷新', valueText: '已用 500 / 500' },
	{ label: 'Free Plan Subscription · 11-01 刷新', valueText: '已用 0 / 100' },
	{ label: 'Bonus Pack · 10-26 到期', valueText: '已用 12.39 / 250' },
	{ label: '拉新权益包 · 11-07 到期', valueText: '已用 552.43 / 1500' }
], '月度包显「· MM-DD 刷新」、一次性包显「· MM-DD 到期」；值两位小数去尾零；**月度包置顶、其余按到期升序**；包名保持上游原名（不翻译）');
/* 进度条比例 = used / total，夹在 0-100；0/100 的套餐不画进度段。
   索引跟着上面三档排序后的顺序走：0 个人体验版 / 1 Free Plan / 2 Bonus Pack / 3 拉新权益包 */
const percentOf = (at) => wbRewardView.tip.panel.rewards[at].percent;
assert.ok(Math.abs(percentOf(0) - 100) < 1e-9, '已用满 → 100%');
assert.strictEqual(percentOf(1), 0, '已用 0 → 0%（不画进度段）');
assert.ok(Math.abs(percentOf(2) - (12.389999979999999 / 250) * 100) < 1e-6, 'Bonus Pack 按 used/total 算比例');
assert.ok(Math.abs(percentOf(3) - (552.42999936 / 1500) * 100) < 1e-6, '拉新权益包按 used/total 算比例');
/* 渲染层：标题下先一条横杠（复用 .dsb-meter-divider），每个套餐一个块 = 一行 + 一条进度 */
const creditsTree = api.creditsPanel(wbRewardView.tip.panel, wbRewardView.tip.title, null, { current: null });
assert.strictEqual(collectByClass(creditsTree, 'dsb-meter-divider').length, 1, '积分套餐气泡标题下有一条横杠');
const creditsChildren = creditsTree.children || [];
assert.strictEqual(String(creditsChildren[0].props.className), 'dsb-meter-head', '第一块是标题行');
assert.strictEqual(String(creditsChildren[1].props.className), 'dsb-meter-divider', '标题行后紧跟横杠');
assert.ok(String(creditsChildren[2].props.className).indexOf('dsb-credits-list') !== -1, '横杠后才是套餐列表');
assert.strictEqual(collectByClass(creditsTree, 'dsb-credits-list').length, 1, '列表容器挂 dsb-credits-list（带滚动上限）');
assert.strictEqual(collectByClass(creditsTree, 'dsb-credit').length, 4, '每个套餐一个块');
const creditRowNodes = collectByClass(creditsTree, 'dsb-meter-row');
assert.strictEqual(creditRowNodes.length, 4, '每个套餐一行（包名/备注 + 已用/总量）');
assert.deepStrictEqual(Array.from(creditRowNodes, (row) => textOf(collectByClass(row, 'dsb-meter-name')[0])),
	['个人体验版 · 11-01 刷新', 'Free Plan Subscription · 11-01 刷新', 'Bonus Pack · 10-26 到期', '拉新权益包 · 11-07 到期'],
	'行首是包名 + 备注；月度包置顶、其余按到期升序；包名保持上游原名（不翻译）');
assert.deepStrictEqual(Array.from(creditRowNodes, (row) => textOf(collectByClass(row, 'dsb-meter-value')[0])),
	['已用 500 / 500', '已用 0 / 100', '已用 12.39 / 250', '已用 552.43 / 1500'], '行尾是已用 / 总量');
/* 进度方向：已用从**左边**起 —— 前段灰（已用宽）、后段透明（剩余宽）；
   100% 只画整条灰；0% 仍渲染空轨道（有 .dsb-bar、没有填充段） */
assert.strictEqual(collectByClass(creditsTree, 'dsb-bar').length, 4, '每个套餐都有进度条（0% 也画空轨道）');
const creditSegs = collectByClass(creditsTree, 'dsb-bar-seg');
const usedPct = (value, total) => (value / total) * 100;
const pct1000 = (n) => Math.round(n * 1000) / 1000;
const expectSegs = [
	{ width: 100, color: api.BALANCE_COLORS.topUp },
	{ width: usedPct(12.389999979999999, 250), color: api.BALANCE_COLORS.topUp },
	{ width: 100 - usedPct(12.389999979999999, 250), color: 'transparent' },
	{ width: usedPct(552.42999936, 1500), color: api.BALANCE_COLORS.topUp },
	{ width: 100 - usedPct(552.42999936, 1500), color: 'transparent' }
];
assert.strictEqual(creditSegs.length, expectSegs.length, '100% 段 1 段 + 两个部分套餐各 2 段（灰已用 + 透明剩余）；0% 无段');
assert.deepStrictEqual(Array.from(creditSegs, (one) => one.props.style.backgroundColor),
	expectSegs.map((one) => one.color), '已用段用余额灰（BALANCE_COLORS.topUp），剩余段透明');
assert.deepStrictEqual(Array.from(creditSegs, (one) => pct1000(parseFloat(one.props.style.width))),
	expectSegs.map((one) => pct1000(one.width)), '前段宽 = used%、后段宽 = 100 - used%（已用从左起）');
/* 0% 的套餐：有轨道、无填充段（排序后它在第 2 位） */
const zeroCredit = collectByClass(creditsTree, 'dsb-credit')[1];
assert.strictEqual(collectByClass(zeroCredit, 'dsb-bar').length, 1, '0% 套餐有进度条轨道');
assert.strictEqual(collectByClass(zeroCredit, 'dsb-bar-seg').length, 0, '0% 套餐没有填充段（只有空轨道）');
/* 14 条套餐：列表容器仍是同一个滚动类（CSS 有半屏高度上限），条数照常 */
const manyRewards = [];
for (let i = 0; i < 14; i += 1) manyRewards.push({ name: '套餐' + (i + 1), used: i, total: 100, monthly: false });
const wbMany = api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: manyRewards }
}, t);
const manyTree = api.creditsPanel(wbMany.tip.panel, wbMany.tip.title, null, { current: null });
assert.strictEqual(collectByClass(manyTree, 'dsb-credit').length, 14, '14 条套餐都渲染');
assert.strictEqual(collectByClass(manyTree, 'dsb-credits-list').length, 1, '14 条时仍用带滚动的列表容器（不撑破屏幕）');

/* 构造夹具（1 月度 + 1 拉新 + 11 裂变 + 1 Bonus，用于稳定断言；真机 live 是 12 裂变、无 Bonus）：
   公共前缀剥离 + 相邻同名聚合 */
const realRewards = [
	{ name: 'CodeBuddy个人体验版', used: 500, total: 500, expireAt: null, refreshAt: '2026-11-01', monthly: true },
	{ name: 'CodeBuddy个人版拉新权益包', used: 552.43, total: 1500, expireAt: '2026-11-07', monthly: false }
];
for (let i = 0; i < 11; i += 1) {
	realRewards.push({
		name: 'CodeBuddy个人版国内运营裂变包',
		used: 0,
		total: 100,
		/* 故意把第一条的到期日放晚：合并后应显示**最近**的 11-07，而不是 12-01 或区间 */
		expireAt: i === 0 ? '2026-12-01' : '2026-11-07',
		monthly: false
	});
}
realRewards.push({ name: 'Bonus Pack', used: 12.39, total: 250, expireAt: '2026-10-26', monthly: false });
const wbReal = api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: realRewards }
}, t);
const realRows = Array.from(wbReal.tip.panel.rewards);
assert.deepStrictEqual(realRows.map((one) => one.label), [
	'个人体验版 · 11-01 刷新',
	'Bonus Pack · 10-26 到期',
	'拉新权益包 · 11-07 到期',
	'运营裂变包×11 · 11-07 到期(最近)'
], '14 条真实数据 → 剥前缀后 4 行；**月度包置顶、裂变包置底、其余按到期升序**；聚合行带 ×11 且日期标「(最近)」');
assert.deepStrictEqual(realRows.map((one) => one.count), [1, 1, 1, 11], '聚合分组记录原始套餐数量');
assert.ok(realRows[0].label.indexOf('×') === -1 && realRows[0].label.indexOf('(最近)') === -1, '非聚合行不带 ×N / (最近)');
assert.ok(realRows[1].label.indexOf('×') === -1 && realRows[1].label.indexOf('(最近)') === -1, '非聚合行不带 ×N / (最近)');
assert.deepStrictEqual(realRows.map((one) => one.valueText), [
	'已用 500 / 500', '已用 12.39 / 250', '已用 552.43 / 1500', '已用 0 / 1100'
], '相邻同名裂变包 used/total 相加（0/1100）');
assert.strictEqual(realRows[3].percent, 0, '裂变包合计已用 0 → percent 0（画空轨道）');
assert.deepStrictEqual(realRows.map((one) => one.name), ['个人体验版', 'Bonus Pack', '拉新权益包', '运营裂变包'],
	'前缀按顺序剥、只剥开头：CodeBuddy → 个人版 → 国内；没有前缀的包名原样保留');
/* 单条不聚合；不相邻同名不合并（顺序按首次出现位置） */
const creditRowsOf = (rewards) => Array.from(api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: rewards }
}, t).tip.panel.rewards);
assert.strictEqual(creditRowsOf([{ name: '单独包', used: 1, total: 2, monthly: false }]).length, 1, '单条不聚合');
assert.deepStrictEqual(creditRowsOf([
	{ name: '同名包', used: 1, total: 10, monthly: false },
	{ name: '其它包', used: 2, total: 10, monthly: false },
	{ name: '同名包', used: 3, total: 10, monthly: false }
]).map((one) => one.name), ['同名包', '其它包', '同名包'], '不相邻的同名包不合并');
/* 前缀剥离边界：无前缀原样、纯前缀剥空保留原名、可连续剥、大小写不敏感；
   关键：**不查任何映射表** —— 新包名来了也原样显示，不会因为表里没有而漏翻 */
assert.deepStrictEqual(creditRowsOf([{ name: 'Bonus Pack', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['Bonus Pack'], '国际站英文包名保持原名（不翻译成中文）');
assert.deepStrictEqual(creditRowsOf([{ name: 'Launch Bonus', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['Launch Bonus'], '上游新增的包名（映射表里从来没有过）原样显示，不依赖任何映射表');
assert.deepStrictEqual(creditRowsOf([{ name: 'CodeBuddy', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['CodeBuddy'], '纯前缀剥完为空 → 保留原名');
assert.deepStrictEqual(creditRowsOf([{ name: 'CodeBuddy个人版国内运营包', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['运营包'], '多层前缀可连续剥（CodeBuddy → 个人版 → 国内）');
assert.deepStrictEqual(creditRowsOf([{ name: 'codebuddy个人版体验包', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['体验包'], 'CodeBuddy 前缀大小写不敏感');
/* 月度包聚合：刷新日期同样取最近一个，并标「(最近)」 */
assert.deepStrictEqual(creditRowsOf([
	{ name: '月度包', used: 1, total: 10, monthly: true, refreshAt: '2026-12-01' },
	{ name: '月度包', used: 2, total: 10, monthly: true, refreshAt: '2026-11-01' }
]).map((one) => ({ label: one.label, valueText: one.valueText })), [
	{ label: '月度包×2 · 11-01 刷新(最近)', valueText: '已用 3 / 20' }
], '月度聚合：刷新日期取最近、带 (最近)、数值合计');
/* 聚合行下钻：×N 行可点 → 子视图用同样的套餐块（一行 + 进度条）竖排列出原始包，点标题返回 */
const realTree = api.creditsPanel(wbReal.tip.panel, wbReal.tip.title, null, { current: null }, { id: null, open: () => {}, back: () => {} });
assert.strictEqual(collectByClass(realTree, 'dsb-credit').length, 4, '根视图 4 个套餐块');
const clickRows = collectByClass(realTree, 'dsb-meter-row-plain');
assert.strictEqual(clickRows.length, 1, '只有聚合行（×11）可点');
assert.ok(textOf(clickRows[0]).indexOf('运营裂变包×11') !== -1, '可点的是聚合行');
/* 聚合行用独立修饰类：只有 cursor:pointer，不带 .dsb-meter-row-click（那个有悬停灰底） */
assert.strictEqual(String(clickRows[0].props.className).indexOf('dsb-meter-row-click'), -1,
	'聚合行不挂 .dsb-meter-row-click（不要悬停灰底）');
assert.strictEqual(collectByClass(realTree, 'dsb-meter-row-click').length, 0, '积分面板里没有任何带灰底胶囊的行');
let openedCredit = null;
const captureTree = api.creditsPanel(wbReal.tip.panel, wbReal.tip.title, null, { current: null }, {
	id: null,
	open: (index) => { openedCredit = index; },
	back: () => {}
});
collectByClass(captureTree, 'dsb-meter-row-plain')[0].props.onClick({ stopPropagation() {} });
assert.strictEqual(openedCredit, 3, '点聚合行打开第 3 组（裂变包）的明细 —— 排序后裂变包在最后');
let backCalls = 0;
const openTree = api.creditsPanel(wbReal.tip.panel, wbReal.tip.title, null, { current: null }, {
	id: 3,
	open: () => {},
	back: () => { backCalls += 1; }
});
/* 子视图与主面板同一套套餐块：每个原始包一块 = 一行 + 一条进度，竖排单列 */
assert.strictEqual(collectByClass(openTree, 'dsb-credit').length, 11, '子视图每个原始包一个套餐块');
assert.strictEqual(collectByClass(openTree, 'dsb-bar').length, 11, '每个块都有自己的进度条（0% 也画空轨道）');
assert.strictEqual(collectByClass(openTree, 'dsb-meter-cols').length, 0, '子视图竖排单列，不分列');
assert.strictEqual(collectByClass(openTree, 'dsb-credits-list').length, 1, '子视图复用带滚动上限的列表容器');
assert.strictEqual(textOf(collectByClass(openTree, 'dsb-meter-headline')[0]), '运营裂变包×11',
	'子视图标题 = 聚合行名字 + 数量（×N）');
/* 下钻标题右侧 = 该组剩余积分（total - used，动态），不是全局总积分 */
assert.strictEqual(collectByClass(openTree, 'dsb-meter-figures').length, 1, '子视图标题右侧显示该组剩余积分');
assert.strictEqual(textOf(collectByClass(openTree, 'dsb-meter-figures')[0]), '1100',
	'11 个包各 100、已用 0 → 该组剩余 1100');
assert.strictEqual(wbReal.tip.panel.rewards[3].remaining, 1100, '分组数据带 remaining = total - used');
assert.strictEqual(wbReal.tip.panel.rewards[3].remainingText, '1100', '分组数据带 remainingText');
/* 主面板 head 的全局总积分保持不变 */
assert.strictEqual(textOf(collectByClass(creditsTree, 'dsb-meter-figures')[0]), '177', '主面板右侧仍是全局总积分 177');
assert.strictEqual(collectByClass(openTree, 'dsb-meter-back').length, 1, '标题变成返回入口');
const subRows = collectByClass(openTree, 'dsb-meter-row');
assert.strictEqual(subRows.length, 11, '11 个原始包各一行');
assert.strictEqual(collectByClass(subRows[0], 'dsb-meter-row-plain').length, 0, '明细行本身不可再点');
assert.strictEqual(textOf(collectByClass(subRows[0], 'dsb-meter-name')[0]), '运营裂变包 · 12-01 到期', '明细行显示该包自己的日期');
assert.strictEqual(textOf(collectByClass(subRows[1], 'dsb-meter-name')[0]), '运营裂变包 · 11-07 到期', '不同到期日的包各显各的');
assert.deepStrictEqual(Array.from(subRows, (row) => textOf(collectByClass(row, 'dsb-meter-value')[0])),
	new Array(11).fill('已用 0 / 100'), '明细值是该包真实值，不合计');
/* 0% 的明细块：有轨道、无填充段 */
const subZero = collectByClass(openTree, 'dsb-credit')[0];
assert.strictEqual(collectByClass(subZero, 'dsb-bar').length, 1, '明细块有进度条轨道');
assert.strictEqual(collectByClass(subZero, 'dsb-bar-seg').length, 0, '0% 明细块没有填充段');
/* 分组保留原始成员明细：raw 名、自己的日期备注、真实 used/total */
const mergedItems = wbReal.tip.panel.rewards[3].items;
assert.strictEqual(mergedItems.length, 11, '聚合组保留 11 个原始成员');
assert.strictEqual(mergedItems[0].name, 'CodeBuddy个人版国内运营裂变包', '明细里保留原始包名');
assert.deepStrictEqual(Array.from(mergedItems, (one) => one.used), new Array(11).fill(0), '明细 used 是各自真实值');
collectByClass(openTree, 'dsb-meter-back')[0].props.onClick({ stopPropagation() {} });
assert.strictEqual(backCalls, 1, '点标题返回套餐列表');
/* 剩余积分随用量动态计算：两组同名包 total 100+500、used 1+2=3 → 该组剩余 597 */
const usedWrap = api.segmentView('balance', {
	...wbSrc,
	balance: {
		ok: true, total: '177', currency: '', isCredits: true,
		rewards: [
			{ name: '剩余包', used: 1, total: 100, monthly: false },
			{ name: '剩余包', used: 2, total: 500, monthly: false }
		]
	}
}, t);
const usedGroup = usedWrap.tip.panel.rewards[0];
assert.strictEqual(usedGroup.count, 2, '两组合并成一组');
assert.strictEqual(usedGroup.used, 3, '已用合计 3');
assert.strictEqual(usedGroup.total, 600, '总容量合计 600');
assert.strictEqual(usedGroup.remaining, 597, '剩余 = 600 - 3');
assert.strictEqual(usedGroup.remainingText, '597', '剩余文本用 formatCredits');
assert.strictEqual(usedGroup.valueText, '已用 3 / 600', '行上仍是已用 / 总量');
const usedOpen = api.creditsPanel(usedWrap.tip.panel, usedWrap.tip.title, null, { current: null }, {
	id: 0, open: () => {}, back: () => {}
});
assert.strictEqual(textOf(collectByClass(usedOpen, 'dsb-meter-figures')[0]), '597',
	'下钻标题右侧 = 该组剩余 597（不显示总容量 600、也不是全局 177）');
assert.deepStrictEqual(Array.from(collectByClass(usedOpen, 'dsb-meter-value'), (one) => textOf(one)),
	['已用 1 / 100', '已用 2 / 500'], '明细仍是各自真实值');
/* 月度包缺 refreshAt：退回「（每月刷新）」；非月度包没有 expireAt 就不加备注 */
const wbMonthly = api.segmentView('balance', {
	...wbSrc,
	balance: {
		ok: true, total: '177', currency: '', isCredits: true,
		rewards: [
			{ name: '无刷新日的月度包', used: 1, total: 2, monthly: true, refreshAt: null },
			{ name: '没有到期日的一次性包', used: 3, total: 4, monthly: false, expireAt: null }
		]
	}
}, t);
assert.deepStrictEqual(Array.from(wbMonthly.tip.panel.rewards, (one) => one.label),
	['无刷新日的月度包（每月刷新）', '没有到期日的一次性包'], '月度缺 refreshAt 退回文字备注；一次性没到期日不加备注');
/* 字段缺失的包跳过；used/total 缺失按 0 处理，不显示半行怪数据 */
const wbPartial = api.segmentView('balance', {
	...wbSrc,
	balance: {
		ok: true, total: '177', currency: '', isCredits: true,
		rewards: [null, { name: '' }, { name: '只写名字的包' }, { name: '缺数字的包', used: 5 }]
	}
}, t);
assert.deepStrictEqual(Array.from(wbPartial.tip.panel.rewards, (one) => one.label), ['只写名字的包', '缺数字的包'], '无名字的包跳过，其余保留');
assert.deepStrictEqual(Array.from(wbPartial.tip.panel.rewards, (one) => one.valueText), ['已用 0 / 0', '已用 5 / 0'], '缺 used/total 按 0 显示');
assert.deepStrictEqual(Array.from(wbPartial.tip.panel.rewards, (one) => one.percent), [0, 0], 'total 为 0 时进度比例 0');
/* rewards 空数组：等同于没有 → 不给 tip（不弹空气泡） */
assert.strictEqual(api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: [] }
}, t).tip, undefined, 'rewards 为空数组时不给气泡');
/* ------------------------------------------------ 积分套餐排序（三档） */
/* 用户拍板：① 每月固定刷新的套餐永远第一行；② 裂变包永远最后；③ 其余按过期时间升序。
   关键约束：**先按原顺序聚合相邻同名包、最后才整体排序** —— 先排会把十几个裂变包
   按日期打散，聚合成「×N」就失效了。 */
assert.strictEqual(api.creditsSortGroup({ monthly: true }), 0, '月度刷新包归第 1 档（永远第一行）');
assert.strictEqual(api.creditsSortGroup({ monthly: false, name: '运营裂变包' }), 2, '裂变包归第 3 档（永远最后）');
assert.strictEqual(api.creditsSortGroup({ monthly: false, name: '拉新权益包' }), 1, '普通包归第 2 档（按到期时间排）');
assert.strictEqual(api.creditsSortGroup({ monthly: true, name: '月度裂变包' }), 0,
	'月度优先于裂变：既是月度又是裂变时，月度那档赢（第一行位置不能被挤走）');
/* 三档同时出现：月度置顶、其余按到期升序、裂变置底（即使裂变包到期最早） */
assert.deepStrictEqual(creditRowsOf([
	{ name: '普通包晚', used: 0, total: 100, monthly: false, expireAt: '2026-12-01' },
	{ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: '2026-10-01' },
	{ name: '普通包早', used: 0, total: 100, monthly: false, expireAt: '2026-10-26' },
	{ name: '月度包', used: 0, total: 100, monthly: true, refreshAt: '2026-11-01' }
]).map((one) => one.name), ['月度包', '普通包早', '普通包晚', '运营裂变包'],
	'月度包置顶 → 其余按到期升序（10-26 在 12-01 前）→ 裂变包置底（即使它 10-01 最早到期）');
assert.deepStrictEqual(creditRowsOf([
	{ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: '2026-01-01' },
	{ name: '普通包', used: 0, total: 100, monthly: false, expireAt: '2026-12-31' }
]).map((one) => one.name), ['普通包', '运营裂变包'],
	'裂变包的可读性优先于日期：到期再早也排最后');
/* 月度档内按刷新日升序；没有日期的排在有日期之后（不猜日期，也不插队） */
assert.deepStrictEqual(creditRowsOf([
	{ name: '月度B', used: 0, total: 100, monthly: true, refreshAt: '2026-12-01' },
	{ name: '月度A', used: 0, total: 100, monthly: true, refreshAt: '2026-11-01' },
	{ name: '月度无日期', used: 0, total: 100, monthly: true }
]).map((one) => one.name), ['月度A', '月度B', '月度无日期'],
	'月度档内按刷新日升序；没有日期的排最后');
/* 排序稳定：同档同日期、或都缺日期时保持上游原顺序，界面不会每次刷新跳来跳去 */
assert.deepStrictEqual(creditRowsOf([
	{ name: '同B', used: 0, total: 100, monthly: false, expireAt: '2026-11-07' },
	{ name: '同A', used: 0, total: 100, monthly: false, expireAt: '2026-11-07' }
]).map((one) => one.name), ['同B', '同A'], '到期日相同 → 保持上游原顺序');
assert.deepStrictEqual(creditRowsOf([
	{ name: '无日期B', used: 0, total: 100, monthly: false },
	{ name: '无日期A', used: 0, total: 100, monthly: false }
]).map((one) => one.name), ['无日期B', '无日期A'], '都没有日期 → 保持上游原顺序');
/* 聚合先于排序：11 条裂变包跨两个到期日，排序后仍只出现一行 */
const crossDateSplit = [];
for (let i = 0; i < 11; i += 1) {
	crossDateSplit.push({
		name: '运营裂变包', used: 0, total: 100, monthly: false,
		expireAt: i % 2 === 0 ? '2026-12-01' : '2026-11-07'
	});
}
const crossDateRows = creditRowsOf(crossDateSplit);
assert.strictEqual(crossDateRows.length, 1, '11 条裂变包跨两个到期日 → 仍聚合成 1 行（先聚合后排序）');
assert.strictEqual(crossDateRows[0].count, 11, '聚合行记录 11 条');
assert.strictEqual(crossDateRows[0].label, '运营裂变包×11 · 11-07 到期(最近)',
	'聚合后取最近到期日 11-07 并标 (最近)');
/* 排序函数是纯函数：返回新数组，不改入参 */
const sortInput = [
	{ name: '裂变包', monthly: false, expireAt: '2026-01-01' },
	{ name: '月度包', monthly: true, refreshAt: '2026-12-01' }
];
const sortSnapshot = sortInput.map((one) => one.name);
const sortOutput = api.creditsSort(sortInput);
assert.deepStrictEqual(sortInput.map((one) => one.name), sortSnapshot, 'creditsSort 不改入参顺序（返回新数组）');
assert.deepStrictEqual(Array.from(sortOutput, (one) => one.name), ['月度包', '裂变包'], '返回的才是排好序的新数组');
/* 英文文案：标题 / 月度刷新 / 到期 / 已用 都走英文词表 */
const enBalance = {
	segBalance: 'Balance', f_balance: 'Balance {symbol}{amount}',
	f_balanceDash: 'Balance {symbol}-',
	tipCreditsTitle: 'Points packages', tipCreditsMonthly: ' (monthly)', tipCreditsRefresh: ' · refreshes {date}',
	tipCreditsExpire: ' · expires {date}', tipCreditsRefreshLatest: ' · refreshes {date} (nearest)',
	tipCreditsExpireLatest: ' · expires {date} (nearest)', tipCreditsUsed: 'Used {used} / {total}'
};
const tEnBalance = (key, params) => {
	let out = enBalance[key] !== undefined ? enBalance[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
const wbEn = api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: REWARDS }
}, tEnBalance);
assert.strictEqual(wbEn.text, 'Balance 177', '英文界面积分总数不带货币符号');
assert.strictEqual(wbEn.tip.title, 'Points packages', '英文标题');
assert.deepStrictEqual(Array.from(wbEn.tip.panel.rewards, (one) => one.label), [
	/* 包名**不跟随界面语言**：上游给什么就显示什么（国内站是中文、国际站是英文），
	   只剥掉 CodeBuddy/个人版/国内 这些渠道前缀。所以英文界面里出现中文包名是预期行为。
	   顺序与中文界面同一套三档规则：月度包置顶 → 其余按到期升序 → 裂变包置底。 */
	'个人体验版 · refreshes 11-01',
	'Free Plan Subscription · refreshes 11-01',
	'Bonus Pack · expires 10-26',
	'拉新权益包 · expires 11-07'
], '英文月度「· refreshes MM-DD」/ 一次性「· expires MM-DD」；**月度包置顶、其余按到期升序**；包名保持上游原名（不翻译）');
assert.deepStrictEqual(Array.from(wbEn.tip.panel.rewards, (one) => one.valueText), [
	'Used 500 / 500', 'Used 0 / 100', 'Used 12.39 / 250', 'Used 552.43 / 1500'
], '英文「Used X / Y」，数字同样两位小数去尾零');
/* 英文聚合行：×11 + (nearest) */
const wbEnReal = api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: realRewards }
}, tEnBalance);
assert.deepStrictEqual(Array.from(wbEnReal.tip.panel.rewards, (one) => one.label), [
	'个人体验版 · refreshes 11-01',
	'Bonus Pack · expires 10-26',
	'拉新权益包 · expires 11-07',
	'运营裂变包×11 · expires 11-07 (nearest)'
], '英文聚合行带 ×11 且日期标 (nearest)；非聚合行不带；顺序同样月度置顶、裂变包置底');
/* 失败态 / 查询中：也要按积分口径显示，别又冒出一个 ¥；没有 rewards 同样不给气泡 */
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

/* 积分包名**不做任何翻译**：上游给什么就显示什么，只剥渠道前缀。
   理由（用户拍板）：映射表必然过期 —— 国际站以后出 `Launch Bonus` 这种新包，
   表里没覆盖到就漏翻，反而比不翻更糟。保持原名 + 剥前缀最不会错。
   实测 region=cn 返回：CodeBuddy个人体验版 / CodeBuddy个人版拉新权益包 / CodeBuddy个人版国内运营裂变包。 */
const enRowsOf = (rewards) => Array.from(api.segmentView('balance', {
	...wbSrc,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: rewards }
}, tEnBalance).tip.panel.rewards);
assert.deepStrictEqual(enRowsOf([
	{ name: 'CodeBuddy个人体验版', used: 1, total: 10, monthly: false },
	{ name: 'CodeBuddy个人版拉新权益包', used: 2, total: 10, monthly: false },
	{ name: 'CodeBuddy个人版国内运营裂变包', used: 3, total: 10, monthly: false }
]).map((one) => one.name), ['个人体验版', '拉新权益包', '运营裂变包'],
	'英文界面：国内站中文包名剥前缀后**保持中文原名**（不翻成英文）');
assert.deepStrictEqual(enRowsOf([
	{ name: 'CodeBuddy个人版国内运营裂变包', used: 1, total: 10, monthly: false },
	{ name: 'CodeBuddy个人版国内运营裂变包', used: 1, total: 10, monthly: false }
]).map((one) => ({ name: one.name, count: one.count })), [{ name: '运营裂变包', count: 2 }],
	'英文界面：相邻同名包按**剥前缀后**的名字聚合（×N 由 creditsLabel 拼，不在这里）');
assert.deepStrictEqual(enRowsOf([{ name: 'Bonus Pack', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['Bonus Pack'], '英文界面：国际站英文包名保持原名');
assert.deepStrictEqual(enRowsOf([{ name: 'Launch Bonus', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['Launch Bonus'], '英文界面：上游新增包名原样显示（不靠映射表兜底）');
assert.deepStrictEqual(enRowsOf([{ name: '我的CodeBuddy包', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['我的CodeBuddy包'], '前缀出现在中间不剥（只剥开头）');
assert.deepStrictEqual(creditRowsOf([{ name: 'Bonus Pack', used: 0, total: 1, monthly: false }]).map((one) => one.name),
	['Bonus Pack'], '中文界面：国际站英文包名同样保持原名（不翻成中文）');
console.log('积分包名不翻译：两个界面都保持上游原名，只剥渠道前缀');

/* 包名只做字符串切片、**不再查任何映射表** —— 所以 constructor / toString / __proto__
   这类原型键也不会被当对象渲染（白屏风险随映射表一起消失了）。
   这里仍钉住「返回值必须是字符串」，防止将来有人把查表逻辑加回来却忘了 hasOwnProperty。 */
const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
PROTOTYPE_KEYS.forEach((key) => {
	const zhName = api.creditDisplayName(key);
	assert.strictEqual(typeof zhName, 'string',
		'包名「' + key + '」必须返回字符串（不查表，纯字符串处理），实际 ' + typeof zhName);
	assert.strictEqual(zhName, key, '原型键名没有前缀可剥，原样返回，实际 ' + zhName);
	const enName = api.creditDisplayName(key);
	assert.strictEqual(typeof enName, 'string', '包名「' + key + '」必须返回字符串（与界面语言无关）');
	assert.strictEqual(enName, key, '原型键名原样返回，实际 ' + enName);
});
/* 大小写不同的原型键同样安全（剥前缀时才做大小写不敏感比较，其余原样返回） */
assert.strictEqual(typeof api.creditDisplayName('CONSTRUCTOR'), 'string',
	'大写原型键「CONSTRUCTOR」也返回字符串');
assert.strictEqual(typeof api.creditDisplayName('TOSTRING'), 'string',
	'大写原型键「TOSTRING」也返回字符串');
/* 正常包名不被原型键防护误伤：任意名字都原样返回（不翻译） */
assert.strictEqual(api.creditDisplayName('Bonus Pack'), 'Bonus Pack', '正常英文包名原样返回');
assert.strictEqual(api.creditDisplayName('bonus pack'), 'bonus pack', '大小写原样保留（不查表就没有归一化）');
assert.strictEqual(api.creditDisplayName('BONUS PACK'), 'BONUS PACK', '全大写写法原样返回');
assert.strictEqual(api.creditDisplayName('奖励包'), '奖励包', '中文包名原样返回（不再反向翻成 Bonus Pack）');
assert.strictEqual(api.creditDisplayName('免费版订阅'), '免费版订阅',
	'中文包名原样返回（不再翻成 Free Plan Subscription）');
console.log('积分包名：原型键 / 任意包名都返回字符串，不查映射表');

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
assert.strictEqual(revealLines.length, 2,
	'useRevealBottom 恰好两处调用（价格浮层 / 条目币种菜单；顶部默认币种选择器 task-24 已删），实际 ' + revealLines.length);
assert.strictEqual((code.match(/const useRevealBottom = \(ref, active, extraKey\)/g) || []).length, 1,
	'只有一份实现（不要各写一份）');
assert.ok(code.includes('useRevealBottom(editPopRef, editing !== null'), '第一处：价格编辑浮层');
assert.ok(code.includes('useRevealBottom(currencyMenuRef, currencyOpen === true, null)'), '第二处：条目币种菜单');
const wiredRefs = ['editPopRef', 'currencyMenuRef'];
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
assert.ok(code.includes('currencySelect("__entrycur", draft, currencyOpen, setCurrencyOpen, currencyMenuRef'),
	'条目级选择器把菜单 ref 传进 currencySelect');

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

/* task-25：「恢复默认」**区分两类条目** —— 官方内置（键命中 `DEFAULT_PRICES`）回官方默认价（含被删掉的加回来），
   用户自建（键不在官方表里）逐字段不变。fixture 故意：官方 flash 改乱值 + 切成 USD、官方 v4-pro **删掉**、
   自建两条（一条含明确填的 0 与 null、都带自己的 currency）。 */
{
	const store2 = new Map();
	const USER_MODELS = {
		'deepseek-flash': {
			tiered: false,
			currency: 'USD',
			peak: { input: 99, cacheRead: 0, cacheWrite: 0, output: 8 },
			offPeak: { input: 0.02, cacheRead: 0.02, cacheWrite: 0, output: 0.1 }
		},
		'my-own-model': {
			tiered: true,
			currency: 'USD',
			peak: { input: 9, cacheRead: 1, cacheWrite: 0, output: 20 },
			offPeak: { input: 4.5, cacheRead: 0.5, cacheWrite: 0, output: 10 }
		},
		'zero-model': {
			tiered: false,
			currency: 'CNY',
			peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
			offPeak: { input: null, cacheRead: null, cacheWrite: null, output: null }
		}
	};
	store2.set(CONFIG_KEY, JSON.stringify({
		version: 5, priceVersion: 2, enabled: true, wrap: false,
		segments: MESSY_SEGMENTS.slice(), hidden: ['counts'],
		/* `currency` 只是"新增条目的默认币种"；官方顺序那个键**故意排在自建键后面**，验恢复默认会覆盖它 */
		currency: 'USD', contextMeter: false,
		modelOrder: ['zzz-first', 'my-own-model', 'deepseek-flash', 'zero-model'],
		models: USER_MODELS
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
	const customKeys = ['my-own-model', 'zero-model'];
	const officialKeys = Object.keys(api2.DEFAULT_PRICES);
	assert.deepStrictEqual(Object.keys(modelsInMemory).sort(), ['deepseek-flash', 'my-own-model', 'zero-model'],
		'前置：内存里的价格库 = 用户那份（官方 v4-pro 已被删掉，且没被官方参考价合并回来）');
	/* 恢复默认后：官方键回官方表、自建键逐字段不变、官方键加回来、顺序 = 官方 + 自建 */
	for (const name of customKeys) {
		const one = modelsInMemory[name];
		assert.strictEqual(one.currency !== undefined && one.currency !== null, true,
			'前置：自建条目自带 currency（' + name + '）');
	}
	const officialBefore = JSON.parse(JSON.stringify(modelsInMemory['deepseek-flash']));
	assert.strictEqual(officialBefore.peak.input, 99, '前置：官方 flash 被改成 99');
	assert.strictEqual(officialBefore.currency, 'USD', '前置：官方 flash 被切成 USD');
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
	/* task-25：官方键回官方默认值、自建键逐字段不变、被删的官方键加回来、顺序 = 官方 + 自建。
	   vm 出来的对象原型与主域不同，deepStrictEqual 会因此失败 —— 两边都先 JSON 化。 */
	const plain = (value) => JSON.parse(JSON.stringify(value));
	assert.deepStrictEqual(Object.keys(afterReset.models).sort(), officialKeys.concat(customKeys).sort(),
		'恢复默认后价格库 = 官方键 + 自建键（被删掉的官方 v4-pro 加回来了）');
	/* ① 官方键：逐字段等于官方默认表（含 tiered / 两档 / 官方 0 与 null），币种回 CNY */
	for (const name of officialKeys) {
		assert.deepStrictEqual(plain(afterReset.models[name]),
			{ tiered: true, currency: 'CNY', peak: plain(api2.DEFAULT_PRICES[name].peak), offPeak: plain(api2.DEFAULT_PRICES[name].offPeak) },
			'官方条目恢复成官方默认值（' + name + '）');
	}
	assert.deepStrictEqual(plain(afterReset.models['deepseek-flash'].peak),
		{ input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, '官方 flash 回官方 CNY 价');
	assert.strictEqual(afterReset.models['deepseek-flash'].currency, 'CNY', '官方条目币种回 CNY');
	assert.strictEqual(afterReset.models['deepseek-flash'].peak.input, 2,
		'官方模型先前被改成 99 ⇒ 恢复默认后被覆盖回官方值（有意取舍）');
	assert.ok(afterReset.models['deepseek-v4-pro'] !== undefined, '被删掉的官方条目要加回来');
	assert.deepStrictEqual(plain(afterReset.models['deepseek-v4-pro'].offPeak),
		{ input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 }, '加回来的官方条目就是官方价');
	/* ② 自建键：逐字段不变（含明确填的 0 与 null、以及它自己的 currency） */
	for (const name of customKeys) {
		assert.deepStrictEqual(plain(afterReset.models[name]), plain(modelsInMemory[name]),
			'自建条目逐字段不变（' + name + '）');
	}
	assert.strictEqual(afterReset.models['zero-model'].peak.cacheRead, 0, '自建条目明确填的 0 仍是 0');
	assert.deepStrictEqual(plain(afterReset.models['my-own-model'].peak),
		{ input: 9, cacheRead: 1, cacheWrite: 0, output: 20 }, '自建条目两档价原样保留');
	/* ③ 顺序：官方键（官方顺序）在前 + 自建键（原相对顺序）在后 */
	assert.deepStrictEqual(plain(afterReset.modelOrder), officialKeys.concat(customKeys),
		'modelOrder = 官方键（官方顺序）在前 + 自建键（原相对顺序）在后');
	console.log('恢复默认：界面配置回默认 · 官方键回官方价（含被删的加回）· 自建键逐字段不变 · 顺序 ' + afterReset.modelOrder.join(' → '));
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
assert.strictEqual(collectByClass(priceTree, 'dsb-default-currency').length, 0, '顶部选择器已删除（task-24），条目选择器在浮层里');
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
	{ input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 },
	'官方内置条目切币种 ⇒ 整条换成官方**另一套参考价表**（不是按汇率换算）');
assert.deepStrictEqual(afterEntry.models['deepseek-v4-pro'].offPeak,
	{ input: 0.66, cacheRead: 0.022, cacheWrite: 0, output: 1.98 }, '空闲档同样等于官方另一套表');
assert.strictEqual(afterEntry.models['deepseek-v4-pro'].tiered, true, 'tiered 标记保留');
assert.notStrictEqual(afterEntry.models['deepseek-v4-pro'].peak.input, 1.334831,
	'不等于按比率算出来的 1.334831（用户明确反对按汇率改数值）');
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
assert.ok(shownValues.indexOf('3.96') !== -1,
	'正在编辑的这张卡立刻换成官方另一套表的数字，实际 ' + JSON.stringify(shownValues));
/* task-24：顶部那个"新增条目的默认币种"选择器**整个删除**（用户说还残留）—— 负断言钉住 */
assert.strictEqual(collectByClass(renderSettings(), 'dsb-default-currency').length, 0, '顶部默认币种选择器已删除');
assert.strictEqual(code.indexOf('dsb-default-currency'), -1, 'CSS/代码里不该再有 dsb-default-currency');
assert.strictEqual(code.indexOf('setDefaultCurrency'), -1, 'setDefaultCurrency 已删除');
['defaultCurrencyOpen', 'defaultCurrencyMenuRef', 'defaultCurrencyRef', 'picker.kind'].forEach((gone) => {
	assert.strictEqual(code.indexOf(gone), -1, '顶部选择器的残留标识不该再出现：' + gone);
});
const settingsTextNoPick = textOf(renderSettings());
assert.strictEqual(settingsTextNoPick.indexOf('默认币种'), -1, '设置页不该再有"默认币种"文字');
assert.strictEqual(settingsTextNoPick.indexOf('default currency'), -1, '设置页不该再有 default currency 文字');
assert.strictEqual(collectByClass(renderSettings(), 'dsb-currency-pick').length, 1, '币种选择器只剩**打开的那张卡浮层里**那一个');
/* 改过数值的条目（deepseek-flash 手改过）切币种 ⇒ 数值一字不变、只改 currency */
buttonByLabel(cardByKey(priceTree, 'deepseek-flash'), '修改').props.onClick();
priceTree = renderSettings();
const flashBefore = JSON.parse(store.get(api.STORAGE_KEY)).models['deepseek-flash'];
const flashPick = collectByClass(collectByClass(cardByKey(priceTree, 'deepseek-flash'), 'dsb-edit-pop')[0], 'dsb-currency-pick')[0];
assert.ok(flashPick !== undefined, '改过数值的条目也有条目级选择器');
collectByClass(flashPick, 'dsb-select-btn')[0].props.onClick();
priceTree = renderSettings();
collectByClass(priceTree, 'dsb-select-item').filter((one) => textOf(one) === 'USD')[0].props.onClick();
const flashAfter = JSON.parse(store.get(api.STORAGE_KEY)).models['deepseek-flash'];
assert.strictEqual(flashAfter.currency, 'USD', '改过数值的条目：只改币种标记');
assert.deepStrictEqual({ peak: flashAfter.peak, offPeak: flashAfter.offPeak, tiered: flashAfter.tiered },
	{ peak: flashBefore.peak, offPeak: flashBefore.offPeak, tiered: flashBefore.tiered },
	'改过数值的条目切币种 ⇒ 数值一字不变（不按比率换算）');
/* task-23：三处新增文案已回退 —— 界面不出现这些文字，后两个 i18n 键连键删除 */
const sectionText = textOf(renderSettings());
['每个条目按它自己的币种计价', 'Each entry is priced in its own currency', '新增条目的默认币种', '本条目的币种'].forEach((bad) => {
	assert.strictEqual(sectionText.indexOf(bad), -1, '设置页不该再出现这段文字：' + bad);
});
['priceEntryCurrency', 'priceDefaultCurrency'].forEach((key) => {
	assert.strictEqual(code.indexOf(key), -1, 'i18n 里这个键（中英）都已删除：' + key);
});
assert.strictEqual(collectByClass(renderSettings(), 'dsb-default-currency').length, 0, '顶部默认币种选择器已删除（task-24）');
assert.strictEqual(collectByClass(renderSettings(), 'dsb-currency-pick').length, 1, '条目级币种选择器仍在（只是没有文字标签）');
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
assert.strictEqual(savedModels()['glm-5.3-flash'].currency, 'CNY', '新增条目带默认币种 CNY（顶部选择器已删除，写死 CNY）');
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

/* 需求 C（task-5，本轮按用户实测反馈改口径）：两档所有字段都是空字符串 = 价格先空着
   ⇒ **条目照样留在价格库里**（用户反馈：新建的自定义模型没填价格，点保存会被自动删掉）；
   只要明确填过数字（**包括明确填 0**）就写入，空着的格子按 null。
   此刻展开的是刚加的那条「1」，草稿全空 —— 正好用来验第一件事。 */
const justAdded = cardByName(priceTree, '1');
assert.deepStrictEqual(numberValues(justAdded), ['', '', ''],
	'新加的条目展开时三个框要留空，实际 ' + JSON.stringify(numberValues(justAdded)));
buttonByLabel(justAdded, '保存').props.onClick();
const blankSaved = savedModels()['1'];
assert.ok(blankSaved !== undefined, '一个字都没填就保存 ⇒ 条目仍留在价格库里（不再自动删除）');
assert.deepStrictEqual(blankSaved.peak, { input: null, cacheRead: null, cacheWrite: null, output: null },
	'没填的格子存成 null（不是 0）');
assert.deepStrictEqual(blankSaved.offPeak, { input: null, cacheRead: null, cacheWrite: null, output: null },
	'用户没碰过的那一档整档 null');
assert.strictEqual(blankSaved.currency, 'CNY', '新建条目的币种仍是界面默认的 CNY');
priceTree = renderSettings();
assert.ok(cardByName(priceTree, '1') !== undefined, '保存后卡片仍留在列表里（不再等于取消添加）');
assert.deepStrictEqual(collectByClass(priceTree, 'dsb-model-name').map(textOf),
	['DeepSeek-Flash', 'DeepSeek-V4-Pro', 'GLM-5.3-Flash', '1'], '列表里仍有刚建的那条');

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
console.log('价格库草稿：新增留空 / 全空保存保留条目 / 明确填 0 保留 / 已有回填真实数值');

/* 用户反馈（bug 2）：新建的自定义模型填了价格、还没点保存就切币种 ⇒ 已填的输入必须留住。
   切币种本身只该改这一条的币种标记，不能把没保存的草稿值写进价格库、更不能清空输入框。 */
buttonByLabel(cardByKey(priceTree, 'zero-kept'), '修改').props.onClick();
priceTree = renderSettings();
const keptBefore = JSON.parse(JSON.stringify(savedModels()['zero-kept']));
numberInputs(cardByKey(priceTree, 'zero-kept'))[2].props.onChange({ target: { value: '9' } });   /* 输出=9，还没保存 */
priceTree = renderSettings();
const keptPick = collectByClass(collectByClass(cardByKey(priceTree, 'zero-kept'), 'dsb-edit-pop')[0], 'dsb-currency-pick')[0];
assert.ok(keptPick !== undefined, '自建条目也有条目级币种选择器');
collectByClass(keptPick, 'dsb-select-btn')[0].props.onClick();
priceTree = renderSettings();
collectByClass(priceTree, 'dsb-select-item').filter((one) => textOf(one) === 'USD')[0].props.onClick();
priceTree = renderSettings();
const keptShown = numberValues(cardByKey(priceTree, 'zero-kept'));
assert.deepStrictEqual(keptShown, ['0', '5', '9'],
	'切币种后，已填还没保存的价格必须原样留在框里，实际 ' + JSON.stringify(keptShown));
const keptAfter = savedModels()['zero-kept'];
assert.strictEqual(keptAfter.currency, 'USD', '切币种只改这一条的币种标记');
assert.deepStrictEqual({ peak: keptAfter.peak, offPeak: keptAfter.offPeak },
	{ peak: keptBefore.peak, offPeak: keptBefore.offPeak },
	'切币种不该把没保存的草稿值写进价格库');
buttonByLabel(cardByKey(priceTree, 'zero-kept'), '保存').props.onClick();
const keptSaved = savedModels()['zero-kept'];
assert.strictEqual(keptSaved.peak.output, 9, '点保存后没保存的输入才落库');
assert.strictEqual(keptSaved.peak.input, 5, '同一档其它格保持原值');
assert.strictEqual(keptSaved.peak.cacheRead, 0, '明确填过的 0 仍是数字 0');
assert.strictEqual(keptSaved.currency, 'USD', '落库时带上切换后的币种');
console.log('切币种保住未保存的输入：自建条目换币种只改标记、草稿原样留下、点保存才落库');

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
	/* 契约：每注入一次记一条 `{ name, manual }`；ponytail 注入两次、其中一次是用户手动调用 */
	skills: [
		{ name: 'ponytail', manual: false },
		{ name: 'my-dow-theory', manual: false },
		{ name: 'ponytail', manual: true }
	],
	/* 全局提示词（~/.dsh/AGENTS.md 这类）：也算一次注入，并计入那一行的数 */
	globalInstruction: 'AGENTS.md',
	compactCount: 2, compactTurn: 32, compactStep: 2,
	/* 只给成功的压缩；第二条是用户手动压缩：轮间压缩没有 turn，by afterTurn 记「第20轮后」，
	   行尾带上标星号 */
	compacts: [
		{ turn: 12, step: 3, manual: false, afterTurn: null },
		{ turn: null, step: null, manual: true, afterTurn: 20 }
	]
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
assert.deepStrictEqual(listRows(tree).map((one) => one.name), ['AGENTS.md', 'ponytail*', 'my-dow-theory'],
	'全局提示词 AGENTS.md 固定第一、不参与技能排序；其余按名字长短（ponytail 8 < my-dow-theory 13）；手动调用的 ponytail 带上标星号，实际 ' + JSON.stringify(listRows(tree)));
assert.deepStrictEqual(listRows(tree).map((one) => one.value), ['', '', ''],
	'技能注入只列名字、不显示次数（次数只在排序里用到；AGENTS.md 同样不显示）');
/* 星号是上标节点：给读屏一个「手动触发」名称（role=img + aria-label），视觉仍只有 * */
const skillStars = collectByClass(tree, 'dsb-sup');
assert.strictEqual(skillStars.length, 1, '只有手动调用过的那一行带星号');
assert.strictEqual(skillStars[0].props['aria-label'], '手动触发', '星号读屏名称是「手动触发」');
assert.strictEqual(skillStars[0].props.role, 'img', '星号带 img 角色，aria-label 才生效');
assert.strictEqual(skillStars[0].props['aria-hidden'], undefined, '星号不再对读屏隐藏');
assert.strictEqual(textOf(skillStars[0]), '*', '星号节点内容是 *');
assert.strictEqual(collectByClass(tree, 'dsb-meter-cols').length, 0, '三个技能不分列');
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 0, '技能注入子视图不收紧间隙');
console.log('技能注入子视图:', listRows(tree).map((one) => one.name).join(' / '));

/* 点标题返回上一层 */
collectByClass(tree, 'dsb-meter-back')[0].props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '会话数据', '点标题回到会话数据');
assert.deepStrictEqual(listRows(tree).map((one) => one.name), ['上下文压缩', '技能注入', '工具调用'], '根视图仍是那三行');

/* 工具调用子视图：原生英文名 + 按名字长度升序、同长度按次数降序，带次数与单位 */
rowAt(tree, '工具调用').props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '工具调用', '工具调用子视图标题');
/* toolCounts = { read: 7, edit: 3, pwsh: 2 }：三个名字都是 4 个字符，
   同长度按次数降序 ⇒ read 7 > edit 3 > pwsh 2（手算后写死，不借实现的排序函数） */
assert.deepStrictEqual(listRows(tree), [
	{ name: 'read', value: '7 次' },
	{ name: 'edit', value: '3 次' },
	{ name: 'pwsh', value: '2 次' }
], '工具名直接用原生英文名，按名字长度升序、同长度按次数降序，实际 ' + JSON.stringify(listRows(tree)));
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 1, '工具调用子视图挂 dsb-meter-tight（间隙收到 1ch）');
assert.strictEqual(collectByClass(tree, 'dsb-meter-full').length, 0, '不再有英文整行块');
/* 标题下的横杠换成彩色分段条：第一段用浅色 01、宽度 = 次数 ÷ 总次数；每段带悬浮提示 */
assert.strictEqual(collectByClass(tree, 'dsb-meter-divider').length, 0, '工具调用子视图不再用普通分隔线');
const toolBar = collectByClass(tree, 'dsb-bar')[0];
assert.ok(toolBar !== undefined, '工具调用子视图标题下有分段条');
const toolSegs = collectByClass(toolBar, 'dsb-bar-seg');
assert.strictEqual(toolSegs.length, 3, '3 个工具 = 3 段');
assert.strictEqual(toolSegs[0].props.style.backgroundColor, '#FFBFD1', '第 1 段用浅色 01');
assert.strictEqual(toolSegs[1].props.style.backgroundColor, '#FFC5AB', '第 2 段用浅色 02');
assert.strictEqual(toolSegs[2].props.style.backgroundColor, '#F4D06A', '第 3 段用浅色 03');
const widthOf = (one) => Math.round(parseFloat(one.props.style.width) * 1000) / 1000;
assert.deepStrictEqual(Array.from(toolSegs, widthOf), [Math.round((7 / 12) * 100 * 1000) / 1000, 25, Math.round((2 / 12) * 100 * 1000) / 1000],
	'段宽 = 该工具次数 ÷ 总次数（read 7 / edit 3 / pwsh 2）');
assert.strictEqual(toolSegs[0].props.title, undefined, '彩条段不再用浏览器原生 title（改插件浮层）');
assert.strictEqual(typeof toolSegs[0].props.onMouseEnter, 'function', '彩条段挂插件自己的悬停回调');
console.log('工具调用子视图:', listRows(tree).map((one) => one.name + ' ' + one.value).join(' / '));
/* 其它子视图仍是普通分隔线 */
collectByClass(tree, 'dsb-meter-back')[0].props.onClick(clickEvent());
rowAt(renderCounts(), '技能注入').props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(collectByClass(tree, 'dsb-meter-divider').length, 1, '技能注入子视图仍是普通分隔线');
assert.strictEqual(collectByClass(tree, 'dsb-bar').length, 0, '技能注入子视图没有分段条');

/* 压缩次数子视图：逐条列出每次压缩落在第几轮第几步（中文序数） */
collectByClass(tree, 'dsb-meter-back')[0].props.onClick(clickEvent());
tree = renderCounts();
rowAt(tree, '上下文压缩').props.onClick(clickEvent());
tree = renderCounts();
assert.strictEqual(panelTitle(tree), '上下文压缩', '上下文压缩子视图标题');
assert.strictEqual(collectByClass(tree, 'dsb-meter-tight').length, 0, '上下文压缩子视图不收紧间隙');
assert.deepStrictEqual(listRows(tree), [
	{ name: '第一次压缩', value: '第12轮3步' },
	/* 手动压缩：星号在行尾（「第二次压缩*」），上标挂在最后、不拆开「第二次」；
	   轮间压缩没有 turn，落点用 afterTurn 显示「第20轮后」而不是横杠 */
	{ name: '第二次压缩*', value: '第20轮后' }
], '压缩明细按发生顺序逐条列，实际 ' + JSON.stringify(listRows(tree)));
assert.strictEqual(collectByClass(tree, 'dsb-sup').length, 1, '手动压缩那条带一个上标星号');
console.log('上下文压缩子视图:', listRows(tree).map((one) => one.name + ' ' + one.value).join(' / '));

/* 分列：每一竖列最多三行，超过就多开一竖列（默认档；工具调用那档折行时由 DOM 量测换成四行） */
const manyTools = (n) => {
	const names = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill',
		'subagent', 'present', 'web_search', 'web_fetch', 'workflow', 'job_list', 'job_output'];
	const counts = {};
	for (let i = 0; i < n; i += 1) counts[names[i]] = i + 1;
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

/* 长短混合的工具名全部进同一个列网格（不再有「整行块」）：短名多、长名也照常分列 */
const mixedTools = openTools({
	turn: 1, turnSteps: 1, toolCalls: 12,
	toolCounts: { pwsh: 4, read: 3, write: 2, edit: 1, mcp__demo__search: 6, custom_tool: 5 },
	skills: [], globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: []
});
assert.strictEqual(collectByClass(mixedTools, 'dsb-meter-full').length, 0, '没有英文整行块：全部统一列网格');
assert.strictEqual(collectByClass(mixedTools, 'dsb-meter-split').length, 0, '没有分列 + 整行块的外层');
assert.strictEqual(collectByClass(mixedTools, 'dsb-meter-cols').length, 1, '只有一个列网格');
assert.strictEqual(collectByClass(mixedTools, 'dsb-meter-row').length, 6, '6 个工具都在网格里');
assert.ok(String(collectByClass(mixedTools, 'dsb-tip')[0].props.className).indexOf('dsb-meter-wide') !== -1, '分列时气泡走宽档');
const mixedOrder = collectByClass(mixedTools, 'dsb-meter-name').map(textOf);
assert.deepStrictEqual(mixedOrder, ['pwsh', 'read', 'edit', 'write', 'custom_tool', 'mcp__demo__search'],
	'按名字长度升序（4 字组内按次数降序：pwsh 4 > read 3 > edit 1）→ 长名排在后面，实际 ' + JSON.stringify(mixedOrder));
console.log('工具调用混合长短名:', mixedOrder.join(' / '));

/* 不再按中文名合并：bash / pwsh / ops_bash 是不同工具，各占一行 */
const mergedTools = openTools({
	turn: 1, turnSteps: 1, toolCalls: 10,
	toolCounts: { pwsh: 2, bash: 5, ops_bash: 3, read: 1 },
	skills: [], globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: []
});
assert.deepStrictEqual(collectByClass(mergedTools, 'dsb-meter-row').map((one) => ({
	name: textOf(collectByClass(one, 'dsb-meter-name')[0]),
	value: textOf(collectByClass(one, 'dsb-meter-value')[0])
})), [
	{ name: 'bash', value: '5 次' },
	{ name: 'pwsh', value: '2 次' },
	{ name: 'read', value: '1 次' },
	{ name: 'ops_bash', value: '3 次' }
], '原生工具名各自一行（4 字组：bash 5 > pwsh 2 > read 1；ops_bash 更长排最后），不再合并成「命令行」');
console.log('原生工具名不合并:', collectByClass(mergedTools, 'dsb-meter-name').map(textOf).join(' / '));

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

	/* 工具调用自适应：一排放不下（横向溢出）时每列行数 3→4→5 逐档加，直到放得下；
	   返回上一层再点进来要回到默认 3 行（重置），不能带着上一次的 5 行。
	   替身里的假几何：stubWrapOn 时列网格容器只放得下 stubWrapCap 列，列数多过它就是"放不下"
	   （nowrap 之后不会再折行，溢出是唯一表现 —— 见 toolColumnsOverflow）。 */
	stubWrapOn = true;
	stubWrapCap = 3;
	barHooks.values.length = 0;
	const wrappedProgress = manyTools(13);
	collectByClass(renderCounts(wrappedProgress), 'dsb-seg-click').filter((one) => one.props.key === '__segcounts')[0]
		.props.onClick(clickEvent());
	renderCounts(wrappedProgress);
	rowAt(renderCounts(wrappedProgress), '工具调用').props.onClick(clickEvent());
	/* 每渲染一遍只升一档，多渲染几遍让它收敛：5 行时 13 个工具正好 3 列，不再超过每排 3 列 */
	for (let i = 0; i < 6; i += 1) renderCounts(wrappedProgress);
	const wrappedCols = columnsOf(renderCounts(wrappedProgress));
	/* 替身里的 layout effect 量到的是上一帧的树（真实 React 在提交后量当前帧），因此会多升一档：
	   最终是每列 6 行（6/6/1）、三个列正好一排放得下；「恰好停在第 5 行」由
	   verify-list-layout 的纯函数收敛用例精确钉住（那里没有这一帧延迟）。 */
	assert.strictEqual(wrappedCols.length, 3, '13 个工具 + 每排最多 3 列：逐档加到一排放得下，收成一排 3 列，实际 ' + wrappedCols.length);
	assert.ok(wrappedCols.every((one) => collectByClass(one, 'dsb-meter-row').length <= 6), '一排放得下后不再继续加行（替身最多多升一档到 6 行）');
	/* 重置：返回再进来，行数回默认 3 */
	stubWrapOn = false;
	collectByClass(renderCounts(wrappedProgress), 'dsb-meter-back')[0].props.onClick(clickEvent());
	renderCounts(wrappedProgress);
	rowAt(renderCounts(wrappedProgress), '工具调用').props.onClick(clickEvent());
	const resetCols = columnsOf(renderCounts(wrappedProgress));
	assert.strictEqual(resetCols.length, 5, '返回后行数重置回 3：13 个工具 → 5 列，实际 ' + resetCols.length);
	assert.ok(resetCols.every((one) => collectByClass(one, 'dsb-meter-row').length <= 3), '每列回到不超过 3 行');
	console.log('工具调用自适应：放不下时逐档加行直到放得下；返回后重置回 3 行');
} finally {
	runEffects = false;
	stubTipWidth = 0;
	stubRingLeft = 120;
	stubWrapOn = false;
	stubWrapCap = 3;
	barHooks.values.length = 0;
}

/* 工具调用彩条的悬停提示：**没有气泡**，只显示一行文字（工具名 + 占比），跟鼠标。
   用一套独立 hooks，避免悬停状态漏到其它用例。 */
const hoverHooks = makeHooks();
const paintHover = () => withHooks(hoverHooks, () => api.StatusBar(skillProps));
collectByClass(paintHover(), 'dsb-seg-click').filter((one) => one.props.key === '__segcounts')[0].props.onClick(clickEvent());
rowAt(paintHover(), '工具调用').props.onClick(clickEvent());
const hovTree = paintHover();
const hovSegs = collectByClass(hovTree, 'dsb-bar-seg');
assert.ok(hovSegs.length === 3, '工具彩条有 3 段');
assert.strictEqual(hovSegs[0].props.title, undefined, '不再有浏览器原生 title');
assert.strictEqual(typeof hovSegs[0].props.onMouseMove, 'function', '色段挂 onMouseMove（提示跟着鼠标走）');
const hoverColorClass = String(collectByClass(hovTree, 'dsb-bar')[0].props.className);
assert.ok(hoverColorClass.indexOf('dsb-bar-hoverable') !== -1, '工具彩条挂 hoverable 类（悬停凸起动效）');
/* 反面断言：悬停放大**只在工具调用这个下钻子视图**启用。
   只测正面（indexOf 命中）挡不住"判据放宽"—— 把 `opened !== null && opened.tight === true`
   改成 `opened !== null`（或 `tight !== false`）后，其它带色条的视图会冒出不该有的放大动效，
   而正面断言照样绿（审查 C 的 M10 / M13 变异就是这么存活的）。

   ⚠ 必须挑**真的走那个三元表达式**的视图。三类要分清：
     · 令牌面板（cost / lastCost）走 `tokenPanel` → `meterBar`，类名是**硬编码**的 "dsb-bar"，
       根本不经过那个三元 —— 拿它断言等于空转（第一版就写错了，实测 M10/M13 仍绿）；
     · 技能注入 / 上下文压缩子视图根本不画色条（没有 segments）；
     · **总用时（sessionTime）根视图**才是对的：它 `kind: "rows"` 且带 `segments`。
   但它在 StatusBar 里要 host 的 `desktopStatusbarActiveTime` 投影（这里没那份夹具，
   强喂会把这条断言变成空转），所以直接调 `rowsPanel` 渲染同一份 tip ——
   它正是那个三元表达式所在的函数，`sub.id === null` ⇒ 必须拿到普通 "dsb-bar"。 */
const timeTipForProbe = api.segmentView('sessionTime', {
	stats: { ttftMs: 2000, decodeMs: 1000, toolMs: 45000 },
	timeRange: { turns: 5400000, since: null, steps: 0, stepSince: null },
	now: FIXED_NOW, subagent: null
}, t).tip;
assert.ok(Array.isArray(timeTipForProbe.segments) && timeTipForProbe.segments.length > 0,
	'前置：总用时 tip 确实带 segments（否则这条反面断言是空转）');
const rootBarPanel = api.rowsPanel(timeTipForProbe, null, { current: null }, {
	id: null, open: () => {}, back: () => {}, rowsPerColumn: 3
});
const rootBars = collectByClass(rootBarPanel, 'dsb-bar');
assert.strictEqual(rootBars.length, 1, '总用时根视图有 1 条分段条，实际 ' + rootBars.length);
assert.strictEqual(String(rootBars[0].props.className), 'dsb-bar',
	'根视图（总用时）色条的 className 必须严格等于 dsb-bar，实际「'
	+ String(rootBars[0].props.className) + '」—— 悬停放大只允许出现在工具调用子视图');
console.log('悬停放大只在工具调用子视图：根视图色条严格等于 dsb-bar');
/* 工具彩条自己的类名也要**严格等于**两个词的组合：
   光写 indexOf 的话，改成 "dsb-bar dsb-bar-hoverable-legacy" 这种（CSS 选择器不再命中、
   动效彻底失效）也照样通过 —— 审查 C 的 P4 变异就是这么存活的。 */
assert.strictEqual(String(collectByClass(hovTree, 'dsb-bar')[0].props.className), 'dsb-bar dsb-bar-hoverable',
	'工具彩条的 className 严格等于「dsb-bar dsb-bar-hoverable」（不是只含这个名字）');
const hovEvent = (x, y) => ({ stopPropagation() {}, clientX: x, clientY: y });
hovSegs[0].props.onMouseEnter(hovEvent(200, 500));
const hoverTree = paintHover();
assert.strictEqual(collectByClass(hoverTree, 'dsb-hovercard').length, 0, '悬停不再弹气泡');
const plain = collectByClass(hoverTree, 'dsb-hover-plain')[0];
assert.ok(plain !== undefined, '悬停后出现纯文字提示');
assert.strictEqual(textOf(plain), 'read 58.33%', '纯文字内容 = 工具名 + 占比（read 7/12，两位小数），实际 ' + textOf(plain));
assert.strictEqual(plain.props.onClick, undefined, '文字提示不可点、不拦截鼠标');
/* 在同一个色段里横向移动：提示不消失、内容不变（onHoverMove 直接改 DOM 坐标，不触发重渲染） */
hovSegs[0].props.onMouseMove(hovEvent(260, 500));
assert.strictEqual(collectByClass(paintHover(), 'dsb-hover-plain').length, 1, '段内移动时提示保持存在、不闪断');
assert.strictEqual(textOf(collectByClass(paintHover(), 'dsb-hover-plain')[0]), 'read 58.33%',
	'段内移动后提示内容不变');
hovSegs[1].props.onMouseEnter(hovEvent(400, 500));
assert.strictEqual(textOf(collectByClass(paintHover(), 'dsb-hover-plain')[0]), 'edit 25.00%',
	'第二段 = edit 3/12 = 25.00%');
console.log('工具彩条悬停提示：read 58.33% / edit 25.00%（无气泡、跟鼠标、段内移动不闪断）');

/* --------------------- 端到端：放不下就整组不显示（走真实链路，不是只喂 rowsPanel）
   这条守的是**接线**：量宽度 → plainFits 判定 → setHoverPlainOff(true) → 传给 rowsPanel →
   所有段都不挂 onMouseEnter。审查发现只测 rowsPanel 契约时，把 `hoverSuppressed: hoverPlainOff`
   改成恒 false（功能整体失效）50 个测试仍全绿 —— 所以必须走 StatusBar 真实渲染。

   做法：把提示的自然宽度调到远超可用区间（stubHoverPlainWidth），触发一次悬停让 layout effect
   量出来并判定；下一帧重新渲染，这时色条段就**不该**再挂 onMouseEnter。 */
/* --------------------- 接线守门：放不下就整组不显示（不依赖替身的 effect 时序）
   审查发现：只测 `rowsPanel` 契约时，把 StatusBar 里 `hoverSuppressed: hoverPlainOff`
   改成恒 `false`（用户要的功能整体失效）50 个测试仍全绿 —— 因为那条接线没人守。
   替身的 layout effect 时序和真实 React 有差异（渲染中途 vs 挂完 DOM），
   硬凑端到端会变成调试替身；这里改用**静态接线断言**，能精确抓住那类错误。
   行为本身的边界由前面 plainFits 那组断言守住。 */
const wiringSource = code.replace(/\/\*[\s\S]*?\*\//g, '');
const hoverSuppressedAt = wiringSource.indexOf('hoverSuppressed:');
assert.ok(hoverSuppressedAt !== -1, 'StatusBar 里必须把开关传给 rowsPanel（hoverSuppressed）');
const hoverSuppressedArg = wiringSource.slice(hoverSuppressedAt, hoverSuppressedAt + 120);
assert.ok(/hoverSuppressed:\s*hoverPlainOff\b/.test(hoverSuppressedArg),
	'hoverSuppressed 必须接 hoverPlainOff（不是恒 false / 恒 true），实际片段：' + hoverSuppressedArg.slice(0, 80));
/* hoverPlainOff 的两个写点都必须存在：置 true（判出放不下）与复位（换气泡/重新放得下） */
assert.ok(/setHoverPlainOff\(true\)/.test(wiringSource), '判出放不下时必须 setHoverPlainOff(true)');
assert.ok(/setHoverPlainOff\(false\)/.test(wiringSource),
	'必须有 setHoverPlainOff(false) 复位 —— 否则碰到一次长工具名后，此页面悬停永久失效');
/* 复位必须**同时**覆盖两条路径，缺一条就有 bug：
   ① 同气泡内重新放得下时复位（量测 effect 里，紧随 setHoverPlainOff(true) 之后）；
   ② 关气泡 / 换气泡时复位（tipId 清理 effect 里）—— 缺这条就是审查发现的死锁：
      `HoverPlainOff` 一旦置 true，悬停全被禁用 → 再也触发不了量测 → 永不复位 → 本页面永久失效。 */
const resetAll = [];
let resetAt = wiringSource.indexOf('setHoverPlainOff(false)');
while (resetAt !== -1) {
	resetAll.push(resetAt);
	resetAt = wiringSource.indexOf('setHoverPlainOff(false)', resetAt + 1);
}
assert.ok(resetAll.length >= 2,
	'必须有**两处** setHoverPlainOff(false)：同气泡重新放得下 与 关气泡时复位，实际 ' + resetAll.length + ' 处');
const resetNearClose = resetAll.some((at) => {
	const around = wiringSource.slice(Math.max(0, at - 300), at + 100);
	return around.indexOf('setHoverCard(null)') !== -1;
});
assert.ok(resetNearClose,
	'必须有一处复位写在「气泡关闭就清空悬停状态」的 effect 里（setHoverCard(null) 附近）——'
	+ '否则碰到一次长工具名后，此页面所有工具名悬停永久失效');
console.log('悬停接线：hoverSuppressed = hoverPlainOff；判出放不下置 true，关气泡复位');

/* ---------------------------------------------- 悬停文字放不下就不显示（取代缩放）
   用户拍板：工具名很长、气泡不够长时，**所有**工具名的悬停提示一律不出现，
   不是只关掉那个超长的、也不是缩小硬塞进去。所以这里守两件事：
     ① plainFits 判的是「放得下吗」，边界值卡准；
     ② 实现里**不许再有缩放**（scale / transform:scale 一条都不留）——
        变异回"缩小硬塞"时立刻红。 */
/* 剥掉注释再断言：注释里也会写 plainFitScale / transform:scale 这些字样（解释为什么不这么做），
   不剥的话把实现改回去时那些字样仍在窗口里，断言照样绿（实测变异存活）。 */
const codeNoComments = code
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const fitBoundsForPlain = api.plainBoundsOf({ right: 60 }, { right: 400 }, 1280);   /* 可用 67..400 = 333 */
assert.strictEqual(api.plainFits(333, fitBoundsForPlain, 1280), true, '刚好放满：算放得下');
assert.strictEqual(api.plainFits(100, fitBoundsForPlain, 1280), true, '明显放得下：算放得下');
assert.strictEqual(api.plainFits(334, fitBoundsForPlain, 1280), false,
	'多 1px 就放不下 → 返回 false（提示该关掉，不是缩小）');
assert.strictEqual(api.plainFits(600, fitBoundsForPlain, 1280), false,
	'长 MCP 工具名（自然宽 600 > 可用 333）→ 放不下');
/* 退化输入一律当"放得下"：量不出来就别关，宁可显示也不误伤 */
assert.strictEqual(api.plainFits(0, fitBoundsForPlain, 1280), true, '宽度为 0（还没量到）→ 当放得下');
assert.strictEqual(api.plainFits(NaN, fitBoundsForPlain, 1280), true, '宽度是 NaN → 当放得下');
assert.strictEqual(api.plainFits(999, null, 0), true, '没有 bounds 也没有视口信息 → 当放得下');
assert.strictEqual(api.plainFits(999, { min: 400, max: 300 }, 1280), true, '区间为负（无处可放）→ 当放得下，交给夹取兜底');
/* 结构层：缩放必须已被彻底移除 —— 不许再出现缩放比例，也不许写 transform: scale */
assert.strictEqual(api.plainFitScale, undefined, 'plainFitScale 已删除（放不下就关，不再算缩放比例）');
assert.strictEqual(/plainFitScale/.test(codeNoComments), false,
	'实现里不许再出现 plainFitScale —— 那是"缩小硬塞"的旧路径');
assert.strictEqual(/transform:\s*"scale\(/.test(codeNoComments), false,
	'悬停提示的样式里不许再写 transform: scale（不再缩放文字）');
assert.strictEqual(/hoverPos\.scale/.test(codeNoComments), false,
	'hoverPos 不再携带 scale 字段（缩放状态已移除）');
/* 判据必须走 plainFits：找到调用处，确认它决定的是"关掉"而不是"缩小" */
const fitsCallAt = codeNoComments.indexOf('plainFits(layoutWidth');
assert.ok(fitsCallAt !== -1, '定位 effect 里必须调用 plainFits 判断放不放得下');
const fitsCall = codeNoComments.slice(fitsCallAt, fitsCallAt + 400);
assert.ok(fitsCall.indexOf('setHoverPlainOff(true)') !== -1,
	'plainFits 返回 false 时必须关掉整组悬停提示（setHoverPlainOff(true)），实际片段：' + fitsCall.slice(0, 260));
console.log('悬停文字：放不下就整组不显示（plainFits 边界已钉住），缩放逻辑已彻底移除');
/* 复位，别影响后面的用例 */
stubHoverPlainWidth = 60;
stubBarWidth = 273;
stubHeadlineWidth = 60;

/* 悬停文字的水平夹取：左 = 标题右边界 + 1ch；右 = **色条本身**的右边界（不是气泡右边界） */
/* 注意：这些对象来自 vm 沙箱，原型与本进程不同，用跨 realm 安全的 JSON 比较 */
const bounds = api.plainBoundsOf({ right: 120 }, { right: 400 }, 1280);
assert.strictEqual(JSON.stringify(bounds), JSON.stringify({ min: 127, max: 400 }),
	'范围 = 标题右边界 + 1ch（7px） ~ 色条右边界');
const boundsViewport = api.plainBoundsOf({ right: 120 }, { right: 2000 }, 1280);
assert.strictEqual(JSON.stringify(boundsViewport), JSON.stringify({ min: 127, max: 1272 }), '色条右边界超过视口时按视口夹');
assert.strictEqual(JSON.stringify(api.plainBoundsOf(null, null, 1280)), JSON.stringify({ min: 8, max: 1272 }),
	'两个边界都拿不到时退回「只夹视口」的范围');
assert.strictEqual(api.clampPlainLeft(0, 60, bounds, 1280), 127, '离标题至少 1ch、不压标题');
assert.strictEqual(api.clampPlainLeft(500, 60, bounds, 1280), 340, '文字右边界不越过色条右边界（400-60）');
assert.strictEqual(api.clampPlainLeft(300, 60, null, 1280), 300, '没有范围时只夹视口');
/* 退化分支：**没有视口宽度**（`viewportWidth <= 0`）。
   上面三条都传了 1280，所以 `viewMax` 永远不是 null，两条退化分支一拍没走到：
   · `clampPlainLeft` 的 `if (max === null) return Math.max(min, centered)`（原值返回）
   · `plainBoundsOf` 的 `if (max < min) return null`（区间为负）
   实测这两个分支写错时测试仍全绿（审查 C 的 P1 / P2）。 */
assert.strictEqual(api.clampPlainLeft(500, 60, null, 0), 500,
	'没有视口、没有范围：left 原样返回居中值（不能贴死在左边界）');
assert.strictEqual(api.clampPlainLeft(3, 60, null, 0), 8,
	'没有视口时仍要守住左边距 8px，实际 ' + api.clampPlainLeft(3, 60, null, 0));
assert.strictEqual(api.plainBoundsOf(null, null, 0), null,
	'没有标题、没有色条、没有视口：返回 null（不要编一个假范围出来）');
assert.strictEqual(api.plainBoundsOf({ right: 400 }, { right: 300 }, 1280), null,
	'标题右边界已越过色条右边界（区间为负）：返回 null，交给夹取兜底');
console.log('悬停文字水平夹取：左=标题右边界+1ch / 右=色条右边界');

/* 悬停文字「放不下就整组不显示」的断言见本文件前面那段（搜 plainFits）：
   缩放功能已被移除，这里不再有"缩小到能放下"的用例。 */

/* ===================================== 总计：增量式记账（走真实渲染路径）======
   用户拍板的口径：**每条调用只算一次钱、算完固化，之后永不重算**；
   没价的模型记「欠账」，补上价只补算那部分。

   这一批**必须走真实渲染路径** —— 这是重点，别退回成"手工构造 hold 直接调纯函数"：
   每拍都调 `api.segmentView('cost', src)`，`src.totalHold` 复用**同一个对象**（模拟 useRef 跨渲染），
   断言取的是**渲染出来的文字**（用户看到的那个数）。

   为什么不能手工传参数：那会绕过 client.js 里「组装 calls → 逐条结算 → overflow / 队友 / 欠账」
   那段真实写入路径。实测代价（2026-10-18 审查 C）：旧实现里「切分基准漂移」写错后
   总计会永久冻结在旧值，而当时 24 个测试全绿 —— 就是因为测试全在纯函数层面打转。 */

/** 一拍：走真实渲染路径跑一次「总计」，返回渲染文字与其中金额。 */
const TICK_OFF = FIXED_NOW;                        /* 北京时间周三 20:00（空闲） */
const TICK_PEAK = Date.UTC(2026, 9, 15, 3, 0, 0);  /* 北京时间周四 11:00（高峰） */
/**
 * 干净的出厂人民币价格库（用例之间复位用）。
 *
 * 为什么不直接取 `api.snapshot().models`：那是**模块级 config**，前面「设置页改价」那一大段用例
 * 已经往里加过 GLM-5.3-Flash、纯数字键 "1"、把 deepseek-flash 改成 USD 等等 —— 拿它当基准会把
 * 别人的改动带进来。这里按 DEFAULT_PRICES 重建一份，只看官方 CNY 价。
 *
 * 必须用 Object.assign 逐个展开：DEFAULT_PRICES 来自 vm 沙箱 realm，
 * 跨 realm 的对象直接嵌进来会让深层比较失败（原型不同）。
 */
const tickTier = (tier) => ({
	input: tier.input, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite, output: tier.output
});
const tickOfficial = (name) => {
	const raw = api.DEFAULT_PRICES[name];
	return { tiered: true, currency: 'CNY', peak: tickTier(raw.peak), offPeak: tickTier(raw.offPeak) };
};
const TICK_BASE_MODELS = Object.assign({},
	{ 'deepseek-flash': tickOfficial('deepseek-flash') },
	{ 'deepseek-v4-pro': tickOfficial('deepseek-v4-pro') });
/** 空账本：形状与 StatusBar 里 useRef 初始化的那份一致。
 *  `debts` 是 **Map**（不是普通对象）：模型名是上游给的任意字符串，
 *  `__proto__` 这类键在普通对象上会变成设原型、静默丢失欠账。 */
const tickHold = () => ({
	sessionId: null, seen: new Map(), cost: 0, tokens: null,
	priced: false, subCostSettled: 0, debts: new Map()
});
/** 一条调用：output 250,000 token = 0.25M。空闲 4 元/M ⇒ ¥1.00；高峰 8 元/M ⇒ ¥2.00。 */
const tickCall = (at, model, units) => ({
	at: at, model: model, input: 0, cacheRead: 0, cacheWrite: 0, output: 250000 * units
});
const tickCost = (hold, opts) => {
	const o = opts === undefined ? {} : opts;
	/* 改价走真实路径：设置页改价就是 setConfig({ models })，priceOf 读的就是这份 */
	if (o.models !== undefined) api.setConfig({ models: o.models });
	const book = api.snapshot().models;
	const view = api.segmentView('cost', {
		sessionUsage: {
			models: book,
			calls: o.calls === undefined ? [] : o.calls,
			overflow: o.overflow,
			/* 压缩摘要的 token 累计（宿主新字段）：总计用量要把这部分加上 */
			summaryParts: o.summaryParts
		},
		sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
		usage: o.usage,
		subagent: o.subagent === undefined ? null : o.subagent,
		currency: 'CNY', defaultCurrency: 'CNY', models: book,
		now: o.now === undefined ? TICK_OFF : o.now,
		sessionId: o.sessionId === undefined ? 'tick-session-a' : o.sessionId,
		totalHold: hold
	}, t);
	const text = api.segmentText('cost', view, t, 'CNY');
	const hit = typeof text === 'string' ? /¥(-?[\d.]+)/.exec(text) : null;
	return { text: text, money: hit === null ? null : Number(hit[1]) };
};

/* ---- 场景 1：正常增长（每条只算一次；重渲染、乱序、同毫秒、滚动窗口都不重不漏）---- */
api.setConfig({ models: TICK_BASE_MODELS });
const growHold = tickHold();
const growCallA = tickCall(TICK_OFF, 'deepseek-flash', 1);
const growCallB = tickCall(TICK_OFF + 1000, 'deepseek-flash', 2);
const growCallC = tickCall(TICK_PEAK + 1000, 'deepseek-flash', 1);
let growTick = tickCost(growHold, { calls: [growCallA] });
assert.strictEqual(growTick.text, '总计 ¥1.00', '第 1 条空闲调用 = ¥1.00，实际 ' + growTick.text);
growTick = tickCost(growHold, { calls: [growCallA, growCallB] });
assert.strictEqual(growTick.text, '总计 ¥3.00', '新增 1 条 ¥2.00 → ¥3.00，实际 ' + growTick.text);
growTick = tickCost(growHold, { calls: [growCallA, growCallB, growCallC] });
assert.strictEqual(growTick.text, '总计 ¥5.00', '再新增 1 条高峰 ¥2.00 → ¥5.00，实际 ' + growTick.text);
/* 同一份数据再渲染：一条都不许重复计费（用户看到的总计不能自己往上跳） */
growTick = tickCost(growHold, { calls: [growCallA, growCallB, growCallC] });
assert.strictEqual(growTick.text, '总计 ¥5.00', '同数据重渲染不得重复计费，实际 ' + growTick.text);
/* calls **不保证按 at 升序**（真实日志里就有 [22:00, 10:00, 10:00]）：
   乱序到达的调用必须全部计入 —— 任何"只往后推时间游标"的写法都会漏掉后到的早调用。 */
const disorderHold = tickHold();
const disorderLate = tickCall(TICK_OFF, 'deepseek-flash', 1);              /* 空闲 ¥1.00 */
const disorderEarly = tickCall(TICK_OFF - 36000000, 'deepseek-flash', 1);  /* 10 小时前 = 周三 10:00 高峰 ¥2.00 */
let disorderTick = tickCost(disorderHold, { calls: [disorderLate, disorderEarly] });
assert.strictEqual(disorderTick.text, '总计 ¥3.00', '乱序到达的两条都要计入（¥1 + ¥2），实际 ' + disorderTick.text);
/* 同一毫秒的并行调用（指纹完全相同）：靠"出现次数"去重，只记"见过/没见过"会漏掉第二条 */
const sameMsHold = tickHold();
const sameMsCall = tickCall(TICK_OFF, 'deepseek-flash', 1);
let sameMsTick = tickCost(sameMsHold, { calls: [sameMsCall] });
assert.strictEqual(sameMsTick.text, '总计 ¥1.00', '同毫秒第 1 条 ¥1.00，实际 ' + sameMsTick.text);
sameMsTick = tickCost(sameMsHold, { calls: [sameMsCall, sameMsCall] });
assert.strictEqual(sameMsTick.text, '总计 ¥2.00', '同一毫秒再来一条同参数调用也要计入，实际 ' + sameMsTick.text);
/* calls 是滚动窗口：队首会被 host 的 MAX_CALLS 丢弃。用**下标**切分会整体错位、扣错钱。 */
const windowHold = tickHold();
const windowA = tickCall(TICK_OFF, 'deepseek-flash', 1);
const windowB = tickCall(TICK_OFF + 1000, 'deepseek-flash', 1);
const windowC = tickCall(TICK_OFF + 2000, 'deepseek-flash', 1);
let windowTick = tickCost(windowHold, { calls: [windowA, windowB] });
assert.strictEqual(windowTick.text, '总计 ¥2.00', '窗口内前两条 ¥2.00，实际 ' + windowTick.text);
windowTick = tickCost(windowHold, { calls: [windowB, windowC] });
assert.strictEqual(windowTick.text, '总计 ¥3.00', '队首被丢弃后只补算新增那条，实际 ' + windowTick.text);
console.log('总计记账：¥1→¥3→¥5 / 重渲染不重复 / 乱序、同毫秒、滚动窗口都不重不漏');

/* ---- 场景 2：改价（改价前已花的钱不动，改价后的新调用按新价）---- */
api.setConfig({ models: TICK_BASE_MODELS });
const priceHold = tickHold();
const priceCallA = tickCall(TICK_OFF, 'deepseek-flash', 1);
let priceTick = tickCost(priceHold, { calls: [priceCallA] });
assert.strictEqual(priceTick.text, '总计 ¥1.00', '改价前按旧价算 ¥1.00，实际 ' + priceTick.text);
/* 空闲输出价 4 → 1 元/M：同一条调用按新价只值 ¥0.25 */
const TICK_CHEAP = {
	'deepseek-flash': {
		tiered: true, currency: 'CNY',
		peak: { input: 0.5, cacheRead: 0.01, cacheWrite: 0, output: 2 },
		offPeak: { input: 0.25, cacheRead: 0.005, cacheWrite: 0, output: 1 }
	}
};
priceTick = tickCost(priceHold, { calls: [priceCallA], models: TICK_CHEAP });
assert.strictEqual(priceTick.text, '总计 ¥1.00', '改价前已经花掉的钱不许变（不能被新价重算成 ¥0.25），实际 ' + priceTick.text);
const priceCallB = tickCall(TICK_OFF + 1000, 'deepseek-flash', 1);
priceTick = tickCost(priceHold, { calls: [priceCallA, priceCallB], models: TICK_CHEAP });
assert.strictEqual(priceTick.text, '总计 ¥1.25', '改价后的新调用按新价 ¥0.25（1 + 0.25），实际 ' + priceTick.text);
console.log('总计记账：改价后历史 ¥1.00 不动 / 新调用按新价 ¥0.25');

/* ---- 场景 3：无价 → 补价（先记欠账给横杠，补价后补算，重渲染不重复补）---- */
/* 剥掉注释再断言（注释里也提到 debts: {} 这种反例写法） */
const codeNoCommentsForDebts = code
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:'\"\\\\])\/\/[^\n]*/g, '');
api.setConfig({ models: TICK_BASE_MODELS });
const debtHold = tickHold();
/* 账本里的欠账**必须是 Map**，不能是普通对象：模型名是上游给的任意字符串，
   `__proto__` 这类键在普通对象上会变成设原型、静默丢失，`Object.keys` 遍历不到，
   补价时永远结算不回来（总计永久少算）。`seen` 也是 Map —— 两者形状应当一致。
   这条断言是给"以后有人把它改回 {}"准备的护栏（改回去立刻红）。 */
assert.ok(debtHold.debts instanceof Map, '前置：账本的 debts 必须是 Map（不是普通对象）');
/* 生产代码里的那两处初始化也必须是 Map —— 测试自己的 tickHold 对，
   不代表 client.js 里那两份也对（变异只改生产代码时，上面那条断言抓不到）。
   必须断言**两处都是** Map 且**不存在** `debts: {}`：只断言"至少有一处是 Map"
   抓不到"只把其中一处改回去"的变异（实测存活过）。 */
assert.strictEqual((codeNoCommentsForDebts.match(/debts: new Map\(\)/g) || []).length, 2,
	'client.js 里两处 debts 初始化都必须是 new Map()（applyTotalFloor 新建账本 + totalHoldRef）');
assert.strictEqual((codeNoCommentsForDebts.match(/debts: \{\}/g) || []).length, 0,
	'client.js 里不许出现 debts: {}（普通对象会丢 __proto__ 这类键的欠账）');
const debtCallA = tickCall(TICK_OFF, 'my-model', 1);
const debtCallB = tickCall(TICK_OFF + 1000, 'my-model', 1);
let debtTick = tickCost(debtHold, { calls: [debtCallA, debtCallB] });
assert.strictEqual(debtTick.text, '总计 ¥-', '一条都算不出价时给横杠（不是 ¥0.00），实际 ' + debtTick.text);
assert.ok(debtHold.debts.has('my-model'),
	'无价模型必须记进欠账，实际 ' + JSON.stringify(Array.from(debtHold.debts.keys())));
/* 补价：my-model 空闲输出 4 元/M ⇒ 每条 ¥1.00，两条 ¥2.00 */
const TICK_WITH_MY = {
	'deepseek-flash': TICK_BASE_MODELS['deepseek-flash'],
	'my-model': {
		tiered: true, currency: 'CNY',
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
		offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
	}
};
debtTick = tickCost(debtHold, { calls: [debtCallA, debtCallB], models: TICK_WITH_MY });
assert.strictEqual(debtTick.text, '总计 ¥2.00', '补价后欠账要补算出来（2 条 × ¥1.00），实际 ' + debtTick.text);
assert.strictEqual(debtHold.debts.size, 0, '补算完欠账应清空');
/* 再渲染一拍：不能重复补算 */
debtTick = tickCost(debtHold, { calls: [debtCallA, debtCallB], models: TICK_WITH_MY });
assert.strictEqual(debtTick.text, '总计 ¥2.00', '欠账补算不得重复（重渲染仍是 ¥2.00），实际 ' + debtTick.text);
console.log('总计记账：无价给横杠并记欠账 / 补价后补算 ¥2.00 / 重渲染不重复补');

/* ---- 场景 3b：模型名撞 JS 原型属性（`__proto__` / `constructor`）----
   欠账账本若用普通对象，`debts['__proto__'] = slot` 是**设置原型**而不是加键，
   `Object.keys` 遍历不到 → 补价时永远结算不回来，总计永久少算。
   `constructor` / `toString` 更隐蔽：读到的是原型上的函数，代码把函数当字典用
   "碰巧能跑"，但那是巧合不是设计。账本必须是 Map（或空原型对象）。 */
api.setConfig({ models: TICK_BASE_MODELS });
[/* __proto__ 单独放在下面测（它过不了 setConfig 的 Object.assign 这一步，见说明） */'constructor', 'toString', 'hasOwnProperty'].forEach((weirdName) => {
	const weirdHold = tickHold();
	const weirdCall = tickCall(TICK_OFF, weirdName, 1);
	let weirdTick = tickCost(weirdHold, { calls: [weirdCall] });
	assert.strictEqual(weirdTick.text, '总计 ¥-',
		weirdName + '：无价时应给横杠，实际 ' + weirdTick.text);
	assert.ok(weirdHold.debts.has(weirdName),
		weirdName + '：欠账必须真的记进账本（普通对象上 __proto__ 会静默丢失），实际 '
		+ JSON.stringify(Array.from(weirdHold.debts.keys())));
	/* 补价：输出 4 元/M × 0.25M = ¥1.00 */
	const weirdModels = Object.assign({}, TICK_BASE_MODELS, {
		[weirdName]: {
			tiered: true, currency: 'CNY',
			peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
			offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
		}
	});
	weirdTick = tickCost(weirdHold, { calls: [weirdCall], models: weirdModels });
	assert.strictEqual(weirdTick.text, '总计 ¥1.00',
		weirdName + '：补价后必须补算出 ¥1.00（原型键上丢了欠账就会是横杠），实际 ' + weirdTick.text);
	assert.strictEqual(weirdHold.debts.size, 0, weirdName + '：补算完欠账应清空');
});
console.log('总计记账：模型名 __proto__ / constructor / toString / hasOwnProperty 都能正常记欠账并补算');

/* ---- 场景 4：队友（子智能体）只加增量、不重复加；换会话不残留 ---- */
api.setConfig({ models: TICK_BASE_MODELS });
const subHold = tickHold();
const subCallA = tickCall(TICK_OFF, 'deepseek-flash', 1);
const subTen = { ok: true, total: { cost: 10, tokens: { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 } } };
const subFifteen = { ok: true, total: { cost: 15, tokens: { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 } } };
let subTick = tickCost(subHold, { calls: [subCallA], subagent: { session: subTen, turn: null } });
assert.strictEqual(subTick.text, '总计 ¥11.00', '本会话 ¥1.00 + 队友 ¥10.00，实际 ' + subTick.text);
subTick = tickCost(subHold, { calls: [subCallA], subagent: { session: subTen, turn: null } });
assert.strictEqual(subTick.text, '总计 ¥11.00', '重渲染时队友金额不得重复加（用户实测的闪烁就是它），实际 ' + subTick.text);
subTick = tickCost(subHold, { calls: [subCallA], subagent: { session: subFifteen, turn: null } });
assert.strictEqual(subTick.text, '总计 ¥16.00', '队友涨到 ¥15.00 时只补 ¥5.00 增量，实际 ' + subTick.text);
/* 队友请求失败（整段拿不到）：显示不许回退 —— 用户实测 20 秒内 ¥2.66 → ¥92.37 就是这个 */
subTick = tickCost(subHold, { calls: [subCallA], subagent: null });
assert.strictEqual(subTick.text, '总计 ¥16.00', '队友请求失败时显示不得回退（防闪），实际 ' + subTick.text);
/* 换会话：上个会话的调用与队友金额都不得带过来（旧实现在这里会把上会话队友永久算进来） */
const switchCall = tickCall(TICK_OFF + 5000, 'deepseek-flash', 2);
const switchTick = tickCost(subHold, { calls: [switchCall], subagent: null, sessionId: 'tick-session-b' });
assert.strictEqual(switchTick.text, '总计 ¥2.00', '换会话后账本清空、只剩本会话 ¥2.00，实际 ' + switchTick.text);
console.log('总计记账：队友只加增量 ¥11→¥16 / 失败不回退 / 换会话无残留');

/* ---- 场景 5：overflow（被 host 截断的老调用）只在建账那一拍计入一次 ---- */
api.setConfig({ models: TICK_BASE_MODELS });
const overHold = tickHold();
const overCallA = tickCall(TICK_OFF, 'deepseek-flash', 1);
const overBucket = {
	'deepseek-flash': {
		peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 250000 }
	}
};
let overTick = tickCost(overHold, { calls: [overCallA], overflow: overBucket });
assert.strictEqual(overTick.text, '总计 ¥2.00', 'calls ¥1.00 + overflow ¥1.00，实际 ' + overTick.text);
overTick = tickCost(overHold, { calls: [overCallA], overflow: overBucket });
assert.strictEqual(overTick.text, '总计 ¥2.00', 'overflow 不得每拍重复计入，实际 ' + overTick.text);
console.log('总计记账：overflow 只在建账那拍计一次（¥2.00 不涨）');

/* ---- 场景 5b：总计**用量**要含压缩摘要（端到端，走真实 segmentView）----
   背景：「总计费用」是我们逐条算的、含摘要；「总计用量」原本只读官方 tokenUsage 投影，
   官方只折 assistant 事件、**不含摘要** → 同一个气泡里两个数字口径不一致。
   用户拍板：官方投影继续用，只把摘要这部分额外加上。
   这条用例必须走**真实的 segmentView('cost', ...)** 并读 tip.panel.totalText ——
   只测 summaryTokenParts / mergeTokenParts 这些纯函数抓不到「客户端忘了把摘要加进去」
   这个变异（实测纯函数用例下该变异存活）。 */
const sumUsage = { uncachedInputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 3000 };
const sumParts = { input: 100000, cacheRead: 50000, cacheWrite: 0, output: 40000 };
const sumView = (withSummary) => api.segmentView('cost', {
	sessionUsage: {
		models: api.snapshot().models, calls: [],
		summaryParts: withSummary === true ? sumParts : undefined
	},
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	usage: sumUsage, subagent: null,
	currency: 'CNY', defaultCurrency: 'CNY', models: api.snapshot().models,
	now: TICK_OFF, sessionId: 'tick-session-sum', totalHold: tickHold()
}, t);
const textOfPanel = (view) => (view === null || view.tip === undefined ? null : view.tip.panel.totalText);
/* 官方投影三段之和 = 1000 + 2000 + 3000 = 6,000 */
assert.strictEqual(textOfPanel(sumView(false)), '6,000', '没有摘要时总计用量 = 官方投影之和，实际 ' + textOfPanel(sumView(false)));
/* 摘要四段换成三段 = cached 50000 + missInput 100000 + output 40000 = 190,000 */
assert.strictEqual(textOfPanel(sumView(true)), '196,000',
	'有摘要时总计用量 = 官方投影 6,000 + 摘要 190,000 = 196,000，实际 ' + textOfPanel(sumView(true)));
console.log('总计用量含摘要：6,000 → 196,000（多出的正好是摘要那 190,000）');

/* ---- 场景 6：已结算指纹集合有上限（长会话内存不能无限增长）---- */
const manyCalls = [];
for (let i = 0; i < 9000; i += 1) manyCalls.push(tickCall(TICK_OFF + i * 1000, 'deepseek-flash', 1));
const manyHold = tickHold();
const manyTick = tickCost(manyHold, { calls: manyCalls });
assert.ok(manyHold.seen.size <= 8000, '已结算指纹集合必须有上限（SEEN_LIMIT=8000），实际 ' + manyHold.seen.size);
assert.strictEqual(manyTick.money, 9000, '9000 条 × ¥1.00 = ¥9000，金额不受上限影响，实际 ' + manyTick.money);
console.log('总计记账：9000 条调用后指纹集合仍 ≤ 8000，金额正确 ¥9000.00');

/* ---- 场景 7：指纹上限的**跨拍**行为（上限真正的作用在下一拍）----
   关键前提：**单拍喂入的调用数不可能超过 MAX_CALLS(4000)** —— host 的 calls 就是那个上限。
   而 SEEN_LIMIT=8000 正好是它的两倍，所以「这一拍还在窗口里的调用」的指纹永远不会被淘汰，
   跨拍重算时必然全部命中、不会重复计费。下面用**真实规模**（4000 条 = MAX_CALLS）验证。

   若把 SEEN_LIMIT 调到小于单拍调用数，淘汰就会误伤仍在窗口里的指纹 → 第二拍重复计费。
   这正是 M05 要盯的边界：这条用例同时是 SEEN_LIMIT 的**下界证明**（必须 ≥ MAX_CALLS）。 */
const manyHold2 = tickHold();
const realMax = manyCalls.slice(0, 4000);        /* MAX_CALLS 规模 */
const manyCallsB = realMax.map((one) => Object.assign({}, one));
let manyTick2 = tickCost(manyHold2, { calls: manyCallsB });
assert.strictEqual(manyTick2.money, 4000, '第一拍 4000 条（= MAX_CALLS）= ¥4000，实际 ' + manyTick2.money);
manyTick2 = tickCost(manyHold2, { calls: manyCallsB });
assert.strictEqual(manyTick2.money, 4000,
	'第二拍喂同一批 4000 条时不得重复计费，实际 ' + manyTick2.money);
assert.strictEqual(manyTick2.text, '总计 ¥4000.00', '第二拍金额文本不变，实际 ' + manyTick2.text);
assert.ok(manyHold2.seen.size <= 8000, '指纹集合仍在上限内，实际 ' + manyHold2.seen.size);
console.log('总计记账：指纹上限跨拍不重复计费（4000 条 = MAX_CALLS，第二拍仍 ¥4000.00）');

/* 用例改了模块级价格库，还回去（后面的设置页用例仍按出厂价跑） */
api.setConfig({ models: TICK_BASE_MODELS });

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














