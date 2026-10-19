/**
 * 客户端卫生回归测试（`lib/client.js` + `tools/shot.cjs`）。
 *
 * 覆盖 3 条，逐条钉住：
 *   ① `.dsb-day-today` 是纯无效输出 —— CSS 里从来没有它的任何规则
 *      （`git log -S '.dsb-day-today'` 为空），它只进 DOM、不产生任何视觉差异，已删除。
 *      这里正断言它不会再回来；同时断言 `tip.today` 在热力图 / 年条里的真实用途还在。
 *   ② `tools/shot.cjs` 里 `pricingShot` 的 JSDoc 曾写「币种下拉**摊开**」，
 *      实现却是 `presets[8] = false`（收起）—— 注释与行为矛盾，已改注释。
 *   ③ `pricingShot` 的 `presets` 下标是**脆的**：组件里新增一个 `useState`
 *      就会让后面所有 hook 后移一位，下标必须回来重数。本测试用真实组件
 *      （vm + react 桩，与 `shot.cjs` 的 `loadPlugin` 同构）**实际渲染一遍**，
 *      数出 `SettingsSection` 的 useState 调用顺序，再用行为探针逐个确认
 *      editing / draft / currencyOpen 分别落在哪个下标上。
 *      历史上的坑：新增 `devOn` 让 hook 整体后移一位而 `presets` 没跟改，
 *      重新生成截图会得到「编辑区没展开 + 卡片里一句『抓取失败（undefined）』」。
 *
 * 用法：node tests/verify-client-hygiene.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* 与仓库其它测试一致：把 DSH_HOME 指到 tests/ 下的隔离目录，绝不碰真实 ~/.dsh。
   本文件只读源码、只在 vm 里渲染组件、不调 apply()，但仍按惯例隔离。 */
process.env.DSH_HOME = path.join(__dirname, '.dsh-test-home-client-hygiene');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const SHOT = path.join(ROOT, 'tools', 'shot.cjs');
const CONFIG_KEY = 'dsh.desktopStatusBar.v1';

const clientSource = fs.readFileSync(CLIENT, 'utf8');
const shotSource = fs.readFileSync(SHOT, 'utf8');

/* 去掉注释再断言：注释里会提到这些名字，直接搜源码会误判「还在用」。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/* ======================================================================
   ① dsb-day-today 不该再出现
   ====================================================================== */
console.log('===== ① `.dsb-day-today` 不该再出现在 lib/client.js =====');
const clientCode = stripComments(clientSource);
assert.strictEqual(clientCode.indexOf('dsb-day-today'), -1,
	'`.dsb-day-today` 在 CSS 里没有任何规则（git log -S 为空），只进 DOM 不产生视觉差异，不该回来');
assert.ok(clientCode.indexOf('"dsb-day"') !== -1, '`.dsb-day` 这个真实存在的类不能被顺手删掉');
assert.ok(/\.dsb-day-active\s+\.dsb-day-track\s*\{/.test(clientCode),
	'`.dsb-day-active` 是唯一真实生效的日柱类（有样式），必须保留');
/* 只删无效 class：tip.today 在同一个函数里还有真实用途（热力图灰阶、年条高亮今天） */
assert.ok(/heatGrid\([^)]*tip\.today\)/.test(clientCode), 'heatGrid 仍要用 tip.today 判未来/过去灰阶');
assert.ok(/yearStrip\([^)]*tip\.today\)/.test(clientCode), 'yearStrip 仍要用 tip.today 高亮今天');
console.log('      已删除 dsb-day-today，且 dsb-day / dsb-day-active / tip.today 的真实用途都还在');

/* ======================================================================
   ② shot.cjs 的注释与实现必须一致
   ====================================================================== */
console.log('\n===== ② tools/shot.cjs 的注释与实现一致（币种下拉收起） =====');
const pricingStart = shotSource.indexOf('function pricingShot');
const pricingEnd = shotSource.indexOf('function statusbarShot');
assert.ok(pricingStart > 0 && pricingEnd > pricingStart, 'tools/shot.cjs 应同时有 pricingShot 与 statusbarShot');
const pricingBlock = shotSource.slice(pricingStart, pricingEnd);
const jsdocStart = shotSource.indexOf('/** 只要价格区');
assert.ok(jsdocStart !== -1 && jsdocStart < pricingStart, 'pricingShot 前面应有「只要价格区」那行 JSDoc');
const pricingJsdoc = shotSource.slice(jsdocStart, pricingStart);
assert.ok(pricingJsdoc.indexOf('收起') !== -1,
	'pricingShot 的 JSDoc 应写「币种下拉收起」—— 实现就是 presets[8] = false');
assert.strictEqual(pricingJsdoc.indexOf('摊开'), -1,
	'JSDoc 曾误写「摊开」，与实现（收起）矛盾，不该回来');
assert.ok(/presets\[8\]\s*=\s*false/.test(pricingBlock), 'pricingShot 仍要显式把币种下拉置为收起');
assert.ok(/presets\[8\]\s*=\s*false[^\n]*收起/.test(pricingBlock),
	'`presets[8] = false` 那行要标明「收起」，与 JSDoc 说法一致');
console.log('      JSDoc 说收起、实现 presets[8] = false、行内注释也是收起，三处一致');

/* ======================================================================
   ③ 用真实组件的 useState 顺序验证 presets 下标
   ====================================================================== */
console.log('\n===== ③ SettingsSection 的 useState 顺序 = pricingShot 的 presets 下标 =====');

/** 按出现顺序取 SettingsSection 自己的 useState 变量名（静态解析，用于给出可读的失败信息） */
function settingsStateNames(source) {
	const start = source.indexOf('function SettingsSection(props)');
	const end = source.indexOf('function apply(ctx)', start);
	assert.ok(start > 0 && end > start, 'client.js 里应有 SettingsSection 及其后的 apply');
	const body = source.slice(start, end);
	const names = [];
	const re = /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,[^\]]*\]\s*=\s*react\.useState\(/g;
	let one = re.exec(body);
	while (one !== null) {
		names.push(one[1]);
		one = re.exec(body);
	}
	return names;
}

/** 从 pricingShot 的注释里读回那张「hook 下标 → 变量名」表 */
function hookOrderFromComment(source) {
	const at = source.indexOf('SettingsSection 里 useState 的顺序');
	assert.ok(at !== -1, 'pricingShot 里应保留「SettingsSection 里 useState 的顺序」这张表');
	/* 只取「下标表」那一段：后面还跟着几段踩坑历史，里面也散落着数字与变量名
	   （例如「presets[3] 从 editing 变成 hostModel」），不能连它们一起解析 */
	const tail = source.indexOf('之前', at);
	const stop = tail === -1 ? source.indexOf('教训', at) : source.lastIndexOf('\n', tail);
	const block = source.slice(at, stop === -1 ? source.indexOf('教训', at) : stop);
	const re = /(\d{1,2})\s+([A-Za-z][A-Za-z0-9]*)/g;
	const pairs = [];
	let one = re.exec(block);
	while (one !== null) {
		pairs.push({ index: Number(one[1]), name: one[2] });
		one = re.exec(block);
	}
	pairs.sort((a, b) => a.index - b.index);
	assert.ok(pairs.length > 0, 'hook 顺序表应能解析出「数字 变量名」的条目');
	return pairs;
}

const names = settingsStateNames(clientSource);
const commentOrder = hookOrderFromComment(shotSource);
console.log('      源码里的顺序：' + names.map((one, at) => at + ' ' + one).join(' / '));
console.log('      注释里的顺序：' + commentOrder.map((one) => one.index + ' ' + one.name).join(' / '));
assert.deepStrictEqual(commentOrder.map((one) => one.name), names,
	'pricingShot 注释里的 hook 顺序表和 client.js 里 SettingsSection 的实际顺序不一致 —— '
	+ '必须回来重数一遍，并同步 pricingShot 里 presets 的下标');

/* 截图用的示例配置（与 shot.cjs 里 SETTINGS_CONFIG 同结构，只留渲染设置页需要的字段） */
const SETTINGS_CONFIG = {
	version: 7, contextMeter: true, currency: 'CNY', priceConfigured: true,
	segments: ['status', 'counts', 'cacheHit', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'],
	hidden: [],
	modelOrder: ['deepseek-flash', 'deepseek-v4-pro'],
	models: {
		'deepseek-flash': {
			tiered: true,
			peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
			offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
		},
		'deepseek-v4-pro': {
			tiered: true,
			peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
			offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 }
		}
	}
};

/**
 * 加载一份 client.js（与 tools/shot.cjs 的 loadPlugin 同构：vm + react 桩）。
 * 额外做两件事：
 *   · 记录每次 useState 的调用序号与初始值 —— 这就是「用真实组件数一遍顺序」；
 *   · presets[at] 有值就按它注入，用来做行为探针（某个下标到底是哪个 state）。
 */
function loadClient(presets) {
	const marker = '\t\texports.apply = apply;';
	let code = clientSource.replace(marker,
		'\t\texports.__hygiene = { zh: zh, en: en, CSS: CSS, SettingsSection: SettingsSection, StatusBar: StatusBar };\n'
		+ marker);
	assert.ok(code !== clientSource, 'client.js 里应能插桩导出组件（找 exports.apply 那行）');

	const store = new Map([[CONFIG_KEY, JSON.stringify(SETTINGS_CONFIG)]]);
	const fakeWindow = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => { store.set(k, v); },
			removeItem: (k) => { store.delete(k); }
		},
		innerWidth: 1200, innerHeight: 900,
		setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
		addEventListener: () => {}, removeEventListener: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

	const states = [];
	let stateIndex = 0;
	const reactStub = {
		createElement: (type, props, ...children) => ({
			type: type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((one) => one !== null && one !== undefined && one !== false)
		}),
		useState: (init) => {
			const at = stateIndex;
			stateIndex += 1;
			const value = typeof init === 'function' ? init() : init;
			states.push({ index: at, init: value });
			if (presets !== undefined && presets[at] !== undefined) return [presets[at], () => {}];
			return [value, () => {}];
		},
		useEffect: () => {},
		useLayoutEffect: () => {},
		useRef: () => ({ current: null }),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useSyncExternalStore: (subscribe, snapshot) => snapshot(),
		Fragment: Symbol('Fragment')
	};

	const sandbox = {
		window: fakeWindow,
		document: {
			documentElement: { classList: { add() {}, remove() {} } },
			querySelector: () => null,
			createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
			head: { appendChild() {} },
			addEventListener: () => {}, removeEventListener: () => {}
		},
		react: reactStub,
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	assert.ok(captured !== null && captured.factory !== undefined, '插件工厂没被捕获');
	const api = captured.factory((name) => (name === 'react' ? reactStub : undefined));
	assert.ok(api.__hygiene !== undefined, '插桩导出没拿到组件');
	return { shot: api.__hygiene, states: states };
}

/** 渲染一次设置页，拿回虚拟树与「数到的 useState 顺序」 */
function renderSettings(presets) {
	const loaded = loadClient(presets);
	const t = (key, params) => {
		const table = loaded.shot.zh;
		let out = table[key] === undefined ? key : table[key];
		if (params !== undefined && params !== null) {
			out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
		}
		return out;
	};
	let tree = null;
	try {
		tree = loaded.shot.SettingsSection({ t: t, useProjection: () => undefined });
	} catch (error) {
		assert.fail('渲染 SettingsSection 失败：' + error.message
			+ '（hook 下标可能已过期，先回来重数 useState 顺序）');
	}
	return { tree: tree, states: loaded.states };
}

function findAll(node, pred) {
	const out = [];
	(function step(one) {
		if (one === null || one === undefined || one === false || one === true) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		if (pred(one)) out.push(one);
		(one.children || []).forEach(step);
	})(node);
	return out;
}

function classOf(node) {
	const raw = node.props === undefined ? undefined : node.props.className;
	return typeof raw === 'string' ? raw : '';
}

function textOf(node) {
	const out = [];
	(function step(one) {
		if (typeof one === 'string' || typeof one === 'number') { out.push(String(one)); return; }
		if (one === null || one === undefined || one === false || one === true) return;
		if (Array.isArray(one)) { one.forEach(step); return; }
		if (typeof one !== 'object') return;
		(one.children || []).forEach(step);
	})(node);
	return out.join('');
}

/** shot.cjs 里 pricingShot 实际用的下标：4 = editing、5 = draft、8 = currencyOpen */
const assigned = [];
const assignRe = /presets\[(\d+)\]\s*=/g;
let assignOne = assignRe.exec(pricingBlock);
while (assignOne !== null) {
	assigned.push(Number(assignOne[1]));
	assignOne = assignRe.exec(pricingBlock);
}
assert.deepStrictEqual(assigned, [4, 5, 8],
	'pricingShot 的 presets 下标应为 4(editing) / 5(draft) / 8(currencyOpen)，实际 '
	+ JSON.stringify(assigned) + '；hook 顺序变了就要跟着改');

/* 名字层面的守卫：这三个下标各自应该是什么 */
['editing', 'draft', 'currencyOpen'].forEach((want, at) => {
	const index = [4, 5, 8][at];
	assert.strictEqual(names[index], want,
		'下标 ' + index + ' 应是 ' + want + '，实际是 ' + names[index]
		+ ' —— SettingsSection 的 hook 顺序变了，pricingShot 的 presets 必须回来重数');
});

/* ---- 行为探针：按 shot.cjs 的下标注入，看渲染出来是什么 ---- */
const shotPresets = [];
shotPresets[4] = 'deepseek-flash';
shotPresets[5] = {
	tiered: true,
	peak: { input: '2', cacheRead: '0.04', cacheWrite: '0', output: '8' },
	offPeak: { input: '1', cacheRead: '0.02', cacheWrite: '0', output: '4' }
};
shotPresets[8] = false;

const isEditPop = (node) => classOf(node).indexOf('dsb-edit-pop') !== -1;
const isSelectMenu = (node) => classOf(node).indexOf('dsb-select-menu') !== -1;
const isSelectBtn = (node) => classOf(node).indexOf('dsb-select-btn') !== -1;

const base = renderSettings(shotPresets);
assert.strictEqual(base.states.length, names.length,
	'渲染时数到 ' + base.states.length + ' 个 useState，源码里数到 ' + names.length
	+ ' 个 —— 组件里可能有别处引入的 hook 或条件调用，必须回来重数');

const pops = findAll(base.tree, isEditPop);
assert.strictEqual(pops.length, 1,
	'presets[4] 应让恰好一张价格卡展开编辑区，实际 ' + pops.length
	+ ' 张展开 —— 下标 4 已经不是 editing 了');

const values = findAll(pops[0], (node) => node.type === 'input').map((node) => node.props.value);
['2', '0.04', '8', '1', '0.02', '4'].forEach((want) => {
	assert.ok(values.indexOf(want) !== -1,
		'编辑区里应出现草稿预设的值 ' + want + '（presets[5] 是 draft），实际 ' + JSON.stringify(values));
});

const baseBtn = findAll(base.tree, isSelectBtn);
assert.strictEqual(baseBtn.length, 1, '展开的编辑区里应有一个币种下拉按钮');
assert.strictEqual(baseBtn[0].props['aria-expanded'], 'false',
	'presets[8] = false 时币种下拉应处于收起状态（aria-expanded="false"）');
assert.strictEqual(findAll(base.tree, isSelectMenu).length, 0,
	'presets[8] = false 时不该渲染出币种菜单（.dsb-select-menu）');

/* 反证 1：把下标 8 换成 true，菜单必须出现 —— 证明 8 确实是 currencyOpen */
const openPresets = shotPresets.slice();
openPresets[8] = true;
const openedTree = renderSettings(openPresets).tree;
const openBtn = findAll(openedTree, isSelectBtn);
assert.strictEqual(openBtn.length, 1, '展开状态下应有币种下拉按钮');
assert.strictEqual(openBtn[0].props['aria-expanded'], 'true',
	'presets[8] = true 时币种下拉应展开 —— 否则下标 8 不是 currencyOpen');
assert.strictEqual(findAll(openedTree, isSelectMenu).length, 1,
	'presets[8] = true 时应渲染出币种菜单（.dsb-select-menu）');

/* 反证 2：不注入下标 4（editing 保持初值 null），一张卡都不该展开 */
const noEdit = shotPresets.slice();
noEdit[4] = undefined;
assert.strictEqual(findAll(renderSettings(noEdit).tree, isEditPop).length, 0,
	'不注入下标 4 时不该有卡片展开 —— 说明下标 4 是 editing');

/* 反证 3：不注入下标 5（draft 保持初值 null），同样展不开 */
const noDraft = shotPresets.slice();
noDraft[5] = undefined;
assert.strictEqual(findAll(renderSettings(noDraft).tree, isEditPop).length, 0,
	'不注入下标 5（draft 为 null）时卡片展不开 —— 说明下标 5 是 draft');

/* 历史上的坑：草稿对象被塞进 holidayNote，卡片里会冒出一句「抓取失败（undefined）」 */
assert.strictEqual(textOf(base.tree).indexOf('抓取失败'), -1,
	'按 shot.cjs 的下标注入后不该出现「抓取失败」—— 那是草稿被塞进 holidayNote 的症状');

/* shot.cjs 里的 draft 必须自带 currency：下拉按钮显示的是 draft.currency 而不是 config.currency，
   漏了它英文截图会退回默认的 CNY，与整页英文界面自相矛盾（2026-10 实际踩过）。 */
assert.ok(/presets\[5\][\s\S]*?currency:\s*'(USD|CNY)'/.test(pricingBlock),
	'pricingShot 的 draft 预设必须写 currency（英文截图靠它显示 USD，漏了会退回 CNY）');
const shotCurrency = /currency:\s*'(\w+)'/.exec(pricingBlock);
assert.ok(shotCurrency !== null, 'pricingShot 里应能找到币种预设');
console.log('      截图 draft 带 currency：' + shotCurrency[1] + '（下拉按钮显示它，不是 config.currency）');

/* ------------------------------------------------- 禁选（拖动不刷蓝底） */
/* 用户拍板：底栏、底栏气泡、设置页按住鼠标拖动会刷出蓝色选中底，看着像出了 bug。
   这几处都是插件自己画的纯展示/操作界面，没有复制文字的需求。
   ::selection 也要写透明 —— 只写 user-select:none 时，某些内核在「先按下再拖动」
   的路径上仍会画一层选中色。 */
const cssText = loadClient([]).shot.CSS;
assert.ok(typeof cssText === 'string' && cssText.length > 0, '样式表是字符串（能直接断言规则）');
const escSel = (one) => one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SELECTION_OFF = ['.dsb-root', '.dsb-tip', '.dsb-settings', '.dsb-hover-plain', '.dsb-drag-card'];
SELECTION_OFF.forEach((selector) => {
	assert.ok(new RegExp(escSel(selector) + '[^{}]*\\{[^}]*user-select:none').test(cssText),
		selector + ' 必须禁选（拖动时不能刷出蓝色选中底）');
	assert.ok(new RegExp(escSel(selector) + '[^{}]*\\{[^}]*webkit-user-select:none').test(cssText),
		selector + ' 还要带 -webkit- 前缀（内核差异）');
});
assert.ok(/::selection[^{}]*\{[^}]*background:transparent/.test(cssText),
	'::selection 要写透明背景（不能只靠 user-select:none）');
['.dsb-root', '.dsb-tip', '.dsb-settings'].forEach((selector) => {
	assert.ok(new RegExp(escSel(selector) + '[^{}]*::selection').test(cssText),
		selector + ' 也要覆盖 ::selection');
});
/* 禁选不能把设置页的输入框一起禁掉 —— 改价格那几个框还要能点进去编辑 */
assert.ok(/\.dsb-settings input[^{}]*\{[^}]*user-select:text/.test(cssText),
	'设置页输入框单独放开 user-select:text（禁选不能把编辑功能误伤）');
const offAt = cssText.indexOf('.dsb-root,.dsb-tip,.dsb-settings');
const onAt = cssText.indexOf('.dsb-settings input');
assert.ok(offAt !== -1 && onAt !== -1, '禁选规则与输入框规则都在样式表里');
assert.ok(onAt > offAt, '输入框的 user-select:text 写在禁选之后，层叠才能覆盖它');
console.log('      禁选：' + SELECTION_OFF.join(' / ') + ' 全部 user-select:none + ::selection 透明；输入框保留可编辑');

console.log('      渲染实测：' + names.length + ' 个 useState；'
	+ '下标 4 = editing（展开第一张卡）、下标 5 = draft（框里显示预设值）、下标 8 = currencyOpen（false 收起 / true 展开）');
console.log('\n全部通过');
