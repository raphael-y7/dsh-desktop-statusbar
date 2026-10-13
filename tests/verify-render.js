/**
 * 设置页渲染冒烟测试：预览功能改动了设置页的 JSX 结构（多了开关、徽标数组、说明条）。
 * 结构写错会让整页白屏 —— 所以这里用一个最小的 React 替身**真的把组件调用一遍**，
 * 确认它在预览开/关两种状态下都能渲染出节点，不抛错。
 *
 * 用法：node tests/verify-render.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
code = code.replace(marker, '\t\texports.__test = { SettingsSection, setDevMode, isDevMode, DEV_CLICKS, setUpdateState, snapshotUpdate };\n' + marker);

/* ---------------------------------------------------------- 最小 React 替身 */
/** 记录渲染出来的节点树，用来断言结构。 */
function makeElement(type, props, ...children) {
	return { type: type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) };
}

const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: (fn) => { fn(); return 0; }
	},
	document: {
		querySelectorAll: () => [],
		createElement: () => ({ innerHTML: '', dataset: {}, className: '', textContent: '', appendChild() {}, querySelector: () => null, remove() {}, firstElementChild: null }),
		body: { appendChild() {} },
		head: { appendChild() {} }
	},
	MutationObserver: class { observe() {} disconnect() {} },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout, clearTimeout
};
sandbox.globalThis = sandbox;
let captured = null;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

/**
 * React 替身：状态**跨渲染保持**（按 hook 调用顺序分配槽位，真 React 就是这么做的）。
 * 如果每次渲染都把 useState 重置成初值，「打开预览」这个交互就测不出来。
 */
const hookSlots = [];
let hookIndex = 0;
const reactStub = {
	createElement: makeElement,
	useState: (init) => {
		const slot = hookIndex;
		hookIndex += 1;
		if (hookSlots[slot] === undefined) hookSlots[slot] = init;
		return [hookSlots[slot], (next) => { hookSlots[slot] = typeof next === 'function' ? next(hookSlots[slot]) : next; }];
	},
	useEffect: (fn) => { const cleanup = fn(); return cleanup; },
	useLayoutEffect: (fn) => fn(),
	useRef: () => {
		const slot = hookIndex;
		hookIndex += 1;
		if (hookSlots[slot] === undefined) hookSlots[slot] = { current: null };
		return hookSlots[slot];
	},
	useSyncExternalStore: (subscribe, snapshot) => snapshot(),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useId: () => 'id',
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	if (name === 'react-dom') throw new Error('no react-dom');
	throw new Error('unexpected require: ' + name);
}).__test;

/** 递归收集所有节点的 className / 文本。 */
function collect(node, out) {
	if (node === null || node === undefined || node === false) return
	if (Array.isArray(node)) { for (const one of node) collect(one, out); return }
	if (typeof node !== 'object') { out.texts.push(String(node)); return }
	if (node.props !== undefined && node.props !== null && typeof node.props.className === 'string') out.classes.push(node.props.className)
	if (node.children !== undefined) collect(node.children, out)
}

/** 把组件渲染一遍，返回收集到的类名与文本。每次渲染前重置 hook 游标（真 React 也这样按序分配）。 */
function render() {
	hookIndex = 0;
	const props = { t: (key, vars) => {
		if (vars !== undefined && vars.version !== undefined) return key + '(' + vars.version + ')';
		return key;
	} };
	const tree = api.SettingsSection(props);
	const out = { classes: [], texts: [] };
	collect(tree, out);
	return out;
}

/**
 * 在渲染结果里找到页脚那行版本号，模拟用户点击它（走真实的 onVersionClick 路径）。
 *
 * 开发模式**刻意没有任何可见控件** —— 入口是这行版本号的「连点 5 次」。
 * 所以这里不去找勾选框，而是找 className 含 dsb-version 的 span 并调它的 onClick。
 */
function clickVersionLine(times = 1) {
	for (let i = 0; i < times; i += 1) {
		hookIndex = 0;
		const tree = api.SettingsSection({ t: (key, vars) => (vars !== undefined && vars.version !== undefined ? key + '(' + vars.version + ')' : key) });
		let versionNode = null;
		(function walk(node) {
			if (node === null || node === undefined || node === false || versionNode !== null) return;
			if (Array.isArray(node)) { node.forEach(walk); return }
			if (typeof node !== 'object') return;
			if (typeof node.props?.className === 'string' && node.props.className.includes('dsb-version')) { versionNode = node; return }
			if (node.children !== undefined) walk(node.children);
		})(tree);
		assert.ok(versionNode !== null, '找得到页脚那行版本号');
		assert.strictEqual(typeof versionNode.props.onClick, 'function', '版本号那一行挂着 onClick');
		versionNode.props.onClick();
	}
	hookIndex = 0;
}

/** 渲染一次并返回**节点树本身**（render() 返回的是收集好的摘要，不是树）。 */
function renderTree() {
	hookIndex = 0;
	return api.SettingsSection({ t: (key) => key });
}

/** 当前渲染出的所有类名。 */
function renderClasses() {
	const tree = renderTree();
	const out = { classes: [], texts: [] };
	(function collect(node) {
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach(collect); return }
		if (typeof node !== 'object') { out.texts.push(String(node)); return }
		if (typeof node.props?.className === 'string') out.classes.push(node.props.className);
		if (node.children !== undefined) collect(node.children);
	})(tree);
	return out;
}

(async () => {

	/* ① 默认（非开发模式）：**一个开发模式相关的可见元素都不该有** */
	/* 注意：不能用 setDevMode 来摆状态 —— 它只改模块级标记，组件读的是自己的 React state。
	   必须像真实用户那样点版本号，组件状态才会跟着走。 */
	api.setUpdateState({ hasUpdate: false, latest: null, busy: false, note: null, reason: null });
	const off = render();
	assert.ok(off.classes.length > 0, '渲染出了节点');
	for (const cls of ['dsb-dev-pill', 'dsb-preview-badge', 'dsb-preview-note', 'dsb-preview-toggle']) {
		assert.strictEqual(off.classes.some((c) => c.includes(cls)), false, '默认不该出现 ' + cls);
	}
	console.log('① 默认状态：无开发模式胶囊、无预览控件，布局与原来一致');

	/* ② 连点 5 次进入开发模式：按钮常驻，**标题右侧出现「开发模式」胶囊」 */
	clickVersionLine(api.DEV_CLICKS);
	assert.strictEqual(api.isDevMode(), true, '连点 5 次进入开发模式');
	const on = render();
	assert.strictEqual(api.snapshotUpdate().hasUpdate, true, '进入后按钮常驻（hasUpdate 为真）');
	assert.strictEqual(on.classes.some((c) => c.includes('dsb-dev-pill')), true, '标题右侧出现「开发模式」胶囊');
	assert.strictEqual(on.texts.some((one) => one.includes('devModeBadge')), true, '胶囊文案取的是 devModeBadge');
	/* 胶囊必须挂在标题那一行里（与「状态栏设置」同一行），不是别处。
	   注意：这里必须用 renderTree() 取树（它会重置 hook 游标）—— 直接调 SettingsSection
	   会让 hook 槽位错位，组件读到的 devOn 就不是当前这个了。 */
	const onTree = renderTree();
	let pillInTitleRow = false;
	(function walk(node, inTitleRow) {
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach((one) => walk(one, inTitleRow)); return }
		if (typeof node !== 'object') return;
		const cls = typeof node.props?.className === 'string' ? node.props.className : '';
		const now = inTitleRow || cls.includes('dsb-titlerow');
		if (cls.includes('dsb-dev-pill') && now) pillInTitleRow = true;
		if (node.children !== undefined) walk(node.children, now);
	})(onTree, false);
	assert.strictEqual(pillInTitleRow, true, '胶囊在标题那一行内');

	/* 位置：胶囊必须**紧跟在标题之后**（同一行的第 2 个子元素）—— 这就是「贴着标题右上角」
	   的结构保证（像 x² 的那个 2）。若哪天把胶囊挪到行首、或塞进别的容器、或用
	   space-between 把它推到面板最右，下面这些断言会立即失败。 */
	let titleRowNode = null;
	(function find(node) {
		if (titleRowNode !== null) return;
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach(find); return }
		if (typeof node !== 'object') return;
		const cls = typeof node.props?.className === 'string' ? node.props.className : '';
		if (cls.includes('dsb-titlerow')) { titleRowNode = node; return }
		if (node.children !== undefined) find(node.children);
	})(onTree);
	assert.ok(titleRowNode !== null, '找得到标题那一行');
	const rowKids = titleRowNode.children.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
	assert.strictEqual(typeof rowKids[0]?.props?.className === 'string'
		&& rowKids[0].props.className.includes('dsb-pagetitle'), true, '标题是这一行的第一个子元素');
	assert.strictEqual(typeof rowKids[1]?.props?.className === 'string'
		&& rowKids[1].props.className.includes('dsb-dev-pill'), true, '胶囊紧跟标题之后（贴着标题，不是甩到最右）');

	/* 样式也要对：
	   ① 不能再用 space-between（那会把胶囊推到最右）；
	   ② 胶囊**不覆盖字号**，沿用 .dsb-nav-pill 的 8px —— 与「发现新版本」那枚逐字一致；
	   ③ **不能有负 margin-top**：父级 .dsb-head 是纵向 flex，往上顶出容器会被裁掉（实测缺陷）。 */
	const cssSource = fs.readFileSync(PLUGIN, 'utf8');
	assert.strictEqual(/\.dsb-titlerow\{[^}]*justify-content:space-between/.test(cssSource), false,
		'标题行不得用 space-between（会把胶囊推到面板最右）');
	assert.strictEqual(/\.dsb-titlerow\{[^}]*align-items:flex-start/.test(cssSource), true,
		'标题行顶端对齐，胶囊才浮在标题右上角');
	const pillRule = (cssSource.match(/\.dsb-dev-pill\{([^}]*)\}/) || [])[1] || '';
	assert.strictEqual(/font-size/.test(pillRule), false,
		'胶囊不得覆盖字号（要沿用 .dsb-nav-pill 的 8px，与「发现新版本」一致）：' + pillRule);
	assert.strictEqual(/margin-top\s*:\s*-/.test(pillRule), false,
		'胶囊不得用负 margin-top（会被父容器裁掉）：' + pillRule);
	assert.strictEqual(/margin-top\s*:\s*2px/.test(pillRule), true,
		'胶囊要往下压 2px，落在标题行盒的行距余量里，顶端才不会高于标题文字上边界：' + pillRule);
	/* 上面那条断言以导航胶囊的 8px 为基准，这里把基准本身也钉住 */
	assert.strictEqual(/\.dsb-nav-pill\{[^}]*font-size:8px/.test(cssSource), true,
		'「发现新版本」导航胶囊的字号应为 8px（胶囊一致性的基准）');
	console.log('② 胶囊位置：紧跟标题右上角，字号与「发现新版本」一致（8px），无裁切');
	/* 更新按钮本身：空闲态文案是 updateTo(9.9.9) */
	assert.ok(on.texts.some((one) => one.includes('updateTo')), true, '渲染出了更新按钮文案：' + on.texts.filter((t) => t.includes('update')).join(' / '));
	assert.strictEqual(on.texts.some((one) => one.includes('9.9.9')), true, '按钮上写着开发演示版本号 9.9.9');
	console.log('② 连点 5 次进入：按钮常驻 + 标题右上角「开发模式」角标 + 演示版本号');

	/* ③ 再连点 5 次退出：按钮收起、胶囊撤掉 */
	clickVersionLine(api.DEV_CLICKS);
	const offAgain = render();
	assert.strictEqual(api.isDevMode(), false, '再连点 5 次退出开发模式');
	assert.strictEqual(api.snapshotUpdate().hasUpdate, false, '退出后按钮收起');
	assert.strictEqual(offAgain.classes.some((c) => c.includes('dsb-dev-pill')), false, '退出后胶囊撤掉');
	console.log('③ 再连点 5 次退出：按钮收起，胶囊撤掉');

	/* ③.5 页脚布局不受开发模式影响：进入前后，**除更新按钮本身**之外的元素必须完全一致。
	   这是用户明确提过的诉求 —— 开发模式不得挤占或改变正常布局。
	   唯一预期差异就是多出「更新」那一个按钮（开发模式的意义就在这）。 */
	function footSignature() {
		hookIndex = 0;
		const tree = api.SettingsSection({ t: (key) => key });
		const out = [];
		(function walk(node, insideFoot) {
			if (node === null || node === undefined || node === false) return;
			if (Array.isArray(node)) { node.forEach((one) => walk(one, insideFoot)); return }
			if (typeof node !== 'object') return;
			const cls = typeof node.props?.className === 'string' ? node.props.className : '';
			const nowInFoot = insideFoot || cls.includes('dsb-foot');
			if (nowInFoot && cls.length > 0) out.push(cls);
			if (node.children !== undefined) walk(node.children, nowInFoot);
		})(tree, false);
		return out;
	}
	const footOff = footSignature();
	clickVersionLine(api.DEV_CLICKS);
	const footOn = footSignature();
	clickVersionLine(api.DEV_CLICKS);

	const normalize = (list) => {
		const cleaned = list.map((c) => c.trim());
		const actionCount = cleaned.filter((c) => c === 'dsb-action').length;
		return { names: cleaned.filter((c) => c !== 'dsb-action').join('|'), actions: actionCount };
	};
	const nOff = normalize(footOff);
	const nOn = normalize(footOn);
	assert.strictEqual(nOn.names, nOff.names,
		'页脚里除按钮外的元素必须一致（不得新增任何提示/小标）\n关：' + footOff.join(' | ') + '\n开：' + footOn.join(' | '));
	assert.strictEqual(nOn.actions, nOff.actions + 1, '页脚只应多出「更新」这一个按钮');
	console.log('③.5 页脚布局：进入前后只多出更新按钮一个元素，无其它增删');
	console.log('     关：' + footOff.join(' | '));
	console.log('     开：' + footOn.join(' | '));

	/* 后面几条状态用例需要开发模式开着 */
	clickVersionLine(api.DEV_CLICKS);

	/* ④ 各状态都能渲染（更新中 / 已更新 / 更新失败），不抛错、文案对得上 */
	const cases = [
		[{ hasUpdate: true, latest: '9.9.9', busy: true, note: null, reason: null }, 'updateRunning', '更新中'],
		[{ hasUpdate: true, latest: '9.9.9', busy: false, note: 'done', reason: null }, 'updateDone', '已更新'],
		[{ hasUpdate: true, latest: '9.9.9', busy: false, note: 'failed', reason: 'release-age' }, 'updateFailed', '更新失败']
	];
	for (const [state, expected, label] of cases) {
		api.setUpdateState(state);
		const out = render();
		assert.strictEqual(out.texts.some((one) => one.includes(expected)), true, label + ' 状态渲染出 ' + expected);
		console.log('④ ' + label + '：渲染出 ' + expected);
	}

	/* ⑤ 更新中时按钮必须是禁用的（点了不能重复触发） */
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: true, note: null, reason: null });
	hookIndex = 0;
	const busyTree = api.SettingsSection({ t: (key) => key });
	let sawDisabled = false;
	(function walk(node) {
		if (node === null || node === undefined || node === false) return;
		if (Array.isArray(node)) { node.forEach(walk); return }
		if (typeof node !== 'object') return;
		if (typeof node.props?.className === 'string' && node.props.className.includes('dsb-action') && node.props.disabled === true) sawDisabled = true;
		if (node.children !== undefined) walk(node.children);
	})(busyTree);
	assert.strictEqual(sawDisabled, true, '更新中时更新按钮是禁用的');
	console.log('⑤ 更新中：按钮禁用（不会重复触发）');

	/* ⑥ 装完的提示必须是「重启 DSH」，**不能**是「刷新页面」。
	   DSH 的插件包元数据缓存至重启，刷新只会重新拉同一份旧 bundle
	   （见 @deepseek-ai/dsh-hmr 与 dsh-client-modules 的说明），
	   官方插件管理器也是「已安装，下次启动后加载」这个口径。
	   这条断言防止把错误的指引写回界面。 */
	const source = fs.readFileSync(PLUGIN, 'utf8');
	const doneLabel = (source.match(/updateDone:\s*"([^"]*)"/) || [])[1];
	assert.ok(typeof doneLabel === 'string' && doneLabel.length > 0, '取得到「已更新」的文案');
	assert.strictEqual(/刷新/.test(doneLabel), false, '「已更新」文案不得叫用户刷新页面（刷新无效）：' + doneLabel);
	assert.strictEqual(/重启|restart/i.test(doneLabel), true, '「已更新」文案必须明确要求重启：' + doneLabel);
	console.log('⑥ 更新完成文案：' + doneLabel + '（不含「刷新」）');

	/* ⑦ 文案要求：必须**明确写出「重启 DSH 后生效」**这个意思，且不得出现「刷新」。
	   用户明确要求过这一点：刷新在桌面端没有用，界面不能给出错误指引。
	   同时确认没有额外多出任何可见提示行（用户要求不要用提示干扰布局）。 */
	const hintKeys = ['updateRestartHint', 'dsb-restart-hint'];
	for (const k of hintKeys) {
		assert.strictEqual(source.includes(k), false, '不该再有额外的重启提示元素：' + k);
	}
	assert.strictEqual(/后生效/.test(doneLabel), true, '文案要说清「重启后生效」：' + doneLabel);
	console.log('⑦ 无额外提示元素；文案自证「重启后生效」：' + doneLabel);

	console.log('\nRENDER CHECKS PASSED');
})().catch((error) => {
	console.error('RENDER CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
