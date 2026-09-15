/**
 * 计时器行为测试：验证「后续轮次计时停摆」这个问题的修复。
 *
 * 关键点：计时器不能只在 running === true 时运行。
 * DSH 的 running 在 step/turn 边界会短暂转 false，而总用时投影里仍有活跃基线
 * （since / stepSince），这时时钟必须继续走，否则数字要等下一次事件才跳。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker, '\t\texports.__test = { StatusBar, msToNextPeakBoundary };\n' + marker);

/* -------- 可观察的 effect / interval 替身 -------- */
let activeEffect = null;
const cleanups = [];
const intervals = [];
const cleared = [];
const timeouts = [];
const clearedTimeouts = [];

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: (fn, ms) => { const id = intervals.length + 1; intervals.push({ id, ms, fn }); return id; },
	clearInterval: (id) => { cleared.push(id); },
	setTimeout: (fn, ms) => { const id = timeouts.length + 1; timeouts.push({ id, ms, fn }); return id; },
	clearTimeout: (id) => { clearedTimeouts.push(id); },
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) })
};

let captured = null;
fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
const sandbox = {
	window: fakeWindow,
	document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;

const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
	/* 让某个 useState 能取到预设值：组件里第二个 useState 是余额（fetch 结果），
	 * 替身没有 setState，用这个入口把余额塞进去，才能覆盖到余额分支。 */
	pendingStates: [],
	useState: (init) => {
		const injected = reactStub.pendingStates.shift();
		if (injected !== undefined) return [injected, () => {}];
		return [typeof init === 'function' ? init() : init, () => {}];
	},
	useRef: (init) => ({ current: init === undefined ? null : init }),
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useEffect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

const t = (key, params) => {
	let out = '<' + key + '>';
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

function renderBar({ running, timeRange, stats, error }) {
	intervals.length = 0;
	cleared.length = 0;
	timeouts.length = 0;
	clearedTimeouts.length = 0;
	cleanups.length = 0;
	activeEffect = null;
	const tree = api.StatusBar({
		t,
		sessionId: 's1',
		useProjection: (name) => {
			if (name === 'desktopStatusbarActiveTime') return timeRange;
			if (name === 'sessionStats') return stats;
			return undefined;
		},
		useSession: (selector) => (selector === undefined ? undefined : selector({ running, partial: null, runningCalls: [], lastAgentError: error === true ? { message: 'boom' } : null })),
		useSessions: () => undefined,
		useChat: () => undefined
	});
	/* 时钟与余额轮询共用 setInterval：时钟是 1s / 10s，余额是 60s */
	const clocks = intervals.filter((entry) => entry.ms <= 10000);
	const dot = findDot(tree);
	return { clocks, timeouts: timeouts.slice(), dotClass: dot === null ? null : dot.props.className, cleanup: () => cleanups.forEach((fn) => fn()), all: intervals.slice() };
}

/** 渲染树里第一个 dsb-dot span 的 props（状态点） */
function findDot(node) {
	if (node === null || node === undefined || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findDot(child);
			if (hit !== null) return hit;
		}
		return null;
	}
	const cls = node.props === undefined ? undefined : node.props.className;
	if (typeof cls === 'string' && cls.indexOf('dsb-dot') === 0) return node;
	return findDot(node.children);
}

/* 0. 状态点必须带上 running / error 修饰类（丢了 state 就只剩灰点） */
let dotRun = renderBar({ running: true, timeRange: { turns: 0, since: Date.now(), steps: 0, stepSince: null } });
assert.strictEqual(dotRun.dotClass, 'dsb-dot dsb-dot-running', 'running dot is green');
let dotIdle = renderBar({ running: false, timeRange: { turns: 0, since: null, steps: 0, stepSince: null } });
assert.strictEqual(dotIdle.dotClass, 'dsb-dot', 'idle dot stays neutral');
let dotErr = renderBar({ running: false, error: true, timeRange: { turns: 0, since: null, steps: 0, stepSince: null } });
assert.strictEqual(dotErr.dotClass, 'dsb-dot dsb-dot-error', 'error dot is red');
console.log('状态点：运行中 ' + dotRun.dotClass + ' / 空闲 ' + dotIdle.dotClass + ' / 出错 ' + dotErr.dotClass);

/* 0b. 勾了余额段时必须能渲染：余额分支调用 factory 作用域的 balanceAtLabel，
 * 它若引用组件里的 t 会抛 ReferenceError，整条底栏会被 React 卸载（回归护栏）。 */
{
	const store = fakeWindow.localStorage;
	store.setItem('dsh.desktopStatusBar.v1', JSON.stringify({
		version: 4, enabled: true, wrap: true, segments: ['status', 'balance']
	}));
	let tree = null;
	let threw = null;
	try {
		/* 组件里的 useState 顺序：now → balance。两个都注入，余额才真的走到渲染分支 */
		reactStub.pendingStates = [Date.now(), { ok: true, total: '3.35', currency: 'CNY', at: Date.now() }];
		tree = api.StatusBar({
			t,
			sessionId: 's1',
			useProjection: (name) => (name === 'desktopStatusbarBalance' ? { ok: true, total: '3.35', currency: 'CNY', at: Date.now() } : undefined),
			useSession: (selector) => (selector === undefined ? undefined : selector({ running: false })),
			useSessions: () => undefined,
			useChat: () => undefined
		});
	} catch (error) {
		threw = error;
	}
	reactStub.pendingStates = [];
	store.removeItem('dsh.desktopStatusBar.v1');
	assert.strictEqual(threw, null, 'balance segment must not throw: ' + (threw === null ? '' : threw.message));
	assert.ok(tree !== null, 'bar renders with balance segment enabled');
	console.log('余额段配置：渲染正常');
}

/* 1. 运行中 + 投影有活跃 turn：1 秒一跳 */
let r = renderBar({ running: true, timeRange: { turns: 60000, since: Date.now() - 5000, steps: 0, stepSince: null } });
assert.strictEqual(r.clocks.length, 1, 'running: exactly one clock');
assert.strictEqual(r.clocks[0].ms, 1000, 'running: 1s tick');

/* 2. running 短暂转 false，但投影仍有活跃 turn → 时钟必须继续（本次修复的核心） */
r = renderBar({ running: false, timeRange: { turns: 60000, since: Date.now() - 5000, steps: 0, stepSince: null } });
assert.strictEqual(r.clocks.length, 1, 'running=false but active turn: clock must keep running');
assert.strictEqual(r.clocks[0].ms, 10000, 'idle-speed tick to stay cheap');

/* 3. 只靠 stepSince 也照样走 */
r = renderBar({ running: false, timeRange: { turns: 0, since: null, steps: 30000, stepSince: Date.now() - 2000 } });
assert.strictEqual(r.clocks.length, 1, 'stepSince alone keeps the clock');

/* 4. 完全空闲（没有基线、没有 running）：不轮询，但要按峰谷边界醒一次 */
r = renderBar({ running: false, timeRange: { turns: 120000, since: null, steps: 0, stepSince: null } });
assert.strictEqual(r.clocks.length, 0, 'idle: no clock');
assert.strictEqual(r.timeouts.length, 1, 'idle: 按时段边界安排一次刷新，实际 ' + r.timeouts.length);
const expectedBoundary = api.msToNextPeakBoundary(Date.now()) + 1000;
assert.ok(Math.abs(r.timeouts[0].ms - expectedBoundary) < 50, '边界定时器应与 helper 一致，实际 ' + r.timeouts[0].ms + ' vs ' + expectedBoundary);

/* 4b. 边界计算：北京 9:00 / 12:00 / 14:00 / 18:00 / 次日 0:00 */
const beijing = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 8, 30)), 30 * 60 * 1000, '8:30 → 9:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 8, 59)), 60 * 1000, '8:59 → 9:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 9, 30)), 150 * 60 * 1000, '9:30 → 12:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 12, 30)), 90 * 60 * 1000, '12:30 → 14:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 18, 30)), 870 * 60 * 1000, '18:30 → 次日 9:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 0, 30)), 510 * 60 * 1000, '0:30 → 9:00');
assert.strictEqual(api.msToNextPeakBoundary(beijing(2026, 9, 14, 23, 30)), 570 * 60 * 1000, '23:30 → 次日 9:00');
console.log('峰谷边界：8:30→9:00 30 分钟 / 12:30→14:00 1.5 小时 / 18:30→次日 9:00 14.5 小时（午夜不算边界）');

/* 5. 投影缺失（host 插件没装）时退回 running 驱动 */
r = renderBar({ running: true, timeRange: undefined });
assert.strictEqual(r.clocks.length, 1, 'no projection: fall back to running');

/* 6. 清理函数要能停掉时钟 */
r = renderBar({ running: true, timeRange: { turns: 0, since: Date.now(), steps: 0, stepSince: null } });
assert.strictEqual(typeof r.cleanup, 'function', 'effect returns cleanup');
r.cleanup();
assert.ok(cleared.includes(r.clocks[0].id), 'cleanup clears the clock');

/* 7. 诊断快照要如实带上投影基线（控制台排查用） */
function debugFor(sinceMs) {
	const now = Date.now();
	const range = { turns: 0, since: now - sinceMs, steps: 0, stepSince: null };
	api.StatusBar({
		t: (key) => '<' + key + '>',
		sessionId: 's1',
		useProjection: (name) => (name === 'desktopStatusbarActiveTime' ? range : undefined),
		useSession: (selector) => (selector === undefined ? undefined : selector({ running: true })),
		useSessions: () => undefined,
		useChat: () => undefined
	});
	return { debug: fakeWindow.__dsbDebug, range };
}
const three = debugFor(3000);
const five = debugFor(5000);
assert.strictEqual(three.debug.running, true, 'debug carries running');
assert.strictEqual(three.debug.clockActive, true, 'debug carries clockActive');
assert.strictEqual(three.debug.timeRange.since, three.range.since, 'debug carries the raw projection');
assert.strictEqual(five.debug.timeRange.since, five.range.since, 'debug follows the new projection');
const age = Date.now() - Number(three.debug.timeRange.since);
assert.ok(age >= 2500 && age <= 20000, 'baseline age is close to what was passed in, got ' + String(age));
console.log('诊断快照：', JSON.stringify(five.debug));

console.log('CLOCK CHECKS PASSED');
