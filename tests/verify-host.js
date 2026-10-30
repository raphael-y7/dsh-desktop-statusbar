/**
 * host 侧投影测试：确认 usage 从 stream chunk 里取得到（而不是只看 data.usage）。
 * 这直接对应"费用恒为 0"的根因。
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

	/* 2. usage 在 data.usage（兜底路径）。inputTokens 就是未命中输入，不再减缓存 */
	const usage2 = { inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0 };
	state = usageProj.apply(state, {
		type: 'assistant/message',
		time: Date.now(),
		data: { turn: 1, step: 2, message, usage: usage2, stream: [] }
	});
	usageProj.stateSchema.parse(state);
	console.log('data.usage 取到调用:', JSON.stringify(state.calls[1]));

	/* 3. input 原样保留：inputTokens 是"未命中缓存的输入"，与官方 uncachedInputTokens 同口径。
	   实测会话里这项曾因多减一次 cacheRead 从 1.80M 掉到 1.22M，总计因此少算。 */
	assert.strictEqual(state.calls.length, 2, 'two calls recorded');
	assert.deepStrictEqual(state.calls[0], {
		at: state.calls[0].at, model: 'deepseek-flash',
		input: 375000, cacheRead: 1900000, cacheWrite: 0, output: 41000
	}, 'stream usage keeps inputTokens as the uncached input');
	assert.ok(state.calls[0].at > 0, 'call carries a timestamp');
	assert.strictEqual(state.calls[1].input, 5000, 'data.usage path keeps inputTokens as-is');
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

	/* 9. 没有 message 的事件（assistant/attempt）：型号从前面的请求记录补。
	   这类事件只有 stream 带 usage，直接读 event.data.message.source 会抛 TypeError；
	   而投影抛错会顺着引擎的 fold 循环冒出去，整条投影从此停摆（cell 水位线不前进，
	   下一条事件又从同一条崩溃事件重放）。会话起标题的后台调用就走这条路。 */
	let routed = usageProj.init();
	routed = usageProj.apply(routed, {
		type: 'session/title-llm-request',
		time: Date.now(),
		data: { route: { model: 'deepseek-flash', provider: 'deepseek-official' }, messages: [], system: '', maxTokens: 64 }
	});
	routed = usageProj.apply(routed, {
		type: 'assistant/attempt',
		time: Date.now(),
		data: { turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } } }] }
	});
	usageProj.stateSchema.parse(routed);
	assert.strictEqual(routed.calls.length, 1, 'attempt 的用量照记，不再抛错');
	assert.strictEqual(routed.calls[0].model, 'deepseek-flash', '型号取自前面那条请求记录');
	assert.strictEqual(routed.calls[0].input, 120, 'attempt 的用量分量按 stream 里的 usage 记');
	assert.strictEqual(routed.current.provider, 'deepseek-official', 'provider 也从前面的请求记录补');

	/* 10. model/selection 同样能提供型号（普通对话里没有 title 请求时走这条） */
	let selected = usageProj.init();
	selected = usageProj.apply(selected, {
		type: 'model/selection',
		time: Date.now(),
		data: { model: 'deepseek-v4-pro', provider: 'deepseek-official', reasoningEffort: 'medium' }
	});
	selected = usageProj.apply(selected, {
		type: 'assistant/attempt',
		time: Date.now(),
		data: { turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } }] }
	});
	usageProj.stateSchema.parse(selected);
	assert.strictEqual(selected.calls.length, 1, 'model/selection 之后 attempt 也照记');
	assert.strictEqual(selected.calls[0].model, 'deepseek-v4-pro', '型号取自 model/selection');

	/* 11. 两条路都拿不到型号：安全跳过这一笔，而不是抛错 */
	let orphan = usageProj.init();
	orphan = usageProj.apply(orphan, {
		type: 'assistant/attempt',
		time: Date.now(),
		data: { turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } }] }
	});
	usageProj.stateSchema.parse(orphan);
	assert.strictEqual(orphan.calls.length, 0, '没有型号来源时跳过，不抛错');
	console.log('无 message 的事件:', JSON.stringify({ routed: routed.calls[0].model, selected: selected.calls[0].model, skipped: orphan.calls.length }));

	/* 12. 轮次项气泡的数：step/start 折本轮步数、tool/call 折总次数与各工具名次数、
	       compaction/end：成功后计数并落档（带 error 的失败不计）（气泡里那三行点开就是这些明细） */
	const progressProj = registered.filter((p) => p.key === 'desktopStatusbarProgress')[0];
	assert.ok(progressProj !== undefined, 'progress projection registered');
	let progress = progressProj.init();
	progressProj.stateSchema.parse(progress);

	/* 第 1 轮走到第 3 步，期间两次工具调用 */
	[[1, 1], [1, 2], [1, 3]].forEach(([turn, step]) => {
		progress = progressProj.apply(progress, { type: 'step/start', time: Date.now(), data: { turn, step } });
	});
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 1, name: 'read' } });
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3, name: 'bash' } });
	/* 技能是靠调用 skill 工具注入的：它算进工具调用总次数，也单独记一笔技能注入 */
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3, name: 'skill', arguments: '{"name":"ponytail"}' } });
	progressProj.stateSchema.parse(progress);
	assert.strictEqual(progress.turnSteps, 3, '本轮步数取轮内最大步号');
	assert.strictEqual(progress.toolCalls, 3, '工具调用次数累加（含 skill 工具）');
	assert.deepStrictEqual(progress.toolCounts, { read: 1, bash: 1, skill: 1 }, '每个工具名各自的次数都记下来');
	assert.deepStrictEqual(progress.skills, [{ name: 'ponytail', manual: false }], 'skill 工具注入记下技能名并标 manual:false，别的工具不算');
	/* 参数坏掉的那次：不记名字，但仍算一次工具调用；顺序按注入先后 */
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3, name: 'skill', arguments: '{坏掉的' } });
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3, name: 'skill', arguments: '{"name":"my-dow-theory"}' } });
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3, name: 'read' } });
	progressProj.stateSchema.parse(progress);
	assert.deepStrictEqual(progress.skills, [{ name: 'ponytail', manual: false }, { name: 'my-dow-theory', manual: false }], '参数坏掉的不进列表，名字按注入顺序排');
	assert.strictEqual(progress.toolCalls, 6, '参数坏掉的 skill 调用照样算工具调用');
	assert.deepStrictEqual(progress.toolCounts, { read: 2, bash: 1, skill: 3 }, '同名工具累加，不新开一项');
	/* 没带 name 的调用（真实日志里没有，但别让它落成一项 "undefined"） */
	progress = progressProj.apply(progress, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 3 } });
	progressProj.stateSchema.parse(progress);
	assert.deepStrictEqual(progress.toolCounts, { read: 2, bash: 1, skill: 3 }, '没有工具名的那次只进总数，不进名单');
	assert.strictEqual(progress.toolCalls, 7, '没有工具名也算一次调用');

	/* 斜杠命令注入技能走的是另一条路：一条 user/message，source.kind = 'skill-invocation'。
	   skill-catalog（可用技能清单，每次会话都注入）不是技能注入，必须排除 */
	let slash = progressProj.init();
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: { source: { kind: 'skill-invocation', name: 'i-have-adhd', form: 'instructions' } } });
	progressProj.stateSchema.parse(slash);
	assert.deepStrictEqual(slash.skills, [{ name: 'i-have-adhd', manual: true }], '斜杠命令注入的技能进 skills，标 manual:true');
	/* 夹具特意带一个顶层 name：真实 skill-catalog 目前没有它，但排除规则必须钉在 kind 上 ——
	   否则哪天宿主给 catalog 补个 name，"只靠 name 缺失"的实现就会把 60+ 个技能名全收进 skills */
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: { source: { kind: 'skill-catalog', name: 'catalog-marker', entries: [{ name: 'ponytail' }, { name: 'my-dow-theory' }] } } });
	progressProj.stateSchema.parse(slash);
	assert.deepStrictEqual(slash.skills, [{ name: 'i-have-adhd', manual: true }], 'skill-catalog 不进 skills（每会话都注入，算进去会虚增）');
	assert.strictEqual(slash.globalInstruction, null, 'skill-catalog 也不冒充全局提示词');
	/* 两种来源混在一起：顺序按注入先后，不看来源 */
	slash = progressProj.apply(slash, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 1, name: 'skill', arguments: '{"name":"ponytail"}' } });
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: { source: { kind: 'skill-invocation', name: 'my-dow-theory' } } });
	progressProj.stateSchema.parse(slash);
	assert.deepStrictEqual(slash.skills, [{ name: 'i-have-adhd', manual: true }, { name: 'ponytail', manual: false }, { name: 'my-dow-theory', manual: true }], '工具调用与斜杠命令两种来源按注入先后合并，manual 各按来源标');
	/* 取不到名字时不落一项，也不能因此崩掉 */
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: { source: { kind: 'skill-invocation', form: 'instructions' } } });
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: undefined });
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now() });
	progressProj.stateSchema.parse(slash);
	assert.deepStrictEqual(slash.skills, [{ name: 'i-have-adhd', manual: true }, { name: 'ponytail', manual: false }, { name: 'my-dow-theory', manual: true }], 'source 缺 name / 整个 data 都没有时只跳过这一条');
	/* 全局提示词那条路没被新分支挤掉：agent-instructions 照旧只进 globalInstruction */
	slash = progressProj.apply(slash, { type: 'user/message', time: Date.now(), data: { source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', scope: 'user-global\u0000AGENTS.md', path: '~/.dsh/AGENTS.md', digest: 'x' }] } } });
	progressProj.stateSchema.parse(slash);
	assert.strictEqual(slash.globalInstruction, 'AGENTS.md', 'agent-instructions 仍走全局提示词那条路');
	assert.deepStrictEqual(slash.skills, [{ name: 'i-have-adhd', manual: true }, { name: 'ponytail', manual: false }, { name: 'my-dow-theory', manual: true }], '全局提示词不算技能注入');

	/* 子能力读取（task-12）：模型读 `skills/<包名>/references/...` 里的子能力文档时也要记一条，
	   用 `sub: true` 与"注入技能本身"区分开。用户要的是「我用了哪个子能力」能看见：
	   平铺显示、不加父技能前缀、名字后加角标。用独立 state，免得动上面那串断言。 */
	let sub = progressProj.init();
	/* ① `<包名>/references/<X>/<X>.md`（ponytail / mao / sunzi 这类布局）：目录名与文件名同名 */
	sub = progressProj.apply(sub, {
		type: 'tool/call', time: Date.now(),
		data: {
			turn: 1, step: 1, name: 'read',
			arguments: JSON.stringify({ file_path: 'C:\\Users\\rapha\\.agents\\skills\\ponytail\\references\\ponytail-review\\ponytail-review.md' })
		}
	});
	progressProj.stateSchema.parse(sub);
	assert.deepStrictEqual(sub.skills, [{ name: 'ponytail-review', manual: false, sub: true }],
		'读 ponytail 的子能力文档 ⇒ 记 { name, manual:false, sub:true }（反斜杠路径也要认出）');
	assert.strictEqual(sub.toolCalls, 1, '读子能力文档照样算一次工具调用（既有逻辑不动）');
	assert.deepStrictEqual(sub.toolCounts, { read: 1 }, '工具名计数照旧');

	/* ② `<包名>/references/capabilities/<X>.md`（gann 那类主入口 + capabilities 子目录）。
	   参数用 `path` 键（read 的另一种写法），顺便覆盖"两个键都认"。 */
	sub = progressProj.apply(sub, {
		type: 'tool/call', time: Date.now(),
		data: {
			turn: 1, step: 2, name: 'read',
			arguments: JSON.stringify({ path: '/home/u/.agents/skills/gann-trend-detector/references/capabilities/trend-judgment.md' })
		}
	});
	progressProj.stateSchema.parse(sub);
	assert.deepStrictEqual(sub.skills, [
		{ name: 'ponytail-review', manual: false, sub: true },
		{ name: 'trend-judgment', manual: false, sub: true }
	], '读 gann 的 capabilities/trend-judgment.md ⇒ 记 trend-judgment（斜杠路径、path 键也认）');

	/* ③ 辅助文件不记：形状本身就是判据（这些文件名不符合那两种形状），不需要白名单。
	   同时覆盖"单文件子能力"（references/<名>.md，candlestick 那种）也**不**记。 */
	const subBefore = sub.skills.length;
	[
		'/home/u/.agents/skills/gann-trend-detector/references/glossary.md',
		'/home/u/.agents/skills/gann-trend-detector/references/overview.md',
		'/home/u/.agents/skills/x/references/cheatsheet.md',
		'/home/u/.agents/skills/x/references/capability-index.md',
		'/home/u/.agents/skills/candlestick-analysis/references/candlestick-analysis.md',
		/* 目录名与文件名不同名 ⇒ 不是 ① 那种形状，不记 */
		'/home/u/.agents/skills/some-skill/references/notes/other-name.md',
		'/home/u/.agents/skills/some-skill/references/capabilities/',
		'/home/u/.agents/skills/some-skill/references/capabilities/x.txt',
		'/home/u/.agents/skills/ponytail/SKILL.md',
		'/home/u/project/src/index.js'
	].forEach((one) => {
		sub = progressProj.apply(sub, {
			type: 'tool/call', time: Date.now(),
			data: { turn: 1, step: 3, name: 'read', arguments: JSON.stringify({ path: one }) }
		});
	});
	progressProj.stateSchema.parse(sub);
	assert.strictEqual(sub.skills.length, subBefore,
		'辅助文件 / 单文件子能力 / 普通源码都不记（实际多了 ' + (sub.skills.length - subBefore) + ' 条）');
	assert.strictEqual(sub.toolCalls, 12, '不记技能但这些读取照样各算一次工具调用（前面 3 次 + 这 9 次）');

	/* 一次 ops_read_files 读多个文件：命中的按读到顺序各记一条 */
	sub = progressProj.apply(sub, {
		type: 'tool/call', time: Date.now(),
		data: {
			turn: 1, step: 4, name: 'ops_read_files',
			arguments: JSON.stringify({
				files: [
					{ path: '/s/.agents/skills/mao-selected-works-skill/references/mao-investigation/mao-investigation.md' },
					{ path: '/s/.agents/skills/gann-trend-detector/references/glossary.md' },
					{ path: '/s/.agents/skills/gann-trend-detector/references/capabilities/position-sizing.md' }
				]
			})
		}
	});
	progressProj.stateSchema.parse(sub);
	assert.deepStrictEqual(sub.skills.slice(-2), [
		{ name: 'mao-investigation', manual: false, sub: true },
		{ name: 'position-sizing', manual: false, sub: true }
	], 'ops_read_files 一次读多个：命中的按顺序各记一条，没命中的跳过');

	/* ④ 斜杠命令仍是 manual:true 且**不带** sub 键（客户端靠"有没有 sub"决定角标位置，
	   多一个 sub:false 会让它误判成子能力） */
	let slashCheck = progressProj.init();
	slashCheck = progressProj.apply(slashCheck, { type: 'user/message', time: Date.now(), data: { source: { kind: 'skill-invocation', name: 'i-have-adhd', form: 'instructions' } } });
	slashCheck = progressProj.apply(slashCheck, { type: 'tool/call', time: Date.now(), data: { turn: 1, step: 1, name: 'skill', arguments: '{"name":"ponytail"}' } });
	progressProj.stateSchema.parse(slashCheck);
	assert.deepStrictEqual(slashCheck.skills, [{ name: 'i-have-adhd', manual: true }, { name: 'ponytail', manual: false }],
		'斜杠命令 manual:true、skill 工具 manual:false，两条都**没有** sub 键');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(slashCheck.skills[0], 'sub'), false,
		'斜杠命令那条不许出现 sub 键（客户端按"有 sub"判子能力）');
	assert.strictEqual(Object.prototype.hasOwnProperty.call(slashCheck.skills[1], 'sub'), false,
		'skill 工具那条同样不许出现 sub 键');

	/* ⑤ 老数据兼容：`sub` 是 optional，旧 state（skills 里没有这个键）必须仍能过 .strict() 校验。
	   这是硬要求 —— 老缓存反序列化时 schema 收紧过一次，整条投影会被宿主拒掉。 */
	const legacy = {
		turn: 1, turnSteps: 2, toolCalls: 3, toolCounts: { read: 2, skill: 1 },
		skills: [{ name: 'ponytail', manual: false }, { name: 'i-have-adhd', manual: true }],
		globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: []
	};
	assert.doesNotThrow(() => progressProj.stateSchema.parse(legacy),
		'老 state（skills 无 sub 字段）必须仍能通过 schema 校验（sub 是 optional）');
	const parsedLegacy = progressProj.stateSchema.parse(legacy);
	assert.strictEqual(parsedLegacy.skills.length, 2, '老数据解析后技能条数不变');
	assert.strictEqual(parsedLegacy.skills[0].sub, undefined, '老数据里没有 sub 就是 undefined，不会被补成 false');
	/* stateVersion 要升过一档：技能新增子能力标记，旧缓存得重放才能把读过的子能力补进来 */
	assert.ok(progressProj.stateVersion >= 9, 'stateVersion 已提升（技能新增 sub 标记），实际 ' + progressProj.stateVersion);
	console.log('子能力标记:', JSON.stringify(sub.skills.slice(-2)), '· stateVersion =', progressProj.stateVersion);

	/* 压缩落点：宿主在 compaction/end 判定结果——成功（不带 error，且必有 compaction/summary）才计数。
	   轮号取 end 的 turn，步号取压缩前最后一条同轮 step/start（压缩事务中间不会插 step/start） */
	progress = progressProj.apply(progress, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'x', turn: 1 } });
	progress = progressProj.apply(progress, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'x', turn: 1 } });
	progressProj.stateSchema.parse(progress);
	assert.strictEqual(progress.compactCount, 1, '成功的压缩才累加次数');
	assert.strictEqual(progress.compactTurn, 1, '压缩轮号来自 end 事件');
	assert.strictEqual(progress.compactStep, 3, '压缩节点取压缩前最后一步');
	assert.deepStrictEqual(progress.compacts, [{ turn: 1, step: 3, afterTurn: null, manual: false }], '成功压缩的落点留档（气泡里逐条列），自动压缩 manual:false');

	/* 失败压缩（模型报错时只发 compaction/end + error，没有 summary）：不计次数、不落档 */
	progress = progressProj.apply(progress, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'bad', turn: 1 } });
	progress = progressProj.apply(progress, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'bad', turn: 1, error: '400: prompt is too long' } });
	progressProj.stateSchema.parse(progress);
	assert.strictEqual(progress.compactCount, 1, '失败的压缩不计次数');
	assert.deepStrictEqual(progress.compacts, [{ turn: 1, step: 3, afterTurn: null, manual: false }], '失败的压缩不落档');
	assert.strictEqual(progress.compactTurn, 1, '失败压缩不改最近一次成功压缩的落点');

	/* 换轮：本轮步数归零重数，累计的计数不动 */
	progress = progressProj.apply(progress, { type: 'step/start', time: Date.now(), data: { turn: 2, step: 1 } });
	progressProj.stateSchema.parse(progress);
	assert.strictEqual(progress.turnSteps, 1, '换轮后本轮步数重数');
	assert.strictEqual(progress.toolCalls, 7, '换轮不影响累计工具调用次数');
	assert.strictEqual(progress.compactStep, 3, '换轮不影响压缩节点');
	/* 第二次成功压缩：留档追加，不改前一条 */
	progress = progressProj.apply(progress, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'z', turn: 2 } });
	progress = progressProj.apply(progress, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'z', turn: 2 } });
	progressProj.stateSchema.parse(progress);
	assert.deepStrictEqual(progress.compacts, [{ turn: 1, step: 3, afterTurn: null, manual: false }, { turn: 2, step: 1, afterTurn: null, manual: false }], '压缩落点按发生顺序追加');

	/* 用户手动 /compact：轮间压缩（start/summary/end 都带 sourceCommandId，turn=null） */
	let manual = progressProj.init();
	manual = progressProj.apply(manual, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'm', turn: null, sourceCommandId: 'cmd-1' } });
	manual = progressProj.apply(manual, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'm', turn: null, sourceCommandId: 'cmd-1' } });
	progressProj.stateSchema.parse(manual);
	assert.strictEqual(manual.compactCount, 1, '成功的手动压缩也计数');
	assert.strictEqual(manual.compactTurn, null, '轮间压缩没有轮号');
	assert.strictEqual(manual.compactStep, null, '轮间压缩没有同轮步号可对，给 null');
	assert.deepStrictEqual(manual.compacts, [{ turn: null, step: null, afterTurn: null, manual: true }], '用户手动 /compact 记 manual:true；state.turn=0 时 afterTurn 给 null');

	/* 压缩落在轮首、压缩前没有同轮的步：步号给 null，客户端只显示轮号 */
	let cold = progressProj.init();
	cold = progressProj.apply(cold, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'y', turn: 7 } });
	cold = progressProj.apply(cold, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'y', turn: 7 } });
	progressProj.stateSchema.parse(cold);
	assert.strictEqual(cold.compactTurn, 7, '压缩轮号照给');
	assert.strictEqual(cold.compactStep, null, '取不到轮内步号时给 null');
	assert.deepStrictEqual(cold.compacts, [{ turn: 7, step: null, afterTurn: null, manual: false }], '轮首压缩也留档，步号 null');
	console.log('进度投影:', JSON.stringify({ turnSteps: progress.turnSteps, toolCalls: progress.toolCalls, toolNames: Object.keys(progress.toolCounts).length, skills: progress.skills, compactCount: progress.compactCount, compacts: progress.compacts }));

	console.log('\nHOST PROJECTION CHECKS PASSED');
})().catch((error) => {
	console.error('HOST PROJECTION CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
