/** 检查各段的悬停气泡：只有 tokens 段应该带 rows，余额段不该有。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
code = code.replace('\t\texports.apply = apply;',
	'\t\texports.__t = { segmentView, SEGMENTS };\n\t\texports.apply = apply;');

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
		useSyncExternalStore: (s, g) => g(), useEffect: () => {}, fallback: {}, Fragment: Symbol('F')
	};
}).__t;

const TEMPLATES = {
	f_balance: '余额 {symbol}{amount}',
	f_peak: '高峰',
	f_valley: '低谷',
	f_cost: '总计 {symbol}{cost}',
	f_lastCost: '本轮 {symbol}{cost}',
	f_tokens: '{total} tokens',
	f_tokensHit: '输入(命中缓存)',
	f_tokensMiss: '输入(未命中缓存)',
	f_tokensOut: '输出'
};
const t = (key, params) => {
	let out = TEMPLATES[key] !== undefined ? TEMPLATES[key] : key;
	if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};

const src = {
	stats: { turns: 2, steps: 10, llmMs: 1000, toolMs: 500, ttftMs: 2000, ttftSteps: 2, decodeMs: 1000, decodeTokens: 500 },
	usage: { uncachedInputTokens: 100, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 3000 },
	pressure: { pressureTokens: 1000, contextWindow: 1000000 },
	sessionModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
	sessionUsage: { models: {}, calls: [{ at: Date.now(), model: 'deepseek-flash', input: 0, cacheRead: 2000000, cacheWrite: 0, output: 3000 }], current: null, last: null, turn: 1 },
	timeRange: { turns: 60000, since: Date.now() - 5000, steps: 0, stepSince: null },
	running: true, partial: null, runningCalls: [], lastAgentError: null, pendingApprovals: [],
	timeline: undefined, now: Date.now(),
	balance: { ok: true, at: Date.now(), total: '9.54', currency: 'CNY' },
	turnUsage: { input: 0, cacheRead: 2000000, cacheWrite: 0, output: 3000 },
	currency: 'CNY'
};

const withRows = [];
api.SEGMENTS.forEach((seg) => {
	const view = api.segmentView(seg.id, src, t);
	if (view !== null && view !== undefined && view.rows !== undefined) withRows.push(seg.id);
});
console.log('带悬停气泡的段:', withRows.join(', ') || '(无)');

assert.ok(withRows.indexOf('tokens') >= 0, 'tokens keeps its hover rows');
assert.strictEqual(withRows.indexOf('balance'), -1, 'balance must not have hover rows');

const balanceView = api.segmentView('balance', src, t);
assert.ok(balanceView !== null, 'balance renders');
assert.strictEqual(balanceView.rows, undefined, 'balance view has no rows field');
assert.strictEqual(balanceView.text, '余额 ¥9.54', 'balance text intact: ' + balanceView.text);
console.log('余额段:', JSON.stringify(balanceView));

const tokenView = api.segmentView('tokens', src, t);
assert.ok(Array.isArray(tokenView.rows) && tokenView.rows.length === 3, 'tokens rows intact');
console.log('tokens 段:', tokenView.text, '| 悬停行数', tokenView.rows.length);

console.log('\nHOVER BUBBLE CHECKS PASSED');
