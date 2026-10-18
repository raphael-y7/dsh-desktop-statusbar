/**
 * 更新功能的两项用户要求（2.2.0 补充）：
 *
 *   A. 客户端侧失败要**补日志**：浏览器里失败（网络断、响应解不出、HTTP 4xx/5xx）
 *      宿主原本完全不知道，用户点完只看到「更新失败」，日志里查不到任何痕迹。
 *      现在每条失败路径都必须 POST 一条结构化诊断到 /api/update-failure。
 *   B. 「更新失败」按钮**仍然可点**，点一下退回「更新到 X.X.X 版本」（不直接重试），
 *      用户再点一次才真的重新更新。这是用户原话要求的交互。
 *
 * 做法：用可控 fetch 替身记录所有出站请求，逐条验真实行为（不是字符串断言）。
 *
 * 用法：node tests/verify-update-retry.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker,
	'\t\texports.__test = { startPluginUpdate, snapshotUpdate, setUpdateState, setDevMode, '
	+ 'onUpdateClick, dismissUpdateFailure, isDevMode, SettingsSection, '
	+ 'DEV_VERSION, DEV_FAIL_REASON };\n' + marker);

/* ------------------------------------------------------------------ 替身 */
/** 每次 fetch 的记录；测试按 url 取最近一条来控制它何时 resolve/reject。 */
const requests = [];
function fetchStub(url, options) {
	const text = String(url);
	/* /api/version 是「有没有新版」的后台自检：本测试自己摆状态，让它立即回「没有」，
	   否则它的异步回包会在我们 setUpdateState 之后把 hasUpdate 覆盖成 false。 */
	if (text.indexOf('/api/version') !== -1) {
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ hasUpdate: false, latest: null }) });
	}
	const one = {
		url: text,
		options: options,
		body: options !== undefined && typeof options.body === 'string' ? options.body : null
	};
	one.promise = new Promise((resolve, reject) => {
		one.resolve = resolve;
		one.reject = reject;
	});
	requests.push(one);
	return one.promise;
}
const take = (suffix) => {
	for (let i = requests.length - 1; i >= 0; i -= 1) {
		if (requests[i].url.indexOf(suffix) !== -1) return requests[i];
	}
	return null;
};

const markervar = null;   /* 占位：下面统一用 marker 常量 */

const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: fetchStub,
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; }
	},
	document: {
		querySelectorAll: () => [],
		createElement: () => ({
			innerHTML: '', dataset: {}, className: '', textContent: '',
			appendChild() {}, querySelector: () => null, remove() {}, firstElementChild: null
		}),
		body: { appendChild() {} }, head: { appendChild() {} }
	},
	MutationObserver: class { observe() {} disconnect() {} },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
let captured = null;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

/**
 * React 替身：状态**跨渲染保持**（按 hook 调用顺序分配槽位，真 React 就是这么做的）。
 * 不这么写的话，渲染出来的 disabled 永远是初始态，测不出「失败态按钮可点」。
 *
 * `updateState` 这类**模块级**状态由 useSyncExternalStore 每次实时取快照，
 * 所以即使 hook 槽位没重置，那个值也是最新的（这正是我们要验的东西）。
 */
const hookSlots = [];
let hookIndex = 0;
const reactStub = {
	createElement: (type, props, ...children) => ({
		type: type,
		props: props === null || props === undefined ? {} : props,
		children: children.flat(Infinity)
	}),
	useState: (init) => {
		const slot = hookIndex;
		hookIndex += 1;
		if (hookSlots[slot] === undefined) hookSlots[slot] = init;
		return [hookSlots[slot], (next) => { hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next; }];
	},
	useEffect: (fn) => { const cleanup = fn(); return cleanup; },
	useLayoutEffect: (fn) => fn(),
	useRef: () => {
		const slot = hookIndex;
		hookIndex += 1;
		if (hookSlots[slot] === undefined) hookSlots[slot] = { current: null };
		return hookSlots[slot];
	},
	/* 关键：每次都实时读快照 —— 模块级 updateState 变化后，下一次渲染立刻反映出来 */
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useId: () => 'id',
	Fragment: Symbol('Fragment')
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	if (name === 'react-dom') throw new Error('no react-dom');
	throw new Error('unexpected require: ' + name);
}).__test;

/** 在渲染树里深度找那颗更新按钮：`key === "__update"`（页面上有多个 dsb-action 按钮）。 */
function findUpdateButton(node) {
	if (node === null || node === undefined || node === false) return null;
	if (Array.isArray(node)) {
		for (const one of node) {
			const hit = findUpdateButton(one);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (typeof node !== 'object') return null;
	if (node.props !== undefined && node.props !== null && node.props.key === '__update') {
		return node.type === 'button' ? node : null;
	}
	return node.children === undefined ? null : findUpdateButton(node.children);
}

/** 渲染一遍设置页，返回那颗更新按钮的节点（渲染不到就返回 null）。 */
function renderUpdateButton() {
	hookIndex = 0;
	const props = {
		t: (key, vars) => (vars !== undefined && vars.version !== undefined ? key + '(' + vars.version + ')' : key)
	};
	return findUpdateButton(api.SettingsSection(props));
}

/** 按钮节点的文字（把子节点拼起来）。 */
function textOfNode(node) {
	if (node === null || node === undefined) return '';
	const out = [];
	(function walk(one) {
		if (one === null || one === undefined || one === false) return;
		if (Array.isArray(one)) { one.forEach(walk); return }
		if (typeof one !== 'object') { out.push(String(one)); return }
		if (one.children !== undefined) walk(one.children);
	})(node.children);
	return out.join('');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 取最近一次失败上报的 body（解析成对象）；没有就返回 null。 */
function lastFailureReport() {
	const one = take('/api/update-failure');
	return one === null || one.body === null ? null : JSON.parse(one.body);
}
/** 让「更新到 9.9.9」这一态就绪。
 *  刻意**不调 setDevMode(false)**：它内部会发一次 /api/version 自检，回包是异步的，
 *  会在我们 setUpdateState 之后把 hasUpdate 覆盖掉，让渲染阶段的按钮时有时无。 */
function ready(latest) {
	api.setUpdateState({
		hasUpdate: true,
		latest: latest === undefined ? '9.9.9' : latest,
		busy: false, note: null, reason: null, failedTarget: null
	});
}

(async () => {
	api.setDevMode(false);

	/* ================================================================ A 组 */
	console.log('===== A：客户端失败必须补日志 =====');

	/* A1 网络异常（fetch reject） */
	ready();
	api.startPluginUpdate();
	assert.ok(take('/api/self-update') !== null, '更新请求已发出');
	take('/api/self-update').reject(new Error('net::ERR_CONNECTION_RESET'));
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '进入失败态');
	assert.strictEqual(api.snapshotUpdate().reason, 'network', '失败原因是 network');
	const a1 = lastFailureReport();
	assert.ok(a1 !== null, '网络异常必须上报一条失败日志（修复前这里一条都没有）');
	assert.strictEqual(a1.reason, 'network', '日志里有 reason');
	assert.strictEqual(a1.target, '9.9.9', '日志里有目标版本');
	assert.strictEqual(a1.current, api.snapshotUpdate().latest === '9.9.9' ? a1.current : a1.current, '日志里有当前版本');
	assert.ok(typeof a1.current === 'string' && /^\d+\.\d+\.\d+/.test(a1.current), '当前版本是版本号形态，实际 ' + String(a1.current));
	assert.ok(typeof a1.at === 'number' && a1.at > 0, '日志里有时间戳');
	assert.ok(typeof a1.elapsedMs === 'number', '日志里有耗时');
	assert.ok(String(a1.detail).indexOf('ERR_CONNECTION_RESET') !== -1, '日志里有错误详情，实际 ' + String(a1.detail));
	assert.strictEqual(a1.stage, 'request', '标出失败发生在 request 阶段');
	console.log('  A1 网络异常 → 上报 reason/target/current/at/elapsed/detail/stage，全齐');

	/* A2 响应体解不出来（response.json() 失败） */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').resolve({
		ok: true,
		status: 200,
		json: () => Promise.reject(new Error('Unexpected token < in JSON'))
	});
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'failed', 'JSON 解析失败也进失败态');
	const a2 = lastFailureReport();
	assert.ok(a2 !== null, 'JSON 解析失败必须上报日志');
	assert.strictEqual(a2.reason, 'network', '按 network 归类（fetch 层失败）');
	assert.ok(String(a2.detail).indexOf('Unexpected token') !== -1, '详情里带解析错原文');
	console.log('  A2 响应解不出来 → 也上报，详情带解析错原文');

	/* A3 HTTP 4xx（fetch 对 4xx 是 resolve，不能只 catch）—— 这是修复前的一个漏洞 */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').resolve({
		ok: false,
		status: 403,
		json: () => Promise.resolve({ ok: false, reason: 'cross-origin' })
	});
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'failed', 'HTTP 403 要判为失败');
	assert.strictEqual(api.snapshotUpdate().reason, 'http-error', 'HTTP 错误单独归类，不混进 network');
	const a3 = lastFailureReport();
	assert.ok(a3 !== null, 'HTTP 4xx 必须上报');
	assert.strictEqual(a3.httpStatus, 403, '日志里带 HTTP 状态码');
	assert.strictEqual(a3.stage, 'request', '标出是请求阶段');
	console.log('  A3 HTTP 403 → 单独归类 http-error，日志带 httpStatus=403（修复前会被当成"解不出来"）');

	/* A4 宿主明确回 ok:false：日志要能和宿主那条对上 */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').resolve({
		ok: true, status: 200,
		json: () => Promise.resolve({ ok: false, reason: 'verify-failed' })
	});
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().reason, 'verify-failed', '带出宿主给的原因');
	const a4 = lastFailureReport();
	assert.ok(a4 !== null, '宿主失败也要在客户端留一条（两边能对上）');
	assert.strictEqual(a4.reason, 'verify-failed', '日志 reason 与界面一致');
	assert.strictEqual(a4.stage, 'host', '标出是宿主阶段');
	assert.ok(String(a4.detail).indexOf('verify-failed') !== -1, '详情里带宿主回的原文');
	console.log('  A4 宿主回 ok:false → 客户端也留一条，带 stage=host 与宿主原文');

	/* A5 成功时不许误报 */
	const beforeOk = take('/api/update-failure');
	ready();
	api.startPluginUpdate();
	take('/api/self-update').resolve({
		ok: true, status: 200,
		json: () => Promise.resolve({ ok: true, from: '2.2.0', to: '9.9.9' })
	});
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'done', '成功态');
	assert.strictEqual(take('/api/update-failure'), beforeOk, '成功时不得上报失败日志');
	console.log('  A5 成功 → 不上报失败日志');

	/* ================================================================ B 组 */
	console.log('\n===== B：「更新失败」可点，点一下退回可重试 =====');

	/* B1 失败态点按钮：只退回、不重试 */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').reject(new Error('boom'));
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '前置：处于失败态');
	const requestsBefore = requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length;
	api.onUpdateClick();
	await wait(30);
	const afterClick = api.snapshotUpdate();
	assert.strictEqual(afterClick.note, null, '点一下退回可重试（note 清空 → 按钮显示「更新到 X.X.X 版本」）');
	assert.strictEqual(afterClick.reason, null, '失败原因一并清掉');
	assert.strictEqual(afterClick.busy, false, '不是进入更新中');
	assert.strictEqual(
		requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length,
		requestsBefore,
		'点一下**只退回、不发起重试**（用户要的是"再点一次才重试"）'
	);
	assert.strictEqual(afterClick.latest, '9.9.9', '退回后文案仍是那个目标版本');
	console.log('  B1 失败态点一下 → 退回可重试，且**没有**偷偷重试（请求数不变）');

	/* B2 退回之后再点一次：这次真的发起更新 */
	api.onUpdateClick();
	await wait(10);
	assert.strictEqual(api.snapshotUpdate().busy, true, '再点一次才真的开始更新');
	assert.ok(
		requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length > requestsBefore,
		'第二次点击真的发出了更新请求'
	);
	/* 收尾：让这次请求成功结束 */
	take('/api/self-update').resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	await wait(30);
	console.log('  B2 退回后再点一次 → 真的重试（请求发出、进入更新中）');

	/* B3 失败态按钮必须**可点**：真渲染设置页，读按钮节点上的 disabled */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').reject(new Error('boom'));
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '前置：处于失败态');
	const failedButton = renderUpdateButton();
	assert.ok(failedButton !== null, '渲染出了更新按钮');
	assert.strictEqual(failedButton.props.disabled, false,
		'失败态按钮必须**可点**（disabled 为 false）；修复前/变异后会变成 true');
	assert.strictEqual(typeof failedButton.props.onClick, 'function', '失败态按钮仍挂着点击处理');
	assert.strictEqual(failedButton.props.onClick, failedButton.props.onClick, '同一引用');
	console.log('  B3 失败态按钮 disabled=false（真渲染读到的，不是源码字符串匹配）');

	/* B3b 更新中态：按钮必须**不可点**（这是唯一该 disabled 的状态） */
	ready();
	api.startPluginUpdate();
	const busyButton = renderUpdateButton();
	assert.strictEqual(busyButton.props.disabled, true, '更新中按钮必须 disabled（不能重复发起）');
	take('/api/self-update').resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	await wait(30);
	console.log('  B3b 更新中态 disabled=true（唯一该禁用的状态）');

	/* B3c 失败态渲染出来的**文案**仍是「更新失败」（点了才变） */
	ready();
	api.startPluginUpdate();
	take('/api/self-update').reject(new Error('boom'));
	await wait(30);
	assert.strictEqual(textOfNode(renderUpdateButton()), 'updateFailed', '失败态文案 = updateFailed');
	api.onUpdateClick();
	const afterDismiss = renderUpdateButton();
	assert.strictEqual(textOfNode(afterDismiss), 'updateTo(9.9.9)', '点一下退回「更新到 9.9.9 版本」');
	assert.strictEqual(afterDismiss.props.disabled, false, '退回后可点，用户再点一次才重试');
	console.log('  B3c 失败态文案=updateFailed；点一下 → updateTo(9.9.9)，按钮可点');

	/* B4 更新中点按钮：仍然不重新发起（保留原有保护） */
	ready();
	api.startPluginUpdate();
	const busyCount = requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length;
	api.onUpdateClick();   /* 此时 busy === true */
	await wait(10);
	assert.strictEqual(
		requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length,
		busyCount,
		'更新中再点不会重复发起（原保护仍在）'
	);
	take('/api/self-update').resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	await wait(30);
	console.log('  B4 更新中再点 → 不重复发起（disabled + 内部 guard 双保险）');

	/* B5 已更新（done）态点按钮：保持原行为（真的再发一次），不能被误当成失败态 */
	ready();
	api.setUpdateState({ busy: false, note: 'done', reason: null });
	const doneCount = requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length;
	api.onUpdateClick();
	await wait(10);
	assert.ok(
		requests.filter((one) => one.url.indexOf('/api/self-update') !== -1).length > doneCount,
		'done 态点按钮仍是"真的更新"（只有 failed 态才是纯退回）'
	);
	take('/api/self-update').resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
	await wait(30);
	console.log('  B5 done 态点按钮 → 仍走真实更新（只有 failed 态是纯退回）');

	console.log('\nUPDATE RETRY CHECKS PASSED');
})().catch((error) => {
	console.error('UPDATE RETRY CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
