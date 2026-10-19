/**
 * 2.2.2 三项行为检查：
 *
 * ① 积分套餐排序：月度刷新包置顶 → 其余按过期时间升序 → 裂变包置底。
 *    关键约束：**必须先按原顺序聚合相邻同名包、最后才整体排序** ——
 *    先排会把 11 个裂变包按日期打散，聚合成「×11」就没了。
 *
 * ② 工具名悬停提示整组关闭：气泡放不下（列网格横向溢出）且行数已加到上限时，
 *    该子视图内**所有**工具名的悬停提示一律不挂 —— 不是只关超长那一个。
 *    加行途中（3 → 4 → 5 …）短暂溢出是正常的，不该提前关。
 *
 * ③ 禁选：底栏、气泡、设置页、跟手浮层、悬停文字都要 user-select:none，
 *    并且 ::selection 要写透明（只写 user-select 时某些内核拖动仍画蓝底）。
 *    设置页里的输入框必须单独放开，否则改不了数。
 *
 * 做法与 verify-list-layout.js 相同：vm 里加载真实 client.js，用最小 React 替身渲染虚拟树，
 * 直接断言数据与树（不跑浏览器）。
 * 用法：node verify-2.2.2.js
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
	'\t\texports.__v222 = { segmentView, rowsPanel, creditsSort, creditsSortGroup, creditsSortDate, '
	+ 'toolHoverSuppressed, LIST_ROWS_PER_COLUMN_MAX, CSS };\n' + marker);

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
}).__v222;

/* --------------------------------------------------------------- 小工具 */
const ZH = {
	segBalance: '余额', segCounts: '轮次＆步数', tipCountsTitle: '会话数据',
	tipCountsSkills: '技能注入', tipCountsCompactAt: '上下文压缩', tipCountsToolCalls: '工具调用',
	tipCreditsTitle: '积分套餐', tipCreditsMonthly: ' · 每月刷新', tipCreditsRefresh: ' · {date} 刷新',
	tipCreditsExpire: ' · {date} 到期', tipCreditsRefreshLatest: ' · {date} 刷新(最近)',
	tipCreditsExpireLatest: ' · {date} 到期(最近)', tipCreditsUsed: '已用 {used} / {total}',
	unitCountCalls: ' 次', f_balance: '余额 {symbol}{amount}', f_balanceDash: '余额 {symbol}-'
};
const t = (key, params) => {
	let out = ZH[key] !== undefined ? ZH[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
	return out;
};
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
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	if (typeof node.type === 'symbol') return (node.children || []).map(textOf).join('');
	return textOf(node.children);
}

/* ============================================================ ① 积分套餐排序 */
/* 需求：每个月固定会刷新的套餐固定在第一行；裂变包固定在最后；
   其他的按过期时间先后排序，最先要过期的排最前。 */
const wbSrc = { sessionModel: { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash-sg' } };
const rewardsOf = (rewards) => api.segmentView('balance', {
	sessionModel: wbSrc.sessionModel,
	balance: { ok: true, total: '177', currency: '', isCredits: true, rewards: rewards }
}, t).tip.panel.rewards;

/* 1.1 三档归组 */
assert.strictEqual(api.creditsSortGroup({ monthly: true }), 0, '月度刷新包归第 1 档（永远第一行）');
assert.strictEqual(api.creditsSortGroup({ monthly: false, name: '运营裂变包' }), 2, '裂变包归第 3 档（永远最后）');
assert.strictEqual(api.creditsSortGroup({ monthly: false, name: '拉新权益包' }), 1, '普通包归第 2 档（按到期时间排）');
assert.strictEqual(api.creditsSortGroup({ monthly: true, name: '月度裂变包' }), 0,
	'月度优先于裂变：既是月度又是裂变时，月度那档赢（第一行位置不能被挤走）');

/* 1.2 三档同时出现：月度置顶、裂变置底、其余按到期升序 */
const mixed = rewardsOf([
	{ name: '普通包晚', used: 0, total: 100, monthly: false, expireAt: '2026-12-01' },
	{ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: '2026-10-01' },
	{ name: '普通包早', used: 0, total: 100, monthly: false, expireAt: '2026-10-26' },
	{ name: '月度包', used: 0, total: 100, monthly: true, refreshAt: '2026-11-01' }
]);
assert.deepStrictEqual(Array.from(mixed, (one) => one.name), ['月度包', '普通包早', '普通包晚', '运营裂变包'],
	'月度包置顶 → 其余按到期升序（10-26 在 12-01 前）→ 裂变包置底（即使它 10-01 最早到期）');

/* 1.3 裂变包即使到期最早也排最后（证明"档位"优先于"日期"） */
const splitEarly = rewardsOf([
	{ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: '2026-01-01' },
	{ name: '普通包', used: 0, total: 100, monthly: false, expireAt: '2026-12-31' }
]);
assert.deepStrictEqual(Array.from(splitEarly, (one) => one.name), ['普通包', '运营裂变包'],
	'裂变包的可读性优先于日期：到期再早也排最后');

/* 1.4 月度包多个时按刷新日升序；没有日期的排在有日期之后 */
const monthlies = rewardsOf([
	{ name: '月度B', used: 0, total: 100, monthly: true, refreshAt: '2026-12-01' },
	{ name: '月度A', used: 0, total: 100, monthly: true, refreshAt: '2026-11-01' },
	{ name: '月度无日期', used: 0, total: 100, monthly: true }
]);
assert.deepStrictEqual(Array.from(monthlies, (one) => one.name), ['月度A', '月度B', '月度无日期'],
	'月度档内按刷新日升序；没有日期的排最后（不猜日期，也不插队）');

/* 1.5 聚合先于排序：普通包夹在裂变包前面时，裂变包仍是连续的一段 → 聚合成 ×11 */
const withPlainFirst = [
	{ name: '普通包', used: 0, total: 100, monthly: false, expireAt: '2026-10-01' }
];
for (let i = 0; i < 11; i += 1) {
	withPlainFirst.push({ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: i === 0 ? '2026-12-01' : '2026-11-07' });
}
const withPlainRows = rewardsOf(withPlainFirst);
assert.strictEqual(withPlainRows.length, 2, '普通包 1 行 + 裂变包聚合 1 行 = 2 行');
assert.deepStrictEqual(Array.from(withPlainRows, (one) => one.name), ['普通包', '运营裂变包'],
	'普通包排第一（10-01 最早到期），裂变包聚合成一行排最后');
assert.strictEqual(withPlainRows[1].count, 11, '聚合行记录 11 条');
assert.strictEqual(withPlainRows[1].label, '运营裂变包×11 · 11-07 到期(最近)',
	'排序不影响聚合：11 个裂变包仍并成「运营裂变包×11」，且取最近到期日');

/* 1.6 11 条裂变包跨日期分布（12-01 与 11-07 混排），排序后仍只出现一行 */
const mixedDates = [];
for (let i = 0; i < 11; i += 1) {
	mixedDates.push({ name: '运营裂变包', used: 0, total: 100, monthly: false, expireAt: i % 2 === 0 ? '2026-12-01' : '2026-11-07' });
}
const mixedDateRows = rewardsOf(mixedDates);
assert.strictEqual(mixedDateRows.length, 1, '11 条裂变包跨两个到期日 → 仍聚合成 1 行（先聚合后排序）');
assert.strictEqual(mixedDateRows[0].count, 11, '聚合行记录 11 条');
assert.strictEqual(mixedDateRows[0].label, '运营裂变包×11 · 11-07 到期(最近)',
	'聚合后取最近到期日 11-07 并标 (最近)');

/* 1.7 排序稳定：同一档内日期相同 / 都缺日期时保持上游原顺序 */
const stable = rewardsOf([
	{ name: '同B', used: 0, total: 100, monthly: false, expireAt: '2026-11-07' },
	{ name: '同A', used: 0, total: 100, monthly: false, expireAt: '2026-11-07' }
]);
assert.deepStrictEqual(Array.from(stable, (one) => one.name), ['同B', '同A'],
	'到期日相同 → 保持上游原顺序（Array.sort 稳定，界面不会每次刷新跳来跳去）');
const noDates = rewardsOf([
	{ name: '无日期B', used: 0, total: 100, monthly: false },
	{ name: '无日期A', used: 0, total: 100, monthly: false }
]);
assert.deepStrictEqual(Array.from(noDates, (one) => one.name), ['无日期B', '无日期A'],
	'都没有日期 → 保持上游原顺序');

/* 1.8 排序函数本身是纯函数，不改入参 */
const input = [
	{ name: '裂变包', monthly: false, expireAt: '2026-01-01' },
	{ name: '月度包', monthly: true, refreshAt: '2026-12-01' }
];
const snapshot = input.map((one) => one.name);
const sorted = api.creditsSort(input);
assert.deepStrictEqual(input.map((one) => one.name), snapshot, 'creditsSort 不改入参顺序（返回新数组）');
assert.deepStrictEqual(Array.from(sorted, (one) => one.name), ['月度包', '裂变包'], '返回的才是排好序的新数组');

/* ================================================= ② 工具名悬停整组关闭 */
/* 1. 判据：行数到上限 + 仍溢出 才算"真的到头" */
assert.strictEqual(api.toolHoverSuppressed(true, api.LIST_ROWS_PER_COLUMN_MAX), true,
	'行数到上限且仍放不下 → 整组关闭悬停提示');
assert.strictEqual(api.toolHoverSuppressed(true, api.LIST_ROWS_PER_COLUMN_MAX - 1), false,
	'还没到上限（还能再加行）→ 不能关，否则悬停会忽有忽无');
assert.strictEqual(api.toolHoverSuppressed(false, api.LIST_ROWS_PER_COLUMN_MAX), false,
	'放得下 → 不关（即使行数已经是上限）');
assert.strictEqual(api.toolHoverSuppressed(false, 3), false, '放得下 + 默认行数 → 不关');

/* 2. 落到树上：hoverSuppressed 为 true 时，彩条每段都不挂 onMouseEnter */
const countsSrc = {
	stats: { turns: 1, steps: 3 },
	progress: {
		turn: 1, turnSteps: 3, toolCalls: 9,
		toolCounts: { read: 5, edit: 2, pwsh: 2 }
	}
};
const countsTip = api.segmentView('counts', countsSrc, t).tip;
/* 工具调用是第 2 个子视图（0 压缩 / 1 技能 / 2 工具） */
const toolSubIndex = 2;
const hovered = (suppressed) => {
	const tree = api.rowsPanel(countsTip, null, { current: null }, {
		id: toolSubIndex,
		rowsPerColumn: api.LIST_ROWS_PER_COLUMN_MAX,
		hover: () => {},
		hoverMove: () => {},
		hoverSuppressed: suppressed
	});
	const segs = collectByClass(tree, 'dsb-bar-seg');
	return segs.filter((one) => typeof one.props.onMouseEnter === 'function').length;
};
assert.ok(hovered(false) > 0, '未关闭时彩条段挂悬停处理（基线非零，否则下面的断言没意义）');
assert.strictEqual(hovered(true), 0,
	'关闭时**所有**彩条段都不挂悬停处理（用户要求：不是只关超长那个，是全部不显示）');

/* 3. 关掉的是悬停，不是整块面板：行本身照常渲染 */
const suppressedTree = api.rowsPanel(countsTip, null, { current: null }, {
	id: toolSubIndex,
	rowsPerColumn: api.LIST_ROWS_PER_COLUMN_MAX,
	hover: () => {},
	hoverSuppressed: true
});
assert.ok(collectByClass(suppressedTree, 'dsb-meter-row').length > 0,
	'悬停关掉后工具列表照常显示（只关提示，不关内容）');

/* 4. 没传 hoverSuppressed（其它子视图 / 老调用方）时行为不变：照常挂悬停 */
const legacyTree = api.rowsPanel(countsTip, null, { current: null }, {
	id: toolSubIndex,
	rowsPerColumn: api.LIST_ROWS_PER_COLUMN_MAX,
	hover: () => {}
});
const legacySegs = collectByClass(legacyTree, 'dsb-bar-seg').filter((one) => typeof one.props.onMouseEnter === 'function');
assert.ok(legacySegs.length > 0, '不传 hoverSuppressed 时行为不变（默认照常挂悬停，向后兼容）');

/* ================================================================ ③ 禁选 */
/* CSS 在 client.js 里已拼成一份字符串（规则数组 → join 过），直接断言 */
const css = api.CSS;
assert.ok(typeof css === 'string' && css.length > 0, '样式表是字符串（能直接断言规则）');

/* 3.1 三处主要区域都要禁选 */
const SELECTORS = ['.dsb-root', '.dsb-tip', '.dsb-settings', '.dsb-hover-plain', '.dsb-drag-card'];
SELECTORS.forEach((selector) => {
	const rule = new RegExp(
		selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{[^}]*user-select:none'
	);
	assert.ok(rule.test(css), selector + ' 必须禁选（拖动时不能刷出蓝色选中底）');
	assert.ok(rule.test(css) && new RegExp(
		selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{[^}]*webkit-user-select:none'
	).test(css), selector + ' 还要带 -webkit- 前缀（内核差异）');
});

/* 3.2 ::selection 写成透明：只写 user-select:none 时，某些内核"先按下再拖"仍会画一层选中色 */
assert.ok(/::selection[^{}]*\{[^}]*background:transparent/.test(css),
	'::selection 要写透明背景（不能只靠 user-select:none）');
SELECTORS.slice(0, 3).forEach((selector) => {
	const rule = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*::selection');
	assert.ok(rule.test(css), selector + ' 也要覆盖 ::selection');
});

/* 3.3 设置页里的输入框必须能选中/编辑（改价格那几个 number 框），否则功能被误伤 */
assert.ok(/\.dsb-settings input[^{}]*\{[^}]*user-select:text/.test(css),
	'设置页输入框单独放开 user-select:text（禁选不能把编辑功能一起禁掉）');

/* 3.4 禁选规则不能误伤到输入框那句话之外 —— 确认输入框规则排在禁选规则之后（层叠靠后覆盖） */
const noneAt = css.indexOf('.dsb-root,.dsb-tip,.dsb-settings');
const textAt = css.indexOf('.dsb-settings input');
assert.ok(noneAt !== -1 && textAt !== -1, '两条规则都在样式表里');
assert.ok(textAt > noneAt, '输入框的 user-select:text 写在禁选之后，才能覆盖它');

console.log('ALL CHECKS PASSED');
