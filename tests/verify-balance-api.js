/* balance-api.js：多平台余额适配器（纯逻辑，不发网络请求）。
   覆盖 provider 识别、请求构造（含智谱「裸 key 不带 Bearer」这个实测坑）、各平台响应解析与异常输入。 */
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
	const m = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'balance-api.js')).href);
	const ids = m.adapters.map((one) => one.id);
	assert.deepStrictEqual(ids, ['deepseek', 'openrouter', 'bai', 'siliconflow', 'moonshot', 'zhipu', 'zhipu-quota', 'workbuddy'], '适配器清单（智谱余额优先于配额；WorkBuddy 积分走本机路由，排最后）');
	const byId = (id) => m.adapters.filter((one) => one.id === id)[0];

	/* ---------------------------------------------------------- provider 识别 */
	assert.strictEqual(m.adapterFor('deepseek', 'deepseek-v4-pro').id, 'deepseek', 'DeepSeek');
	assert.strictEqual(m.adapterFor('deepseek-official', 'deepseek-chat').id, 'deepseek', '官方 provider 名');
	assert.strictEqual(m.adapterFor('openrouter', 'x-ai/grok-4').id, 'openrouter', 'OpenRouter');
	assert.strictEqual(m.adapterFor('zhipu', 'glm-4-plus').id, 'zhipu', '智谱按量计费走余额（不是配额）');
	assert.strictEqual(m.adapterFor('bigmodel', 'glm-4.6').id, 'zhipu', '智谱别名同样走余额');
	/* 但"按量计费走余额"只说了**主选**是谁，没说配额那条路存在 —— 这正是原来缺的另一半：
	   智谱两种计费通道是**独立的两条路**，keys 完全重叠（zhipu/glm/bigmodel 全一样），
	   单选的 adapterFor 永远只命中第一个。必须靠 `adaptersFor` 给出"依次尝试"的链，
	   否则 coding plan 用户永远拿不到配额（客户端 isPercent 分支恒不可达）。 */
	assert.deepStrictEqual(m.adaptersFor('zhipu', 'glm-4-plus').map((one) => one.id), ['zhipu', 'zhipu-quota'],
		'智谱要给出两条路：先现金余额、再 coding plan 配额（两者独立，不能二选一）');
	assert.deepStrictEqual(m.adaptersFor('bigmodel', 'glm-4.6').map((one) => one.id), ['zhipu', 'zhipu-quota'],
		'智谱别名（bigmodel）同样要带上配额那条路');
	assert.deepStrictEqual(m.adaptersFor('zai', 'glm-5.3').map((one) => one.id), ['zhipu', 'zhipu-quota'],
		'z.ai（国际站）provider 名同样要带上配额那条路');
	/* 配额适配器必须还在（它含已实测的上游协议知识），而且必须是链上的下一跳 */
	assert.strictEqual(byId('zhipu-quota').fallbackOf, 'zhipu', 'zhipu-quota 挂在 zhipu 后面（不是被删掉）');
	assert.strictEqual(byId('zhipu-quota').keys.indexOf('zhipu') >= 0, true,
		'配额那条的 keys 与余额重叠（这正是它选不中的原因，必须靠 fallbackOf 显式挂链）');
	/* 非智谱平台链长恒为 1：行为与旧版逐字节一致 */
	assert.deepStrictEqual(m.adaptersFor('deepseek', 'deepseek-v4-pro').map((one) => one.id), ['deepseek'], 'DeepSeek 只有一条路');
	assert.deepStrictEqual(m.adaptersFor('openrouter', 'x-ai/grok-4').map((one) => one.id), ['openrouter'], 'OpenRouter 只有一条路');
	assert.deepStrictEqual(m.adaptersFor('moonshot', 'kimi-k2').map((one) => one.id), ['moonshot'], 'Kimi 只有一条路');
	assert.deepStrictEqual(m.adaptersFor('workbuddy-ai', 'deepseek-v4.1-flash-sg').map((one) => one.id), ['workbuddy'], 'WorkBuddy 只有一条路');
	assert.deepStrictEqual(m.adaptersFor('xiaomi', 'MiMo-V2.6-Pro-Ultraspeed'), [], '认不出平台 ⇒ 空链（不硬凑）');
	assert.deepStrictEqual(m.adaptersFor(undefined, undefined), [], '缺参数 ⇒ 空链');
	assert.deepStrictEqual(m.adaptersFor('my-gateway', 'deepseek-chat').map((one) => one.id), ['deepseek'], 'provider 认不出时退回模型名，链长仍为 1');
	assert.strictEqual(m.adapterFor('moonshot', 'kimi-k2').id, 'moonshot', 'Kimi');
	assert.strictEqual(m.adapterFor('siliconflow', 'Qwen/Qwen3-8B').id, 'siliconflow', '硅基流动');
	assert.strictEqual(m.adapterFor('b-ai', 'gpt-5').id, 'bai', 'B.AI');
	/* 没核实过的平台不许乱认：小米只有网页控制台，OpenAI 类没有公开余额端点 */
	assert.strictEqual(m.adapterFor('xiaomi', 'MiMo-V2.6-Pro-Ultraspeed'), null, '小米不该被认成任何适配器');
	assert.strictEqual(m.adapterFor('openai', 'gpt-5'), null, 'OpenAI 没有余额端点');
	assert.strictEqual(m.adapterFor('', ''), null, '空线索返回 null');
	assert.strictEqual(m.adapterFor(undefined, undefined), null, '缺参数返回 null');
	console.log('识别：8 家命中 / 3 类不该命中 / 适配器识别正常');

	/* ------------------------------------------- provider 优先于模型名（实测坑） */
	/* 实测 2026-10-07：WorkBuddy AI 会话跑 deepseek-v4.1-flash-sg，模型名里的 "deepseek"
	   曾把会话认成 DeepSeek 平台，于是拿 DeepSeek 的 key 去问官方余额接口，稳定 401。
	   provider 才是会话实际走的计费通道，必须以它为准。 */
	assert.strictEqual(m.adapterFor('workbuddy-ai', 'deepseek-v4.1-flash-sg').id, 'workbuddy',
		'WorkBuddy AI 会话即使跑 deepseek 模型，也必须认成 WorkBuddy（不能认成 DeepSeek）');
	assert.strictEqual(m.adapterFor('workbuddy', 'deepseek-v4-pro').id, 'workbuddy', '国内版同理');
	assert.strictEqual(m.adapterFor('workbuddy-ai', 'glm-5.3').id, 'workbuddy',
		'WorkBuddy AI 跑 glm 模型也不能认成智谱（否则会拿智谱 key 去查）');
	assert.strictEqual(m.adapterFor('openrouter', 'deepseek-v4-pro').id, 'openrouter',
		'OpenRouter 上的 deepseek 模型仍归 OpenRouter');
	/* provider 认不出（或还没上报）时才退回模型名，兼容自定义 provider 名 */
	assert.strictEqual(m.adapterFor('my-gateway', 'deepseek-chat').id, 'deepseek', 'provider 认不出时退回模型名');
	assert.strictEqual(m.adapterFor('', 'deepseek-chat').id, 'deepseek', 'provider 为空时退回模型名');
	console.log('provider 优先：WorkBuddy 会话不再被模型名里的 deepseek/glm 带偏');

	/* ------------------------------------------------------------ 请求构造 */
	const or = byId('openrouter').request('sk-or-1');
	assert.strictEqual(or.url, 'https://openrouter.ai/api/v1/credits', 'OpenRouter 端点');
	assert.strictEqual(or.headers.authorization, 'Bearer sk-or-1', 'OpenRouter 用 Bearer');
	const zp = byId('zhipu-quota').request('zp-key');
	assert.strictEqual(zp.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', '智谱配额端点');
	assert.strictEqual(zp.headers.authorization, 'zp-key', '智谱裸 key，不加 Bearer（cc-switch 实测）');
	const sf = byId('siliconflow').request('sf-key');
	assert.strictEqual(sf.url, 'https://api.siliconflow.com/v1/user/info', 'SiliconFlow 端点');
	const km = byId('moonshot').request('ms-key');
	assert.strictEqual(km.url, 'https://api.moonshot.ai/v1/users/me/balance', 'Kimi 端点');
	const ds = byId('deepseek').request('ds-key');
	assert.strictEqual(ds.url, 'https://api.deepseek.com/user/balance', 'DeepSeek 端点');
	assert.strictEqual(ds.headers.authorization, 'Bearer ds-key', 'DeepSeek 用 Bearer');
	console.log('请求构造：端点与鉴权头都符合各家实测');

	/* ---------------------------------------------------------------- 解析 */
	const orOut = byId('openrouter').parse({ data: { total_credits: 20, total_usage: 7.5 } });
	assert.strictEqual(orOut.total, '12.50', 'OpenRouter 可用 = 总额度 - 已用');
	assert.strictEqual(orOut.currency, 'USD', 'OpenRouter 币种');
	assert.strictEqual(byId('openrouter').parse({}), null, 'OpenRouter 空响应给 null');
	assert.strictEqual(byId('openrouter').parse(null), null, 'OpenRouter null 给 null');

	const zpOut = byId('zhipu-quota').parse({
		success: true,
		data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 37.5 }, { type: 'CREDIT_LIMIT', percentage: 12 }] }
	});
	assert.strictEqual(zpOut.total, '37.50%', '智谱取最紧窗口，直接给百分比');
	assert.strictEqual(zpOut.isPercent, true, '百分比口径要标记出来（client 据此不带货币符号）');
	assert.strictEqual(zpOut.currency, '', '百分比不带货币');
	assert.strictEqual(byId('zhipu-quota').parse({ success: false, msg: 'x' }), null, '智谱失败态给 null');
	assert.strictEqual(byId('zhipu-quota').parse({ success: true, data: { limits: [] } }), null, '智谱没有窗口给 null');
	assert.strictEqual(byId('zhipu-quota').parse({ success: true, data: { limits: [{ type: 'OTHER', percentage: 1 }] } }), null, '智谱忽略未知 type');

	/* 智谱按量计费余额（cc-switch PR #6978 的模板） */
	const zpb = byId('zhipu').request('zp-key');
	assert.strictEqual(zpb.url, 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report', '智谱余额端点');
	assert.strictEqual(zpb.headers.authorization, 'Bearer zp-key', '智谱余额用 Bearer（与配额的裸 key 不同）');
	assert.strictEqual(byId('zhipu').refs[0], 'ZAI_API_KEY', '实测用户配的是 ZAI_API_KEY，必须排在引用名首位');
	const zpbOut = byId('zhipu').parse({ code: 200, data: { availableBalance: 88.5, balance: 88.5, rechargeAmount: 100, giveAmount: 5, totalSpendAmount: 11.5 } });
	assert.strictEqual(zpbOut.total, '88.50', '智谱可用余额取 availableBalance');
	assert.strictEqual(zpbOut.currency, 'CNY', '智谱余额单位 CNY');
	assert.deepStrictEqual(zpbOut.parts, [{ label: 'toppedUp', amount: '100.00' }, { label: 'granted', amount: '5.00' }, { label: 'spent', amount: '11.50' }], '智谱三行：累计充值 / 赠送 / 累计消费');
	assert.strictEqual(byId('zhipu').parse({ code: 401, msg: 'no' }), null, '智谱非 200 给 null');
	assert.strictEqual(byId('zhipu').parse({ code: 200, data: {} }), null, '智谱缺余额字段给 null');
	assert.strictEqual(byId('zhipu').parse({ code: 200, data: { balance: 5 } }).total, '5.00', '智谱回退到 balance 字段');

	const sfOut = byId('siliconflow').parse({ data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } });
	assert.strictEqual(sfOut.total, '88.88', 'SiliconFlow 用 totalBalance');
	assert.deepStrictEqual(sfOut.parts, [{ label: 'toppedUp', amount: '88.00' }, { label: 'granted', amount: '0.88' }], 'SiliconFlow 两行构成');

	const kmOut = byId('moonshot').parse({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 } });
	assert.strictEqual(kmOut.total, '49.59', 'Kimi 可用余额（含代金券）');
	assert.deepStrictEqual(kmOut.parts, [{ label: 'toppedUp', amount: '3.00' }, { label: 'granted', amount: '46.59' }], 'Kimi 两行构成');
	assert.strictEqual(byId('moonshot').parse({ code: 1 }), null, 'Kimi 响应缺 data 给 null');

	const dsOut = byId('deepseek').parse({ balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.34', topped_up_balance: '10.00' }] });
	assert.strictEqual(dsOut.total, '12.34', 'DeepSeek 总额');
	assert.strictEqual(dsOut.currency, 'CNY', 'DeepSeek 币种');
	assert.deepStrictEqual(dsOut.parts, [{ label: 'toppedUp', amount: '10.00' }, { label: 'granted', amount: '2.34' }], 'DeepSeek 两行构成');
	assert.strictEqual(byId('deepseek').parse({ balance_infos: [] }), null, 'DeepSeek 空列表给 null');
	/* 数组元素为 null（上游坏数据）：不能抛 TypeError —— 抛了整条余额就永久变横杠 */
	assert.strictEqual(byId('deepseek').parse({ balance_infos: [null] }), null,
		'DeepSeek 列表元素是 null ⇒ 给 null（不抛 TypeError）');
	assert.strictEqual(byId('zhipu-quota').parse({ success: true, data: { limits: [null] } }), null,
		'智谱配额列表元素是 null ⇒ 给 null（不抛 TypeError）');
	assert.strictEqual(byId('zhipu-quota').parse({ success: true, data: { limits: [null, { type: 'TOKENS_LIMIT', percentage: 50 }] } }).total,
		'50.00%', '智谱混入 null 时跳过坏元素、正常元素照常解析');

	/* 「累计消费」只有智谱能给：其他平台不该凭空造出这一行（气泡第三行的显示依据） */
	const spentCount = (id, data) => {
		const out = byId(id).parse(data);
		return out === null ? -1 : out.parts.filter((one) => one.label === 'spent').length;
	};
	assert.strictEqual(spentCount('deepseek', { balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] }), 0, 'DeepSeek 没有累计消费');
	assert.strictEqual(spentCount('openrouter', { data: { total_credits: 1, total_usage: 0 } }), 0, 'OpenRouter 没有累计消费');
	assert.strictEqual(spentCount('siliconflow', { data: { totalBalance: '1' } }), 0, 'SiliconFlow 没有累计消费');
	assert.strictEqual(spentCount('moonshot', { data: { available_balance: 1 } }), 0, 'Kimi 没有累计消费');
	assert.strictEqual(spentCount('bai', { balance: 1 }), 0, 'B.AI 没有累计消费');
	assert.strictEqual(spentCount('zhipu', { code: 200, data: { availableBalance: 1, rechargeAmount: 10, giveAmount: 2, totalSpendAmount: 5 } }), 1, '只有智谱给累计消费');
	console.log('累计消费：只有智谱产出该行，其余五家都不产出');

	const baiOut = byId('bai').parse({ balance: 12.5 });
	assert.strictEqual(baiOut.total, '12.5', 'B.AI 顶层 balance');
	assert.strictEqual(byId('bai').parse({}), null, 'B.AI 空响应给 null');
	console.log('解析：六家正常值 + 八类异常输入全部符合预期');

	/* ------------------------------------------------- WorkBuddy 积分（本机路由） */
	const wb = byId('workbuddy');
	assert.strictEqual(wb.local, true, 'WorkBuddy 不发外部请求，只读本机路由');
	assert.deepStrictEqual(wb.refs, [], '不解析任何凭据引用（凭据由 connect 插件持有）');
	/* 两个插件（新 dsh-connect-workbuddy / 老 dsh-workbuddy-connect）的路径**都**要在候选里：
	   用户明确说旧插件后续可能还会用，所以不能只留一条。新插件在前（当前生效的是它）。 */
	assert.deepStrictEqual(wb.pathsOf('workbuddy'),
		['/plugins/dsh-connect-workbuddy/usage?region=cn', '/plugins/dsh-workbuddy-connect/status'],
		'国内版：先试新插件 /usage，再试老插件 /status');
	assert.deepStrictEqual(wb.pathsOf('workbuddy-ai'),
		['/plugins/dsh-connect-workbuddy/usage?region=global', '/plugins/dsh-workbuddy-connect/ai/status'],
		'国际版（-ai）：新插件带 region=global，老插件走 /ai/status');
	assert.deepStrictEqual(wb.pathsOf('workbuddy-global'),
		['/plugins/dsh-connect-workbuddy/usage?region=global', '/plugins/dsh-workbuddy-connect/ai/status'],
		'国际版（-global）：与 -ai 同一套候选');
	assert.deepStrictEqual(wb.pathsOf('WorkBuddy-AI'),
		['/plugins/dsh-connect-workbuddy/usage?region=global', '/plugins/dsh-workbuddy-connect/ai/status'],
		'provider 名大小写不敏感');
	assert.deepStrictEqual(wb.pathsOf(''),
		['/plugins/dsh-connect-workbuddy/usage?region=cn', '/plugins/dsh-workbuddy-connect/status'],
		'provider 缺失时按国内版候选');

	/* 实测形状：新旧插件的积分都在**顶层 credits.total**（口径一致，解析器一份就够）。
	   新插件实测（2026-10-12）credits 是 { total, packages, expiringSoon, nearestExpiryMs }。 */
	const wbOut = wb.parse({ status: 'signed-in', credits: { total: 177, accounts: [{ packageName: 'Bonus Pack', remain: 30, size: 30 }] } });
	assert.strictEqual(wbOut.total, '177', 'WorkBuddy 取 credits.total（老插件形状）');
	const wbNew = wb.parse({ status: 'signed-in', region: 'cn', credits: { total: 1072, packages: [], expiringSoon: 0, nearestExpiryMs: 0 } });
	assert.strictEqual(wbNew.total, '1,072', '新插件 /usage 的 credits.total 同样能解析（口径一致）');
	assert.strictEqual(wbNew.isCredits, true, '新插件同样是积分口径');
	assert.strictEqual(wbOut.currency, '', '积分不是货币：currency 必须留空，客户端才不拼 ¥');
	assert.strictEqual(wbOut.isCredits, true, '标记积分口径（客户端据此不显示货币符号、不列构成行）');
	assert.deepStrictEqual(wbOut.parts, [], '按用户要求不给套餐构成行，气泡只显示总数');
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: { total: 1234 } }).total, '1,234', '四位数积分加千分位');
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: { total: 12.345 } }).total, '12.35', '非整数积分保留两位小数');
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: { total: 0 } }).total, '0', '零积分显示 0');
	assert.strictEqual(wb.parse({ status: 'signed-out' }), null, '未登录（没有 credits）给 null');
	assert.strictEqual(wb.parse({ status: 'signed-in', creditsError: 'boom' }), null, '上游报错（没有 credits）给 null');
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: {} }), null, 'credits 里没有 total 给 null');
	assert.strictEqual(wb.parse(null), null, 'null 输入给 null');
	console.log('WorkBuddy：本机路由映射 + 积分口径（不带货币符号、不列构成）');

	/* ------------------------------ WorkBuddy 积分套餐投影（rewards） */
	/* 新插件 /usage 的 credits.packages 就是官方客户端「积分套餐」那一栏的数据；
	   实测样本见 _diag/workbuddy-rewards-feasibility.md §2（cn 账号 13 个包、global 2 个包）。
	   这里取前 3 个包：1 个月度（带 cycleRefreshMs）+ 2 个一次性（带 expiresAtMs）。 */
	const wbPackages = wb.parse({
		status: 'signed-in',
		region: 'cn',
		credits: {
			total: 2547.57000064,
			packages: [
				{ packageName: 'CodeBuddy个人体验版', remain: 0, size: 500, monthly: true, cycleRefreshMs: 1793462400000 },
				{ packageName: 'CodeBuddy个人版拉新权益包', remain: 947.57000064, size: 1500, monthly: false, expiresAtMs: 1794056975000 },
				{ packageName: 'CodeBuddy个人版国内运营裂变包', remain: 100, size: 100, monthly: false, expiresAtMs: 1794056980000 }
			]
		}
	});
	assert.strictEqual(wbPackages.total, '2,547.57', '顶层 total 仍是千分位字符串（口径不变）');
	assert.strictEqual(Array.isArray(wbPackages.rewards), true, '有 packages 就投影出 rewards 数组');
	assert.deepStrictEqual(wbPackages.rewards[0], {
		name: 'CodeBuddy个人体验版', used: 500, total: 500, expireAt: null, refreshAt: '2026-11-01', monthly: true
	}, '月度包：refreshAt 是下期刷新日（不是到期），expireAt null');
	assert.deepStrictEqual(wbPackages.rewards[2], {
		name: 'CodeBuddy个人版国内运营裂变包', used: 0, total: 100, expireAt: '2026-11-07', refreshAt: null, monthly: false
	}, '一次性包：expireAt 是到期日，refreshAt null；没用过 ⇒ used 0');
	assert.strictEqual(wbPackages.rewards[1].used, 552.42999936,
		'已用 = 总量 - 剩余（与官方 CycleCapacity 口径一致，不提前四舍五入丢精度）');
	assert.strictEqual(wbPackages.rewards[1].expireAt, '2026-11-07', '毫秒时间戳按北京时间折成 YYYY-MM-DD');
	assert.strictEqual(wbPackages.rewards[1].refreshAt, null, '一次性包没有刷新日');
	assert.strictEqual(typeof wbPackages.rewards[0].used, 'number', 'used/total 给数字，格式化交给客户端');
	assert.strictEqual(typeof wbPackages.rewards[0].total, 'number', 'total 给数字（不是千分位字符串）');
	assert.strictEqual(/^\d{4}-\d{2}-\d{2}$/.test(wbPackages.rewards[0].refreshAt), true, '日期统一 YYYY-MM-DD');
	/* 上游没有 packages/不是数组（老插件 /status）⇒ 不给 rewards，客户端保持纯总数显示 */
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: { total: 177 } }).rewards, undefined,
		'老插件：只有 credits.total ⇒ 不带 rewards（保持现状）');
	assert.strictEqual(wb.parse({ status: 'signed-in', credits: { total: 177, accounts: [{ packageName: 'Bonus Pack', remain: 30, size: 30 }] } }).rewards, undefined,
		'老形状的 accounts 不是套餐，不猜字段');
	assert.strictEqual(wb.parse({ credits: { total: 1, packages: 'not-an-array' } }).rewards, undefined,
		'packages 不是数组 ⇒ 不给 rewards');
	assert.deepStrictEqual(wb.parse({ credits: { total: 1, packages: [] } }).rewards, [],
		'packages 是空数组 ⇒ rewards 空数组（客户端据此不显示气泡）');

	/* 字段缺失/坏数据：逐个跳过坏包，或者降级字段，绝不让整条气泡抛错 */
	const wbDegraded = wb.parse({
		credits: {
			total: 10,
			packages: [
				{ packageName: '正常包', remain: 5, size: 10, monthly: false, expiresAtMs: 1794056975000 },
				null,
				{ packageName: '缺 size', remain: 5, monthly: false },
				{ remain: 1, size: 2, monthly: false },
				{ packageName: 'remain 非数', remain: 'abc', size: 10, monthly: false },
				{ packageName: '日期坏', remain: 0, size: 10, monthly: false, expiresAtMs: 'oops' },
				{ packageName: '剩余超总量', remain: 999, size: 10, monthly: false },
				{ packageName: '月度缺刷新', remain: 3, size: 9, monthly: true }
			]
		}
	});
	assert.deepStrictEqual(wbDegraded.rewards, [
		{ name: '正常包', used: 5, total: 10, expireAt: '2026-11-07', refreshAt: null, monthly: false },
		{ name: '日期坏', used: 10, total: 10, expireAt: null, refreshAt: null, monthly: false },
		{ name: '剩余超总量', used: 0, total: 10, expireAt: null, refreshAt: null, monthly: false },
		{ name: '月度缺刷新', used: 6, total: 9, expireAt: null, refreshAt: null, monthly: true }
	], '坏包跳过、坏字段降级为 null，不抛错；剩余超总量时 used 夹到 0（不显示负数）');

	/* ----------------------------- 上游数据量上限（防主线程被拖死）
	   上游是外部 API，包名多长、返回多少条都不由我们决定。两个上限：
	     · 包名超 200 字符就截断 —— 下游 creditDisplayName 按前缀反复剥是 O(n²)，
	       实测 500KB 名字能让浏览器主线程卡 18 秒；
	     · 超过 256 条就忽略 —— 列表在底栏每秒重渲染路径上、没有 memo，
	       实测 10 万条 ≈ 0.7 秒/帧。 */
	const hugeName = 'X'.repeat(500000);
	const hugeNameOut = wb.parse({
		credits: { total: 1, packages: [{ packageName: hugeName, remain: 1, size: 2, monthly: false }] }
	});
	assert.strictEqual(hugeNameOut.rewards.length, 1, '超长包名仍保留一条（不是整条丢掉）');
	assert.strictEqual(hugeNameOut.rewards[0].name.length, 201,
		'包名截断到 200 字符 + 省略号（下游前缀剥离是 O(n²)，不截会卡死主线程），实际 '
		+ hugeNameOut.rewards[0].name.length);
	assert.strictEqual(hugeNameOut.rewards[0].name.slice(-1), '…', '截断处补省略号，用户看得出被截了');
	/* 正常长度的包名一个字都不能动 */
	const normalName = wb.parse({
		credits: { total: 1, packages: [{ packageName: 'CodeBuddy个人版国内运营裂变包', remain: 1, size: 2, monthly: false }] }
	}).rewards[0].name;
	assert.strictEqual(normalName, 'CodeBuddy个人版国内运营裂变包', '正常包名原样保留（截断只对超长生效）');
	/* 条数上限：300 条只取前 256 条 */
	const manyPackages = [];
	for (let i = 0; i < 300; i += 1) {
		manyPackages.push({ packageName: '包' + i, remain: 1, size: 2, monthly: false });
	}
	const capped = wb.parse({ credits: { total: 1, packages: manyPackages } });
	assert.strictEqual(capped.rewards.length, 256, '套餐条数上限 256（超出的忽略，不让渲染拖死底栏）');
	assert.strictEqual(capped.rewards[0].name, '包0', '保留的是前面那些包（顺序不变）');
	assert.strictEqual(capped.rewards[255].name, '包255', '取满 256 条');

	/* ------------------------------------- connect 类插件的通用发现（白名单 + 具名抽取器） */
	/* 路由筛选：只认 /plugins/<id>/<只读动词>，写操作与 SSE 一律不进候选 */
	const fakeTable = new Map([
		['/plugins/dsh-connect-workbuddy/usage', {}],
		['/plugins/dsh-connect-workbuddy/account-credits', {}],
		['/plugins/dsh-workbuddy-connect/status', {}],
		['/plugins/dsh-connect-workbuddy/pool', {}],            /* 写/敏感：必须排除 */
		['/plugins/dsh-connect-workbuddy/refresh', {}],         /* 写：必须排除 */
		['/plugins/dsh-connect-workbuddy/checkin', {}],         /* 会真领奖励：必须排除 */
		['/plugins/dsh-connect-workbuddy/transfer', {}],        /* 凭据转移：必须排除 */
		['/plugins/dsh-connect-workbuddy/oauth', {}],           /* 登录：必须排除 */
		['/plugins/dsh-connect-workbuddy/__save', {}],          /* 写配置：必须排除 */
		['/plugins/events', {}],                                /* SSE：GET 会挂住：必须排除 */
		['/plugins/dsh-connect-qoder/usage', {}],
		['/dsh-desktop-statusbar/api', {}]                      /* 非 /plugins 前缀：排除 */
	]);
	const found = m.pluginRoutesIn(fakeTable);
	const foundPaths = found.map((one) => one.path).sort();
	assert.deepStrictEqual(foundPaths, [
		'/plugins/dsh-connect-qoder/usage',
		'/plugins/dsh-connect-workbuddy/account-credits',
		'/plugins/dsh-connect-workbuddy/usage',
		'/plugins/dsh-workbuddy-connect/status'
	].sort(), '只筛出只读动词（usage/status/account-credits），写操作与 SSE 全排除');
	assert.deepStrictEqual(m.LOCAL_READONLY_VERBS, ['usage', 'status', 'account-credits'], '只读动词白名单');
	assert.strictEqual(m.LOCAL_NEVER_PROBE.indexOf('/plugins/events') >= 0, true, 'SSE 端点列在永不探测名单里');
	/* 拿不到路由表（宿主改实现）时给空数组，不能抛错 —— 调用方据此回退声明表 */
	assert.deepStrictEqual(m.pluginRoutesIn(null), [], '表为 null ⇒ 空数组（优雅回退）');
	assert.deepStrictEqual(m.pluginRoutesIn(undefined), [], '表为 undefined ⇒ 空数组');
	assert.deepStrictEqual(m.pluginRoutesIn('not-a-map'), [], '非 Map ⇒ 空数组');
	assert.deepStrictEqual(m.pluginRoutesIn({ forEach: undefined }), [], '没有 forEach ⇒ 空数组');

	/* 具名抽取器：**绝不自由猜字段**。这条是"宁可不显示也不显示错数"的唯一防线。
	   生产路径是 index.js 的 queryLocalAdapter → adapter.parse(data)（本机路由响应直接喂进去），
	   所以这里打的就是生产 `parse`，不再打测试专用的旁路函数。 */
	assert.strictEqual(wb.parse({ credits: { total: 1072 } }).total, '1,072', 'workbuddy 形状：credits.total 是余额');
	assert.strictEqual(wb.parse({ credits: { total: 1072 } }).isCredits, true, 'workbuddy 形状：积分口径标记');
	assert.strictEqual(byId('zhipu-quota').parse({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 37.5 }] } }).total, '37.50%', '配额形状：limits 里的 percentage');
	assert.strictEqual(byId('zhipu-quota').parse({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 37.5 }] } }).isPercent, true, '配额形状标记 isPercent');
	/* qoder 那种结构：`userQuota.total` 是**配额容量**、`remaining` 才是余额 —— 必须认不出，
	   而不是"找到 total 就当余额"（那会显示一个看起来合理的错数）。
	   实测同一份 qoder 文档喂给 workbuddy 与 zhipu-quota 两条生产解析器，都必须给 null。 */
	const qoderDoc = { usage: { userQuota: { total: 1000, used: 200, remaining: 800, percentage: 20 } }, atMs: 1 };
	assert.strictEqual(wb.parse(qoderDoc), null,
		'qoder 形状：userQuota.total 是容量不是余额 ⇒ 必须认不出（不猜字段）');
	assert.strictEqual(byId('zhipu-quota').parse(qoderDoc), null,
		'qoder 形状喂给配额解析器同样必须认不出（没有 limits 就不是配额）');
	assert.strictEqual(wb.parse({ status: 'signed-out' }), null, '未登录文档 ⇒ null');
	assert.strictEqual(wb.parse({ credits: {} }), null, 'credits 里没有 total ⇒ null');
	assert.strictEqual(wb.parse({ credits: { total: 'abc' } }), null, 'total 不是数字 ⇒ null');
	assert.strictEqual(wb.parse(null), null, 'null ⇒ null');
	assert.strictEqual(wb.parse(undefined), null, 'undefined ⇒ null');
	/* 数组：生产 parse 走 `data.credits`，数组上取不到 credits ⇒ null（不因 typeof 判断差异而误报） */
	assert.strictEqual(wb.parse([]), null, '数组 ⇒ null');
	assert.strictEqual(byId('zhipu-quota').parse([]), null, '数组喂给配额解析器 ⇒ null');
	console.log('connect 通用发现：只读动词白名单（写操作/SSE 全排除）+ 生产 parse 打真代码（qoder 形状认不出、不猜数）');

	console.log('');
	console.log('BALANCE API CHECKS PASSED');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
