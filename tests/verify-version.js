/**
 * 版本自检与 /api/version 路由：宿主启动时问一次 registry 最新版号，
 * 客户端拿它决定导航项后面的「发现新版本」胶囊与设置页那颗「更新」按钮显不显示。
 * 全程打桩 fetch，不联网、不下载包。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

/* 隔离真实家目录：apply 会顺手预热用量台账，别让它扫真实会话、写真实台账 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home');

/**
 * 起一个独立的模块实例：latestVersion 是模块级状态，多个用例要不同的自检结果，
 * 靠 import 的 query 串各拿一份新实例。
 * @param {object} stub 打桩结果：{ fail } 让 fetch 抛错、{ http } 让它回非 2xx、否则回 { version }
 */
async function boot(tag, stub) {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		if (stub.fail === true) throw new Error('network down');
		if (stub.http !== undefined) return { ok: false, status: stub.http, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ version: stub.version }) };
	};

	const mod = await import('file:///' + INDEX.replace(/\\/g, '/') + '?case=' + tag);
	let handler = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (r) => { handler = r.handler; return () => {}; } },
		credentials: undefined
	});
	assert.strictEqual(typeof handler, 'function', 'webServer 路由已注册');

	/** 打一次路由（GET 带 query） */
	async function hit(query) {
		let status = null;
		let body = null;
		const res = { writeHead: (code) => { status = code; }, end: (text) => { body = text; } };
		const req = { url: '/dsh-desktop-statusbar/api/version' + query, method: 'GET', on: () => req, destroy: () => {} };
		let thrown = null;
		await Promise.resolve(handler(req, res)).catch((error) => { thrown = error; });
		return { status, body, thrown };
	}

	return { calls, hit };
}

(async () => {
	/* 1. registry 上有更新：hasUpdate 为真，带上 latest 与 current */
	const a = await boot('a', { version: '9.9.9' });
	const older = await a.hit('?current=2.0.2');
	assert.strictEqual(older.thrown, null, 'version 路由不应抛错');
	assert.strictEqual(older.status, 200, 'version 状态码 200');
	const olderBody = JSON.parse(older.body);
	assert.strictEqual(olderBody.ok, true, '拿到版本号时 ok 为真');
	assert.strictEqual(olderBody.latest, '9.9.9', 'latest 取 registry 的 version');
	assert.strictEqual(olderBody.current, '2.0.2', 'current 原样回显');
	assert.strictEqual(olderBody.hasUpdate, true, '2.0.2 → 9.9.9 有更新');
	assert.ok(typeof olderBody.checkedAt === 'number' && olderBody.checkedAt > 0, '带上自检时间');
	console.log('有更新:', olderBody.current + ' → ' + olderBody.latest + ' hasUpdate=' + String(olderBody.hasUpdate));

	/* 2. 同号、更新号、以及不带 current：都不算有更新 */
	assert.strictEqual(JSON.parse((await a.hit('?current=9.9.9')).body).hasUpdate, false, '同号不算有更新');
	assert.strictEqual(JSON.parse((await a.hit('?current=10.0.0')).body).hasUpdate, false, '本地更新时不算有更新');
	const blank = JSON.parse((await a.hit('')).body);
	assert.strictEqual(blank.hasUpdate, false, '不带 current 时客户端还没报版本，不能算有更新');
	assert.strictEqual(blank.current, '', '不带 current 回显空串');
	console.log('同号 / 更高号 / 缺 current 都不提示更新');

	/* 3. 自检只跑一次：客户端反复问也只联网一次，不重复打 registry */
	assert.strictEqual(a.calls.length, 1, '自检只请求 registry 一次，实际 ' + a.calls.length + ' 次');
	assert.strictEqual(a.calls[0], 'https://registry.npmjs.org/dsh-desktop-statusbar/latest', '只问 latest 条目');
	console.log('registry 请求次数:', a.calls.length);

	/* 4. 版本比较按数字段，不是按字符串：2.10.0 比 2.9.0 新 */
	const b = await boot('b', { version: '2.10.0' });
	assert.strictEqual(JSON.parse((await b.hit('?current=2.9.0')).body).hasUpdate, true, '2.10.0 > 2.9.0（数字段比较）');
	console.log('数字段比较 OK: 2.10.0 > 2.9.0');

	/* 5. 预发布排在同号正式版之前：latest 是 2.1.0-rc.1 时，本地 2.1.0 不算旧 */
	const c = await boot('c', { version: '2.1.0-rc.1' });
	assert.strictEqual(JSON.parse((await c.hit('?current=2.1.0')).body).hasUpdate, false, 'rc 比同号正式版旧');
	assert.strictEqual(JSON.parse((await c.hit('?current=2.0.9')).body).hasUpdate, true, 'rc 仍比 2.0.9 新');
	console.log('预发布比较 OK: 2.0.9 < 2.1.0-rc.1 < 2.1.0');

	/* 6. 查不到就安静地不提示：网络挂了 / registry 回非 2xx，都给结构化失败 */
	const d = await boot('d', { fail: true });
	const offline = JSON.parse((await d.hit('?current=2.0.2')).body);
	assert.strictEqual(offline.ok, false, '联网失败时 ok 为假');
	assert.strictEqual(offline.latest, null, '联网失败时没有版本号');
	assert.strictEqual(offline.hasUpdate, false, '联网失败时不提示更新');
	assert.strictEqual(offline.error, 'fetch-failed', '失败原因给 fetch-failed');
	console.log('离线:', offline.error, 'hasUpdate=' + String(offline.hasUpdate));

	const e = await boot('e', { http: 503 });
	const httpFail = JSON.parse((await e.hit('?current=2.0.2')).body);
	assert.strictEqual(httpFail.ok, false, '非 2xx 时 ok 为假');
	assert.strictEqual(httpFail.error, 'http-503', '非 2xx 带状态码，实际 ' + String(httpFail.error));
	console.log('非 2xx:', httpFail.error);

	/* 两处版本号必须一致：client 的 VERSION 与 package.json 的 version。
	   版本自检拿 client 的 VERSION 跟 npm 上的最新版比 —— 写歪了会永远提示「有新版本」。 */
	const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
	const clientSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
	const clientVersion = (clientSource.match(/const VERSION = "([^"]+)"/) || [])[1];
	assert.strictEqual(clientVersion, pkgVersion,
		'client 的 VERSION 与 package.json 的 version 必须一致（实际 ' + clientVersion + ' / ' + pkgVersion + '）');
	console.log('版本号一致：client VERSION = package.json version =', pkgVersion);

	console.log('\nVERSION SELF-CHECK CHECKS PASSED');
})().catch((error) => {
	console.error('VERSION SELF-CHECK CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
