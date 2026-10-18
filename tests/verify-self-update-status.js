/**
 * 更新状态接口：`GET /api/self-update` 必须把「找不到 pnpm 时试过哪些路径」带出去。
 *
 * 为什么单独一条：self-update.js 里已经把 `tried` 算好了，但界面/用户看到的是
 * **状态接口**那一段 JSON。字段漏接的话，日志里有、接口里没有，issue 里那种
 * 「只能手工逐条 Test-Path 才定位」的排查体验还是原样 —— 这条专门钉住那根接线。
 *
 * 判据只针对「新加的字段」，不改任何现有字段语义：
 *   · last 仍带 ok / reason / from / to；
 *   · 新加的 last.tried 是字符串数组，能找到 primary-runtime 这条候选；
 *   · 没跑过更新时 last 仍是 null（不能凭空造一个对象）。
 *
 * 用法：node tests/verify-self-update-status.js；退出码 0 = 通过。
 */
const assert = require('assert');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const ROOT = join(__dirname, '..');

/* 隔离真实家目录：index.js 的 apply 会预热用量台账，别让它扫真实会话 */
const home = mkdtempSync(join(tmpdir(), 'dsb-status-home-'));
process.env.DSH_HOME = home;
/* 插件的用量刷新定时器会把测试进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

/**
 * 起一个 host 实例并返回请求小工具。
 * 与 verify-fixes.js 里那套假 req/res 同源，只保留这里需要的最小面。
 *
 * 注意必须**走接口**触发更新，不能直接 import self-update.js 调 `selfUpdateOnce()`：
 * 本测试给 self-update.js 的 import 加了 `?case=` 查询串，那会得到**另一个模块实例**，
 * 它的 lastResult 与 index.js 内部那份不是同一个 —— 直接调会让状态接口永远看到 null。
 *
 * @returns {Promise<{get: Function, post: Function}>}
 */
async function bootHost() {
	const mod = await import('file:///' + join(ROOT, 'lib', 'index.js').replace(/\\/g, '/') + '?case=status');
	let registered = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (route) => { registered = route; return () => {}; } },
		credentials: undefined,
	});
	assert.ok(registered !== null && typeof registered.handler === 'function', '路由已注册（前置条件）');
	const handler = registered.handler;
	/** 发一次请求；GET 不带 body，POST 带 JSON 文本。 */
	const request = (pathname, method, body) => new Promise((resolve) => {
		let status = null;
		let text = null;
		const res = {
			headersSent: false,
			writeHead: (code) => { status = code; res.headersSent = true; },
			end: (one) => { if (one !== undefined) text = one; },
		};
		const listeners = {};
		const req = {
			url: pathname,
			method: method,
			headers: { host: '127.0.0.1:19387' },
			on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
			destroy: () => {},
		};
		const timer = setTimeout(() => resolve({ status: 'TIMEOUT', body: null }), 30000);
		Promise.resolve(handler(req, res)).then(() => {
			clearTimeout(timer);
			resolve({ status: status, body: text === null ? null : JSON.parse(text) });
		}, () => {
			clearTimeout(timer);
			resolve({ status: 'REJECTED', body: null });
		});
		if (body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(body, 'utf8')));
		(listeners.end || []).forEach((fn) => fn());
	});
	return {
		get: (pathname) => request(pathname, 'GET', undefined),
		post: (pathname, body) => request(pathname, 'POST', body),
	};
}

(async () => {
	const host = await bootHost();

	/* ① 还没跑过更新：last 必须是 null，不能凭空造对象 */
	const fresh = await host.get('/dsh-desktop-statusbar/api/self-update');
	assert.strictEqual(fresh.status, 200, '状态接口返回 200，实际 ' + String(fresh.status));
	assert.strictEqual(fresh.body.ok, true, '状态接口 ok 为 true');
	assert.strictEqual(fresh.body.busy, false, '空闲时 busy 为 false');
	assert.strictEqual(fresh.body.last, null, '没跑过更新时 last 为 null（不凭空造对象）');
	console.log('状态接口：没跑过更新时 last 为 null');

	/* ② 制造一次「找不到 pnpm」的失败：把 resources 指向空目录，清掉两个覆盖变量 */
	const sandbox = mkdtempSync(join(tmpdir(), 'dsb-status-'));
	const emptyResources = join(sandbox, 'resources');
	mkdirSync(emptyResources, { recursive: true });
	const fakeHost = join(sandbox, 'DeepSeek Harness.exe');
	writeFileSync(fakeHost, '', 'utf8');
	/* host 端 `resolveSelfDir()` 会从**本仓库**往上找同名插件目录，所以 from 读到的是
	   仓库自己的版本号（不是上面那个假目录的）。断言用它，避免把版本号写死。 */
	const repoVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
	/* 一个像插件的目录，让 runSelfUpdate 能读到版本 */
	const liveDir = join(sandbox, 'node_modules', 'dsh-desktop-statusbar');
	mkdirSync(liveDir, { recursive: true });
	writeFileSync(join(liveDir, 'package.json'), JSON.stringify({
		name: 'dsh-desktop-statusbar', version: '2.1.2', type: 'module'
	}, null, 2), 'utf8');

	const savedExecPath = process.execPath;
	const savedResourcesPath = process.resourcesPath;
	const savedCustom = process.env.DSH_DESKTOP_STATUSBAR_PNPM;
	const savedHostEntry = process.env.DSH_DESKTOP_PNPM_ENTRY;
	try {
		delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		process.execPath = fakeHost;
		Object.defineProperty(process, 'resourcesPath', { value: emptyResources, configurable: true, writable: true });

		const failure = await host.post('/dsh-desktop-statusbar/api/self-update', JSON.stringify({ version: '2.2.1' }));
		assert.strictEqual(failure.status, 200, '更新接口返回 200，实际 ' + String(failure.status));
		assert.strictEqual(failure.body.reason, 'pnpm-not-found', '前置：这次更新确实失败在 pnpm-not-found，实际 ' + String(failure.body.reason));

		/* ③ 现在状态接口必须把 tried 带出来 */
		const after = await host.get('/dsh-desktop-statusbar/api/self-update');
		assert.strictEqual(after.status, 200, '失败后状态接口仍返回 200');
		assert.ok(after.body.last !== null && typeof after.body.last === 'object', '失败后 last 是对象');
		assert.strictEqual(after.body.last.ok, false, 'last.ok 如实反映失败');
		assert.strictEqual(after.body.last.reason, 'pnpm-not-found', 'last.reason 如实反映失败原因');
		assert.strictEqual(after.body.last.from, repoVersion, 'last.from 是插件目录 package.json 里声明的版本（host 自己定位的）');
		assert.strictEqual(after.body.last.to, '2.2.1', 'last.to 是这次的目标版本');
		assert.ok(Array.isArray(after.body.last.tried), 'last.tried 必须是数组（缺了就等于把排查线索丢了）');
		assert.ok(after.body.last.tried.length > 0, 'last.tried 不能为空');
		assert.ok(after.body.last.tried.every((one) => typeof one === 'string'), 'last.tried 每条都是格式化好的字符串');
		assert.ok(after.body.last.tried.some((one) => one.indexOf('primary-runtime') !== -1),
			'last.tried 里能看到 primary-runtime 候选（正是这次修的布局）');
		console.log('状态接口：失败后 last.tried 带出 ' + after.body.last.tried.length + ' 条候选路径');
	} finally {
		process.execPath = savedExecPath;
		if (savedResourcesPath === undefined) delete process.resourcesPath;
		else Object.defineProperty(process, 'resourcesPath', { value: savedResourcesPath, configurable: true, writable: true });
		if (savedCustom === undefined) delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		else process.env.DSH_DESKTOP_STATUSBAR_PNPM = savedCustom;
		if (savedHostEntry === undefined) delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		else process.env.DSH_DESKTOP_PNPM_ENTRY = savedHostEntry;
		rmSync(sandbox, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}

	console.log('\nSELF-UPDATE STATUS CHECKS PASSED');
})().catch((error) => {
	console.error('SELF-UPDATE STATUS CHECKS FAILED:', error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
