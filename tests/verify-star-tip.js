/**
 * 回归：点「GitHub 支持」后气泡不得卡住常显。
 *
 * 缺陷成因：气泡的显示条件是 `:hover` **或** `:focus-within`（见样式里那条规则）。
 * 点击按钮让**按钮**获得 DOM 焦点；跳去浏览器只让**窗口**失焦，DOM 焦点仍留在按钮上，
 * 于是 `:focus-within` 一直为真 —— 用户关掉浏览器回来时气泡常显，直到点别处才消失。
 *
 * 修法：点击处理里先 `blur()` 掉按钮，再 `window.open`。这样气泡只跟鼠标悬停走。
 *
 * 用法：node tests/verify-star-tip.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker, '\t\texports.__test = { SettingsSection, setUpdateState };\n' + marker);

/* ------------------------------------------------------------------ 替身 */
function makeElement(type, props, ...children) {
	return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) };
}
const hookSlots = [];
let hookIndex = 0;

const opened = [];
const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; },
		open: (url, target, features) => { opened.push({ url, target, features }); return null; }
	},
	document: { querySelectorAll: () => [], createElement: () => ({ innerHTML: '', dataset: {}, appendChild() {}, querySelector: () => null, remove() {} }), body: {}, head: { appendChild() {} } },
	MutationObserver: class { observe() {} disconnect() {} },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
let captured = null;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') {
		return {
			createElement: makeElement,
			useState: (init) => {
				const slot = hookIndex; hookIndex += 1;
				if (hookSlots[slot] === undefined) hookSlots[slot] = init;
				return [hookSlots[slot], (next) => { hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next; }];
			},
			useEffect: (fn) => fn(),
			useLayoutEffect: (fn) => fn(),
			useRef: () => {
				const slot = hookIndex; hookIndex += 1;
				if (hookSlots[slot] === undefined) hookSlots[slot] = { current: null };
				return hookSlots[slot];
			},
			useSyncExternalStore: (sub, snap) => snap(),
			useCallback: (fn) => fn,
			useMemo: (fn) => fn(),
			useId: () => 'id',
			Fragment: Symbol('Fragment')
		};
	}
	if (name === 'react-dom') throw new Error('no react-dom');
	throw new Error('unexpected require: ' + name);
}).__test;

/* ------------------------------------------------------- 找到星标按钮与其气泡 */
function render() {
	hookIndex = 0;
	return api.SettingsSection({ t: (key) => key });
}
function findByClass(node, cls, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) { node.forEach((one) => findByClass(one, cls, out)); return out }
	if (typeof node !== 'object') return out;
	if (typeof node.props?.className === 'string' && node.props.className.includes(cls)) out.push(node);
	if (node.children !== undefined) findByClass(node.children, cls, out);
	return out;
}

api.setUpdateState({ hasUpdate: false, latest: null, busy: false, note: null, reason: null });

const results = [];
const check = (label, ok) => { results.push([label, ok === true]); };

/* ① 气泡与按钮的结构还在 */
const tree = render();
const wraps = findByClass(tree, 'dsb-star-wrap');
check('找得到 GitHub 支持那个包裹层', wraps.length === 1);
const wrap = wraps[0];
const tips = findByClass(wrap, 'dsb-star-tip');
check('包裹层里有悬停气泡', tips.length === 1);
const buttons = findByClass(wrap, 'dsb-action').filter((n) => n.type === 'button');
check('包裹层里有按钮', buttons.length === 1);
const starButton = buttons[0];

/* ② 关键：点击时必须先 blur 掉自己，再打开浏览器 —— 否则 :focus-within 让气泡卡住 */
check('按钮挂着 onClick', typeof starButton.props.onClick === 'function');

let blurred = 0;
let blurBeforeOpen = null;
const fakeEvent = {
	currentTarget: {
		blur: () => {
			blurred += 1;
			/* 记录 blur 发生时是否已经打开了浏览器：blur 必须在前 */
			blurBeforeOpen = opened.length === 0;
		}
	}
};

starButton.props.onClick(fakeEvent);

check('点击时调用了 blur（让气泡不再被 :focus-within 钉住）', blurred === 1);
check('blur 发生在 window.open 之前', blurBeforeOpen === true);
check('确实打开了仓库页面', opened.length === 1 && /github\.com/.test(opened[0].url));
check('新窗口带 noopener', typeof opened[0].features === 'string' && opened[0].features.includes('noopener'));

console.log('① 气泡与按钮结构：' + (wraps.length === 1 && tips.length === 1 && buttons.length === 1 ? '正常' : '异常'));
console.log('② 点击次序：blur ×' + blurred + ' → window.open（' + (opened[0] === undefined ? '-' : opened[0].url) + '）');

/* ③ 事件对象缺失也不能崩（防御式：没有 currentTarget 时照常打开） */
opened.length = 0;
let threw = null;
try { starButton.props.onClick(undefined); } catch (error) { threw = error }
check('onClick 传 undefined 事件时不得抛错', threw === null);
check('没有事件对象时仍然打开浏览器', opened.length === 1);
console.log('③ 无事件对象时：不抛错，仍打开浏览器');

/* ④ 源码层面确认 blur 在 open 之前（防止实现被改成先 open 再 blur） */
const source = fs.readFileSync(PLUGIN, 'utf8');
const starHandler = source.slice(source.indexOf('__star'), source.indexOf('}, t("starRepo"))'));
const blurAt = starHandler.indexOf('blur(');
const openAt = starHandler.indexOf('window.open(');
check('源码里 blur 写在 window.open 之前', blurAt !== -1 && openAt !== -1 && blurAt < openAt);
console.log('④ 源码次序：blur @' + blurAt + ' < open @' + openAt);

const failed = results.filter(([, ok]) => ok !== true);
console.log('\n===== 结果 =====');
for (const [label, ok] of results) console.log((ok ? '  通过  ' : '  失败  ') + label);
if (failed.length > 0) {
	console.error('\nSTAR TIP CHECKS FAILED：' + failed.length + ' 项未通过');
	process.exit(1);
}
console.log('\nSTAR TIP CHECKS PASSED');
