/**
 * host `/api/holidays` 的入参校验：年份必须是合理的数字。
 * 只测不联网的分支；真抓取 + 解析由 verify-holidays.js（通知原文样本）覆盖。
 * 用法：node verify-holiday-route.js
 */
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* apply() 会预热扫一次台账（读会话日志、必要时落盘）。把 DSH_HOME 指到 tests/ 下的
   隔离目录，别让测试读写这台机器上的真实台账 ~/.dsh/dsh-status-bar/ 。 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home');

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

(async () => {
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	assert.strictEqual(typeof mod.apply, 'function', 'apply exported');

	let handler = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handler = route.handler;
				return () => {};
			}
		},
		credentials: undefined
	});
	assert.ok(handler !== null, 'host 路由已注册');

	const call = (query) => new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/holidays' + query, method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handler(req, res);
	});

	const cases = [['?year=abc', 'abc'], ['', '缺参数'], ['?year=99999', '99999'], ['?year=20.5', '20.5']];
	for (const one of cases) {
		const got = await call(one[0]);
		assert.strictEqual(got.status, 400, one[1] + ' 应被拒绝');
		assert.strictEqual(got.body.ok, false, one[1] + ' 返回 ok:false');
		assert.strictEqual(got.body.reason, 'bad-year', one[1] + ' 返回 bad-year');
		console.log('= ' + one[1] + ' → 400 bad-year');
	}

	console.log('');
	console.log('HOLIDAY ROUTE CHECKS PASSED');
})().catch((error) => {
	console.error('HOLIDAY ROUTE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
