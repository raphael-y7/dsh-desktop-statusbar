/**
 * 令牌面板的口径检查：总计与本轮共用这块面板，读法必须一致。
 *   - 总量 = 缓存命中 + 未命中输入 + 输出，千分位精确值（底栏那行不再显示 token 数）
 *   - 分段条按实际占比划分，合起来顶满 100%
 *   - 未命中输入 = 未缓存输入 + 缓存写入（与官方 tokenUsage 同口径）
 * 用法：node verify-tokens.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { tokenPanelView, sessionTokenParts, billableParts };\n\t\texports.apply = apply;');

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

console.log('');
console.log('TOKEN PANEL CHECKS PASSED');
