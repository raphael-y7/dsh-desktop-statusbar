/**
 * 进度投影 2.2.0 事件语义：技能 manual 标记 + 压缩成功/失败/手动标记（task-1 的断言）。
 *
 * 契约（Lead 定，stateVersion 8）：
 *   skills: Array<{ name, manual }>                 每次注入一条；manual=true 是用户手动（斜杠命令 /技能名）
 *   compacts: Array<{ turn, step|null, afterTurn, manual }>  只列成功压缩，按发生顺序；
 *                                                  轮间压缩 turn=null，afterTurn=发生时最后已知轮号
 *   compactCount 只数成功；compactTurn/compactStep 只跟最近一次成功压缩
 *
 * 宿主语义（证据：app.asar 里 @deepseek-ai/dsh-compaction 的 invariant 校验 +
 * ~/.dsh/sessions 真实日志里的 17 个压缩事务：成功 4、失败 13、手动 11）：
 *   成功 = compaction/end 且 data.error 缺省（成功的 end 在宿主日志里会伴随一条 compaction/summary）；
 *   失败 = compaction/end 带 data.error，不产生 summary（模型 400 超长 / 429 限流）；
 *   手动 = start/summary/end 三个事件都带同一个 sourceCommandId，且 turn=null（轮间压缩）；
 *   自动 = 没有 sourceCommandId，turn 是当前轮号。
 *   **判定只看 end 的 error，不数 compaction/summary**：「没 summary 就算失败」是没有验证过的
 *   启发式（第 6 步专门钉住这条），summary 只在宿主 invariant 里当「成功 end 的伴随证据」。
 *
 * 用法：node tests/verify-progress-events.js
 */
const path = require('path');
const assert = require('assert');

const INDEX = path.join(__dirname, '..', 'lib', 'index.js');

/* apply() 会预热扫一次台账（读会话日志、必要时落盘）：把 DSH_HOME 指到隔离目录，
   别碰这台机器上真实的 ~/.dsh/dsh-status-bar/ */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home-progress');

/* 假 ctx 不会跑 effect 的 cleanup，插件里的定时器会吊住进程：让它别真的起定时器 */
globalThis.setInterval = () => 0;

const at = () => Date.now();

/* ---------------- 事件夹具：字段形状照真实会话日志（含失败样本） ---------------- */

/** 用户输入 /技能名：一条 user/message，source.kind = 'skill-invocation' */
const userSkill = (name) => ({
	type: 'user/message', time: at(),
	data: { source: { kind: 'skill-invocation', name, form: 'instructions' } }
});

/** 模型/自动调 skill 工具：tool/call，arguments 是 JSON 字符串 */
const toolSkill = (name) => ({
	type: 'tool/call', time: at(),
	data: { turn: 1, step: 1, name: 'skill', arguments: JSON.stringify({ name }) }
});

/** 压缩开始：turn=null 表示轮间压缩（用户手动 /compact），自动压缩带当前轮号 */
const compactStart = (id, turn, commandId) => ({
	type: 'compaction/start',
	time: at(),
	data: commandId === undefined
		? { compactionId: id, turn }
		: { compactionId: id, turn, sourceCommandId: commandId }
});

/** 压缩结束：带 error 是失败（宿主此时不发 compaction/summary）；不带 error 是成功 */
const compactEnd = (id, turn, commandId, error) => {
	const data = { compactionId: id, turn };
	if (commandId !== undefined) data.sourceCommandId = commandId;
	if (error !== undefined) data.error = error;
	return { type: 'compaction/end', time: at(), data };
};

const applyAll = (proj, state, events) => events.reduce((one, event) => proj.apply(one, event), state);

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

	const proj = registered.filter((p) => p.key === 'desktopStatusbarProgress')[0];
	assert.ok(proj !== undefined, '进度投影已注册');

	/* 0. 版本必须升到 9：旧持久化状态（skills 是字符串数组）会被重建 */
	assert.strictEqual(proj.stateVersion, 9, 'stateVersion 升到 9（skills 新增 sub 子能力标记）');
	let state = proj.init();
	proj.stateSchema.parse(state);
	assert.deepStrictEqual(state.skills, [], 'skills 初始为空数组');
	assert.deepStrictEqual(state.compacts, [], 'compacts 初始为空数组');

	/* 1. 技能两种来源各一条，manual 按来源标 */
	state = applyAll(proj, state, [userSkill('i-have-adhd'), toolSkill('ponytail')]);
	proj.stateSchema.parse(state);
	assert.deepStrictEqual(state.skills, [
		{ name: 'i-have-adhd', manual: true },
		{ name: 'ponytail', manual: false }
	], '斜杠命令 manual:true、skill 工具 manual:false，按注入顺序排');

	/* 2. 同一技能重复注入也各记一条（客户端自己聚合），不清旧记录 */
	state = applyAll(proj, state, [toolSkill('ponytail'), userSkill('ponytail')]);
	proj.stateSchema.parse(state);
	assert.deepStrictEqual(state.skills, [
		{ name: 'i-have-adhd', manual: true },
		{ name: 'ponytail', manual: false },
		{ name: 'ponytail', manual: false },
		{ name: 'ponytail', manual: true }
	], '重复注入逐条保留，manual 各按来源标');
	assert.strictEqual(state.toolCalls, 2, 'skill 工具调用照旧计入工具次数');

	/* 3. 失败压缩不计次数、不落档（真实日志：end 带 400/429 错误、没有 summary） */
	state = applyAll(proj, state, [
		compactStart('bad-1', 1),
		compactEnd('bad-1', 1, undefined, '400: {"message":"prompt is too long"}'),
		compactStart('bad-2', null, 'cmd-1'),
		compactEnd('bad-2', null, 'cmd-1', '429: too many requests')
	]);
	proj.stateSchema.parse(state);
	assert.strictEqual(state.compactCount, 0, '失败的压缩一次都不计');
	assert.deepStrictEqual(state.compacts, [], '失败的压缩不进 compacts');
	assert.strictEqual(state.compactTurn, null, '失败压缩不写 compactTurn');
	assert.strictEqual(state.compactStep, null, '失败压缩不写 compactStep');

	/* 4. 自动压缩成功：turn 取 end 的轮号，step 取压缩前最后一条同轮 step/start，manual:false */
	state = applyAll(proj, state, [
		{ type: 'step/start', time: at(), data: { turn: 5, step: 1 } },
		{ type: 'step/start', time: at(), data: { turn: 5, step: 2 } },
		compactStart('auto-1', 5),
		compactEnd('auto-1', 5)
	]);
	proj.stateSchema.parse(state);
	assert.strictEqual(state.compactCount, 1, '成功的自动压缩计一次');
	assert.strictEqual(state.compactTurn, 5, '轮号来自 end 事件');
	assert.strictEqual(state.compactStep, 2, '步号取压缩前最后一步');
	assert.deepStrictEqual(state.compacts, [{ turn: 5, step: 2, afterTurn: null, manual: false }], '自动压缩 manual:false，afterTurn null（自己有轮号）');

	/* 5. 成功之后再遇到失败（start 有、end 带 error）：计数不动、最近一次成功落点不动 */
	state = applyAll(proj, state, [
		compactStart('bad-after-ok', 5),
		compactEnd('bad-after-ok', 5, undefined, '429: too many requests')
	]);
	proj.stateSchema.parse(state);
	assert.strictEqual(state.compactCount, 1, '有 start 但 end 带 error 的压缩不增计数');
	assert.deepStrictEqual(state.compacts, [{ turn: 5, step: 2, afterTurn: null, manual: false }], '失败压缩不落档，也不改上一条');
	assert.strictEqual(state.compactStep, 2, '最近一次成功压缩的步号不变');

	/* 6. summary 缺失不能否决成功：判定只看 end 的 error。
	      真实日志里成功的 end 都伴随 summary（宿主 invariant 保证），但投影不去数它——
	      别把「没 summary = 失败」当启发式；日志损坏该由宿主的 invariant 拒绝，投影不承担。 */
	state = applyAll(proj, state, [
		compactStart('no-summary', 5),
		compactEnd('no-summary', 5)
	]);
	proj.stateSchema.parse(state);
	assert.strictEqual(state.compactCount, 2, '中间没有 summary、但 end 无 error：仍算成功');
	assert.deepStrictEqual(state.compacts, [
		{ turn: 5, step: 2, afterTurn: null, manual: false },
		{ turn: 5, step: 2, afterTurn: null, manual: false }
	], '第二次成功压缩追加落档（summary 不是判据）');

	/* 7. 用户手动 /compact 成功：轮间压缩没有 turn/step，但 afterTurn 记「压缩发生时最后已知轮号」，
	   客户端据此显示「第 N 轮后」，不再只给一个横杠 */
	let manual = proj.init();
	manual = applyAll(proj, manual, [
		{ type: 'step/start', time: at(), data: { turn: 4, step: 2 } },   // 前面已经跑到第 4 轮
		compactStart('manual-1', null, 'cmd-abc-1'),
		compactEnd('manual-1', null, 'cmd-abc-1')
	]);
	proj.stateSchema.parse(manual);
	assert.strictEqual(manual.compactCount, 1, '成功的手动压缩也计一次');
	assert.strictEqual(manual.compactTurn, null, '轮间压缩没有轮号');
	assert.strictEqual(manual.compactStep, null, '轮间压缩没有同轮步号可对，给 null');
	assert.deepStrictEqual(manual.compacts, [{ turn: null, step: null, afterTurn: 4, manual: true }], '手动压缩 manual:true，afterTurn=最后已知轮号');
	/* 手动失败那条：不计、不落档，也不影响已成功的那条 */
	manual = applyAll(proj, manual, [
		compactStart('manual-2', null, 'cmd-abc-2'),
		compactEnd('manual-2', null, 'cmd-abc-2', '429: too many requests')
	]);
	proj.stateSchema.parse(manual);
	assert.strictEqual(manual.compactCount, 1, '手动压缩失败也不计次数');
	assert.deepStrictEqual(manual.compacts, [{ turn: null, step: null, afterTurn: 4, manual: true }], '手动压缩失败不落档');

	/* 7b. 连「最后已知轮号」都没有（新会话第一次压缩就是轮间压缩）：afterTurn 给 null */
	let noTurn = proj.init();
	noTurn = applyAll(proj, noTurn, [
		compactStart('manual-0', null, 'cmd-x'),
		compactEnd('manual-0', null, 'cmd-x')
	]);
	proj.stateSchema.parse(noTurn);
	assert.deepStrictEqual(noTurn.compacts, [{ turn: null, step: null, afterTurn: null, manual: true }], '没有已知轮号时 afterTurn 给 null');

	/* 8. 自动压缩落在轮首（压缩前没有同轮 step）：轮号照给、步号 null */
	let cold = proj.init();
	cold = applyAll(proj, cold, [compactStart('cold-1', 9), compactEnd('cold-1', 9)]);
	proj.stateSchema.parse(cold);
	assert.strictEqual(cold.compactTurn, 9, '轮首压缩轮号照给');
	assert.strictEqual(cold.compactStep, null, '压缩前没有同轮步号时给 null');
	assert.deepStrictEqual(cold.compacts, [{ turn: 9, step: null, afterTurn: null, manual: false }], '轮首压缩也落档');

	/* 9. 旧字段形状必须被拒（stateVersion 变了，旧 state 会重建而不是带病沿用） */
	assert.strictEqual(
		proj.stateSchema.safeParse({ ...proj.init(), skills: ['ponytail'] }).success,
		false,
		'旧 skills: string[] 形状不再被接受'
	);
	assert.strictEqual(
		proj.stateSchema.safeParse({ ...proj.init(), compacts: [{ turn: 1, step: 2 }] }).success,
		false,
		'旧 compacts 缺 manual 不再被接受'
	);
	assert.strictEqual(
		proj.stateSchema.safeParse({ ...proj.init(), compacts: [{ turn: 1, step: 2, manual: false }] }).success,
		false,
		'旧 compacts 缺 afterTurn 不再被接受'
	);

	/* 10. 无关事件不改变状态（投影要能安全地喂任何事件） */
	const before = JSON.stringify(state);
	state = applyAll(proj, state, [
		{ type: 'tool/result', time: at(), data: { turn: 1, step: 1 } },
		{ type: 'assistant/message', time: at(), data: {} },
		{ type: 'compaction/summary', time: at(), data: { compactionId: 'auto-1' } }
	]);
	assert.strictEqual(JSON.stringify(state), before, '无关事件不改进度状态');

	console.log('进度投影事件语义:', JSON.stringify({
		stateVersion: proj.stateVersion,
		skills: state.skills,
		compactCount: state.compactCount,
		compacts: state.compacts
	}));
	console.log('\nPROGRESS EVENT CHECKS PASSED');
})().catch((error) => {
	console.error('PROGRESS EVENT CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
