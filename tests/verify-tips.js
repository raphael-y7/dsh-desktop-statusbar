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
	'\t\texports.__t = { segmentView, segmentText, chineseNumber, SEGMENTS, DEFAULT_SEGMENTS, isSegmentOn, snapshot, toolList, TOOL_BAR_COLORS };\n\t\texports.apply = apply;');

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
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb, { filename: 'client.js' });
const api = captured.factory((n) => {
	if (n !== 'react') throw new Error('unexpected require: ' + n);
	return {
		createElement: () => ({}), useState: (v) => [v, () => {}], useRef: () => ({}),
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
		   用 afterTurn 记「发生在第几轮之后」→ 行尾上标星号 + 「第20轮后」 */
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
	'技能注入子视图：AGENTS.md 是全局提示词、固定第一不参与排序；ponytail 注入两次（其中一次手动）→ 合并 + 上标星号');
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
	/* 星号在行尾（「第二次压缩*」）：上标挂在最后，不把「第二次」拆开；
	   手动压缩没有 turn，落点用 afterTurn 显示「第20轮后」而不是横杠 */
	{ label: '第二次压缩*', value: '第20轮后' }
], '上下文压缩子视图：中文序数 + 第X轮Y步，按发生顺序；手动压缩的行尾加上标星号');
console.log('子视图:', countsTip.rows.map((r) => pairs(r.sub.rows).map((x) => plainLabel(x.label) + ' ' + x.value).join(' / ')).join(' || '));

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
	'同名合并；名字短的在前面；手动调用的 ponytail 带星号');
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
/* 百分比配额（GLM 那种）：只有「剩余配额」一行，取蓝（原赠金那一档） */
const quota = api.segmentView('balance', Object.assign({}, src, {
	balance: { ok: true, isPercent: true, total: '62.50%', currency: 'CNY' }
}), t).tip;
assert.deepStrictEqual(labels(quota.rows), ['剩余配额'], '配额模式只列剩余');
assert.strictEqual(quota.rows[0].color, 'var(--dsw-static-blue-450)', '剩余配额图例取蓝');
assert.strictEqual(quota.segments[0].color, 'var(--dsw-static-blue-450)', '配额条那段跟着同一色走');
console.log('余额气泡:', values(gifted.rows).join(' / '));

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

console.log('');
console.log('TIP PANEL CHECKS PASSED');
