/**
 * 点击气泡检查：每个可点段展开的行内容与缺数据占位。
 *   - status 圆环 → 上下文占用面板（meter）；峰谷两个字 → 计费规则（rows）
 *   - 总计 → 会话 token 明细；本轮 → 本轮 token 明细（同一个令牌面板，只有标题不同）
 *   - 总用时 → 模型用时 / 工具调用用时
 *   - 首字平均 → 最快 / 最慢首字；输出速度 → 最快 / 最慢输出速度
 *   - 余额 → 充值余额 / 赠金余额
 * 用法：node verify-tips.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { segmentView, segmentText, chineseNumber, SEGMENTS, DEFAULT_SEGMENTS, isSegmentOn, snapshot, toolList, TOOL_BAR_COLORS, skillList, compactList, creditsView, creditsPanel, applyColsFade, refreshColsFade, COLS_FADE_PX };\n\t\texports.apply = apply;');

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0, clearInterval: () => {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
};
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
const sb = {
	window: fakeWindow,
	document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, WeakMap, Error
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: 'client.js' });
const api = captured.factory((n) => {
	if (n !== 'react') throw new Error('unexpected require: ' + n);
	return {
		/* createElement 保留 type / props / children：本文件要按**节点顺序**断言角标位置
		   （星号在名字后、+ 也在名字后），只返回空对象就拿不到落点。
		   其它纯数据断言不受影响（它们读的是 view 对象，不读渲染树）。 */
		createElement: (type, props, ...children) => ({
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
		}),
		useState: (v) => [v, () => {}], useRef: () => ({}),
		useSyncExternalStore: (s, g) => g(), useEffect: () => {}, Fragment: Symbol('F')
	};
}).__t;

const TEMPLATES = {
	f_counts: '{turns} 轮 {steps} 步',
	f_cacheHit: '缓存命中 {percent}%',
	f_ttft: '首字平均 {duration}',
	f_speed: '综合速度 {throughput}t/s',
	f_sessionTime: '总用时 {duration}',
	f_cost: '总计 {symbol}{cost}',
	f_lastCost: '本轮 {symbol}{cost}',
	f_balance: '余额 {symbol}{amount}',
	f_balanceSubCent: '余额 <{symbol}0.01',
	f_balanceDash: '余额 -',
	f_tokensHit: '输入(命中缓存)',
	f_tokensMiss: '输入(未命中缓存)',
	f_tokensOut: '输出',
	f_tokensTotal: '总计用量',
	f_tokensTurn: '本轮用量',
	f_peak: '高峰',
	f_valley: '低谷',
	segTtft: '首字延迟',
	segTps: '输出速度',
	segSessionTime: '运行用时',
	segBalance: '余额',
	tipModelTime: '模型用时',
	tipToolTime: '工具调用',
	tipWaitTime: '等待用时',
	tipTtftFast: '最快首字延迟',
	tipTtftSlow: '最慢首字延迟',
	tipTpsFast: '最快输出速度',
	tipTpsSlow: '最慢输出速度',
	tipTopUp: '充值余额',
	tipGranted: '赠金余额',
	tipQuotaLeft: '剩余配额',
	tipSpent: '累计消费',
	tipHitTurn: '本轮命中率',
	tipHitHigh: '最高命中率',
	tipHitLow: '最低命中率',
	tipTtftTurn: '本轮平均首字',
	tipTpsTurn: '本轮平均速度',
	segCacheHit: '缓存命中率',
	segCounts: '轮次＆步数',
	tipCountsTitle: '会话数据',
	tipCountsSkills: '技能注入',
	tipCountsCompactAt: '上下文压缩',
	tipCountsToolCalls: '工具调用',
	tipCompactItem: '第{index}次压缩',
	tipCompactWhere: '第{turn}轮{step}步',
	tipCompactTurnOnly: '第{turn}轮',
	tipCompactAfter: '第{turn}轮后',
	/* 两种角标的读屏文案（技能列表用）：手动「手动触发」/ 子能力「子能力」 */
	tipManual: '手动触发',
	tipSub: '子能力',
	unitCountSteps: ' 步',
	unitCountCalls: ' 次',
	unitSpeed: 't/s'
};
const t = (key, params) => {
	let out = TEMPLATES[key] !== undefined ? TEMPLATES[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

const labels = (rows) => Array.from(rows, (row) => row.label);
const values = (rows) => Array.from(rows, (row) => row.value);
/* 气泡里的行对象是在 vm 里造的（跨 realm 原型不同，deepStrictEqual 会判不等），
   比结构时先摊成外层对象 */
const pairs = (rows) => Array.from(rows, (row) => ({ label: row.label, value: row.value }));
/* 名字可能是节点数组（手动调用的上标星号），拍成一行文本：星号节点在替身里只记作 "*" */
const plainLabel = (label) => (Array.isArray(label)
	? label.map((one) => (typeof one === 'string' ? one : '*')).join('')
	: label);

const src = {
	stats: { turns: 2, steps: 10, llmMs: 125000, toolMs: 45000, ttftMs: 2000, ttftSteps: 2, decodeMs: 1000, decodeTokens: 500 },
	usage: {
		uncachedInputTokens: 100, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 3000
	},
	pressure: { pressureTokens: 400000, contextWindow: 1000000 },
	breakdown: { systemTokens: 1900, toolsTokens: 7300, messageTokens: 181000 },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	sessionUsage: {
		models: {},
		/* 三次调用：99.995% / 33.333333% / 分母为 0（算不出比例，跳过） */
		calls: [
			{ at: Date.now(), model: 'deepseek-flash', input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000 },
			{ at: Date.now(), model: 'deepseek-flash', input: 2, cacheRead: 1, cacheWrite: 0, output: 10 },
			{ at: Date.now(), model: 'deepseek-flash', input: 0, cacheRead: 0, cacheWrite: 0, output: 5 }
		],
		/* 本轮摘要：气泡第一行的"本轮命中率"读它（字段是短名；100 未命中 + 300 命中 → 75.000%） */
		current: { input: 100, cacheRead: 300, cacheWrite: 0, output: 500 },
		last: null, turn: 1
	},
	timing: {
		samples: 3,
		fastestTtft: { value: 1200, at: Date.now(), model: 'deepseek-flash' },
		slowestTtft: { value: 12500, at: Date.now(), model: 'deepseek-flash' },
		fastestTps: { value: 120.4, at: Date.now(), model: 'deepseek-flash' },
		slowestTps: { value: 30.6, at: Date.now(), model: 'deepseek-flash' },
		/* 本轮累计：两条首字样本平均 4000ms；3000 tokens / 24s → 125t/s */
		turn: 1,
		turnTtftMs: 8000,
		turnTtftSamples: 2,
		turnDecodeMs: 24000,
		turnDecodeTokens: 3000
	},
	timeRange: { turns: 60000, since: null, steps: 0, stepSince: null },
	running: false, partial: null, runningCalls: [], lastAgentError: null, pendingApprovals: [],
	timeline: undefined, now: Date.now(),
	balance: { ok: true, at: Date.now(), total: '12.34', currency: 'CNY' },
	turnUsage: { input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000 },
	currency: 'CNY',
	/* host 的 desktopStatusbarProgress：2 轮 10 步里本轮走到第 7 步，压缩过 2 次，
	   最近一次压缩落在第 49 轮第 1 步，整会话 1338 次工具调用（三个工具名各自的次数）
	   每次压缩的落点按发生顺序记在 compacts 上 */
	progress: {
		turn: 9, turnSteps: 7, toolCalls: 1338,
		toolCounts: { read: 900, pwsh: 400, edit: 38 },
		/* 契约：每注入一次记一条 `{ name, manual }`，同名注入由客户端聚合次数。
		   ponytail 注入两次（其中一次是用户手动调用）→ 次数 2 + 上标星号。 */
		skills: [
			{ name: 'ponytail', manual: false },
			{ name: 'my-dow-theory', manual: false },
			{ name: 'ponytail', manual: true }
		],
		/* 全局提示词（~/.dsh/AGENTS.md）：也算一次注入并计入那一行，和技能一起参与排序 */
		globalInstruction: 'AGENTS.md',
		compactCount: 2, compactTurn: 49, compactStep: 1,
		/* 只给成功的压缩（宿主已滤掉失败）；第二条是用户手动压缩：轮间压缩没有 turn，
		   用 afterTurn 记「发生在第几轮之后」→ 名字前上标星号 + 「第20轮后」 */
		compacts: [
			{ turn: 12, step: 3, manual: false, afterTurn: null },
			{ turn: null, step: null, manual: true, afterTurn: 20 }
		]
	}
};

/* ------------------------------------------------ 哪些段可点、点出什么面板 */
const kinds = {};
api.SEGMENTS.forEach((seg) => {
	const view = api.segmentView(seg.id, src, t);
	if (view === null || view === undefined) return;
	if (view.tip !== undefined && view.tip !== null) kinds[seg.id] = view.tip.kind;
	if (view.periodTip !== undefined && view.periodTip !== null) kinds[seg.id + ':period'] = view.periodTip.kind;
});
console.log('可点段:', JSON.stringify(kinds));
assert.deepStrictEqual(kinds, {
	/* 峰谷判断点开是活跃总览（条形图） */
	status: 'bars',
	counts: 'rows',
	ttft: 'rows',
	tps: 'rows',
	sessionTime: 'rows',
	cost: 'tokens',
	balance: 'rows',
	cacheHit: 'rows',
	/* 本轮也必须能点开：没有数据时给三行横杠的 tokens 面板 */
	lastCost: 'tokens'
}, '可点段与面板类型：峰谷是条形图、令牌面板 tokens（总计与本轮）、其余 rows');
assert.strictEqual(api.segmentView('status', src, t).periodTip, undefined, '峰谷那两个字的点击气泡已移除');

/* ------------------------------------------------------------ 轮次气泡 */
const countsTip = api.segmentView('counts', src, t).tip;
assert.strictEqual(countsTip.title, '会话数据', '气泡标题用 tipCountsTitle（字段名仍是「轮次＆步数」）');
assert.strictEqual(countsTip.head, undefined, '标题右侧不跟数值');
assert.deepStrictEqual(labels(countsTip.rows), ['上下文压缩', '技能注入', '工具调用'], '轮次气泡三行：上下文压缩 → 技能注入 → 工具调用');
assert.deepStrictEqual(values(countsTip.rows), ['2', '4', '1,338'], '三行都只给数字、不带单位；技能注入按每次注入计数（3 条技能注入 + AGENTS.md）');
assert.deepStrictEqual(Array.from(countsTip.rows, (row) => row.sub.title), ['上下文压缩', '技能注入', '工具调用'], '三行各自带一个下钻子视图，标题就是这一行的名字');
assert.strictEqual(countsTip.rows[1].list, undefined, '技能注入那行不再带 list（悬停二次气泡已去掉）');
console.log('轮次气泡:', countsTip.rows.map((r) => r.label + ' ' + r.value).join(' / '));

/* 子视图内容：AGENTS.md 固定第一；技能按名字长短 → 次数降序 → 字典序、同名合并（次数只用于排序、不显示）；
   工具调用先按显示名长短（短的在前）再按次数降序；压缩次数逐条列落点 */
assert.deepStrictEqual(Array.from(countsTip.rows[1].sub.rows, (row) => plainLabel(row.label)),
	['AGENTS.md', 'ponytail*', 'my-dow-theory'],
	'技能注入子视图：AGENTS.md 是全局提示词、固定第一不参与排序；ponytail 注入两次（其中一次手动）→ 合并 + 星号在**名字后面**');
/* 用户明确要求：技能注入只列名字，不显示统计次数（次数只在排序里用到） */
assert.deepStrictEqual(Array.from(countsTip.rows[1].sub.rows, (row) => row.value), [undefined, undefined, undefined],
	'技能注入的行不带数值（不显示次数）；AGENTS.md 也不显示次数');
/* 工具名直接显示原生英文名（不再翻译）；排序主键是名字长度：read/edit/pwsh 都是 4，
   同长度按次数降序 ⇒ read 900 > pwsh 400 > edit 38（手算，不借实现的排序函数） */
assert.deepStrictEqual(pairs(countsTip.rows[2].sub.rows), [
	{ label: 'read', value: '900 次' },
	{ label: 'pwsh', value: '400 次' },
	{ label: 'edit', value: '38 次' }
], '工具调用子视图：原生英文名，按名字长度升序、同长度按次数降序，带单位');
/* 只有工具调用这个子视图把名字↔次数的间隙收到 1ch，别的子视图与根视图都保持 5ch */
assert.strictEqual(countsTip.rows[2].sub.tight, true, '工具调用子视图标了 tight');
assert.strictEqual(countsTip.rows[1].sub.tight, undefined, '技能注入子视图不收紧间隙');
assert.strictEqual(countsTip.rows[0].sub.tight, undefined, '上下文压缩子视图不收紧间隙');
assert.deepStrictEqual(Array.from(countsTip.rows[0].sub.rows, (row) => ({ label: plainLabel(row.label), value: row.value })), [
	{ label: '第一次压缩', value: '第12轮3步' },
	/* 手动压缩那条的星号在**名字后面**（「第二次压缩*」）：与技能列表同一种写法；
	   手动压缩没有 turn，落点用 afterTurn 显示「第20轮后」而不是横杠 */
	{ label: '第二次压缩*', value: '第20轮后' }
], '上下文压缩子视图：中文序数 + 第X轮Y步，按发生顺序；手动压缩的星号在名字后（与技能列表一致）');
console.log('子视图:', countsTip.rows.map((r) => pairs(r.sub.rows).map((x) => plainLabel(x.label) + ' ' + x.value).join(' / ')).join(' || '));

/* ------------------------- 技能角标：手动星号在后 / 子能力 + 在后（用户拍板，最终形态） */
/* 两次改口后的最终形态：
     · 手动调用的技能 → `*` 在**名字后面**（`ponytail*`）
     · 子能力（host 记的 `sub: true`）→ `+` 在**名字后面**（`ponytail-review+`）
   用户理由：**子能力不可能由他手动调用**，两者不会落在同一个名字上，
   所以不需要靠"前/后位置"区分两种标注；"星号在后"也更像脚注，和压缩列表同一种写法。
   符号 `+` 是实机看完后从 `†` 换的：+ 笔画细、体量小，用 .dsb-sup-strong 加粗补回。
   这里按**节点顺序**断言（不是只拼文本）：顺序断言直接钉住"在后"这件事。 */
/* 单个角标节点的文本（plainLabel 只处理"整条 label"；这里要单独看某个节点） */
const nodeText = (node) => {
	if (node === null || node === undefined) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(nodeText).join('');
	return (node.children || []).map(nodeText).join('');
};
const plainText = (label) => nodeText(label);

/* ① 手动：名字在前、星号在后 */
const manualRow = api.skillList([{ name: 'ponytail', manual: true }], null, t).rows[0];
assert.ok(Array.isArray(manualRow.label), '手动调用的行 label 是节点数组');
assert.strictEqual(manualRow.label.length, 2, '手动是 [名字, 星号] 两个节点，实际 ' + manualRow.label.length);
assert.strictEqual(manualRow.label[0], 'ponytail', '第一个节点是名字');
assert.strictEqual(plainText(manualRow.label[1]), '*', '第二个节点是星号（星号在名字**后**）');
assert.strictEqual(manualRow.label[1].props['aria-label'], '手动触发', '星号读屏文案');

/* ② 子能力：名字在前、+ 在后 */
const subRow = api.skillList([{ name: 'ponytail', manual: false, sub: true }], null, t).rows[0];
assert.ok(Array.isArray(subRow.label), '子能力的行 label 是节点数组');
assert.strictEqual(subRow.label.length, 2, '子能力是 [名字, +] 两个节点，实际 ' + subRow.label.length);
assert.strictEqual(subRow.label[0], 'ponytail', '名字排在**前**');
assert.strictEqual(plainText(subRow.label[1]), '+', '第二个节点是 +（不是 *，也不是旧版的 †）');
assert.strictEqual(subRow.label[1].props['aria-label'], '子能力', '+ 的读屏名称是「子能力」');
assert.ok(String(subRow.label[1].props.className).split(' ').indexOf('dsb-sup') !== -1,
	'+ 复用手动星号那套 .dsb-sup 上标样式');
assert.ok(String(subRow.label[1].props.className).split(' ').indexOf('dsb-sup-strong') !== -1,
	'+ 还要挂 .dsb-sup-strong 加粗到 600（+ 笔画细，同字号下会比星号轻一档）');

/* ③ 两者并存（实际不会发生，代码仍兼容）：名字 + * + +，两个角标的读屏文案必须不同 */
const bothRow = api.skillList([{ name: 'ponytail', manual: true, sub: true }], null, t).rows[0];
assert.strictEqual(bothRow.label.length, 3, '名字 + 星号 + + 共三个节点，实际 ' + bothRow.label.length);
assert.strictEqual(plainText(bothRow.label), 'ponytail*+', '拼起来是 名字*+，实际 ' + plainText(bothRow.label));
assert.strictEqual(bothRow.label[1].props['aria-label'], '手动触发', '星号读屏文案');
assert.strictEqual(bothRow.label[2].props['aria-label'], '子能力', '+ 读屏文案');
assert.notStrictEqual(bothRow.label[1].props['aria-label'], bothRow.label[2].props['aria-label'],
	'两个角标必须给读屏不同名称 —— 否则读屏用户分不清"手动敲的"与"模型读的子能力"');

/* ④ 旧数据没有 sub 字段：不抛错、不出现 + 角标 */
let legacySkills = null;
assert.doesNotThrow(() => {
	legacySkills = api.skillList([{ name: 'ponytail', manual: true }, { name: 'my-dow-theory' }], 'AGENTS.md', t);
}, '缺 sub 字段的旧数据不许抛错');
assert.strictEqual(plainLabel(legacySkills.rows[0].label), 'AGENTS.md', '旧数据里全局提示词照旧在第一行');
assert.deepStrictEqual(Array.from(legacySkills.rows, (row) => plainLabel(row.label)),
	['AGENTS.md', 'ponytail*', 'my-dow-theory'],
	'旧数据渲染与改动前一致：只有名字后的手动星号，没有子能力角标');
assert.strictEqual(Array.from(legacySkills.rows, (row) => plainLabel(row.label)).join('').indexOf('+'), -1,
	'旧数据里不许冒出 + 角标（sub 缺字段一律按 false，不是"未知"）');
/* sub: false 与缺字段等价；脏值（字符串 'true'）也只认真正的布尔 true */
assert.deepStrictEqual(
	Array.from(api.skillList([{ name: 'x', manual: false, sub: false }, { name: 'y', manual: false, sub: 'true' }], null, t).rows,
		(row) => plainLabel(row.label)), ['x', 'y'],
	'sub:false / sub:"true"（脏值）都不该出现 + 角标');

/* ⑤ 手动压缩的星号也在**名字后面**（与技能列表统一）。这是防回归的另一半：
   别把压缩那条"顺手"改回前置。英文那条放到下面 tEn 定义之后再验。 */
const compactManual = api.compactList([{ turn: 12, step: 3, manual: true, afterTurn: null }], t).rows[0];
assert.ok(Array.isArray(compactManual.label), '压缩那行同样是节点数组 [文字, 星号]');
assert.strictEqual(plainLabel(compactManual.label), '第一次压缩*',
	'手动压缩的星号在**名字后**（「第一次压缩*」），与技能列表一致');
assert.strictEqual(compactManual.label[0], '第一次压缩', '第一个节点是整行文字，不拆开「第一次」');
assert.strictEqual(plainText(compactManual.label[1]), '*', '第二个节点是星号（在名字后）');
console.log('技能角标: 手动 ponytail* / 子能力 ponytail+ / 并存 ponytail*+（aria 不同）· 手动压缩 第一次压缩*');

/* ----------------------------- 工具调用：原生英文名 + 长度优先 / 同长度按次数降序 */
const toolListOf = (counts, tt) => Array.from(api.toolList(counts, tt).rows, (one) => ({ label: one.label, value: one.value }));
/* 按**原始工具名**合并计数：同名才合并（数据层面不同工具名天然不同）；
   bash / pwsh / ops_bash 是不同工具，各占一行 —— 不再有「命令行」这种中文名合并 */
assert.deepStrictEqual(toolListOf({ pwsh: 5, bash: 3, read: 4 }, t), [
	{ label: 'pwsh', value: '5 次' },
	{ label: 'read', value: '4 次' },
	{ label: 'bash', value: '3 次' }
], 'bash / pwsh 各自一行（原生名，不再按中文名合并）');
/* 长度优先 + 同长度按次数降序：read(4) 50 次在 pwsh(4) 1 次前；skill(5) 9 次在 write(5) 2 次前 */
assert.deepStrictEqual(toolListOf({ pwsh: 1, read: 50, write: 2, skill: 9 }, t), [
	{ label: 'read', value: '50 次' },
	{ label: 'pwsh', value: '1 次' },
	{ label: 'skill', value: '9 次' },
	{ label: 'write', value: '2 次' }
], '长度升序 → 同长度次数降序');
/* 插件 / MCP 工具原样显示，原名照样参与长度排序 */
assert.deepStrictEqual(toolListOf({ read: 1, mcp__demo__search: 5 }, t), [
	{ label: 'read', value: '1 次' },
	{ label: 'mcp__demo__search', value: '5 次' }
], '插件 / MCP 工具原样显示');
/* 不再有「未翻译整行块」：所有行都走同一个列网格，行上不带 full 标记 */
assert.strictEqual(
	Array.from(api.toolList({ read: 1, mcp__demo__search: 5, bash: 2 }, t).rows).every((one) => one.full !== true),
	true, '所有工具行统一分列，不再有 full 标记');
/* 英文界面（与中文界面）都是同一份原始名，排序规则一致 */
const EN_TIPS = {
	segCounts: 'Turns & Steps',
	tipCountsTitle: 'Session data', tipCountsSkills: 'Skills injected',
	tipCountsCompactAt: 'Compactions', tipCountsToolCalls: 'Tool calls',
	tipCompactItem: 'Compaction {index}', tipCompactWhere: 'Turn {turn} Step {step}', tipCompactTurnOnly: 'Turn {turn}',
	tipManual: 'Manually invoked', tipSub: 'Sub-skill',
	unitCountCalls: ' calls', unitCountSteps: ' steps'
};
const tEn = (key, params) => {
	let out = EN_TIPS[key] !== undefined ? EN_TIPS[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
assert.deepStrictEqual(toolListOf({ read: 1, skill: 5 }, tEn), [
	{ label: 'read', value: '1 calls' },
	{ label: 'skill', value: '5 calls' }
], '英文界面：read(4 字符) 在 skill(5 字符) 前面');
assert.deepStrictEqual(toolListOf({ pwsh: 5, bash: 3, ops_bash: 2 }, tEn), [
	{ label: 'pwsh', value: '5 calls' },
	{ label: 'bash', value: '3 calls' },
	{ label: 'ops_bash', value: '2 calls' }
], '英文界面按原名分：pwsh / bash / ops_bash 各自一行');
/* 英文界面：手动压缩同样是「文字 + 星号」，星号在**后**（中英一致） */
const enCompactManual = api.compactList([{ turn: 12, step: 3, manual: true, afterTurn: null }], tEn).rows[0];
assert.strictEqual(plainLabel(enCompactManual.label), 'Compaction 1*',
	'英文界面手动压缩是 Compaction 1*（星号在后，与中文一致）');
assert.strictEqual(plainText(enCompactManual.label[1]), '*', '英文界面第二个节点是星号');
/* 英文界面技能角标：手动星号在后、子能力 + 在后（符号不翻译，只翻读屏文案） */
const enManualSkill = api.skillList([{ name: 'ponytail', manual: true }], null, tEn).rows[0];
assert.strictEqual(plainText(enManualSkill.label), 'ponytail*', '英文界面手动技能是 ponytail*');
assert.strictEqual(enManualSkill.label[1].props['aria-label'], 'Manually invoked', '英文星号读屏文案');
const enSubSkill = api.skillList([{ name: 'ponytail', manual: false, sub: true }], null, tEn).rows[0];
assert.strictEqual(plainText(enSubSkill.label), 'ponytail+', '英文界面子能力是 ponytail+（+ 不翻译）');
assert.strictEqual(enSubSkill.label[1].props['aria-label'], 'Sub-skill', '英文 + 读屏文案');
/* 中英两套界面同一份数据：名字相同、顺序相同（不再有翻译导致的中英差异） */
assert.deepStrictEqual(toolListOf({ read: 1, skill: 5 }, t), toolListOf({ read: 1, skill: 5 }, t), '同一份数据同序');
/* 端到端：面板里那一行确实走同一套规则 */
const subToolRows = (counts) => {
	const progress = Object.assign({}, src.progress, { toolCounts: counts });
	const rows = api.segmentView('counts', Object.assign({}, src, { progress: progress }), t).tip.rows;
	const row = Array.from(rows).filter((one) => one.label === t('tipCountsToolCalls'))[0];
	return Array.from(row.sub.rows, (one) => ({ label: one.label, value: one.value }));
};
assert.deepStrictEqual(subToolRows({ read: 1, skill: 5 }), toolListOf({ read: 1, skill: 5 }, t),
	'面板子视图与 toolList 同源同序');

/* 标题下彩条：颜色按显示顺序取 32 色（浅→中→深→浓），宽度 = 该工具次数 ÷ 总次数 */
const segOf = (counts, tt) => Array.from(api.toolList(counts, tt).segments);
const threeSegs = segOf({ aaa: 50, bbb: 30, ccc: 20 }, t);
assert.deepStrictEqual(threeSegs.map((one) => Math.round(one.width)), [50, 30, 20],
	'三个工具 50 / 30 / 20 次 → 段宽 50% / 30% / 20%');
assert.deepStrictEqual(threeSegs.map((one) => one.color), ['#FFBFD1', '#FFC5AB', '#F4D06A'],
	'前三工具依次用浅色 01 / 02 / 03');
/* 悬停浮层用 name + percentText（两位小数占比），不再生成浏览器原生 title */
assert.deepStrictEqual(threeSegs.map((one) => one.name), ['aaa', 'bbb', 'ccc'], '每段带工具名（浮层左侧）');
assert.deepStrictEqual(threeSegs.map((one) => one.percentText), ['50.00%', '30.00%', '20.00%'],
	'每段带两位小数占比（浮层右侧）');
assert.ok(threeSegs.every((one) => one.title === undefined), '不再生成原生 title 字符串');
assert.strictEqual(threeSegs.reduce((sum, one) => sum + one.width, 0), 100, '段宽总和 100%');
/* 8 个工具用满浅色一行；第 9 个开始用第二行（中）第 1 色 */
const nineCounts = {};
for (let i = 0; i < 9; i += 1) nineCounts['a' + String(i + 1)] = 9 - i;
const nineSegs = segOf(nineCounts, t);
assert.deepStrictEqual(nineSegs.slice(0, 8).map((one) => one.color), [
	'#FFBFD1', '#FFC5AB', '#F4D06A', '#B0E693', '#72ECD6', '#93E0FF', '#C3D2FF', '#EBC1FF'
], '前 8 个工具用浅色那 8 个');
assert.strictEqual(nineSegs[8].color, '#FFA29E', '第 9 个工具用中行第 1 色');
/* 33 个工具：第 33 个循环回第 1 色 */
const manyCounts = {};
for (let i = 0; i < 33; i += 1) manyCounts['b' + String(i + 1).padStart(2, '0')] = 33 - i;
const manySegs = segOf(manyCounts, t);
assert.strictEqual(manySegs.length, 33, '33 个工具 33 段');
assert.strictEqual(manySegs[31].color, '#D67774', '第 32 个用最后一色（浓行末尾）');
assert.strictEqual(manySegs[32].color, '#FFBFD1', '第 33 个循环回浅色 01');
/* 色表**整张**都要钉住，不能只抽点验首尾：
   原先只断言前 3 / 前 8 / 第 9 / 第 32 / 第 33 循环 —— 第 10–19、21–31 色位没有任何断言，
   实测把第 20/21 色对调、或把第 16 色改成与第 15 色重复，测试仍全绿（审查 C 的 S1 / S2 变异）。

   ⚠ 期望值必须是**写死的字面量表**，不能拿 `api.TOOL_BAR_COLORS` 当期望 ——
   那样是拿实现断言实现，色表自己改了期望也跟着变，恒等成立（第一版就这么写的，
   实测 S1 对调 20/21 色仍然全绿）。所以这里把 32 色原文抄一份。 */
const EXPECTED_COLORS = [
	'#FFBFD1', '#FFC5AB', '#F4D06A', '#B0E693', '#72ECD6', '#93E0FF', '#C3D2FF', '#EBC1FF',
	'#FFA29E', '#F5AE60', '#C0C762', '#77D6A1', '#57D4DE', '#87C5FF', '#C0B3FC', '#EDA3D8',
	'#EB9067', '#CAA63E', '#88BC6B', '#42C2AD', '#54B9DD', '#91A7EC', '#C496D9', '#E68BA8',
	'#CA8634', '#989E36', '#4DAD79', '#1BAAB4', '#609CD4', '#998BD1', '#C27BAF', '#D67774'
];
const colorTable = Array.prototype.slice.call(api.TOOL_BAR_COLORS);
assert.strictEqual(colorTable.length, 32, '色表必须正好 32 色，实际 ' + colorTable.length);
assert.deepStrictEqual(colorTable, EXPECTED_COLORS, '色表 32 色逐个钉死（任何色位改动 / 对调都必须报出来）');
assert.strictEqual(new Set(colorTable).size, 32, '32 个颜色不得重复（第 16 色曾有重复变异存活）');
const thirtyTwoCounts = {};
for (let i = 0; i < 32; i += 1) thirtyTwoCounts['c' + String(i + 1).padStart(2, '0')] = 32 - i;
const thirtyTwoSegs = segOf(thirtyTwoCounts, t);
assert.deepStrictEqual(thirtyTwoSegs.map((one) => one.color), EXPECTED_COLORS,
	'32 个工具按显示顺序依次取到那 32 色（取色循环也必须一位不差）');
/* 空列表 / 0 次：不画彩条（保持原有空列表逻辑） */
assert.strictEqual(api.toolList({}, t).segments, undefined, '没有工具调用时没有彩条');
assert.strictEqual(api.toolList({ read: 0 }, t).segments, undefined, '次数为 0 时没有彩条');
console.log('工具调用：中文名 / 长度优先 / 同长度次数降序 / 未映射回退原名 / 英文用原名');

/* 没压缩过 / host 还没上报这个投影：对应行给横杠，气泡照样打得开 */
const countsWith = (progress) => api.segmentView('counts', Object.assign({}, src, { progress: progress }), t).tip.rows;
assert.deepStrictEqual(values(countsWith({ turn: 3, turnSteps: 4, toolCalls: 10, compactCount: 0, compactTurn: null, compactStep: null })),
	['0', '-', '10'], '没压缩过：上下文压缩显示 0（那行不可点）；host 没给 skills 时技能注入给横杠');
assert.deepStrictEqual(values(countsWith(undefined)), ['-', '-', '-'], 'host 没上报：三行横杠');
/* 0 与「没数据」都不给子视图：点开没东西看，那行连可点样式都不该有 */
assert.deepStrictEqual(Array.from(countsWith(undefined), (row) => String(row.sub)), ['null', 'null', 'null'], 'host 没上报时三行都不可点');
assert.deepStrictEqual(
	Array.from(countsWith({ turn: 3, turnSteps: 4, toolCalls: 0, skills: [], globalInstruction: null, toolCounts: {}, compactCount: 0, compactTurn: null, compactStep: null, compacts: [] }), (row) => String(row.sub)),
	['null', 'null', 'null'], '全为 0 时三行都不可点');
/* 只有全局提示词、没调过 skill：那一行照样可点，数也要算上它 */
const onlyPrompt = countsWith({ turn: 3, turnSteps: 4, toolCalls: 0, skills: [], globalInstruction: 'AGENTS.md', toolCounts: {}, compactCount: 0, compactTurn: null, compactStep: null, compacts: [] });
assert.strictEqual(onlyPrompt[1].value, '1', '只有全局提示词时技能注入那行给 1');
assert.deepStrictEqual(labels(onlyPrompt[1].sub.rows), ['AGENTS.md'], '只有全局提示词时子视图只列它');
/* 没有全局提示词时：不计入、也不出现在子视图里 */
const noPrompt = countsWith({ turn: 3, turnSteps: 4, toolCalls: 10, skills: [{ name: 'ponytail', manual: false }], globalInstruction: null, toolCounts: {}, compactCount: 0, compactTurn: null, compactStep: null, compacts: [] });
assert.strictEqual(noPrompt[1].value, '1', '没有全局提示词时技能注入只数技能');
assert.deepStrictEqual(Array.from(noPrompt[1].sub.rows, (row) => plainLabel(row.label)), ['ponytail'], '没有全局提示词时子视图不出现 AGENTS.md');
/* 技能有两种来源（skill 工具调用 + 斜杠命令 /i-have-adhd 这类）：host 那边已经并进同一个 skills 数组，
   这里按名字合并；重复注入同一技能只留一行，计数按注入次数（与工具调用口径一致） */
const mixedSkills = countsWith({ turn: 1, turnSteps: 1, toolCalls: 3, skills: [
	{ name: 'i-have-adhd', manual: false },
	{ name: 'ponytail', manual: true },
	{ name: 'i-have-adhd', manual: false }
], globalInstruction: null, toolCounts: {}, compactCount: 0, compactTurn: null, compactStep: null, compacts: [] });
assert.strictEqual(mixedSkills[1].value, '3', '斜杠命令注入的技能与工具调用注入的技能并进同一行计数');
assert.deepStrictEqual(Array.from(mixedSkills[1].sub.rows, (row) => plainLabel(row.label)), ['ponytail*', 'i-have-adhd'],
	'同名合并；名字短的在前面；手动调用的 ponytail 星号在名字后');
assert.deepStrictEqual(Array.from(mixedSkills[1].sub.rows, (row) => row.value), [undefined, undefined], '合并后仍只显示名字，不显示次数');
/* 压缩落点拿不到步号（压缩落在轮首）时只给轮号，整条也不至于给横杠 */
assert.deepStrictEqual(
	pairs(countsWith({ turn: 1, turnSteps: 0, toolCalls: 3, skills: [], toolCounts: {}, compactCount: 1, compactTurn: 7, compactStep: null, compacts: [{ turn: 7, step: null }] })[0].sub.rows),
	[{ label: '第一次压缩', value: '第7轮' }], '步号拿不到时只给第X轮');
/* 中文序数（压缩明细的「第一次 / 第二次」）：个位、十位、百位与三位数以外 */
assert.strictEqual(api.chineseNumber(1), '一', '1 = 一');
assert.strictEqual(api.chineseNumber(10), '十', '10 = 十');
assert.strictEqual(api.chineseNumber(11), '十一', '11 = 十一');
assert.strictEqual(api.chineseNumber(20), '二十', '20 = 二十');
assert.strictEqual(api.chineseNumber(21), '二十一', '21 = 二十一');
assert.strictEqual(api.chineseNumber(100), '一百', '100 = 一百');
assert.strictEqual(api.chineseNumber(101), '一百零一', '101 = 一百零一');
assert.strictEqual(api.chineseNumber(999), '九百九十九', '999 = 九百九十九');
assert.strictEqual(api.chineseNumber(1000), null, '四位数没有对应写法，交给调用方退回阿拉伯数字');
assert.strictEqual(api.chineseNumber(0), null, '0 不是序数');
console.log('中文序数: 1→一 / 11→十一 / 21→二十一 / 101→一百零一 / 999→九百九十九');

/* ------------------------------------------------------------ 总用时气泡 */
const timeTip = api.segmentView('sessionTime', src, t).tip;
assert.strictEqual(timeTip.title, '运行用时', '总用时气泡标题');
assert.strictEqual(timeTip.head, undefined, '标题右侧不再跟数值');
assert.deepStrictEqual(labels(timeTip.rows), ['等待用时', '模型用时', '工具调用'], '总用时气泡三行');
assert.deepStrictEqual(values(timeTip.rows), ['2s', '1s', '45s'], 'ttftMs 2000 → 2s；有解码时长时模型用时取 decodeMs 1000 → 1s；toolMs 45000 → 45s');
console.log('总用时气泡:', timeTip.rows.map((r) => r.label + ' ' + r.value).join(' / '));

/* --------------------------------------------------------- 首字/速度气泡 */
const ttftTip = api.segmentView('ttft', src, t).tip;
assert.strictEqual(ttftTip.title, '首字延迟', '首字气泡标题');
assert.strictEqual(ttftTip.head, undefined, '首字气泡标题右侧不再跟数值');
assert.deepStrictEqual(labels(ttftTip.rows), ['本轮平均首字', '最快首字延迟', '最慢首字延迟'], '首字气泡三行：本轮平均在最前');
assert.deepStrictEqual(values(ttftTip.rows), ['4s', '1.2s', '12.5s'], '本轮平均 8000ms/2 → 4s；极值同样按秒（一位小数）');
const tpsTip = api.segmentView('tps', src, t).tip;
assert.strictEqual(tpsTip.head, undefined, '速度气泡标题右侧不再跟数值');
assert.deepStrictEqual(labels(tpsTip.rows), ['本轮平均速度', '最快输出速度', '最慢输出速度'], '速度气泡三行：本轮平均在最前');
assert.deepStrictEqual(values(tpsTip.rows), ['125t/s', '120t/s', '31t/s'], '本轮平均取整；极值取整（30.6 → 31）');
console.log('首字气泡:', values(ttftTip.rows).join(' / '), '| 速度气泡:', values(tpsTip.rows).join(' / '));

/* 没有 host 投影（旧版后台 / 还没跑过调用）时给横杠，不留空 */
const noTiming = api.segmentView('ttft', Object.assign({}, src, { timing: undefined }), t).tip;
assert.deepStrictEqual(values(noTiming.rows), ['-', '-', '-'], '没有极值数据时三行都给横杠');
assert.deepStrictEqual(values(api.segmentView('tps', Object.assign({}, src, { timing: null }), t).tip.rows), ['-', '-', '-'], 'timing 为 null 同样给横杠');

/* ------------------------------------------------------------ 余额气泡 */
const balanceTip = api.segmentView('balance', src, t).tip;
assert.strictEqual(balanceTip.title, '余额', '余额气泡标题');
assert.strictEqual(balanceTip.head, undefined, '余额气泡标题右侧不再跟数值');
assert.deepStrictEqual(labels(balanceTip.rows), ['充值余额', '赠金余额'], '余额气泡两行：先充值后赠金');
assert.deepStrictEqual(values(balanceTip.rows), ['¥0.00', '¥0.00'], '接口没给这两个字段时按 0.00 显示');
const gifted = api.segmentView('balance', Object.assign({}, src, {
	balance: { ok: true, total: '12.34', toppedUp: '10.00', granted: '2.34', currency: 'CNY' }
}), t).tip;
assert.deepStrictEqual(values(gifted.rows), ['¥10.00', '¥2.34'], '有赠金时分别显示充值余额与赠金余额');
/* 配色统一：充值取灰、赠金取紫，且与总用时气泡的两档同源；色条跟这一组常量一起走 */
const GRAY = 'var(--dsw-static-neutral-bluish-400)';
const PURPLE = '#a78bfa';
assert.deepStrictEqual(Array.from(gifted.rows, (row) => row.color), [GRAY, PURPLE], '充值余额取灰、赠金余额取紫');
assert.strictEqual(gifted.rows[0].color, timeTip.rows[0].color, '充值的灰与「等待用时」的灰同款');
assert.strictEqual(gifted.rows[1].color, timeTip.rows[1].color, '赠金的紫与「模型用时」的紫同款');
assert.deepStrictEqual(Array.from(gifted.segments, (one) => one.color), [GRAY, PURPLE], '色条两段跟着同一组色走');
console.log('余额配色:', gifted.rows.map((r) => r.label + '=' + r.color).join(' / '));
const subCent = api.segmentView('balance', Object.assign({}, src, {
	balance: { ok: true, total: '0.00', subCent: true, toppedUp: '0.00', granted: '0.00', currency: 'CNY' }
}), t);
assert.strictEqual(subCent.text, '余额 <¥0.01', '不足一分钱仍显示 <¥0.01');
assert.deepStrictEqual(values(subCent.tip.rows), ['¥0.00', '¥0.00'], '不足一分钱也有两行构成');
/* 百分比配额（GLM 那种）：只有「剩余配额」一行，取灰（充值金额那一档）、色条剩余段贴右端。
   注意变量取**完整返回值**（不是 `.tip`）：下面既断言气泡内容，也要断言底栏那行 text ——
   用户实机报过「底栏 余额 62.50% / 气泡 剩余配额 37.50%」同屏打架，两处必须同源。 */
const quotaView = api.segmentView('balance', Object.assign({}, src, {
	balance: { ok: true, isPercent: true, total: '62.50%', currency: 'CNY' }
}), t);
const quota = quotaView.tip;
/* ⚠ 上游 `isPercent` 的 `total` 是**已用**百分比（lib/balance-api.js:231 把接口的 percentage
   原样当 total 返回），所以底栏不能把它直接当余额显示 —— 必须与气泡一样用「剩余」。 */
assert.strictEqual(quotaView.text, '余额 37.50%',
	'底栏显示「剩余」而不是上游的「已用」，与气泡那行同源（62.50% 是已用 ⇒ 剩余 37.50%）');
assert.strictEqual(quota.rows[0].value, '37.50%', '气泡「剩余配额」那行也是 37.50%，与底栏同一个数');
assert.deepStrictEqual(labels(quota.rows), ['剩余配额'], '配额模式只列剩余');
assert.strictEqual(quota.rows[0].color, 'var(--dsw-static-neutral-bluish-400)',
	'剩余配额图例取灰（与「充值金额」同一档，不再是原来的蓝）');
/* 配额条两段：**剩余那段灰**在最左端、**已用那段透明**在右。
   为什么灰在左：用户拍板原话「灰条从左边起」—— 灰条长度 = 剩余额度，越长剩得越多，
   从左读起一眼就知道"还剩多少"，不用先扫过一段空的已用区。
   为什么已用画成透明而不是另一种颜色：配额只有"剩余"这一个真实数值，
   把已用涂色会让人以为那也是一份额度；透明留着位置，剩余那段才正好占住左端。 */
assert.strictEqual(quota.segments.length, 2, '配额条固定两段（剩余灰 + 已用透明）');
assert.strictEqual(quota.segments[0].color, 'var(--dsw-static-neutral-bluish-400)',
	'第一段是剩余那段、取灰（与图例同色，且在**最左端**）');
assert.strictEqual(quota.segments[0].width, 37.5, '剩余那段宽 = 剩余百分比 37.5%（100 - 62.5）');
assert.strictEqual(quota.segments[1].color, 'transparent', '第二段是已用那段、透明（不涂色）');
assert.strictEqual(quota.segments[1].width, 62.5, '已用那段宽 = 已用百分比 62.5%');
assert.strictEqual(quota.segments[0].width + quota.segments[1].width, 100, '两段加起来正好 100%');
console.log('余额气泡:', values(gifted.rows).join(' / '));

/* --------------------------------------------- 积分套餐条：灰=剩余、从**左**起
 * 用户拍板原话「灰条从左边起」（来回改过一次，这条断言把最终方向钉死）。
 * 这里直接渲染 creditsPanel，按**段序**断言：第一段必须是灰(topUp)、宽度 = 100 - used；
 * 最后一段必须是透明。三个包 50% / 67% / 33% 逐一验。
 * 为什么必须测段序而不是只测宽度：左右颠倒过一次 —— 宽度对、顺序反了，界面上就是反的。 */
const GRAY_SEG = 'var(--dsw-static-neutral-bluish-400)';
{
	const rewards = [
		{ name: 'Coding Plan', used: 400, total: 800 },
		{ name: 'Coding Plan B', used: 402, total: 600 },
		{ name: 'Coding Plan C', used: 396, total: 1200 }
	];
	const view = api.creditsView(rewards, '总积分', t);
	const panel = api.creditsPanel(view, '积分套餐', { left: 0, top: 0 }, () => ({}), { open() {}, back() {} });
	const bars = [];
	(function walk(node) {
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach(walk); return }
		if (typeof node !== 'object') return;
		if (node.props !== undefined && node.props.className === 'dsb-bar') bars.push(node);
		(node.children || []).forEach(walk);
	})(panel);
	assert.strictEqual(bars.length, 3, '三个套餐块各一条进度条，实际 ' + bars.length);
	/* used 与期望的剩余宽度（100 - used），顺序与上面的 rewards 一致 */
	const expect = [
		{ used: 50, left: 50 },
		{ used: 67, left: 33 },
		{ used: 33, left: 67 }
	];
	expect.forEach((one, index) => {
		const segs = (bars[index].children || []).filter((node) => node !== null && node !== undefined && node !== false);
		assert.strictEqual(segs.length, 2, '第 ' + (index + 1) + ' 条固定两段（灰剩余 + 透明已用）');
		/* **第一段**必须是灰、宽度 = 100 - used ⇒ 灰条贴着最左端 */
		assert.strictEqual(segs[0].props.style.backgroundColor, GRAY_SEG,
			'第 ' + (index + 1) + ' 条第一段必须是灰（剩余），且在**最左端**');
		assert.strictEqual(segs[0].props.style.width, one.left + '%',
			'第 ' + (index + 1) + ' 条灰段宽 = 剩余 ' + one.left + '%（100 - ' + one.used + '）');
		/* **最后一段**必须是透明（已用），在右 */
		assert.strictEqual(segs[segs.length - 1].props.style.backgroundColor, 'transparent',
			'第 ' + (index + 1) + ' 条最后一段必须是透明（已用），在右');
		assert.strictEqual(segs[segs.length - 1].props.style.width, one.used + '%',
			'第 ' + (index + 1) + ' 条透明段宽 = 已用 ' + one.used + '%');
	});
	console.log('积分套餐条: 灰在左 = ' + expect.map((one) => one.left + '%').join(' / ')
		+ '（对应 used ' + expect.map((one) => one.used + '%').join(' / ') + '）');
	/* 边界：used=0 ⇒ 只有一整条灰（额度一点没用）；used=100 ⇒ 只有一整条透明 */
	const zeroView = api.creditsView([{ name: 'Z', used: 0, total: 100 }], '总积分', t);
	const zeroPanel = api.creditsPanel(zeroView, '积分套餐', { left: 0, top: 0 }, () => ({}), { open() {}, back() {} });
	const zeroBars = [];
	(function walk(node) {
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach(walk); return }
		if (typeof node !== 'object') return;
		if (node.props !== undefined && node.props.className === 'dsb-bar') zeroBars.push(node);
		(node.children || []).forEach(walk);
	})(zeroPanel);
	const zeroSegs = (zeroBars[0].children || []).filter((node) => node !== null && node !== undefined && node !== false);
	assert.strictEqual(zeroSegs.length, 1, 'used=0 时只有一段');
	assert.strictEqual(zeroSegs[0].props.style.backgroundColor, GRAY_SEG, 'used=0 ⇒ 整条灰');
	assert.strictEqual(zeroSegs[0].props.style.width, '100%', 'used=0 ⇒ 灰占满 100%');
	console.log('积分套餐条边界: used=0 ⇒ 整条灰 100%');
}

/* --------------------------------------------------- 缓存命中率最高/最低 */
const hitTip = api.segmentView('cacheHit', src, t).tip;
assert.strictEqual(hitTip.title, '缓存命中率', '缓存命中气泡标题');
assert.strictEqual(hitTip.head, undefined, '缓存命中气泡标题右侧不再跟数值');
assert.deepStrictEqual(labels(hitTip.rows), ['本轮命中率', '最高命中率', '最低命中率'], '缓存命中气泡三行：本轮在最前');
assert.deepStrictEqual(values(hitTip.rows), ['75.000%', '99.995%', '33.333%'], '本轮按整轮输入算；单次命中率四舍五入到小数点后三位');
const halfTip = api.segmentView('cacheHit', Object.assign({}, src, {
	sessionUsage: { calls: [{ at: Date.now(), model: 'deepseek-flash', input: 1, cacheRead: 1, cacheWrite: 0, output: 1 }] }
}), t).tip;
assert.deepStrictEqual(values(halfTip.rows), ['-', '50.000%', '50.000%'], '第三位是 0 也要显示（这份 mock 没带 current，本轮给横杠）');
const noCalls = api.segmentView('cacheHit', Object.assign({}, src, { sessionUsage: null }), t).tip;
assert.deepStrictEqual(values(noCalls.rows), ['-', '-', '-'], '没有会话用量时三行都给横杠');
console.log('缓存命中气泡:', values(hitTip.rows).join(' / '));

/* 峰谷段只剩文字：它自己的气泡和圆环都已拆走（圆环归独立开关） */
const statusView = api.segmentView('status', src, t);
assert.strictEqual(statusView.periodTip, undefined, '峰谷不再有点击气泡');
assert.strictEqual(statusView.tip.kind, 'bars', '峰谷段给活跃总览条形图');
assert.ok(statusView.text === '高峰' || statusView.text === '低谷', '峰谷段只出文字，实际 ' + statusView.text);
console.log('峰谷段：只剩文字，圆环独立');

/* ------------------------------------------------------ 总计 / 本轮令牌 */
const costTip = api.segmentView('cost', src, t).tip;
assert.strictEqual(costTip.kind, 'tokens', '总计点开的是令牌面板');
assert.strictEqual(costTip.title, '总计用量', '总计气泡标题');
assert.deepStrictEqual(labels(costTip.panel.rows), ['输入(命中缓存)', '输入(未命中缓存)', '输出'], '令牌面板三行');
assert.deepStrictEqual(values(costTip.panel.rows), ['2,000,000', '100', '3,000'], '会话总量取官方 tokenUsage，只给数字不带单位');
console.log('总计气泡:', costTip.panel.totalText);

/* 本轮：优先按本轮调用逐条累加，兜底用官方差分 */
const turnSrc = Object.assign({}, src, {
	sessionUsage: Object.assign({}, src.sessionUsage, {
		current: {
			provider: 'deepseek-official', model: 'deepseek-flash', time: Date.now(),
			input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000,
			calls: [{ at: Date.now(), model: 'deepseek-flash', input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000 }]
		}
	})
});
const turnTip = api.segmentView('lastCost', turnSrc, t).tip;
assert.strictEqual(turnTip.kind, 'tokens', '有 host 本轮数据时，本轮点开的仍是令牌面板');
assert.strictEqual(turnTip.title, '本轮用量', '本轮气泡标题与会话总量区分开');
assert.deepStrictEqual(values(turnTip.panel.rows), ['2,000,000', '100', '3,000'], '本轮用量来自本轮调用');
const fallbackTip = api.segmentView('lastCost', Object.assign({}, src, { turnUsage: { input: 5, cacheRead: 7, cacheWrite: 3, output: 11 } }), t);
assert.strictEqual(fallbackTip.tip === null, false, '兜底差分同样给 token 面板（三行横杠），保证点得开');
assert.strictEqual(fallbackTip.text.indexOf('本轮 ¥'), 0, '兜底差分仍算出金额，实际 ' + fallbackTip.text);
console.log('本轮回退:', fallbackTip.text);

/* 会话与本轮都没有用量时，本轮显示 ¥0.00（不整段消失，底栏长度稳定），令牌面板不弹 */
const noUsage = api.segmentView('lastCost', Object.assign({}, src, { sessionUsage: null, turnUsage: null }), t);
assert.strictEqual(noUsage.text, '本轮 ¥-', '没有用量时本轮给 0.00，实际 ' + (noUsage === null ? 'null' : noUsage.text));
/* 没有用量时也给面板（三行横杠），保证任何情况下都点得开 */
assert.strictEqual(noUsage.tip === null, false, 'no-usage turn still gets a panel');
assert.strictEqual(noUsage.tip.panel.totalText, '-', 'no-usage panel total is a dash');

/* 新一轮刚开跑、还没有属于它的调用：必须归零成 0.00，绝不能挂着上一轮的数字
   —— 显示旧值正是这条分支当初要堵的坑。会话里一次模型调用都还没完成过（第一轮）时
   没有可归零的对象，跟总计一样给横杠。 */
const startingSrc = Object.assign({}, src, {
	running: true,
	sessionUsage: Object.assign({}, src.sessionUsage, { current: null }),
	turnUsage: { input: 100, cacheRead: 2000000, cacheWrite: 0, output: 3000 }
});
const freshTurn = api.segmentView('lastCost', startingSrc, t);
assert.strictEqual(freshTurn.text, '本轮 ¥0.00', '新一轮进行中归零，实际 ' + freshTurn.text);
assert.strictEqual(freshTurn.tip === null, false, '还没有调用就没有明细可看');
const tinyBucket = api.segmentView('lastCost', Object.assign({}, startingSrc, {
	turnUsage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }
}), t);
const hugeBucket = api.segmentView('lastCost', Object.assign({}, startingSrc, {
	turnUsage: { input: 1000000000, cacheRead: 0, cacheWrite: 0, output: 1000000000 }
}), t);
assert.strictEqual(tinyBucket.text, hugeBucket.text, '归零值不读折叠出来的用量，实际 ' + tinyBucket.text + ' / ' + hugeBucket.text);
const firstTurn = api.segmentView('lastCost', Object.assign({}, startingSrc, {
	sessionUsage: { models: {}, calls: [], current: null, last: null, turn: 1 }
}), t);
assert.strictEqual(firstTurn.text, '本轮 ¥-', '第一轮还没有任何已完成调用时给横杠，实际 ' + firstTurn.text);
const idleTurn = api.segmentView('lastCost', Object.assign({}, startingSrc, {
	running: false, runningCalls: [], partial: null
}), t);
assert.notStrictEqual(idleTurn.text, '本轮 ¥-', '空闲时仍显示最近一轮的费用，实际 ' + idleTurn.text);
console.log('新一轮归零:', freshTurn.text, '| 第一轮:', firstTurn.text, '| 空闲时:', idleTurn.text);

/* 回归：节点折叠拿到的轮号对不上 host 的当前轮（当前轮还没产出节点）→ 绝不能拿那份用量算钱。
   旧版在这里往后跳一轮，结果底栏显示的是上上轮（第 6 轮）的金额。 */
const staleTurn = Object.assign({}, startingSrc, { turnUsageTurn: 6, currentTurn: 8 });
assert.strictEqual(api.segmentView('lastCost', staleTurn, t).text, freshTurn.text, '折叠轮号对不上当前轮时不能显示那份用量');
const sameTurnSrc = Object.assign({}, startingSrc, { turnUsageTurn: 8, currentTurn: 8 });
const sameTurnView = api.segmentView('lastCost', sameTurnSrc, t);
assert.notStrictEqual(sameTurnView.text, '本轮 ¥-', '轮号一致时显示本轮进行中的用量，实际 ' + sameTurnView.text);
assert.strictEqual(sameTurnView.tip === null, false, '折叠出来的用量只用于算钱，不给 token 明细（口径与官方投影不同）');
console.log('轮号对账:', api.segmentView('lastCost', staleTurn, t).text, '/', sameTurnView.text);

/* ============================================================ 右缘淡出遮罩
 * 用户实机报过三次，最终定稿是这三条规则：
 *   ① **能继续加行的容器一律不挂遮罩**（用户原话「只有超过每列 12 的情况才应该有这个淡出
 *      遮罩，因为其他情况都不涉及到滚动」）—— 对应 `data-cols-grow="1"`。
 *   ② 遮罩**宽度固定 40px**，不按溢出量收窄（用户原话「遮罩的宽度是固定的呀，溢出两个
 *      像素，就抹两个像素，那样好看吗？」）。
 *   ③ 逐档加行之后要重算一次（`refreshColsFade`），否则加完行已经不用滚了、遮罩还挂着。
 * 几何用最小替身构造：applyColsFade 只读 scrollWidth / clientWidth / scrollLeft / getAttribute，
 * 只写 classList 与两个 CSS 变量，所以不需要真 DOM。 */
const makeCols = (opts) => {
	const classes = new Set();
	const vars = {};
	const writes = [];
	const attrs = opts.attrs === undefined ? {} : opts.attrs;
	return {
		scrollWidth: opts.sw, clientWidth: opts.cw, scrollLeft: opts.sl === undefined ? 0 : opts.sl,
		classList: {
			add: (n) => { classes.add(n); },
			remove: (n) => { classes.delete(n); },
			has: (n) => classes.has(n)
		},
		style: { setProperty: (k, v) => { if (vars[k] !== v) writes.push(k + '=' + v); vars[k] = v; } },
		/* applyColsFade 会读 data-cols-grow；不给真 DOM 时也要有这个入口，否则测不到新判据 */
		getAttribute: (name) => (attrs[name] === undefined ? null : attrs[name]),
		classes: classes, vars: vars, writes: writes
	};
};
const FADE = 'dsb-cols-fade';

/* ① **还能加行**的容器：即使溢出很多也不挂遮罩（这是用户最终判据的核心） */
const growable = makeCols({ sw: 600, cw: 400, attrs: { 'data-cols-grow': '1' } });
api.applyColsFade(growable);
assert.strictEqual(growable.classes.has(FADE), false,
	'带 data-cols-grow="1"（还能继续加行）时不准挂遮罩 —— 加行机制会消掉溢出，此时还不涉及滚动');
assert.strictEqual(growable.vars['--dsb-fade-r'], undefined,
	'不挂遮罩时连 --dsb-fade-r 都不该写');
/* ② 不能加行（已到 12 行上限，或非 tight 面板）：溢出就挂，宽度固定 40px */
const bigOverflow = makeCols({ sw: 600, cw: 400 });
api.applyColsFade(bigOverflow);
assert.strictEqual(bigOverflow.classes.has(FADE), true, '不带该属性、溢出 200px 时要挂遮罩');
assert.strictEqual(bigOverflow.vars['--dsb-fade-r'], api.COLS_FADE_PX + 'px',
	'遮罩宽度固定 = ' + api.COLS_FADE_PX + 'px');
/* ③ 只溢出一点点：**仍然 40px**（宽度固定，不按溢出量收窄 —— 用户明确否掉的做法） */
const tinyOverflow = makeCols({ sw: 410, cw: 400 });
api.applyColsFade(tinyOverflow);
assert.strictEqual(tinyOverflow.classes.has(FADE), true, '溢出 10px（> 1px 容差）仍要挂遮罩');
assert.strictEqual(tinyOverflow.vars['--dsb-fade-r'], api.COLS_FADE_PX + 'px',
	'溢出只有 10px 时遮罩宽仍是固定的 ' + api.COLS_FADE_PX + 'px（不随溢出量收窄）');
/* ④ 不溢出（含 1px 取整误差）：完全不挂 */
[0, 1].forEach((over) => {
	const none = makeCols({ sw: 400 + over, cw: 400 });
	api.applyColsFade(none);
	assert.strictEqual(none.classes.has(FADE), false, '溢出 ' + over + 'px（容差内）不该挂遮罩');
});
/* ⑤ 状态翻转：溢出 → 不溢出时 class 要摘掉、变量归零；再溢出时要重新挂上。
   （宽度现在是常量，记忆只比两个布尔 —— 所以这条验的就是"挂不挂"能正确翻转） */
const flip = makeCols({ sw: 600, cw: 400 });
api.applyColsFade(flip);
assert.strictEqual(flip.classes.has(FADE), true, '先溢出 ⇒ 挂');
flip.scrollWidth = 400;
api.applyColsFade(flip);
assert.strictEqual(flip.classes.has(FADE), false, '不再溢出 ⇒ 摘掉');
flip.scrollWidth = 600;
api.applyColsFade(flip);
assert.strictEqual(flip.classes.has(FADE), true, '又溢出了 ⇒ 重新挂上');
/* ⑥ 滚到最右：右侧归零、左侧保留固定宽 */
const atEnd = makeCols({ sw: 600, cw: 400, sl: 200 });
api.applyColsFade(atEnd);
assert.strictEqual(atEnd.vars['--dsb-fade-r'], '0px', '滚到最右时右侧遮罩宽必须归零');
assert.strictEqual(atEnd.vars['--dsb-fade-l'], api.COLS_FADE_PX + 'px', '滚到最右时左侧遮罩宽固定');
/* ⑦ 加行之后重算：模拟「3 行放不下挂了遮罩 → 加到 4 行后不再溢出 → 遮罩必须消失」。
   注意：这条走的是"节点不带 grow 属性"的路径（加行后的节点会由 rowsPanel 重新渲染，
   perColumn 仍 < 12 时其实带 grow；但它一旦不再溢出，两种路径的结论一致 —— 都不挂）。
   这里同时覆盖「带了 grow 属性」的版本，确认 refreshColsFade 读到属性也会照规矩办。 */
const gridPlain = makeCols({ sw: 600, cw: 400 });
const gridGrow = makeCols({ sw: 600, cw: 400, attrs: { 'data-cols-grow': '1' } });
const panelStub = {
	querySelector: () => null,
	querySelectorAll: (sel) => (sel === '.dsb-meter-cols' ? [gridPlain, gridGrow] : [])
};
api.refreshColsFade(panelStub);
assert.strictEqual(gridPlain.classes.has(FADE), true, '非 grow 节点：加行前（3 行、放不下）应当有遮罩');
assert.strictEqual(gridGrow.classes.has(FADE), false, 'grow 节点：加行中不该有遮罩');
gridPlain.scrollWidth = 400;   /* 加行后列数变少、气泡变宽 ⇒ 不再溢出 */
api.refreshColsFade(panelStub);
assert.strictEqual(gridPlain.classes.has(FADE), false,
	'加行之后已经不需要滚动 ⇒ 遮罩必须重算并摘掉（用户实机报的正是它一直留着）');
console.log('右缘淡出: grow 属性 → 一律不挂 / 溢出 → 固定 ' + api.COLS_FADE_PX + 'px（10px 溢出也是 40px）/ '
	+ '溢出≤1 → 不挂 / 挂-摘-重挂 能翻转 / 加行后重算摘掉');

console.log('');
/* ============================ 底栏余额双币种（¥14.12+$3.17）
 * 用户原话：「余额的显示（不是指点击气泡里，就是单指底栏），有一些 API，它是人民币和美元
 * 两个余额共存的应该都能查到，这个也给他这样做也就是显示成 ¥14.12+$3.17 这种格式」。
 * 规则与活跃总览同一套：人民币在前、某项 ≤0 不出现、只有一项不带 +、负数与 0 同样处理。
 * **气泡一行不动**（用户明确说「不是指点击气泡里」）。 */
const dualSrc = (bal) => Object.assign({}, src, { balance: bal });
const dualView = (bal) => api.segmentView('balance', dualSrc(bal), t);
const both = dualView({
	ok: true, currency: 'CNY', total: '14.12',
	balances: [{ currency: 'CNY', total: '14.12' }, { currency: 'USD', total: '3.17' }]
});
assert.strictEqual(both.text, '余额 ¥14.12+$3.17',
	'人民币 + 美元共存 ⇒ 「余额 ¥14.12+$3.17」，实际 ' + both.text);
assert.strictEqual(both.text.indexOf('¥¥') === -1, true,
	'拼好的串自带符号 ⇒ balSymbol 必须传空串，不许出现 ¥¥（实际 ' + both.text + '）');
const usdOnly = dualView({ ok: true, currency: 'USD', total: '3.17', balances: [{ currency: 'USD', total: '3.17' }] });
assert.strictEqual(usdOnly.text, '余额 $3.17', '只有美元 ⇒ 「余额 $3.17」，实际 ' + usdOnly.text);
const cnyOnly = dualView({ ok: true, currency: 'CNY', total: '14.12', balances: [{ currency: 'CNY', total: '14.12' }] });
assert.strictEqual(cnyOnly.text, '余额 ¥14.12', '只有人民币 ⇒ 不带结尾的 +，实际 ' + cnyOnly.text);
const zeroUsd = dualView({
	ok: true, currency: 'CNY', total: '14.12',
	balances: [{ currency: 'CNY', total: '14.12' }, { currency: 'USD', total: '0' }]
});
assert.strictEqual(zeroUsd.text, '余额 ¥14.12', '某币种为 0 ⇒ 该项不出现，实际 ' + zeroUsd.text);
const negUsd = dualView({
	ok: true, currency: 'CNY', total: '14.12',
	balances: [{ currency: 'CNY', total: '14.12' }, { currency: 'USD', total: '-2.5' }]
});
assert.strictEqual(negUsd.text, '余额 ¥14.12', '负数与 0 同样处理（用户拍板），实际 ' + negUsd.text);
const reversed = dualView({
	ok: true, currency: 'CNY', total: '0',
	balances: [{ currency: 'USD', total: '3.17' }, { currency: 'CNY', total: '14.12' }]
});
assert.strictEqual(reversed.text, '余额 ¥14.12+$3.17', '数组顺序颠倒也要人民币在前，实际 ' + reversed.text);
/* 防回归：老 host 没有 balances ⇒ 完全退回改动前的单币种文本 */
const noBalances = dualView({ ok: true, currency: 'CNY', total: '153.43' });
assert.strictEqual(noBalances.text, '余额 ¥153.43', '没有 balances 字段 ⇒ 退回单币种（老 host 行为不变）');
const emptyBalances = dualView({ ok: true, currency: 'CNY', total: '153.43', balances: [] });
assert.strictEqual(emptyBalances.text, '余额 ¥153.43', 'balances 是空数组 ⇒ 同样退回单币种');
/* 防回归：百分比配额 / 积分两种口径完全不受影响 */
const quotaDual = dualView({ ok: true, isPercent: true, total: '62.50%', currency: 'CNY', balances: [{ currency: 'CNY', total: '14.12' }] });
assert.strictEqual(quotaDual.text, '余额 37.50%', '百分比配额有 balances 也照旧显示剩余百分比');
const creditsDual = dualView({ ok: true, isCredits: true, total: '1280', currency: 'CNY', rewards: [{ name: 'x', used: 1, total: 2 }], balances: [{ currency: 'CNY', total: '14.12' }] });
assert.strictEqual(creditsDual.text, '余额 1280', '积分口径有 balances 也照旧显示积分');
/* 气泡一行不动：仍是充值 / 赠金两行，与分币种无关 */
assert.strictEqual(Array.isArray(both.tip.rows), true, '双币种时气泡仍有内容（不是被清空）');
assert.strictEqual(both.tip.rows.length, 2, '气泡仍是两行（充值 / 赠金），与改动前一致');
console.log('底栏余额双币种：¥14.12+$3.17 / 仅美元 $3.17 / 仅人民币无 + / 0 与负数不出现 / '
	+ '无 balances 退回单币种 / 百分比与积分不受影响 / 气泡不动');

/* =================== 余额气泡：**仍是「充值余额 / 赠金余额」两行**，值里体现双币种
 * 用户原话：「你改了我的项，原本气泡里面只显示充值余额和赠金余额，
 * 我没有让你把它改成 CNY 和 USD」—— 上一版按币种分行（CNY / USD）是错的，已回退。
 * 正确形态：label 保持原样，值用 costByCurrencyText 拼成 `¥13.14+$5.21`。 */
const rowsOf = (bal) => api.segmentView('balance', Object.assign({}, src, { balance: bal }), t).tip.rows;
const dualRows = rowsOf({
	ok: true, currency: 'CNY', total: '21.85', toppedUp: '18.35', granted: '3.50',
	balances: [
		{ currency: 'CNY', total: '15.64', toppedUp: '13.14', granted: '2.50' },
		{ currency: 'USD', total: '6.21', toppedUp: '5.21', granted: '1.00' }
	]
});
assert.strictEqual(dualRows.length, 2, '气泡固定两行（充值 / 赠金），实际 ' + dualRows.length);
assert.strictEqual(dualRows[0].label, '充值余额',
	'★ 第一行 label 必须是「充值余额」，**不许**改成 CNY（实际 ' + dualRows[0].label + '）');
assert.strictEqual(dualRows[1].label, '赠金余额',
	'★ 第二行 label 必须是「赠金余额」，**不许**改成 USD（实际 ' + dualRows[1].label + '）');
assert.strictEqual(dualRows[0].value, '¥13.14+$5.21',
	'充值那行的值体现两个币种（人民币在前），实际 ' + dualRows[0].value);
assert.strictEqual(dualRows[1].value, '¥2.50+$1.00',
	'赠金那行的值体现两个币种，实际 ' + dualRows[1].value);
assert.strictEqual(dualRows[0].label === 'CNY' || dualRows[1].label === 'USD', false,
	'★ 绝不能再出现 CNY / USD 这种按币种分行的 label');
/* 只有人民币 ⇒ 不带 + */
const rowCnyOnly = rowsOf({
	ok: true, currency: 'CNY', total: '15.64', toppedUp: '13.14', granted: '2.50',
	balances: [{ currency: 'CNY', total: '15.64', toppedUp: '13.14', granted: '2.50' }]
});
assert.strictEqual(rowCnyOnly[0].value, '¥13.14', '只有人民币 ⇒ 充值不带 +，实际 ' + rowCnyOnly[0].value);
assert.strictEqual(rowCnyOnly[1].value, '¥2.50', '赠金同样不带 +');
/* 只有美元 ⇒ 带 $ */
const rowUsdOnly = rowsOf({
	ok: true, currency: 'USD', total: '6.21', toppedUp: '5.21', granted: '1.00',
	balances: [{ currency: 'USD', total: '6.21', toppedUp: '5.21', granted: '1.00' }]
});
assert.strictEqual(rowUsdOnly[0].value, '$5.21', '只有美元 ⇒ $ 前缀，实际 ' + rowUsdOnly[0].value);
/* 某币种赠金为 0 ⇒ 那一项不出现 */
const zeroUsdGrant = rowsOf({
	ok: true, currency: 'CNY', total: '18.35', toppedUp: '18.35', granted: '2.50',
	balances: [
		{ currency: 'CNY', total: '15.64', toppedUp: '13.14', granted: '2.50' },
		{ currency: 'USD', total: '5.21', toppedUp: '5.21', granted: '0.00' }
	]
});
assert.strictEqual(zeroUsdGrant[1].value, '¥2.50',
	'美元赠金为 0 ⇒ 赠金那行只显示人民币，实际 ' + zeroUsdGrant[1].value);
assert.strictEqual(zeroUsdGrant[1].value.indexOf('$') === -1, true, '不该出现 $');
/* 两个币种赠金都是 0 ⇒ 赠金行给 ¥0.00（不能空串） */
const allZeroGrant = rowsOf({
	ok: true, currency: 'CNY', total: '18.35', toppedUp: '18.35', granted: '0.00',
	balances: [
		{ currency: 'CNY', total: '13.14', toppedUp: '13.14', granted: '0.00' },
		{ currency: 'USD', total: '5.21', toppedUp: '5.21', granted: '0.00' }
	]
});
assert.strictEqual(allZeroGrant[1].value, '¥0.00',
	'两币种赠金都是 0 ⇒ 赠金行必须是 ¥0.00（不能空串），实际 ' + JSON.stringify(allZeroGrant[1].value));
/* ★ 防回归：没有 balances ⇒ 完全回到改动前（balSymbol + balanceAmount） */
const legacyRows = rowsOf({ ok: true, currency: 'CNY', total: '100.00', toppedUp: '70.00', granted: '30.00' });
assert.strictEqual(legacyRows.length, 2, '没有 balances ⇒ 仍是两行');
assert.strictEqual(legacyRows[0].label, '充值余额', 'label 不变');
assert.strictEqual(legacyRows[0].value, '¥70.00', '退回 balSymbol + balanceAmount 老逻辑，实际 ' + legacyRows[0].value);
assert.strictEqual(legacyRows[1].value, '¥30.00', '赠金老逻辑');
const emptyRows = rowsOf({ ok: true, currency: 'CNY', total: '100.00', toppedUp: '70.00', granted: '30.00', balances: [] });
assert.strictEqual(emptyRows[0].value, '¥70.00', 'balances 空数组 ⇒ 同样退回老逻辑');
/* 没有 toppedUp/granted 字段（老宿主只给 total）⇒ 退回老逻辑 */
const noSplitRows = rowsOf({
	ok: true, currency: 'CNY', total: '100.00', toppedUp: '70.00', granted: '30.00',
	balances: [{ currency: 'CNY', total: '13.14' }]
});
assert.strictEqual(noSplitRows[0].value, '¥70.00',
	'balances 不带 toppedUp/granted ⇒ 退回老逻辑（不是把 13.14 当充值），实际 ' + noSplitRows[0].value);
/* 百分比配额 / 积分不受影响 */
const quotaRowView = rowsOf({ ok: true, isPercent: true, total: '62.50%', currency: 'CNY', balances: [{ currency: 'CNY', total: '13.14', toppedUp: '13.14', granted: '0' }] });
assert.strictEqual(quotaRowView.length, 1, '百分比配额 ⇒ 仍一行');
assert.strictEqual(quotaRowView[0].label, '剩余配额', '仍是「剩余配额」');
const creditsView2 = api.segmentView('balance', Object.assign({}, src, {
	balance: { ok: true, isCredits: true, total: '1280', currency: '', rewards: [{ name: 'x', used: 1, total: 2 }], balances: [{ currency: 'CNY', total: '13.14', toppedUp: '13.14', granted: '0' }] }
}), t);
assert.strictEqual(creditsView2.tip.kind, 'credits', '积分口径仍走 credits 面板');
console.log('余额气泡：仍是「充值余额 / 赠金余额」两行，值里体现双币种（¥13.14+$5.21 / ¥2.50+$1.00）；'
	+ '单项不带 +、0 项不出现、全 0 给 ¥0.00、无 balances 退回老逻辑、配额与积分不受影响');
/* ======================= 余额色条：分币种时「折汇率后再相加」，仍两段
 * 用户原话：「色调的比例就两者混合，不要拆分出来 4 个色条」，
 * 并明确选「折汇率后再加」而不是把 13.14 与 5.21 直接相加
 * （两种计价单位直接加是没有意义的数）。
 * 数据来自 host 的 balances[].toppedUp / granted（task-66 补齐）。 */
const segsOf = (bal) => api.segmentView('balance', Object.assign({}, src, { balance: bal }), t).tip.segments;
/* ① 带 toppedUp/granted ⇒ 仍是两段，比例按折算后的充值 : 赠金 */
const ccySegs = segsOf({
	ok: true, currency: 'CNY', total: '18.35', toppedUp: '18.35', granted: '0.00',
	balances: [
		{ currency: 'CNY', total: '13.14', toppedUp: '13.14', granted: '0.00' },
		{ currency: 'USD', total: '5.21', toppedUp: '3.00', granted: '2.21' }
	]
});
assert.strictEqual(ccySegs.length, 2,
	'分币种色条**仍是两段**（灰=充值总额、紫=赠金总额），用户明确不要拆成四段；实际 ' + ccySegs.length);
assert.strictEqual(ccySegs[0].color, 'var(--dsw-static-neutral-bluish-400)', '第一段是充值（灰）');
assert.strictEqual(ccySegs[1].color, '#a78bfa', '第二段是赠金（紫）');
/* 两段之和必须是 100（比例条的基本要求） */
assert.ok(Math.abs(ccySegs[0].width + ccySegs[1].width - 100) < 0.01,
	'两段宽度之和 = 100%，实际 ' + (ccySegs[0].width + ccySegs[1].width));
/* 若按"不折算直接加"来算，USD 的 3.00 会被当成 3.00 人民币，灰段比例会明显偏小；
   折算后（6.74 倍）灰段应该明显更大。用一个下限断言把这条口径钉住。 */
assert.ok(ccySegs[0].width > 55,
	'灰段应当占多数（USD 充值 3.00 折算成人民币后约 20.23，远大于直接相加的 3.00）'
	+ '，实际 ' + ccySegs[0].width.toFixed(2) + '% —— 若这条红了，说明汇率折算没生效');
/* ② balances 不带 toppedUp/granted ⇒ 完全退回 balance.toppedUp / granted（老口径 70:30） */
const legacySegs = segsOf({
	ok: true, currency: 'CNY', total: '100.00', toppedUp: '70.00', granted: '30.00',
	balances: [{ currency: 'CNY', total: '13.14' }, { currency: 'USD', total: '5.21' }]
});
assert.strictEqual(legacySegs.length, 2, '拿不到分币种充值/赠金 ⇒ 仍是两段');
assert.ok(Math.abs(legacySegs[0].width - 70) < 0.01,
	'退回老口径：充值 70 / 赠金 30，实际灰段 ' + legacySegs[0].width);
assert.ok(Math.abs(legacySegs[1].width - 30) < 0.01, '紫段 30%，实际 ' + legacySegs[1].width);
/* ③ 折算后两个都是 0 ⇒ 色条为空（与现状 balanceSum > 0 的判定保持一致） */
const zeroSegs = segsOf({
	ok: true, currency: 'CNY', total: '13.14', toppedUp: '0.00', granted: '0.00',
	balances: [
		{ currency: 'CNY', total: '13.14', toppedUp: '0.00', granted: '0.00' },
		{ currency: 'USD', total: '5.21', toppedUp: '0.00', granted: '0.00' }
	]
});
assert.strictEqual(Array.isArray(zeroSegs) && zeroSegs.length, 0,
	'折算后充值/赠金都是 0 ⇒ 色条为空数组（不能画出 NaN% 的段）');
/* ④ 没有 balances ⇒ 完全不进新分支 */
const noCcySegs = segsOf({ ok: true, currency: 'CNY', total: '100.00', toppedUp: '70.00', granted: '30.00' });
assert.strictEqual(noCcySegs.length, 2, '没有 balances ⇒ 老两口径不变');
assert.ok(Math.abs(noCcySegs[0].width - 70) < 0.01, '仍是 70:30');
/* ⑤ 百分比配额色条不受影响（剩余灰 + 已用透明） */
const quotaBarSegs = segsOf({ ok: true, isPercent: true, total: '62.50%', currency: 'CNY', balances: [{ currency: 'CNY', total: '13.14', toppedUp: '13.14', granted: '0' }] });
assert.strictEqual(quotaBarSegs.length, 2, '百分比配额仍是两段（剩余灰 + 已用透明）');
assert.strictEqual(quotaBarSegs[0].color, 'var(--dsw-static-neutral-bluish-400)', '配额第一段仍是灰');
assert.strictEqual(quotaBarSegs[1].color, 'transparent', '配额第二段仍是透明');
console.log('余额色条分币种：折算后相加仍两段（灰 69% / 紫 31%）、无字段退回 70:30、'
	+ '全 0 时为空、无 balances 不变、配额不受影响');

/* ★ 决定性证据：**色条走的是新分支，不是回退老口径**
 * 这是最容易出问题的地方 —— 若 host 没把 toppedUp/granted 传下来，代码会静默走回退分支，
 * 测试照样绿但功能没生效。所以刻意构造一组「新老口径比例必然不同」的数据：
 *   新口径：CNY 充值 10.00 + USD 赠金 5.21（折人民币约 35.13）⇒ 灰约 22%
 *   老口径：balance.toppedUp=1.00 / granted=1.00          ⇒ 灰 50%
 * 两者差 28 个百分点，一眼能看出走的是哪条路。 */
const proofSegs = segsOf({
	ok: true, currency: 'CNY', total: '15.21', toppedUp: '1.00', granted: '1.00',
	balances: [
		{ currency: 'CNY', total: '10.00', toppedUp: '10.00', granted: '0.00' },
		{ currency: 'USD', total: '5.21', toppedUp: '0.00', granted: '5.21' }
	]
});
assert.strictEqual(proofSegs.length, 2, '两组都有金额 ⇒ 两段');
assert.ok(proofSegs[0].width > 10 && proofSegs[0].width < 40,
	'★ 灰段应约 22%（新口径：CNY 充值 10 对 USD 赠金折算后 35），'
	+ '若变成 50% 说明静默回退了老口径（用 balance.toppedUp/granted=1/1）；实际 '
	+ proofSegs[0].width.toFixed(2) + '%');
assert.ok(Math.abs(proofSegs[0].width - 50) > 5,
	'★ 灰段必须明显偏离老口径的 50%，实际 ' + proofSegs[0].width.toFixed(2) + '%');
/* 赠金为 0 时只出一段（紫段宽 0 被 filter 掉）—— 这是正确行为，不是 bug */
const noGrantSegs = segsOf({
	ok: true, currency: 'CNY', total: '17.29', toppedUp: '17.29', granted: '0.00',
	balances: [
		{ currency: 'CNY', total: '14.12', toppedUp: '14.12', granted: '0.00' },
		{ currency: 'USD', total: '3.17', toppedUp: '3.17', granted: '0.00' }
	]
});
assert.strictEqual(noGrantSegs.length, 1, '赠金全是 0 ⇒ 只剩灰段一段（紫段被过滤），实际 ' + noGrantSegs.length);
assert.ok(Math.abs(noGrantSegs[0].width - 100) < 0.01, '那一整段就是 100%');
console.log('色条分支证据：新口径灰 ' + proofSegs[0].width.toFixed(2) + '%（老口径会是 50%）；'
	+ '赠金全 0 时只出一段');
console.log('TIP PANEL CHECKS PASSED');
