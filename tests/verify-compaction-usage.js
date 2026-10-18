/**
 * compaction/summary 费用漏计的修复断言（task-6）。
 *
 * 背景：压缩引擎发起摘要调用时会落一条 compaction/summary，data.usage 是那次调用的真实用量。
 * 旧实现只认 assistant/message 与 assistant/attempt，这 4 笔摘要（真实会话里全部带用量）
 * 整笔漏掉，「本轮费用」和「总计费用」都比实际少。
 *
 * 真实样本（~/.dsh/sessions 里 session-174511f8 的 seq=4624）：
 *   data = { compactionId:'6e5261f3-…', provider:'workbuddy', model:'deepseek-v4.1-flash',
 *            usage:{ inputTokens:496385, cacheReadTokens:1152, outputTokens:4186, totalTokens:501723 } }
 *   同事务 compaction/start(seq 4623, data.turn=22)、compaction/end(seq 4626)；summary 没有 turn。
 *
 * 归轮规则（task 描述）：
 *   ① 映射到数字 turn 且等于当前 turn → 总计 + 本轮
 *   ② 映射到数字 turn 但不等当前轮、或映射为 null（轮间/手动压缩）→ 只进总计
 *   ③ 无映射（日志截断/旧版本）→ 兜底归当前轮，不抛错
 *   另：同一 compactionId 只计一次；窗口内同 usage 分量的 assistant call 存在时跳过后到的 summary。
 *
 * 用法：node tests/verify-compaction-usage.js
 */
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* apply() 会预热扫一次台账（读会话日志、必要时落盘）：把 DSH_HOME 指到隔离目录 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home-compaction-usage');

/* 假 ctx 不会跑 effect 的 cleanup，插件里的定时器会吊住进程：让它别真的起定时器 */
globalThis.setInterval = () => 0;

/* 时间统一往后走：防双计按「start 到 summary 之间」圈窗口，事件顺序必须靠时间能分辨 */
let clock = Date.now()
const tick = () => (clock += 1000)

/* 真实摘要样本的用量（原文照抄，测试按它手算） */
const SUMMARY_USAGE = { inputTokens: 496385, cacheReadTokens: 1152, outputTokens: 4186, totalTokens: 501723 };
const SUMMARY_PROVIDER = 'workbuddy';
const SUMMARY_MODEL = 'deepseek-v4.1-flash';

const assistantMessage = (turn, usage, model) => ({
	type: 'assistant/message',
	time: tick(),
	data: {
		turn,
		step: 1,
		message: { source: { kind: 'model', provider: 'workbuddy', model } },
		usage
	}
})
const compactionStart = (compactionId, turn) => ({
	type: 'compaction/start', time: tick(), data: { compactionId, turn }
})
const compactionSummary = (compactionId, usage, model) => ({
	type: 'compaction/summary',
	time: tick(),
	data: {
		compactionId,
		provider: SUMMARY_PROVIDER,
		model: model === undefined ? SUMMARY_MODEL : model,
		usage: usage === undefined ? SUMMARY_USAGE : usage
	}
})
const applyAll = (proj, state, events) => events.reduce((one, event) => proj.apply(one, event), state);
/* 上一个定义必须带分号：下一行以 `(` 开头，没有分号会被解析成「调用箭头函数返回值的表达式」，
   整个 IIFE 就被吞掉了（文件能通过 --check，但一行都不执行）。 */

(async () => {
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	const registered = [];
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: (p) => { registered.push(p); return () => {}; } },
		webServer: { register: () => () => {} },
		credentials: undefined
	});

	const proj = registered.filter((p) => p.key === 'desktopStatusbarUsage')[0];
	assert.ok(proj !== undefined, 'usage 投影已注册');
	assert.strictEqual(proj.stateVersion, 8, 'usage 投影 stateVersion 升到 8（新增 summaryParts + 手动压缩刷新本轮）');
	let state = proj.init();
	proj.stateSchema.parse(state);

	/* ---------- a + b：同轮摘要既进本轮也进总计，型号取 summary 自己的 data.model ----------
	   这一段就是「**自动压缩累加到当前轮**」的守护用例：自动压缩是对话进行中达到阈值时
	   触发的，`compaction/start` 的 turn = 当前轮号 ⇒ 映射到 stateTurn ⇒ belongsToCurrent
	   命中 ⇒ 这笔摘要**累加**进本轮（不是替换）。用户明确要求过这一点。
	   断言里本轮 input 必须同时含两笔 assistant 与摘要那 496385 —— 谁把这条改成「替换」
	   或者「不进本轮」，这里立刻红。 */
	const A = { inputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 200 };
	const B = { inputTokens: 500, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 100 };
	state = applyAll(proj, state, [
		assistantMessage(2, A, 'deepseek-v4-pro'),      // 先建立当前轮（state.turn=2、current 非空）
		compactionStart('cmp-a', 2),                    // 本轮的压缩事务
		compactionSummary('cmp-a'),                     // 摘要：data 没有 turn，靠映射归到 turn 2
		assistantMessage(2, B, 'deepseek-v4-pro')
	]);
	proj.stateSchema.parse(state);
	assert.strictEqual(state.current.input, 1000 + 496385 + 500, '本轮 input = 两笔 assistant + 一笔摘要');
	assert.strictEqual(state.current.cacheRead, 100 + 1152 + 50, '本轮 cacheRead 含摘要');
	assert.strictEqual(state.current.output, 200 + 4186 + 100, '本轮 output 含摘要');
	assert.strictEqual(state.current.calls.length, 3, '本轮逐条明细也含摘要那一笔');
	assert.strictEqual(state.current.calls[1].model, SUMMARY_MODEL, '摘要那笔用 summary 的 data.model');
	/* 总计：models 按模型分别累计，摘要模型那项必须出现且数字与样本一致 */
	assert.deepStrictEqual(state.models[SUMMARY_MODEL], {
		input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186
	}, '总计里摘要按自己的模型计：真实样本 496385 / 1152 / 4186');
	assert.deepStrictEqual(state.models['deepseek-v4-pro'], {
		input: 1500, cacheRead: 150, cacheWrite: 0, output: 300
	}, '正常 assistant 两笔照旧累计');
	assert.strictEqual(state.calls.length, 3, 'calls（总计逐条）也追加了摘要');

	/* ---------- c：同一 compactionId 重复到达 → 只计一次 ---------- */
	const beforeDuplicate = JSON.stringify({ models: state.models, calls: state.calls, current: state.current });
	state = proj.apply(state, compactionSummary('cmp-a'));
	proj.stateSchema.parse(state);
	assert.strictEqual(
		JSON.stringify({ models: state.models, calls: state.calls, current: state.current }),
		beforeDuplicate,
		'同一 compactionId 的重复 summary 不再计费'
	);

	/* ---------- c2【A2 回归】没有 compactionId 的摘要也要防双计 ----------
	   上游正常情况下总会带 id（`compaction/start` 那边也有 `id 为空就丢弃` 的防护），
	   但事件缺 id 的坏数据一旦出现，旧实现的两道防护会**同时失效**：
	     · `counted.includes(compactionId)` 要求 id 非空 → 跳过
	     · `duplicate` 检查要求有 opened 映射 → 空 id 查不到 → 跳过
	   结果是同一条 summary 事件重放几次就计几次（费用与用量**同步**翻倍）。
	   修法：拿不到 id 时退回 `event.seq`（与本文件 usageEventKey 的既有做法一致）——
	   同一事件的 seq 相同、不同事件必然不同，既能防重放又不丢真实用量。 */
	let noId = proj.init();
	const noIdSummary = { type: 'compaction/summary', time: 1792300000900, seq: 4242, data: {
		model: SUMMARY_MODEL, provider: SUMMARY_PROVIDER, usage: SUMMARY_USAGE } };   /* 故意不带 compactionId */
	noId = proj.apply(noId, noIdSummary);
	proj.stateSchema.parse(noId);
	const afterFirstNoId = JSON.stringify({ models: noId.models, calls: noId.calls, parts: noId.summaryParts });
	assert.strictEqual(noId.calls.length, 1, '第一笔无 id 摘要正常计入（不丢真实用量）');
	noId = proj.apply(noId, noIdSummary);        /* 同一事件（同 seq）重放 */
	proj.stateSchema.parse(noId);
	assert.strictEqual(
		JSON.stringify({ models: noId.models, calls: noId.calls, parts: noId.summaryParts }),
		afterFirstNoId,
		'无 compactionId 的同一事件重放时不得重复计费（靠 event.seq 兜底身份）'
	);
	console.log('无 compactionId 的摘要：正常计入且重放不重复');

	/* ---------- d：摘要属于本轮之前 → 只进总计，不动 current ---------- */
	let older = proj.init();
	older = applyAll(proj, older, [assistantMessage(2, A, 'deepseek-v4-pro')]);
	const currentBefore = JSON.stringify(older.current);
	older = applyAll(proj, older, [compactionStart('cmp-old', 1), compactionSummary('cmp-old')]);
	proj.stateSchema.parse(older);
	assert.strictEqual(JSON.stringify(older.current), currentBefore, '上一轮的摘要不并进当前轮');
	assert.strictEqual(older.models[SUMMARY_MODEL].input, 496385, '但总计照记');
	assert.strictEqual(older.calls.length, 2, '总计逐条里也有这笔');

	/* ---------- e：会话起标题的请求本身不带 usage，不能重复计算 ---------- */
	let titled = proj.init();
	titled = applyAll(proj, titled, [
		{ type: 'session/title-llm-request', time: tick(), data: { route: { provider: 'workbuddy', model: 'title-model' }, messages: [], system: '', maxTokens: 64 } },
		assistantMessage(1, A, 'main-model')
	]);
	proj.stateSchema.parse(titled);
	assert.strictEqual(titled.calls.length, 1, 'title-llm-request 自身不产生费用');
	assert.strictEqual(titled.models['title-model'], undefined, '标题请求的型号不落进账本');
	assert.strictEqual(titled.models['main-model'].input, 1000, '标题响应那条 assistant/message 只计一次');

	/* ---------- f：找不到 start 映射的 summary → 兜底归当前轮，且不抛错 ---------- */
	let orphan = proj.init();
	orphan = applyAll(proj, orphan, [
		assistantMessage(3, A, 'deepseek-v4-pro'),
		compactionSummary('cmp-orphan')                 // 日志里没有对应的 compaction/start
	]);
	proj.stateSchema.parse(orphan);
	assert.strictEqual(orphan.current.input, 1000 + 496385, '无映射时兜底进当前轮');
	assert.strictEqual(orphan.calls.length, 2, '总计也记了这笔');

	/* ---------- g：防旧宿主双计 —— 窗口内已有同 usage 的 assistant call，跳过后到的 summary ---------- */
	let doubled = proj.init();
	const same = { inputTokens: 496385, cacheReadTokens: 1152, cacheWriteTokens: 0, outputTokens: 4186 };
	doubled = applyAll(proj, doubled, [
		compactionStart('cmp-dup', 2),
		assistantMessage(2, same, SUMMARY_MODEL),       // 旧宿主可能两边都发：这一笔与 summary 用量完全相同
		compactionSummary('cmp-dup')
	]);
	proj.stateSchema.parse(doubled);
	assert.strictEqual(doubled.calls.length, 1, '重复的那笔摘要被跳过');
	assert.strictEqual(doubled.models[SUMMARY_MODEL].input, 496385, '总计没有被算两遍');
	assert.strictEqual(doubled.current.input, 496385, '本轮也没有翻倍');

	/* ---------- h：summary 没有 data.model 时直接跳过，不落回 routeModel ---------- */
	let noModel = proj.init();
	noModel = applyAll(proj, noModel, [
		{ type: 'model/selection', time: tick(), data: { model: 'route-model', provider: 'workbuddy' } },
		{ type: 'compaction/start', time: tick(), data: { compactionId: 'cmp-nomodel', turn: 1 } },
		{ type: 'compaction/summary', time: tick(), data: { compactionId: 'cmp-nomodel', provider: 'workbuddy', usage: SUMMARY_USAGE } }
	]);
	proj.stateSchema.parse(noModel);
	assert.strictEqual(noModel.calls.length, 0, '没型号就放弃这笔，不落到 routeModel 上算错账');

	/* ---------- i：turn=null 的摘要（轮间 / 手动压缩）**要刷新本轮** ----------
	   用户原话：「手动压缩的时候，上一轮对话明显已经结束了，此时本轮显示的数字依旧是
	   上一轮对话产生的费用，而不是本次手动压缩产生的费用。」
	   所以这里的行为从「只进总计、current 逐字不变」改成了「只进总计，并且把 current
	   **替换成只含这一笔**」—— 上一轮已结束，继续显示旧数字是误导。
	   注意是**替换**不是累加：压缩那笔不代表新一轮的起点，新一轮会从 0 重新算。 */
	let interTurn = proj.init();
	interTurn = applyAll(proj, interTurn, [assistantMessage(2, A, 'deepseek-v4-pro')]);
	const currentSnapshot = JSON.stringify(interTurn.current);
	const modelsSnapshot = JSON.stringify(interTurn.models);
	interTurn = applyAll(proj, interTurn, [
		compactionStart('cmp-interturn', null),        // 轮间/手动压缩：start 的 turn 是 null
		compactionSummary('cmp-interturn')
	]);
	proj.stateSchema.parse(interTurn);
	/* current 必须刷新成"只含这一笔摘要"，而不是继续保持上一轮的对话用量 */
	assert.notStrictEqual(JSON.stringify(interTurn.current), currentSnapshot,
		'turn=null 的摘要要刷新本轮（上一轮已结束，不能继续显示旧数字）');
	assert.strictEqual(interTurn.current.calls.length, 1, '本轮只含这一笔压缩（替换而非累加）');
	assert.deepStrictEqual(
		{ input: interTurn.current.input, cacheRead: interTurn.current.cacheRead, cacheWrite: interTurn.current.cacheWrite, output: interTurn.current.output },
		{ input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186 },
		'本轮的 token 就是这笔压缩的用量');
	assert.strictEqual(interTurn.current.model, SUMMARY_MODEL, '本轮的模型是摘要自己的模型');
	assert.notStrictEqual(JSON.stringify(interTurn.models), modelsSnapshot, '但总计 models 也增加了');
	assert.deepStrictEqual(interTurn.models[SUMMARY_MODEL], {
		input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186
	}, '总计按摘要自己的模型累计（真实样本数字）');
	assert.strictEqual(interTurn.calls.length, 2, '总计 calls 也追加了这笔摘要');


	/* ---------- i2：手动压缩刷新本轮之后，**下一轮从 0 开始、不叠加压缩那一笔** ----------
	   用户确认的边界：压缩那笔只是「本轮」的一次临时显示，新轮次开始时正常清零重算。
	   验证方式：紧接上面（本轮此刻 = 压缩那一笔），喂一个真正的新一轮 assistant 事件，
	   断言本轮的 token 只剩新轮那一条，**不含**压缩的 496385。 */
	const nextTurnCall = { input: 777, cacheRead: 0, cacheWrite: 0, output: 999 };
	interTurn = applyAll(proj, interTurn, [{
		type: 'assistant/message',
		time: 1792306300000,
		data: {
			turn: 5,   /* 比上一轮（turn 2）大，明确是新轮 */
			message: { kind: 'assistant', source: { kind: 'model', model: 'deepseek-v4-pro', provider: 'workbuddy' } },
			usage: {
				inputTokens: nextTurnCall.input,
				cacheReadTokens: nextTurnCall.cacheRead,
				cacheWriteTokens: nextTurnCall.cacheWrite,
				outputTokens: nextTurnCall.output
			}
		}
	}]);
	proj.stateSchema.parse(interTurn);
	assert.strictEqual(interTurn.current.calls.length, 1, '新轮次的本轮只含这一条（压缩那笔不并进来）');
	assert.deepStrictEqual(
		{ input: interTurn.current.input, output: interTurn.current.output },
		{ input: nextTurnCall.input, output: nextTurnCall.output },
		'新轮次从 0 开始累加，不叠加压缩那一笔（输入的 ' + nextTurnCall.input + ' ≠ 496385 + ' + nextTurnCall.input + '）');
	assert.strictEqual(interTurn.current.input !== 496385 + nextTurnCall.input, true,
		'明确断言：本轮输入**不是**「压缩 + 新轮」的叠加值');
	/* 总计不受影响：压缩那笔仍在总计里（这是它该在的地方） */
	assert.deepStrictEqual(interTurn.models[SUMMARY_MODEL], {
		input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186
	}, '压缩那笔仍完整留在总计里（只影响本轮的显示，不影响账本）');
	console.log('手动压缩刷新本轮 → 下一轮从 0 开始、不叠加压缩那笔');
	/* ---------- i1：summaryParts 必须**真的累计**摘要用量 ----------
	   客户端「总计用量」读的是官方 tokenUsage 投影（不含摘要），要靠宿主这份 summaryParts
	   把摘要补回去。所以宿主侧必须把每笔摘要的四段累加进它 —— 这个字段恒为 0 时，
	   客户端那边再怎么加也加不出东西（用户看到的还是"费用含摘要、用量不含"）。
	   同时验证它**只含摘要**：上面的 assistantMessage 那笔不该混进来。 */
	assert.deepStrictEqual(interTurn.summaryParts, {
		input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186
	}, 'summaryParts 累计了摘要的四段（且只含摘要，不含普通调用）');
	/* 再喂第二笔摘要：必须**累加**（不是覆盖） */
	interTurn = applyAll(proj, interTurn, [
		compactionStart('cmp-second', null),
		compactionSummary('cmp-second')
	]);
	proj.stateSchema.parse(interTurn);
	assert.deepStrictEqual(interTurn.summaryParts, {
		input: 496385 * 2, cacheRead: 1152 * 2, cacheWrite: 0, output: 4186 * 2
	}, '第二笔摘要要累加进 summaryParts（不是覆盖）');
	console.log('summaryParts 累计摘要用量（两笔相加，只含摘要）');

	/* ---------- j：MAX_CALLS 截断与摘要组合 —— 共用 addCallTotals，挤掉的那条必须精确进 overflow ---------- */
	/* 被挤掉的永远是 calls 队首（最老）那条：这里把它造成独特分量，好在 overflow 里认出来 */
	const bulkCalls = [];
	for (let i = 0; i < 4000; i += 1) {
		bulkCalls.push({ at: i + 1, model: 'bulk-model', input: i + 1, cacheRead: 0, cacheWrite: 0, output: 0 });
	}
	const overflowTotal = (overflow) => {
		const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		for (const tier of Object.values(overflow === undefined || overflow === null ? {} : overflow)) {
			for (const part of [tier.peak, tier.offPeak]) {
				total.input += part.input;
				total.cacheRead += part.cacheRead;
				total.cacheWrite += part.cacheWrite;
				total.output += part.output;
			}
		}
		return total;
	};

	/* 3999 条时追加摘要：4000 条刚好到上限，不触发截断、overflow 保持空 */
	let notFull = { ...proj.init(), calls: bulkCalls.slice(0, 3999), turn: 4000 };
	notFull = applyAll(proj, notFull, [compactionStart('cmp-fill', null), compactionSummary('cmp-fill')]);
	proj.stateSchema.parse(notFull);
	assert.strictEqual(notFull.calls.length, 4000, '3999 + 1 笔摘要 = 4000，恰好到上限');
	assert.deepStrictEqual(overflowTotal(notFull.overflow), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, '没到上限不挤掉任何一条');

	/* 4000 条时追加摘要：calls 仍 4000，最老那条（input=1）精确进 overflow */
	let full = { ...proj.init(), calls: bulkCalls, turn: 4000 };
	full = applyAll(proj, full, [compactionStart('cmp-overflow', null), compactionSummary('cmp-overflow')]);
	proj.stateSchema.parse(full);
	assert.strictEqual(full.calls.length, 4000, '超过 MAX_CALLS 仍截回 4000');
	assert.strictEqual(full.calls[full.calls.length - 1].model, SUMMARY_MODEL, '摘要那笔留在队尾（刚发生的）');
	assert.deepStrictEqual(overflowTotal(full.overflow), {
		input: 1, cacheRead: 0, cacheWrite: 0, output: 0
	}, '被挤掉的最老一条（input=1）精确进 overflow，token 一个不少');
	assert.deepStrictEqual(full.models[SUMMARY_MODEL], {
		input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186
	}, '摘要照常进 models');

	console.log('压缩摘要费用:', JSON.stringify({
		stateVersion: proj.stateVersion,
		summaryModel: state.models[SUMMARY_MODEL],
		current: { input: state.current.input, cacheRead: state.current.cacheRead, output: state.current.output, calls: state.current.calls.length }
	}));
	console.log('\nCOMPACTION USAGE CHECKS PASSED');
})().catch((error) => {
	console.error('COMPACTION USAGE CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});

