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
	assert.strictEqual(m.adapterFor('moonshot', 'kimi-k2').id, 'moonshot', 'Kimi');
	assert.strictEqual(m.adapterFor('siliconflow', 'Qwen/Qwen3-8B').id, 'siliconflow', '硅基流动');
	assert.strictEqual(m.adapterFor('b-ai', 'gpt-5').id, 'bai', 'B.AI');
	/* 没核实过的平台不许乱认：小米只有网页控制台，OpenAI 类没有公开余额端点 */
	assert.strictEqual(m.adapterFor('xiaomi', 'MiMo-V2.6-Pro-Ultraspeed'), null, '小米不该被认成任何适配器');
	assert.strictEqual(m.adapterFor('openai', 'gpt-5'), null, 'OpenAI 没有余额端点');
	assert.strictEqual(m.adapterFor('', ''), null, '空线索返回 null');
	assert.strictEqual(m.adapterFor(undefined, undefined), null, '缺参数返回 null');
	assert.strictEqual(m.isDeepSeek('deepseek', 'deepseek-chat'), true, 'isDeepSeek 命中');
	assert.strictEqual(m.isDeepSeek('xiaomi', 'MiMo-V2.6-Pro-Ultraspeed'), false, 'isDeepSeek 不误判');
	console.log('识别：8 家命中 / 3 类不该命中 / isDeepSeek 正常');

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
	assert.deepStrictEqual(wb.refs, [], '不解析任何凭据引用（凭据由 workbuddy-connect 持有）');
	assert.strictEqual(wb.request(null, null, 'workbuddy-ai').path, '/plugins/dsh-workbuddy-connect/ai/status', '国际版路由');
	assert.strictEqual(wb.request(null, null, 'workbuddy').path, '/plugins/dsh-workbuddy-connect/status', '国内版路由');
	assert.strictEqual(wb.request(null, null, 'WorkBuddy-AI').path, '/plugins/dsh-workbuddy-connect/ai/status', 'provider 名大小写不敏感');
	assert.strictEqual(wb.request(null, null, '').path, '/plugins/dsh-workbuddy-connect/status', 'provider 缺失时按国内版路由');

	/* 实测形状：/plugins/dsh-workbuddy-connect/ai/status 的 credits 段 */
	const wbOut = wb.parse({ status: 'signed-in', credits: { total: 177, accounts: [{ packageName: 'Bonus Pack', remain: 30, size: 30 }] } });
	assert.strictEqual(wbOut.total, '177', 'WorkBuddy 取 credits.total');
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

	console.log('');
	console.log('BALANCE API CHECKS PASSED');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
