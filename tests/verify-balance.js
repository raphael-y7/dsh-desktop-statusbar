/**
 * 余额路由：优先用官方账号服务（设置页「账号与余额」同源），合计 = 充值 + 赠金。
 * 用法：node verify-balance.js
 */
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

/* 隔离真实家目录：否则会读到本机 ~/.dsh/.credentials.yaml，余额来源就会跟着环境变 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home');

(async () => {
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	assert.strictEqual(typeof mod.apply, 'function', 'apply exported');

	let handler = null;
	const seen = [];
	const account = {
		getBalance: async (client) => {
			seen.push(client);
			return {
				status: 'ready',
				value: [{ currency: 'CNY', balance: '2.3866190000000000' }],
				bonusWallets: [{ currency: 'CNY', balance: '0.17' }]
			};
		}
	};
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
		credentials: undefined,
		/* 真实宿主上 ctx.webServer 与 ctx.get('webServer') 是同一个对象（inject 里声明过）；
		   这里让 ctx.webServer 不带端口、get 带端口，确认代码会挑带端口的那个 */
		get: (name) => {
			if (name === 'deepseekAccount') return account;
			if (name === 'webServer') return { port: 19387 };
			return undefined;
		}
	});
	assert.ok(handler !== null, 'host 路由已注册');

	const call = (query) => new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance' + query, method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handler(req, res);
	});

	const got = await call('');
	assert.strictEqual(got.status, 200, 'HTTP 200');
	assert.strictEqual(got.body.ok, true, '余额可用');
	assert.strictEqual(got.body.source, 'account-service', '走官方账号服务（设置页同源）');
	assert.strictEqual(got.body.total, '2.55', '合计 2.386619 + 0.17 = 2.556619 向下截断到分（四舍五入会得到 2.56）');
	assert.strictEqual(got.body.toppedUp, '2.38', '充值余额 2.386619 同样截断');
	assert.strictEqual(got.body.granted, '0.17', '赠金余额');
	assert.strictEqual(got.body.subCent, false, '不是不足一分钱的情形');
	assert.ok(typeof got.body.probe === 'string' && got.body.probe.length > 0, '带上诊断字段: ' + got.body.probe);
	assert.strictEqual(seen.length, 1, '只调了一次官方服务');
	assert.strictEqual(seen[0].timezoneOffsetSeconds, 8 * 3600, '带上客户端元数据');
	console.log('= /api/balance 走官方账号服务：2.386619 + 0.17 → ' + got.body.total + '（截断，不是四舍五入）');

	/* 客户端点开余额气泡时会带 force=1 再查一次：host 端本来就不缓存（BALANCE_TTL_MS = 0），
	   这条路径同样得走得通 —— 参数只是把"跳过缓存"写明，不能因为多这个参数就出错。 */
	const forced = await call('?force=1');
	assert.strictEqual(forced.status, 200, 'force=1 仍然 HTTP 200');
	assert.strictEqual(forced.body.ok, true, 'force=1 同样拿得到余额');
	assert.strictEqual(forced.body.total, got.body.total, '强制刷新与轮询取的是同一口径');
	assert.strictEqual(seen.length, 2, 'force 请求照样落到官方账号服务');
	console.log('= /api/balance?force=1 与不带参数同路：' + forced.body.total);

	/* 回退路径（account 抛错 → API key 查询）不在这里测：那会真的打 DeepSeek 接口，
	   测试要保持离线；容错由 queryAccountBalance 里的 try/catch 保证。 */

	/* --------------------------------------------- WorkBuddy 积分：走本机路由 */
	/* 实测 2026-10-07 的根因回归：WorkBuddy AI 会话跑 deepseek-v4.1-flash-sg 时，
	   旧写法按模型名里的 "deepseek" 认成 DeepSeek 平台，拿 DeepSeek 的 key 去问官方接口，
	   稳定 401、底栏余额永远是横杠。这条断言锁住「以 provider 为准 + 读本机积分路由」。 */
	const asked = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		asked.push(String(url));
		return {
			ok: true,
			json: async () => ({
				status: 'signed-in',
				credits: { total: 177, accounts: [{ packageName: 'Bonus Pack', remain: 30, size: 30 }] }
			})
		};
	};
	const wb = await call('?provider=workbuddy-ai&model=deepseek-v4.1-flash-sg');
	globalThis.fetch = realFetch;
	assert.strictEqual(wb.status, 200, 'WorkBuddy 余额 HTTP 200');
	assert.strictEqual(wb.body.ok, true, 'WorkBuddy 积分可取');
	assert.strictEqual(wb.body.total, '177', '取到积分总数 177');
	assert.strictEqual(wb.body.isCredits, true, '标记积分口径');
	assert.strictEqual(wb.body.currency, '', '积分不是货币，currency 留空');
	assert.strictEqual(asked.length, 1, '只发一次请求');
	assert.strictEqual(asked[0], 'http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status',
		'打的是本机积分路由，不是 api.deepseek.com（旧写法就是在这里 401 的）');
	console.log('= WorkBuddy 会话（模型名含 deepseek）走本机积分路由 → ' + wb.body.total + '，不再误判成 DeepSeek');

	/* 未登录时本机路由给 signed-out：要如实降级，不能拿别的数字顶上 */
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'signed-out' }) });
	const out = await call('?provider=workbuddy&model=glm-5.3');
	globalThis.fetch = realFetch;
	assert.strictEqual(out.body.ok, false, '未登录时 ok=false');
	assert.strictEqual(out.body.isCredits, true, '失败态也带积分标记（客户端据此不显示 ¥）');
	console.log('= WorkBuddy 未登录：如实降级为不可用，且仍按积分口径显示（不给 ¥）');

	/* 端口另一条来源：宿主直接把 webServer 挂在 ctx 上（inject 声明过），
	   此时 ctx.get('webServer') 取不到也要能拿到端口 */
	let handler2 = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			port: 19400,
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handler2 = route.handler;
				return () => {};
			}
		},
		get: () => undefined
	});
	const asked2 = [];
	globalThis.fetch = async (url) => {
		asked2.push(String(url));
		return { ok: true, json: async () => ({ status: 'signed-in', credits: { total: 88 } }) };
	};
	const second = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance?provider=workbuddy-ai&model=x', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handler2(req, res);
	});
	globalThis.fetch = realFetch;
	assert.strictEqual(second.body.total, '88', 'ctx.webServer 直接挂端口时同样取得到积分');
	assert.strictEqual(asked2[0], 'http://127.0.0.1:19400/plugins/dsh-workbuddy-connect/ai/status',
		'用的是 ctx.webServer 上的端口');
	console.log('= 端口来源兼容：ctx.webServer 直接挂服务时也能查到积分');

	console.log('');
	console.log('BALANCE ROUTE CHECKS PASSED');
})().catch((error) => {
	console.error('BALANCE ROUTE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
