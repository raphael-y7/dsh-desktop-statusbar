/**
 * 验证设置导航图标替换：只改本插件那一项，其他项不动，重复扫描不重复替换，结构异常不报错。
 * 用法：node verify-navicon.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker, '\t\texports.__test = { installNavIcon };\n' + marker);

/* ---------------------------------------------------------- 最小 DOM 替身 */
const cells = [];
function makeCell(text, withSvg) {
	const cell = {
		textContent: text,
		__replaced: null,
		querySelector(sel) {
			return sel === '.lucide-gauge' && cell.__replaced !== null ? cell.__replaced : null;
		}
	};
	cell.firstElementChild = withSvg === false
		? { tagName: 'span' }
		: { tagName: 'svg', replaceWith(node) { cell.__replaced = node; } };
	return cell;
}
const documentStub = {
	querySelectorAll: (sel) => (sel === 'nav button' ? cells : []),
	createElement: () => {
		const box = { innerHTML: '' };
		Object.defineProperty(box, 'firstElementChild', {
			get() {
				return box.innerHTML.indexOf('lucide-gauge') >= 0
					? { tagName: 'svg', className: 'lucide lucide-gauge' }
					: null;
			}
		});
		return box;
	},
	body: {}
};
let observers = 0;
class FakeObserver {
	observe() { observers += 1; }
	disconnect() { observers -= 1; }
}

let captured = null;
const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; }
	},
	document: documentStub,
	MutationObserver: FakeObserver,
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

const reactStub = {
	createElement: () => ({}),
	useState: (init) => [init, () => {}],
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

/* ------------------------------------------------------------------ 用例 */
cells.push(makeCell('通用设置', true));
cells.push(makeCell('状态栏', true));
cells.push(makeCell('桌面设置', true));

const stop = api.installNavIcon(() => '状态栏');
assert.strictEqual(cells[1].__replaced !== null, true, '状态栏那一项应被替换');
assert.strictEqual(cells[1].__replaced.className, 'lucide lucide-gauge', '应换成 gauge 图标');
assert.strictEqual(cells[0].__replaced, null, '通用设置不该被动');
assert.strictEqual(cells[2].__replaced, null, '桌面设置不该被动');
assert.strictEqual(observers, 1, '应挂上一个 DOM 观察者');

const first = cells[1].__replaced;
const stop2 = api.installNavIcon(() => '状态栏');
assert.strictEqual(cells[1].__replaced, first, '已经换过的不重复替换');
stop2();
assert.strictEqual(observers, 1, '关掉第二个观察者后仍剩一个');

cells.length = 0;
cells.push(makeCell('状态栏', false));
const stop3 = api.installNavIcon(() => '状态栏');
assert.strictEqual(cells[0].__replaced, null, '没有前导 svg 时保持原样且不报错');
stop3();

cells.length = 0;
cells.push(makeCell('状态栏', true));
const stop4 = api.installNavIcon(() => '');
assert.strictEqual(cells[0].__replaced, null, '标签为空时不做任何事');
stop4();
stop();
assert.strictEqual(observers, 0, '全部卸载后没有观察者');

console.log('导航图标：匹配替换 / 不越界 / 幂等 / 异常安全 全部通过');
