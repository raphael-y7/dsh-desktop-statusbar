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

const clicks = [];
const resizes = [];
const scrolls = [];
const fetched = [];
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
				: { ok: false })
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
		addEventListener: (name, fn) => { if (name === 'click') clicks.push(fn); },
		removeEventListener: () => {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;

/* React 替身：hooks 按组件分桶；ref 会拿到一个能判"是不是底栏内部"的假节点 */
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
		const node = {
			type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
			__inside: true,
			/* 替身节点也当 DOM 用：contains 给"点别处收起"判内外，getBoundingClientRect 给气泡量宽度 */
			contains: (target) => target !== null && target !== undefined && target.__inside === true,
			getBoundingClientRect: () => ({ width: 240, height: 40, left: 0, top: 0, right: 240, bottom: 40 })
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
		fn();
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
	if (n !== 'react') throw new Error('unexpected require: ' + n);
	return reactStub;
}).__test;

const TEMPLATES = {
	f_ttft: '首字平均 {duration}', f_speed: '综合速度 {throughput}t/s', f_sessionTime: '总用时 {duration}',
	f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}', f_balance: '余额 {symbol}{amount}',
	f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出',
	f_tokensTotal: '总计用量', f_tokensTurn: '本轮用量', f_peak: '高峰', f_valley: '低谷',
	f_cacheHit: '综合命中 {percent}%', f_counts: '{turns} 轮 {steps} 步',
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

console.log('');
console.log('TIP TOGGLE CHECKS PASSED');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
