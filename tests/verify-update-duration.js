/**
 * 核实：「正在更新中...」的持续时间到底由什么决定。
 *
 * 结论分两条路径，必须分开看：
 *   A. 真实更新（startPluginUpdate）：busy 从发请求前置上，到 **HTTP 响应回来**才解除。
 *      没有任何人为定时器参与 —— 持续时间 = 后端真正跑完 pnpm 的时间。
 *      所以它确实「跟随更新动作的时间」，而且是精确跟随。
 *   B. 开发模式（runDevPreview）：**故意**用一个固定 2200ms 的定时器演示，
 *      因为它不真的安装。这条只在开发模式模式里走，与真实更新完全隔离。
 *
 * 本测试用「一个自己控制何时 resolve 的 fetch」来证明 A 的长度是外部可控的：
 * 若代码里有固定时长，那么无论 fetch 何时 resolve，busy 都会在同一时间解除；
 * 若跟随真实动作，busy 就会一直保持到我们手动 resolve 为止。
 *
 * 用法：node tests/verify-update-duration.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker, '\t\texports.__test = { startPluginUpdate, snapshotUpdate, setUpdateState, setDevMode, runDevPreview, isDevMode, DEV_VERSION };\n' + marker);

/* ------------------------------------------------------------------ 替身 */
/** 可控 fetch：把 resolve 攥在测试手里，用来测 busy 到底跟谁走。 */
let pending = null;
sandbox_setup();
function sandbox_setup() {}
const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: (url, options) => {
			return new Promise((resolve) => {
				pending = { url: String(url), options, resolve };
			});
		},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; }
	},
	document: { querySelectorAll: () => [], createElement: () => ({ innerHTML: '', dataset: {}, appendChild() {}, querySelector: () => null, remove() {} }), body: {}, head: { appendChild() {} } },
	MutationObserver: class { observe() {} disconnect() {} },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
let captured = null;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') {
		return {
			createElement: () => ({}), useState: (init) => [init, () => {}], useEffect: () => {},
			useRef: () => ({ current: null }), useSyncExternalStore: (sub, snap) => snap(),
			useCallback: (fn) => fn, useMemo: (fn) => fn(), Fragment: Symbol('Fragment')
		};
	}
	if (name === 'react-dom') throw new Error('no react-dom');
	throw new Error('unexpected require: ' + name);
}).__test;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	api.setDevMode(false);   /* 真实路径，不是开发模式 */

	/* ---- ① 真实更新：把请求发出去，但**故意让它挂着** ---- */
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	assert.strictEqual(api.snapshotUpdate().busy, true, '点击后立刻进入「正在更新中」');
	assert.ok(pending !== null, '确实发出了请求');
	assert.strictEqual(pending.url, '/dsh-desktop-statusbar/api/self-update', '打的是自有更新路由');
	console.log('① 点击后立刻进入更新中，请求已发出（尚未返回）');

	/* ---- ② 请求挂着不放：等远超开发模式那 2200ms 的时间 ---- */
	await wait(3500);
	assert.strictEqual(api.snapshotUpdate().busy, true,
		'请求还没回来时，即使过了 3.5 秒（超过开发模式的 2.2 秒）也必须仍然停在「更新中」——' +
		'证明真实路径没有固定时长');
	console.log('② 等 3.5 秒（超过开发模式的 2.2 秒）：仍在更新中 → 真实路径无固定时长');

	/* ---- ③ 现在才让请求返回：busy 应当**立刻**解除 ---- */
	pending.resolve({ ok: true, json: () => Promise.resolve({ ok: true, from: '2.1.1', to: '9.9.9' }) });
	await wait(30);
	const after = api.snapshotUpdate();
	assert.strictEqual(after.busy, false, '响应一回来就解除「更新中」');
	assert.strictEqual(after.note, 'done', '进入成功态');
	console.log('③ 手动放行响应：立刻解除更新中 → 时长完全跟随后端动作');

	/* ---- ④ 真实路径的失败：也要在响应回来时才解除 ---- */
	pending = null;
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	await wait(1500);
	assert.strictEqual(api.snapshotUpdate().busy, true, '失败场景同样要等响应，不能提前结束');
	pending.resolve({ ok: true, json: () => Promise.resolve({ ok: false, reason: 'release-age' }) });
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().busy, false, '失败响应回来才解除');
	assert.strictEqual(api.snapshotUpdate().reason, 'release-age', '带出真实失败原因');
	console.log('④ 失败场景：同样等响应，不提前结束');

	/* ---- ⑤ 开发模式路径：这里**确实**是固定 2200ms（这是有意的，它不真装） ---- */
	api.setDevMode(true);
	assert.strictEqual(api.snapshotUpdate().busy, false, '打开开发模式后不处于忙碌');
	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().busy, true, '开发模式点击后进入更新中');
	await wait(1200);
	assert.strictEqual(api.snapshotUpdate().busy, true, '开发模式 1.2 秒时仍在更新中（未到 2.2 秒）');
	await wait(1400);   /* 累计约 2.6 秒 */
	assert.strictEqual(api.snapshotUpdate().note, 'done', '开发模式约 2.2 秒后自动转为成功（固定时长，仅演示）');
	console.log('⑤ 开发模式路径：约 2.2 秒后自动转成功（有意的固定时长，且不真装）');

	/* ---- ⑥ 两条路径互不干扰：开发模式的定时器不该影响真实更新 ---- */
	api.setDevMode(false);
	await wait(50);
	pending = null;
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	await wait(2600);   /* 超过开发模式的 2.2 秒 */
	assert.strictEqual(api.snapshotUpdate().busy, true, '真实更新不会被开发模式那 2.2 秒的定时器提前结束');
	pending.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
	await wait(30);
	assert.strictEqual(api.snapshotUpdate().busy, false, '仍然要等真实响应');
	console.log('⑥ 开发模式的定时器不影响真实更新（真实更新等满响应）');

	console.log('\nUPDATE DURATION CHECKS PASSED');
})().catch((error) => {
	console.error('UPDATE DURATION CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
