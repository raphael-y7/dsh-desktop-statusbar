/**
 * 平台「适用模型」可输入筛选下拉回归测试（fix-3.0.6）。
 * 用法：node tests/verify-modelrow-scroll.js
 *
 * 口径（用户最新要求）：
 *   A. 滚动语义（锁定项，不得退化）：
 *      ① .dsb-modelrow-menu 内部 wheel/touchmove/scroll 不关闭菜单，也不阻止自身滚动；
 *      ② 输入框上的 wheel 改滚候选菜单 scrollTop 并 preventDefault/stopPropagation；
 *      ③ 只有落在设置区（.dsb-settings 内部或其真实滚动祖先）的 scroll/wheel/touchmove 才关闭；
 *         背景对话区自身程序滚动/滚轮不关闭；关闭后 input 仍聚焦时 click 可重开；
 *      ④ 菜单内 wheel/touchmove stopPropagation，不向 document 冒泡。
 *   B. 可输入筛选：原生 text input + 可访问名；清空输入恢复全部候选；
 *      按显示名或原始名大小写无关包含匹配；无匹配时不渲染 listbox，aria-expanded=false。
 *   C. 键盘不参与选择：ArrowUp/Down 不改变选择、Enter 不选中 option、无灰色键盘活动项；
 *      仅保留 Escape 关闭并恢复已选显示；鼠标点击仍可选。
 *   D. 布局：菜单 portal 到 body + fixed 坐标；最多 3 项完整高度；始终锚定输入框下方；
 *      空间不足时按下方实际可用空间限高，右侧越界夹紧，菜单内部滚动。
 *
 * 做法：用最小 React 替身加载真实 client.js，按真实 hook 顺序跑 SettingsSection；
 *       在 effect 真正挂载后模拟 window 捕获事件与菜单节点事件。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { findAll, hasClass, textOf, makeFakeDocument, runPlugin } = require('./helpers/client-harness');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const clientSource = fs.readFileSync(PLUGIN, 'utf8');

/* 气泡尺寸/滚动/portal 锁定项，防止改动时丢失 */
assert.ok(clientSource.includes('max-height:calc(3 * 30px + 8px);overflow-y:auto'),
	'.dsb-modelrow-menu 仍应保留 max-height 3 行 + overflow-y:auto');
assert.ok(clientSource.includes('overscroll-behavior:contain'),
	'.dsb-modelrow-menu 仍应保留 overscroll-behavior:contain');
assert.ok(clientSource.includes('createPortal(menuNode, portalTarget)'),
	'菜单应 portal 到 body（portalTarget）');
assert.ok(clientSource.includes('z-index:1100;max-width:100%;max-height:calc(3 * 30px + 8px)'),
	'.dsb-modelrow-menu 应提升到既有 body 浮层 z-index:1100');
assert.ok(clientSource.includes('position: "fixed"'),
	'菜单应使用 fixed 定位（脱离设置卡片 overflow 裁切）');
/* 撤销灰色键盘活动项：源码里不应再有该 class */
assert.ok(!clientSource.includes('dsb-select-item-active'),
	'灰色键盘活动项（dsb-select-item-active）应已撤销');
/* 模型输入框复用 dsb-select-btn，窄断言其显示文本光标 */
assert.ok(clientSource.includes('.dsb-modelrow-select .dsb-select-btn{cursor:text}'),
	'.dsb-modelrow-select .dsb-select-btn 应设 cursor:text（模型输入框显示文本光标）');

const marker = '\t\texports.apply = apply;';
assert.ok(clientSource.includes(marker), 'exports.apply marker not found');
const code = clientSource.replace(marker,
	'\t\texports.__test = { zh: zh, SettingsSection: SettingsSection, setConfig: setConfig };\n' + marker);

const price = (a) => ({ tiered: true, currency: 'CNY', peak: { input: a, cacheRead: 0.04, cacheWrite: 0, output: a * 4 }, offPeak: { input: a / 2, cacheRead: 0.02, cacheWrite: 0, output: a * 2 } });
const CONFIG = {
	models: {
		'deepseek-flash': price(2),
		/* 用于筛选：只有 claude 含 c（原始名与显示名都含）；gpt / gemini / qwen 不含 c */
		'claude-opus-test': price(1),
		'gpt-4o-mini-test': price(1),
		'gemini-test': price(1),
		'qwen-max-test': price(1)
	},
	modelOrder: ['deepseek-flash', 'claude-opus-test', 'gpt-4o-mini-test', 'gemini-test', 'qwen-max-test'],
	priceConfigured: true,
	relayPlatforms: {
		'relay-a': {
			endpoint: '', tokenHeader: 'authorization', userIdHeader: '', balancePath: '',
			currency: '', balanceDivisor: null,
			models: [{ model: 'deepseek-flash', feeMultiplier: 1 }]
		}
	}
};

/* 当前 harness 的 DOM 关系替身：focusEvent 在构造锚点时读取（各测试块顺序使用，不交叉）。 */
let ACTIVE_DOM = null;

/* ------------------------------------------------------------------ 最小替身 */
function makeHarness(options) {
	options = options || {};
	const store = new Map();
	const windowListeners = [];
	let menuSeq = 0;
	let menuRefSlot = null;

	const fakeWindow = {
		localStorage: {
			getItem: (key) => (store.has(key) ? store.get(key) : null),
			setItem: (key, value) => { store.set(key, value); },
			removeItem: (key) => { store.delete(key); }
		},
		innerWidth: 1200, innerHeight: 900,
		setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
		requestAnimationFrame: (fn) => { fn(); return 0; },
		cancelAnimationFrame: () => {},
		addEventListener: (type, fn, options) => {
			const capture = options === true || (options !== null && options !== undefined && options.capture === true);
			windowListeners.push({ type: type, fn: fn, capture: capture });
		},
		removeEventListener: (type, fn, options) => {
			const capture = options === true || (options !== null && options !== undefined && options.capture === true);
			for (let at = windowListeners.length - 1; at >= 0; at -= 1) {
				if (windowListeners[at].type === type && windowListeners[at].fn === fn && windowListeners[at].capture === capture) {
					windowListeners.splice(at, 1);
				}
			}
		},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) })
	};

	const { document: fakeDocument, docClicks } = makeFakeDocument();
	const portalCalls = [];
	const reactDom = options.portal === true ? {
		createPortal: (node, target) => {
			portalCalls.push({ node: node, target: target });
			return { type: '__portal', props: { target: target }, children: [node] };
		}
	} : null;

	/* 菜单 DOM 替身：effect 会在打开菜单的那一帧把它挂到 platformModelMenuRef 上 */
	const makeMenuNode = () => {
		menuSeq += 1;
		const listeners = [];
		return {
			__menuId: menuSeq,
			style: {},
			scrollTop: 0,
			scrollHeight: 200,
			clientHeight: 100,
			listeners: listeners,
			contains: (target) => target !== null && target !== undefined && target.__insideModelMenu === true,
			addEventListener: (type, fn) => { listeners.push({ type: type, fn: fn }); },
			removeEventListener: (type, fn) => {
				for (let at = listeners.length - 1; at >= 0; at -= 1) {
					if (listeners[at].type === type && listeners[at].fn === fn) listeners.splice(at, 1);
				}
			}
		};
	};

	/* React 替身：hook 下标与真实渲染顺序一致；effect 按依赖变化在渲染后执行，并保留 cleanup */
	const values = [];
	const refs = [];
	const effects = [];
	let hookIndex = 0;
	let layoutQueue = [];
	let effectQueue = [];

	const reactStub = {
		createElement: (type, props, ...children) => {
			const node = {
				type: type,
				props: props === null || props === undefined ? {} : props,
				children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
			};
			const ref = node.props.ref;
			if (ref !== null && ref !== undefined && typeof ref === 'object'
				&& typeof node.props.className === 'string' && node.props.className.split(' ').indexOf('dsb-modelrow-menu') !== -1) {
				menuRefSlot = ref;
				ref.current = makeMenuNode();
			}
			return node;
		},
		useState: (init) => {
			const at = hookIndex;
			hookIndex += 1;
			if (!(at in values)) values[at] = typeof init === 'function' ? init() : init;
			return [values[at], (next) => { values[at] = typeof next === 'function' ? next(values[at]) : next; }];
		},
		useEffect: (fn, deps) => {
			if (typeof fn !== 'function') return;
			const at = hookIndex;
			hookIndex += 1;
			const prev = effects[at];
			const same = Array.isArray(deps) === true && prev !== undefined && Array.isArray(prev.deps) === true
				&& deps.length === prev.deps.length && deps.every((one, i) => one === prev.deps[i]);
			if (same) return;
			effectQueue.push({ at: at, fn: fn, deps: Array.isArray(deps) ? deps.slice() : undefined });
		},
		useLayoutEffect: (fn, deps) => {
			if (typeof fn !== 'function') return;
			const at = hookIndex;
			hookIndex += 1;
			const prev = effects[at];
			const same = Array.isArray(deps) === true && prev !== undefined && Array.isArray(prev.deps) === true
				&& deps.length === prev.deps.length && deps.every((one, i) => one === prev.deps[i]);
			if (same) return;
			layoutQueue.push({ at: at, fn: fn, deps: Array.isArray(deps) ? deps.slice() : undefined });
		},
		useRef: (init) => {
			const at = hookIndex;
			hookIndex += 1;
			if (refs[at] === undefined) refs[at] = { current: init === undefined ? null : init };
			return refs[at];
		},
		useMemo: (fn) => { hookIndex += 1; return fn(); },
		useCallback: (fn) => { hookIndex += 1; return fn; },
		useSyncExternalStore: (subscribe, snapshot) => { hookIndex += 1; return snapshot(); },
		Fragment: Symbol('Fragment')
	};

	const flushQueue = (queue) => {
		queue.forEach((item) => {
			const prev = effects[item.at];
			if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup();
			const cleanup = item.fn();
			effects[item.at] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
		});
	};

	const api = runPlugin(code, reactStub, fakeWindow, fakeDocument, reactDom);

	/* 最小 DOM 关系：输入框、设置区内部滚动、包住设置 root 的真实滚动祖先、对话区背景 */
	const dom = {
		inputNode: { __modelInput: true },
		settingsPop: { rect: { left: 0, top: 0 }, getBoundingClientRect() { return this.rect; } },
		settingsInner: { __settingsInner: true },
		conversation: { __conversation: true },
		settingsScroller: { scrollHeight: 1200, clientHeight: 600, scrollTop: 0 }
	};
	dom.settingsRoot = {
		parentElement: dom.settingsScroller,
		contains: (node) => node === dom.settingsInner || node === dom.inputNode
	};
	ACTIVE_DOM = dom;
	api.setConfig(CONFIG);

	const translator = (key, params) => {
		let out = api.zh[key] === undefined ? key : api.zh[key];
		if (params !== undefined && params !== null) {
			out = out.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}
		return out;
	};
	const t = translator;

	const render = () => {
		/* React 在菜单卸载时会把 ref.current 清空；同步这个关键语义，避免 no-match wheel 误用旧菜单。 */
		if (menuRefSlot !== null) menuRefSlot.current = null;
		hookIndex = 0;
		layoutQueue = [];
		effectQueue = [];
		const tree = api.SettingsSection({ t: t, useProjection: () => undefined });
		flushQueue(layoutQueue);
		flushQueue(effectQueue);
		return tree;
	};

	const dispatchWindow = (type, target, extra) => {
		const event = Object.assign({ type: type, target: target }, extra || {});
		windowListeners.filter((one) => one.type === type && one.capture === true).forEach((one) => one.fn(event));
		windowListeners.filter((one) => one.type === type && one.capture !== true).forEach((one) => one.fn(event));
	};

	return {
		api: api, t: t, render: render, dispatchWindow: dispatchWindow, window: fakeWindow,
		windowListenerCount: (type) => windowListeners.filter((one) => one.type === type).length,
		docClickCount: () => docClicks.length,
		portalCalls: portalCalls, document: fakeDocument,
		dom: dom
	};
}

const RECT_DEFAULT = { left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 };
const focusEvent = (rowNode, rect) => {
	const r = rect === undefined ? RECT_DEFAULT : rect;
	const dom = ACTIVE_DOM || {};
	const target = Object.assign({}, rowNode, { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => r });
	const anchor = {
		getBoundingClientRect: () => r,
		closest: (sel) => (sel === '.dsb-model' ? target : (sel === '.dsb-edit-pop' ? (dom.settingsPop || null) : (sel === '.dsb-settings' ? (dom.settingsRoot || null) : null))),
		contains: (node) => dom.inputNode !== undefined && node === dom.inputNode
	};
	return { type: 'focus', target: { select: () => { throw new Error('适用模型输入聚焦时不得自动选择文本'); } }, stopPropagation: () => {}, currentTarget: { closest: (sel) => (sel === '.dsb-select' ? anchor : null) } };
};
/* 输入/键盘事件：currentTarget 与 focus 一致，target 带 value */
const inputEvent = (rowNode, value) => {
	const ev = focusEvent(rowNode);
	ev.target = { value: value, select: () => {} };
	return ev;
};

/* 平台区块 / 行 / 输入 / 菜单 取节点 */
const sectionOf = (tree) => findAll(tree, (node) => hasClass(node, 'dsb-section') && node.props.key === '__platforms')[0];
const platformRowOf = (tree) => findAll(sectionOf(tree), (node) => hasClass(node, 'dsb-model') && node.props.key === 'relay-a')[0];
const rowsOf = (tree) => findAll(platformRowOf(tree), (node) => hasClass(node, 'dsb-modelrow'));
const inputOfRow = (row) => findAll(row, (node) => node.type === 'input' && hasClass(node, 'dsb-select-btn'))[0];
const menuOf = (tree) => findAll(tree, (node) => hasClass(node, 'dsb-modelrow-menu'))[0];
const itemsOf = (menu) => findAll(menu, (node) => node.type === 'button' && hasClass(node, 'dsb-select-item'));
const headOf = (tree) => findAll(platformRowOf(tree), (node) => hasClass(node, 'dsb-platform-head'))[0];

function openPlatformEdit(h) {
	let tree = h.render();
	headOf(tree).props.onClick();
	tree = h.render();
	assert.ok(findAll(platformRowOf(tree), (node) => hasClass(node, 'dsb-platform-pop')).length === 1, '前置：平台编辑区已展开');
	return tree;
}

/* ============================================================ A. 滚动语义（锁定项） */
console.log('===== A. 平台「适用模型」下拉：内部滚动不关闭 / 外部滚动仍关闭 =====');
{
	const h = makeHarness();
	let tree = openPlatformEdit(h);
	const row = () => platformRowOf(tree);
	const input = () => inputOfRow(rowsOf(tree)[0]);
	const openMenu = () => {
		input().props.onClick(focusEvent(row()));
		tree = h.render();
		assert.ok(menuOf(tree) !== undefined, '点击关闭态适用模型输入框应打开候选气泡');
	};

	openMenu();
	const menuEl = menuOf(tree).props.ref.current;
	assert.ok(menuEl !== null && menuEl !== undefined, '菜单 ref 应指向菜单节点');
	assert.ok(h.windowListenerCount('wheel') >= 1 && h.windowListenerCount('touchmove') >= 1 && h.windowListenerCount('scroll') >= 1,
		'打开菜单后应注册 window 的 scroll/wheel/touchmove 监听');

	/* ① 菜单内部：wheel / touchmove / scroll 都不关闭 */
	const inside = { __insideModelMenu: true };
	h.dispatchWindow('wheel', inside); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '菜单内 wheel 不应关闭菜单');
	h.dispatchWindow('touchmove', inside); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '菜单内 touchmove 不应关闭菜单');
	h.dispatchWindow('scroll', inside); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '菜单内 scroll 不应关闭菜单');

	/* 菜单节点自身拦截 wheel / touchmove 冒泡，且不 preventDefault */
	let stopped = 0; let prevented = 0;
	const menuWheelEvent = { target: inside, stopPropagation: () => { stopped += 1; }, preventDefault: () => { prevented += 1; } };
	menuEl.listeners.filter((one) => one.type === 'wheel').forEach((one) => one.fn(menuWheelEvent));
	assert.strictEqual(stopped, 1, '菜单内 wheel 应 stopPropagation（不冒泡到外层关闭逻辑）');
	assert.strictEqual(prevented, 0, '菜单内 wheel 不得 preventDefault（自身滚动照常）');
	menuEl.listeners.filter((one) => one.type === 'touchmove').forEach((one) => one.fn({ target: inside, stopPropagation: () => { stopped += 1; } }));
	assert.strictEqual(stopped, 2, '菜单内 touchmove 应 stopPropagation');

	/* ② 菜单外部 wheel 立即关闭 */
	h.dispatchWindow('wheel', h.dom.settingsScroller); tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '菜单外 wheel 仍应立即关闭菜单');

	/* ③ 菜单外部 scroll（平台列表 / 页面）立即关闭 */
	openMenu();
	h.dispatchWindow('scroll', h.dom.settingsInner); tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '菜单外 scroll（内部平台列表）仍应立即关闭菜单');
	openMenu();
	h.dispatchWindow('scroll', h.dom.settingsScroller); tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '菜单外 scroll（页面）仍应立即关闭菜单');

	/* ④ 外部 touchmove 仍关闭 */
	openMenu();
	h.dispatchWindow('touchmove', h.dom.settingsInner); tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '菜单外 touchmove 仍应立即关闭菜单');

	/* ⑤ 输入框滚轮：把 deltaY 滚到菜单 scrollTop，preventDefault + stopPropagation，菜单保持打开 */
	openMenu();
	const curMenu = menuOf(tree).props.ref.current;
	curMenu.scrollTop = 0;
	curMenu.scrollHeight = 200;
	curMenu.clientHeight = 100;
	let wheelPrevented = 0; let wheelStopped = 0;
	h.dispatchWindow('wheel', h.dom.inputNode, {
		deltaY: 64,
		preventDefault: () => { wheelPrevented += 1; },
		stopPropagation: () => { wheelStopped += 1; }
	});
	tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '输入框内 wheel 不应关闭菜单');
	assert.strictEqual(curMenu.scrollTop, 64, '输入框内 wheel 应把 deltaY 滚到菜单 scrollTop');
	assert.strictEqual(wheelPrevented, 1, '输入框内 wheel 应 preventDefault（不把滚轮传给背景页/对话区）');
	assert.ok(wheelStopped >= 1, '输入框内 wheel 应 stopPropagation');

	/* ⑥ DSH 背景对话区的程序滚动 / 滚轮不关闭菜单 */
	h.dispatchWindow('scroll', h.dom.conversation); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '背景对话区自动滚动 scroll 不应关闭菜单');
	h.dispatchWindow('wheel', h.dom.conversation); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '背景对话区 wheel 不应关闭菜单');
	h.dispatchWindow('touchmove', h.dom.conversation); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '背景对话区 touchmove 不应关闭菜单');

	/* ⑦ 关闭后 input 仍聚焦：再次 click 应重新打开气泡（不依赖 focus） */
	h.dispatchWindow('scroll', h.dom.settingsInner); tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '前置：设置区滚动已关闭菜单');
	input().props.onClick(focusEvent(row())); tree = h.render();
	assert.ok(menuOf(tree) !== undefined, '菜单关闭且 input 仍聚焦时，点击 input 应重新打开气泡');

	/* ⑧ 选项点击仍正常：打开 → 点选项 → 选中并收起 */
	openMenu();
	const item = itemsOf(menuOf(tree)).filter((node) => node.props.key === 'deepseek-flash')[0];
	assert.ok(item !== undefined, '菜单里应有 deepseek-flash 选项');
	item.props.onClick({ stopPropagation: () => {} });
	tree = h.render();
	assert.strictEqual(menuOf(tree), undefined, '点选项后菜单收起');
	assert.strictEqual(input().props['aria-expanded'], 'false', '选项点击后输入框回到收起态');

	console.log('      内部滚动不关闭；输入框 wheel 滚候选并阻止背景；设置滚动关闭；背景对话滚动放行；关闭后 click 重开；选项点击正常');
}

/* ============================================================ A-1. dirty filter 提交 / no-match wheel 放行 / 边界放行 */
console.log('===== A-1. dirty filter 提交；无菜单与滚动边界 wheel 放行 =====');
{
	/* 设置区 scroll 关闭菜单时，dirty filter 必须写回模型行，不能恢复旧值。 */
	{
		const h = makeHarness();
		let tree = openPlatformEdit(h);
		const row = () => platformRowOf(tree);
		const input = () => inputOfRow(rowsOf(tree)[0]);
		input().props.onClick(focusEvent(row())); tree = h.render();
		input().props.onChange(inputEvent(row(), 'claude')); tree = h.render();
		h.dispatchWindow('scroll', h.dom.settingsInner); tree = h.render();
		assert.strictEqual(menuOf(tree), undefined, '设置区 scroll 应关闭菜单');
		assert.strictEqual(input().props.value, 'Claude', '设置区 scroll 关闭菜单时必须提交 dirty filter');
	}

	/* 无匹配时没有真实 menu：wheel 不得 prevent/stop，且关闭后保留筛选文本。 */
	{
		const h = makeHarness();
		let tree = openPlatformEdit(h);
		const row = () => platformRowOf(tree);
		const input = () => inputOfRow(rowsOf(tree)[0]);
		input().props.onClick(focusEvent(row())); tree = h.render();
		input().props.onChange(inputEvent(row(), 'zzz')); tree = h.render();
		assert.strictEqual(menuOf(tree), undefined, '无匹配时不应存在真实 menu');
		let prevented = 0; let stopped = 0;
		h.dispatchWindow('wheel', h.dom.inputNode, { deltaY: 20, preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
		tree = h.render();
		assert.strictEqual(prevented, 0, '无匹配 wheel 不得 preventDefault，应让设置滚动继续');
		assert.strictEqual(stopped, 0, '无匹配 wheel 不得 stopPropagation，应让设置滚动继续');
		assert.strictEqual(input().props.value, 'Zzz', '无匹配 wheel 关闭后必须保留筛选文本');
	}

	/* 真实 menu 在顶部向上、底部向下都不能再滚时，wheel 放行给设置区。 */
	{
		const h = makeHarness();
		let tree = openPlatformEdit(h);
		const row = () => platformRowOf(tree);
		const input = () => inputOfRow(rowsOf(tree)[0]);
		const open = () => { input().props.onClick(focusEvent(row())); tree = h.render(); assert.ok(menuOf(tree) !== undefined, '边界场景 menu 应打开'); };
		open();
		input().props.onChange(inputEvent(row(), 'c')); tree = h.render();
		let menu = menuOf(tree).props.ref.current;
		menu.scrollHeight = 300; menu.clientHeight = 100; menu.scrollTop = 0;
		let prevented = 0; let stopped = 0;
		h.dispatchWindow('wheel', h.dom.inputNode, { deltaY: -20, preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
		tree = h.render();
		assert.strictEqual(prevented, 0, '顶部向上 boundary wheel 不得 preventDefault');
		assert.strictEqual(stopped, 0, '顶部向上 boundary wheel 不得 stopPropagation');
		assert.strictEqual(input().props.value, 'C', '顶部 boundary 关闭后保留 dirty filter');
		open();
		menu = menuOf(tree).props.ref.current;
		menu.scrollHeight = 300; menu.clientHeight = 100; menu.scrollTop = 200;
		prevented = 0; stopped = 0;
		h.dispatchWindow('wheel', h.dom.inputNode, { deltaY: 20, preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
		tree = h.render();
		assert.strictEqual(prevented, 0, '底部向下 boundary wheel 不得 preventDefault');
		assert.strictEqual(stopped, 0, '底部向下 boundary wheel 不得 stopPropagation');
		assert.strictEqual(input().props.value, 'C', '底部 boundary 关闭后保留筛选文本');
	}

	console.log('      dirty filter 随 scroll 提交；no-match wheel 与上下边界 wheel 放行并保留文本');
}

/* ============================================================ B. 可输入筛选 + 清空恢复 + 无匹配空白 */
console.log('===== B. 模型输入控件：原生输入 + 包含匹配 + 清空恢复 + 无匹配空白 =====');
{
	const h = makeHarness();
	const t = h.t;
	let tree = openPlatformEdit(h);
	const row = () => platformRowOf(tree);
	const input = () => inputOfRow(rowsOf(tree)[0]);
	const menu = () => menuOf(tree);
	const itemKeys = () => itemsOf(menu()).map((node) => node.props.key);

	/* 原生输入 + 可访问名 + combobox/aria */
	const first = input();
	assert.strictEqual(first.type, 'input', '适用模型应是原生 text input');
	assert.strictEqual(first.props.type, 'text', 'input type 应为 text');
	assert.strictEqual(first.props.role, 'combobox', 'input 角色应为 combobox');
	assert.strictEqual(first.props['aria-label'], t('platformModels'), 'input 应有可访问名（适用模型）');
	assert.strictEqual(first.props['aria-expanded'], 'false', '未打开时 aria-expanded=false');
	assert.ok(typeof first.props['aria-controls'] === 'string' && first.props['aria-controls'].length > 0, '应有 aria-controls 指向 listbox');
	assert.strictEqual(first.props.value, 'DeepSeek-Flash', '收起态保留当前值显示');

	/* 聚焦已有值：显示气泡，不自动选择文本。 */
	input().props.onFocus(focusEvent(row())); tree = h.render();
	assert.ok(menu() !== undefined, '聚焦时应显示现有下拉气泡');
	assert.strictEqual(input().props.value, 'DeepSeek-Flash', '聚焦已有值时仍显示当前值');
	const listbox = menu();
	assert.strictEqual(listbox.props.role, 'listbox', '气泡 role=listbox');
	assert.ok(typeof listbox.props.id === 'string' && listbox.props.id.length > 0, 'listbox 应有 id');
	assert.strictEqual(input().props['aria-controls'], listbox.props.id, 'aria-controls 应指向该 listbox');
	assert.strictEqual(input().props['aria-expanded'], 'true', '打开时 aria-expanded=true');

	/* 清空输入恢复全部候选 */
	input().props.onChange(inputEvent(row(), '')); tree = h.render();
	assert.strictEqual(input().props.value, '', '清空后输入框为空');
	assert.strictEqual(itemKeys().length, 5, '清空筛选应恢复全部候选');

	/* 输入 C：大小写无关包含匹配，命中 Claude，排除其它无 c 的模型 */
	input().props.onChange(inputEvent(row(), 'C')); tree = h.render();
	assert.strictEqual(input().props.value, 'C', '输入后筛选文本写回输入框');
	let keys = itemKeys();
	assert.ok(keys.indexOf('claude-opus-test') !== -1, '输入 C 应命中 Claude（原始名含 c）');
	['deepseek-flash', 'gpt-4o-mini-test', 'gemini-test', 'qwen-max-test'].forEach((name) => {
		assert.strictEqual(keys.indexOf(name), -1, '输入 C 不应命中无 c 的模型：' + name);
	});

	/* 小写 c 结果一致 */
	input().props.onChange(inputEvent(row(), 'c')); tree = h.render();
	assert.ok(itemKeys().indexOf('claude-opus-test') !== -1, '小写 c 同样命中 Claude（大小写无关）');

	/* 按原始名子串匹配（opus） */
	input().props.onChange(inputEvent(row(), 'opus')); tree = h.render();
	assert.deepStrictEqual(itemKeys(), ['claude-opus-test'], '输入 opus 仅命中 claude（原始名子串）');

	/* 再次清空恢复全部 */
	input().props.onChange(inputEvent(row(), '')); tree = h.render();
	assert.strictEqual(itemKeys().length, 5, '再次清空应恢复全部候选');

	/* 无匹配：空列表，不渲染任何提示文案（空白） */
	input().props.onChange(inputEvent(row(), 'zzz')); tree = h.render();
	assert.strictEqual(menu(), undefined, '无匹配时完全不渲染 listbox');
	assert.strictEqual(input().props['aria-expanded'], 'false', '无匹配时 aria-expanded=false');
	input().props.onChange(inputEvent(row(), '')); tree = h.render();
	assert.ok(menu() !== undefined, '清空筛选后重新显示候选 listbox');
	assert.strictEqual(input().props['aria-expanded'], 'true', '清空后候选可见时 aria-expanded=true');
	assert.strictEqual(itemKeys().length, 5, '清空无匹配筛选后恢复全部候选');

	console.log('      原生输入 / 可访问名 / C 与 c 包含匹配 / opus 子串 / 清空恢复 / 无匹配空白');
}

/* ============================================================ C. 键盘不选择 + Escape + 鼠标可选 */
console.log('===== C. 键盘不参与选择：方向键/Enter 不选、Escape 关闭、鼠标点击可选 =====');
{
	const h = makeHarness();
	let tree = openPlatformEdit(h);
	const row = () => platformRowOf(tree);
	const input = () => inputOfRow(rowsOf(tree)[0]);
	const menu = () => menuOf(tree);

	/* 清空显示全部，确保若键盘误选会改变输入值 */
	input().props.onFocus(focusEvent(row())); tree = h.render();
	input().props.onChange(inputEvent(row(), '')); tree = h.render();
	assert.ok(itemsOf(menu()).length >= 2, '清空后应显示多个候选');
	const beforeValue = input().props.value;
	const beforeKeys = itemsOf(menu()).map((node) => node.props.key);

	/* 方向键不得改变选择、不得关闭菜单 */
	['ArrowDown', 'ArrowUp', 'ArrowDown'].forEach((key) => {
		input().props.onKeyDown(Object.assign(inputEvent(row(), ''), { key: key, preventDefault: () => {} })); tree = h.render();
		assert.ok(menu() !== undefined, key + ' 不应关闭菜单');
		assert.strictEqual(input().props.value, beforeValue, key + ' 不应改变输入/选择');
	});
	/* 无灰色键盘活动项、无 aria-activedescendant */
	assert.strictEqual(findAll(menu(), (node) => hasClass(node, 'dsb-select-item-active')).length, 0, '不应出现键盘活动灰底项');
	assert.strictEqual(input().props['aria-activedescendant'], undefined, '不应有 aria-activedescendant（无键盘活动项）');

	/* Enter 不得选中 option / 菜单保持打开 / 候选不变 */
	input().props.onKeyDown(Object.assign(inputEvent(row(), ''), { key: 'Enter', preventDefault: () => {} })); tree = h.render();
	assert.ok(menu() !== undefined, 'Enter 不应选中并关闭菜单');
	assert.deepStrictEqual(itemsOf(menu()).map((node) => node.props.key), beforeKeys, 'Enter 不应改变候选/选择');
	assert.strictEqual(input().props.value, beforeValue, 'Enter 不应改变输入值');

	/* Escape 关闭并恢复已选显示 */
	input().props.onKeyDown(Object.assign(inputEvent(row(), ''), { key: 'Escape', preventDefault: () => {} })); tree = h.render();
	assert.strictEqual(menu(), undefined, 'Escape 关闭菜单');
	assert.strictEqual(input().props.value, 'DeepSeek-Flash', 'Escape 后恢复已选值显示');

	/* 鼠标点击仍可选 */
	input().props.onFocus(focusEvent(row())); tree = h.render();
	input().props.onChange(inputEvent(row(), 'claude')); tree = h.render();
	const claude = itemsOf(menu()).filter((node) => node.props.key === 'claude-opus-test')[0];
	assert.ok(claude !== undefined, '筛选 claude 后应出现 claude 候选');
	let mouseDownPrevented = false; let mouseDownStopped = false;
	claude.props.onMouseDown({ preventDefault: () => { mouseDownPrevented = true; }, stopPropagation: () => { mouseDownStopped = true; } });
	assert.strictEqual(mouseDownPrevented, true, '候选 mousedown 必须 preventDefault，避免 input 抢先 blur');
	assert.strictEqual(mouseDownStopped, true, '候选 mousedown 必须阻止冒泡');
	claude.props.onClick({ stopPropagation: () => {} }); tree = h.render();
	assert.strictEqual(menu(), undefined, '点击候选后菜单收起');
	assert.strictEqual(input().props.value, 'Claude-Opus-Test', '点击候选写回所选模型显示名');

	/* 再次聚焦显示已选模型，筛选文本不残留 */
	input().props.onFocus(focusEvent(row())); tree = h.render();
	assert.strictEqual(input().props.value, 'Claude-Opus-Test', '再次聚焦显示已选模型，筛选文本未残留');
	input().props.onKeyDown(Object.assign(inputEvent(row(), ''), { key: 'Escape', preventDefault: () => {} })); tree = h.render();
	assert.strictEqual(menu(), undefined, 'Escape 关闭');

	console.log('      方向键/Enter 不选、无灰底活动项、Escape 关闭、鼠标点击可选、筛选不残留');
}

/* ============================================================ D. 布局：fixed / 3 项高度 / 始终向下 / 视口夹紧 */
console.log('===== D. 布局：fixed 定位 / 最多 3 项完整高度 / 始终向下 / 视口夹紧 =====');
function openWithRect(rect, viewW, viewH) {
	const h = makeHarness();
	if (typeof viewW === 'number') h.window.innerWidth = viewW;
	if (typeof viewH === 'number') h.window.innerHeight = viewH;
	let tree = openPlatformEdit(h);
	const row = platformRowOf(tree);
	const input = inputOfRow(rowsOf(tree)[0]);
	input.props.onFocus(focusEvent(row, rect));
	tree = h.render();
	const menu = menuOf(tree);
	assert.ok(menu !== undefined, '布局场景：菜单应打开');
	return menu.props.style;
}
{
	/* 无 react-dom 时 fixed 的包含块是最近 .dsb-edit-pop：坐标换算后仍向下且按视口底部限高。 */
	const fallbackHarness = makeHarness();
	fallbackHarness.window.innerHeight = 450;
	fallbackHarness.dom.settingsPop.rect = { left: 20, top: 300 };
	let fallbackTree = openPlatformEdit(fallbackHarness);
	const fallbackRow = platformRowOf(fallbackTree);
	inputOfRow(rowsOf(fallbackTree)[0]).props.onFocus(focusEvent(fallbackRow, { left: 100, top: 350, right: 300, bottom: 380, width: 200, height: 30 }));
	fallbackTree = fallbackHarness.render();
	const fallbackMenu = menuOf(fallbackTree);
	assert.ok(fallbackMenu !== undefined, 'fallback 路径菜单应打开');
	assert.strictEqual(fallbackMenu.props.style.left, '80px', 'fallback left 应减去 .dsb-edit-pop 的视口 left');
	assert.strictEqual(fallbackMenu.props.style.top, '84px', 'fallback top 应减去 .dsb-edit-pop 的视口 top');
	assert.strictEqual(fallbackMenu.props.style.bottom, 'auto', 'fallback 不得向上展开');
	assert.strictEqual(fallbackMenu.props.style.maxHeight, '62px', 'fallback 仍按视口底部剩余空间限高');
	assert.strictEqual(fallbackHarness.portalCalls.length, 0, '无 react-dom 时必须走 fallback');

	/* react-dom 可用时 portal 到 document.body，保留视口 fixed 坐标与同一限高。 */
	const portalHarness = makeHarness({ portal: true });
	portalHarness.window.innerHeight = 450;
	portalHarness.dom.settingsPop.rect = { left: 20, top: 300 };
	let portalTree = openPlatformEdit(portalHarness);
	const portalRow = platformRowOf(portalTree);
	inputOfRow(rowsOf(portalTree)[0]).props.onFocus(focusEvent(portalRow, { left: 100, top: 350, right: 300, bottom: 380, width: 200, height: 30 }));
	portalTree = portalHarness.render();
	const portalMenu = menuOf(portalTree);
	assert.ok(portalMenu !== undefined, 'portal 路径菜单应打开');
	assert.strictEqual(portalMenu.props.style.left, '100px', 'portal left 应使用视口坐标');
	assert.strictEqual(portalMenu.props.style.top, '384px', 'portal top 应使用视口坐标并向下展开');
	assert.strictEqual(portalMenu.props.style.bottom, 'auto', 'portal 不得向上展开');
	assert.strictEqual(portalMenu.props.style.maxHeight, '62px', 'portal 仍按视口底部剩余空间限高');
	const menuPortalCall = portalHarness.portalCalls.filter((call) => call.node !== null && call.node !== undefined && call.node.props !== undefined && typeof call.node.props.className === 'string' && call.node.props.className.indexOf('dsb-modelrow-menu') !== -1)[0];
	assert.ok(menuPortalCall !== undefined, '模型菜单应调用 createPortal');
	assert.strictEqual(menuPortalCall.target, portalHarness.document.body, '模型菜单 portal 目标必须是 document.body');

	/* 默认下方够放：3 项完整高度 = 8 + 3*30 = 98；fixed 贴输入框 */
	const a = openWithRect({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }, 1200, 900);
	assert.strictEqual(a.position, 'fixed', '菜单应为 fixed 定位（脱离设置容器 overflow 裁切）');
	assert.strictEqual(a.maxHeight, '98px', '最多 3 项完整高度（8 + 3*30）');
	assert.strictEqual(a.overflowY, 'auto', '放不下时菜单内部滚动');
	assert.strictEqual(a.left, '0px', '向下贴输入框左边');
	assert.strictEqual(a.width, '200px', '宽度贴合输入框');
	assert.strictEqual(a.top, '104px', '向下贴输入框底边 + 4px');
	assert.strictEqual(a.bottom, 'auto', '向下时不用 bottom');

	/* 底部空间不足仍向下锚定，按下方实际剩余空间限高。 */
	const b = openWithRect({ left: 0, top: 450, right: 200, bottom: 480, width: 200, height: 30 }, 1200, 500);
	assert.strictEqual(b.position, 'fixed', '底部空间不足时仍 fixed');
	assert.strictEqual(b.top, '484px', '底部不足时 top 仍为输入框底边 + 4px');
	assert.strictEqual(b.bottom, 'auto', '向下定位不使用 bottom');
	assert.strictEqual(b.maxHeight, '12px', '下方仅余 12px 时按实际空间限高');

	/* 右侧越界 → 左移夹紧在视口内 */
	const c = openWithRect({ left: 1100, top: 0, right: 1300, bottom: 100, width: 200, height: 100 }, 1200, 900);
	assert.strictEqual(c.left, '996px', '右侧越界时夹在视口内（1200 - 4 - 200）');

	/* 上下都不够 → 按可视空间限高（内部滚动），不超出视口 */
	const d = openWithRect({ left: 0, top: 40, right: 200, bottom: 70, width: 200, height: 30 }, 1200, 120);
	assert.strictEqual(d.maxHeight, '42px', '上下都不够时按可视空间限高（120 - 70 - 4 - 4）');
	assert.strictEqual(d.top, '74px', '限高时仍向下贴底边 + 4px');
	assert.strictEqual(d.overflowY, 'auto', '限高靠菜单内部滚动');

	console.log('      fixed 定位 / 3 项高度 98px / 底部不足仍向下并限高 / 右越界夹紧 / 菜单内部滚动');
}

console.log('\n全部通过');
