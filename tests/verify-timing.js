/**
 * host 侧 desktopStatusbarTiming 投影测试：逐次调用的首字/输出速度极值。
 * 计时口径与官方 dsh-session-stats 对齐：step/start → 首个 token 分片 → assistant/message。
 * 用法：node verify-timing.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* apply() 会预热扫一次台账（读会话日志、必要时落盘）。把 DSH_HOME 指到 tests/ 下的
   隔离目录，别让测试读写这台机器上的真实台账 ~/.dsh/dsh-status-bar/ 。 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home');

/* 假 ctx 不会跑 effect 的 cleanup，插件的用量刷新定时器会把进程吊住不退出：让它别真的起定时器 */
globalThis.setInterval = () => 0;

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
	const proj = registered.filter((p) => p.key === 'desktopStatusbarTiming')[0];
	assert.ok(proj !== undefined, 'timing projection registered');
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

	/* 第一次调用：首 token 在 t=1500，回答在 t=4000 → 首字 500ms、解码 2500ms / 500 tokens */
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
	assert.strictEqual(Math.round(state.fastestTps.value), 200, '速度 = 500 tokens / 2.5s');
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
	assert.strictEqual(Math.round(state.fastestTps.value), 200, '最快速度仍是第一次');
	assert.strictEqual(Math.round(state.slowestTps.value), 100, '最慢速度换成第二次');
	console.log('极值:', JSON.stringify({
		ttft: [state.fastestTtft.value, state.slowestTtft.value],
		tps: [Math.round(state.fastestTps.value), Math.round(state.slowestTps.value)]
	}));

	/* 首 token 只在 assistant/message 的 stream 里（attempt 没给）：也要算得出来 */
	state = proj.apply(state, step('step/start', 10000, 1, 3));
	state = proj.apply(state, step('assistant/message', 13000, 1, 3, {
		message, usage: { outputTokens: 1000 },
		stream: [{ type: 'chunk', time: 11000, chunk: { type: 'reasoning-delta', text: 'think' } }]
	}));
	assert.strictEqual(state.samples, 3, 'message 里的 stream 也能取首 token（样本 +1）');
	assert.strictEqual(Math.round(state.fastestTps.value), 500, '两个 chunk 包一层也算（{type:"chunk"}）');
	console.log('首 token 兜底路径:', JSON.stringify({ samples: state.samples, tps: Math.round(state.fastestTps.value) }));

	/* 打包 run（紧凑流）：第一个非空分片在 time0 + dt[0] → 首字 1100ms（单独一份状态，极值一眼可读） */
	state = proj.init();
	state = proj.apply(state, step('step/start', 20000, 1, 4));
	state = proj.apply(state, step('assistant/message', 22000, 1, 4, {
		message, usage: { outputTokens: 200 },
		stream: [{ type: 'text-chunks', time0: 21000, texts: ['', 'a', 'b'], dt: [100, 100] }]
	}));
	assert.strictEqual(state.fastestTtft.value, 1100, '打包 run：第一个非空分片在 time0 + 100ms');
	assert.strictEqual(Math.round(state.fastestTps.value), 222, '200 tokens / 0.9s');

	/* 带 name 的 tool-call 分片算首字，但这类步骤的时间戳挤在同一刻，不进速度极值 */
	state = proj.init();
	state = proj.apply(state, step('step/start', 30000, 1, 5));
	state = proj.apply(state, step('assistant/message', 31000, 1, 5, {
		message, usage: { outputTokens: 300 },
		stream: [{ type: 'tool-call-chunks', time0: 30500, name: 'read', args: ['{}'], dt: [0] }]
	}));
	assert.strictEqual(state.fastestTtft.value, 500, '工具调用的 name 分片也算首字');
	assert.strictEqual(state.samples, 1, '首字样本照常计一次');
	assert.strictEqual(state.fastestTps, null, '纯工具调用的步骤不参与速度极值');
	assert.strictEqual(state.slowestTps, null, '同上');
	console.log('纯工具调用步：进首字、不进速度');

	/* 思考增量（reasoning-chunks）与文本增量一样进速度极值：真实会话里这类占多数 */
	state = proj.init();
	state = proj.apply(state, step('step/start', 40000, 1, 6));
	state = proj.apply(state, step('assistant/message', 43000, 1, 6, {
		message, usage: { outputTokens: 300 },
		stream: [{ type: 'reasoning-chunks', time0: 40500, texts: ['先想一下'], dt: [10] }]
	}));
	assert.strictEqual(state.fastestTtft.value, 500, 'reasoning 分片算首字');
	assert.strictEqual(Math.round(state.fastestTps.value), 120, '300 tokens / 2.5s 参与速度');

	/* 同一步里先思考再调工具：按首个分片定性，仍然算速度 */
	state = proj.apply(state, step('step/start', 50000, 1, 7));
	state = proj.apply(state, step('assistant/message', 52000, 1, 7, {
		message, usage: { outputTokens: 250 },
		stream: [
			{ type: 'reasoning-chunks', time0: 50500, texts: ['想'], dt: [] },
			{ type: 'tool-call-chunks', time0: 51000, name: 'read', args: ['{}'], dt: [] }
		]
	}));
	assert.strictEqual(state.fastestTtft.value, 500, '先思考后调工具：首字取 reasoning 分片');
	assert.strictEqual(Math.round(state.fastestTps.value), 167, '250 tokens / 1.5s 参与速度');
	console.log('reasoning / 混合流：按首个分片定性');

	/* 没有输出 token 的步骤：只算首字，不进速度极值 */
	const beforeTps = JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps });
	const beforeSamples = state.samples;
	state = proj.apply(state, step('step/start', 60000, 1, 8));
	state = proj.apply(state, step('assistant/message', 65000, 1, 8, {
		message, usage: {}, stream: [{ type: 'chunk', time: 61000, chunk: { type: 'text-delta', text: 'q' } }]
	}));
	assert.strictEqual(JSON.stringify({ fast: state.fastestTps, slow: state.slowestTps }), beforeTps, '没有 outputTokens 就不动速度极值');
	assert.strictEqual(state.samples, beforeSamples + 1, '首字仍然计入样本数');
	console.log('缺 outputTokens：只更新首字');

	/* 取消的步骤：没有 message 落地，边界必须在 step/end 清掉 */
	state = proj.apply(state, step('step/start', 70000, 2, 1));
	state = proj.apply(state, step('assistant/attempt', 70100, 2, 1, {
		stream: [{ type: 'chunk', time: 70500, chunk: { type: 'text-delta', text: 'z' } }]
	}));
	state = proj.apply(state, step('step/end', 71000, 2, 1));
	assert.strictEqual(state.openStep, null, '取消的步骤不留边界');
	const after = proj.apply(state, step('assistant/message', 72000, 2, 1, { message, usage: { outputTokens: 10 }, stream: [] }));
	assert.strictEqual(JSON.stringify(after), JSON.stringify(state), '边界清掉后迟到的 message 不再计入');
	console.log('取消的步骤：边界清空，迟到消息不计');

	/* 换轮也要清边界 */
	state = proj.apply(state, step('step/start', 80000, 3, 1));
	state = proj.apply(state, step('turn/end', 81000, 3, 1));
	assert.strictEqual(state.openStep, null, 'turn/end 清边界');

	proj.stateSchema.parse(state);
	proj.wire.viewSchema.parse(proj.wire.view(state));
	console.log('最终 wire 视图:', JSON.stringify(proj.wire.view(state)));

	console.log('\nHOST TIMING PROJECTION CHECKS PASSED');
})().catch((error) => {
	console.error('HOST TIMING CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
