/**
 * 点击气泡的开关行为（与底栏组件一起跑真实渲染路径）：
 *   - 点带气泡的段 → 展开，再点一次收起
 *   - 点另一段 → 前一个收起，新的展开
 *   - 圆环与峰谷文字各管一个气泡，互不干扰
 *   - 点底栏以外的地方 → 全部收起
 * 用法：node verify-hover.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__test = { StatusBar };\n\t\texports.apply = apply;');

/* ResizeObserver 替身：只记录观察对象，用例手动触发「气泡尺寸变了」 */
const observers = [];
class FakeResizeObserver {
	constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
	observe(target) { this.targets.push(target); }
	disconnect() { this.targets.length = 0; }
}
	/* Portal 替身：记录 reactDom.createPortal 的调用（节点原样返回，树遍历/ref 逻辑不变） */
	const portalCalls = [];
const clicks = [];
const resizes = [];
const scrolls = [];
const fetched = [];
const hoverLayout = { enabled: false, titleRight: 80, barRight: 150 };
/* 活跃总览的假 daily：至少一天有用量，才能触发柱/方块的 onMouseEnter（悬停浮层 Portal 用例） */
const dailyFixture = {
	ok: true,
	totals: { total: 100, calls: 2, cost: 0.5 },
	days: [
		{ date: '2026-11-02', total: 100, input: 40, cacheRead: 50, cacheWrite: 0, output: 10, calls: 2, cost: 0.5 },
		{ date: '2026-11-03', total: 40, input: 20, cacheRead: 15, cacheWrite: 0, output: 5, calls: 1, cost: 0.2 },
		{ date: '2026-11-04', total: 20, input: 10, cacheRead: 8, cacheWrite: 0, output: 2, calls: 1, cost: 0.1 },
		{ date: '2026-11-05', total: 10, input: 5, cacheRead: 4, cacheWrite: 0, output: 1, calls: 1, cost: 0.05 },
		{ date: '2026-11-06', total: 5, input: 2, cacheRead: 2, cacheWrite: 0, output: 1, calls: 1, cost: 0.03 },
		{ date: '2026-11-07', total: 2, input: 1, cacheRead: 1, cacheWrite: 0, output: 0, calls: 1, cost: 0.01 },
		{ date: '2026-11-08', total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, cost: 0 }
	],
	month: null,
	year: null
};
const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0, clearInterval: () => {},
	setTimeout: () => 0, clearTimeout: () => {},
	innerWidth: 1200, innerHeight: 800,
	addEventListener: (name, fn) => {
		if (name === 'click') clicks.push(fn);
		if (name === 'resize') resizes.push(fn);
		if (name === 'scroll') scrolls.push(fn);
	},
	removeEventListener: () => {},
	fetch: (url) => {
		fetched.push(String(url));
		return Promise.resolve({
			json: () => Promise.resolve(String(url).indexOf('/balance') !== -1
				? { ok: true, total: '12.34', toppedUp: '10.00', granted: '2.34', currency: 'CNY' }
				: (String(url).indexOf('/daily-usage') !== -1 ? dailyFixture : { ok: false }))
		});
	}
};
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {} }),
		head: { appendChild() {} },
		documentElement: { classList: { add() {}, remove() {} } },
		body: {},
		addEventListener: (name, fn) => { if (name === 'click') clicks.push(fn); },
		removeEventListener: () => {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	/* 浏览器里 setTimeout 是全局函数（client.js 收起悬停用的是裸 setTimeout） */
	setTimeout: () => 0, clearTimeout: () => {}
};
sandbox.ResizeObserver = FakeResizeObserver;
sandbox.globalThis = sandbox;

/* React 替身：hooks 按组件分桶；ref 会拿到一个能判"是不是底栏内部"的假节点 */
let activeHooks = null;
	function makeHooks() { return { values: [], index: 0, pending: [] }; }
	function withHooks(bucket, fn) {
		const prev = activeHooks;
		activeHooks = bucket;
		bucket.index = 0;
		bucket.pending = [];
		let out;
		try { out = fn(); } finally { activeHooks = prev; }
		/* 真实 React 顺序：渲染 → 挂 DOM（ref 赋值）→ effect。同步跑会让量节点的 effect 拿到 null ref。 */
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
const reactStub = {
	createElement(type, props, ...children) {
		const hasClass = (name) => typeof props.className === 'string' && props.className.split(' ').indexOf(name) !== -1;
		const node = {
			type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
			__inside: true,
			/* 替身节点也当 DOM 用：contains 给"点别处收起"判内外，getBoundingClientRect 给气泡量宽度 */
			contains: (target) => target !== null && target !== undefined && target.__inside === true,
			querySelector(selector) {
				if (hoverLayout.enabled !== true) return null;
				if (typeof selector !== 'string' || selector[0] !== '.') return null;
				const wanted = selector.slice(1);
				let found = null;
				walk(node.children, (child) => {
					if (found === null && child.props !== undefined && typeof child.props.className === 'string'
						&& child.props.className.split(' ').indexOf(wanted) !== -1) found = child;
				});
				return found;
			},
			get offsetWidth() {
				return hoverLayout.enabled === true && hasClass('dsb-hover-plain') ? textOf(node.children).length * 5.5 : 0;
			},
			getBoundingClientRect() {
				if (hoverLayout.enabled !== true) return { width: 240, height: 40, left: 0, top: 0, right: 240, bottom: 40 };
				const right = Math.min(hoverLayout.barRight, fakeWindow.innerWidth - 8);
				if (hasClass('dsb-meter-headline')) return { width: hoverLayout.titleRight - 30, height: 12, left: 30, top: 100, right: hoverLayout.titleRight, bottom: 112 };
				if (hasClass('dsb-meter-head')) return { width: right - 20, height: 16, left: 20, top: 98, right, bottom: 114 };
				if (hasClass('dsb-bar')) return { width: right - hoverLayout.titleRight, height: 2, left: hoverLayout.titleRight, top: 118, right, bottom: 120 };
				if (hasClass('dsb-hover-plain')) {
					const width = node.offsetWidth;
					return { width, height: 11, left: 100, top: 100, right: 100 + width, bottom: 111 };
				}
				if (hasClass('dsb-tip')) return { width: right - 20, height: 80, left: 20, top: 120, right, bottom: 200 };
				return { width: 240, height: 40, left: 0, top: 0, right: 240, bottom: 40 };
			},
			__inside: true
		};
		const ref = node.props.ref;
		if (ref !== null && ref !== undefined && typeof ref === 'object') ref.current = node;
		return node;
	},
	useState: (init) => {
		const slot = hookSlot(init);
		return [slot.get(), slot.set];
	},
	useEffect: (fn, deps) => {
		if (activeHooks === null) return;
		const bucket = activeHooks;
		const at = bucket.index;
		bucket.index += 1;
		const previous = bucket.values[at];
		const next = deps === undefined ? undefined : Array.prototype.slice.call(deps);
		/* 依赖变化才重跑（替身不做 cleanup：测试里没有需要回收的订阅） */
		if (previous !== undefined && deps !== undefined) {
			const same = previous.deps !== undefined && previous.deps.length === next.length
				&& next.every((one, index) => one === previous.deps[index]);
			if (same === true) return;
		}
		bucket.values[at] = { deps: next };
		bucket.pending.push(fn);
	},
	useLayoutEffect: (fn, deps) => reactStub.useEffect(fn, deps),
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
const api = captured.factory((n) => {
	if (n === 'react') return reactStub;
	if (n === 'react-dom') {
		return {
			createPortal: (node, container) => {
				portalCalls.push({ node, container });
				return node;
			}
		};
	}
	throw new Error('unexpected require: ' + n);
	return reactStub;
}).__test;

const TEMPLATES = {
	f_ttft: '首字平均 {duration}', f_speed: '综合速度 {throughput}t/s', f_sessionTime: '总用时 {duration}',
	f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}', f_balance: '余额 {symbol}{amount}',
	f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出',
	f_tokensTotal: '总计用量', f_tokensTurn: '本轮用量', f_peak: '高峰', f_valley: '低谷',
	f_cacheHit: '综合命中 {percent}%', f_counts: '{turns} 轮 {steps} 步',
	tipCountsTitle: '会话数据', tipCountsSkills: '技能注入', tipCountsToolCalls: '工具调用', tipCountsCompactAt: '上下文压缩',
	tipModelTime: '模型用时', tipToolTime: '工具调用', tipTtftFast: '最快首字延迟', tipTtftSlow: '最慢首字延迟',
	tipTpsFast: '最快输出速度', tipTpsSlow: '最慢输出速度', tipTopUp: '充值余额', tipGranted: '赠金余额',
	tipPeriodTitle: '峰谷规则', tipPeakRule: '周一至周五 9:00-12:00、14:00-18:00',
	tipValleyRule: '其余时段，单价为高峰的一半', tipHoliday: '节假日', tipHolidayRule: '法定节假日与周末全天按空闲价',
	tipHitHigh: '最高命中率', tipHitLow: '最低命中率', segCacheHit: '缓存命中率',
	contextAria: '上下文已用 {percent}', contextSystem: '系统提示词', contextTools: '工具定义', contextMessages: '对话消息',
	segTtft: '首字延迟', segTps: '输出速度', segSessionTime: '运行用时', segBalance: '余额', unitSpeed: 't/s'
};
const t = (key, params) => {
	let out = TEMPLATES[key] !== undefined ? TEMPLATES[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

const now = Date.now();
const projections = {
	sessionStats: { turns: 2, steps: 10, llmMs: 125000, toolMs: 45000, ttftMs: 2000, ttftSteps: 2, decodeMs: 1000, decodeTokens: 500 },
	tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 3000 },
	contextPressure: { pressureTokens: 400000, contextWindow: 1000000 },
	contextBreakdown: { systemTokens: 1900, toolsTokens: 7300, messageTokens: 181000 },
	desktopStatusbarModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	desktopStatusbarUsage: {
		models: {}, current: null, last: null, turn: 1,
		calls: [{ at: now, model: 'deepseek-flash', input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000 }]
	},
	desktopStatusbarActiveTime: { turns: 60000, since: null, steps: 0, stepSince: null },
	desktopStatusbarTiming: {
		samples: 3,
		fastestTtft: { value: 1200, at: now, model: 'deepseek-flash' },
		slowestTtft: { value: 12500, at: now, model: 'deepseek-flash' },
		fastestTps: { value: 120, at: now, model: 'deepseek-flash' },
		slowestTps: { value: 31, at: now, model: 'deepseek-flash' }
	},
	desktopStatusbarProgress: {
		toolCalls: 3,
		toolCounts: { go: 1, 'cordis-plugin-longname': 2 },
		compactCount: 1,
		compacts: [{ turn: 1, step: 2, afterTurn: null, manual: false }]
	}
};
const props = {
	t,
	useProjection: (name) => projections[name],
	useSession: () => undefined,
	useSessions: () => undefined,
	useChat: (selector) => selector({
		legacy: { nodes: [{ kind: 'assistant', turn: 1, usage: { inputTokens: 100, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 3000 } }] }
	}),
	sessionId: 'verify-session'
};
const hooks = makeHooks();
const render = () => withHooks(hooks, () => api.StatusBar(props));

function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== 'object') return;
	if (Array.isArray(node)) { node.forEach((one) => walk(one, visit)); return; }
	visit(node);
	walk(node.children, visit);
}
function byKey(tree, key) {
	let found = null;
	walk(tree, (node) => {
		if (found === null && node.props !== undefined && node.props.key === key) found = node;
	});
	return found;
}
function byClass(tree, className) {
	const out = [];
	walk(tree, (node) => {
		const cls = node.props === undefined ? undefined : node.props.className;
		if (typeof cls === 'string' && cls.split(' ').indexOf(className) !== -1) out.push(node);
	});
	return out;
}
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return textOf(node.children);
}
/** 段节点展开时 children 里会多出一个气泡（收起时只剩那层文字 span） */
const isOpen = (tree, key) => byKey(tree, key).children.length > 1;
const panelOf = (tree, key) => byClass(byKey(tree, key), 'dsb-tip')[0];
const clickEvent = (left, width) => {
	const at = left === undefined ? 200 : left;
	const wide = width === undefined ? 80 : width;
	return {
		currentTarget: { getBoundingClientRect: () => ({ left: at, top: 700, width: wide, height: 20, right: at + wide }) },
		stopPropagation() {}
	};
};
/** 气泡的 fixed 内联位置（替身节点的 getBoundingClientRect 固定宽 240） */
const panelStyleOf = (tree, key) => {
	const panel = panelOf(tree, key);
	return panel === undefined ? null : panel.props.style;
};

async function main() {
render();   /* 先挂一次：余额请求在 effect 里发出去，等它落地再开始断言 */
await new Promise((resolve) => setImmediate(resolve));
let tree = render();
assert.strictEqual(byClass(tree, 'dsb-seg-click').length, 9, '可点段 9 个（峰谷 + 轮次 + 缓存命中 + 首字 + 速度 + 总用时 + 总计 + 本轮 + 余额；圆环另算）');
			/* 本轮必须任何情况下都能点开：没有明细时气泡里给三行横杠 */
			assert.strictEqual(byKey(tree, '__seglastCost') !== null && typeof byKey(tree, '__seglastCost').props.onClick === 'function', true, '没有 host 本轮明细时，本轮也要有气泡可点');
assert.strictEqual(typeof byKey(tree, '__segstatus').props.onClick, 'function', '峰谷可点开活跃总览');
assert.strictEqual(isOpen(tree, '__segcost'), false, '初始都收着');

/* 1. 点总计 → 展开令牌面板，再点一次收起 */
byKey(tree, '__segcost').props.onClick(clickEvent());
tree = render();
assert.strictEqual(isOpen(tree, '__segcost'), true, '点总计展开气泡');
assert.strictEqual(byKey(tree, '__segcost').props['aria-expanded'], 'true', '展开时 aria-expanded=true');
assert.ok(textOf(panelOf(tree, '__segcost')).indexOf(TEMPLATES.f_tokensTotal) !== -1, '气泡里是会话总量面板');
byKey(tree, '__segcost').props.onClick(clickEvent());
tree = render();
assert.strictEqual(isOpen(tree, '__segcost'), false, '再点一次收起');
console.log('总计：点开 / 再点收起');

/* 2. 点另一段 → 切换（不残留两个气泡） */
byKey(tree, '__segcost').props.onClick(clickEvent());
tree = render();
byKey(tree, '__segttft').props.onClick(clickEvent());
tree = render();
assert.strictEqual(isOpen(tree, '__segcost'), false, '切到首字后总计收起');
assert.strictEqual(isOpen(tree, '__segttft'), true, '首字气泡展开');
assert.ok(textOf(panelOf(tree, '__segttft')).indexOf(TEMPLATES.tipTtftFast) !== -1, '首字气泡含最快首字');
console.log('切换：一次只开一个');

/* 3. 圆环管上下文占用面板 */
assert.ok(byClass(tree, 'dsb-ring-btn')[0] !== undefined, '有上下文占用时状态位是圆环按钮');
byKey(tree, '__segttft').props.onClick(clickEvent());   /* 先收掉前面那个 */
tree = render();
byClass(tree, 'dsb-ring-btn')[0].props.onClick(clickEvent());
tree = render();
assert.strictEqual(byClass(tree, 'dsb-ring-btn')[0].children.length, 2, '点圆环展开上下文面板');
assert.strictEqual(isOpen(tree, '__segstatus'), false, '峰谷那两个字不出气泡');
byClass(tree, 'dsb-ring-btn')[0].props.onClick(clickEvent());
tree = render();
assert.strictEqual(byClass(tree, 'dsb-ring-btn')[0].children.length, 1, '再点圆环收起');
console.log('圆环：上下文占用气泡，峰谷文字不参与');

/* 4. 缓存命中也能点开（最高/最低命中率） */
byKey(tree, '__segcacheHit').props.onClick(clickEvent());
tree = render();
assert.strictEqual(isOpen(tree, '__segcacheHit'), true, '缓存命中气泡展开');
assert.ok(textOf(panelOf(tree, '__segcacheHit')).indexOf(TEMPLATES.tipHitHigh) !== -1, '气泡含最高命中率');
console.log('缓存命中：点开有气泡');

/* 5. 点底栏以外的地方 → 收起 */
assert.ok(clicks.length > 0, '底栏注册了"点别处收起"');
clicks[clicks.length - 1]({ target: { __inside: false } });
tree = render();
assert.strictEqual(isOpen(tree, '__segcacheHit'), false, '点别处收起缓存命中气泡');
const reopened = render();
byKey(reopened, '__segbalance').props.onClick(clickEvent());
tree = render();
assert.strictEqual(isOpen(tree, '__segbalance'), true, '余额气泡也能开');
clicks[clicks.length - 1]({ target: byKey(tree, '__segbalance') });
tree = render();
assert.strictEqual(isOpen(tree, '__segbalance'), true, '点在底栏内部不收起');
clicks[clicks.length - 1]({ target: { __inside: false } });
tree = render();
assert.strictEqual(isOpen(tree, '__segbalance'), false, '点外部收起');
console.log('点别处：外部收起、内部不收起');

/* 6. 对齐与宽度：浮层贴着触发项左边缘、宽度与它一致（宽度由替身固定成 240） */
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));    /* 中间项：中心 350 */
tree = render();
tree = render();
assert.strictEqual(panelStyleOf(tree, '__segttft').left, '300.5px', '可见左边缘跟触发项对齐（border-box 300.5 含 0.5 描边）：实际 ' + panelStyleOf(tree, '__segttft').left);
assert.strictEqual(panelStyleOf(tree, '__segttft').bottom, '106px', '底边贴在触发项上方 6px（800 − 700 + 6）');
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));
tree = render();
byKey(tree, '__segbalance').props.onClick(clickEvent(300, 100));  /* 最右项 */
tree = render();
tree = render();
assert.strictEqual(panelStyleOf(tree, '__segbalance').left, '300.5px', '最右项也跟触发项左边缘对齐：实际 ' + panelStyleOf(tree, '__segbalance').left);
byKey(tree, '__segbalance').props.onClick(clickEvent(300, 100));
tree = render();
byClass(tree, 'dsb-ring-btn')[0].props.onClick(clickEvent(300, 100));   /* 最左项（圆环） */
tree = render();
tree = render();
const ringPanel = byClass(tree, 'dsb-tip')[0];
assert.ok(ringPanel !== undefined, '圆环的气泡挂在按钮里');
assert.strictEqual(ringPanel.props.style.left, '300.5px', '最左项贴左：可见边用触发项左边缘，实际 ' + ringPanel.props.style.left);
console.log('对齐：气泡左边界与宽度都跟触发项一致');

/* 7. 贴边：气泡与触发项同宽同左边界，触发项贴边时气泡跟着贴边（不再单独夹取） */
byClass(tree, 'dsb-ring-btn')[0].props.onClick(clickEvent(300, 100));
tree = render();
byKey(tree, '__segttft').props.onClick(clickEvent(1150, 100));   /* 中心 1200 → 居中会溢出 */
tree = render();
tree = render();
assert.strictEqual(panelStyleOf(tree, '__segttft').left, '1150.5px', '左边界跟触发项一致（可见边 1150）：实际 ' + panelStyleOf(tree, '__segttft').left);
console.log('贴边：左边界跟触发项一致');

/* 8. 带气泡的段都可点：九个段全有气泡，轮次/步数也不例外 */
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));
tree = render();
assert.strictEqual(typeof byKey(tree, '__segcounts').props.onClick, 'function', '轮次/步数可点开气泡');
byKey(tree, '__segcounts').props.onClick(clickEvent(300, 100));
tree = render();
assert.strictEqual(isOpen(tree, '__segcounts'), true, '点轮次 → 气泡打开');
assert.strictEqual(isOpen(tree, '__segttft'), false, '同时只开一个');
console.log('轮次可点：打开它自己的气泡');

/* 9. 回归：会话进行中不能莫名其妙收起气泡
      —— 工具调用、新一轮开始时对话区会自动滚动，旧版跟着 scroll 收起，气泡就没了 */
assert.strictEqual(scrolls.length, 0, '不再监听 scroll（对话区自动滚动不该关气泡）');
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));
tree = render();
tree = render();
assert.strictEqual(isOpen(tree, '__segttft'), true, '气泡开着');
/* 投影更新（新的一次调用/新的步骤）只会重渲染，不该丢掉展开状态 */
projections.sessionStats = Object.assign({}, projections.sessionStats, { steps: projections.sessionStats.steps + 1 });
tree = render();
assert.strictEqual(isOpen(tree, '__segttft'), true, '投影更新后仍开着');
/* 窗口缩放：位置重算，气泡留着 */
assert.ok(resizes.length > 0, '注册了 resize 处理');
resizes[resizes.length - 1]();
tree = render();
tree = render();
assert.strictEqual(isOpen(tree, '__segttft'), true, 'resize 后仍开着');
assert.strictEqual(panelStyleOf(tree, '__segttft').left, '300.5px', 'resize 后重新落位，实际 ' + panelStyleOf(tree, '__segttft').left);
console.log('会话更新 / 滚动 / 缩放：气泡都不会被收掉');

/* 10. 点余额 → 立刻强制重查一次余额（不等最多 60 秒的下一轮轮询）；收起那一下不重查 */
const balanceCalls = () => fetched.filter((url) => url.indexOf('/balance') !== -1);
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));   /* 先收掉上一个气泡 */
tree = render();
const beforeBalance = balanceCalls().length;
byKey(tree, '__segbalance').props.onClick(clickEvent(300, 100));
tree = render();
assert.strictEqual(isOpen(tree, '__segbalance'), true, '余额气泡展开');
assert.strictEqual(balanceCalls().length, beforeBalance + 1, '点开余额立刻多发一次余额请求');
assert.ok(balanceCalls()[balanceCalls().length - 1].indexOf('force=1') !== -1,
	'这次请求带 force=1，实际 ' + balanceCalls()[balanceCalls().length - 1]);
const afterOpen = balanceCalls().length;
byKey(tree, '__segbalance').props.onClick(clickEvent(300, 100));   /* 再点一次 = 收起 */
tree = render();
assert.strictEqual(isOpen(tree, '__segbalance'), false, '再点余额收起气泡');
assert.strictEqual(balanceCalls().length, afterOpen, '收起那一下不重复请求');
byKey(tree, '__segttft').props.onClick(clickEvent(300, 100));   /* 点别的段 */
tree = render();
assert.strictEqual(balanceCalls().length, afterOpen, '点其他段不牵动余额查询');
console.log('点余额：立刻重查一次（force=1），收起与点其他段都不重查');

	/* 11. 工具子视图：悬停纯文字画在**气泡内部**（水平跟鼠标并夹进气泡边界，垂直夹在气泡内）；
	   可用宽度 = 气泡内部宽度（panel 宽 - 16），放不下才整组不显示 */
	const settleHover = () => {
		let next = null;
		for (let pass = 0; pass < 4; pass += 1) next = render();
		return next;
	};
	/* 需求 10：活跃总览的悬停浮层与 hoverPlain 一样必须 Portal 到 body ——
	   否则 fixed 会被宿主 composer 的包含块捕获，气泡消失 / 闪跳（用户实测根因）。 */
	byKey(tree, '__segstatus').props.onClick(clickEvent());
	tree = settleHover();
	const dayWithData = byClass(tree, 'dsb-day').filter((node) => typeof node.props.onMouseEnter === 'function')[0];
	assert.ok(dayWithData !== undefined, '活跃总览应有可悬停的每日柱');
	const portalsBeforeCard = portalCalls.length;
	dayWithData.props.onMouseEnter({ clientX: 300, clientY: 500 });
	tree = settleHover();
	const cardPortals = portalCalls.slice(portalsBeforeCard)
		.filter((one) => String(one.node.props.className).indexOf('dsb-hovercard') !== -1);
	assert.ok(cardPortals.length > 0, '悬停浮层必须走 reactDom.createPortal（不能就地在 .dsb-root 里渲染）');
	const lastCardPortal = cardPortals[cardPortals.length - 1];
	assert.strictEqual(lastCardPortal.container, sandbox.document.body, '悬停浮层 Portal 目标必须是 document.body');
	assert.ok(String(lastCardPortal.node.props.className).indexOf('dsb-tip') !== -1, 'Portal 的节点是 dsb-tip 悬停浮层');
	dayWithData.props.onMouseLeave();
	tree = settleHover();
	console.log('活跃总览悬停：浮层 Portal 到 document.body（避开 composer 包含块）');
	const findToolCallsRow = (sourceTree) => byClass(sourceTree, 'dsb-meter-row-click').find((row) =>
		textOf(row).indexOf(TEMPLATES.tipCountsToolCalls) !== -1);
	const assertToolHoverHandlers = (sourceTree, expected, label) => {
		const segments = byClass(sourceTree, 'dsb-bar-seg');
		assert.strictEqual(segments.length, 2, label + ': 工具调用色条应含短名与长名两段');
		if (expected === true) {
			assert.ok(segments.every((one) => typeof one.props.onMouseEnter === 'function'),
				label + ': 可用时每段都应挂 onMouseEnter');
		} else {
			assert.ok(segments.every((one) => one.props.onMouseEnter === undefined),
				label + ': 气泡内放不下时所有段都必须没有 onMouseEnter');
		}
		return segments;
	};
	const visibleHoverPlain = (sourceTree) => byClass(sourceTree, 'dsb-hover-plain').filter((node) =>
		String(node.props.className).split(' ').indexOf('dsb-hover-plain-probe') === -1);
	const resizeCountBeforeCounts = resizes.length;
	byKey(tree, '__segcounts').props.onClick(clickEvent());
	tree = settleHover();
	assert.strictEqual(isOpen(tree, '__segcounts'), true, '打开会话数据根视图');
	assert.ok(resizes.length > resizeCountBeforeCounts, '打开气泡时注册 window resize listener');
	const resizeListener = resizes[resizes.length - 1];
	assert.strictEqual(typeof resizeListener, 'function', '捕获已注册的 resize 回调');
	const toolCallsRow = findToolCallsRow(tree);
	assert.ok(toolCallsRow !== undefined && typeof toolCallsRow.props.onClick === 'function', '根视图有可进入的工具调用子视图');
	toolCallsRow.props.onClick({ stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(byClass(tree, 'dsb-meter-headline')[0]), TEMPLATES.tipCountsToolCalls, '当前进入真实工具调用子视图');
	let probeTexts = byClass(tree, 'dsb-hover-plain-probe').map(textOf);
	assert.ok(probeTexts.some((one) => one === 'go 33.33%'), '工具子视图含短名 go');
	assert.ok(probeTexts.some((one) => one === 'cordis-plugin-longname 66.67%'), '工具子视图含长名 cordis-plugin-longname');
	hoverLayout.enabled = true;
	/* 替身几何：panel = {left:20, right:min(barRight, innerWidth-8), top:120, bottom:200}；标题行 bottom=114 */
	const panelBoxNow = () => ({ left: 20, right: Math.min(hoverLayout.barRight, fakeWindow.innerWidth - 8), top: 120, bottom: 200 });
	const plainNumber = (value) => Number(String(value).replace('px', ''));
	const assertAlignedWithTitle = (label) => {
		const one = visibleHoverPlain(tree)[0];
		assert.ok(one !== undefined, label + ': 应当渲染出悬停提示');
		const style = one.props.style;
		assert.ok(style !== undefined, label + ': 提示必须有定位样式');
		const plainNumber = (value) => Number(String(value).replace('px', ''));
		const left = plainNumber(style.left);
		const top = plainNumber(style.top);
		const width = one.offsetWidth;
		const box = panelBoxNow();
		/* 垂直：与「工具调用」标题行上下居中（替身标题行 top=98 height=16 → 中心 106；文字高 11 → top=100.5） */
		const titleCenter = 98 + 16 / 2;
		assert.ok(Math.abs((top + 11 / 2) - titleCenter) <= 1, label + ': top 必须与标题行垂直中心对齐（top=' + top + ', 标题中心=' + titleCenter + '）');
		/* 水平：≥ 标题右边界 + 12（不压标题），右边界 ≤ 气泡右边界 - 8 */
		assert.ok(left >= hoverLayout.titleRight + 12 - 0.01, label + ': left 必须 ≥ 标题右边界+间距（left=' + left + '）');
		assert.ok(left + width <= box.right - 8 + 0.01, label + ': right 必须 ≤ 气泡右边界-8（right=' + (left + width) + '）');
	};
	const resizeBubble = (barRight) => {
		hoverLayout.barRight = barRight;
		resizeListener();
		return settleHover();
	};
	/* 气泡够宽：两个名字都放得下（内部可用宽度 = 480 - 16 = 464 > 159.5） */
	tree = resizeBubble(500);
	let toolSegments = assertToolHoverHandlers(tree, true, '气泡够宽');
	toolSegments[0].props.onMouseEnter({ clientX: 220, clientY: 500, stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'go 33.33%', '短名悬停提示出现');

	/* task-37：悬停文字必须 Portal 到 body —— 否则被 z-index:105 的气泡盖住（用户实测「什么都不显示」） */
	assert.ok(portalCalls.length > 0, '悬停文字必须走 reactDom.createPortal（不能就地在 .dsb-root 里渲染）');
	const lastPortal = portalCalls[portalCalls.length - 1];
	assert.strictEqual(lastPortal.container, sandbox.document.body, 'Portal 目标必须是 document.body');
	assert.ok(String(lastPortal.node.props.className).indexOf('dsb-hover-plain') !== -1, 'Portal 的节点就是悬停文字');
	assertAlignedWithTitle('短名');
	/* 同段内移动：只改 DOM 坐标、内容不重建、不闪断 */
	toolSegments[0].props.onMouseMove({ clientX: 260, clientY: 505, stopPropagation() {} });
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'go 33.33%', '段内移动后内容不变');
	assertAlignedWithTitle('段内移动后');
	/* 长名字也能显示（只要气泡内部放得下） */
	toolSegments = byClass(tree, 'dsb-bar-seg');
	toolSegments[1].props.onMouseEnter({ clientX: 420, clientY: 500, stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'cordis-plugin-longname 66.67%', '长名悬停提示也能显示');
	assertAlignedWithTitle('长名');
	/* 气泡太窄：内部可用宽度 130-16 = 114 < 170.5 → 整组不显示 */
	tree = resizeBubble(150);
	assertToolHoverHandlers(tree, false, '气泡太窄');
	assert.strictEqual(visibleHoverPlain(tree).length, 0, '放不下时不残留提示');
	/* 气泡变宽：恢复并可显示 */
	tree = resizeBubble(500);
	toolSegments = assertToolHoverHandlers(tree, true, '气泡变宽后恢复');
	toolSegments[1].props.onMouseEnter({ clientX: 420, clientY: 500, stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'cordis-plugin-longname 66.67%', '恢复后长名悬浮真实出现');
	assertAlignedWithTitle('恢复后长名');
	const backHeading = byClass(tree, 'dsb-meter-headline').find((node) => typeof node.props.onClick === 'function');
	assert.ok(backHeading !== undefined, '工具调用子视图标题可返回根视图');
	backHeading.props.onClick({ stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(byClass(tree, 'dsb-meter-headline')[0]), TEMPLATES.tipCountsTitle, '返回会话数据根视图');
	const toolCallsRowAgain = findToolCallsRow(tree);
	assert.ok(toolCallsRowAgain !== undefined, '返回后仍可重新进入工具调用子视图');
	toolCallsRowAgain.props.onClick({ stopPropagation() {} });
	tree = settleHover();
	toolSegments = assertToolHoverHandlers(tree, true, '返回后再次进入工具视图');
	toolSegments[0].props.onMouseEnter({ clientX: 220, clientY: 500, stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'go 33.33%', '返回并再次进入后实际悬浮仍可用');
	console.log('工具悬浮：提示画在气泡内部（水平夹在气泡边界、垂直夹在气泡矩形内）；气泡放不下长名时整组不显示、变宽恢复');

	/* 12. 回归：气泡尺寸/视口变化后必须重测 —— ResizeObserver 是「气泡自己变宽」的信号。 */
	tree = resizeBubble(150);
	assertToolHoverHandlers(tree, false, 'ResizeObserver 用例：先缩窄（整组关闭）');
	assert.ok(observers.length > 0, '组件必须用 ResizeObserver 盯气泡尺寸（否则收不到气泡自己变大）');
	const panelObserver = observers[observers.length - 1];
	assert.ok(panelObserver.targets.length === 1, 'ResizeObserver 应只观察气泡节点，实际观察 ' + panelObserver.targets.length + ' 个');
	assert.ok(String(panelObserver.targets[0].props.className).indexOf('dsb-tip') !== -1,
		'ResizeObserver 观察的必须是气泡节点');
	/* 气泡被内容撑宽（没有 dispatch window resize）：只靠 ResizeObserver 回调触发重测 */
	hoverLayout.barRight = 500;
	panelObserver.callback();
	tree = settleHover();
	assertToolHoverHandlers(tree, true, 'ResizeObserver 重测后整组恢复');
	toolSegments = byClass(tree, 'dsb-bar-seg');
	toolSegments[1].props.onMouseEnter({ clientX: 420, clientY: 500, stopPropagation() {} });
	tree = settleHover();
	assert.strictEqual(textOf(visibleHoverPlain(tree)[0]), 'cordis-plugin-longname 66.67%',
		'ResizeObserver 恢复后长名悬浮真实出现');
	assertAlignedWithTitle('ResizeObserver 恢复后');
	console.log('悬停恢复：气泡变窄 → ResizeObserver 重测 → 整组悬停自动恢复');

console.log('');
console.log('TIP TOGGLE CHECKS PASSED');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
