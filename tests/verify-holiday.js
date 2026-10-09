/**
 * 验证官方 2026-09-19 峰谷时间说明后的节假日判定：
 * 中国法定节假日、周末全天按空闲价，调休上班的周末也按空闲价，
 * 高峰只落在"工作日且放假日历里没有放假"的 9:00-12:00、14:00-18:00。
 * 用法：node verify-holiday.js
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

/** [说明, 北京时间, 期望时段] */
const CASES = [
	['中秋当天（周五，放假）', beijing(2026, 9, 25, 10, 0), '低谷'],
	['中秋前一天（周四）', beijing(2026, 9, 24, 10, 0), '高峰'],
	['中秋后第一个工作日（周一）', beijing(2026, 9, 28, 10, 0), '高峰'],
	['调休上班（周日）', beijing(2026, 9, 20, 10, 0), '低谷'],
	['调休上班（周六）', beijing(2026, 10, 10, 10, 0), '低谷'],
	['国庆首日（周四，放假）', beijing(2026, 10, 1, 10, 0), '低谷'],
	['国庆中的周一', beijing(2026, 10, 5, 15, 0), '低谷'],
	['国庆末日（周三）', beijing(2026, 10, 7, 9, 30), '低谷'],
	['国庆后第一个工作日（周四）', beijing(2026, 10, 8, 9, 30), '高峰'],
	['元旦当天（周四）', beijing(2026, 1, 1, 9, 30), '低谷'],
	['元旦放假次日（周五）', beijing(2026, 1, 2, 9, 30), '低谷'],
	['元旦后第一个工作日（周一）', beijing(2026, 1, 5, 9, 30), '高峰'],
	['春节最后一天（周一）', beijing(2026, 2, 23, 9, 30), '低谷'],
	['春节后第一个工作日（周二）', beijing(2026, 2, 24, 9, 30), '高峰'],
	['清明补休（周一）', beijing(2026, 4, 6, 15, 0), '低谷'],
	['劳动节当天（周五）', beijing(2026, 5, 1, 10, 0), '低谷'],
	['劳动节中的周二', beijing(2026, 5, 5, 15, 0), '低谷'],
	['端午当天（周五）', beijing(2026, 6, 19, 10, 0), '低谷'],
	['普通周三上午', beijing(2026, 7, 15, 10, 0), '高峰'],
	['普通周三午休', beijing(2026, 7, 15, 12, 30), '低谷'],
	['普通周三下午', beijing(2026, 7, 15, 14, 0), '高峰'],
	['普通周三 18:00 收工', beijing(2026, 7, 15, 18, 0), '低谷']
];

let bad = 0;
CASES.forEach((item) => {
	const got = phase(item[1]);
	const ok = got === item[2];
	if (ok !== true) bad += 1;
	console.log((ok ? '=' : '×') + ' ' + item[0] + '：' + label(item[1]) + ' → ' + got + '（期望 ' + item[2] + '）');
	assert.strictEqual(got, item[2], item[0] + ' ' + label(item[1]));
});

/* 假期里醒来重新判定：闹钟仍按北京时间 9/12/14/18 走，醒来后的时段必须与真实规则一致 */
const wake = (from) => from + api.msToNextPeakBoundary(from);
const holidayNight = beijing(2026, 10, 7, 20, 0);
const wokeAt = wake(holidayNight);
const wokePhase = phase(wokeAt);
console.log('');
console.log('= 国庆最后一晚 ' + label(holidayNight) + '（' + phase(holidayNight) + '）—闹钟→ ' + label(wokeAt) + '（' + wokePhase + '）');
assert.strictEqual(wokePhase, '高峰', '假期结束后第一个工作日 9:00 必须回到高峰');

const holidayNoon = beijing(2026, 10, 5, 13, 0);
const wokeNoon = wake(holidayNoon);
console.log('= 假期中 ' + label(holidayNoon) + '（' + phase(holidayNoon) + '）—闹钟→ ' + label(wokeNoon) + '（' + phase(wokeNoon) + '）');
assert.strictEqual(phase(wokeNoon), '低谷', '假期中的 14:00 仍是空闲');

/* 未收录的年份只按星期几判断（2027 年放假安排公布后需要往 HOLIDAYS 里补） */
assert.strictEqual(phase(beijing(2027, 1, 1, 10, 0)), '高峰', '未收录年份回退到按星期几判断');

console.log('');
console.log(bad === 0 ? 'HOLIDAY CHECKS PASSED（法定节假日与调休日的计费时段都正确）' : bad + ' 项不符');
process.exit(bad === 0 ? 0 : 1);
