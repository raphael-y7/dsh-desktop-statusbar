/**
 * host 侧 desktopStatusbarTiming 投影测试：逐次调用的首字/输出速度极值。
 * 计时口径：TPS 分母按**解码窗口可信度**结构判据选（没有速度阈值、不按数值过滤）——
 *   解码窗口可信 = decode ≥ 300ms 且 decode ≥ 15% × request；
 *   有 reasoning 且解码可信 → 解码窗口（标准 TPS）；否则（隐藏思维链 / 缓冲）→ 请求窗口（端到端吞吐）。
 * TTFT = step/start → 首 token，极值不做任何上限过滤（108s 如实显示，含 message 兜底）。
 * 测量精度门槛（仅此）：output>0、选定窗口≥300ms、非工具首片；极值与本轮平均同一口径。
 * 用法：node verify-timing.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* apply() 会预热扫一次台账（读会话日志、必要时落盘）。把 DSH_HOME 指到 tests/ 下的
   隔离目录，别让测试读写这台机器上的真实台账 ~/.dsh/dsh-status-bar/ 。 */
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-test-home-'));
process.env.DSH_HOME = TEMP_HOME;

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

(async () => {
	const hostSource = fs.readFileSync(INDEX, 'utf8');
	const parserStart = hostSource.indexOf('function relayPathSegments(path) {');
	const parserEnd = hostSource.indexOf('\nfunction relayValueAt(', parserStart);
	assert.ok(parserStart >= 0 && parserEnd > parserStart, 'relayPathSegments source found');
	const relayPathSegments = vm.runInNewContext('(' + hostSource.slice(parserStart, parserEnd).trim() + ')');
	const segmentsOf = (value) => {
		const result = relayPathSegments(value);
		return result === null ? null : Array.from(result);
	};
	assert.deepStrictEqual(segmentsOf('$.data.quota'), ['data', 'quota']);
	assert.deepStrictEqual(segmentsOf('$[0].quota'), [0, 'quota']);
	assert.deepStrictEqual(segmentsOf('$.items[12].balance.total'), ['items', 12, 'balance', 'total']);
	for (const invalid of ['', '$.data..quota', '$[01].quota', '$.items[-1].quota', '$.bad!']) {
		assert.strictEqual(segmentsOf(invalid), null, 'invalid path rejected: ' + invalid);
	}
	for (const key of ['__proto__', 'prototype', 'constructor']) {
		assert.strictEqual(segmentsOf('$.data.' + key + '.quota'), null, 'prototype key rejected: ' + key);
	}
	console.log('relayPathSegments parser checks passed');
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	const registered = [];
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: (p) => { registered.push(p); return () => {}; } },
		webServer: { register: () => () => {} },
		credentials: undefined
	});
	const proj = registered.filter((p) => p.key === 'desktopStatusbarTiming')[0];
	assert.ok(proj !== undefined, 'timing projection registered');
	assert.strictEqual(proj.stateVersion, 6, 'TPS 合理性回退后 stateVersion 升到 6');
	console.log('已注册投影:', registered.map((p) => p.key).join(', '));

	let state = proj.init();
	proj.stateSchema.parse(state);
	assert.strictEqual(state.fastestTtft, null, '初始没有极值');
	/* wire 视图里不该带内部边界字段（strict schema 会挡下来） */
	proj.wire.viewSchema.parse(proj.wire.view(state));
	assert.strictEqual(proj.wire.view(state).openStep, undefined, 'wire 不带 openStep');
	console.log('init 状态通过 schema:', JSON.stringify(state));

	const message = { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } };
	const step = (type, time, turn, no, extra) => Object.assign({ type, time, data: Object.assign({ turn, step: no }, extra) }, {});

	/* 第一次调用：首 token 在 t=1500，回答在 t=4000 → 首字 500ms；无 reasoning 分片 ⇒ 请求窗口 3000ms / 500 tokens */
	state = proj.apply(state, step('step/start', 1000, 1, 1));
	state = proj.apply(state, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 1200, chunk: { type: 'block-start', blockType: 'text' } },
			{ type: 'chunk', time: 1500, chunk: { type: 'text-delta', text: '你' } }]
	}));
	assert.strictEqual(state.openStep.firstTokenTime, 1500, '首 token 时间来自第一个非空分片');
	state = proj.apply(state, step('assistant/message', 4000, 1, 1, {
		message, usage: { outputTokens: 500 }, stream: []
	}));
	proj.stateSchema.parse(state);
	assert.strictEqual(state.samples, 1, '记一次样本');
	assert.strictEqual(state.fastestTtft.value, 500, '首字 = 首 token − step 开始');
	assert.strictEqual(state.slowestTtft.value, 500, '只有一个样本时最快=最慢');
	assert.strictEqual(Math.round(state.fastestTps.value), 167, '无 reasoning ⇒ 请求窗口：500 tokens / 3s');
	assert.strictEqual(state.turnDecodeMs, 3000, '本轮平均时长使用请求窗口');
	assert.strictEqual(state.turnDecodeTokens, 500, '本轮平均累计相同的 TPS 样本 tokens');
	assert.strictEqual(state.openStep, null, '消息落地后边界清空');
	console.log('第一次调用:', JSON.stringify({ ttft: state.fastestTtft.value, tps: Math.round(state.fastestTps.value) }));

	/* 第二次调用更慢的首字、更低的速度：极值要分别更新到两边 */
	state = proj.apply(state, step('step/start', 5000, 1, 2));
	state = proj.apply(state, step('assistant/attempt', 5100, 1, 2, {
		stream: [{ type: 'chunk', time: 7000, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	state = proj.apply(state, step('assistant/message', 8000, 1, 2, {
		message, usage: { outputTokens: 100 }, stream: []
	}));
	assert.strictEqual(state.samples, 2, '两次样本');
	assert.strictEqual(state.fastestTtft.value, 500, '最快首字仍是第一次');
	assert.strictEqual(state.slowestTtft.value, 2000, '最慢首字换成第二次');
	assert.strictEqual(Math.round(state.fastestTps.value), 167, '最快速度仍是第一次');
	assert.strictEqual(Math.round(state.slowestTps.value), 33, '最慢速度换成第二次（100 tokens / 3s 请求窗口）');
	assert.strictEqual(state.turnDecodeMs, 6000, '两个有效样本按 3s + 3s 请求窗口累计');
	assert.strictEqual(state.turnDecodeTokens, 600, '两个有效样本按 500 + 100 tokens 累计');
	/* 同一门槛下「本轮平均 ≤ 最快」恒成立：不会出现平均进、最快没进的口径分裂 */
	assert.ok(state.turnDecodeTokens / (state.turnDecodeMs / 1000) <= state.fastestTps.value + 1e-9,
		'本轮平均 ' + Math.round(state.turnDecodeTokens / (state.turnDecodeMs / 1000))
		+ ' 必须 ≤ 最快 ' + Math.round(state.fastestTps.value));
	console.log('极值:', JSON.stringify({
		ttft: [state.fastestTtft.value, state.slowestTtft.value],
		tps: [Math.round(state.fastestTps.value), Math.round(state.slowestTps.value)]
	}));

	/* 首 token 只在 assistant/message 的 stream 里（attempt 没给）：兜底也能取；
	   这条 stream 带 reasoning-delta ⇒ 有 reasoning ⇒ 解码窗口 2000ms。 */
	state = proj.apply(state, step('step/start', 10000, 1, 3));
	state = proj.apply(state, step('assistant/message', 13000, 1, 3, {
		message, usage: { outputTokens: 1000 },
		stream: [{ type: 'chunk', time: 11000, chunk: { type: 'reasoning-delta', text: 'think' } }]
	}));
	assert.strictEqual(state.samples, 3, 'message 里的 stream 也能取首 token（样本 +1）');
	assert.strictEqual(Math.round(state.fastestTps.value), 500, '有 reasoning ⇒ 1000 tokens / 2s 解码窗口');
	assert.strictEqual(state.turnDecodeMs, 8000, '前两笔各 3s 请求窗口 + 本笔 2s 解码窗口');
	assert.strictEqual(state.turnDecodeTokens, 1600, '三个有效样本输出 tokens 累计一致');
	console.log('首 token 兜底路径:', JSON.stringify({ samples: state.samples, tps: Math.round(state.fastestTps.value) }));

	/* 打包 run（紧凑流）：第一个非空分片在 time0 + dt[0] → 首字 1100ms（单独一份状态，极值一眼可读） */
	state = proj.init();
	state = proj.apply(state, step('step/start', 20000, 1, 4));
	state = proj.apply(state, step('assistant/message', 22000, 1, 4, {
		message, usage: { outputTokens: 200 },
		stream: [{ type: 'text-chunks', time0: 21000, texts: ['', 'a', 'b'], dt: [100, 100] }]
	}));
	assert.strictEqual(state.samples, 1, '打包 run 的 message 兜底仍计首字样本');
	assert.strictEqual(state.fastestTtft.value, 1100, 'message 兜底的首分片也能进 TTFT 极值');
	assert.strictEqual(state.turnTtftMs, 1100, 'TTFT 平均按 message 兜底样本累计');
	assert.strictEqual(Math.round(state.fastestTps.value), 100, '无 reasoning ⇒ 200 tokens / 2s 请求窗口');

	/* 带 name 的 tool-call 分片：首 token 是工具调用 ⇒ 不进 TPS 极值（速度分母不可信），
	   但 TTFT 是真实等待时间，如实进首字极值。 */
	state = proj.init();
	state = proj.apply(state, step('step/start', 30000, 1, 5));
	state = proj.apply(state, step('assistant/message', 31000, 1, 5, {
		message, usage: { outputTokens: 300 },
		stream: [{ type: 'tool-call-chunks', time0: 30500, name: 'read', args: ['{}'], dt: [0] }]
	}));
	assert.strictEqual(state.samples, 1, '首字样本照常计一次');
	assert.strictEqual(state.fastestTtft.value, 500, '工具首片的首字时间如实进极值');
	assert.strictEqual(state.turnTtftMs, 500, 'TTFT 平均累计该样本');
	assert.strictEqual(state.fastestTps, null, '纯工具调用的步骤不参与速度极值');
	assert.strictEqual(state.slowestTps, null, '同上');
	console.log('纯工具调用步：TTFT 如实进极值、TPS 不进极值');

	/* 思考增量（reasoning-chunks）与文本增量一样进速度极值：真实会话里这类占多数。
	   带 reasoning 分片 ⇒ 有流式思维链 ⇒ TPS 用首 token 到回复结束的解码窗口；
	   TTFT 仍单独从首个 reasoning 分片计算。 */
	state = proj.init();
	state = proj.apply(state, step('step/start', 40000, 1, 6));
	state = proj.apply(state, step('assistant/attempt', 40500, 1, 6, {
		stream: [{ type: 'chunk', time: 40500, chunk: { type: 'reasoning-delta', text: '想' } }]
	}));
	state = proj.apply(state, step('assistant/message', 43000, 1, 6, {
		message, usage: { outputTokens: 300 }, stream: []
	}));
	proj.stateSchema.parse(state);
	assert.strictEqual(state.fastestTtft.value, 500, 'reasoning 分片算首字');
	assert.strictEqual(Math.round(state.fastestTps.value), 120, '300 tokens / 2.5s 解码窗口');
	assert.strictEqual(state.samples, 1, 'reasoning 步骤照常计入样本');
	console.log('纯 reasoning 步：按解码窗口进极值与平均值（outputTokens 含 reasoning token）');

	/* 同一步里先思考再调工具：按首个分片定性，仍然算速度 */
	state = proj.apply(state, step('step/start', 50000, 1, 7));
	state = proj.apply(state, step('assistant/attempt', 50500, 1, 7, {
		stream: [{ type: 'chunk', time: 50500, chunk: { type: 'reasoning-delta', text: '想' } }]
	}));
	state = proj.apply(state, step('assistant/message', 52000, 1, 7, {
		message, usage: { outputTokens: 250 },
		stream: [{ type: 'tool-call-chunks', time0: 51000, name: 'read', args: ['{}'], dt: [] }]
	}));
	proj.stateSchema.parse(state);
	assert.strictEqual(state.fastestTtft.value, 500, '先思考后调工具：首字取 reasoning 分片');
	assert.strictEqual(Math.round(state.fastestTps.value), 167, '250 tokens / 1.5s 解码窗口 (tool-call chunk is not an executed-tool interval)');
	console.log('reasoning / 混合流：按首个分片定性');

	/* TTFT=3000ms，100 tokens，解码窗口 500ms；这条流**没有** reasoning 分片（text-delta）
	   ⇒ 隐藏思维链口径，用请求窗口 3500ms ⇒ 约 28.6 t/s。 */
	let longTtft = proj.init();
	longTtft = proj.apply(longTtft, step('step/start', 1000, 1, 1));
	longTtft = proj.apply(longTtft, step('assistant/attempt', 4000, 1, 1, {
		stream: [{ type: 'chunk', time: 4000, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	longTtft = proj.apply(longTtft, step('assistant/message', 4500, 1, 1, {
		message, usage: { outputTokens: 100 }, stream: []
	}));
	assert.strictEqual(longTtft.fastestTtft.value, 3000, '长 TTFT 保持 request start 到首 token');
	assert.strictEqual(longTtft.fastestTps.value, 100 / 3.5, '无 reasoning ⇒ 请求窗口：100 tokens / 3.5s');
	assert.strictEqual(Math.round(longTtft.fastestTps.value * 10) / 10, 28.6, 'TPS 约为 28.6');
	assert.strictEqual(longTtft.turnDecodeMs, 3500, '本轮平均累计请求窗口');
	assert.strictEqual(longTtft.turnDecodeTokens, 100, '本轮平均累计输出 tokens');
	console.log('长 TTFT 无 reasoning：请求窗口 3500ms ⇒ 28.6 t/s');

	/* 有 reasoning 且解码窗口可信（decode 500ms ≥ 15% × request 1500ms）⇒ 标准解码 200 t/s。 */
	let longTtftReasoning = proj.init();
	longTtftReasoning = proj.apply(longTtftReasoning, step('step/start', 3000, 1, 1));
	longTtftReasoning = proj.apply(longTtftReasoning, step('assistant/attempt', 4000, 1, 1, {
		stream: [{ type: 'chunk', time: 4000, chunk: { type: 'reasoning-delta', text: '想' } }]
	}));
	longTtftReasoning = proj.apply(longTtftReasoning, step('assistant/message', 4500, 1, 1, {
		message, usage: { outputTokens: 100 }, stream: []
	}));
	assert.strictEqual(longTtftReasoning.fastestTtft.value, 1000, '首字 1000ms（TTFT 与 TPS 分母分开）');
	assert.strictEqual(longTtftReasoning.fastestTps.value, 200, '有 reasoning 且解码可信 ⇒ 100 tokens / 0.5s = 200 t/s');
	assert.strictEqual(longTtftReasoning.turnDecodeMs, 500, '本轮平均累计解码窗口');
	console.log('长 TTFT + reasoning：500ms 解码窗口 ⇒ 200 t/s（首字等待不进分母）');

	/* 闭源隐藏思维链场景：无 reasoning 分片 ⇒ 请求窗口 3488ms ⇒ 1211 tokens / 3.488s ≈ 347 t/s，
	   不会出现 2482 t/s 的虚高（思考 token 不可见时按用户实际等待时间算）。 */
	let closedThinking = proj.init();
	closedThinking = proj.apply(closedThinking, step('step/start', 1000, 1, 1));
	closedThinking = proj.apply(closedThinking, step('assistant/attempt', 4000, 1, 1, {
		stream: [{ type: 'chunk', time: 4000, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	closedThinking = proj.apply(closedThinking, step('assistant/message', 4488, 1, 1, {
		message, usage: { outputTokens: 1211 }, stream: []
	}));
	closedThinking = proj.apply(closedThinking, step('step/end', 4500, 1, 1));
	proj.stateSchema.parse(closedThinking);
	assert.strictEqual(Math.round(closedThinking.fastestTps.value), Math.round(1211 / 3.488),
		'无 reasoning ⇒ 请求窗口 3488ms ⇒ 约 347 t/s（不是 2482 t/s 假值），实际 ' + Math.round(closedThinking.fastestTps.value));
	assert.ok(closedThinking.fastestTps.value < 1000,
		'闭源思考不可见的样本不得出现 2000+ 的虚高值，实际 ' + Math.round(closedThinking.fastestTps.value));
	console.log('闭源思考不可见：1211 tokens / 3488ms 请求窗口 ⇒ ' + Math.round(closedThinking.fastestTps.value) + ' t/s');

	/* 无 reasoning 分片（隐藏思维链）：1211 tokens / 解码 488ms 会让解码窗口算出 2482 t/s 虚高，
	   但这条流没有 reasoning ⇒ 用请求窗口 5000ms ⇒ 约 242 t/s（标准公式的结构判据）。 */
	let hiddenCot = proj.init();
	hiddenCot = proj.apply(hiddenCot, step('step/start', 0, 1, 1));
	hiddenCot = proj.apply(hiddenCot, step('assistant/attempt', 4512, 1, 1, {
		stream: [{ type: 'chunk', time: 4512, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	hiddenCot = proj.apply(hiddenCot, step('assistant/message', 5000, 1, 1, {
		message, usage: { outputTokens: 1211 }, stream: []
	}));
	proj.stateSchema.parse(hiddenCot);
	assert.strictEqual(Math.round(hiddenCot.fastestTps.value), Math.round(1211 / 5),
		'无 reasoning ⇒ 请求窗口 5s ⇒ 约 242 t/s，实际 ' + Math.round(hiddenCot.fastestTps.value));
	assert.strictEqual(hiddenCot.turnDecodeMs, 5000, '本轮平均按请求窗口 5s 累计');
	assert.ok(hiddenCot.turnDecodeTokens / (hiddenCot.turnDecodeMs / 1000)
		<= hiddenCot.fastestTps.value + 1e-9, '本轮平均仍 ≤ 最快');
	console.log('隐藏思维链 · 1211 tokens / 请求窗口 5s ⇒ ' + Math.round(hiddenCot.fastestTps.value) + ' t/s');

	/* 有 reasoning 但解码窗口只有 200ms（< 300ms）⇒ 解码不可信 ⇒ 改走请求窗口 1700ms
	   ⇒ 100 tokens / 1.7s ≈ 59 t/s（端到端吞吐，依然如实入样）。 */
	let shortDecode = proj.init();
	shortDecode = proj.apply(shortDecode, step('step/start', 1000, 1, 1));
	shortDecode = proj.apply(shortDecode, step('assistant/attempt', 2500, 1, 1, {
		stream: [{ type: 'chunk', time: 2500, chunk: { type: 'reasoning-delta', text: '想' } }]
	}));
	shortDecode = proj.apply(shortDecode, step('assistant/message', 2700, 1, 1, {
		message, usage: { outputTokens: 100 }, stream: []
	}));
	proj.stateSchema.parse(shortDecode);
	assert.strictEqual(Math.round(shortDecode.fastestTps.value), Math.round(100 / 1.7),
		'解码窗口 200ms < 300ms ⇒ 改走请求窗口 1.7s ≈ 59 t/s，实际 ' + Math.round(shortDecode.fastestTps.value));
	assert.strictEqual(shortDecode.turnDecodeMs, 1700, '本轮平均按请求窗口累计');
	assert.strictEqual(shortDecode.turnDecodeTokens, 100, '本轮平均 tokens 累计');
	console.log('解码窗口 200ms（<300ms）⇒ 端到端吞吐 1.7s：' + Math.round(shortDecode.fastestTps.value) + ' t/s');

	/* 真实会话里的缓冲样本：有 reasoning，但解码窗口只占请求窗口 4.5%（token 末尾一次性灌入），
	   解码时间戳不可信 ⇒ 端到端吞吐 1952 / 25.275s ≈ 77 t/s（不是 1725 t/s 假值）。 */
	let buffered = proj.init();
	buffered = proj.apply(buffered, step('step/start', 0, 1, 1));
	buffered = proj.apply(buffered, step('assistant/attempt', 24144, 1, 1, {
		stream: [{ type: 'chunk', time: 24144, chunk: { type: 'reasoning-delta', text: '想' } }]
	}));
	buffered = proj.apply(buffered, step('assistant/message', 25275, 1, 1, {
		message, usage: { outputTokens: 1952 }, stream: []
	}));
	proj.stateSchema.parse(buffered);
	assert.strictEqual(Math.round(buffered.fastestTps.value), Math.round(1952 / 25.275),
		'缓冲样本（decode 1.131s < 15% × 25.275s）⇒ 请求窗口 25.275s ≈ 77 t/s');
	assert.ok(buffered.fastestTps.value < 500,
		'不得出现 1725 t/s 这类缓冲虚高，实际 ' + Math.round(buffered.fastestTps.value));
	assert.strictEqual(buffered.turnDecodeMs, 25275, '本轮平均按请求窗口累计');
	console.log('缓冲样本 · 1952 tokens / 25.275s 请求窗口 ⇒ ' + Math.round(buffered.fastestTps.value) + ' t/s');

	/* 可配对的实际 tool/call 与 tool/result 事件；result 的 data.toolCallId 与 message.source.callId 对应 callId。 */
	const toolCall = (time, turn, no, callId) => step('tool/call', time, turn, no, {
		callId, name: 'read', arguments: {}
	});
	const toolResult = (time, turn, no, callId) => ({
		type: 'tool/result', time,
		data: { turn, step: no, toolCallId: callId, message: { source: { callId }, content: [] } }
	});

	/* 三个完全重叠的 1s 调用按区间并集扣 1s，不是逐个相加扣 3s。
	   无 reasoning ⇒ 请求窗口：4s − 1s = 3s；300/3 = 100 t/s。 */
	let overlap = proj.init();
	overlap = proj.apply(overlap, step('step/start', 1000, 1, 1));
	overlap = proj.apply(overlap, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 1100, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	['c1', 'c2', 'c3'].forEach((id) => { overlap = proj.apply(overlap, toolCall(2000, 1, 1, id)); });
	['c1', 'c2', 'c3'].forEach((id) => { overlap = proj.apply(overlap, toolResult(3000, 1, 1, id)); });
	overlap = proj.apply(overlap, step('assistant/message', 5000, 1, 1, {
		message, usage: { outputTokens: 300 }, stream: []
	}));
	assert.strictEqual(Math.round(overlap.fastestTps.value), 100, '请求窗口 4s − 1s 工具并集 = 3s；300/3 = 100 t/s');
	assert.strictEqual(overlap.turnDecodeMs, 3000, 'fully overlapping tools subtract only one second');
	assert.strictEqual(overlap.turnDecodeTokens, 300, 'fully overlapping sample enters average once');

	/* 部分重叠：[2s,4s] 与 [3s,5s] 的 union=3s，不是相加的 4s ⇒ 请求窗口 6s − 3s = 3s。 */
	let partialOverlap = proj.init();
	partialOverlap = proj.apply(partialOverlap, step('step/start', 1000, 1, 1));
	partialOverlap = proj.apply(partialOverlap, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 1100, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	partialOverlap = proj.apply(partialOverlap, toolCall(2000, 1, 1, 'a'));
	partialOverlap = proj.apply(partialOverlap, toolCall(3000, 1, 1, 'b'));
	partialOverlap = proj.apply(partialOverlap, toolResult(4000, 1, 1, 'a'));
	partialOverlap = proj.apply(partialOverlap, toolResult(5000, 1, 1, 'b'));
	partialOverlap = proj.apply(partialOverlap, step('assistant/message', 7000, 1, 1, {
		message, usage: { outputTokens: 600 }, stream: []
	}));
	assert.strictEqual(Math.round(partialOverlap.fastestTps.value), 200, '请求窗口 6s − 3s 工具并集 = 3s；600/3 = 200 t/s');
	assert.strictEqual(partialOverlap.turnDecodeMs, 3000, 'partial overlap subtracts union, not summed 4s');
	assert.strictEqual(partialOverlap.turnDecodeTokens, 600, 'partial-overlap sample enters average once');
	console.log('工具区间并集：完全重叠与部分重叠按真实 callId/result 配对');

	/* 没有输出 token 的步骤：只算首字，不进速度极值 */
	const beforeTps = JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps });
	const beforeSamples = state.samples;
	const beforeAverage = { ms: state.turnDecodeMs, tokens: state.turnDecodeTokens };
	state = proj.apply(state, step('step/start', 60000, 1, 8));
	state = proj.apply(state, step('assistant/message', 65000, 1, 8, {
		message, usage: {}, stream: [{ type: 'chunk', time: 61000, chunk: { type: 'text-delta', text: 'q' } }]
	}));
	assert.strictEqual(JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps }), beforeTps, '没有 outputTokens 就不动速度极值');
	assert.strictEqual(state.samples, beforeSamples + 1, '首字仍然计入样本数');
	assert.deepStrictEqual({ ms: state.turnDecodeMs, tokens: state.turnDecodeTokens }, beforeAverage,
		'缺失 outputTokens 的步骤不进入 TPS 极值或本轮平均');
	console.log('缺 outputTokens：只更新首字');

	/* 取消的步骤：没有 message 落地，边界必须在 step/end 清掉 */
	const beforeFailureTps = JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps });
	state = proj.apply(state, step('step/start', 70000, 2, 1));
	state = proj.apply(state, step('assistant/attempt', 70100, 2, 1, {
		stream: [{ type: 'chunk', time: 70500, chunk: { type: 'text-delta', text: 'z' } }]
	}));
	state = proj.apply(state, step('step/end', 71000, 2, 1));
	assert.strictEqual(state.openStep, null, '取消的步骤不留边界');
	assert.strictEqual(JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps }), beforeFailureTps,
		'失败/取消且无 reply 不制造 TPS 样本');
	assert.strictEqual(state.turnDecodeMs, 0, '失败/取消且无 reply 不进入本轮平均时长');
	assert.strictEqual(state.turnDecodeTokens, 0, '失败/取消且无 reply 不进入本轮平均 tokens');
	const after = proj.apply(state, step('assistant/message', 72000, 2, 1, { message, usage: { outputTokens: 10 }, stream: [] }));
	assert.strictEqual(JSON.stringify(after), JSON.stringify(state), '边界清掉后迟到的 message 不再计入');
	console.log('取消的步骤：边界清空，迟到消息不计');

	/* 换轮也要清边界 */
	state = proj.apply(state, step('step/start', 80000, 3, 1));
	state = proj.apply(state, step('turn/end', 81000, 3, 1));
	assert.strictEqual(state.openStep, null, 'turn/end 清边界');

	proj.stateSchema.parse(state);
	proj.wire.viewSchema.parse(proj.wire.view(state));
	/* ==================================================================
	 * task-58：测量精度门槛（TPS_MIN_WINDOW_MS = 300）
	 *
	 * 背景：真实日志里出现过 3725 t/s 的假极值。根因不是"速度快"，而是
	 * **窗口太短、测量本身没有精度** —— 时间戳分辨率 1ms，142ms 的窗口
	 * 相对误差就有 0.7%，再叠上分片批量落盘（523 片里 421 个 dt 是 0）。
	 *
	 * 下面这组都**没有 reasoning 分片**（走请求窗口），覆盖 142ms、1420ms、419ms、
	 * 1215ms 与正好 300ms 的边界。
	 * ================================================================== */
	let gate = proj.init();

	/* 请求窗口只有 142ms（1142 − 1000），达不到 300ms 测量精度门槛 ⇒ 整笔剔除。 */
	gate = proj.apply(gate, step('step/start', 1000, 1, 1));
	gate = proj.apply(gate, step('assistant/attempt', 1010, 1, 1, {
		stream: [{ type: 'chunk', time: 1010, chunk: { type: 'text-delta', text: '5' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 1142, 1, 1, { message, usage: { outputTokens: 529 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.strictEqual(gate.fastestTps, null,
		'request=142ms 的样本不许进最快极值（实际 ' + JSON.stringify(gate.fastestTps) + '）');
	assert.strictEqual(gate.slowestTps, null, '同样不许进最慢极值');
	/* 极值与本轮平均同门槛：短于 300ms 的窗口都不累计。 */
	assert.strictEqual(gate.turnDecodeMs, 0, '极短窗口不累计平均时长，实际 ' + gate.turnDecodeMs);
	assert.strictEqual(gate.turnDecodeTokens, 0, '未通过门槛的 token 不进本轮平均，实际 ' + gate.turnDecodeTokens);
	console.log('精度门槛 · 请求窗口 142ms / 529 tokens 不进极值或本轮平均');

	/* 同样 529 tokens、请求窗口 1420ms ⇒ 373 t/s，必须进极值。 */
	gate = proj.apply(gate, step('step/start', 3000, 1, 2));
	gate = proj.apply(gate, step('assistant/attempt', 3100, 1, 2, {
		stream: [{ type: 'chunk', time: 4000, chunk: { type: 'text-delta', text: '5' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 4420, 1, 2, { message, usage: { outputTokens: 529 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.ok(gate.fastestTps !== null, '请求窗口 1420ms 的 373 t/s 必须进极值');
	assert.strictEqual(Math.round(gate.fastestTps.value), Math.round(529 / 1.42),
		'速度 = 529 / 1.42s ≈ 373 t/s，实际 ' + Math.round(gate.fastestTps.value));
	console.log('精度门槛 · 529 tokens / 1420ms 请求窗口 ⇒ ' + Math.round(gate.fastestTps.value) + ' t/s');

	/* 419ms 请求 / 265 tokens ≈ 632 t/s：真实快速样本，如实进极值（不做速度过滤）。 */
	gate = proj.apply(gate, step('step/start', 6000, 1, 3));
	gate = proj.apply(gate, step('assistant/attempt', 6100, 1, 3, {
		stream: [{ type: 'chunk', time: 6100, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 6419, 1, 3, { message, usage: { outputTokens: 265 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.strictEqual(Math.round(gate.fastestTps.value), Math.round(265 / 0.419),
		'请求窗口 419ms / 265 tokens（632t/s）如实进极值，实际 ' + Math.round(gate.fastestTps.value));
	console.log('精度门槛 · 真实快样本 632 t/s 如实进极值');

	/* 请求窗口 1215ms / 541 tokens ≈ 445 t/s（独立 state，槽位干净）。 */
	let soloFast = proj.init();
	soloFast = proj.apply(soloFast, step('step/start', 9000, 1, 4));
	soloFast = proj.apply(soloFast, step('assistant/attempt', 9100, 1, 4, {
		stream: [{ type: 'chunk', time: 9100, chunk: { type: 'text-delta', text: 'y' } }]
	}));
	soloFast = proj.apply(soloFast, step('assistant/message', 10215, 1, 4, { message, usage: { outputTokens: 541 }, stream: [] }));
	proj.stateSchema.parse(soloFast);
	assert.ok(soloFast.fastestTps !== null,
		'request=1215ms / 541 tokens（445t/s）必须进极值，实际 null（被门槛误杀）');
	assert.strictEqual(Math.round(soloFast.fastestTps.value), Math.round(541 / 1.215),
		'速度 = 541 / 1.215s ≈ 445 t/s，实际 ' + Math.round(soloFast.fastestTps.value));
	console.log('精度门槛 · 请求窗口 1215ms 的真实值 ' + Math.round(soloFast.fastestTps.value) + ' t/s 仍在');

	/* 边界：请求窗口正好 300ms（1300 − 1000）⇒ 60 tokens / 0.3s = 200 t/s，进极值与本轮平均。 */
	let edge = proj.init();
	edge = proj.apply(edge, step('step/start', 1000, 1, 1));
	edge = proj.apply(edge, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 1100, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	edge = proj.apply(edge, step('assistant/message', 1300, 1, 1, { message, usage: { outputTokens: 60 }, stream: [] }));
	proj.stateSchema.parse(edge);
	assert.strictEqual(Math.round(edge.fastestTps.value), 200,
		'请求窗口 300ms 边界：60 tokens / 0.3s = 200 t/s 进极值（门槛是 >=）');
	assert.strictEqual(edge.slowestTps.value, edge.fastestTps.value, '只有一个样本时最快=最慢');
	assert.strictEqual(edge.turnDecodeMs, 300, '边界样本也进入本轮平均时长');
	assert.strictEqual(edge.turnDecodeTokens, 60, '边界样本也进入本轮平均 tokens');
	console.log('窗口边界 · 请求窗口 300ms/60 tokens 进极值：' + Math.round(edge.fastestTps.value) + ' t/s');

	/* 极值如实反映真实样本：40 tokens / 10s 请求窗口 = 4 t/s 照实进最慢（不做 token 门槛）。 */
	let tpsExtremes = proj.init();
	tpsExtremes = proj.apply(tpsExtremes, step('step/start', 1000, 1, 1));
	tpsExtremes = proj.apply(tpsExtremes, step('assistant/attempt', 2000, 1, 1, {
		stream: [{ type: 'chunk', time: 2000, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	tpsExtremes = proj.apply(tpsExtremes, step('assistant/message', 11000, 1, 1, {
		message, usage: { outputTokens: 40 }, stream: []
	}));
	proj.stateSchema.parse(tpsExtremes);
	assert.strictEqual(Math.round(tpsExtremes.fastestTps.value), Math.round(40 / 10),
		'40 tokens / 10s 请求窗口 = 4 t/s 如实进最快（唯一极值样本）');
	assert.strictEqual(Math.round(tpsExtremes.slowestTps.value), Math.round(40 / 10),
		'40 tokens 样本如实进最慢，不被人为 token 门槛剔除');
	assert.strictEqual(tpsExtremes.turnDecodeMs, 10000, '本轮平均累计该样本');
	assert.strictEqual(tpsExtremes.turnDecodeTokens, 40, '本轮平均 tokens 累计');

	/* 无 reasoning ⇒ 请求窗口 4490ms：214 tokens / 4.49s ≈ 48 t/s 成为最快（4.4 仍是最慢）。 */
	tpsExtremes = proj.apply(tpsExtremes, step('step/start', 20000, 1, 2));
	tpsExtremes = proj.apply(tpsExtremes, step('assistant/attempt', 21000, 1, 2, {
		stream: [{ type: 'chunk', time: 21000, chunk: { type: 'text-delta', text: 'b' } }]
	}));
	tpsExtremes = proj.apply(tpsExtremes, step('assistant/message', 24490, 1, 2, {
		message, usage: { outputTokens: 214 }, stream: []
	}));
	proj.stateSchema.parse(tpsExtremes);
	assert.strictEqual(Math.round(tpsExtremes.fastestTps.value), Math.round(214 / 4.49),
		'214 tokens / 4.49s 请求窗口 ≈ 48 t/s 成为最快');
	assert.strictEqual(Math.round(tpsExtremes.slowestTps.value), Math.round(40 / 9),
		'最慢仍是 40 tokens 的 4.4 t/s（如实显示，不人为抬高）');
	assert.strictEqual(tpsExtremes.turnDecodeMs, 10000 + 4490, '两笔都进本轮平均');
	assert.strictEqual(tpsExtremes.turnDecodeTokens, 40 + 214, '本轮平均 tokens = 40 + 214');
	assert.ok(tpsExtremes.turnDecodeTokens / (tpsExtremes.turnDecodeMs / 1000)
		<= tpsExtremes.fastestTps.value + 1e-9, '本轮平均仍 ≤ 最快');
	console.log('极值如实 · 40 tokens/10s(4 t/s) 是最慢，214 tokens/4.49s(48 t/s) 是最快');

	/* 108 秒异常请求：无 reasoning ⇒ 请求窗口 109195ms ⇒ 840/109.195 ≈ 7.69 t/s，
	   如实成为最慢，本轮平均按请求窗口累计。 */
	let slowOutlier = proj.init();
	slowOutlier = proj.apply(slowOutlier, step('step/start', 0, 1, 1));
	slowOutlier = proj.apply(slowOutlier, step('assistant/attempt', 108025, 1, 1, {
		stream: [{ type: 'chunk', time: 108025, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	slowOutlier = proj.apply(slowOutlier, step('assistant/message', 109195, 1, 1, {
		message, usage: { outputTokens: 840 }, stream: []
	}));
	proj.stateSchema.parse(slowOutlier);
	assert.strictEqual(Math.round(slowOutlier.fastestTps.value * 100) / 100, Math.round(840 / 109.195 * 100) / 100,
		'840 tokens/109s 请求窗口口径 ≈ 7.69 t/s 如实成为极值');
	assert.strictEqual(Math.round(slowOutlier.slowestTps.value * 100) / 100, Math.round(840 / 109.195 * 100) / 100,
		'7.69 t/s 如实进最慢');
	assert.strictEqual(slowOutlier.turnDecodeMs, 109195, '本轮平均按请求窗口累计');
	assert.strictEqual(slowOutlier.turnDecodeTokens, 840, '本轮平均 tokens 累计');
	console.log('极值如实 · 840 tokens/109s 请求窗口得 7.69 t/s 成为最慢');

	/* 真实会话里的样本：821 tokens、无 reasoning ⇒ 请求窗口 21.005s ⇒ 39.09 t/s，如实参与极值。 */
	let slowRequest = proj.init();
	slowRequest = proj.apply(slowRequest, step('step/start', 0, 1, 1));
	slowRequest = proj.apply(slowRequest, step('assistant/attempt', 19897, 1, 1, {
		stream: [{ type: 'chunk', time: 19897, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	slowRequest = proj.apply(slowRequest, step('assistant/message', 21005, 1, 1, {
		message, usage: { outputTokens: 821 }, stream: []
	}));
	proj.stateSchema.parse(slowRequest);
	assert.strictEqual(Math.round(slowRequest.slowestTps.value * 100) / 100, Math.round(821 / 21.005 * 100) / 100,
		'821 tokens / 21.005s 请求窗口 ≈ 39.09 t/s 如实成为极值');
	assert.strictEqual(slowRequest.turnDecodeMs, 21005, '本轮平均按请求窗口累计');
	console.log('极值如实 · 821 tokens/21s 请求窗口得 39.09 t/s 参与极值');

	/* GPT 这类隐藏思维链：无 reasoning 分片 ⇒ 请求窗口。
	   100 tokens、总请求 1.7s（含 1.2s 首字等待）⇒ 100 / 1.7 ≈ 58.8 t/s。 */
	let gptScenario = proj.init();
	gptScenario = proj.apply(gptScenario, step('step/start', 0, 1, 1));
	gptScenario = proj.apply(gptScenario, step('assistant/message', 1700, 1, 1, {
		message, usage: { outputTokens: 100 },
		stream: [{ type: 'chunk', time: 1200, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	proj.stateSchema.parse(gptScenario);
	assert.strictEqual(gptScenario.fastestTtft.value, 1200, 'GPT 场景首字 1.2s 如实记录');
	assert.strictEqual(Math.round(gptScenario.fastestTps.value), Math.round(100 / 1.7),
		'隐藏思维链：100 tokens / 请求窗口 1.7s ≈ 59 t/s（含等待的保守口径）');
	console.log('GPT 隐藏思维链 · 100 tokens / 1.7s 请求窗口 ⇒ ' + Math.round(gptScenario.fastestTps.value) + ' t/s');

	/* 首字极值如实统计：108s 异常慢请求就是最慢首字（不再被 60s 上限剔除）；
	   随后 30s、message 兜底 5s 依次更新极值。本轮首字平均口径不变。 */
	let ttftExtremes = proj.init();
	ttftExtremes = proj.apply(ttftExtremes, step('step/start', 1000, 1, 1));
	ttftExtremes = proj.apply(ttftExtremes, step('assistant/attempt', 109000, 1, 1, {
		stream: [{ type: 'chunk', time: 109000, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	ttftExtremes = proj.apply(ttftExtremes, step('assistant/message', 109195, 1, 1, {
		message, usage: { outputTokens: 840 }, stream: []
	}));
	proj.stateSchema.parse(ttftExtremes);
	assert.strictEqual(ttftExtremes.samples, 1, '108s 样本计首字样本数');
	assert.strictEqual(ttftExtremes.fastestTtft.value, 108000, '108s 如实成为最快首字（唯一样本）');
	assert.strictEqual(ttftExtremes.slowestTtft.value, 108000, '108s 如实成为最慢首字（不再被 60s 上限剔除）');
	assert.strictEqual(ttftExtremes.turnTtftMs, 108000, '本轮首字平均累计 108s');

	ttftExtremes = proj.apply(ttftExtremes, step('step/start', 200000, 1, 2));
	ttftExtremes = proj.apply(ttftExtremes, step('assistant/attempt', 230000, 1, 2, {
		stream: [{ type: 'chunk', time: 230000, chunk: { type: 'text-delta', text: 'b' } }]
	}));
	ttftExtremes = proj.apply(ttftExtremes, step('assistant/message', 240000, 1, 2, {
		message, usage: { outputTokens: 5000 }, stream: []
	}));
	proj.stateSchema.parse(ttftExtremes);
	assert.strictEqual(ttftExtremes.slowestTtft.value, 108000, '最慢首字仍是 108s（如实显示）');
	assert.strictEqual(ttftExtremes.fastestTtft.value, 30000, '30s 样本成为最快首字');

	/* message stream 兜底的首分片同样能进极值（真实会话不一定有 attempt 事件） */
	ttftExtremes = proj.apply(ttftExtremes, step('step/start', 300000, 1, 3));
	ttftExtremes = proj.apply(ttftExtremes, step('assistant/message', 310000, 1, 3, {
		message, usage: { outputTokens: 200 },
		stream: [{ type: 'chunk', time: 305000, chunk: { type: 'text-delta', text: 'c' } }]
	}));
	proj.stateSchema.parse(ttftExtremes);
	assert.strictEqual(ttftExtremes.fastestTtft.value, 5000, 'message 兜底首分片（ttft 5s）成为最快首字');
	assert.strictEqual(ttftExtremes.slowestTtft.value, 108000, '最慢首字仍是 108s');
	assert.strictEqual(ttftExtremes.turnTtftMs, 108000 + 30000 + 5000, '本轮首字平均累计三个样本');
	assert.strictEqual(ttftExtremes.turnTtftSamples, 3, '首字平均样本数');
	console.log('首字极值如实 · 108s 是最慢、30s 中间、message 兜底 5s 是最快');

	/* ==================================================================
	 * task-73 D：`outputTokens = 0` 的步骤不许把速度极值钉成 0
	 *
	 * bug（2.2.2 起就有，不是本轮引入）：旧实现速度 = tokens / (decode/1000)，
	 * 0 个 token ⇒ speed 恒为 0；而 `pickSmaller` 取最小 ⇒ `slowestTps`
	 * 一旦被写成 0 就**永久锁死**（0 是下界，后面再没有比它更小的），
	 * 界面上永远显示"最慢 0 t/s"。0 个 token 无所谓"每秒多少"，
	 * 这一笔根本不该参与速度比较。
	 *
	 * 实现口径（照 lib/index.js 那行门槛的写法）：`output > 0` 是独立一道
	 * 门槛，output=0 的步骤**完全不进速度极值**，所以：
	 *   · 全新状态 ⇒ fastestTps / slowestTps 保持 **null**
	 *   · 已有非零极值 ⇒ **原值原封不动**（不是"重置为 null"，是"不参与比较"）
	 * 首字极值照旧统计 —— 输出 0 个 token 的步骤仍然有"用户等了多久"。
	 * ================================================================== */
	let zeroTps = proj.init();

	/* 【核心】单步 outputTokens=0 + request duration=1200ms（2200 − 1000），全新状态 */
	zeroTps = proj.apply(zeroTps, step('step/start', 1000, 1, 1));
	zeroTps = proj.apply(zeroTps, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 1200, chunk: { type: 'text-delta', text: '0' } }]
	}));
	zeroTps = proj.apply(zeroTps, step('assistant/message', 2200, 1, 1, {
		message, usage: { outputTokens: 0 }, stream: []
	}));
	proj.stateSchema.parse(zeroTps);
	/* 先证明夹具本身被 apply 吃进去了：首字照旧计样本、首字极值算得出来。
	   否则下面两条 null 断言可能只是因为事件被忽略，等于没测。 */
	assert.strictEqual(zeroTps.samples, 1, 'output=0 的步骤首字照旧计一次样本（证明夹具生效）');
	assert.strictEqual(zeroTps.fastestTtft.value, 200, 'output=0 的步骤首字照旧算（1200 − 1000）');
	assert.strictEqual(zeroTps.fastestTps, null,
		'output=0 / request=1200ms 不许进最快极值，实际 ' + JSON.stringify(zeroTps.fastestTps));
	assert.strictEqual(zeroTps.slowestTps, null,
		'output=0 / request=1200ms 不许进最慢极值（否则被永久锁成 0），实际 ' + JSON.stringify(zeroTps.slowestTps));
	/* 极值与本轮平均采用同一采样口径；output=0 不贡献速度或平均样本。 */
	assert.strictEqual(zeroTps.turnDecodeMs, 0, 'output=0 时不累计本轮 TPS 时长，实际 ' + zeroTps.turnDecodeMs);
	assert.strictEqual(zeroTps.turnDecodeTokens, 0, 'output=0 时本轮平均 tokens 保持 0，实际 ' + zeroTps.turnDecodeTokens);
	console.log('output=0 · 全新状态被拦：fastest/slowest 与本轮平均均保持空');

	/* 【防回归对照】同一 state 紧跟正常步骤（500 tokens / 2s 请求窗口 ⇒ 250 t/s），
	   证明上面的 null 是 output=0 被排除，而非夹具整体无效。 */
	zeroTps = proj.apply(zeroTps, step('step/start', 5000, 1, 2));
	zeroTps = proj.apply(zeroTps, step('assistant/attempt', 5100, 1, 2, {
		stream: [{ type: 'chunk', time: 6000, chunk: { type: 'text-delta', text: 'n' } }]
	}));
	zeroTps = proj.apply(zeroTps, step('assistant/message', 7000, 1, 2, {
		message, usage: { outputTokens: 500 }, stream: []
	}));
	proj.stateSchema.parse(zeroTps);
	assert.ok(zeroTps.fastestTps !== null,
		'同一夹具里的正常步骤（500 tokens / 2s）必须算出速度极值，实际 null（夹具失效或门槛误杀）');
	assert.strictEqual(Math.round(zeroTps.fastestTps.value), 250, '正常步骤速度 = 500 / 2s 请求窗口，实际 ' + zeroTps.fastestTps.value);
	assert.strictEqual(Math.round(zeroTps.slowestTps.value), 250, '只有一个非零样本时最快=最慢');
	assert.strictEqual(zeroTps.turnDecodeMs, 2000, '有效输出进入本轮平均请求窗口');
	assert.strictEqual(zeroTps.turnDecodeTokens, 500, '有效输出进入本轮平均 tokens');
	console.log('output=0 · 同夹具的正常步骤仍算出 250 t/s');

	/* 【已有非零极值后再来 output=0】原值必须原封不动，不能被 0 顶掉。
	   这一步是本 bug 的原始症状：若 output=0 进了极值，slowestTps 会变成 0。 */
	zeroTps = proj.apply(zeroTps, step('step/start', 9000, 1, 3));
	zeroTps = proj.apply(zeroTps, step('assistant/attempt', 9100, 1, 3, {
		stream: [{ type: 'chunk', time: 9200, chunk: { type: 'text-delta', text: 'z' } }]
	}));
	zeroTps = proj.apply(zeroTps, step('assistant/message', 10200, 1, 3, {
		message, usage: { outputTokens: 0 }, stream: []
	}));
	proj.stateSchema.parse(zeroTps);
	assert.strictEqual(Math.round(zeroTps.fastestTps.value), 250,
		'output=0 之后最快极值仍是上一个非零值 250，实际 ' + JSON.stringify(zeroTps.fastestTps));
	assert.strictEqual(Math.round(zeroTps.slowestTps.value), 250,
		'output=0 不许把最慢极值锁成 0（pickSmaller 一旦见 0 就永久钉死），实际 ' + JSON.stringify(zeroTps.slowestTps));
	assert.strictEqual(zeroTps.turnDecodeMs, 2000, 'output=0 不改变有效样本的平均请求窗口');
	assert.strictEqual(zeroTps.turnDecodeTokens, 500, 'output=0 不改变有效样本的平均 tokens');
	console.log('output=0 · 已有极值和本轮平均均不被覆盖');

	/* 【边界】outputTokens=0 且 request duration=1142ms（超过 300ms），由 output guard 排除。 */
	let zeroEdge = proj.init();
	zeroEdge = proj.apply(zeroEdge, step('step/start', 1000, 1, 1));
	zeroEdge = proj.apply(zeroEdge, step('assistant/message', 2142, 1, 1, {
		message, usage: { outputTokens: 0 },
		stream: [{ type: 'chunk', time: 2000, chunk: { type: 'text-delta', text: 'e' } }]
	}));
	proj.stateSchema.parse(zeroEdge);
	assert.strictEqual(zeroEdge.samples, 1, 'output=0 / request=1142ms 的步骤首字照旧计样本（证明夹具生效）');
	assert.strictEqual(zeroEdge.fastestTps, null,
		'output=0 / request=1142ms 不许进最快极值，实际 ' + JSON.stringify(zeroEdge.fastestTps));
	assert.strictEqual(zeroEdge.slowestTps, null,
		'output=0 / request=1142ms 不许进最慢极值，实际 ' + JSON.stringify(zeroEdge.slowestTps));
	console.log('output=0 · request=1142ms 虽过时长门槛，仍不进极值（output guard）');

	proj.stateSchema.parse(state);
	proj.wire.viewSchema.parse(proj.wire.view(state));
	console.log('最终 wire 视图:', JSON.stringify(proj.wire.view(state)));

	console.log('\nHOST TIMING PROJECTION CHECKS PASSED');
})().finally(() => {
	try { fs.rmSync(TEMP_HOME, { recursive: true, force: true }); } catch (error) { /* best effort */ }
}).catch((error) => {
	console.error('HOST TIMING CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
