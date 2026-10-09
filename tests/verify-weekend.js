/**
 * 验证「午夜不再是闹钟点」之后，工作日 / 周末的切换判断仍然正确。
 * 场景：闹钟醒来后重新判定的结果，必须与真实峰谷规则一致
 *       （工作日 9-12、14-18 高峰；周末整天空闲）。
 * 用法：node verify-weekend.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker, '\t\texports.__test = { isPeakTime, msToNextPeakBoundary };\n' + marker);

const fakeWindow = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout: () => 0,
	clearTimeout: () => {},
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

const reactStub = {
	createElement: () => ({}),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
	useRef: () => ({ current: null }),
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

/* 北京时间 → UTC 毫秒 */
const beijing = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const label = (ms) => {
	const at = new Date(ms + 8 * 3600 * 1000);
	const hh = String(at.getUTCHours()).padStart(2, '0');
	const mm = String(at.getUTCMinutes()).padStart(2, '0');
	return weekdays[at.getUTCDay()] + ' ' + hh + ':' + mm;
};
const phase = (ms) => (api.isPeakTime(ms) ? '高峰' : '低谷');

/* 找一个确定的周五/周六/周日作基准（当天 00:00 北京时间） */
let friday = beijing(2026, 9, 1, 0, 0);
while (new Date(friday + 8 * 3600 * 1000).getUTCDay() !== 5) friday += 86400000;
const saturday = friday + 86400000;
const sunday = saturday + 86400000;
const monday = sunday + 86400000;

/** 从 from 出发，按闹钟走一格，返回醒来时刻 */
const wake = (from) => from + api.msToNextPeakBoundary(from);

const CASES = [
	{ name: '周五收工后', from: friday + 18.5 * 3600 * 1000, tickPhase: '低谷', wakePhase: '低谷' },
	{ name: '周日收工后', from: sunday + 18.5 * 3600 * 1000, tickPhase: '低谷', wakePhase: '高峰' },
	{ name: '周日深夜', from: sunday + 23.5 * 3600 * 1000, tickPhase: '低谷', wakePhase: '高峰' },
	{ name: '周一上工前', from: monday + 8.5 * 3600 * 1000, tickPhase: '低谷', wakePhase: '高峰' },
	{ name: '周六上午', from: saturday + 9.5 * 3600 * 1000, tickPhase: '低谷', wakePhase: '低谷' }
];

let bad = 0;
CASES.forEach((item) => {
	const at = wake(item.from);
	const fromPhase = phase(item.from);
	const atPhase = phase(at);
	const ok = fromPhase === item.tickPhase && atPhase === item.wakePhase;
	if (ok !== true) bad += 1;
	console.log((ok ? '=' : '×') + ' ' + item.name + '：' + label(item.from) + '（' + fromPhase + '）'
		+ ' —闹钟→ ' + label(at) + '（' + atPhase + '）'
		+ '，等待 ' + (api.msToNextPeakBoundary(item.from) / 3600000).toFixed(1) + ' 小时');
	assert.strictEqual(fromPhase, item.tickPhase, item.name + ' 起点时段');
	assert.strictEqual(atPhase, item.wakePhase, item.name + ' 醒来时段');
});

/* 周五收工 → 周末整段都不该再出现高峰 */
assert.strictEqual(phase(friday + 18 * 3600 * 1000), '低谷', '周五 18:00 起空闲');
assert.strictEqual(phase(saturday + 10 * 3600 * 1000), '低谷', '周六上午仍空闲（周末整天空闲）');
assert.strictEqual(phase(sunday + 15 * 3600 * 1000), '低谷', '周日下午仍空闲');
assert.strictEqual(phase(monday + 9.5 * 3600 * 1000), '高峰', '周一 9:30 回到高峰');

console.log('');
console.log(bad === 0 ? 'WEEKEND CHECKS PASSED（跨周末/工作日的闹钟落点都落在正确的时段）' : bad + ' 项不符');
process.exit(bad === 0 ? 0 : 1);
