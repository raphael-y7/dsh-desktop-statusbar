/**
 * 上下文占用（对齐官方 ContextMeter 口径）测试：
 *   - 占用量：projectedTokens 优先，缺省退回 pressureTokens；除以 contextWindow 取整、封顶 100
 *   - 精确数字：千分位、不缩写
 *   - 分项面板：三行构成 + 按比例的分段宽度；没有 breakdown 时退化成单段
 *   - 段渲染：状态段带圆环数据；token 段变成"小条 + 百分比"，没有占用数据时退回 token 总数
 * 用法：node verify-context.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker,
	'\t\texports.__test = { contextOccupancy, formatTokensExact, meterView, dashMeter, segmentView, segmentText, contextRing, SEGMENTS };\n' + marker);

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0, clearInterval: () => {},
	setTimeout: () => 0, clearTimeout: () => {},
	fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
};
let captured = null;
fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
const sandbox = {
	window: fakeWindow,
	document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
/* 记录型 createElement：圆环的 SVG 属性要能被断言 */
const reactStub = {
	createElement: (type, props, ...children) => ({ type: type, props: props || {}, children: children }),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {}, useRef: () => ({ current: null }),
	useSyncExternalStore: (s, snap) => snap(), useCallback: (fn) => fn, useMemo: (fn) => fn(),
	Fragment: Symbol('Fragment')
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

/* 只放这次用得到的键，缺失的键渲染成 <key> 便于发现漏配 */
const DICT = {
	contextAria: '上下文已用 {percent}', contextSystem: '系统提示词', contextTools: '工具定义', contextMessages: '对话消息',
	numThousand: '{value}K', numMillion: '{value}M',
	f_peak: '高峰', f_valley: '低谷', f_tokens: '{total} tokens',
	f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出'
};
const t = (key, params) => {
	let out = DICT[key] !== undefined ? DICT[key] : ('<' + key + '>');
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

/* ------------------------------------------------------------- 占用计算 */
const cases = [
	{ name: 'projectedTokens 优先', input: { projectedTokens: 300000, pressureTokens: 900000, contextWindow: 1000000 }, percent: 30 },
	{ name: '没有 projected 就用 pressure', input: { pressureTokens: 620000, contextWindow: 1000000 }, percent: 62 },
	{ name: '超过窗口封顶 100', input: { pressureTokens: 2000000, contextWindow: 1000000 }, percent: 100 },
	{ name: '四舍五入', input: { pressureTokens: 308400, contextWindow: 1000000 }, percent: 31 }
];
cases.forEach((one) => {
	const got = api.contextOccupancy(one.input);
	assert.strictEqual(got.percent, one.percent, one.name);
	console.log('= ' + one.name + ' → ' + got.percent + '%（' + got.usedTokens + ' / ' + got.contextWindow + '）');
});
[[null], [undefined], [{}], [{ pressureTokens: 100 }], [{ contextWindow: 1000 }], [{ projectedTokens: null, contextWindow: 1000 }]].forEach((args, index) => {
	assert.strictEqual(api.contextOccupancy(args[0]), null, '缺数据应返回 null（第 ' + index + ' 例）');
});
console.log('= 缺用量或缺窗口：口径层返回 null（渲染层再用空环兜底，不让底栏缺项）');

/* ------------------------------------------------------------- 精确数字 */
[['999', 999], ['1,500', 1500], ['308,400', 308400], ['1,000,000', 1000000], ['0', 0]].forEach((one) => {
	assert.strictEqual(api.formatTokensExact(one[1]), one[0], one[1] + ' → ' + one[0]);
});
console.log('= 精确数字（千分位）：999 / 1,500 / 308,400 / 1,000,000 都对');

/* ------------------------------------------------------------- 分项面板数据 */
const meter = api.meterView({ pressureTokens: 308400, contextWindow: 1000000 }, { systemTokens: 1900, toolsTokens: 7300, messageTokens: 181000 }, null, t);
assert.strictEqual(meter.percent, 31, '占用百分比');
assert.strictEqual(meter.used, '308,400', '已用（精确到个位）');
assert.strictEqual(meter.window, '1M', '窗口（整百万缩写到 M）');
assert.strictEqual(meter.rows.length, 3, '三行构成');
assert.deepStrictEqual(Array.from(meter.rows, (r) => r.label), ['系统提示词', '工具定义', '对话消息'], '行顺序与官方一致');
assert.strictEqual(meter.rows[0].value, '1,900', '图例数值精确到个位、不带约等于号');
assert.strictEqual(meter.rows[1].value, '7,300', '工具定义');
assert.strictEqual(meter.rows[2].value, '181,000', '对话消息');
const sumWidth = meter.segments.reduce((sum, one) => sum + one.width, 0);
assert.ok(Math.abs(sumWidth - 31) < 0.01, '各段宽度合计 = 占用比例 31（不是 100）');
assert.ok(Math.abs(meter.segments[2].width - 31 * 181000 / 190200) < 0.01, '对话消息段按占比切分这 31%');
console.log('= 分项面板：31% 308,400 / 1,000,000，三行 1,900 / 7,300 / 181,000，条只填到 31%');

const noBreakdown = api.meterView({ pressureTokens: 500000, contextWindow: 1000000 }, undefined, null, t);
assert.deepStrictEqual(Array.from(noBreakdown.segments, (s) => Math.round(s.width)), [50], '没有 breakdown 时单段宽度 = 占用比例');
assert.deepStrictEqual(Array.from(noBreakdown.rows), [], '没有 breakdown 就没有图例行');
console.log('= 没有 breakdown 时退化成单段，宽度是占用比例');

/* 缺数据必须仍然出空环：圆环是固定底栏项，不能时有时无（会话刚发出就中断时最容易撞上） */
const dash = api.dashMeter();
assert.strictEqual(dash.percent, 0, '空态圆环进度为 0（只画底环）');
assert.strictEqual(dash.empty, true, '空态带 empty 标记，面板据此区分“没数据”与“0%”');
assert.strictEqual(dash.used, '-', '空态已用给横杠');
assert.strictEqual(dash.window, '-', '空态窗口给横杠');
assert.deepStrictEqual(Array.from(dash.rows), [], '空态没有图例行');
assert.deepStrictEqual(Array.from(dash.segments), [], '空态没有分段');
assert.strictEqual(dash.compact, null, '空态没有压缩点缺口');
const dashRing = api.contextRing(dash.percent, 'idle');
assert.strictEqual(Array.from(dashRing.children).length, 2, '空态圆环照旧是底环 + 进度弧');
assert.strictEqual(Array.from(dashRing.children)[1].props.strokeDashoffset, 2 * Math.PI * 5.5, '0% 时进度弧整段留空');
console.log('= 缺占用数据 → 空环 + 横杠（不再整块消失）');

/* ------------------------------------------------------------- 段渲染 */
const baseSrc = {
	usage: { uncachedInputTokens: 29631, cacheReadTokens: 1900000, cacheWriteTokens: 0, outputTokens: 41007 },
	pressure: { pressureTokens: 620000, contextWindow: 1000000 },
	breakdown: { systemTokens: 1900, toolsTokens: 7300, messageTokens: 181000 },
	running: false, partial: null, runningCalls: [], lastAgentError: null, pendingApprovals: null,
	now: Date.UTC(2026, 8, 21, 2, 0), currency: 'CNY'
};
/* 圆环已拆成独立开关：峰谷段只出文字，运行状态交给圆环自己上色（组件层测） */
const statusView = api.segmentView('status', baseSrc, t);
assert.strictEqual(statusView.meter, undefined, '状态段不再背圆环数据');
assert.strictEqual(statusView.state, undefined, '运行状态不再挂在峰谷段上');
assert.ok(statusView.text === '高峰' || statusView.text === '低谷', '峰谷文字，实际 ' + statusView.text);
console.log('= 状态段：只出峰谷文字，圆环改由独立开关控制');

assert.strictEqual(api.SEGMENTS.filter((seg) => seg.id === 'tokens')[0], undefined, 'token 计数段已从字段表移除');
const contextMeter = api.meterView(baseSrc.pressure, baseSrc.breakdown, null, t);
assert.strictEqual(contextMeter.percent, 62, '圆环与面板同一口径（62%）');
/* 压缩点：给了窗口 + 本次输出上限就算得出触发点（1M 窗口 / 384K 输出 → 550,464，即 55.0464%） */
const withCapacity = api.meterView(baseSrc.pressure, baseSrc.breakdown, { contextWindow: 1000000, maxOutputTokens: 384000 }, t);
assert.ok(Math.abs(withCapacity.compact - 55.0464) < 1e-6, '压缩点百分比，实际 ' + withCapacity.compact);
assert.strictEqual(contextMeter.compact, null, '没有 capacity 时压缩点为空（圆环上不开缺口）');
console.log('= 圆环带上下文占用气泡；压缩点随模型自适应；token 计数段已并入总计，峰谷可点');

/* ------------------------------------------------------------- 圆环几何 */
const ring = api.contextRing(62, 'idle');
assert.strictEqual(ring.type, 'svg', '圆环是 svg');
assert.ok(String(ring.props.className).indexOf('dsb-ring') === 0, '圆环类名');
const circles = Array.from(ring.children);
assert.strictEqual(circles[0].props.className, 'dsb-ring-track', '底环');
assert.strictEqual(circles[1].props.className, 'dsb-ring-fill', '进度弧');
assert.strictEqual(circles[1].props.transform, 'rotate(-90 7 7)', '起点在 12 点方向（整体转 -90°）');
assert.strictEqual(Math.round(circles[1].props.strokeDasharray), Math.round(2 * Math.PI * 5.5), '周长 = 2πr');
assert.strictEqual(Math.round(circles[1].props.strokeDashoffset), Math.round(2 * Math.PI * 5.5 * 0.38), '62% 时留 38% 的缺口');
assert.ok(String(api.contextRing(62, 'running').props.className).includes('dsb-ring-running'), '运行中 → 绿色');
assert.ok(String(api.contextRing(62, 'error').props.className).includes('dsb-ring-error'), '报错 → 红色');
assert.ok(String(api.contextRing(62, 'approval').props.className).includes('dsb-ring-approval'), '待审批 → 黄色');
/* 底环：没有压缩点时整圈（不旋转、不设 dasharray）；有压缩点时在压缩点处开一个圆头缺口 */
assert.strictEqual(circles[0].props.transform, undefined, '没有压缩点时底环不旋转');
assert.strictEqual(circles[0].props.strokeDasharray, undefined, '没有压缩点时底环整圈');
const notchTrack = Array.from(api.contextRing(62, 'idle', 55.0464).children)[0];
assert.strictEqual(notchTrack.props.transform, 'rotate(-90 7 7)', '开缺口时底环转到 12 点起（与进度弧同一口径）');
assert.strictEqual(notchTrack.props.strokeLinecap, 'round', '缺口两端是圆头');
const notchDashes = notchTrack.props.strokeDasharray.split(' ').map(Number);
assert.strictEqual(notchDashes.length, 3, '缺口 = 画-空-画 三段');
assert.strictEqual(notchDashes[1], 3, '空洞 = 净宽 1 + 描边 2（圆头各向洞内啃半个线宽）');
assert.ok(Math.abs(notchDashes[0] + notchDashes[1] + notchDashes[2] - 2 * Math.PI * 5.5) < 1e-12, '三段之和精确等于周长');
assert.ok(Math.abs((notchDashes[0] + notchDashes[1] / 2) - 2 * Math.PI * 5.5 * 0.550464) < 1e-12, '缺口中心落在压缩点上');
console.log('= 圆环：12 点起、周长与进度正确、颜色随状态；压缩点处开圆头缺口');

/* 点击与收起的契约：圆环包在按钮里（hover/展开有灰底），面板点别处收起 */
const source = fs.readFileSync(PLUGIN, 'utf8');
assert.ok(source.includes('className: "dsb-ring-btn"'), '圆环包在按钮里（点击范围带灰底）');
assert.ok(source.includes('.dsb-ring-btn:hover,.dsb-ring-btn[aria-expanded="true"]'), 'hover 与展开态都有灰底');
assert.ok(source.includes('addEventListener("click", onDocClick)'), '点别处收起面板');
assert.ok(source.includes('onMouseEnter:'), '悬停气泡：鼠标移到段上给活跃总览');
assert.ok(source.includes('|| dashMeter()'), '拿不到占用数据时兜底成空环，不整块消失');
console.log('= 点击范围灰底、点别处收起、悬停给活跃总览');

console.log('');
console.log('CONTEXT METER CHECKS PASSED');
