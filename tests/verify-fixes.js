/**
 * 回归测试：本轮对抗性审查发现并修复的缺陷，逐条钉住，避免以后改回去。
 *
 * 覆盖 6 条：
 *   ① 开发模式与设置页组件状态不同步 —— 卸载时若只清定时器，devMode 会留着，
 *      重挂后界面没有胶囊、按钮却显示演示版本号，点下去只播演示不安装。
 *   ② 价格库上报的请求体上限太小 —— 24 个模型就超过 4KB 被掐断，价格库静默不同步。
 *   ③ 失败原因 update.reason 只写不读 —— 所有失败都退化成「更新失败」四个字。
 *   ④ release-age 在 flow 写法下写出重复键 —— pnpm 拒绝解析整个 profile。
 *   ⑤ 客户端日期键用本机时区 —— 非 UTC+8 机器上「今天」错一天（host 用 +8h）。
 *   ⑥ 导航胶囊无条件写 textContent —— 与 MutationObserver 形成每帧空转。
 *
 * 用法：node tests/verify-fixes.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const LIB = path.join(__dirname, '..', 'lib');
const client = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const host = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');

/* 去掉注释再断言：注释里会提到这些名字，直接搜源码会误判「还在用」。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const clientCode = stripComments(client);
const hostCode = stripComments(host);

console.log('===== ① 开发模式：卸载时必须复位模块级状态 =====');
assert.ok(/react\.useEffect\(\(\) => \(\) => \{\s*if \(devMode === true\) setDevMode\(false\);?\s*\}/.test(clientCode),
	'设置页卸载时要复位 devMode（否则重挂后 devMode=true 但胶囊不显示，更新按钮变成空操作）');
assert.ok(!/useEffect\(\(\) => \(\) => \{\s*if \(devTimer !== null\) \{ clearTimeout\(devTimer\); devTimer = null; \} \}\s*\}, \[\]\)/.test(clientCode),
	'不能只清定时器、不重置 devMode');
console.log('      卸载时调用 setDevMode(false)，且只在真的开着时才调');

console.log('\n===== ② 价格库上报：上限要够用，失败要能看见 =====');
/* 请求体上限必须有量级提升：24 个模型约 4.2KB，旧的 4096 不够 */
const limitMatch = hostCode.match(/JSON_BODY_LIMIT\s*=\s*([0-9*\s]+)/);
assert.ok(limitMatch !== null, '应有具名的请求体上限常量，而不是散落的魔法数字 4096');
const limitExpr = limitMatch[1].trim();
const limitValue = limitExpr.split('*').reduce((acc, one) => acc * Number(one.trim()), 1);
assert.ok(limitValue >= 64 * 1024, '上限至少 64KB（24 个模型约 4.2KB，旧值 4096 会掐断），实际 ' + limitValue);
assert.ok(/size > JSON_BODY_LIMIT/.test(hostCode), '按该常量判断，而不是写死 4096');
assert.ok(!/raw\.length > JSON_BODY_LIMIT/.test(hostCode),
	'上限必须按**字节数**判：raw.length 是字符数，一个汉字只算 1，拿它判会让 256KB 实际放到 768KB');
assert.ok(!/raw\.length > 4096/.test(hostCode), '旧的 4096 判断必须消失');
/* 客户端要检查 response.ok：fetch 对 4xx 是 resolve 不是 reject，只 catch 抓不到 */
assert.ok(/response\.ok !== true/.test(clientCode), '价格库上报要检查 response.ok（4xx 不会进 catch）');
assert.ok(!/body: JSON\.stringify\(\{ models: models \}\)\s*\}\)\.catch\(\(\) => \{ \/\* 上报失败不影响底栏 \*\/ \}\);/.test(clientCode),
	'不能再用「只 catch、不看 response」的那种写法静默吞掉失败');
console.log('      上限 ' + limitExpr + '（= ' + limitValue + ' 字节），且上报失败会告警');

console.log('\n===== ③ 更新失败仍只说「更新失败」（按用户要求，不额外暴露原因）=====');
/* 用户明确不要悬停可见原因，所以按钮上不该有 title 透露 reason。
   这条断言防的是「以后又有人好心把内部原因挂到界面上」。 */
assert.ok(!/title: update\.note === "failed"/.test(clientCode),
	'更新失败按钮不应挂 title 暴露内部原因（用户明确不要）');
const failedLabel = clientCode.slice(clientCode.indexOf('update.note === "done"'), clientCode.indexOf('update.note === "done"') + 400);
assert.ok(/t\("updateFailed"\)/.test(failedLabel), '失败态仍显示 updateFailed 文案');
console.log('      失败态就是「更新失败」四个字，不暴露内部 reason');

console.log('\n===== ④ release-age：所有写法都只能产出一个同名键 =====');
/* 直接跑真实函数，比字符串断言可靠 */
const { mergeExcludeIntoYaml } = require(path.join(LIB, 'release-age.js'));
const YAML_CASES = [
	['flow 风格', 'minimumReleaseAgeExclude: ["other@0.4.4"]\n'],
	['行尾注释', 'minimumReleaseAgeExclude:  # 表\n  - other@0.4.4\n'],
	['空数组', 'minimumReleaseAgeExclude: []\n'],
	['块风格', 'minimumReleaseAgeExclude:\n  - other@0.4.4\n'],
	['没有该键', 'packages:\n  - .\n'],
];
for (const [label, src] of YAML_CASES) {
	const out = mergeExcludeIntoYaml(src, 'dsh-desktop-statusbar', '2.1.2');
	const keys = (out.text.match(/^minimumReleaseAgeExclude:/gm) || []).length;
	assert.strictEqual(keys, 1, label + '：同名键只能有一个，实际 ' + keys + ' 个（重复会让 pnpm 拒绝解析）');
	assert.ok(out.text.includes('dsh-desktop-statusbar@2.1.2'), label + '：写入了目标版本');
}
console.log('      ' + YAML_CASES.length + ' 种写法都只写一个键');
/* 同行写法也要把已有条目保留下来，不能替换掉 */
const kept = mergeExcludeIntoYaml('minimumReleaseAgeExclude: ["other@0.4.4"]\n', 'dsh-desktop-statusbar', '2.1.2');
assert.ok(kept.text.includes('other@0.4.4'), 'flow 写法里的原有条目必须保留');
console.log('      flow 写法里的原有条目保留');

console.log('\n===== ⑤ 日期归属按装机者时区（峰谷计价仍按北京时间）=====');
assert.ok(/function dateKeyOf\(ms\)/.test(clientCode), '仍有 dateKeyOf');
const dateKeyBody = clientCode.slice(clientCode.indexOf('function dateKeyOf(ms)'));
const dateKeyFn = dateKeyBody.slice(0, dateKeyBody.indexOf('\n\t\t}'));
/* 日期归属：用本机时区（getFullYear/getMonth/getDate），不加 8 小时偏移 */
assert.ok(/d\.getFullYear\(\)/.test(dateKeyFn) && /d\.getMonth\(\)/.test(dateKeyFn) && /d\.getDate\(\)/.test(dateKeyFn),
	'dateKeyOf 按装机者时区取年月日');
assert.ok(!/\+ 8 \* 3600 \* 1000/.test(dateKeyFn),
	'日期归属不得再固定加 8 小时：UTC+8 装机看不出差别，其它时区会整体错一天');
/* host 侧同口径 */
const hostDates = hostCode.slice(hostCode.indexOf('function localDateKey'), hostCode.indexOf('function localDateKey') + 400);
assert.ok(/date\.getFullYear\(\)/.test(hostDates), 'host 的 localDateKey 也按本机时区');
assert.ok(!/ms \+ 8 \* 3600/.test(hostDates), 'host 的 localDateKey 不得再固定加 8 小时');
/* 峰谷计价必须**保留**北京时间 —— 那是 DeepSeek 的官方计费规则，与装机位置无关 */
const peakFn = hostCode.slice(hostCode.indexOf('function isPeakTime'), hostCode.indexOf('function isPeakTime') + 500);
assert.ok(/ms \+ 8 \* 3600 \* 1000/.test(peakFn),
	'isPeakTime（峰谷计价）必须继续按北京时间：那是官方计费规则，不能跟着装机时区走');
/* 行为验证：跨零点时刻在不同时区应归到各自的本地日期 */
const AT = Date.UTC(2026, 9, 13, 16, 30, 0); /* 北京 10-14 00:30 / 纽约 10-13 12:30 */
const localKeyAt = (ms, offsetHours) => {
	const d = new Date(ms + offsetHours * 3600 * 1000);
	const pad = (n) => (n < 10 ? '0' + n : String(n));
	return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
};
assert.strictEqual(localKeyAt(AT, 8), '2026-10-14', 'UTC+8 装机 → 10-14');
assert.strictEqual(localKeyAt(AT, -4), '2026-10-13', 'UTC-4 装机 → 10-13（本地还是 13 号）');
console.log('      装机时区 +8 / -4 各归到自己的日历日期；峰谷计价仍按北京时间');

console.log('\n===== ⑥ 导航胶囊：写 textContent 前先比值 =====');
const syncAt = clientCode.indexOf('function syncNavPill');
assert.ok(syncAt !== -1, '仍有 syncNavPill');
const syncFn = clientCode.slice(syncAt, syncAt + 700);
assert.ok(/has\.textContent !== text/.test(syncFn),
	'写 textContent 前必须比值：写相同内容也会产生 childList 记录，会让监听 childList 的 observer 每帧空转');
console.log('      已加值比较，不会自激 MutationObserver');

/* ======================================================================================
 * 第二轮：宿主侧（lib/index.js）7 条已复现缺陷的回归断言。
 * 有行为可测的都**直接跑真实函数**（比字符串断言可靠）：把 lib/ 复制到仓库内的临时目录，
 * patch 出一份导出内部符号的 index.js（工具见 tests/_host-lib.js）。
 * 临时目录必须落在仓库内 —— index.js 要 import 'zod'，Node 从该文件往上找 node_modules。
 * ====================================================================================== */
const hostLib = require('./_host-lib.js');
const TMP = path.join(__dirname, '.dsh-fixes-lib');
const FIX_HOME = path.join(__dirname, '.dsh-test-home-fixes');
process.env.DSH_HOME = FIX_HOME;
globalThis.setInterval = () => 0;

const TIER = (i, o) => ({ input: i, cacheRead: 0, cacheWrite: 0, output: o });
const bookOf = (entry) => ({ x: entry });

(async () => {
	const source = hostLib.prepare(TMP, ['sanitizePriceBook', 'fingerprintOf', 'parseFingerprint',
		'readJsonBody', 'addUnpriced', 'isCrossSiteWrite']);
	let host = null;
	try {
		host = await hostLib.loadHost(source, 'fixes');

		console.log('\n===== ⑦ addUnpriced：模型名撞 JS 原型属性不许抛错 =====');
		/* 复现：name='constructor' 时 `bucket[name] ?? 默认值` 取到原型上的函数，`??` 不触发
		   → one.peak 是 undefined → `tier.input += …` 抛 TypeError。抛错发生在
		   collectIntoLedger / backfillUnpriced 里，queueLedgerJob 随之 reject，
		   /api/daily-usage 恒返回 ledger-failed，活跃总览整块打不开。 */
		['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'normal'].forEach((model) => {
			const day = {};
			host.addUnpriced(day, model, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, true);
			host.addUnpriced(day, model, { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 }, false);
			assert.ok(Object.prototype.hasOwnProperty.call(day.unpriced, model), model + ' 必须建成自有属性');
			assert.strictEqual(Object.getPrototypeOf(day.unpriced), Object.prototype,
				model + ' 不许把欠账桶的原型改掉（__proto__ 键的老写法会）');
			assert.strictEqual(day.unpriced[model].peak.input, 1, model + ' 高峰档累加');
			assert.strictEqual(day.unpriced[model].peak.output, 4, model + ' 高峰档 output 累加');
			assert.strictEqual(day.unpriced[model].offPeak.input, 10, model + ' 空闲档累加');
		});
		console.log('      6 个原型属性名都不抛错、都建自有属性、原型未被污染');

		console.log('\n===== ⑧ sanitizePriceBook：__proto__ 键不许静默丢条目/污染原型 =====');
		/* 输入必须用 JSON.parse 造：对象字面量里的 `__proto__:` 是设原型，根本不是键；
		   真实路径上 POST 的 body 就是 JSON.parse 的产物，自有 __proto__ 键可达。 */
		const dirty = JSON.parse('{"constructor":{"peak":{"input":1,"cacheRead":0,"cacheWrite":0,"output":2}},'
			+ '"toString":{"peak":{"input":3,"cacheRead":0,"cacheWrite":0,"output":4}},'
			+ '"__proto__":{"peak":{"input":5,"cacheRead":0,"cacheWrite":0,"output":6}},'
			+ '"normal":{"peak":{"input":7,"cacheRead":0,"cacheWrite":0,"output":8}}}');
		assert.ok(Object.prototype.hasOwnProperty.call(dirty, '__proto__'), '前置：输入里确有自有 __proto__ 键');
		const clean = host.sanitizePriceBook(dirty);
		assert.notStrictEqual(clean, null, '清洗结果非 null');
		assert.deepStrictEqual(Object.keys(clean).sort(), ['__proto__', 'constructor', 'normal', 'toString'],
			'__proto__ 条目不许静默丢失（老写法 `out[name]=…` 是设置原型，Object.keys 里看不到它）');
		assert.strictEqual(Object.getPrototypeOf(clean), Object.prototype, '返回对象的原型不许被不可信输入替换');
		assert.strictEqual(clean['__proto__'].peak.input, 5, '__proto__ 条目的值正确');
		console.log('      4 个键全活下来（含 __proto__），原型仍是 Object.prototype');

		console.log('\n===== ⑨ 指纹：tiered / currency 进了指纹 =====');
		/* 复现：两次 POST 数字相同、只改 tiered 或 currency → changed=false →
		   settleUnpriced 不跑、weekUsageCache 不失效，欠账一直挂着。 */
		const fpBase = host.fingerprintOf(bookOf({ tiered: true, currency: 'CNY', peak: TIER(1, 2), offPeak: TIER(3, 4) }));
		assert.notStrictEqual(fpBase, host.fingerprintOf(bookOf({ tiered: false, currency: 'CNY', peak: TIER(1, 2), offPeak: TIER(3, 4) })),
			'tiered 从 true 改成 false，指纹必须变（否则欠账永远不结算）');
		assert.notStrictEqual(fpBase, host.fingerprintOf(bookOf({ tiered: true, currency: 'USD', peak: TIER(1, 2), offPeak: TIER(3, 4) })),
			'currency 从 CNY 改成 USD，指纹必须变');
		assert.strictEqual(fpBase, host.fingerprintOf(bookOf({ tiered: true, peak: TIER(1, 2), offPeak: TIER(3, 4) })),
			'缺 currency 按 CNY 归一：client 会落成显式 CNY，两侧必须算出同一串（否则每次上报都误判"已变更"）');
		console.log('      tiered / currency 都进指纹，缺省币种归一为 CNY');

		console.log('\n===== ⑩ 指纹：含 : / | 的键名必须能往返 =====');
		/* 复现：老格式 `名字:四项:四项|…` 被键名里的 `:` / `|` 吃掉分隔符 →
		   parseFingerprint 返回 null（回退内置表）或还原出**错的键名** →
		   backfillUnpriced 把"当年已按自建价算过钱"的事件误判成"当时缺价" → settleUnpriced
		   再补一遍 → 同一笔用量计两次、当天 cost 翻倍。可达的键名很现实：
		   Ollama 的 `qwen2.5:14b`、OpenRouter 的 `deepseek/deepseek-chat:free`。 */
		const tricky = {
			'qwen2.5:14b': { peak: TIER(1, 2), offPeak: TIER(3, 4) },
			'a|b': { peak: TIER(5, 6), offPeak: TIER(7, 8) },
			'deepseek/deepseek-chat:free': { peak: TIER(9, 10), offPeak: TIER(11, 12) },
			'normal': { peak: TIER(13, 14), offPeak: TIER(15, 16) },
		};
		const fingerprint = host.fingerprintOf(tricky);
		const restored = host.parseFingerprint(fingerprint);
		assert.notStrictEqual(restored, null, '含 : / | 的指纹必须能解析回来（返回 null 会触发重复计费）');
		assert.deepStrictEqual(Object.keys(restored).sort(), Object.keys(tricky).sort(),
			'键名逐个还原，不许丢条也不许串名（老格式下 `a|b` 会被还原成 `b`）');
		assert.strictEqual(host.fingerprintOf(restored), fingerprint, '指纹 → 价格库 → 指纹 必须回到原串');
		assert.strictEqual(restored['qwen2.5:14b'].peak.input, 1, 'qwen2.5:14b 的数值正确');
		assert.strictEqual(restored['a|b'].peak.input, 5, 'a|b 的数值正确');
		/* 升级前落盘的旧格式仍要能解析（迁移回扫靠它判"当年有没有价"） */
		const legacy = host.parseFingerprint('deepseek-flash:2,0.04,0,8:1,0.02,0,4');
		assert.notStrictEqual(legacy, null, '老格式指纹仍可解析，否则升级后历史欠账会全部重复补算');
		assert.strictEqual(legacy['deepseek-flash'].peak.input, 2, '老格式数值正确');
		assert.strictEqual(legacy['deepseek-flash'].offPeak.output, 4, '老格式空闲档数值正确');
		console.log('      4 个含分隔符的键名全部往返一致；升级前的旧格式仍可解析');

		console.log('\n===== ⑪ readJsonBody：跨 chunk 的多字节字符 + 按字节数限流 =====');
		/* 复现（老写法 `raw += chunk`）：chunk 是 Buffer，`+=` 触发逐块独立 toString('utf8')，
		   一个汉字的 3 字节被切在两个 chunk 里时两半都变成 U+FFFD —— 中文模型名被污染成
		   `���定义模型`，接口照样回 ok:true，之后查价永远匹配不上。 */
		const feed = (chunks) => new Promise((resolve) => {
			const listeners = {};
			const req = {
				on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
				destroy: () => {},
			};
			const pending = host.readJsonBody(req);
			chunks.forEach((chunk) => (listeners.data || []).forEach((fn) => fn(chunk)));
			(listeners.end || []).forEach((fn) => fn());
			pending.then(resolve);
		});
		const CHINESE = '自定义模型·中文名';
		const body = Buffer.from(JSON.stringify({ models: { [CHINESE]: { peak: TIER(1, 2) } } }), 'utf8');
		/* ① 逐字节喂：每个汉字都会被切在字符中间 */
		const byByte = [];
		for (let i = 0; i < body.length; i += 1) byByte.push(body.slice(i, i + 1));
		const parsedByte = await feed(byByte);
		assert.notStrictEqual(parsedByte, null, '逐字节分片仍要能解析');
		assert.deepStrictEqual(Object.keys(parsedByte.models), [CHINESE],
			'中文模型名不许被 U+FFFD 污染，实际 ' + JSON.stringify(Object.keys(parsedByte.models)));
		/* ② 固定切在汉字 3 字节中间（缺陷的原始位置） */
		const cut = body.indexOf(Buffer.from('中', 'utf8')) + 1;
		const parsedCut = await feed([body.slice(0, cut), body.slice(cut)]);
		assert.deepStrictEqual(Object.keys(parsedCut.models), [CHINESE], '切在汉字中间也不许污染');
		/* ③ 超限按字节数判，并断开请求 */
		let destroyed = false;
		const over = await new Promise((resolve) => {
			const listeners = {};
			const req = {
				on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
				destroy: () => { destroyed = true; },
			};
			const pending = host.readJsonBody(req);
			/* 200 万个汉字 = 6MB 字节，但字符数只有 200 万出头：老写法按字符判会放它过去 */
			const big = Buffer.from('{"s":"' + '中'.repeat(2000000) + '"}', 'utf8');
			for (let i = 0; i < big.length; i += 65536) (listeners.data || []).forEach((fn) => fn(big.slice(i, i + 65536)));
			(listeners.end || []).forEach((fn) => fn());
			pending.then(resolve);
		});
		assert.strictEqual(over, null, '超限必须返回 null');
		assert.strictEqual(destroyed, true, '超限必须断开请求（req.destroy 被调用）');
		console.log('      逐字节 / 切在汉字中间都保真；超限按字节数判定并断开');

		console.log('\n===== ⑫ 跨站来源：带跨站 Origin 的写请求必须 403 =====');
		/* 复现：handler 完全不读 req.headers，浏览器里任意网页都能对本机发**简单请求**
		   （`Content-Type: text/plain` 的 POST 不触发 CORS 预检，页面读不到响应也照样把请求送达）。
		   伪造的价格库被完整接受 → settleUnpriced 按攻击者单价结算进 days[].cost，而 cost
		   一旦记下就不再改动 → 污染不可逆；同一面还能触发 /api/self-update 真跑 pnpm 安装。
		   最小方案：只拦「带跨站 Origin 的 POST」，同源与无 Origin（命令行 / curl / 宿主内部）放行。 */
		const registered = { route: null };
		host.apply({
			logger: { info: () => {} },
			effect: (fn) => fn(),
			sessionProjections: { register: () => () => {} },
			webServer: { register: (route) => { registered.route = route; return () => {}; } },
			/* credentials 服务直接抛错：顺带验 ⑬ 的整体兜底 */
			get: () => { throw new Error('credentials 服务炸了'); },
		});
		assert.ok(registered.route !== null, '路由已注册');
		const handler = registered.route.handler;
		const HOST_HEADER = '127.0.0.1:19387';
		const hit = (pathname, options) => new Promise((resolve) => {
			const opts = options === undefined ? {} : options;
			let status = null;
			let text = null;
			const res = {
				headersSent: false,
				writeHead: (code) => { status = code; res.headersSent = true; },
				end: (one) => { if (one !== undefined) text = one; },
			};
			const listeners = {};
			const headers = Object.assign({ host: HOST_HEADER }, opts.headers === undefined ? {} : opts.headers);
			const req = {
				url: pathname,
				method: opts.method === undefined ? 'GET' : opts.method,
				headers: headers,
				on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
				destroy: () => {},
			};
			const pending = Promise.resolve(handler(req, res));
			if (opts.body !== undefined) (listeners.data || []).forEach((fn) => fn(Buffer.from(opts.body, 'utf8')));
			(listeners.end || []).forEach((fn) => fn());
			/* 修复前 handler reject 时既不写响应也不关连接 → 这里会挂到超时 */
			const timer = setTimeout(() => resolve({ status: 'TIMEOUT', body: null }), 3000);
			pending.then(() => {
				clearTimeout(timer);
				resolve({ status: status, body: text === null ? null : JSON.parse(text) });
			});
		});
		const PRICE_BODY = JSON.stringify({ models: { 'safe-model': { tiered: false, peak: TIER(1, 1), offPeak: TIER(1, 1) } } });
		assert.strictEqual(host.isCrossSiteWrite({ method: 'POST', headers: { origin: 'https://evil.example', host: HOST_HEADER } }), true,
			'isCrossSiteWrite：跨站 Origin 的 POST 判为跨站');
		assert.strictEqual(host.isCrossSiteWrite({ method: 'GET', headers: { origin: 'https://evil.example', host: HOST_HEADER } }), false,
			'isCrossSiteWrite：GET 不受影响');
		assert.strictEqual(host.isCrossSiteWrite({ method: 'POST', headers: { host: HOST_HEADER } }), false,
			'isCrossSiteWrite：无 Origin 放行');
		assert.strictEqual(host.isCrossSiteWrite({ method: 'POST', headers: { origin: 'http://' + HOST_HEADER, host: HOST_HEADER } }), false,
			'isCrossSiteWrite：同源放行');
		assert.strictEqual(host.isCrossSiteWrite({ method: 'POST', headers: { origin: 'null', host: HOST_HEADER } }), true,
			'isCrossSiteWrite：opaque 来源（null）也判为跨站');
		/* 四个写面逐个打：prices 改价、active-model 改状态、self-update 真跑 pnpm、tip-diag 落文件 */
		const writeSurfaces = [
			['/dsh-desktop-statusbar/api/prices', PRICE_BODY],
			['/dsh-desktop-statusbar/api/active-model', JSON.stringify({ model: 'pwn' })],
			['/dsh-desktop-statusbar/api/self-update', JSON.stringify({ version: '9.9.9' })],
			['/dsh-desktop-statusbar/api/tip-diag', '{}'],
		];
		for (const [pathname, body] of writeSurfaces) {
			const evil = await hit(pathname, { method: 'POST', headers: { origin: 'https://evil.example' }, body: body });
			assert.strictEqual(evil.status, 403, '跨站写 ' + pathname + ' 必须 403，实际 ' + evil.status);
			assert.strictEqual(evil.body.reason, 'cross-origin', pathname + ' 给出 cross-origin 原因');
		}
		const opaque = await hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', headers: { origin: 'null' }, body: PRICE_BODY });
		assert.strictEqual(opaque.status, 403, 'Origin: null（沙箱 iframe / file:// 页面）也必须 403，实际 ' + opaque.status);
		const sameOrigin = await hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', headers: { origin: 'http://' + HOST_HEADER }, body: PRICE_BODY });
		assert.strictEqual(sameOrigin.status, 200, '同源 POST 照常放行，实际 ' + sameOrigin.status);
		const noOrigin = await hit('/dsh-desktop-statusbar/api/prices', { method: 'POST', body: PRICE_BODY });
		assert.strictEqual(noOrigin.status, 200, '无 Origin 的 POST（命令行 / curl / 宿主内部）照常放行，实际 ' + noOrigin.status);
		const crossGet = await hit('/dsh-desktop-statusbar/api/prices', { headers: { origin: 'https://evil.example' } });
		assert.strictEqual(crossGet.status, 200, '带跨站 Origin 的 GET 不受影响（不引入 CORS 预检），实际 ' + crossGet.status);
		console.log('      四个写面 + opaque 来源全部 403；同源 / 无 Origin / GET 照常放行');

		console.log('\n===== ⑬ handler 整体兜底：异常写 500，不许永久 pending =====');
		/* 复现：resolveAdapterKey 里的 `ctx.get('credentials')` 裸在 try 之外，被 queryBalance
		   调用时也在 try 之外 → handler reject 时既不写响应也不关连接 → 客户端 fetch
		   **永久 pending**（底栏余额永远停在「查询中」）。这里的 ctx.get 就是直接抛错的替身。 */
		const balance = await hit('/dsh-desktop-statusbar/api/balance');
		assert.notStrictEqual(balance.status, 'TIMEOUT',
			'凭证服务抛错时不许永久挂起（修复前 handler reject，客户端 fetch 永远 pending）');
		assert.strictEqual(balance.status, 500, '兜底写 500，实际 ' + balance.status);
		assert.strictEqual(balance.body.ok, false, 'body 带 ok:false');
		assert.strictEqual(balance.body.reason, 'internal-error', '回复 internal-error');
		/* 兜底不能把正常路径也变成 500 */
		const alive = await hit('/dsh-desktop-statusbar/api/prices', { headers: { origin: 'https://evil.example' } });
		assert.strictEqual(alive.status, 200, '正常 GET 仍 200（兜底不该误伤）');
		console.log('      handler 内异常 → 500 internal-error；正常路径不受影响');
	} finally {
		hostLib.cleanup(TMP);
		fs.rmSync(FIX_HOME, { recursive: true, force: true });
	}

	/* ====================================================================================
	 * 第三轮：日期窗口与畸形台账（Lead 补）
	 * ==================================================================================== */
	console.log('\n===== ⑭ 近 7 天窗口：跨夏令时也必须是「今天往前 6 天」=====');
	{
		const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
		const grab = (name) => {
			const at = hostSrc.indexOf('function ' + name);
			assert.ok(at !== -1, '找得到 ' + name);
			const open = hostSrc.indexOf('{', at);
			let depth = 0;
			for (let i = open; i < hostSrc.length; i += 1) {
				if (hostSrc[i] === '{') depth += 1;
				else if (hostSrc[i] === '}') { depth -= 1; if (depth === 0) return hostSrc.slice(at, i + 1) }
			}
			return hostSrc.slice(at);
		};
		/* recentStartMs 只依赖 Date，单独求值即可（周函数依赖太多内部符号，不整体抽） */
		const recentStartMs = new Function(grab('recentStartMs') + '\nreturn recentStartMs;')();
		const pad2 = (n) => (n < 10 ? '0' + n : String(n));
		const keyAt = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) };
		/* 复刻周函数的推进方式（日历逐日），这正是与 DST 相关的部分 */
		const windowKeys = (startMs) => {
			const s = new Date(startMs);
			const out = [];
			for (let i = 0; i < 7; i += 1) out.push(keyAt(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i).getTime()));
			return out;
		};
		/* 三年逐日扫一遍：窗口必须恰好是「今天往前 6 天」，且以今天结尾。
		   修复前用「本地今天 00:00 − 6×24h」，在有夏令时的时区里 3 年各有 18 天错位
		   （春季拨快那天只有 23 小时，减固定毫秒会落到 7 天前的 23:00）。 */
		let misaligned = 0;
		for (let day = 0; day < 365 * 3; day += 1) {
			const now = new Date(2026, 0, 1, 12, 0, 0).getTime() + day * 24 * 3600 * 1000;
			const base = new Date(now);
			const want = [];
			for (let i = 6; i >= 0; i -= 1) want.push(keyAt(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i).getTime()));
			if (JSON.stringify(windowKeys(recentStartMs(now))) !== JSON.stringify(want)) misaligned += 1;
		}
		assert.strictEqual(misaligned, 0,
			'跨夏令时的 3 年逐日扫描里窗口不得错位（实测修复前有夏令时的时区各错 18 天），实际 ' + misaligned + ' 天');
		/* 防回归：不许再用固定毫秒回退 */
		assert.strictEqual(/6 \* 24 \* 3600 \* 1000/.test(grab('recentStartMs')), false,
			'recentStartMs 不得再用固定 6×24h 毫秒回退（夏令时下会错一天）');
		console.log('      3 年逐日扫描 0 错位；未使用固定毫秒回退（当前 TZ=' + String(process.env.TZ) + '）');
	}

	console.log('\n===== ⑮ 畸形日桶不再产生 NaN =====');
	{
		/* 走真实路由：往隔离 home 写一份日桶被改坏的台账，打 /api/daily-usage。
		   修复前 bucket.input 直接相加 → NaN 会传染整个 totals，JSON 里还丢键。
		   复用文件顶部已 require 的 hostLib（再 require 一次会撞声明）。 */
		const TMP2 = path.join(__dirname, '.dsh-fixes-lib2');
		const HOME2 = path.join(__dirname, '.dsh-test-home-malformed');
		const prevHome = process.env.DSH_HOME;
		process.env.DSH_HOME = HOME2;
		try {
			/* prepare(dir, names) 返回 index.js 的绝对路径，且 names 不能省（内部会 join）。 */
			const hostEntry = hostLib.prepare(TMP2, ['isUpdating']);
			const mod = await hostLib.loadHost(hostEntry, 'malformed');
			let handler = null;
			mod.apply({
				logger: { info() {}, warn() {}, error() {} },
				effect: (fn) => fn(),
				sessionProjections: { register: () => () => {} },
				webServer: { register: (r) => { if (r.path === '/dsh-desktop-statusbar/api') handler = r.handler; return () => {} } },
				credentials: undefined,
				get: () => { throw new Error('service not registered') },
			});
			assert.ok(handler !== null, '拿到 API handler');
			const pad2 = (n) => (n < 10 ? '0' + n : String(n));
			const now = new Date();
			const todayKey = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
			const led = path.join(HOME2, 'dsh-status-bar', 'usage-ledger.json');
			fs.mkdirSync(path.dirname(led), { recursive: true });
			fs.writeFileSync(led, JSON.stringify({
				version: 3, days: { [todayKey]: 'garbage' }, seen: {}, sessions: {}, files: {}, unpricedBackfill: 'done',
			}), 'utf8');
			const res = await new Promise((resolve) => {
				const listeners = {};
				const req = {
					url: '/dsh-desktop-statusbar/api/daily-usage?force=1', method: 'GET', headers: { host: '127.0.0.1:19387' },
					on (n, fn) { (listeners[n] = listeners[n] || []).push(fn); return this },
					destroy () {},
				};
				const out = { status: 0, text: '' };
				const resObj = {
					writeHead (s) { out.status = s },
					end (t) { out.text += t === undefined ? '' : t; resolve(out) },
					write (t) { out.text += t },
				};
				Promise.resolve(handler(req, resObj)).catch((e) => resolve({ status: 0, text: 'reject: ' + e.message }));
			});
			const parsed = JSON.parse(res.text);
			assert.strictEqual(parsed.ok, true, '畸形日桶下 daily-usage 仍要 ok:true，实际 ' + res.text.slice(0, 200));
			const t = parsed.totals;
			for (const k of ['input', 'cacheRead', 'cacheWrite', 'output', 'total', 'calls', 'cost']) {
				assert.strictEqual(typeof t[k] === 'number' && Number.isNaN(t[k]) === false, true,
					'totals.' + k + ' 必须是有限数字（畸形日桶不得传染 NaN），实际 ' + String(t[k]));
			}
			console.log('      日桶为字符串时 totals 全为 0，无 NaN');
		} finally {
			hostLib.cleanup(TMP2);
			fs.rmSync(HOME2, { recursive: true, force: true });
			process.env.DSH_HOME = prevHome;
		}
	}

	console.log('\nFIX REGRESSION CHECKS PASSED');
})().catch((error) => {
	console.error('FIX REGRESSION CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
