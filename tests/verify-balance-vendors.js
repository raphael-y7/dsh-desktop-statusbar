/* 五家官方余额适配器：小米 MiMo / StepFun / xAI / 阿里云 BSS / MiniMax。
   覆盖：
   · provider/模型识别与 refs（小米/StepFun 走模型页 credentials，不要求额外环境变量）；
   · request 的 URL 与认证头（阿里云 HMAC-SHA1 签名可复算）；
   · parse 的正常字段与异常输入；
   · 生产入口 queryBalanceForTest 的整链：mock fetch + 假 ctx.credentials 验证「模型页 key」路径。
   env / fetch / DSH_HOME 全部在 finally 里还原，不污染环境、不在仓库留文件。 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHmac } = require('node:crypto');

const ENV_NAMES = [
	'MIMO_API_KEY', 'XIAOMI_API_KEY', 'STEPFUN_API_KEY',
	'XAI_MANAGEMENT_API_KEY', 'XAI_TEAM_ID',
	'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
	'ALIBABA_CLOUD_SECURITY_TOKEN', 'ALIBABA_CLOUD_STS_TOKEN'
];

async function withEnv(values, fn) {
	const saved = new Map();
	for (const name of ENV_NAMES) saved.set(name, process.env[name]);
	try {
		for (const name of ENV_NAMES) delete process.env[name];
		for (const [name, value] of Object.entries(values)) process.env[name] = value;
		return await fn();
	} finally {
		for (const name of ENV_NAMES) {
			if (saved.get(name) === undefined) delete process.env[name];
			else process.env[name] = saved.get(name);
		}
	}
}

async function withFetch(handler, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = handler;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

/** 模拟宿主 ctx.credentials：resolve(ref) 按 ref 名返回模型页写入的 key；settings 可选。 */
function credentialsCtx(map, settings) {
	const credentials = {
		resolve: async (ref) => (Object.prototype.hasOwnProperty.call(map, ref)
			? { value: map[ref], source: 'model-page' }
			: null)
	};
	return {
		logger: { info: () => {} },
		get: (name) => {
			if (name === 'credentials') return credentials;
			if (name === 'settings') return settings;
			return undefined;
		}
	};
}

/** 模拟模型页 settings.describe()：providers 表里的 provider → { baseURL }。 */
function settingsWith(providers) {
	return { describe: () => [{ ns: 'include:llm-pi-ai', value: { providers: providers } }] };
}

async function driveAdapter(adapter, key, body, envValues) {
	return withEnv(envValues, async () => {
		const spec = adapter.request(key);
		assert.notStrictEqual(spec, null, adapter.id + ' 应当有 request spec');
		const calls = [];
		const parsed = await withFetch(async (url, options) => {
			calls.push({ url, options });
			return { ok: true, status: 200, json: async () => body };
		}, async () => {
			const response = await fetch(spec.url, { method: 'GET', headers: spec.headers });
			assert.strictEqual(response.ok, true, adapter.id + ' mock 响应');
			return adapter.parse(await response.json());
		});
		return { spec, calls, parsed };
	});
}

/** 生产路径：queryBalanceForTest → chain → queryWithAdapter → adapter.request/parse。 */
async function queryProduction(idx, ctx, provider, model, body, envValues) {
	const calls = [];
	const result = await withEnv(envValues, async () => withFetch(async (url, options) => {
		calls.push({ url, options });
		return { ok: true, status: 200, json: async () => body };
	}, async () => idx.queryBalanceForTest(ctx, false, provider, model, null, null)));
	return { result, calls };
}

function percentEncode(value) {
	return encodeURIComponent(String(value))
		.replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
		.replace(/%7E/g, '~')
		.replace(/\+/g, '%20');
}

function assertAlibabaSignature(url, secret) {
	const parsed = new URL(url);
	const signature = parsed.searchParams.get('Signature');
	assert.ok(typeof signature === 'string' && signature.length > 0, '阿里云 URL 带 Signature');
	const params = new Map();
	for (const [name, value] of parsed.searchParams.entries()) {
		if (name !== 'Signature') params.set(name, value);
	}
	const canonical = Array.from(params.keys()).sort()
		.map((name) => percentEncode(name) + '=' + percentEncode(params.get(name))).join('&');
	const stringToSign = 'GET&' + percentEncode('/') + '&' + percentEncode(canonical);
	const expected = createHmac('sha1', secret + '&').update(stringToSign, 'utf8').digest('base64');
	assert.strictEqual(signature, expected, '阿里云签名可用同一算法复算');
	return parsed;
}

async function main() {
	/* 隔离 DSH_HOME：queryBalance 会读 relay 配置，不能受本机真实配置影响。 */
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-balance-vendors-'));
	const savedHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	/* 不让插件的定时器把测试进程吊住（import index.js 不会 apply，但保持与 verify-balance 一致）。 */
	globalThis.setInterval = () => 0;
	try {
		const m = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'balance-api.js')).href);
		const idx = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'index.js')).href);
		const byId = (id) => m.adapters.filter((one) => one.id === id)[0];

		/* ---------------------------------------------------- 五家识别与清单 */
		const examples = [
			['xiaomi', 'xiaomi', 'MiMo-V2.6-Pro-Ultraspeed'],
			['stepfun', 'stepfun', 'step-3'],
			['minimax', 'minimax', 'MiniMax-M3'],
			['xai', 'xai', 'grok-4.7'],
			['alibaba', 'dashscope', 'qwen3.8-flash']
		];
		for (const [id, provider, model] of examples) {
			assert.ok(byId(id) !== undefined, '适配器存在：' + id);
			assert.deepStrictEqual(m.adaptersFor(provider, model).map((one) => one.id), [id],
				id + '：单一官方余额链路');
		}
		assert.strictEqual(m.adapterFor('openrouter', 'x-ai/grok-4').id, 'openrouter',
			'OpenRouter 上的 grok 模型仍归 OpenRouter（provider 优先）');
		assert.strictEqual(m.adapterFor('xiaomi', 'MiMo-V2.6-Pro-Ultraspeed').refs[0], 'xiaomi',
			'小米的 refs 首位是 provider 名（模型页凭据按 provider 落库）');
		assert.strictEqual(byId('stepfun').refs[0], 'stepfun',
			'StepFun 的 refs 首位是 provider 名');
		assert.strictEqual(m.adapterFor('minimax', 'MiniMax-M3').id, 'minimax',
			'MiniMax 走 M Plan / Token Plan 官方余额接口');
		assert.strictEqual(byId('minimax').refs[0], 'minimax',
			'MiniMax 的 refs 首位是 provider 名（模型页凭据按 provider 落库）');
		/* 环境变量契约表：只列需要特殊配置的两家（xAI/阿里云）；小米/StepFun 都走模型页 provider 凭据。
		   表 = 后续 balance-provider-setup 接口与设置 UI 的唯一事实源；这里只断言变量名，不涉及真实密钥。 */
		assert.deepStrictEqual(m.BALANCE_PROVIDER_ENV, {
			xai: ['XAI_TEAM_ID', 'XAI_MANAGEMENT_API_KEY'],
			alibaba: ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']
		}, 'BALANCE_PROVIDER_ENV 只声明 xAI/阿里云的特殊环境变量');
		assert.strictEqual('xiaomi' in m.BALANCE_PROVIDER_ENV, false, '小米不在特殊环境变量表里（模型页 provider 凭据）');
		assert.strictEqual('stepfun' in m.BALANCE_PROVIDER_ENV, false, 'StepFun 不在特殊环境变量表里（模型页 provider 凭据）');
		assert.strictEqual('minimax' in m.BALANCE_PROVIDER_ENV, false, 'MiniMax 不在特殊环境变量表里（模型页 provider 凭据）');
		for (const [id, names] of Object.entries(m.BALANCE_PROVIDER_ENV)) {
			const adapter = byId(id);
			assert.ok(adapter !== undefined, '环境变量表里的 ' + id + ' 有对应适配器');
			for (const name of names) {
				assert.strictEqual(/^[A-Z][A-Z0-9_]*$/.test(name), true, id + ' 环境变量名格式：' + name);
			}
			/* refs 里的凭据环境变量必须都在表里声明（provider 名不是环境变量，跳过） */
			for (const ref of adapter.refs) {
				if (/^[A-Z][A-Z0-9_]*$/.test(ref)) {
					assert.ok(names.includes(ref), id + ' 的 refs 里 ' + ref + ' 必须在 BALANCE_PROVIDER_ENV 中声明');
				}
			}
		}
		console.log('识别：五家适配器都能命中，OpenRouter 上的 grok 不误判');

		/* ---------------------------------------------------- 小米 MiMo */
		const xiaomiBody = {
			object: 'balance',
			balance_infos: [{
				currency: 'CNY',
				cash_balance: '100.50',
				gift_balance: '20.25',
				frozen_balance: '0.00',
				credit_available: '379.75',
				total_available: '500.50'
			}]
		};
		const xiaomi = byId('xiaomi');
		const xiaomiDirect = await driveAdapter(xiaomi, 'sk-mimo-test', xiaomiBody, {});
		assert.strictEqual(xiaomiDirect.spec.url, 'https://api.xiaomimimo.com/v1/platform/balance', '小米端点');
		assert.strictEqual(xiaomiDirect.spec.headers['api-key'], 'sk-mimo-test', '小米 api-key 认证');
		assert.strictEqual(xiaomiDirect.parsed.total, '500.50', '小米 total_available');
		assert.strictEqual(xiaomiDirect.parsed.currency, 'CNY', '小米币种');
		assert.deepStrictEqual(xiaomiDirect.parsed.parts, [
			{ label: 'toppedUp', amount: '100.50' },
			{ label: 'granted', amount: '20.25' }
		], '小米现金/赠金构成');
		assert.strictEqual(xiaomi.parse({ balance_infos: [null] }), null, '小米坏数组元素 ⇒ null');
		assert.strictEqual(xiaomi.parse({ balance_infos: [{ currency: 'CNY' }] }), null, '小米缺 total_available ⇒ null');
		assert.strictEqual(xiaomi.parse(null), null, '小米 null ⇒ null');

		/* 生产路径：key 只来自模型页 ctx.credentials（app 里 provider=xiaomi），不设任何 env。 */
		const xiaomiProduction = await queryProduction(idx, credentialsCtx({ xiaomi: 'sk-model-page-mimo' }), 'xiaomi', 'MiMo-V2.6-Pro-Ultraspeed', xiaomiBody, {});
		assert.strictEqual(xiaomiProduction.result.ok, true, '小米生产路径成功');
		assert.strictEqual(xiaomiProduction.result.total, '500.50', '小米生产路径总额');
		assert.strictEqual(xiaomiProduction.result.source, 'xiaomi', '小米 key 来源是模型页 provider 引用');
		assert.strictEqual(xiaomiProduction.calls.length, 1, '小米只发一次余额请求');
		assert.strictEqual(xiaomiProduction.calls[0].url, 'https://api.xiaomimimo.com/v1/platform/balance');
		assert.strictEqual(xiaomiProduction.calls[0].options.headers['api-key'], 'sk-model-page-mimo', '小米生产请求用模型页 key');
		const xiaomiNoKey = await queryProduction(idx, credentialsCtx({}), 'xiaomi', 'MiMo-V2.6-Pro-Ultraspeed', xiaomiBody, {});
		assert.strictEqual(xiaomiNoKey.result.ok, false, '小米没有模型页 key 时不显示余额');
		assert.strictEqual(xiaomiNoKey.result.reason, 'no-credential', '小米缺凭据原因');
		console.log('小米：端点/api-key/字段解析正确，模型页 ctx.credentials 路径已覆盖');

		/* ---------------------------------------------------- StepFun */
		const stepfunBody = {
			object: 'account',
			type: 'prepaid',
			balance: 12.34,
			total_cash_balance: 100,
			total_voucher_balance: 26
		};
		const stepfun = byId('stepfun');
		const stepfunDirect = await driveAdapter(stepfun, 'sk-stepfun-test', stepfunBody, {});
		assert.strictEqual(stepfunDirect.spec.url, 'https://api.stepfun.com/v1/accounts', 'StepFun 国内站端点');
		assert.strictEqual(stepfunDirect.spec.currency, 'CNY', 'StepFun 国内站 request 指定 CNY');
		assert.strictEqual(stepfunDirect.spec.headers.authorization, 'Bearer sk-stepfun-test', 'StepFun Bearer');
		const stepfunIntlSpec = stepfun.request('sk-stepfun-intl', 'https://api.stepfun.ai/v1');
		assert.strictEqual(stepfunIntlSpec.url, 'https://api.stepfun.ai/v1/accounts', 'StepFun 国际站端点');
		assert.strictEqual(stepfunIntlSpec.currency, 'USD', 'StepFun 国际站 request spec 用 USD 覆盖 parse 默认 CNY');
		assert.strictEqual(stepfunDirect.parsed.total, '12.34', 'StepFun balance');
		assert.strictEqual(stepfunDirect.parsed.currency, 'CNY', 'StepFun parse 默认币种 CNY（无上下文）');
		assert.strictEqual(stepfun.parse(stepfunBody).currency, 'CNY', 'StepFun parse 始终按默认 CNY，国际站由 request spec 覆盖');
		assert.deepStrictEqual(stepfunDirect.parsed.parts, [
			{ label: 'toppedUp', amount: '100.00' },
			{ label: 'granted', amount: '26.00' }
		], 'StepFun 充值/赠送构成');
		assert.strictEqual(stepfun.parse({}), null, 'StepFun 空响应 ⇒ null');
		assert.strictEqual(stepfun.parse({ balance: 'oops' }), null, 'StepFun 非数余额 ⇒ null');

		/* 国内站：baseURL api.stepfun.com → 国内端点、CNY */
		const stepfunDomestic = await queryProduction(idx, credentialsCtx({ stepfun: 'sk-model-page-stepfun' }, settingsWith({ stepfun: { baseURL: 'https://api.stepfun.com/v1' } })), 'stepfun', 'step-3', stepfunBody, {});
		assert.strictEqual(stepfunDomestic.result.ok, true, 'StepFun 国内站生产路径成功');
		assert.strictEqual(stepfunDomestic.result.total, '12.34', 'StepFun 国内站生产路径总额');
		assert.strictEqual(stepfunDomestic.result.currency, 'CNY', 'StepFun 国内站币种 CNY');
		assert.strictEqual(stepfunDomestic.result.source, 'stepfun', 'StepFun key 来源是模型页 provider 引用');
		assert.strictEqual(stepfunDomestic.calls[0].url, 'https://api.stepfun.com/v1/accounts', 'StepFun 国内站生产请求端点');
		assert.strictEqual(stepfunDomestic.calls[0].options.headers.authorization, 'Bearer sk-model-page-stepfun', 'StepFun 生产请求用模型页 key');
		/* 国际站：baseURL api.stepfun.ai → 国际端点、USD（request spec 覆盖 parse 的默认 CNY） */
		const stepfunIntl = await queryProduction(idx, credentialsCtx({ stepfun: 'sk-model-page-stepfun' }, settingsWith({ stepfun: { baseURL: 'https://api.stepfun.ai/v1' } })), 'stepfun', 'step-3', stepfunBody, {});
		assert.strictEqual(stepfunIntl.result.ok, true, 'StepFun 国际站生产路径成功');
		assert.strictEqual(stepfunIntl.result.total, '12.34', 'StepFun 国际站生产路径总额');
		assert.strictEqual(stepfunIntl.result.currency, 'USD', 'StepFun 国际站币种 USD');
		assert.strictEqual(stepfunIntl.calls[0].url, 'https://api.stepfun.ai/v1/accounts', 'StepFun 国际站生产请求端点');
		console.log('StepFun：国内 api.stepfun.com/CNY 与国际 api.stepfun.ai/USD 两条路径都正确');

		/* ---------------------------------------------------- MiniMax（M Plan / Token Plan） */
		const minimaxBody = {
			base_resp: { status_code: 0, status_msg: 'success' },
			model_remains: [{
				model_name: 'general',
				current_interval_remaining_percent: 62.5,
				current_weekly_remaining_percent: 40,
				current_interval_total_count: 1000,
				current_interval_usage_count: 625
			}]
		};
		const minimax = byId('minimax');
		const minimaxDirect = await driveAdapter(minimax, 'sk-minimax-test', minimaxBody, {});
		assert.strictEqual(minimaxDirect.spec.url, 'https://www.minimax.cn/v1/token_plan/remains', 'MiniMax M Plan 端点');
		assert.strictEqual(minimaxDirect.spec.headers.authorization, 'Bearer sk-minimax-test', 'MiniMax Bearer 认证');
		assert.strictEqual(minimaxDirect.parsed.total, '37.50%', 'MiniMax 已用 = 100 - 剩余 62.5%');
		assert.strictEqual(minimaxDirect.parsed.currency, '', 'MiniMax 百分比不带货币');
		assert.strictEqual(minimaxDirect.parsed.isPercent, true, 'MiniMax 标记百分比口径');
		assert.deepStrictEqual(minimaxDirect.parsed.parts, [], 'MiniMax 不列构成行');
		/* 没有 percent 字段时按计数换算；usage_count 名字是 usage，实际是**剩余额度** */
		const minimaxCounts = minimax.parse({
			base_resp: { status_code: 0 },
			model_remains: [{ model_name: 'general', current_interval_total_count: 200, current_interval_usage_count: 50 }]
		});
		assert.strictEqual(minimaxCounts.total, '75.00%', 'MiniMax 计数换算：剩余 50/200 ⇒ 已用 75%');
		assert.strictEqual(minimax.parse({
			base_resp: { status_code: 0 },
			model_remains: [
				{ model_name: 'other', current_interval_remaining_percent: 10 },
				{ model_name: 'general', current_interval_remaining_percent: 60 }
			]
		}).total, '40.00%', 'MiniMax 优先 general 桶');
		assert.strictEqual(minimax.parse({ base_resp: { status_code: 1004 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }] }), null, 'MiniMax base_resp 非 0 ⇒ null');
		assert.strictEqual(minimax.parse({ base_resp: { status_code: 0 }, model_remains: [{}] }), null, 'MiniMax 字段缺失 ⇒ null');
		assert.strictEqual(minimax.parse({ base_resp: { status_code: 0 }, model_remains: 'oops' }), null, 'MiniMax model_remains 非数组 ⇒ null');
		assert.strictEqual(minimax.parse({}), null, 'MiniMax 空响应 ⇒ null');
		const minimaxProduction = await queryProduction(idx, credentialsCtx({ minimax: 'sk-model-page-minimax' }), 'minimax', 'MiniMax-M3', minimaxBody, {});
		assert.strictEqual(minimaxProduction.result.ok, true, 'MiniMax 生产路径成功');
		assert.strictEqual(minimaxProduction.result.total, '37.50%', 'MiniMax 生产路径总额');
		assert.strictEqual(minimaxProduction.result.source, 'minimax', 'MiniMax key 来源是模型页 provider 引用');
		assert.strictEqual(minimaxProduction.calls.length, 1, 'MiniMax 只发一次余额请求');
		assert.strictEqual(minimaxProduction.calls[0].url, 'https://www.minimax.cn/v1/token_plan/remains', 'MiniMax 生产请求端点');
		assert.strictEqual(minimaxProduction.calls[0].options.headers.authorization, 'Bearer sk-model-page-minimax', 'MiniMax 生产请求用模型页 key');
		const minimaxInferred = await queryProduction(idx, credentialsCtx({ minimax: 'sk-model-page-minimax' }, settingsWith({ minimax: { baseURL: 'https://www.minimax.cn/v1' } })), '', '', minimaxBody, {});
		assert.strictEqual(minimaxInferred.result.ok, true, '空 provider：MiniMax baseURL 可推断');
		assert.strictEqual(minimaxInferred.result.provider, 'minimax', '空 provider 推断出 MiniMax');
		console.log('MiniMax：M Plan 端点/Bearer/百分比换算正确，base_resp 非 0 与字段缺失均给 null');

		/* ------------------------------------- provider 为空：baseURL 唯一才推断 */
		const uniqueBaseCtx = credentialsCtx({ stepfun: 'sk-model-page-stepfun' }, settingsWith({ stepfun: { baseURL: 'https://api.stepfun.ai/v1' } }));
		const uniqueBase = await queryProduction(idx, uniqueBaseCtx, '', '', stepfunBody, {});
		assert.strictEqual(uniqueBase.result.ok, true, '空 provider：唯一 baseURL 可推断 StepFun');
		assert.strictEqual(uniqueBase.result.provider, 'stepfun', '空 provider 推断出的适配器');
		assert.strictEqual(uniqueBase.result.currency, 'USD', '空 provider 推断也走国际站 USD');
		assert.strictEqual(uniqueBase.calls[0].url, 'https://api.stepfun.ai/v1/accounts', '空 provider 推断后请求国际站端点');
		const multiVendorCtx = credentialsCtx({}, settingsWith({
			stepfun: { baseURL: 'https://api.stepfun.com/v1' },
			deepseek: { baseURL: 'https://api.deepseek.com/v1' }
		}));
		const multiVendor = await queryProduction(idx, multiVendorCtx, '', '', stepfunBody, {});
		assert.strictEqual(multiVendor.result.ok, false, '空 provider：多厂商并存不猜');
		assert.strictEqual(multiVendor.result.reason, 'unknown-platform', '空 provider 多厂商报 unknown-platform');
		assert.strictEqual(multiVendor.calls.length, 0, 'unknown-platform 不发请求');
		/* 未知官方 baseURL：除 StepFun 外还有一个官方域名认不出厂商 → 不猜 */
		const unknownBaseCtx = credentialsCtx({}, settingsWith({
			stepfun: { baseURL: 'https://api.stepfun.com/v1' },
			anthropic: { baseURL: 'https://api.anthropic.com/v1' }
		}));
		const unknownBase = await queryProduction(idx, unknownBaseCtx, '', '', stepfunBody, {});
		assert.strictEqual(unknownBase.result.ok, false, '空 provider：存在无法归类的官方 baseURL 不猜');
		assert.strictEqual(unknownBase.result.reason, 'unknown-platform', '空 provider 未知 baseURL 报 unknown-platform');
		assert.strictEqual(unknownBase.calls.length, 0, '未知 baseURL 不发请求');
		/* 同厂商多 baseURL：同一厂商多个 provider 指向同一地址 → 去重后仍唯一，可推断 */
		const sameOriginCtx = credentialsCtx({ stepfun: 'sk-model-page-stepfun' }, settingsWith({
			stepfun: { baseURL: 'https://api.stepfun.com/v1' },
			'stepfun-backup': { baseURL: 'https://api.stepfun.com/v1' }
		}));
		const sameOrigin = await queryProduction(idx, sameOriginCtx, '', '', stepfunBody, {});
		assert.strictEqual(sameOrigin.result.ok, true, '空 provider：同厂商同地址去重后仍可推断');
		assert.strictEqual(sameOrigin.result.provider, 'stepfun', '同厂商同地址推断 stepfun');
		assert.strictEqual(sameOrigin.result.currency, 'CNY', '同厂商同地址走国内站 CNY');
		/* 同厂商多 baseURL：两个地址都指向 StepFun 但 origin 不同 → 仍无法确定是哪一个 */
		const multiBaseCtx = credentialsCtx({}, settingsWith({
			stepfun: { baseURL: 'https://api.stepfun.com/v1' },
			'stepfun-intl': { baseURL: 'https://api.stepfun.ai/v1' }
		}));
		const multiBase = await queryProduction(idx, multiBaseCtx, '', '', stepfunBody, {});
		assert.strictEqual(multiBase.result.ok, false, '空 provider：同厂商多 baseURL 不猜');
		assert.strictEqual(multiBase.result.reason, 'unknown-platform', '同厂商多 baseURL 报 unknown-platform');
		assert.strictEqual(multiBase.calls.length, 0, '同厂商多 baseURL 不发请求');
		console.log('空 provider：唯一 baseURL → StepFun；多厂商 / 未知 baseURL / 同厂商多地址 → unknown-platform（不发请求）');

		/* ---------------------------------------------------- xAI */
		const xaiBody = { changes: [], total: { val: '-2433' } };
		const xai = byId('xai');
		const xaiDirect = await driveAdapter(xai, 'mgmt-key', xaiBody, { XAI_TEAM_ID: 'team-42' });
		assert.strictEqual(xaiDirect.spec.url, 'https://management-api.x.ai/v1/billing/teams/team-42/prepaid/balance', 'xAI 端点带 team_id');
		assert.strictEqual(xaiDirect.spec.headers.authorization, 'Bearer mgmt-key', 'xAI Bearer');
		assert.strictEqual(xaiDirect.parsed.total, '24.33', 'xAI 倒记账：-2433 分 = $24.33');
		assert.strictEqual(xaiDirect.parsed.currency, 'USD', 'xAI 币种 USD');
		assert.strictEqual(xai.parse({ total: { val: '250' } }).total, '-2.50', 'xAI 保留符号');
		assert.strictEqual(xai.parse({ balance: 1234 }).total, '-12.34', 'xAI 整数 balance（分）兼容');
		assert.strictEqual(xai.parse({ balance: '12.34' }), null, 'xAI 带小数点的 balance 单位拿不准 ⇒ null');
		assert.strictEqual(xai.parse({ total: { val: 'oops' } }), null, 'xAI 非数 total.val ⇒ null');
		assert.strictEqual((await withEnv({}, async () => xai.request('mgmt-key'))), null, 'xAI 缺 XAI_TEAM_ID ⇒ request null');
		const xaiNoTeam = await queryProduction(idx, credentialsCtx({ XAI_MANAGEMENT_API_KEY: 'mgmt-key' }), 'xai', 'grok-4.7', xaiBody, {});
		assert.strictEqual(xaiNoTeam.result.ok, false, 'xAI 缺 XAI_TEAM_ID 生产路径不可用');
		assert.strictEqual(xaiNoTeam.result.reason, 'not-configured', 'xAI 缺 team 报 not-configured（不是 TypeError/network）');
		assert.strictEqual(xaiNoTeam.calls.length, 0, 'xAI 缺 team 不发请求');
		const xaiProduction = await queryProduction(idx, credentialsCtx({ XAI_MANAGEMENT_API_KEY: 'mgmt-key' }), 'xai', 'grok-4.7', xaiBody, { XAI_TEAM_ID: 'team-42' });
		assert.strictEqual(xaiProduction.result.ok, true, 'xAI 生产路径成功');
		assert.strictEqual(xaiProduction.result.total, '24.33', 'xAI 生产路径总额');
		console.log('xAI：team_id/Management Key/倒记账分单位解析正确，缺 team 返回不可用');

		/* ---------------------------------------------------- 阿里云 BSS */
		const alibabaBody = {
			Code: '200',
			Message: 'success',
			RequestId: 'test-request',
			Success: true,
			Data: {
				AvailableAmount: '10000.00',
				CreditAmount: '0.00',
				MybankCreditAmount: '0.00',
				Currency: 'CNY',
				AvailableCashAmount: '10000.00',
				QuotaLimit: '10000.00'
			}
		};
		const alibaba = byId('alibaba');
		const alibabaEnv = { ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI-test-id', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-secret' };
		const alibabaDirect = await driveAdapter(alibaba, 'LTAI-test-id', alibabaBody, alibabaEnv);
		const alibabaUrl = assertAlibabaSignature(alibabaDirect.spec.url, 'test-secret');
		assert.strictEqual(alibabaUrl.origin, 'https://business.aliyuncs.com', '阿里云端点域名');
		assert.strictEqual(alibabaUrl.searchParams.get('Action'), 'QueryAccountBalance', '阿里云 Action');
		assert.strictEqual(alibabaUrl.searchParams.get('Version'), '2017-12-14', '阿里云版本');
		assert.strictEqual(alibabaUrl.searchParams.get('AccessKeyId'), 'LTAI-test-id', '阿里云 AccessKeyId');
		assert.strictEqual(alibabaUrl.searchParams.get('SignatureMethod'), 'HMAC-SHA1', '阿里云签名方法');
		assert.strictEqual(alibabaDirect.parsed.total, '10000.00', '阿里云 AvailableAmount');
		assert.strictEqual(alibabaDirect.parsed.currency, 'CNY', '阿里云币种');
		assert.strictEqual(alibaba.parse({ Code: '401', Success: false }), null, '阿里云失败码 ⇒ null');
		assert.strictEqual(alibaba.parse({ Code: '200', Success: true, Data: {} }), null, '阿里云缺 AvailableAmount ⇒ null');
		assert.strictEqual((await withEnv({ ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI-test-id' }, async () => alibaba.request('LTAI-test-id'))), null, '阿里云缺 Secret ⇒ request null');
		const alibabaSts = await withEnv({ ...alibabaEnv, ALIBABA_CLOUD_SECURITY_TOKEN: 'sts-token' }, async () => alibaba.request('LTAI-test-id'));
		assert.strictEqual(new URL(alibabaSts.url).searchParams.get('SecurityToken'), 'sts-token', '阿里云 STS Token 参数');
		const alibabaProduction = await queryProduction(idx, credentialsCtx({}), 'alibaba', 'qwen3.8-flash', alibabaBody, alibabaEnv);
		assert.strictEqual(alibabaProduction.result.ok, true, '阿里云生产路径成功');
		assert.strictEqual(alibabaProduction.result.total, '10000.00', '阿里云生产路径总额');
		assert.strictEqual(alibabaProduction.result.source, 'env', '阿里云 key 来源为环境变量');
		console.log('阿里云：QueryAccountBalance 签名可复算，AvailableAmount/Currency 正确，缺 Secret 不可用');

		console.log('');
		console.log('BALANCE VENDOR CHECKS PASSED');
	} finally {
		if (savedHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = savedHome;
		try { fs.rmSync(home, { recursive: true, force: true }); } catch (error) { /* 清理失败不影响结论 */ }
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
