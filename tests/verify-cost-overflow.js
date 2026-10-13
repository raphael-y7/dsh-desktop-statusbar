/**
 * 长会话费用回归：host 的 calls 被 MAX_CALLS 截断后，客户端「总计费用」必须
 * 把截掉的那部分（overflow）补回来，否则用量是全量、费用是残缺的。
 *
 * 修复前实测：5000 次调用低估 22.7%，2 万次低估 80%。
 * 这里用真实投影逻辑（不桩）跑一份 5000 条调用的会话，比对三条数：
 *   基准（一条不丢） / 修复前（只算保留） / 修复后（保留 + overflow）
 *
 * 用法：node tests/verify-cost-overflow.js
 */
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* 隔离真实家目录：apply 会预热台账，别让它扫真实会话 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home-cost-overflow');
globalThis.setInterval = () => 0;

/* ---------------------------------------------------------------- 价格与峰谷
   与 lib/index.js 的官方参考价同口径（元/百万 token）。 */
const PRICE = {
	peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
	offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
};
/* 峰谷判定：北京时间工作日 9-12 / 14-18（简化掉节假日，本用例的时刻都落在普通工作日） */
function isPeak(ms) {
	const d = new Date(ms + 8 * 3600 * 1000);
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	const h = d.getUTCHours();
	return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function costOfTier(bucket, peak) {
	const tier = peak === true ? PRICE.peak : PRICE.offPeak;
	return ((bucket.input || 0) * tier.input + (bucket.cacheRead || 0) * tier.cacheRead
		+ (bucket.cacheWrite || 0) * tier.cacheWrite + (bucket.output || 0) * tier.output) / 1e6;
}

/* ---------------------------------------------------------------- 取真实投影 */
/** 从 host 模块里把 sessionUsage 投影拿回来。
 *  注意 apply 会注册**多个**投影（模型/容量/进度/用量/活跃时间/时序），
 *  只留最后一个会拿错对象 —— 必须按 key 找 desktopStatusbarUsage。 */
async function loadProjection(tag) {
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/') + '?overflow=' + tag);
	const registered = [];
	mod.apply({
		logger: { info: () => {}, warn: () => {}, error: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: (p) => { registered.push(p); return () => {}; } },
		webServer: { register: () => () => {} },
		credentials: undefined,
	});
	const projection = registered.find((p) => p.key === 'desktopStatusbarUsage');
	assert.ok(projection !== undefined, '找到了 sessionUsage 投影（共注册 ' + registered.length + ' 个）');
	return projection;
}

(async () => {
	const projection = await loadProjection('main');

	const TOTAL = 5000; /* 超过 MAX_CALLS(4000)，必然触发截断 */
	const MODEL = 'deepseek-flash';
	const one = () => ({ input: 29631, cacheRead: 1900000, cacheWrite: 0, output: 41007 });
	const baseAt = Date.UTC(2026, 9, 14, 0, 0, 0); /* 普通周三，覆盖高峰与空闲两档 */

	/* 逐条喂给真实投影，模拟 host 收到 5000 次 assistant 事件 */
	let state = projection.init();
	const allCalls = [];
	for (let i = 0; i < TOTAL; i += 1) {
		const at = baseAt + i * 60000;
		const usage = one();
		allCalls.push({ at, model: MODEL, ...usage });
		state = projection.apply(state, {
			type: 'assistant/message',
			time: at,
			data: {
				message: { kind: 'assistant', source: { kind: 'model', model: MODEL, provider: 'deepseek-official' } },
				usage: {
					inputTokens: usage.input,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					outputTokens: usage.output,
				},
			},
		});
	}

	console.log('===== ① 投影状态 =====');
	console.log('  喂入调用数: ' + TOTAL);
	console.log('  calls 保留 : ' + state.calls.length);
	console.log('  被截掉条数 : ' + (TOTAL - state.calls.length));
	assert.ok(state.calls.length <= 4000, 'calls 受 MAX_CALLS 限制');
	assert.ok(TOTAL - state.calls.length > 0, '本用例确实触发了截断');

	console.log('\n===== ② overflow 必须把截掉的按档累计起来 =====');
	const overflow = state.overflow;
	assert.strictEqual(typeof overflow, 'object', 'state 里有 overflow');
	assert.ok(overflow !== null, 'overflow 非空');
	const ov = overflow[MODEL];
	assert.ok(ov !== undefined, 'overflow 里有本模型');
	assert.strictEqual(typeof ov.peak, 'object', 'overflow 有峰谷两档');
	assert.strictEqual(typeof ov.offPeak, 'object', 'overflow 有空闲档');
	const ovTokens = (ov.peak.input + ov.peak.cacheRead + ov.peak.cacheWrite + ov.peak.output)
		+ (ov.offPeak.input + ov.offPeak.cacheRead + ov.offPeak.cacheWrite + ov.offPeak.output);
	console.log('  overflow 合计 token: ' + ovTokens.toLocaleString('en-US'));
	assert.ok(ovTokens > 0, 'overflow 里确实有被截掉的用量');

	/* 被截掉的那些，按档分桶必须**精确**等于逐条分档的结果 */
	const dropped = allCalls.slice(0, TOTAL - state.calls.length);
	const wantPeak = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const wantOff = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	for (const call of dropped) {
		const target = isPeak(call.at) ? wantPeak : wantOff;
		target.input += call.input;
		target.cacheRead += call.cacheRead;
		target.cacheWrite += call.cacheWrite;
		target.output += call.output;
	}
	assert.deepStrictEqual(ov.peak, wantPeak, '峰值档累计与逐条分档一致');
	assert.deepStrictEqual(ov.offPeak, wantOff, '空闲档累计与逐条分档一致');
	console.log('  峰值档与空闲档的累计都与逐条分档精确一致');

	console.log('\n===== ③ 费用：修复后必须与「一条不丢」的基准一致 =====');
	let baseline = 0;
	for (const call of allCalls) baseline += costOfTier(call, isPeak(call.at));

	let retained = 0;
	for (const call of state.calls) retained += costOfTier(call, isPeak(call.at));

	const fixed = retained + costOfTier(ov.peak, true) + costOfTier(ov.offPeak, false);

	console.log('  基准（一条不丢）    : ¥' + baseline.toFixed(4));
	console.log('  修复前（只算保留）  : ¥' + retained.toFixed(4)
		+ '   低估 ' + ((baseline - retained) / baseline * 100).toFixed(1) + '%');
	console.log('  修复后（含 overflow）: ¥' + fixed.toFixed(4));
	assert.ok(retained < baseline * 0.9, '本用例确实能暴露「只算保留会低估」');
	assert.ok(Math.abs(fixed - baseline) < 1e-6, 'overflow 补齐后与基准一致，实际偏差 ' + Math.abs(fixed - baseline));
	console.log('  补齐后与基准一致（偏差 < 1e-6）');

	console.log('\nCOST OVERFLOW CHECKS PASSED');
})().catch((error) => {
	console.error('COST OVERFLOW CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
