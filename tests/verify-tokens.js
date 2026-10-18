/**
 * 令牌面板的口径检查：总计与本轮共用这块面板，读法必须一致。
 *   - 总量 = 缓存命中 + 未命中输入 + 输出，千分位精确值（底栏那行不再显示 token 数）
 *   - 分段条按实际占比划分，合起来顶满 100%
 *   - 未命中输入 = 未缓存输入 + 缓存写入（与官方 tokenUsage 同口径）
 *   - 条上要能看出子代理（队友）的占比：同色段拆成「主会话原色 + 子代理 50% 浅色」，
 *     顺序固定 命中主/子 → 未命中主/子 → 输出主/子；数字与行仍是合并口径
 * 用法：node verify-tokens.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { tokenPanelView, tokensTip, meterBar, mergeTokenParts, sessionTokenParts, billableParts, summaryTokenParts };\n\t\texports.apply = apply;');

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
/* React 替身：返回带 class 的树节点，够验「子段挂没挂 dsb-bar-sub」 */
const reactStub = {
	createElement(type, props, ...children) {
		return {
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
		};
	},
	useState: (v) => [v, () => {}], useRef: () => ({}),
	useSyncExternalStore: (s, g) => g(), useEffect: () => {}, Fragment: Symbol('F')
};
const api = captured.factory((n) => {
	if (n !== 'react') throw new Error('unexpected require: ' + n);
	return reactStub;
}).__t;
const classNames = (node, out) => {
	const found = out === undefined ? [] : out;
	if (node === null || node === undefined || node === false) return found;
	if (Array.isArray(node)) {
		node.forEach((one) => classNames(one, found));
		return found;
	}
	if (typeof node !== 'object') return found;
	const className = node.props === undefined || node.props.className === undefined ? '' : String(node.props.className);
	if (className !== '') found.push(className);
	(node.children || []).forEach((one) => classNames(one, found));
	return found;
};

const ZH = {
	f_tokensHit: '输入(命中缓存)',
	f_tokensMiss: '输入(未命中缓存)',
	f_tokensOut: '输出'
};
const t = (key, params) => {
	let out = ZH[key] !== undefined ? ZH[key] : '<' + key + '>';
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

/* 1. 三段之和 + 千分位（面板里只给数字，不再带 tokens 单位） */
const panel = api.tokenPanelView(1900000, 30131, 41007, t);
assert.strictEqual(panel.totalText, '1,971,138', '第一排是三者之和（千分位，不带单位）');
assert.deepStrictEqual(Array.from(panel.rows, (row) => row.label), ['输入(命中缓存)', '输入(未命中缓存)', '输出'], '三行标签');
assert.strictEqual(panel.rows[0].value, '1,900,000', '命中缓存');
assert.strictEqual(panel.rows[1].value, '30,131', '未命中缓存');
assert.strictEqual(panel.rows[2].value, '41,007', '输出');
const widthSum = panel.segments.reduce((sum, one) => sum + one.width, 0);
assert.ok(Math.abs(widthSum - 100) < 0.01, '条顶满 100%（按实际占比划分），实际 ' + widthSum);
console.log('令牌面板:', panel.totalText, '|', panel.rows.map((row) => row.label + ' ' + row.value).join(' / '));

/* 2. 三段全 0 不给面板（段本身也就不显示，不会弹空泡泡） */
assert.strictEqual(api.tokenPanelView(0, 0, 0, t), null, '全 0 返回 null');
console.log('全 0:', 'null（不弹面板）');

/* 3. 两个数据源归一到同一套三段 */
assert.strictEqual(JSON.stringify(api.sessionTokenParts({ uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 5, outputTokens: 7 })),
	JSON.stringify({ cached: 200, missInput: 105, output: 7 }), '官方 tokenUsage → 三段');
assert.strictEqual(api.sessionTokenParts(undefined), null, '没有官方用量时返回 null');
assert.strictEqual(JSON.stringify(api.billableParts({ input: 5, cacheRead: 7, cacheWrite: 3, output: 11 })),
	JSON.stringify({ cached: 7, missInput: 8, output: 11 }), '插件调用记录 → 三段');
console.log('两个数据源同口径');
/* 没有子代理数据时仍只有原来的三段，不挂 sub 标记（老口径不变） */
assert.ok(panel.segments.every((one) => one.sub === undefined), '没有子代理数据：三段都不带 sub 标记');

/* 4. 有子代理用量：子代理块在左、主会话块在右，共 6 小段 */
const MAIN = { cached: 1900000, missInput: 30131, output: 41007 };
const SUB = { cached: 100000, missInput: 20000, output: 10000 };
const mergedParts = api.mergeTokenParts(MAIN, SUB);
const total = mergedParts.cached + mergedParts.missInput + mergedParts.output;
const split = api.tokenPanelView(mergedParts.cached, mergedParts.missInput, mergedParts.output, t, SUB);
const GRAY = 'var(--dsw-static-neutral-bluish-400)';
const PURPLE = '#a78bfa';
const BLUE = 'var(--dsw-static-blue-450)';
const pct = (value) => (value / total) * 100;
assert.strictEqual(split.totalText, '2,101,138', '总量仍是合并口径（主 + 子）');
assert.deepStrictEqual(Array.from(split.rows, (row) => ({ label: row.label, value: row.value })), [
	{ label: '输入(命中缓存)', value: '2,000,000' },
	{ label: '输入(未命中缓存)', value: '50,131' },
	{ label: '输出', value: '51,007' }
], '三行明细仍是合并后的数字，不新增行');
assert.strictEqual(split.segments.length, 6, '主+子拆成 6 小段');
assert.deepStrictEqual(Array.from(split.segments, (one) => one.color), [GRAY, PURPLE, BLUE, GRAY, PURPLE, BLUE],
	'顺序：子·命中 → 子·未命中 → 子·输出 → 主·命中 → 主·未命中 → 主·输出（子块在左、主块在右）');
assert.deepStrictEqual(Array.from(split.segments, (one) => one.sub === true), [true, true, true, false, false, false],
	'前 3 小段是子代理块，后 3 小段是主会话块');
assert.deepStrictEqual(Array.from(split.segments, (one) => one.light === true), [true, false, false, false, false, false],
	'只有「子·命中」是 75% 浅灰；子·未命中 / 子·输出用正常主色');
/* 宽度手算：子段 = 子值 / 总量，主段 =（合并值 - 子值）/ 总量 */
const expectWidths = [
	pct(100000), pct(20000), pct(10000),
	pct(1900000), pct(30131), pct(41007)
];
split.segments.forEach((one, at) => {
	assert.ok(Math.abs(one.width - expectWidths[at]) < 1e-9,
		'第 ' + (at + 1) + ' 小段宽度按占比：期望 ' + expectWidths[at] + '，实际 ' + one.width);
});
const splitSum = split.segments.reduce((sum, one) => sum + one.width, 0);
assert.ok(Math.abs(splitSum - 100) < 1e-9, '6 小段合起来仍顶满 100%，实际 ' + splitSum);
console.log('子代理分段:', split.segments.map((one) => (one.sub === true ? '子' : '主') + one.width.toFixed(2) + '%').join(' / '));

/* 5. 渲染层：只有「子·命中」挂 dsb-bar-sub（CSS 75% 灰），其余段用行内主色 */
const collectNodes = (node, cls, out) => {
	const found = out === undefined ? [] : out;
	if (node === null || node === undefined || node === false) return found;
	if (Array.isArray(node)) {
		node.forEach((one) => collectNodes(one, cls, found));
		return found;
	}
	if (typeof node !== 'object') return found;
	const className = node.props === undefined || node.props.className === undefined ? '' : String(node.props.className);
	if (className.split(' ').indexOf(cls) !== -1) found.push(node);
	(node.children || []).forEach((one) => collectNodes(one, cls, found));
	return found;
};
const barTree = api.meterBar(split);
assert.strictEqual(collectNodes(barTree, 'dsb-bar-seg').length, 6, '条上渲染 6 个小段');
const lightNodes = collectNodes(barTree, 'dsb-bar-sub');
assert.strictEqual(lightNodes.length, 1, '只有「子·命中」这 1 段挂 dsb-bar-sub（75% 灰）');
assert.strictEqual(lightNodes[0].props.style.backgroundColor, undefined,
	'浅色段不写行内背景色（交给 CSS，否则会盖掉 75% 灰）');
assert.ok(typeof lightNodes[0].props.style.width === 'string' && lightNodes[0].props.style.width.indexOf('%') !== -1,
	'浅色段宽度按百分比写进 style');
const allSegs = collectNodes(barTree, 'dsb-bar-seg');
assert.deepStrictEqual(Array.from(allSegs, (one) => one.props.style.backgroundColor),
	[undefined, PURPLE, BLUE, GRAY, PURPLE, BLUE],
	'其余 5 段用正常主色（background-color 长写，避免重置 background-clip）：子·未命中紫 / 子·输出蓝 / 主·命中灰 / 主·未命中紫 / 主·输出蓝');
/* 子值为 0 的类别不渲染子段；主值为 0 的类别不渲染主段 */
const onlySub = api.tokenPanelView(100000, 0, 0, t, { cached: 100000, missInput: 0, output: 0 });
assert.strictEqual(onlySub.segments.length, 1, '本会话命中为 0 时只剩子代理那 1 段');
assert.strictEqual(onlySub.segments[0].sub, true, '剩下的是子段');
assert.strictEqual(onlySub.segments[0].light, true, '子·命中段用浅色');
const onlyMain = api.tokenPanelView(100000, 0, 0, t, { cached: 0, missInput: 0, output: 0 });
assert.strictEqual(onlyMain.segments.length, 1, '子代理为 0 时只有主段');
assert.strictEqual(onlyMain.segments[0].sub, undefined, '主段不挂 sub 标记');
assert.strictEqual(onlyMain.segments[0].light, undefined, '主段不挂浅色标记');
console.log('渲染层：6 小段，只「子·命中」1 段 dsb-bar-sub（75% 灰）');

/* 6. parts 为 null 但有子代理数据：仍出面板（不能退化成横杠） */
const tipOnlySub = api.tokensTip(null, '总计用量', t, SUB);
assert.strictEqual(tipOnlySub.panel.totalText, '130,000', '只有子代理数据时总量 = 子代理三段之和');
assert.strictEqual(tipOnlySub.panel.segments.length, 3, '三段都是子段');
assert.ok(tipOnlySub.panel.segments.every((one) => one.sub === true), '主会话没数据时三小段全是子代理块');
assert.deepStrictEqual(Array.from(tipOnlySub.panel.segments, (one) => one.light === true), [true, false, false],
	'只有「子·命中」是浅色，其余用主色');
assert.strictEqual(api.tokensTip(null, '总计用量', t, null).panel.totalText, '-', '两个来源都没有时仍是横杠面板');
console.log('无主会话数据时仍出面板（子代理块在左、只有命中段浅色）');

/* 7. 总计用量要**含压缩摘要**（用户拍板的「官方投影继续用，只把摘要额外加上」）
   背景：「总计费用」是我们自己逐条算的、含摘要；而「总计用量」原本只读官方 tokenUsage
   投影，官方只折 assistant 事件、**不含摘要** → 同一个气泡里两个数字口径不一致。
   宿主现在额外给出 summaryParts（只属于摘要的四段），客户端要把它加到总计用量上。
   口径转换必须与 billableParts 一致：input + cacheWrite 算 missInput、cacheRead 算 cached、
   output 算 output —— 否则三行明细与总量对不上。 */
const SUM_PARTS = { input: 496385, cacheRead: 1152, cacheWrite: 0, output: 4186 };
const sumAsParts = api.summaryTokenParts(SUM_PARTS);
assert.strictEqual(JSON.stringify(sumAsParts), JSON.stringify({ cached: 1152, missInput: 496385, output: 4186 }),
	'摘要四段按 billableParts 口径映射：cacheRead→cached、input+cacheWrite→missInput、output→output');
/* 宿主老版本没有这个字段 → null，调用方当 0 处理，行为退回改动前 */
assert.strictEqual(api.summaryTokenParts(undefined), null, '老宿主没有 summaryParts → null');
assert.strictEqual(api.summaryTokenParts(null), null, 'summaryParts 为 null → null');
/* 空对象：host 不会写这种值，但即便出现也只会加 0，不该崩 */
assert.strictEqual(JSON.stringify(api.summaryTokenParts({})), JSON.stringify({ cached: 0, missInput: 0, output: 0 }),
	'空对象映射成三段全 0（加进去等于没加，不会崩）');
/* 关键：加上摘要后总量必须**变多**，而且多的正好是摘要那部分 */
const officialParts = { cached: 1900000, missInput: 29631, output: 41007 };
const withSummary = api.mergeTokenParts(officialParts, sumAsParts);
assert.strictEqual(JSON.stringify(withSummary), JSON.stringify({
	cached: 1900000 + 1152,
	missInput: 29631 + 496385,
	output: 41007 + 4186
}), '总计用量 = 官方投影 + 摘要（三段逐项相加）');
const totalWithout = officialParts.cached + officialParts.missInput + officialParts.output;
const totalWith = withSummary.cached + withSummary.missInput + withSummary.output;
const summaryTotal = 1152 + 496385 + 4186;
assert.strictEqual(totalWith - totalWithout, summaryTotal,
	'加上摘要后总量正好多出摘要那 ' + summaryTotal + ' 个 token，实际多 ' + (totalWith - totalWithout));
/* 再加队友：三段都保留，顺序是 官方 → 摘要 → 队友 */
const withAll = api.mergeTokenParts(withSummary, { cached: 1000, missInput: 2000, output: 3000 });
assert.strictEqual(JSON.stringify(withAll), JSON.stringify({
	cached: 1900000 + 1152 + 1000,
	missInput: 29631 + 496385 + 2000,
	output: 41007 + 4186 + 3000
}), '总计用量 = 官方投影 + 摘要 + 队友');
/* mergeTokenParts 两段都要容忍 null（摘要/队友任一段缺失时不能崩） */
assert.strictEqual(JSON.stringify(api.mergeTokenParts(officialParts, null)), JSON.stringify(officialParts), '第二段为 null 时当 0，不崩');
assert.strictEqual(JSON.stringify(api.mergeTokenParts(null, sumAsParts)), JSON.stringify(sumAsParts), '第一段为 null 时当 0，不崩');
assert.strictEqual(JSON.stringify(api.mergeTokenParts(null, null)), JSON.stringify({ cached: 0, missInput: 0, output: 0 }), '两段都 null → 全 0');
console.log('总计用量含摘要：官方投影 + 摘要 + 队友（三段逐项相加，多出的正好是摘要量）');

console.log('');
console.log('TOKEN PANEL CHECKS PASSED');



