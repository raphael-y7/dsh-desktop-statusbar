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

	/* 思考增量（reasoning-chunks）与文本增量一样进速度极值：真实会话里这类占多数。
	   **注意**：`outputTokens` 里本来就含 reasoning token（实测 reasoning 极多、正文为 0 的步
	   outputTokens 仍有几千），所以解码窗口必须含 reasoning 时间 —— 分子分母同时含，自洽。
	   曾经试过"排除思考步骤"和"decode 从正文首片起算"，两者都把速度系统性放大了
	   （最快 632→4961、本轮平均 192→470），task-60 已整批回退。详见 index.js 里
	   `TPS_MIN_DECODE_MS` 上方那段"两端为什么不对称"的说明。 */
	state = proj.init();
	state = proj.apply(state, step('step/start', 40000, 1, 6));
	state = proj.apply(state, step('assistant/message', 43000, 1, 6, {
		message, usage: { outputTokens: 300 },
		stream: [{ type: 'reasoning-chunks', time0: 40500, texts: ['先想一下'], dt: [10] }]
	}));
	proj.stateSchema.parse(state);
	assert.strictEqual(state.fastestTtft.value, 500, 'reasoning 分片算首字');
	assert.strictEqual(Math.round(state.fastestTps.value), 120, '300 tokens / 2.5s 参与速度');
	assert.strictEqual(state.samples, 1, 'reasoning 步骤照常计入样本');
	console.log('纯 reasoning 步：照常进极值与平均值（outputTokens 含 reasoning token）');

	/* 同一步里先思考再调工具：按首个分片定性，仍然算速度 */
	state = proj.apply(state, step('step/start', 50000, 1, 7));
	state = proj.apply(state, step('assistant/message', 52000, 1, 7, {
		message, usage: { outputTokens: 250 },
		stream: [
			{ type: 'reasoning-chunks', time0: 50500, texts: ['想'], dt: [] },
			{ type: 'tool-call-chunks', time0: 51000, name: 'read', args: ['{}'], dt: [] }
		]
	}));
	proj.stateSchema.parse(state);
	assert.strictEqual(state.fastestTtft.value, 500, '先思考后调工具：首字取 reasoning 分片');
	assert.strictEqual(Math.round(state.fastestTps.value), 167, '250 tokens / 1.5s 参与速度（从 reasoning 首片起算）');
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
	/* ==================================================================
	 * task-58：解码窗口精度门槛（TPS_MIN_DECODE_MS = 300）
	 *
	 * 背景：真实日志里出现过 3725 t/s 的假极值。根因不是"速度快"，而是
	 * **解码窗口太短、测量本身没有精度** —— 时间戳分辨率 1ms，142ms 的窗口
	 * 相对误差就有 0.7%，再叠上分片批量落盘（523 片里 421 个 dt 是 0）。
	 *
	 * **这不是速度上限**：门槛卡的是"这次测量够不够长"。同样 529 个 token，
	 * 把它摊到 1420ms（10 倍时长）就必须能进极值 —— 下面专门钉这条。
	 * ================================================================== */
	let gate = proj.init();

	/* 假值：decode=142ms + output=529（真实日志 turn89 s3 的形态）⇒ 不进极值 */
	gate = proj.apply(gate, step('step/start', 1000, 1, 1));
	gate = proj.apply(gate, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 2000, chunk: { type: 'text-delta', text: '5' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 2142, 1, 1, { message, usage: { outputTokens: 529 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.strictEqual(gate.fastestTps, null,
		'decode=142ms 的假值不许进最快极值（实际 ' + JSON.stringify(gate.fastestTps) + '）');
	assert.strictEqual(gate.slowestTps, null, '同样不许进最慢极值');
	/* 但本轮平均必须照旧累加 —— 用户要求"改前改后一致" */
	assert.strictEqual(gate.turnDecodeMs, 142, '本轮 decode 照旧累加（不受门槛影响），实际 ' + gate.turnDecodeMs);
	assert.strictEqual(gate.turnDecodeTokens, 529, '本轮 tokens 照旧累加，实际 ' + gate.turnDecodeTokens);
	console.log('精度门槛 · 假值被拦：decode=142ms / 529 tokens 不进极值（本轮仍累加 142ms/529）');

	/* 同样 529 tokens、摊到 1420ms（10 倍时长）⇒ **必须进极值**
	   这条最关键：证明拦的是"精度"，不是"内容多少"，更不是"速度快慢" */
	gate = proj.apply(gate, step('step/start', 3000, 1, 2));
	gate = proj.apply(gate, step('assistant/attempt', 3100, 1, 2, {
		stream: [{ type: 'chunk', time: 4000, chunk: { type: 'text-delta', text: '5' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 5420, 1, 2, { message, usage: { outputTokens: 529 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.ok(gate.fastestTps !== null, 'decode=1420ms 的同 token 数步骤必须进极值（证明拦的是精度不是内容）');
	assert.strictEqual(Math.round(gate.fastestTps.value), Math.round(529 / 1.42),
		'速度 = 529 / 1.42s ≈ 373 t/s，实际 ' + Math.round(gate.fastestTps.value));
	console.log('精度门槛 · 同样 529 tokens 摊到 1420ms ⇒ 进极值 ' + Math.round(gate.fastestTps.value) + ' t/s');

	/* 真实值 632 t/s：decode=419ms + output=265（真实日志 turn105 s2）⇒ 必须进 */
	gate = proj.apply(gate, step('step/start', 6000, 1, 3));
	gate = proj.apply(gate, step('assistant/attempt', 6100, 1, 3, {
		stream: [{ type: 'chunk', time: 7000, chunk: { type: 'text-delta', text: 'x' } }]
	}));
	gate = proj.apply(gate, step('assistant/message', 7419, 1, 3, { message, usage: { outputTokens: 265 }, stream: [] }));
	proj.stateSchema.parse(gate);
	assert.strictEqual(Math.round(gate.fastestTps.value), Math.round(265 / 0.419),
		'decode=419ms / 265 tokens（632t/s 真实值）必须进极值，实际 ' + Math.round(gate.fastestTps.value));
	console.log('精度门槛 · 真实值 632 t/s 仍在：' + Math.round(gate.fastestTps.value) + ' t/s');

	/* 真实值 445 t/s：decode=1215ms + output=541 ⇒ 必须进极值。
	   极值只有"最快/最慢"两个槽位，而 445 既比 632 慢、又比 373 快 ⇒ 落不到任何槽位里，
	   所以在已有的 gate 状态上看不出来。这里单开一个 state、只喂这一步，
	   断言它确实被计入（否则门槛会把它也拦掉，两个槽位都会是 null）。 */
	let solo445 = proj.init();
	solo445 = proj.apply(solo445, step('step/start', 9000, 1, 4));
	solo445 = proj.apply(solo445, step('assistant/attempt', 9100, 1, 4, {
		stream: [{ type: 'chunk', time: 10000, chunk: { type: 'text-delta', text: 'y' } }]
	}));
	solo445 = proj.apply(solo445, step('assistant/message', 11215, 1, 4, { message, usage: { outputTokens: 541 }, stream: [] }));
	proj.stateSchema.parse(solo445);
	assert.ok(solo445.fastestTps !== null,
		'decode=1215ms / 541 tokens（445t/s）必须进极值，实际 null（被门槛误杀）');
	assert.strictEqual(Math.round(solo445.fastestTps.value), Math.round(541 / 1.215),
		'速度 = 541 / 1.215s ≈ 445 t/s，实际 ' + Math.round(solo445.fastestTps.value));
	console.log('精度门槛 · 真实值 445 t/s 仍在：' + Math.round(solo445.fastestTps.value) + ' t/s');

	/* 边界：正好等于门槛（300ms）必须进 —— 门槛是 >= 不是 > */
	let edge = proj.init();
	edge = proj.apply(edge, step('step/start', 1000, 1, 1));
	edge = proj.apply(edge, step('assistant/attempt', 1100, 1, 1, {
		stream: [{ type: 'chunk', time: 2000, chunk: { type: 'text-delta', text: 'a' } }]
	}));
	edge = proj.apply(edge, step('assistant/message', 2300, 1, 1, { message, usage: { outputTokens: 60 }, stream: [] }));
	proj.stateSchema.parse(edge);
	assert.ok(edge.fastestTps !== null, 'decode 正好 300ms 必须进极值（门槛是 >=）');
	console.log('精度门槛 · 边界 decode=300ms 恰好进极值：' + Math.round(edge.fastestTps.value) + ' t/s');

	/* ==================================================================
	 * task-73 D：`outputTokens = 0` 的步骤不许把速度极值钉成 0
	 *
	 * bug（2.2.2 起就有，不是本轮引入）：速度 = tokens / (decode/1000)，
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

	/* 【核心】单步 outputTokens=0 + decode=1000ms（2200 − 1200），全新状态 */
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
		'output=0 / decode=1000ms 不许进最快极值，实际 ' + JSON.stringify(zeroTps.fastestTps));
	assert.strictEqual(zeroTps.slowestTps, null,
		'output=0 / decode=1000ms 不许进最慢极值（否则被永久锁成 0），实际 ' + JSON.stringify(zeroTps.slowestTps));
	/* 本轮平均口径故意与极值不同：0 token 仍然累加 decode，不跟着门槛跳过 */
	assert.strictEqual(zeroTps.turnDecodeMs, 1000, 'output=0 时本轮 decode 照旧累加，实际 ' + zeroTps.turnDecodeMs);
	assert.strictEqual(zeroTps.turnDecodeTokens, 0, 'output=0 时本轮 tokens 累加 0，实际 ' + zeroTps.turnDecodeTokens);
	console.log('output=0 · 全新状态被拦：slowestTps / fastestTps 保持 null（首字照旧 200ms）');

	/* 【防回归对照】同一份夹具、同一个 state 里紧跟一步正常步骤
	   （output=500 + decode=1000ms ⇒ 500 t/s）：极值必须能算出来（不是 null），
	   证明上面那些 null 是"output=0 被拦"，而不是"夹具坏了、什么都算不出"。 */
	zeroTps = proj.apply(zeroTps, step('step/start', 5000, 1, 2));
	zeroTps = proj.apply(zeroTps, step('assistant/attempt', 5100, 1, 2, {
		stream: [{ type: 'chunk', time: 6000, chunk: { type: 'text-delta', text: 'n' } }]
	}));
	zeroTps = proj.apply(zeroTps, step('assistant/message', 7000, 1, 2, {
		message, usage: { outputTokens: 500 }, stream: []
	}));
	proj.stateSchema.parse(zeroTps);
	assert.ok(zeroTps.fastestTps !== null,
		'同一夹具里的正常步骤（500 tokens / 1s）必须算出速度极值，实际 null（夹具失效或门槛误杀）');
	assert.strictEqual(Math.round(zeroTps.fastestTps.value), 500, '正常步骤速度 = 500 / 1s，实际 ' + zeroTps.fastestTps.value);
	assert.strictEqual(Math.round(zeroTps.slowestTps.value), 500, '只有一个非零样本时最快=最慢');
	console.log('output=0 · 同夹具的对照步骤仍算出极值：' + Math.round(zeroTps.fastestTps.value) + ' t/s');

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
	assert.strictEqual(Math.round(zeroTps.fastestTps.value), 500,
		'output=0 之后最快极值仍是上一个非零值 500，实际 ' + JSON.stringify(zeroTps.fastestTps));
	assert.strictEqual(Math.round(zeroTps.slowestTps.value), 500,
		'output=0 不许把最慢极值锁成 0（pickSmaller 一旦见 0 就永久钉死），实际 ' + JSON.stringify(zeroTps.slowestTps));
	console.log('output=0 · 已有极值不被覆盖：fastest/slowest 仍是 500 t/s');

	/* 【边界】outputTokens=0 且 decode < TPS_MIN_DECODE_MS（142ms）⇒ 两道门槛
	   任一条拦住即可，同样不许进极值。 */
	let zeroEdge = proj.init();
	zeroEdge = proj.apply(zeroEdge, step('step/start', 1000, 1, 1));
	zeroEdge = proj.apply(zeroEdge, step('assistant/message', 2142, 1, 1, {
		message, usage: { outputTokens: 0 },
		stream: [{ type: 'chunk', time: 2000, chunk: { type: 'text-delta', text: 'e' } }]
	}));
	proj.stateSchema.parse(zeroEdge);
	assert.strictEqual(zeroEdge.samples, 1, 'output=0 / decode=142ms 的步骤首字照旧计样本（证明夹具生效）');
	assert.strictEqual(zeroEdge.fastestTps, null,
		'output=0 / decode=142ms 两道门槛任一拦住即可，不许进最快极值，实际 ' + JSON.stringify(zeroEdge.fastestTps));
	assert.strictEqual(zeroEdge.slowestTps, null,
		'output=0 / decode=142ms 不许进最慢极值，实际 ' + JSON.stringify(zeroEdge.slowestTps));
	console.log('output=0 · 边界 decode=142ms（< 300ms）同样不进极值');



	proj.stateSchema.parse(state);
	proj.wire.viewSchema.parse(proj.wire.view(state));
	console.log('最终 wire 视图:', JSON.stringify(proj.wire.view(state)));

	console.log('\nHOST TIMING PROJECTION CHECKS PASSED');
})().catch((error) => {
	console.error('HOST TIMING CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
