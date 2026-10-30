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
code = code.replace(marker, '\t\texports.__test = { SettingsSection, setDevMode, isDevMode, DEV_CLICKS, setUpdateState, snapshotUpdate, contextRing, ringPercentOf, readSubagentTiers, nextSubagentTiers, SUBAGENT_TIERS_EMPTY, METER_CIRCUMFERENCE, rowsPanel, skillList, toolList, compactList, costByCurrencyText, sumDays, hoverPanelRows };\n' + marker);

/* ---------------------------------------------------------- 最小 React 替身 */
/** 记录渲染出来的节点树，用来断言结构。 */
function makeElement(type, props, ...children) {
	return { type: type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) };
}

const sandbox = {
	window: {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		/* 本文件不关心网络：所有 fetch 一律回空对象（够 update / 余额这些路径安静地走过）。
	   注意不要再引入依赖某个具体路由返回值的写法 —— 开发模式那条探测路由已经删掉了
	   （开发模式合并回主插件，入口判定纯本地）。 */
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
async function clickVersionLine(times = 1) {
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
		await versionNode.props.onClick();
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
	await clickVersionLine(api.DEV_CLICKS);
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
	await clickVersionLine(api.DEV_CLICKS);
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
	await clickVersionLine(api.DEV_CLICKS);
	const footOn = footSignature();
	await clickVersionLine(api.DEV_CLICKS);

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
	await clickVersionLine(api.DEV_CLICKS);

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

	/* ================================================== ⑧ 圆环三档颜色 + 弧长分层
	 * 用户新需求（Agent Teams）：「在使用智能体团队的时候，智能体团队成员仍在工作，而主页面
	 * （lead）没有在工作，那么上下文占用的圆环的条就应该变成蓝色在旋转。如果成员没有在工作，
	 * 而成员下面的一级子智能体在工作……那就变成紫色在旋转。」
	 * 以及弧长：「如果有多个成员同时在运行，那么这个圆圈应该显示为同一级内上下文占用最多的
	 * 那一个……（紫色那部分）上下文占用要显示最少的那个。」
	 * 即：**颜色 = 谁在跑；弧长 = 那一级的占用（成员取最大、深层取最小）**，两件事独立。 */

	/* 取圆环节点上的 class 与 fill 的 dashoffset（弧长＝周长 × (1 - 百分比/100)） */
	const ringOf = (status, percent, compact) => {
		const tree = api.contextRing(percent, status, compact);
		const collect = { classes: [], offset: null };
		(function walk(node) {
			if (node === null || node === undefined || typeof node !== 'object') return;
			if (Array.isArray(node)) { node.forEach(walk); return; }
			if (typeof node.props?.className === 'string') collect.classes.push(node.props.className);
			if (typeof node.props?.strokeDashoffset === 'number') collect.offset = node.props.strokeDashoffset;
			if (node.children !== undefined) walk(node.children);
		})(tree);
		return collect;
	};
	const clsOf = (one) => one.classes.join(' ');

	/* ⑧-1 teamRunning ⇒ 蓝档 class，且**不带**绿色那份 */
	const ringTeam = ringOf('teamRunning', 55, null);
	assert.strictEqual(clsOf(ringTeam).includes('dsb-ring-team'), true,
		'state=teamRunning ⇒ class 要含 dsb-ring-team（实际 ' + clsOf(ringTeam) + '）');
	assert.strictEqual(clsOf(ringTeam).includes('dsb-ring-running'), false,
		'state=teamRunning 不该同时带 dsb-ring-running（否则绿色会盖住蓝色）');

	/* ⑧-2 deepRunning ⇒ 紫档 class，同样不带绿 */
	const ringDeep = ringOf('deepRunning', 10, null);
	assert.strictEqual(clsOf(ringDeep).includes('dsb-ring-deep'), true,
		'state=deepRunning ⇒ class 要含 dsb-ring-deep（实际 ' + clsOf(ringDeep) + '）');
	assert.strictEqual(clsOf(ringDeep).includes('dsb-ring-running'), false,
		'state=deepRunning 不该同时带 dsb-ring-running');

	/* ⑧-3 running 仍是绿（防回归：这条谁都不能动） */
	const ringRunning = ringOf('running', 55, null);
	assert.strictEqual(clsOf(ringRunning).includes('dsb-ring-running'), true,
		'state=running 必须仍是 dsb-ring-running（绿色一档保持不变）');
	assert.strictEqual(clsOf(ringRunning).includes('dsb-ring-team'), false, 'running 不该带蓝档');
	assert.strictEqual(clsOf(ringRunning).includes('dsb-ring-deep'), false, 'running 不该带紫档');

	/* ⑧-4 CSS 里两条新规则在，且 reduced-motion 一并停掉（与绿色同待遇） */
	/* cssSource 在本文件前面（⑦ 那段）已经读过一次源码，直接复用，别重复声明 */
	assert.ok(/\.dsb-ring-team \.dsb-ring-fill\{stroke:var\(--dsw-static-blue-450\)/.test(cssSource),
		'CSS 里要有 .dsb-ring-team 规则，颜色取总计「输出」那个蓝 var(--dsw-static-blue-450)');
	assert.ok(/\.dsb-ring-deep \.dsb-ring-fill\{stroke:#a78bfa/.test(cssSource),
		'CSS 里要有 .dsb-ring-deep 规则，颜色取总计「未命中输入」那个紫 #a78bfa');
	const reduced = cssSource.match(/@media \(prefers-reduced-motion: reduce\)\{[^}]*\.dsb-ring[^}]*animation:none[^}]*\}/);
	assert.ok(reduced !== null, '要有一条 prefers-reduced-motion 规则同时管到圆环三档');
	assert.ok(reduced[0].includes('.dsb-ring-team') && reduced[0].includes('.dsb-ring-deep'),
		'reduced-motion 那条必须同时包含蓝档与紫档（与绿色同待遇，不能只停一个）：' + (reduced === null ? '' : reduced[0]));

	/* ⑧-5 弧长：teamRunning 用成员级最大（55），不是 Lead 自己的占用 */
	const circumference = api.METER_CIRCUMFERENCE;
	const percentToOffset = (pc) => circumference * (1 - pc / 100);
	const leadMeter = { percent: 20, compact: null };
	assert.strictEqual(api.ringPercentOf(leadMeter, 'teamRunning', { teamPercent: 55, deepPercent: 10 }), 55,
		'teamRunning ⇒ 弧长取 teamContextPercent(55)，不是 Lead 自己的 20');
	assert.strictEqual(ringOf('teamRunning', 55, null).offset, percentToOffset(55),
		'dashoffset 要对应 55%（成员级最大占用），实际 ' + ringOf('teamRunning', 55, null).offset
		+ ' 期望 ' + percentToOffset(55));

	/* ⑧-6 弧长：deepRunning 用深层最小（10） */
	assert.strictEqual(api.ringPercentOf(leadMeter, 'deepRunning', { teamPercent: 55, deepPercent: 10 }), 10,
		'deepRunning ⇒ 弧长取 deepContextPercent(10)，不是 Lead 自己的 20');
	assert.strictEqual(ringOf('deepRunning', 10, null).offset, percentToOffset(10),
		'dashoffset 要对应 10%（深层最小占用），实际 ' + ringOf('deepRunning', 10, null).offset
		+ ' 期望 ' + percentToOffset(10));

	/* ⑧-7 兜底：分层百分比为 null ⇒ 退回 Lead 自己的占用（不能显示 0 把圆环弄空） */
	assert.strictEqual(api.ringPercentOf(leadMeter, 'teamRunning', { teamPercent: null, deepPercent: null }), 20,
		'teamRunning 但 teamContextPercent 为 null ⇒ 必须退回 contextMeter.percent(20)，不是 0');
	assert.strictEqual(api.ringPercentOf(leadMeter, 'deepRunning', null), 20,
		'deepRunning 但整个分层对象都没有 ⇒ 同样退回 20');
	/* 其余四档一律用 Lead 自己的占用，一点不改 */
	['running', 'error', 'approval', 'idle'].forEach((st) => {
		assert.strictEqual(api.ringPercentOf(leadMeter, st, { teamPercent: 55, deepPercent: 10 }), 20,
			st + ' 档必须继续用 Lead 自己的占用(20)，不能被分层百分比影响');
	});

	console.log('⑧ 圆环：teamRunning→dsb-ring-team / deepRunning→dsb-ring-deep / running→dsb-ring-running（绿不变）；'
		+ 'CSS 两条规则 + reduced-motion 三档同停；弧长 成员55% / 深层10% / null 退回 Lead 20%');

	/* ============================== ⑨ data-cols-grow 与 data-cols-growable 语义各异
	 * 两个属性**不能合并**：
	 *   · `data-cols-growable` —— "这类列表支持逐档加行"（能力）。toolColumnsOverflow 靠它
	 *     决定要不要量溢出。到 12 行上限后**依然带着**，因为那时仍要量（量了才知道要不要遮罩）。
	 *   · `data-cols-grow` —— "当前还没加到 12 行上限、还能继续加"。applyColsFade 靠它
	 *     决定要不要显示遮罩（能加行时显示遮罩就是误报）。
	 * 三个列表（工具调用 / 技能注入 / 上下文压缩）都走这条逻辑。 */
	const growAttrsOf = (tip, sub, rowsPerColumn) => {
		const tree = api.rowsPanel(tip, null, { current: null },
			{ id: sub, rowsPerColumn: rowsPerColumn });
		let found = null;
		(function walk(node) {
			if (node === null || node === undefined || typeof node !== 'object') return;
			if (Array.isArray(node)) { node.forEach(walk); return; }
			const cls = typeof node.props?.className === 'string' ? node.props.className : '';
			/* 只认列网格那一层（class 里精确含 dsb-meter-cols 这个词） */
			if (cls.split(' ').includes('dsb-meter-cols')) { found = node.props; return; }
			if (node.children !== undefined) walk(node.children);
		})(tree);
		return found;
	};
	/* 三个列表都塞够多条目，保证一定分多列（分列才套 dsb-meter-cols） */
	/* 列表函数要一个 t；本段只关心"带不带 growable / tight"，文案不重要 —— 给个恒等 t */
	const idT = (key) => String(key);
	const manySkillsR = Array.from({ length: 24 }, (_, i) => ({ name: 'sk-' + i }));
	const manyCompactsR = Array.from({ length: 24 }, (_, i) => ({ turn: i + 1, step: 1, afterTurn: null, manual: false }));
	/* 工具列表要够多：12 行/列时仍要排成多列（否则不套 dsb-meter-cols，属性测不到） */
	const toolsMap = {};
	Array.from({ length: 24 }, (_, i) => { toolsMap['tool_' + i] = i + 1; });
	/* 直接构造 counts 段那种 tip：rows 每项的 sub 就是子视图对象（rowsPanel 读 row.sub） */
	const tipR = {
		kind: 'rows',
		title: '会话数据',
		rows: [
			{ label: '上下文压缩', value: '3', sub: api.compactList(manyCompactsR, idT) },
			{ label: '技能注入', value: '3', sub: api.skillList(manySkillsR, 'AGENTS.md', idT) },
			{ label: '工具调用', value: '3', sub: api.toolList(toolsMap, idT) }
		]
	};

	/* 未到 12 行：两个属性都在 */
	const at3 = growAttrsOf(tipR, 2, 3);
	assert.strictEqual(at3['data-cols-growable'], '1', '未到 12 行时 data-cols-growable 要在（表示这类列表支持加行）');
	assert.strictEqual(at3['data-cols-grow'], '1', '未到 12 行时 data-cols-grow 也要在（表示还能继续加）');
	/* 到 12 行：growable 仍在、grow 消失 */
	const at12 = growAttrsOf(tipR, 2, 12);
	assert.strictEqual(at12['data-cols-growable'], '1',
		'到 12 行上限时 data-cols-growable 仍要带着（还要靠它量溢出才知道该不该显示遮罩）');
	assert.strictEqual(at12['data-cols-grow'], undefined,
		'到 12 行上限时 data-cols-grow 必须消失（不能再加行了，溢出就是真要滚 ⇒ 该显示遮罩）');

	/* 技能注入（sub 索引 1）与上下文压缩（sub 索引 0）同样带这两个属性 */
	[0, 1].forEach((idx) => {
		const attrs = growAttrsOf(tipR, idx, 3);

		assert.strictEqual(attrs === null, false, '子视图 ' + idx + ' 应当渲染出列网格');
		assert.strictEqual(attrs['data-cols-growable'], '1',
			'子视图 ' + idx + '（' + (idx === 0 ? '上下文压缩' : '技能注入') + '）也要带 data-cols-growable');
		assert.strictEqual(attrs['data-cols-grow'], '1',
			'子视图 ' + idx + ' 也要带 data-cols-grow（未到 12 行）');
		assert.strictEqual(String(attrs.className).includes('dsb-meter-tight'), false,
			'子视图 ' + idx + ' 不许带 dsb-meter-tight（长名字会被挤在一起）');
	});
	console.log('⑨ data-cols-growable（能力，到 12 行仍在）/ data-cols-grow（未满 12 行才有）语义各别；'
		+ '技能与压缩子视图都带、且都不带 dsb-meter-tight');
	/* ============================== ⑩ 活跃总览金额：分币种各算各的（不折算）
	 * 用户原话：「各自算各自，不再换算成统一币种，就比如说我美元模型用了 7.77。
	 * 人民币模型用了 145.66。那显示就应该显示 ¥145.66+$7.77」，
	 * 以及「但是如果其中有一项为 0，也就是没产生费用，就不用显示这个 +」。
	 * 关键边界：**只有美元时必须是 $7.77，不能出现 ¥0.00+**。 */
	const costT = (key) => String(key);
	const cbc = (map, fallback) => api.costByCurrencyText(map, fallback, costT);
	assert.strictEqual(cbc({ CNY: 145.66, USD: 7.77 }, 999), '¥145.66+$7.77',
		'人民币在前、美元在后，用 + 连接（实际 ' + cbc({ CNY: 145.66, USD: 7.77 }, 999) + '）');
	assert.strictEqual(cbc({ USD: 7.77 }, 0), '$7.77',
		'只有美元 ⇒ 只显示 $7.77，**不许出现 ¥0.00+**（实际 ' + cbc({ USD: 7.77 }, 0) + '）');
	assert.strictEqual(cbc({ CNY: 145.66 }, 0), '¥145.66',
		'只有人民币 ⇒ 不带结尾的 +（实际 ' + cbc({ CNY: 145.66 }, 0) + '）');
	assert.strictEqual(cbc({ CNY: 0, USD: 7.77 }, 0), '$7.77',
		'某币种为 0 ⇒ 该项不出现（实际 ' + cbc({ CNY: 0, USD: 7.77 }, 0) + '）');
	assert.strictEqual(cbc({}, 153.43), '¥153.43',
		'空对象 ⇒ 退回旧的混合金额逻辑（老 host 行为不变）');
	assert.strictEqual(cbc({}, 0), '¥0.00', '空对象 + 0 ⇒ ¥0.00（这一行必须有内容）');
	assert.strictEqual(cbc({ CNY: -1, USD: 7.77 }, 0), '$7.77',
		'负数当 0（浮点噪声）⇒ 只剩美元');
	/* ============ 金额不足 0.01 不显示（用户原话：「只要金额不足 0.01，就直接不显示。」）
	 * 以前是「≤ 0 才不显示」，于是 0.002 会被 toFixed(2) 显示成 `$0.00` —— 一个
	 * "有这笔钱但看起来是零"的假零。判据改成 `Math.round(amount * 100) >= 1`。 */
	assert.strictEqual(cbc({ CNY: 14.12, USD: 0.002 }, 0), '¥14.12',
		'★ 关键：美元只有 0.002 ⇒ 被过滤，**不许出现 $0.00**（实际 ' + cbc({ CNY: 14.12, USD: 0.002 }, 0) + '）');
	assert.strictEqual(cbc({ CNY: 0.002, USD: 0.003 }, 0), '¥0.00',
		'两项都不足 0.01 ⇒ ¥0.00（这一行必须有内容），实际 ' + cbc({ CNY: 0.002, USD: 0.003 }, 0));
	assert.strictEqual(cbc({ CNY: 0.005, USD: 0 }, 0), '¥0.01',
		'边界：正好半分 ⇒ 四舍五入进位，应当显示 ¥0.01，实际 ' + cbc({ CNY: 0.005, USD: 0 }, 0));
	assert.strictEqual(cbc({ CNY: 0.004, USD: 0 }, 0), '¥0.00',
		'边界：不到半分 ⇒ 被过滤，实际 ' + cbc({ CNY: 0.004, USD: 0 }, 0));
	assert.strictEqual(cbc({ USD: 0.009 }, 0), '$0.01',
		'0.009 四舍五入到 0.01，应当显示，实际 ' + cbc({ USD: 0.009 }, 0));
	assert.strictEqual(cbc({ CNY: 14.12, USD: 0.005 }, 0), '¥14.12+$0.01',
		'恰好半分那一侧也要显示（不是被 0.01 门槛卡掉），实际 ' + cbc({ CNY: 14.12, USD: 0.005 }, 0));
	/* 空对象仍走 fallback（老 host 没有分币种数据），不能因为新规则变成 ¥0.00 */
	assert.strictEqual(cbc({}, 153.43), '¥153.43',
		'空对象仍退回混合 cost 兜底（新规则不影响"根本没有这个字段"的老数据）');
	assert.strictEqual(cbc({}, 0.002), '¥0.00', 'fallback 本身不足 0.01 时也显示 ¥0.00');
	assert.strictEqual(cbc(undefined, 153.43), '¥153.43', 'undefined 也退回旧逻辑');
	assert.strictEqual(cbc({ CNY: 0, USD: 0 }, 99), '¥0.00',
		'两项都 0 ⇒ ¥0.00（不能返回空串，也不能用 fallback 的 99）');
	assert.strictEqual(cbc({ CNY: NaN, USD: 7.77 }, 0), '$7.77', 'NaN 当 0');
	assert.strictEqual(cbc({ CNY: 1, USD: 2, EUR: 3 }, 0), '¥1.00+$2.00',
		'只认 CNY / USD 两个键（其它币种不参与，字段名已锁定）');
	assert.strictEqual(cbc({ CNY: 145.6, USD: 7.7 }, 0), '¥145.60+$7.70', '每项固定两位小数');
	/* sumDays 必须把分币种也累加起来，否则周汇总/全年汇总只有一个混合数 */
	const sumMixed = api.sumDays([
		{ input: 1, cacheRead: 2, cacheWrite: 0, output: 3, calls: 1, cost: 100, costByCurrency: { CNY: 100 } },
		{ input: 1, cacheRead: 0, cacheWrite: 0, output: 1, calls: 2, cost: 7.77, costByCurrency: { USD: 7.77 } }
	]);
	assert.strictEqual(sumMixed.byCurrency.CNY, 100, 'sumDays 累加人民币');
	assert.strictEqual(sumMixed.byCurrency.USD, 7.77, 'sumDays 累加美元');
	assert.strictEqual(sumMixed.cost, 107.77, 'sumDays 的混合 cost 仍照旧求和（老逻辑不变）');
	assert.strictEqual(sumMixed.calls, 3, 'sumDays 的 calls 仍照旧求和');
	const sumUsd = api.sumDays([
		{ cost: 3.5, costByCurrency: { USD: 3.5 } },
		{ cost: 4.27, costByCurrency: { USD: 4.27 } }
	]);
	assert.strictEqual(sumUsd.byCurrency.USD.toFixed(2), '7.77', '两天美元 3.5 + 4.27 = 7.77');
	assert.strictEqual(sumUsd.byCurrency.CNY, undefined, '没产生人民币费用就不建 CNY 键');
	const sumOld = api.sumDays([{ cost: 5 }, { cost: 6 }]);
	/* 用 JSON 比较而不是 deepStrictEqual：这个对象来自 vm 里的另一个 realm，
	   原型与本文件里的 {} 不是同一个，deepStrictEqual 会因原型不同而判定不相等。 */
	assert.strictEqual(JSON.stringify(sumOld.byCurrency), '{}',
		'老数据没有 costByCurrency ⇒ 空对象（显示层退回旧逻辑），实际 ' + JSON.stringify(sumOld.byCurrency));
	assert.strictEqual(sumOld.cost, 11, '老数据 cost 照旧');
	/* 悬停面板那六行里，金额行必须用新的分币种文案（而不是写死的 ¥ + 混合数） */
	const hoverRows = api.hoverPanelRows('d', { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
		2, 999, { CNY: 145.66, USD: 7.77 }, costT);
	const hoverTexts = [];
	(function walkHover(node) {
		if (node === null || node === undefined) return;
		if (Array.isArray(node)) { node.forEach(walkHover); return; }
		if (typeof node === 'string' || typeof node === 'number') { hoverTexts.push(String(node)); return; }
		if (typeof node !== 'object') return;
		if (node.children !== undefined) walkHover(node.children);
	})(hoverRows);
	assert.strictEqual(hoverTexts.indexOf('¥145.66+$7.77') !== -1, true,
		'悬停面板金额行要显示分币种文案，实际文本 ' + JSON.stringify(hoverTexts));
	assert.strictEqual(hoverTexts.indexOf('¥999.00') !== -1, false,
		'有分币种数据时不该再显示那个混合金额');
	console.log('⑩ 活跃总览金额分币种：¥145.66+$7.77 / 仅美元 $7.77（无 ¥0.00+）/ 仅人民币无 + / '
		+ '0 项不出现 / 空对象退回 ¥153.43 / 两项都 0 时 ¥0.00；sumDays 按币种累加、老 cost 不变');
	console.log('\nRENDER CHECKS PASSED');
})().catch((error) => {
	console.error('RENDER CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
