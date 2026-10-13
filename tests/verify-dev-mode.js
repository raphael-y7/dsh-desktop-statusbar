/**
 * 开发模式：连点版本号 5 次进入，四种状态循环，且**绝不真安装**。
 *
 * 这段逻辑的目的就是「让作者亲眼看到更新按钮怎么表现」，所以本测试要证明三件事：
 *   1. 入口手势正确：连点 5 次进入，间隔太久要重新计数，再连点 5 次退出；
 *   2. 状态循环完整：空闲 → 更新中 → 已更新 → 更新失败 → 空闲；
 *   3. **一次都不发安装请求** —— 开发模式必须纯本地，否则就变成了偷偷装东西。
 *
 * 用法：node tests/verify-dev-mode.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker, '\t\texports.__test = { startPluginUpdate, snapshotUpdate, setUpdateState, setDevMode, runDevPreview, isDevMode, onVersionClick, DEV_VERSION, DEV_FAIL_REASON, DEV_CLICKS, DEV_CLICK_WINDOW_MS };\n' + marker);

/* ------------------------------------------------------------ 最小替身 */
const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; }
	},
	document: { querySelectorAll: () => [], createElement: () => ({ innerHTML: '', dataset: {}, appendChild() {}, querySelector: () => null }), body: {}, head: { appendChild() {} } },
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	/* ---------------- ① 入口手势：连点 5 次进入开发模式 ---------------- */
	assert.strictEqual(api.isDevMode(), false, '默认不在开发模式');
	assert.strictEqual(api.DEV_CLICKS, 5, '连点次数应当是 5');

	for (let i = 1; i < api.DEV_CLICKS; i += 1) {
		const state = api.onVersionClick();
		assert.strictEqual(api.isDevMode(), false, '第 ' + i + ' 次点击还不该进入');
		assert.strictEqual(state.count, i, '计数应当是 ' + i);
	}
	api.onVersionClick();   /* 第 5 次 */
	assert.strictEqual(api.isDevMode(), true, '连点 5 次后进入开发模式');
	console.log('① 连点 ' + api.DEV_CLICKS + ' 次 → 进入开发模式');

	/* 进入后状态摆成「有新版本可更新」，版本号是演示用的假号 */
	const opened = api.snapshotUpdate();
	assert.strictEqual(opened.hasUpdate, true, '开发模式下更新按钮常驻');
	assert.strictEqual(opened.latest, api.DEV_VERSION, '演示版本号是假的 ' + api.DEV_VERSION);
	assert.strictEqual(opened.busy, false, '初始不进忙碌态');
	assert.strictEqual(opened.note, null, '初始没有结论');
	console.log('② 进入后：按钮常驻，演示版本号 ' + opened.latest);

	/* ---------------- ③ 状态循环 ---------------- */
	const fetches = [];
	sandbox.window.fetch = (url) => {
		fetches.push(String(url));
		return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
	};
	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().busy, true, '第一次点击进入「更新中」');
	console.log('③ 点击 1 → 更新中（busy=true）');

	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().busy, false, '更新中结束');
	assert.strictEqual(api.snapshotUpdate().note, 'done', '进入「已更新」');
	console.log('④ 自动推进 → 已更新（note=done）');

	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '第二次点击进入「更新失败」');
	assert.strictEqual(api.snapshotUpdate().reason, api.DEV_FAIL_REASON, '带出失败原因（走真实失败显示路径）');
	console.log('⑤ 点击 2 → 更新失败（reason=' + api.DEV_FAIL_REASON + '）');

	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().note, null, '第三次点击回到空闲');
	assert.strictEqual(api.snapshotUpdate().hasUpdate, true, '仍处于开发模式，按钮还在');
	console.log('⑥ 点击 3 → 回到空闲，可再点一遍');

	/* ---------------- ⑦ 关键：整轮演示一次安装请求都没发 ---------------- */
	await settle();
	assert.deepStrictEqual(fetches, [], '开发模式全程不得发任何 fetch，实际：' + JSON.stringify(fetches));
	console.log('⑦ 全程未发任何网络请求（纯本地，绝不安装）');

	/* ---------------- ⑧ 再连点 5 次退出，恢复真实自检结果 ---------------- */
	sandbox.window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ hasUpdate: false, latest: null }) });
	for (let i = 0; i < api.DEV_CLICKS; i += 1) api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '再连点 5 次退出开发模式');
	await settle();
	const closed = api.snapshotUpdate();
	assert.strictEqual(closed.hasUpdate, false, '退出后按真实自检结果：没有新版就不显示按钮');
	assert.strictEqual(closed.latest, null, '演示版本号被清掉');
	console.log('⑧ 再连点 5 次 → 退出，恢复真实自检结果');

	/* ---------------- ⑨ 慢点不算：间隔超过时间窗就重新计数 ---------------- */
	api.onVersionClick();
	api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '点了 2 次还没进');
	/* 等到超过时间窗，再点一次应当从 1 重新数（而不是接着累到 3） */
	await waitFor(api.DEV_CLICK_WINDOW_MS + 200);
	const afterGap = api.onVersionClick();
	assert.strictEqual(afterGap.count, 1, '间隔超时后重新从 1 计数（慢慢点不会误进）');
	assert.strictEqual(api.isDevMode(), false, '慢点 3 次不该进入');
	console.log('⑨ 慢点不误触：间隔超过 ' + api.DEV_CLICK_WINDOW_MS + 'ms 就重新计数');

	/* ---------------- ⑩ 退出会停掉在跑的定时器 ---------------- */
	api.setDevMode(true);
	api.runDevPreview();          /* 进入「更新中」，挂一个定时器 */
	assert.strictEqual(api.snapshotUpdate().busy, true, '演示进入更新中');
	api.setDevMode(false);        /* 中途退出 */
	assert.strictEqual(api.snapshotUpdate().busy, false, '退出立即停止演示，不留在忙碌态');
	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().note, null, '被取消的定时器不得迟到生效');
	console.log('⑩ 中途退出：定时器被清掉，没有迟到的状态更新');

	/* ---------------- ⑪ 更新中重复点击不叠加 ---------------- */
	sandbox.window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ hasUpdate: false, latest: null }) });
	api.setDevMode(true);
	api.runDevPreview();
	api.runDevPreview();
	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().busy, true, '更新中重复点击仍停在更新中');
	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().note, 'done', '只推进一次，没有因多次点击而跳步');
	console.log('⑪ 更新中重复点击：被忽略，只推进一次');

	/* ---------------- ⑫ 真实更新路径不受开发模式影响 ---------------- */
	api.setDevMode(false);
	await settle();
	const realFetches = [];
	sandbox.window.fetch = (url, options) => {
		realFetches.push(String(url));
		return new Promise(() => {});   /* 挂着，只看它有没有发请求 */
	};
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	assert.strictEqual(realFetches.length, 1, '退出开发模式后，点击会打真实更新接口');
	assert.strictEqual(realFetches[0], '/dsh-desktop-statusbar/api/self-update', '打的是自有更新路由');
	assert.strictEqual(api.snapshotUpdate().busy, true, '真实更新不依赖 ctx.remote（空 ctx 下照常工作）');
	console.log('⑫ 退出后走真实路径：发出 1 次安装请求到自有路由');

	console.log('\nDEV MODE CHECKS PASSED');
})().catch((error) => {
	console.error('DEV MODE CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
