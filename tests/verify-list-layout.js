/**
 * 气泡列表布局检查（2.2.0）：技能注入的排序 / 合并 / 上标星号，压缩明细的手动星号，
 * 工具调用「原生英文名 + 单列网格 + 每列 3 → 4 → 5 …行」的边界，
 * 以及列网格**横向溢出量测** toolColumnsOverflow 的判定。
 *
 * 布局口径（用户拍板）：列网格 `flex-wrap:nowrap`，**永不折行**；
 * 一排放不下先逐档加每列行数（3 → 12），12 行仍放不下才横向滚动。
 * 因此量测函数判的是"横向放不下"，不是"折成两排"（nowrap 之后根本不会折）。
 *
 * 做法与 verify-tips.js 相同：vm 里加载真实 client.js，用最小 React 替身渲染出虚拟树，
 * 直接断言树 / 序列化后的 HTML（不跑浏览器，浏览器那一层由 work/ 下的截图脚本证明）。
 * 用法：node verify-list-layout.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker,
	'\t\texports.__layout = { segmentView, rowsPanel, listColumns, toolColumnsOverflow, nextToolRows, '
	+ 'skillList, toolList, compactList, '
	+ 'LIST_ROWS_PER_COLUMN, LIST_ROWS_PER_COLUMN_MAX };\n' + marker);

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0, clearInterval: () => {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
};
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
const sandbox = {
	window: fakeWindow,
	document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

/* React 替身：把 createElement 的结果留成一棵真正的树（带 props/children），后面走树断言 */
const reactStub = {
	createElement(type, props, ...children) {
		return {
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
		};
	},
	Fragment: Symbol('Fragment'),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useRef: () => ({ current: null }),
	useEffect: () => {},
	useLayoutEffect: () => {},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useSyncExternalStore: (subscribe, snapshot) => snapshot()
};
const api = captured.factory((name) => {
	if (name !== 'react') throw new Error('unexpected require: ' + name);
	return reactStub;
}).__layout;

/* ------------------------------------------------------------------ 替身 i18n */
const ZH = {
	segCounts: '轮次＆步数',
	tipCountsTitle: '会话数据',
	tipCountsSkills: '技能注入',
	tipCountsCompactAt: '上下文压缩',
	tipCountsToolCalls: '工具调用',
	tipCompactItem: '第{index}次压缩',
	tipCompactWhere: '第{turn}轮{step}步',
	tipCompactTurnOnly: '第{turn}轮',
	tipCompactAfter: '第{turn}轮后',
	tipManual: '手动触发',
	unitCountCalls: ' 次'
};
const EN = {
	segCounts: 'Turns & Steps',
	tipCountsTitle: 'Session data',
	tipCountsSkills: 'Skills injected',
	tipCountsCompactAt: 'Context compactions',
	tipCountsToolCalls: 'Tool calls',
	tipCompactItem: 'Compaction {index}',
	tipCompactWhere: 'Turn {turn}·Step {step}',
	tipCompactTurnOnly: 'Turn {turn}',
	tipCompactAfter: 'After turn {turn}',
	tipManual: 'Manually invoked',
	unitCountCalls: ' calls'
};
const translator = (table) => (key, params) => {
	let out = table[key] !== undefined ? table[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
	return out;
};
const t = translator(ZH);
const tEn = translator(EN);

/* ---------------------------------------------------------- 虚拟树 → 文本 / HTML */
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (typeof node.type === 'symbol') return (node.children || []).map(textOf).join('');
	return textOf(node.children);
}
function collectByClass(node, cls, out) {
	const found = out === undefined ? [] : out;
	if (node === null || node === undefined || node === false) return found;
	if (Array.isArray(node)) {
		node.forEach((one) => collectByClass(one, cls, found));
		return found;
	}
	if (typeof node === 'string' || typeof node === 'number') return found;
	const className = node.props === undefined || node.props.className === undefined ? '' : String(node.props.className);
	if (className.split(' ').indexOf(cls) !== -1) found.push(node);
	(node.children || []).forEach((one) => collectByClass(one, cls, found));
	return found;
}
const esc = (text) => String(text)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 序列化成 HTML：只留渲染意义上的属性，够验 aria-hidden / title / class 的落点 */
function toHtml(node) {
	if (node === null || node === undefined || node === false || node === true || node === '') return '';
	if (typeof node === 'string' || typeof node === 'number') return esc(node);
	if (Array.isArray(node)) return node.map(toHtml).join('');
	if (typeof node.type === 'symbol') return (node.children || []).map(toHtml).join('');
	const props = node.props || {};
	let attrs = '';
	Object.keys(props).forEach((key) => {
		if (key === 'children' || key === 'ref' || key === 'key' || key.indexOf('on') === 0) return;
		const value = props[key];
		if (value === undefined || value === null || value === false || typeof value === 'function') return;
		attrs += ' ' + (key === 'className' ? 'class' : key) + '="' + esc(value === true ? '' : value) + '"';
	});
	if (props.style !== undefined && props.style !== null) {
		attrs += ' style="' + Object.keys(props.style).map((key) => key + ':' + props.style[key]).join(';') + '"';
	}
	return '<' + node.type + attrs + '>' + (node.children || []).map(toHtml).join('') + '</' + node.type + '>';
}

/* -------------------------------------------------------------- 被测数据与面板 */
const src = {
	stats: { turns: 2, steps: 10 },
	progress: {
		turn: 9, turnSteps: 7, toolCalls: 30,
		toolCounts: {
			read: 5, edit: 2, pwsh: 1, bash: 2, ops_bash: 3, workflow: 4,
			mcp__demo__search: 9, custom_tool: 3
		},
		skills: [
			{ name: 'ponytail', manual: false },
			{ name: 'my-dow-theory', manual: false },
			{ name: 'ponytail', manual: true },
			{ name: 'aa', manual: false },
			{ name: 'ab', manual: false },
			{ name: 'b', manual: false }
		],
		globalInstruction: 'AGENTS.md',
		compactCount: 2, compactTurn: 49, compactStep: 1,
		/* 第二条是用户手动 /compact：轮间压缩 turn 是 null（不是失败，不能丢），
		   afterTurn 记「发生在第几轮之后」→ 显示「第20轮后」 */
		compacts: [
			{ turn: 12, step: 3, manual: false, afterTurn: null },
			{ turn: null, step: null, manual: true, afterTurn: 20 }
		]
	}
};
const countsTip = api.segmentView('counts', src, t).tip;
/* 会话数据那三行的下钻顺序：0 压缩 / 1 技能 / 2 工具；rowsPerColumn 由 StatusBar 量测后传入 */
const subPanel = (tip, index, rowsPerColumn) => api.rowsPanel(tip, null, { current: null }, {
	id: index,
	rowsPerColumn: rowsPerColumn
});
const listRows = (tree) => collectByClass(tree, 'dsb-meter-row').map((row) => ({
	name: textOf(collectByClass(row, 'dsb-meter-name')[0]),
	value: textOf(collectByClass(row, 'dsb-meter-value')[0])
}));

/* --------------------------- 技能注入：排序 / 合并 / 上标星号（只列名字，不显示次数） */
const skillPanel = subPanel(countsTip, 1, 3);
const skillRows = listRows(skillPanel);
assert.deepStrictEqual(skillRows.map((one) => one.name), [
	/* 全局提示词 AGENTS.md 固定第一、不参与技能排序；其余按 名字短→次数多→字典序（次数只用于排序） */
	'AGENTS.md', 'b', 'aa', 'ab', 'ponytail*', 'my-dow-theory'
], '技能列表：AGENTS.md 固定第一；其余名字短的在前 → 次数降序 → 字典序；手动调用的 ponytail 名字后跟上标星号，实际 ' + JSON.stringify(skillRows));
/* 用户明确要求：技能注入只列名字、不显示统计次数（AGENTS.md 也不显示） */
assert.deepStrictEqual(skillRows.map((one) => one.value), ['', '', '', '', '', ''],
	'技能注入的行只有名字，没有次数');
const skillStars = collectByClass(skillPanel, 'dsb-sup');
assert.strictEqual(skillStars.length, 1, '只有手动调用过的那一行带星号');
assert.strictEqual(skillStars[0].props['aria-label'], '手动触发', '星号的读屏名称是「手动触发」');
assert.strictEqual(skillStars[0].props.role, 'img', '星号带 img 角色：span 默认 generic，aria-label 会被读屏忽略');
assert.strictEqual(skillStars[0].props['aria-hidden'], undefined, '不再用 aria-hidden 把星号整个藏掉');
/* 不挂 title：星号只有 11px，鼠标几乎落不到上面，原生悬停气泡是"偶尔冒一下"的意外行为 */
assert.strictEqual(skillStars[0].props.title, undefined, '星号**没有**原生悬停气泡（用户明确不要）');
assert.strictEqual(textOf(skillStars[0]), '*', '视觉内容仍是 *');
/* HTML 落点：星号在名字后面、同一个 name 节点里，且是上标类 */
const skillHtml = toHtml(skillPanel);
assert.ok(skillHtml.indexOf('ponytail<span class="dsb-sup" role="img" aria-label="手动触发">*</span>') !== -1,
	'上标星号紧跟技能名之后且不带 title，实际 ' + skillHtml);
console.log('技能注入：' + skillRows.map((one) => one.name + ' ' + one.value).join(' / '));

/* 英文界面：同一套排序，星号的读屏文案走英文 t */
const enSkills = api.skillList(src.progress.skills, 'AGENTS.md', tEn);
const enStarRow = enSkills.rows.filter((row) => Array.isArray(row.label))[0];
assert.ok(enStarRow !== undefined, '英文界面手动调用的技能同样带星号');
assert.strictEqual(enStarRow.label[1].props['aria-label'], 'Manually invoked', '英文界面星号读屏文案走英文词表');
assert.strictEqual(enStarRow.label[1].props['aria-hidden'], undefined, '英文界面也不用 aria-hidden');
console.log('技能注入（英文）：星号读屏文案 ' + enStarRow.label[1].props['aria-label']);

/* ------------------------------------------- 上下文压缩：手动那条行尾加上标星号 */
const compactRows = listRows(subPanel(countsTip, 0, 3));
assert.deepStrictEqual(compactRows, [
	{ name: '第一次压缩', value: '第12轮3步' },
	/* 星号在行尾（第二次压缩*）：上标挂在最后；轮间压缩没有 turn，用 afterTurn 显示「第20轮后」 */
	{ name: '第二次压缩*', value: '第20轮后' }
], '自动压缩给第X轮Y步；手动/轮间压缩用 afterTurn 给「第X轮后」+ 行尾上标星号，实际 ' + JSON.stringify(compactRows));
const compactHtml = toHtml(subPanel(countsTip, 0, 3));
assert.ok(compactHtml.indexOf('第二次压缩<span class="dsb-sup" role="img" aria-label="手动触发">*</span>') !== -1,
	'压缩星号落在整行末尾（同样不挂 title），实际 ' + compactHtml);
/* afterTurn 也拿不到（老日志 / 宿主没给）时仍给横杠；英文界面用 After turn */
const bareCompact = api.compactList([{ turn: null, step: null, manual: true, afterTurn: null }], t);
assert.strictEqual(bareCompact.rows[0].value, '-', 'turn 与 afterTurn 都没有 → 横杠');
const enCompact = api.compactList([{ turn: null, step: null, manual: false, afterTurn: 20 }], tEn);
assert.strictEqual(enCompact.rows[0].value, 'After turn 20', '英文界面 afterTurn 用 After turn {turn}');
console.log('上下文压缩：' + compactRows.map((one) => one.name + ' ' + one.value).join(' / '));

/* --------------------------- 工具调用：原生英文名 + 单列网格（不翻译、不分中文/英文两套结构） */
const toolPanel = subPanel(countsTip, 2, 3);
const columnsOf = (panel) => collectByClass(panel, 'dsb-meter-col');
const toolColumns = columnsOf(toolPanel);
assert.strictEqual(toolColumns.length, 3, '8 个工具按每列 3 行 → 3 列');
assert.deepStrictEqual(toolColumns.map((one) => collectByClass(one, 'dsb-meter-row').length), [3, 3, 2],
	'列内行数 3 / 3 / 2（列数不设上限、折行交给 CSS）');
assert.ok(toolColumns.every((one) => collectByClass(one, 'dsb-meter-row').length <= 3), '每列不超过 3 行');
const toolFlat = listRows(toolPanel);
assert.deepStrictEqual(toolFlat.map((one) => one.name), [
	/* 名字长度升序 → 同长度次数降序 → 字典序：
	   read(4,5次) bash(4,2) edit(4,2) pwsh(4,1) workflow(8,4) ops_bash(8,3) custom_tool(11,3) mcp__demo__search(18,9) */
	'read', 'bash', 'edit', 'pwsh', 'workflow', 'ops_bash', 'custom_tool', 'mcp__demo__search'
], '原生英文名排序：长度升序 → 同长度次数降序 → 字典序，实际 ' + JSON.stringify(toolFlat.map((one) => one.name)));
assert.deepStrictEqual(toolFlat.map((one) => one.value),
	['5 次', '2 次', '2 次', '1 次', '4 次', '3 次', '3 次', '9 次'],
	'每行显示各自调用次数（不同工具名不合并）');
/* bash / pwsh / ops_bash 各占一行：不再按中文名合并成「命令行」 */
assert.strictEqual(toolFlat.some((one) => one.name.indexOf('命令行') !== -1
	|| one.name.indexOf('读取文件') !== -1), false, '不再出现中文工具名');
/* 统一一个列网格：不再有英文整行块 / 外层分列容器 */
assert.strictEqual(collectByClass(toolPanel, 'dsb-meter-full').length, 0, '不再有英文整行块');
assert.strictEqual(collectByClass(toolPanel, 'dsb-meter-split').length, 0, '不再有分列 + 整行块的外层');
assert.strictEqual(collectByClass(toolPanel, 'dsb-meter-cols').length, 1, '只有一个列网格');
assert.ok(String(collectByClass(toolPanel, 'dsb-meter-cols')[0].props.className).indexOf('dsb-meter-tight') !== -1,
	'工具调用子视图仍标 tight（名字与次数间距 1ch）');
assert.ok(String(toolPanel.props.className).indexOf('dsb-meter-wide') !== -1, '分列子视图走宽档');
console.log('工具调用：' + toolFlat.map((one) => one.name + ' ' + one.value).join(' / '));

/* 中英界面完全一致：工具名不翻译，两套词表渲染出的行名与顺序相同 */
const enToolPanel = subPanel(api.segmentView('counts', src, tEn).tip, 2, 3);
assert.deepStrictEqual(listRows(enToolPanel).map((one) => one.name), toolFlat.map((one) => one.name),
	'中英界面的工具名与顺序一致（原生名，不翻译）');
console.log('中英工具行一致：' + listRows(enToolPanel).map((one) => one.name).join(' / '));

/* toolList 纯数据：不同工具名天然不合并；排序规则同面板 */
assert.deepStrictEqual(Array.from(api.toolList({ read: 2, ops_bash: 9, ops_read_file: 1 }, t).rows,
	(one) => ({ label: one.label, value: one.value })), [
	{ label: 'read', value: '2 次' },
	{ label: 'ops_bash', value: '9 次' },
	{ label: 'ops_read_file', value: '1 次' }
], '第三方插件工具也是原生名，按名字长度排在后面');
assert.strictEqual(api.toolList({}, t).rows.length, 1, '没有调用时给一行横杠占位（不显示空气泡）');

/* 分列边界：13 个原生工具名，3 行一列 5 列；逐档加到 5 行一列 3 列 */
const thirteen = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'skill',
	'subagent', 'present', 'web_search', 'web_fetch', 'workflow'];
const counts13 = {};
thirteen.forEach((name, at) => { counts13[name] = at + 1; });
const tip13 = api.segmentView('counts', {
	stats: { turns: 1, steps: 1 },
	progress: {
		turn: 1, turnSteps: 1, toolCalls: 13, toolCounts: counts13,
		skills: [], globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: []
	}
}, t).tip;
const colsAt = (rowsPerColumn) => columnsOf(subPanel(tip13, 2, rowsPerColumn));
const threePerCol = colsAt(3);
const fourPerCol = colsAt(4);
const fivePerCol = colsAt(5);
const twelvePerCol = colsAt(12);
assert.strictEqual(threePerCol.length, 5, '13 个工具默认 5 列');
assert.strictEqual(fourPerCol.length, 4, '折行后 4 行一列 → 4 列');
assert.strictEqual(fivePerCol.length, 3, '再升到 5 行一列 → 3 列（本例目标就是这一档）');
assert.strictEqual(twelvePerCol.length, 2, '12 行一列（上限）→ 2 列');
assert.ok(fourPerCol.every((one) => collectByClass(one, 'dsb-meter-row').length <= 4), '每列不超过 4 行');
assert.ok(fivePerCol.every((one) => collectByClass(one, 'dsb-meter-row').length <= 5), '每列不超过 5 行');
assert.ok(twelvePerCol.every((one) => collectByClass(one, 'dsb-meter-row').length <= 12), '每列不超过 12 行（上限）');
assert.strictEqual(collectByClass(subPanel(tip13, 2, 5), 'dsb-meter-row').length, 13, '换成 5 行一列后行数不变');
/* 23 个工具、perColumn=4 → 6 列 × 每列最多 4 行 */
const tool23 = {};
for (let i = 0; i < 23; i += 1) tool23['tool_' + String(i + 1).padStart(2, '0')] = i + 1;
const tip23 = api.segmentView('counts', {
	stats: { turns: 1, steps: 1 },
	progress: {
		turn: 1, turnSteps: 1, toolCalls: 23, toolCounts: tool23,
		skills: [], globalInstruction: null, compactCount: 0, compactTurn: null, compactStep: null, compacts: []
	}
}, t).tip;
const tool23Columns = columnsOf(subPanel(tip23, 2, 4));
assert.strictEqual(tool23Columns.length, 6, '23 个工具、perColumn=4 → 6 列');
assert.deepStrictEqual(tool23Columns.map((one) => collectByClass(one, 'dsb-meter-row').length), [4, 4, 4, 4, 4, 3],
	'6 列的行数是 4×5 + 3（每列不超过 4 行）');
console.log('分列边界：13 行 → 3 行 5 列 / 4 行 4 列 / 5 行 3 列 / 12 行 2 列；23 行 @4 → 6 列');

/* ------------------------------- 分列边界与逐档加行：3 → 4 → 5 …，上限 12（纯函数） */
assert.strictEqual(api.LIST_ROWS_PER_COLUMN, 3, '默认每列 3 行');
assert.strictEqual(api.LIST_ROWS_PER_COLUMN_MAX, 12, '每列行数上限 12');
/* nextToolRows：放得下保持；放不下 +1；到上限不再加（只升不降） */
assert.strictEqual(api.nextToolRows(3, false), 3, '放得下：保持 3 行');
assert.strictEqual(api.nextToolRows(3, true), 4, '放不下：3 → 4');
assert.strictEqual(api.nextToolRows(4, true), 5, '4 行仍放不下：4 → 5（不是只升一档就停）');
assert.strictEqual(api.nextToolRows(11, true), 12, '11 行放不下：升到上限 12');
assert.strictEqual(api.nextToolRows(12, true), 12, '到上限 12 仍放不下：不再加，交给横向滚动兜底（不折行）');
assert.strictEqual(api.nextToolRows(12, false), 12, '放得下也不回退（只升不降，避免抖动）');
const seq = (n) => Array.from({ length: n }, (one, at) => at + 1);
/* vm 里造的数组跨 realm（原型不同，deepStrictEqual 会判不等）：摊成本地数组再比 */
const columns = (rows, size) => JSON.parse(JSON.stringify(api.listColumns(rows, size)));
assert.deepStrictEqual(columns(seq(0), 3), [], '空列表不分列');
assert.deepStrictEqual(columns(seq(1), 3), [[1]], '1 行只有一列');
assert.deepStrictEqual(columns(seq(3), 3), [[1, 2, 3]], '3 行正好一列');
assert.deepStrictEqual(columns(seq(4), 3), [[1, 2, 3], [4]], '4 行开两列（第二列只有 1 行）');
assert.deepStrictEqual(columns(seq(13), 3), [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13]],
	'13 行 → 3 行一列共 5 列');
assert.deepStrictEqual(columns(seq(13), 4), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13]],
	'4 行一列时 13 行 → 4 列（列数少一档，一排放得下的机会更大）');
assert.deepStrictEqual(columns(seq(13), 5), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13]],
	'5 行一列时 13 行 → 3 列');
assert.deepStrictEqual(columns(seq(13), 12), [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [13]],
	'上限 12 行一列时 13 行 → 2 列');
assert.deepStrictEqual(columns(seq(5)), [[1, 2, 3], [4, 5]], '不传行数 = 默认 3 行一列');

/* 逐档收敛：与 StatusBar 里那条 effect 同一个循环（每渲染一遍 +1，直到放得下或到上限） */
const converge = (rowCount, capacity) => {
	let rows = api.LIST_ROWS_PER_COLUMN;
	for (let guard = 0; guard < 30; guard += 1) {
		const next = api.nextToolRows(rows, api.listColumns(seq(rowCount), rows).length > capacity);
		if (next === rows) return rows;
		rows = next;
	}
	return rows;
};
assert.strictEqual(converge(13, 3), 5, '13 个工具、每排最多 3 列：3→4 仍放不下，4→5 收成一排（不是只升一档就停）');
assert.strictEqual(converge(13, 2), 7, '每排最多 2 列：13 个工具要升到 7 行才收成一排');
assert.strictEqual(converge(40, 1), 12, '极端放不下时升到上限 12 就停，剩下的交给横向滚动（绝不折行）');
console.log('逐档收敛：13+每排 3 列 → 5 行；每排 2 列 → 7 行；放不下 → 12 行封顶后横向滚动');

/* ------------------- 「理解 B」：宽度必须跟着行数收窄，不能停在加行之前的宽度 ---------------
   用户原话：「对，理解 b，这才叫自适应宽度」。举例：
     3 行时要 7 列 → 宽 7×170=1190px；加到 5 行只要 4 列 → 宽度必须变成 680px。
   气泡是 width:max-content（宽度 = 内容宽），而内容宽 = 列数 × 列宽（nowrap 单排），
   所以"列数变少 ⇒ 宽度收窄"在实现上是必然成立的 —— 但**必须有测试钉住**：
   万一有人给列网格加了固定 width、或把 flex-wrap 改回 wrap（第二排会撑大宽度），
   这个性质就没了。这里用「列数 × 列宽」把它换算成宽度来做断言。 */
const COL_W = 170;
const widthAt = (rowCount, rows) => api.listColumns(seq(rowCount), rows).length * COL_W;
/* 13 个工具：3 行 5 列 = 850px → 5 行 3 列 = 510px */
assert.strictEqual(widthAt(13, 3), 5 * COL_W, '13 个工具 3 行一列 → 5 列（850px）');
assert.strictEqual(widthAt(13, 5), 3 * COL_W, '13 个工具 5 行一列 → 3 列（510px）');
assert.ok(widthAt(13, 5) < widthAt(13, 3),
	'【理解 B】加行之后气泡必须变窄：3 行 850px → 5 行 510px，实际 ' + widthAt(13, 5));
/* 20 个工具（用户举例的量级）：3 行 7 列 1190px → 收敛到 5 行 4 列 680px */
const rows20 = converge(20, 4);       /* 容器只放得下 4 列 */
assert.strictEqual(rows20, 5, '20 个工具、容器放得下 4 列：3→4→5 行才收得住，实际 ' + rows20);
assert.strictEqual(widthAt(20, 3), 7 * COL_W, '20 个工具 3 行一列 → 7 列（1190px）');
assert.strictEqual(widthAt(20, rows20), 4 * COL_W, '20 个工具收敛到 ' + rows20 + ' 行 → 4 列（680px）');
assert.ok(widthAt(20, rows20) < widthAt(20, 3),
	'【理解 B】20 个工具：3 行 1190px → ' + rows20 + ' 行 680px，宽度必须收窄（不能停在 1190px，那是留白）');
/* 宽度单调性：行数越多，宽度只能不变或更窄（列数 = ceil(n/rows)，随 rows 单调不增） */
[20, 50, 100].forEach((count) => {
	let prev = Infinity;
	for (let rows = api.LIST_ROWS_PER_COLUMN; rows <= api.LIST_ROWS_PER_COLUMN_MAX; rows += 1) {
		const w = widthAt(count, rows);
		assert.ok(w <= prev, count + ' 个工具：行数从 ' + (rows - 1) + ' 加到 ' + rows
			+ ' 时宽度不许变大（' + prev + 'px → ' + w + 'px）');
		prev = w;
	}
});
console.log('理解 B：宽度随行数收窄（20 个工具 1190px → 680px；13 个 850px → 510px）');

/* --------------------- 横向溢出量测：nowrap 之后"放不下"的唯一表现（scrollWidth > clientWidth）--------
   口径变了：列网格是 flex-wrap:nowrap，**永远不会折行**。旧实现靠"各列 top 是否一致"判折行，
   在 nowrap 下恒为 false —— 那会让逐档加行彻底失效（工具一多就一直横向溢出、不升行数）。
   现在改成量列网格自身的内容宽 vs 容器宽。 */
const fakeGrid = (scrollWidth, clientWidth) => ({ scrollWidth: scrollWidth, clientWidth: clientWidth });
const fakePanel = (options) => ({
	querySelector: (selector) => (selector === '.dsb-meter-tight' ? (options.tight === true ? {} : null) : null),
	querySelectorAll: (selector) => (selector === '.dsb-meter-cols' ? options.grids : [])
});
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(680, 680)] })),
	false, '内容宽 = 容器宽 → 放得下（不用加行）');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(1020, 680)] })),
	true, '内容 1020 > 容器 680 → 放不下，继续加行数');
/* 1px 容差：scrollWidth / clientWidth 都是整数，亚像素取整可能差 1px，不该被当成溢出而白加一档 */
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(681, 680)] })),
	false, '只差 1px（取整误差）不算溢出');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(682, 680)] })),
	true, '差 2px 才算溢出');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: false, grids: [fakeGrid(1020, 680)] })),
	false, '只有工具调用子视图（tight）才做这个量测');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(400, 400), fakeGrid(900, 680)] })),
	true, '多个网格时任一溢出即算放不下');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(400, 400), fakeGrid(680, 680)] })),
	false, '多个网格全放得下才算放得下');
assert.strictEqual(api.toolColumnsOverflow(fakePanel({ tight: true, grids: [fakeGrid(900, 0)] })),
	false, '容器宽 0（还没布局完）不算溢出，避免首帧误加行');
assert.strictEqual(api.toolColumnsOverflow({}), false, '拿不到 DOM（测试替身 / 没挂载）时不误判');
assert.strictEqual(api.toolColumnsOverflow(null), false, '气泡还没挂上时给 false');
console.log('横向溢出量测：scrollWidth > clientWidth 即"放不下"；1px 取整容差；tight 之外不量');

/* 空列表：气泡照样打得开，不出现空白（count 为 0 时行不带 sub，这里手工搭一层只为验子视图本身） */
const emptyTip = {
	kind: 'rows',
	title: '会话数据',
	rows: [
		{ label: '上下文压缩', value: '0', sub: api.compactList([], t) },
		{ label: '技能注入', value: '0', sub: api.skillList([], null, t) },
		{ label: '工具调用', value: '0', sub: api.toolList({}, t) }
	]
};
assert.deepStrictEqual(listRows(subPanel(emptyTip, 0, 3)), [{ name: '上下文压缩', value: '-' }], '没有压缩时给一行横杠占位');
assert.deepStrictEqual(listRows(subPanel(emptyTip, 1, 3)), [{ name: '技能注入', value: '-' }], '没有技能时给一行横杠占位');
assert.deepStrictEqual(listRows(subPanel(emptyTip, 2, 3)), [{ name: '工具调用', value: '-' }], '没有工具调用时给一行横杠占位');
/* 旧宿主只给字符串（还没升级的那一半）：按每次注入一条算，不至于整行消失；仍然只显示名字 */
const stringSkills = api.skillList(['ponytail', 'ponytail'], null, t);
assert.deepStrictEqual(Array.from(stringSkills.rows, (row) => ({ label: row.label, value: row.value })),
	[{ label: 'ponytail', value: undefined }], '字符串形式的旧契约也能聚合排序，但行上只有名字');
console.log('空列表：技能 / 工具 / 压缩都退回一行横杠；旧字符串契约兼容');

console.log('');
console.log('LIST LAYOUT CHECKS PASSED');
