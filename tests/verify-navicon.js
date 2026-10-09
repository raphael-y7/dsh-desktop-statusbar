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
code = code.replace(marker, '\t\texports.__test = { installNavIcon, startPluginUpdate, snapshotUpdate, setUpdateState, setCtx: (c) => { pluginCtx = c; } };\n' + marker);

/* ---------------------------------------------------------- 最小 DOM 替身 */
const cells = [];
function makeCell(text, withSvg) {
	const attrs = {};
	const kids = [];
	const cell = {
		textContent: text,
		__replaced: null,
		__kids: kids,
		getAttribute(name) { return attrs[name] === undefined ? null : attrs[name]; },
		setAttribute(name, value) { attrs[name] = String(value); },
		/* 真 DOM 里子元素的文字会算进 textContent —— 胶囊挂上去后文案就不再等于标签，
		   替身必须照这个行为来，否则测不出「靠标记而不是靠文案认这一项」这件事 */
		appendChild(node) {
			kids.push(node);
			node.remove = () => {
				const at = kids.indexOf(node);
				if (at >= 0) kids.splice(at, 1);
				cell.textContent = text + kids.reduce((acc, one) => acc + String(one.textContent), '');
			};
			cell.textContent += String(node.textContent);
			return node;
		},
		querySelector(sel) {
			if (sel === '.lucide-gauge') return cell.__replaced !== null ? cell.__replaced : null;
			if (sel === '.dsb-nav-pill') return kids.filter((one) => one.className === 'dsb-nav-pill')[0] || null;
			return null;
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
		const box = { innerHTML: '', className: '', textContent: '' };
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

/* 「发现新版本」胶囊：默认隐藏，自检到 registry 上有新版才挂；只挂本插件那一项、重复扫描不重复挂 */
const pillCount = (cell) => cell.__kids.filter((one) => one.className === 'dsb-nav-pill').length;
/* 自检走 fetch → 两层 then，等一个宏任务让整条链落地 */
const settle = () => new Promise((resolve) => setImmediate(resolve));
let lastUrl = null;
const feedVersion = (hasUpdate) => {
	sandbox.window.fetch = (url) => {
		lastUrl = String(url);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ hasUpdate }) });
	};
};

(async () => {
	/* ① registry 上没有新版：胶囊不出现 */
	feedVersion(false);
	cells.length = 0;
	const quiet = makeCell('状态栏', true);
	cells.push(makeCell('通用设置', true), quiet, makeCell('桌面设置', true));
	const stopQuiet = api.installNavIcon(() => '状态栏', () => '发现新版本');
	assert.strictEqual(pillCount(quiet), 0, '自检结果回来前先按「没有新版」处理，不挂胶囊');
	await settle();
	assert.strictEqual(pillCount(quiet), 0, '确认没有新版后依然不挂');
	assert.strictEqual(quiet.__replaced !== null, true, '不挂胶囊不影响换图标');
	stopQuiet();
	assert.strictEqual(observers, 0, '第一个胶囊用例的观察者已卸载');

	/* ② registry 上有新版：胶囊挂上，文案 / 幂等 / 靠标记认项都照旧 */
	feedVersion(true);
	cells.length = 0;
	const ours = makeCell('状态栏', true);
	cells.push(makeCell('通用设置', true), ours, makeCell('桌面设置', true));
	const stopPill = api.installNavIcon(() => '状态栏', () => '发现新版本');
	await settle();
	assert.strictEqual(pillCount(ours), 1, '自检到新版后挂上胶囊');
	/* 宿主按 ?current= 比大小：不带这个参数它就没版本可比，会当成「没有新版」，胶囊永远不出现 */
	const asked = lastUrl === null ? null : lastUrl.match(/[?&]current=([^&]*)/);
	assert.ok(asked !== null && asked[1].length > 0, '自检请求必须带上本地版本号');
	assert.strictEqual(ours.__kids[0].textContent, '发现新版本', '胶囊文案');
	assert.strictEqual(pillCount(cells[0]) + pillCount(cells[2]), 0, '其它导航项不挂胶囊');
	assert.strictEqual(ours.__replaced !== null, true, '挂胶囊不影响换图标');
	assert.strictEqual(ours.textContent, '状态栏发现新版本', '胶囊文字算进单元格文案（替身按真 DOM 行为来）');

	const stopPill2 = api.installNavIcon(() => '状态栏', () => '有新版本啦');
	assert.strictEqual(ours.__kids[0].textContent, '有新版本啦', '换文案（切语言）时胶囊跟着改 —— 靠标记才认得这一项');
	assert.strictEqual(pillCount(ours), 1, '重复扫描不重复挂胶囊');
	assert.strictEqual(ours.__replaced !== null, true, '文案已被胶囊污染，第二次扫描仍靠标记认得这一项');
	stopPill2();
	stopPill();
	assert.strictEqual(observers, 0, '胶囊用例的观察者也已卸载');

	/* ③ 一键更新：调 DSH 官方的安装接口，点名要装的版本并带上 requestId */
	const installs = [];
	api.setCtx({ remote: { pluginManager: {
		installBundle: (spec, options) => { installs.push({ spec, options }); return Promise.resolve({ ok: true }); }
	} } });
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	assert.strictEqual(api.snapshotUpdate().busy, true, '点下去先进忙碌态（按钮要禁用）');
	await settle();
	assert.strictEqual(installs.length, 1, '调了一次安装');
	assert.strictEqual(installs[0].spec, 'dsh-desktop-statusbar@9.9.9', '装的是自检发现的那个版本');
	assert.ok(typeof installs[0].options.requestId === 'string' && installs[0].options.requestId.length > 0, '带上 requestId');
	assert.strictEqual(api.snapshotUpdate().note, 'done', '成功后给完成提示');
	assert.strictEqual(api.snapshotUpdate().busy, false, '忙碌态解除');

	/* ④ 安装失败：把原因带出来，不能静默 */
	api.setCtx({ remote: { pluginManager: {
		installBundle: () => Promise.resolve({ ok: false, reason: 'network' })
	} } });
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	await settle();
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '失败要有提示');
	assert.strictEqual(api.snapshotUpdate().reason, 'network', '失败原因要带出来');

	/* ⑤ 取不到插件管理器：按失败处理，不抛错、不卡住（官方桌面端一定带管理器，这只是兜底） */
	api.setCtx({});
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '取不到安装器也算失败');
	assert.strictEqual(api.snapshotUpdate().busy, false, '不该卡在忙碌态');
})().then(() => {
	console.log('导航图标：匹配替换 / 不越界 / 幂等 / 异常安全 / 胶囊按自检结果显隐 / 更新按钮接线 全部通过');
}).catch((error) => {
	console.error('导航图标：失败 ——', error && error.message ? error.message : error);
	process.exitCode = 1;
});
