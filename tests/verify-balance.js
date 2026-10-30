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

	/* ===================== 双币种余额（人民币 + 美元共存）
	   用户要求：底栏显示成「¥14.12+$3.17」，两个币种各算各的。
	   这里验两件事：① 官方账号服务那条把分币种收进 `balances`；② **老字段语义一个字不变**。
	   注意：单币种时 `balances` 只能是 `undefined`（不是空数组），否则上层会误判成"查到了但没有余额"。 */
	/* 单币种时给**一项**数组（不是 undefined、也不是空数组）：
	   底栏拿到后会显示成单个「¥2.56」—— 因为 `costByCurrencyText` 对"只有一项"本来就不带 `+`，
	   所以这里不需要在 host 侧特判。唯一必须避免的是**空数组**（那会被当成"查到了但没余额"）。 */
	assert.strictEqual(Array.isArray(got.body.balances), true,
		'单币种也返回 balances 数组（一项），实际 ' + JSON.stringify(got.body.balances));
	assert.strictEqual(got.body.balances.length, 1,
		'单币种 ⇒ balances 只有一项，实际 ' + JSON.stringify(got.body.balances));
	assert.strictEqual(got.body.balances[0].currency, 'CNY', '那一项就是人民币');

	/* 再挂一个带双币种钱包的账号服务，确认 balances 有两项、且 total/currency 仍是老口径那一笔 */
	let handlerDual = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handlerDual = route.handler;
				return () => {};
			}
		},
		credentials: undefined,
		get: (name) => {
			if (name === 'deepseekAccount') {
				return {
					getBalance: async () => ({
						status: 'ready',
						value: [
							{ currency: 'CNY', balance: '14.12' },
							{ currency: 'USD', balance: '3.17' }
						],
						bonusWallets: []
					})
				};
			}
			return undefined;
		}
	});
	assert.ok(handlerDual !== null, '双币种场景的 host 路由已注册');
	const dual = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handlerDual(req, res);
	});
	assert.strictEqual(dual.body.ok, true, '双币种账户仍可用');
	assert.strictEqual(Array.isArray(dual.body.balances), true,
		'人民币 + 美元共存 ⇒ 返回 balances 数组，实际 ' + JSON.stringify(dual.body.balances));
	assert.strictEqual(dual.body.balances.length, 2, 'balances 有两项，实际 ' + JSON.stringify(dual.body.balances));
	const byCode = {};
	dual.body.balances.forEach((one) => { byCode[one.currency] = one.total; });
	assert.strictEqual(byCode.CNY, '14.12', '人民币那一笔');
	assert.strictEqual(byCode.USD, '3.17', '美元那一笔');
	/* 老字段口径不变：currency 仍是主币种、total 仍是「主钱包 + 赠金」那个合计 */
	assert.strictEqual(dual.body.currency, 'CNY', '老字段 currency 不受影响（仍是主币种）');
	assert.strictEqual(dual.body.total, '14.12', '老字段 total 不受影响（主钱包 14.12 + 无赠金）');
	assert.strictEqual(dual.body.toppedUp, '14.12', '老字段 toppedUp 不受影响');
	/* task-66：每笔都要带**自己的** toppedUp / granted，客户端才能折汇率后相加算色条比例。
	   这个夹具的 bonusWallets 是空的 ⇒ 两笔的 granted 都应是 '0.00'（不是 undefined）。 */
	dual.body.balances.forEach((one) => {
		assert.strictEqual(typeof one.toppedUp, 'string',
			one.currency + ' 那笔必须有 toppedUp 字符串，实际 ' + JSON.stringify(one));
		assert.strictEqual(typeof one.granted, 'string',
			one.currency + ' 那笔必须有 granted 字符串，实际 ' + JSON.stringify(one));
		assert.notStrictEqual(one.toppedUp, undefined, one.currency + ' 的 toppedUp 不许是 undefined');
		assert.notStrictEqual(one.granted, undefined, one.currency + ' 的 granted 不许是 undefined');
	});
	const cnyItem = dual.body.balances.filter((one) => one.currency === 'CNY')[0];
	const usdItem = dual.body.balances.filter((one) => one.currency === 'USD')[0];
	assert.strictEqual(cnyItem.toppedUp, '14.12', 'CNY 那笔 toppedUp = 14.12，实际 ' + cnyItem.toppedUp);
	assert.strictEqual(cnyItem.granted, '0.00', 'CNY 那笔无赠金 ⇒ granted = 0.00');
	assert.strictEqual(usdItem.toppedUp, '3.17', 'USD 那笔 toppedUp = 3.17，实际 ' + usdItem.toppedUp);
	assert.strictEqual(usdItem.granted, '0.00', 'USD 那笔无赠金 ⇒ granted = 0.00');
	console.log('= 双币种：balances = CNY ' + byCode.CNY + ' + USD ' + byCode.USD
		+ '（老字段 total/currency/toppedUp 不变；每笔带 toppedUp/granted）');

	/* task-66 专项：wallet 与 bonusWallet **按币种分别累计**，
	   这样才能算出「充值 : 赠金」的真实比例（不是把赠金混进充值里）。
	   夹具：CNY 充值 10、赠金 2.5；USD 充值 4、赠金 1。 */
	let handlerSplit = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handlerSplit = route.handler;
				return () => {};
			}
		},
		credentials: undefined,
		get: (name) => {
			if (name === 'deepseekAccount') {
				return {
					getBalance: async () => ({
						status: 'ready',
						value: [{ currency: 'CNY', balance: '10' }, { currency: 'USD', balance: '4' }],
						bonusWallets: [{ currency: 'CNY', balance: '2.5' }, { currency: 'USD', balance: '1' }]
					})
				};
			}
			return undefined;
		}
	});
	const split = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handlerSplit(req, res);
	});
	const splitCny = split.body.balances.filter((one) => one.currency === 'CNY')[0];
	const splitUsd = split.body.balances.filter((one) => one.currency === 'USD')[0];
	assert.strictEqual(splitCny.toppedUp, '10.00', 'CNY 充值 10 ⇒ toppedUp=10.00，实际 ' + splitCny.toppedUp);
	assert.strictEqual(splitCny.granted, '2.50', 'CNY 赠金 2.5 ⇒ granted=2.50，实际 ' + splitCny.granted);
	assert.strictEqual(splitCny.total, '12.5', 'CNY total = 充值 + 赠金 = 12.5，实际 ' + splitCny.total);
	assert.strictEqual(splitUsd.toppedUp, '4.00', 'USD 充值 4 ⇒ toppedUp=4.00，实际 ' + splitUsd.toppedUp);
	assert.strictEqual(splitUsd.granted, '1.00', 'USD 赠金 1 ⇒ granted=1.00，实际 ' + splitUsd.granted);
	assert.strictEqual(splitUsd.total, '5', 'USD total = 充值 + 赠金 = 5，实际 ' + splitUsd.total);
	console.log('= 充值/赠金按币种分开累计：CNY 10/2.5 · USD 4/1（色条比例可折汇率后相加）');

	/* 只有美元 ⇒ balances 只有一项，且**不含 CNY 键**（0 与负数都不进） */
	let handlerUsd = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handlerUsd = route.handler;
				return () => {};
			}
		},
		credentials: undefined,
		get: (name) => {
			if (name === 'deepseekAccount') {
				return {
					getBalance: async () => ({
						status: 'ready',
						/* 第二笔余额是 0：**不该进 balances** */
						value: [{ currency: 'USD', balance: '3.17' }, { currency: 'CNY', balance: '0' }],
						bonusWallets: []
					})
				};
			}
			return undefined;
		}
	});
	const usdOnly = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handlerUsd(req, res);
	});
	assert.strictEqual(Array.isArray(usdOnly.body.balances), true, '只有美元 ⇒ balances 仍要给数组');
	assert.strictEqual(usdOnly.body.balances.length, 1,
		'余额为 0 的币种不进 balances，实际 ' + JSON.stringify(usdOnly.body.balances));
	assert.strictEqual(usdOnly.body.balances[0].currency, 'USD', '只留下美元那一笔');
	/* task-66：wallet 只有 balance 没有赠金 ⇒ granted 必须是 '0.00' 而不是 undefined */
	assert.strictEqual(usdOnly.body.balances[0].granted, '0.00',
		'没有 bonusWallet ⇒ granted 给 0.00（不是 undefined），实际 ' + String(usdOnly.body.balances[0].granted));
	assert.strictEqual(typeof usdOnly.body.balances[0].toppedUp, 'string',
		'toppedUp 也必须是字符串，实际 ' + String(usdOnly.body.balances[0].toppedUp));
	console.log('= 只有美元：balances 只一项（0 那笔被过滤），且 toppedUp/granted 齐全');

	/* task-66：**API key 那条路由**（`/api/user/balance`）的 `balances` 也要带 toppedUp/granted。
	   上面几条走的都是账号服务那条路，这条走的是另一条实现（`:1928` 那个 IIFE），必须单独覆盖。
	   夹具故意**让美元那笔缺 `granted_balance`、人民币那笔缺 `topped_up_balance`**：
	   两个字段都必须兜底成 '0.00'，不许是 undefined（客户端会直接参与数值计算）。 */
	let handlerKey = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handlerKey = route.handler;
				return () => {};
			}
		},
		credentials: { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test-key-0123456789', source: 'env' } : null) },
		get: (name) => {
			/* 凭据服务通过 ctx.get('credentials') 取（resolveAdapterKey 就是这么找的）；
			   不挂它的话会退回环境变量/文件，而那些在测试机上是空的 ⇒ no-credential。 */
			if (name === 'credentials') return { resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test-key-0123456789', source: 'env' } : null) };
			return undefined;
		}
	});
	const realFetchForKey = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({
			is_available: true,
			balance_infos: [
				/* CNY：有 total 与赠金，**缺 topped_up_balance** */
				{ currency: 'CNY', total_balance: '13.14', granted_balance: '1.00' },
				/* USD：有 total 与充值，**缺 granted_balance** */
				{ currency: 'USD', total_balance: '5.21', topped_up_balance: '5.21' }
			]
		})
	});
	const keyRun = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance?provider=deepseek-official', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handlerKey(req, res);
	});
	globalThis.fetch = realFetchForKey;
	assert.strictEqual(Array.isArray(keyRun.body.balances), true,
		'API key 那条也要给 balances 数组，实际 ' + JSON.stringify(keyRun.body.balances));
	assert.strictEqual(keyRun.body.balances.length, 2, '两笔都在，实际 ' + JSON.stringify(keyRun.body.balances));
	const keyCny = keyRun.body.balances.filter((one) => one.currency === 'CNY')[0];
	const keyUsd = keyRun.body.balances.filter((one) => one.currency === 'USD')[0];
	assert.strictEqual(keyCny.toppedUp, '0.00',
		'CNY 缺 topped_up_balance ⇒ 兜底 0.00（不是 undefined），实际 ' + String(keyCny.toppedUp));
	assert.strictEqual(keyCny.granted, '1.00', 'CNY 赠金 1 ⇒ granted=1.00，实际 ' + keyCny.granted);
	assert.strictEqual(keyUsd.toppedUp, '5.21', 'USD 充值 5.21 ⇒ toppedUp=5.21，实际 ' + keyUsd.toppedUp);
	assert.strictEqual(keyUsd.granted, '0.00',
		'USD 缺 granted_balance ⇒ 兜底 0.00（不是 undefined），实际 ' + String(keyUsd.granted));
	console.log('= API key 那条：balances 每笔带 toppedUp/granted，缺字段兜底 0.00（13.14/1.00 · 5.21/0.00）');


	const adapterMod = await import('file:///' + path.join(__dirname, '..', 'lib', 'balance-api.js').split(path.sep).join('/'));
	const deepseek = adapterMod.adapters.filter((one) => one.id === 'deepseek')[0];
	assert.ok(deepseek !== undefined && typeof deepseek.parse === 'function', '找得到 deepseek 适配器');
	const parsedDual = deepseek.parse({
		balance_infos: [
			{ currency: 'CNY', total_balance: '14.12', topped_up_balance: '14.12', granted_balance: '0.00' },
			{ currency: 'USD', total_balance: '3.17', topped_up_balance: '3.17', granted_balance: '0.00' }
		]
	});
	assert.strictEqual(Array.isArray(parsedDual.balances), true,
		'适配器 parse 要给出 balances（否则底栏拿不到第二笔）');
	assert.strictEqual(parsedDual.balances.length, 2, '两笔都收进来，实际 ' + JSON.stringify(parsedDual.balances));
	assert.strictEqual(parsedDual.balances[0].currency, 'CNY', '按原顺序：第一笔人民币');
	assert.strictEqual(parsedDual.balances[1].currency, 'USD', '第二笔美元');
	assert.strictEqual(parsedDual.balances[1].total, '3.17', '美元那笔的原始字符串');
	/* 老字段（取第一笔）语义一个字不变 */
	assert.strictEqual(parsedDual.currency, 'CNY', '老字段 currency 仍是第一笔');
	assert.strictEqual(parsedDual.total, '14.12', '老字段 total 仍是第一笔（老调用方靠它）');
	const parsedZero = deepseek.parse({
		balance_infos: [
			{ currency: 'CNY', total_balance: '0', topped_up_balance: '0', granted_balance: '0' },
			{ currency: 'USD', total_balance: '3.17', topped_up_balance: '3.17', granted_balance: '0' }
		]
	});
	assert.strictEqual(parsedZero.balances.length, 1, '余额为 0 的币种被过滤掉，实际 ' + JSON.stringify(parsedZero.balances));
	assert.strictEqual(parsedZero.balances[0].currency, 'USD', '只留美元');
	const parsedSingle = deepseek.parse({
		balance_infos: [{ currency: 'CNY', total_balance: '14.12', topped_up_balance: '14.12', granted_balance: '0' }]
	});
	assert.strictEqual(Array.isArray(parsedSingle.balances), true,
		'单币种 ⇒ balances 给一项数组（显示层对"只有一项"不加 +，所以不需要特判）');
	assert.strictEqual(parsedSingle.balances.length, 1, '只有一项');
	assert.strictEqual(parsedSingle.balances[0].currency, 'CNY', '那一项是人民币');
	console.log('= 适配器 parse：两笔都收 / 0 过滤 / 单币种给 undefined，老字段不变');

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
	/* 候选顺序：**新插件在前**（当前生效的是 dsh-connect-workbuddy），老插件在后。
	   mock 对任意 URL 都返回成功，所以命中的是第一条；老插件那条只有在第一条
	   裸 404（未注册）时才会被试到 —— 见下面"回退"那一组用例。 */
	assert.strictEqual(asked[0], 'http://127.0.0.1:19387/plugins/dsh-connect-workbuddy/usage?region=global',
		'打的是本机积分路由（新插件 /usage），不是 api.deepseek.com（旧写法就是在这里 401 的）');
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
	assert.strictEqual(asked2[0], 'http://127.0.0.1:19400/plugins/dsh-connect-workbuddy/usage?region=global',
		'用的是 ctx.webServer 上的端口（路径同样是新插件那条）');
	console.log('= 端口来源兼容：ctx.webServer 直接挂服务时也能查到积分');

	/* 回退：新插件那条**裸 404**（路由未注册）⇒ 要接着试老插件那条，而不是直接失败。
	   这正是本机当前的过渡形态（两个插件都装着，只有一个在跑）。 */
	let handler3 = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			port: 19500,
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handler3 = route.handler;
				return () => {};
			}
		},
		credentials: undefined
	});
	const asked3 = [];
	globalThis.fetch = async (url) => {
		asked3.push(String(url));
		if (String(url).indexOf('/plugins/dsh-connect-workbuddy/') >= 0) {
			/* 宿主的"这条路由没注册"兜底：裸 404、无 Content-Type、空体 */
			return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
		}
		return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ status: 'signed-in', credits: { total: 66 } }) };
	};
	const fallback = await new Promise((resolve) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance?provider=workbuddy-ai&model=x', method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		handler3(req, res);
	});
	globalThis.fetch = realFetch;
	assert.strictEqual(fallback.body.total, '66', '新插件裸 404 时回退到老插件，取到积分');
	assert.strictEqual(asked3.length, 2, '试了两条（先新后老）');
	assert.strictEqual(asked3[0], 'http://127.0.0.1:19500/plugins/dsh-connect-workbuddy/usage?region=global', '第一条是新插件');
	assert.strictEqual(asked3[1], 'http://127.0.0.1:19500/plugins/dsh-workbuddy-connect/ai/status', '第二条回退到老插件');
	console.log('= 新插件未注册（裸 404）⇒ 自动回退老插件：两条候选，先新后老');

	/* ---------------------- 智谱两条路：并发发起 + 固定优先级（配额优先）+ 定案后掐断 */
	/* 智谱的「现金余额」与「coding plan 配额」是两条互斥的路（同一账号只可能有一条
	   能解析出结果）。用户拍板的规则是**固定优先级**：「有 Coding Plan 的人肯定会先用
	   Coding Plan，而用按量计费的人一般是没有 Coding Plan 的」—— 所以配额能解析就用配额，
	   不管谁先返回。两条仍然并发发出（配额这条慢时不必白等）。
	   这里锁四件事：
	   ① 两条都成功、**现金余额先返回**时，结论必须是配额（口径一致，不看先后）；
	   ② 配额解析不出（no-balance-info）时才用现金余额；
	   ③ 定案后另一条的请求要**被掐断**（signal.aborted 变 true），不留悬挂连接；
	   ④ 两条都不通时，报**链序第一个**的原因。 */
	let handler4 = null;
	const KEY = 'zhipu-test-key-0123456789';
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: {
			register: (route) => {
				if (route.path === '/dsh-desktop-statusbar/api') handler4 = route.handler;
				return () => {};
			}
		},
		get: (name) => {
			if (name === 'webServer') return { port: 19600 };
			if (name === 'credentials') {
				/* 两条路声明的 refs 不完全一样（zhipu 有 ZAI_API_KEY，zhipu-quota 没有），
				   各自都要能取到同一个 key，否则链尾会因为 no-credential 根本不发请求 */
				return {
					resolve: async (ref) => (ref === 'ZAI_API_KEY' || ref === 'ZHIPU_API_KEY'
						? { value: KEY, source: 'env' }
						: null)
				};
			}
			return undefined;
		}
	});
	assert.ok(handler4 !== null, 'host 路由已注册（智谱用例）');
	const call4 = (query) => new Promise((resolve, reject) => {
		const req = { url: '/dsh-desktop-statusbar/api/balance' + query, method: 'GET' };
		const res = {
			writeHead: (status) => { res.status = status; },
			end: (text) => { resolve({ status: res.status, body: JSON.parse(text) }); }
		};
		try {
			handler4(req, res);
		} catch (error) {
			reject(error);
		}
	});

	const BALANCE_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report';
	const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
	const QUOTA_BODY = { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 62.5 }] } };
	const BALANCE_BODY = { code: 200, data: { availableBalance: 12.34, rechargeAmount: 10, giveAmount: 2.34 } };
	const jsonOk = (body) => ({ ok: true, json: async () => body });

	/* 用例一（口径一致）：**两条都成功，且现金余额先返回**，配额 20ms 后才回来 ——
	   按固定优先级必须用配额。这条锁的正是"同一账号每轮口径一致"，不是谁先到谁赢。 */
	const callsOne = [];
	const signalsOne = [];
	globalThis.fetch = (url, options) => {
		const target = String(url);
		callsOne.push(target);
		signalsOne.push(options === undefined ? null : options.signal);
		if (target === QUOTA_URL) {
			return new Promise((resolve) => setTimeout(() => resolve(jsonOk(QUOTA_BODY)), 20));
		}
		/* 链首：立刻成功，比配额早 20ms 落地 */
		return Promise.resolve(jsonOk(BALANCE_BODY));
	};
	const priority = await call4('?provider=zhipu&model=glm-5.3');
	globalThis.fetch = realFetch;
	assert.strictEqual(callsOne.length, 2,
		'两条路都发起（实际 ' + callsOne.length + ' 次：' + callsOne.join(' , ') + '）');
	assert.strictEqual(callsOne[0], BALANCE_URL, '先发起的是链首 zhipu（现金余额）');
	assert.strictEqual(callsOne[1], QUOTA_URL, '并发发起链尾 zhipu-quota（coding plan 配额）');
	assert.ok(signalsOne.every((one) => one !== null && one !== undefined),
		'两条请求都带上了 abort 信号（否则定案后掐不断在飞的那条）');
	assert.strictEqual(priority.status, 200, '智谱查询 HTTP 200');
	assert.strictEqual(priority.body.ok, true, '两条都成功时可用');
	assert.strictEqual(priority.body.provider, 'zhipu-quota',
		'现金余额先返回、且也成功，仍必须用配额（固定优先级，不看先后）');
	assert.strictEqual(priority.body.isPercent, true, '按百分比显示');
	assert.strictEqual(priority.body.total, '62.50%', '配额使用率 62.5%（不是现金余额 12.34）');
	console.log('= 配额优先：现金余额先返回且成功，仍用配额 ' + priority.body.total);

	/* 用例二（回退）：配额返回结构不是这一路（parse 给 null ⇒ no-balance-info）时，
	   才用现金余额。两个平台账号互斥，这正是按量计费账号的正常路径。 */
	globalThis.fetch = (url) => {
		if (String(url) === QUOTA_URL) {
			/* 真实上游对按量计费账号的应答：没有 limits，parse 解析不出 */
			return Promise.resolve(jsonOk({ success: true, data: { level: 'free' } }));
		}
		return Promise.resolve(jsonOk(BALANCE_BODY));
	};
	const fallbackToCash = await call4('?provider=zhipu&model=glm-5.3');
	globalThis.fetch = realFetch;
	assert.strictEqual(fallbackToCash.body.ok, true, '配额解析不出时回退到现金余额，可用');
	assert.strictEqual(fallbackToCash.body.provider, 'zhipu', '结论来自链首（现金余额）');
	assert.strictEqual(fallbackToCash.body.total, '12.34', '现金余额 12.34');
	assert.strictEqual(fallbackToCash.body.isPercent, false, '不是配额口径（isPercent 恒为布尔，这里必须是 false）');
	console.log('= 配额解析不出（no-balance-info）⇒ 才用现金余额 ' + fallbackToCash.body.total);

	/* 用例三（定案后掐断）：链首的 fetch **永不 resolve**（模拟慢端口），配额立刻成功 ——
	   实现正确时响应必须照样返回配额结果，并且链首那条请求要被 abort（signal.aborted），
	   不能留到 60 秒超时才释放。 */
	const abortProbe = [];
	globalThis.fetch = (url, options) => {
		const target = String(url);
		const signal = options === undefined ? undefined : options.signal;
		/* 模拟真实 fetch 的行为：signal 一旦 abort，这个请求就以 AbortError 结束 */
		const aborted = new Promise((resolve, reject) => {
			if (signal !== undefined && signal !== null) {
				signal.addEventListener('abort', () => {
					const error = new Error('The operation was aborted');
					error.name = 'AbortError';
					reject(error);
				}, { once: true });
			}
		});
		if (target === QUOTA_URL) return Promise.resolve(jsonOk(QUOTA_BODY));
		abortProbe.push({ url: target, signal: signal });
		return aborted; /* 链首：只有被 abort 才会结束 */
	};
	const raced = await Promise.race([
		call4('?provider=zhipu&model=glm-5.3'),
		new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000))
	]);
	/* abort 是异步传播的，给事件循环一拍 */
	await new Promise((resolve) => setTimeout(resolve, 10));
	globalThis.fetch = realFetch;
	assert.strictEqual(raced.timeout, undefined,
		'配额成功时必须立刻定案，不能卡在永不返回的链首上等它');
	assert.strictEqual(raced.body.ok, true, '定案后可用');
	assert.strictEqual(raced.body.provider, 'zhipu-quota', '用的是配额那条');
	assert.strictEqual(abortProbe.length, 1, '链首请求确实发出过（模拟"另一条在飞"）');
	assert.ok(abortProbe[0].signal !== undefined && abortProbe[0].signal !== null, '链首请求带上了 abort 信号');
	assert.strictEqual(abortProbe[0].signal.aborted, true,
		'定案后另一条在飞请求必须被 abort（否则要挂到 60 秒超时才释放）');
	console.log('= 定案后掐断另一条：链首请求 signal.aborted = true');

	/* 用例四：两条都失败 → 报**链序第一个**的原因（诊断文案与串行时一致）。 */
	const failCalls = [];
	globalThis.fetch = (url) => {
		failCalls.push(String(url));
		if (String(url) === QUOTA_URL) {
			/* 链尾先回来，且失败：它不配当结论 */
			return Promise.resolve({ ok: false, status: 502, json: async () => null });
		}
		/* 链首慢一拍再回来：HTTP 500 是环境类失败，要原样报出 */
		return new Promise((resolve) => {
			setTimeout(() => resolve({ ok: false, status: 500, json: async () => null }), 20);
		});
	};
	const allFailed = await call4('?provider=zhipu&model=glm-5.3');
	globalThis.fetch = realFetch;
	assert.strictEqual(failCalls.length, 2, '失败时两条路也都发起了（实际 ' + failCalls.length + ' 次）');
	assert.strictEqual(allFailed.body.ok, false, '两条都不通时 ok=false');
	assert.strictEqual(allFailed.body.reason, 'http-500', '报链序第一个 zhipu 的原因，不是先回来的链尾 http-502');
	assert.strictEqual(allFailed.body.provider, 'zhipu', '失败态也标明是链首那条适配器');
	console.log('= 智谱两条路全失败：报链序第一个 http-500（链尾 http-502 先回来也不抢结论）');

	console.log('');
	console.log('BALANCE ROUTE CHECKS PASSED');
})().catch((error) => {
	console.error('BALANCE ROUTE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
