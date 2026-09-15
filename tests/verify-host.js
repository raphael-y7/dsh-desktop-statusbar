/**
 * host 侧投影测试：确认 usage 从 stream chunk 里取得到（而不是只看 data.usage）。
 * 这直接对应"费用恒为 0"的根因。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

(async () => {
	/* 动态导入真实模块（zod 由插件目录自身的 node_modules 解析） */
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	assert.strictEqual(typeof mod.apply, 'function', 'apply exported');

	const registered = [];
	const logs = [];
	mod.apply({
		logger: { info: (m) => logs.push(m) },
		effect: (fn) => fn(),
		sessionProjections: { register: (p) => { registered.push(p); return () => {}; } },
		webServer: { register: () => () => {} },
		credentials: undefined
	});

	const usageProj = registered.filter((p) => p.key === 'desktopStatusbarUsage')[0];
	assert.ok(usageProj !== undefined, 'usage projection registered');
	console.log('已注册投影:', registered.map((p) => p.key).join(', '));

	/* 初始状态必须满足 schema（strict，多一个字段就会挂） */
	let state = usageProj.init();
	usageProj.stateSchema.parse(state);
	console.log('init 状态通过 schema:', JSON.stringify(state));

	const usage = { inputTokens: 375000, outputTokens: 41000, cacheReadTokens: 1900000, cacheWriteTokens: 0 };
	const message = { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } };

	/* 1. usage 只在 stream chunk 里（真实情况） */
	state = usageProj.apply(state, {
		type: 'assistant/message',
		time: Date.now(),
		data: { turn: 1, step: 1, message, stream: [{ index: 0, chunk: { type: 'usage', usage } }] }
	});
	usageProj.stateSchema.parse(state);
	console.log('stream 取到调用:', JSON.stringify(state.calls[0]));

	/* 2. usage 在 data.usage（兜底路径）。注意 inputTokens 含缓存，未缓存量 = 5000-3000-0 = 2000 */
	const usage2 = { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0 };
	state = usageProj.apply(state, {
		type: 'assistant/message',
		time: Date.now(),
		data: { turn: 1, step: 2, message, usage: usage2, stream: [] }
	});
	usageProj.stateSchema.parse(state);
	console.log('data.usage 取到调用:', JSON.stringify(state.calls[1]));

	/* 3. 两条都不能是 0，且未缓存输入 = input - cacheRead - cacheWrite */
	assert.strictEqual(state.calls.length, 2, 'two calls recorded');
	assert.deepStrictEqual(state.calls[0], {
		at: state.calls[0].at, model: 'deepseek-flash',
		input: 0, cacheRead: 1900000, cacheWrite: 0, output: 41000
	}, 'stream usage parsed with uncached-input semantics');
	assert.ok(state.calls[0].at > 0, 'call carries a timestamp');
	assert.strictEqual(state.calls[1].input, 2000, 'data.usage path subtracts cache from input');
	assert.strictEqual(state.calls[1].cacheRead, 3000, 'data.usage path records cacheRead');

	/* 4. models 聚合也要有值 */
	console.log('models 聚合:', JSON.stringify(state.models));

	/* 5. 无 usage 的事件不能污染状态 */
	const before = JSON.stringify(state.calls);
	state = usageProj.apply(state, { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 3, message, stream: [] } });
	assert.strictEqual(JSON.stringify(state.calls), before, 'event without usage is ignored');

	/* 6. 本轮汇总（current）：同 turn 的两条调用必须累加（按 turn 号判断，不靠 turn/start） */
	assert.strictEqual(state.current.calls.length, 2, 'current holds this turn calls');
	assert.strictEqual(state.current.output, 41000 + 2000, 'current output accumulates within the same turn');
	assert.strictEqual(state.current.cacheRead, 1900000 + 3000, 'current cacheRead accumulates too');
	console.log('本轮汇总:', JSON.stringify({ output: state.current.output, calls: state.current.calls.length }));

	/* 7. 同一轮再加一条：继续叠加 */
	state = usageProj.apply(state, {
		type: 'assistant/message',
		time: Date.now(),
		data: { turn: 1, step: 4, message, usage: { inputTokens: 0, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 }, stream: [] }
	});
	assert.strictEqual(state.current.output, 43500, 'third call adds to the turn total');
	assert.strictEqual(state.current.calls.length, 3, 'third call joins current calls');
	console.log('三条调用后本轮汇总:', JSON.stringify({ output: state.current.output, calls: state.current.calls.length }));

	/* 8. 换一轮：current 必须重开，不能把上一轮算进来 */
	state = usageProj.apply(state, {
		type: 'assistant/message',
		time: Date.now(),
		data: { turn: 2, step: 1, message, usage: { inputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, stream: [] }
	});
	assert.strictEqual(state.current.output, 100, 'new turn resets the turn summary');
	assert.strictEqual(state.current.calls.length, 1, 'new turn summary holds only the new call');
	assert.strictEqual(state.last.output, 43500, 'previous turn settled into last');
	console.log('换轮后:', JSON.stringify({ currentOutput: state.current.output, lastOutput: state.last.output, total: state.calls.length }));

	console.log('\nHOST PROJECTION CHECKS PASSED');
})().catch((error) => {
	console.error('HOST PROJECTION CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
