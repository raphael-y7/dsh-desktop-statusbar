/** 验证速度单位与余额悬停清理结果。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(PLUGIN, 'utf8');

/* 1. 源码层面：模板与单位都不带空格 */
const zhSpeed = code.match(/f_speed: "([^"]+)"/)[1];
const enSpeed = code.match(/f_speed: "([^"]+)"/g)[1];
console.log('zh f_speed =', JSON.stringify(zhSpeed), '| en =', JSON.stringify(enSpeed));
assert.ok(!/ \}?t\/s|\} t\/s/.test(zhSpeed), 'zh speed template has no space: ' + zhSpeed);
assert.ok(code.indexOf('unitSpeed: " t/s"') < 0, 'no unitSpeed with leading space');

/* 2. 运行层面：渲染出的速度段不带空格 */
let mod = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { segmentView, segmentText };\n\t\texports.apply = apply;');
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
vm.runInContext(mod, sb, { filename: 'client.js' });
const api = captured.factory((n) => {
	if (n !== 'react') throw new Error('unexpected require: ' + n);
	return { createElement: () => ({}), useState: (v) => [v, () => {}], useRef: () => ({}), useSyncExternalStore: (s, g) => g(), useEffect: () => {}, Fragment: Symbol('F') };
}).__t;

const t = (key, params) => {
	const dict = { f_speed: '输出速度 {throughput}t/s' };
	let out = dict[key] !== undefined ? dict[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

const speedView = api.segmentView('tps', { stats: { decodeMs: 1000, decodeTokens: 261 }, currency: 'CNY', now: Date.now() }, t);
console.log('速度段显示:', JSON.stringify(speedView.text));
assert.ok(/261t\/s$/.test(speedView.text), 'no space between number and unit: ' + speedView.text);

/* 3. 余额悬停残留已清空 */
for (const gone of ['balanceAtRow', 'balanceAtLabel', 'balanceAt:']) {
	assert.strictEqual(code.indexOf(gone), -1, 'leftover: ' + gone);
}
console.log('余额悬停残留: 已清空');

const balanceView = api.segmentView('balance', { balance: { ok: true, at: Date.now(), total: '9.54', currency: 'CNY' }, currency: 'CNY' }, t);
assert.strictEqual(balanceView.rows, undefined, 'balance has no hover rows');
console.log('余额段:', JSON.stringify(balanceView));

console.log('\nSPEED & CLEANUP CHECKS PASSED');
