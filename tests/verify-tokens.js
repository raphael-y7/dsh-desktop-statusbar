/** token 段规则验证（对齐按整行宽度判断）。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { segmentView, formatTokens };\n\t\texports.apply = apply;');

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

const zhStart = code.indexOf('\t\tconst zh = {');
const zhEnd = code.indexOf('\n\t\t};', zhStart);
assert.ok(zhStart >= 0 && zhEnd > zhStart, 'zh dict located');
const zhDict = eval('(' + code.slice(zhStart + '\t\tconst zh = '.length, zhEnd + '\n\t\t};'.length - 1) + ')');
const t = (key, params) => {
	let out = zhDict[key] !== undefined ? zhDict[key] : '<' + key + '>';
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

/* 1. 千分位 */
for (const [input, want] of [[1234567, '1,234,567'], [123456, '123,456'], [999, '999'], [1000, '1,000'], [1029631, '1,029,631'], [0, '0']]) {
	assert.strictEqual(api.formatTokens(input), want, 'formatTokens(' + input + ')');
}
console.log('千分位:', [1234567, 123456, 999, 1000, 1029631, 0].map((n) => api.formatTokens(n)).join(' | '));

/* 2. 主显示 = 三者之和，不带段名 */
const usage = { uncachedInputTokens: 29631, cacheReadTokens: 1900000, cacheWriteTokens: 500, outputTokens: 41007 };
const view = api.segmentView('tokens', { usage, currency: 'CNY', now: Date.now() }, t);
const sum = 29631 + 1900000 + 500 + 41007;
console.log('显示:', JSON.stringify(view.text));
console.log('悬停:');
console.log(view.title);
assert.ok(view.text.indexOf(api.formatTokens(sum)) >= 0, 'text shows the sum: ' + view.text);
assert.ok(view.text.indexOf('输入') < 0 && view.text.indexOf('输出') < 0, 'text has no segment label: ' + view.text);
assert.ok(/tokens\s*$/.test(view.text.trim()), 'ends with tokens unit');
assert.ok(!/[、,]/.test(view.text.replace(/,(\d{3})/g, '$1')), 'single number, no extra dividers');

/* 3. 悬停明细：rows 三行（标签 + 数值），交给 grid 左右分列 */
const rows = view.rows;
assert.ok(Array.isArray(rows) && rows.length === 3, 'three hover rows');
assert.strictEqual(rows.map((r) => r.label).join('|'), [zhDict.f_tokensHit, zhDict.f_tokensMiss, zhDict.f_tokensOut].join('|'), 'labels in order');
assert.strictEqual(rows.map((r) => r.value).join('|'), [api.formatTokens(1900000), api.formatTokens(30131), api.formatTokens(41007)].join('|'), 'values are the three parts');
assert.ok(rows.every((r) => typeof r.value === 'string' && r.value.indexOf('tokens') < 0), 'values carry no unit');
console.log('悬停三行:', rows.map((r) => r.label + ' ' + r.value).join(' / '));

/* 4. 无 usage → 段返回 null，占位渲染成「输入/输出 - tokens」 */
assert.strictEqual(api.segmentView('tokens', { usage: undefined, currency: 'CNY', now: Date.now() }, t), null, 'no usage → null');
console.log('无数据占位:', '输入/输出 - tokens（由 f_tokens + 占位规则生成）');

console.log('\nTOKEN SEGMENT CHECKS PASSED');
