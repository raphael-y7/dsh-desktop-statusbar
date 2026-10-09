/**
 * 校验 host 的 HTTP 路由：价格 / 余额 / 当前模型上报都要正常应答。
 * 回归护栏：曾经因为把 prices 分支插到 `const url = ...` 之前，
 * handler 抛 ReferenceError，把余额接口一起打挂（前端只剩一个横杠）。
 */
const path = require('path');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'index.js');

/* 台账 v3 起 POST /api/prices 会读台账并落盘（结算欠账）。这里必须把 DSH_HOME 指到
   tests/ 下的隔离目录，否则测试会改写这台机器上的真实台账 ~/.dsh/dsh-status-bar/ 。 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home');

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

(async () => {
	const mod = await import('file:///' + PLUGIN.replace(/\\/g, '/'));
	const routes = [];
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (r) => { routes.push(r); return () => {}; } },
		credentials: undefined
	});
	assert.strictEqual(routes.length, 1, 'one route prefix registered');
	const handler = routes[0].handler;
	console.log('路由前缀:', routes[0].path);

	/** 打一次路由；options.body 会以 data 事件补上（POST 用） */
	async function hit(pathname, options) {
		const opts = options === undefined ? {} : options;
		let status = null;
		let body = null;
		const res = {
			writeHead: (code) => { status = code; },
			end: (text) => { body = text; }
		};
		const listeners = {};
		const req = {
			url: pathname,
			method: opts.method === undefined ? 'GET' : opts.method,
			on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
			destroy: () => {}
		};
		let thrown = null;
		const pending = Promise.resolve(handler(req, res)).catch((error) => { thrown = error; });
		if (opts.body !== undefined) (listeners.data || []).forEach((fn) => fn(opts.body));
		(listeners.end || []).forEach((fn) => fn());
		await pending;
		return { status, body, thrown };
	}

	/* 1. 价格接口 */
	const prices = await hit('/dsh-desktop-statusbar/api/prices');
	assert.strictEqual(prices.thrown, null, 'prices route must not throw: ' + (prices.thrown === null ? '' : prices.thrown.message));
	assert.strictEqual(prices.status, 200, 'prices status 200');
	const parsed = JSON.parse(prices.body);
	assert.strictEqual(parsed.models['deepseek-flash'].peak.output, 8, 'flash peak output price');
	assert.strictEqual(parsed.models['deepseek-v4-pro'].offPeak.input, 4.5, 'v4-pro off-peak input price');
	console.log('价格接口 OK:', Object.keys(parsed.models).join(', '));

	/* 2. 余额接口：没有可用 key 时应返回结构化失败，而不是抛错 */
	const balance = await hit('/dsh-desktop-statusbar/api/balance');
	assert.strictEqual(balance.thrown, null, 'balance route must not throw: ' + (balance.thrown === null ? '' : balance.thrown.message));
	assert.ok(balance.status === 200 || balance.status === 404, 'balance status is structured: ' + balance.status);
	const bal = JSON.parse(balance.body);
	console.log('余额接口 OK: status=' + balance.status + ' ok=' + String(bal.ok) + (bal.total === undefined ? '' : ' total=' + String(bal.total)));
	assert.ok(typeof bal.ok === 'boolean', 'balance payload has ok flag');

	/* 3. 当前模型接口：初始为空，POST 之后能读回 */
	const empty = await hit('/dsh-desktop-statusbar/api/active-model');
	assert.strictEqual(empty.thrown, null, 'active-model GET must not throw');
	assert.strictEqual(empty.status, 200, 'active-model GET status 200');
	assert.strictEqual(JSON.parse(empty.body).model, null, '初始没有模型');

	const post = await hit('/dsh-desktop-statusbar/api/active-model', {
		method: 'POST',
		body: JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-flash' })
	});
	assert.strictEqual(post.thrown, null, 'active-model POST must not throw');
	assert.strictEqual(post.status, 200, 'active-model POST status 200');

	const after = JSON.parse((await hit('/dsh-desktop-statusbar/api/active-model')).body);
	assert.strictEqual(after.model, 'deepseek-flash', '上报后应读回模型');
	assert.strictEqual(after.provider, 'deepseek-official', 'provider 也应读回');
	assert.ok(typeof after.at === 'number' && after.at > 0, '带上报时间');
	console.log('当前模型接口 OK:', after.provider + ' / ' + after.model);

	/* 4. 空模型名应被拒绝 */
	const bad = await hit('/dsh-desktop-statusbar/api/active-model', { method: 'POST', body: JSON.stringify({ model: '   ' }) });
	assert.strictEqual(bad.thrown, null, '空模型名不应抛错');
	assert.strictEqual(bad.status, 400, '空模型名返回 400');
	assert.strictEqual(JSON.parse((await hit('/dsh-desktop-statusbar/api/active-model')).body).model, 'deepseek-flash', '非法上报不应覆盖原值');
	console.log('空模型名被拒绝且不覆盖原值');

	/* 5. 未知路径仍是 404 */
	const other = await hit('/dsh-desktop-statusbar/api/nope');
	assert.strictEqual(other.status, 404, 'unknown path 404');
	assert.strictEqual(other.thrown, null, 'unknown path must not throw');
	console.log('未知路径 404 OK');

	/* 6. 价格库上报：活跃总览的 cost 由 host 记账时算，必须用客户端那份价格库。
	   实测 2026-10-07：用户在设置页加了 Deepseek-V4.1-Flash，底栏能算、活跃总览恒为 0 ——
	   就是因为 host 只认自己那张硬编码表。这里锁住「上报后 host 用客户端价格」。 */
	const posted = await hit('/dsh-desktop-statusbar/api/prices', {
		method: 'POST',
		body: JSON.stringify({
			models: {
				'Deepseek-V4.1-Flash': {
					peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
					offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 2 }
				}
			}
		})
	});
	assert.strictEqual(posted.thrown, null, 'prices POST must not throw: ' + (posted.thrown === null ? '' : posted.thrown.message));
	assert.strictEqual(posted.status, 200, 'prices POST status 200');
	assert.strictEqual(JSON.parse(posted.body).ok, true, 'prices POST 成功');
	console.log('价格库上报 OK:', JSON.parse(posted.body).count + ' 条，changed=' + JSON.parse(posted.body).changed);

	/* 7. 非法价格库应被拒且不污染已有价格 */
	const badPrices = await hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', body: JSON.stringify({ models: {} }) });
	assert.strictEqual(badPrices.status, 400, '空价格库返回 400');
	assert.strictEqual(JSON.parse(badPrices.body).reason, 'bad-models', '给出原因');
	console.log('空价格库被拒 OK');

	/* 8. GET 仍返回官方参考价（客户端价格库为空时拿它自愈），不受 POST 影响 */
	const refAgain = JSON.parse((await hit('/dsh-desktop-statusbar/api/prices')).body);
	assert.strictEqual(refAgain.models['deepseek-flash'].peak.output, 8, 'GET 始终是官方参考价');
	assert.strictEqual(refAgain.models['Deepseek-V4.1-Flash'], undefined, 'GET 不混入用户价格库');
	console.log('GET 参考价与用户价格库分离 OK');

	console.log('\nHOST ROUTE CHECKS PASSED');
})().catch((error) => {
	console.error('HOST ROUTE CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
