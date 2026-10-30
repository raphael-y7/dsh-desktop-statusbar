/**
 * 开发模式：入口手势（未解锁连点 5 次 / 解锁后单击）、四种状态循环、跨页面常驻，
 * 且**绝不真安装**。
 *
 * 这段逻辑的目的就是「让作者亲眼看到更新按钮怎么表现」，所以本测试要证明五件事：
 *   1. 入口手势正确：**未解锁**时连点 5 次进入，间隔太久要重新计数；
 *   2. 解锁记忆正确：进入成功后把当前 VERSION 写进 localStorage，之后**单击即可进出**；
 *      VERSION 变了（升级）旧记录自动失配 ⇒ 重新要求连点 5 次；写不进 localStorage
 *      （无痕模式）时安全退化成每次连点；
 *   3. 状态循环完整：空闲 → 更新中 → 已更新 → 更新失败 → 空闲；
 *   4. **关掉设置页不关开发模式**：开发模式是模块级开关，跨页面常驻（用户已确认这是预期行为），
 *      关页面不等于要退出，退出只能靠版本号手势；
 *   5. **一次都不发安装请求** —— 开发模式必须纯本地，否则就变成了偷偷装东西。
 *   6. **开发模式就是主插件的一部分**：没有独立组件、没有探测请求、没有轮询。
 *      入口判断纯本地（连点计数 + 解锁记录），一次网络往返都不需要。
 *
 * localStorage 替身是**真实可读写**的 Map（存解锁记录用），测试里可随时 clear() 模拟
 * 「首次安装 / 换个浏览器」。React 替身的 `useEffect` 会**同步执行并收集 cleanup**，
 * 这样才能真的走一遍设置页的「挂载 → 卸载」（见 mountAndUnmountSettings）。
 *
 * 用法：node tests/verify-dev-mode.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
/* 这份 __test 列表会**覆盖** client.js 末尾自带的那份（插在 `exports.apply` 之前），
   所以要测的东西必须在这里列全：开发模式的解锁键、轮次入口、以及**设置页组件本身**
   （最后一项用来真挂载/卸载设置页，验证「卸载不关开发模式」）。
   注意 `devRoundOf` 在 client.js 自带那份里是**内联箭头函数**（不是具名函数），这里照写一份
   —— `devRound` 是同一作用域里的 `let`，闭包读得到当前值。 */
code = code.replace(marker, '\t\texports.__test = { startPluginUpdate, snapshotUpdate, setUpdateState, setDevMode, runDevPreview, isDevMode, onVersionClick, DEV_VERSION, DEV_FAIL_REASON, DEV_CLICKS, DEV_CLICK_WINDOW_MS, DEV_UNLOCK_KEY, devRoundOf: () => devRound, SettingsSection: SettingsSection, StatusBar: StatusBar, devFieldScenesOf: () => Object.assign({}, devFieldScenes) };\n' + marker);

/* ------------------------------------------------------------ 最小替身 */
/* localStorage 替身必须是**真实可读写**的 Map（原来是 getItem 恒返回 null 的空壳）：
   开发模式的解锁状态就存在这里 —— 空壳等于"写进去永远读不出来"，
   「解锁后单击即可进出」和「VERSION 变了重新要求连点 5 次」两条断言都无法验证。
   storage 提到外面，测试里可以随时清空来模拟"清 localStorage"或"换个浏览器"。 */
const storage = new Map();
const localStorageStub = {
	getItem: (key) => (storage.has(key) ? storage.get(key) : null),
	setItem: (key, value) => { storage.set(key, String(value)); },
	removeItem: (key) => { storage.delete(key); },
	clear: () => { storage.clear(); }
};
const sandbox = {
	window: {
		localStorage: localStorageStub,
		fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
		setInterval: () => 0,
		clearInterval() {},
		setTimeout: () => 0,
		clearTimeout() {},
		requestAnimationFrame: (fn) => { fn(); return 0; },
		cancelAnimationFrame: () => {},
		addEventListener: () => {}, removeEventListener: () => {},
		open: () => null
	},
	document: {
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ innerHTML: '', dataset: {}, style: {}, appendChild() {}, querySelector: () => null, className: '' }),
		body: {}, head: { appendChild() {} },
		addEventListener: () => {}, removeEventListener: () => {}
	},
	MutationObserver: class { observe() {} disconnect() {} },
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
	setTimeout, clearTimeout,
	requestAnimationFrame: (fn) => { fn(); return 0; },
	cancelAnimationFrame: () => {}
};
sandbox.globalThis = sandbox;
let captured = null;
sandbox.window.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

/* 卸载时会被执行的 effect cleanup。真挂载设置页之前先清空、卸载后再一个个跑掉 ——
   这是本测试「模拟设置页卸载」的唯一手段（没有真 DOM，也就没有真的 React 卸载）。
   `useEffect` 替身**同步**执行回调并收好 cleanup：设置页里那几个 effect 都是
   「注册监听 → 返回移除函数」的形态，同步执行即可复现。 */
let effectCleanups = [];

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') {
		return {
			/* 保留 type/props/children：⑰ 要按 className 找段、再看它的 onClick。
			   原来写成 `() => ({})`，拿到的树是个空对象，任何结构断言都测不到东西。 */
			createElement: (type, props, ...children) => ({ type: type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) }),
			useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
			useEffect: (fn) => {
				const out = fn();
				if (typeof out === 'function') effectCleanups.push(out);
			},
			useRef: (init) => ({ current: init === undefined ? null : init }),
			useSyncExternalStore: (sub, snap) => snap(),
			useCallback: (fn) => fn, useMemo: (fn) => fn(), Fragment: Symbol('Fragment')
		};
	}
	if (name === 'react-dom') throw new Error('no react-dom');
	throw new Error('unexpected require: ' + name);
}).__test;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------- 网络请求的记录器
 *
 * 开发模式组件已经**合并回主插件**（没有独立开关了），所以「组件开没开」这件事不再需要
 * 客户端去问宿主 —— 那套探测/轮询（`/api/dev-mode` 路由、5 秒核对）全部删掉了。
 *
 * 这里保留的是**记录所有 fetch** 的能力：本文件最关键的硬约束之一是
 * 「开发模式进入后 0 次真实请求」，需要把发出的 URL 全记下来逐个断言。
 * 默认响应是「没有新版」，其余 URL 交给 extra 处理。
 */
const fetchLog = [];
function setFetch(extra) {
	sandbox.window.fetch = (url, options) => {
		const one = String(url);
		fetchLog.push(one);
		if (typeof extra === 'function') return extra(one, options);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ hasUpdate: false, latest: null }) });
	};
}

/**
 * 模拟「打开一次设置页再关掉」：`SettingsSection` 是个函数组件，调用一次 = 挂载
 * （替身里 useEffect 同步执行），随后跑光它注册的 cleanup = 卸载。
 *
 * 为什么必须**真的挂载一次**，而不是直接调 setDevMode(false) 来假装：
 * 本次的行为变更正是「卸载回调里不再复位开发模式」。若卸载路径没有被代码覆盖，
 * 直接把开发模式关掉的测试永远测不出这个 bug。
 *
 * 返回 `{ mounted, cleanupCount }`：挂载是否成功、卸载跑了几个 cleanup（> 0 才说明
 * 卸载路径真的被走到了）。
 */
function mountAndUnmountSettings(extraProps) {
	effectCleanups = [];
	let mounted = false;
	try {
		const node = api.SettingsSection(Object.assign({ t: (key) => '<' + key + '>' }, extraProps));
		mounted = node !== null && node !== undefined;
	} finally {
		const cleanups = effectCleanups;
		effectCleanups = [];
		/* 长度要在跑 cleanup **之前**记下来：跑完数组就空了 */
		const cleanupCount = cleanups.length;
		while (cleanups.length > 0) {
			const one = cleanups.pop();
			try { one(); } catch (error) { /* 单个 cleanup 失败不影响其余 */ }
		}
		return { mounted: mounted, cleanupCount: cleanupCount };
	}
}

/**
 * 渲染一次 StatusBar（拿不到真 DOM 就只能直接调组件函数）。
 *
 * 它只是「底栏能在这套最小替身下渲染出来」的冒烟渲染（有 useState/useEffect 等），
 * 渲染崩了别的断言也会跟着失真。开发模式现在没有任何"组件在不在"的渲染期信号 ——
 * 它就是主插件的一部分。
 */
function renderStatusBar() {
	effectCleanups = [];
	const t = (key) => '<' + key + '>';
	const node = api.StatusBar({
		t: t,
		sessionId: 's1',
		useProjection: () => undefined,
		useSession: (selector) => (selector === undefined ? undefined : selector({
			running: false, partial: null, runningCalls: [], lastAgentError: null
		})),
		useSessions: () => undefined,
		useChat: () => undefined
	});
	/* 渲染期间注册的 effect 已经同步跑完（替身的 useEffect 就是立刻调用），
	   这里顺手把 cleanup 也跑掉：底栏里有定时器，攒着会污染后面几次渲染。 */
	const cleanups = effectCleanups;
	effectCleanups = [];
	while (cleanups.length > 0) {
		const one = cleanups.pop();
		try { one(); } catch (error) { /* 单个 cleanup 失败不影响其余 */ }
	}
	return node;
}

/* ---------------------------------------------------------- 渲染辅助（⑰⑰-b 用）
 * 这两条要断言"某段可点 / 点它会推进"，所以需要一个能 ① 注入任意投影、
 * ② 把树收集成可查询结构 的渲染器。 */

/**
 * 底栏渲染用的**真实中文词表**（只收本文件断言会读到的键）。
 *
 * 为什么不能像别的用例那样用 `(key) => "<" + key + ">"`：
 *   `segmentText` 的横杠占位文案是拿 `unitCountTurns` / `SEGMENTS.short` /
 *   `f_balanceDash` 这些键拼出来的；键名对不上就返回空串，而渲染处 `view.text === ""`
 *   会**整段跳过** —— 于是"空态段"根本渲染不出来，这条测试变成测空气。
 */
const barT = (key, params) => {
	const dict = {
		segStatus: '峰谷判断', segCounts: '轮次＆步数', segTtft: '首字延迟', segCacheHit: '缓存命中率',
		segTps: '输出速度', segSessionTime: '运行用时', segCost: '会话费用', segLastCost: '本次费用',
		segBalance: '余额', segContext: '上下文占用',
		f_peak: '高峰', f_valley: '低谷', f_counts: '{turns} 轮 {steps} 步',
		f_ttft: '首字平均 {duration}', f_cacheHit: '综合命中 {percent}%',
		f_speed: '综合速度 {throughput}t/s', f_sessionTime: '总用时 {duration}',
		f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
		f_balance: '余额 {symbol}{amount}', f_balanceDash: '余额 {symbol}-',
		f_balanceSubCent: '余额 <{symbol}0.01',
		unitCountTurns: ' 轮', unitCountSteps: ' 步',
		tipEmptyTitle: '{label}',
		tipEmptyBody: '该字段当前没有数据。开发模式下点开它会推进到下一组假数据场景，不会停在这一态。',
		tipCountsTitle: '会话数据', tipWeekTitle: '活跃总览', tipCreditsTitle: '积分套餐',
		tipCountsCompactAt: '上下文压缩', tipCountsSkills: '技能注入', tipCountsToolCalls: '工具调用',
		tipTopUp: '充值余额', tipGranted: '赠金余额', tipQuotaLeft: '剩余配额',
		tipTtftTurn: '本轮平均首字', tipTtftFast: '最快首字延迟', tipTtftSlow: '最慢首字延迟',
		tipHitTurn: '本轮命中率', tipHitHigh: '最高命中率', tipHitLow: '最低命中率',
		tipTpsTurn: '本轮平均速度', tipTpsFast: '最快输出速度', tipTpsSlow: '最慢输出速度',
		tipWaitTime: '等待用时', tipModelTime: '模型用时', tipToolTime: '工具调用',
		tipManual: '手动触发', tipSub: '子能力',
		tipCompactItem: '第{index}次压缩', tipCompactWhere: '第{turn}轮{step}步',
		tipCompactAfter: '第{turn}轮后', tipCompactTurnOnly: '第{turn}轮',
		f_tokensTotal: '总计用量', f_tokensTurn: '本轮用量',
		hoverCalls: '请求次数', hoverCost: '消费', hoverYearAll: '全年合计',
		f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出'
	};
	let out = dict[key] === undefined ? '<' + key + '>' : dict[key];
	if (params) out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
	return out;
};

/** 按名字取投影（未提供的名字一律 undefined，与真实宿主"没这个投影"同义）。 */
function projectionsFor(table) {
	return (name) => (table !== undefined && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined);
}

/** 渲染底栏并返回节点树（投影由 table 指定）。 */
function renderStatusBarWith(table) {
	effectCleanups = [];
	let node = null;
	try {
		node = api.StatusBar({
			t: barT,
			sessionId: 's-empty',
			useProjection: projectionsFor(table),
			useSession: (selector) => (selector === undefined ? undefined : selector({
				running: false, partial: null, runningCalls: [], lastAgentError: null
			})),
			useSessions: () => undefined,
			useChat: () => undefined
		});
	} finally {
		const cleanups = effectCleanups;
		effectCleanups = [];
		while (cleanups.length > 0) {
			const one = cleanups.pop();
			try { one(); } catch (error) { /* 忽略单个 cleanup 失败 */ }
		}
	}
	return node;
}

/** 开发模式开着时的底栏渲染（投影一律 undefined，让 fixture 全部接管）。 */
function renderStatusBarInDev() {
	return renderStatusBarWith(undefined);
}

/** 收集某类名的节点（按 props.className 分词匹配）。 */
function collectByClass(node, name) {
	const out = [];
	(function walk(one) {
		if (one === null || one === undefined || one === false) return;
		if (Array.isArray(one)) { one.forEach(walk); return }
		if (typeof one !== 'object') return;
		const cls = one.props === undefined ? undefined : one.props.className;
		if (typeof cls === 'string' && cls.split(' ').indexOf(name) !== -1) out.push(one);
		if (one.children !== undefined) walk(one.children);
	})(node);
	return out;
}

(async () => {
	/* ---------------- ① 入口手势：未解锁时连点 5 次才能进入 ---------------- */
	assert.strictEqual(api.isDevMode(), false, '默认不在开发模式');
	assert.strictEqual(api.DEV_CLICKS, 5, '连点次数应当是 5');
	/* 解锁记录里存的就是当前 VERSION，从源码里读出来当断言基准（不写死版本号，
	   否则每次发版这条测试都要跟着改）。 */
	const VERSION = (/\bconst VERSION = "([^"]+)"/.exec(fs.readFileSync(PLUGIN, 'utf8')) || [])[1];
	assert.ok(typeof VERSION === 'string' && VERSION.length > 0, '从 client.js 里读得到 VERSION 常量');

	/* 前置：清空 localStorage，模拟「首次安装 / 换个浏览器」——
	   只有真清空了，下面才分得清「未解锁要连点」与 ⑧b「解锁后单击」两种手势。
	   （替身是真 Map，不清就会继承上一个用例留下的解锁记录。） */
	storage.clear();
	assert.strictEqual(storage.size, 0, '前置：解锁记录已清空（未解锁状态）');

	for (let i = 1; i < api.DEV_CLICKS; i += 1) {
		const state = api.onVersionClick();
		assert.strictEqual(api.isDevMode(), false, '第 ' + i + ' 次点击还不该进入');
		assert.strictEqual(state.count, i, '计数应当是 ' + i);
	}
	api.onVersionClick();   /* 第 5 次 */
	assert.strictEqual(api.isDevMode(), true, '连点 5 次后进入开发模式');
	console.log('① 连点 ' + api.DEV_CLICKS + ' 次 → 进入开发模式');

	/* 进入后状态摆成「有新版本可更新」，版本号是演示用的假号 */
	const opened = api.snapshotUpdate();
	assert.strictEqual(opened.hasUpdate, true, '开发模式下更新按钮常驻');
	assert.strictEqual(opened.latest, api.DEV_VERSION, '演示版本号是假的 ' + api.DEV_VERSION);
	assert.strictEqual(opened.busy, false, '初始不进忙碌态');
	assert.strictEqual(opened.note, null, '初始没有结论');
	console.log('② 进入后：按钮常驻，演示版本号 ' + opened.latest);

	/* ---------------- ③ 状态循环 ---------------- */
	/* 先清空 fetchLog：从"已进入开发模式"这一刻开始计数（⑦ 断言的就是这一段）。 */
	setFetch();
	fetchLog.length = 0;
	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().busy, true, '第一次点击进入「更新中」');
	console.log('③ 点击 1 → 更新中（busy=true）');

	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().busy, false, '更新中结束');
	assert.strictEqual(api.snapshotUpdate().note, 'done', '进入「已更新」');
	console.log('④ 自动推进 → 已更新（note=done）');

	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().note, 'failed', '第二次点击进入「更新失败」');
	assert.strictEqual(api.snapshotUpdate().reason, api.DEV_FAIL_REASON, '带出失败原因（走真实失败显示路径）');
	console.log('⑤ 点击 2 → 更新失败（reason=' + api.DEV_FAIL_REASON + '）');

	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().note, null, '第三次点击回到空闲');
	assert.strictEqual(api.snapshotUpdate().hasUpdate, true, '仍处于开发模式，按钮还在');
	console.log('⑥ 点击 3 → 回到空闲，可再点一遍');

	/* ---------------- ⑦ 关键：**进入之后**整轮演示一次真实请求都没发 ---------------- */
	/* 这里钉的是「进入开发模式之后」：演示状态机跑一整轮、设置页挂载、底栏渲染，
	   都不许有任何真实请求（尤其不许真的去装东西）。 */
	await settle();
	assert.deepStrictEqual(fetchLog, [],
		'开发模式**进入后**不得发任何真实请求，实际：' + JSON.stringify(fetchLog));
	console.log('⑦ 进入开发模式之后：0 次真实请求（纯本地，绝不安装）');

	/* ---------------- ⑧ 解锁后单击即可退出（新手势） ---------------- */
	/* ① 里连点 5 次**进入**时已经把当前 VERSION 记进 localStorage（见 onVersionClick 的
	   rememberDevUnlock）⇒ 现在处于「已解锁」状态，退出只要单击一下，不用再连点 5 次。
	   这正是本次要加的那条行为：作者反复进出调试时不该每次点 5 下。 */
	setFetch();
	assert.strictEqual(storage.get(api.DEV_UNLOCK_KEY), VERSION,
		'前置：连点进入成功时应当把当前 VERSION 写进解锁记录，实际 ' + JSON.stringify(storage.get(api.DEV_UNLOCK_KEY)));
	const roundBeforeExit = api.devRoundOf();
	api.onVersionClick();   /* 只点 1 次 */
	assert.strictEqual(api.isDevMode(), false, '已解锁时单击 1 次就退出开发模式（不再要求连点 5 次）');
	await settle();
	const closed = api.snapshotUpdate();
	assert.strictEqual(closed.hasUpdate, false, '退出后按真实自检结果：没有新版就不显示按钮');
	assert.strictEqual(closed.latest, null, '演示版本号被清掉');
	assert.strictEqual(api.devRoundOf(), roundBeforeExit, '退出不推进轮次（devRound 只在进入时 +1）');
	console.log('⑧ 已解锁 ⇒ 单击 1 次退出，恢复真实自检结果');

	/* ---------------- ⑧b 解锁后单击即可再进入，且每进一次推进一轮假数据 ---------------- */
	api.onVersionClick();   /* 还是单击 */
	assert.strictEqual(api.isDevMode(), true, '已解锁时单击 1 次就能重新进入（进出都只要一下）');
	assert.strictEqual(api.devRoundOf(), roundBeforeExit + 1,
		'每进入一次开发模式 devRound +1（假数据换下一轮），实际 ' + api.devRoundOf());
	assert.strictEqual(api.snapshotUpdate().latest, api.DEV_VERSION, '重新进入后演示版本号又挂上');
	assert.strictEqual(storage.get(api.DEV_UNLOCK_KEY), VERSION, '进入时再次写入解锁记录（幂等）');
	api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '再单击 1 次又退出');
	console.log('⑧b 解锁后单次点击可反复进出，每次进入 devRound +1（当前第 ' + api.devRoundOf() + ' 轮）');

	/* ---------------- ⑧c 版本变了（解锁记录过期）⇒ 重新要求连点 5 次 ---------------- */
	/* 解锁记的是「解锁时的 VERSION」。作者升级插件后 VERSION 常量变了，旧记录自动失配，
	   于是又回到「连点 5 次」—— 不用写任何迁移代码。这里把记录改成别的版本号来模拟。 */
	storage.set(api.DEV_UNLOCK_KEY, '0.0.0');
	assert.notStrictEqual(storage.get(api.DEV_UNLOCK_KEY), VERSION, '前置：解锁记录已改成旧版本 0.0.0');
	api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '解锁记录与当前 VERSION 不符 ⇒ 单击不生效（不能一键进入）');
	for (let i = 2; i < api.DEV_CLICKS; i += 1) {
		api.onVersionClick();
		assert.strictEqual(api.isDevMode(), false, '第 ' + i + ' 次点击还不该进入（旧记录已失效）');
	}
	api.onVersionClick();   /* 第 5 次 */
	assert.strictEqual(api.isDevMode(), true, '版本变了 ⇒ 重新连点 5 次才能进入');
	assert.strictEqual(storage.get(api.DEV_UNLOCK_KEY), VERSION,
		'进入成功后把**当前** VERSION 写回去（升级后的第一次连点会刷新记录），实际 '
		+ JSON.stringify(storage.get(api.DEV_UNLOCK_KEY)));
	api.onVersionClick();   /* 已解锁 ⇒ 单击退出，为 ⑨ 复位 */
	assert.strictEqual(api.isDevMode(), false, '退出（此时记录已刷新，单击即可）');
	console.log('⑧c 解锁记录 = 旧版本 0.0.0 ⇒ 单击无效、重新连点 5 次；进入后记录刷新为当前版本');

	/* ---------------- ⑧d 无痕模式（localStorage 写不进去）⇒ 安全退化成每次都要连点 ---------------- */
	/* 这是原第 ⑧ 条「连点 5 次也能退出」的归宿：解锁持久化之后，正常路径下进入即写记录 ⇒
	   退出只要单击。**只有写不进去时**才不会留下记录，于是进出都还得连点 5 次。
	   同时验证 localStorage 抛错被 try/catch 兜住（不许把异常冒到 onClick 上，
	   否则界面上就是「点了完全没反应」）。 */
	const realSetItem = localStorageStub.setItem;
	localStorageStub.setItem = () => { throw new Error('QuotaExceededError: 无痕模式'); };
	storage.clear();
	assert.strictEqual(api.isDevMode(), false, '前置：不在开发模式');
	for (let i = 1; i <= api.DEV_CLICKS; i += 1) api.onVersionClick();
	assert.strictEqual(api.isDevMode(), true, '写不进 localStorage 也要能连点进入（存储坏了不能连门都进不去）');
	assert.strictEqual(storage.get(api.DEV_UNLOCK_KEY), undefined, '写失败 ⇒ 解锁记录根本没落下');
	for (let i = 1; i < api.DEV_CLICKS; i += 1) {
		api.onVersionClick();
		assert.strictEqual(api.isDevMode(), true, '既没解锁记录，点 ' + i + ' 次不该退出');
	}
	api.onVersionClick();   /* 退出方向的第 5 次 */
	assert.strictEqual(api.isDevMode(), false, '没解锁记录 ⇒ 退出同样要连点 5 次（每次都连点，安全退化）');
	localStorageStub.setItem = realSetItem;
	console.log('⑧d 无痕模式（写 localStorage 抛错）：异常被兜住，进出都照旧连点 5 次');

	/* ---------------- ⑨ 慢点不算：间隔超过时间窗就重新计数 ---------------- */
	/* 必须先清掉解锁记录：⑧/⑧c 把 VERSION 写进了 localStorage，留着的话
	   下面第一下点击就走了「单击切换」分支，根本不会进连点计数 —— 这一条测的正是计数。 */
	storage.clear();
	assert.strictEqual(api.isDevMode(), false, '前置：已退出开发模式');
	api.onVersionClick();
	api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '点了 2 次还没进');
	/* 等到超过时间窗，再点一次应当从 1 重新数（而不是接着累到 3） */
	await waitFor(api.DEV_CLICK_WINDOW_MS + 200);
	const afterGap = api.onVersionClick();
	assert.strictEqual(afterGap.count, 1, '间隔超时后重新从 1 计数（慢慢点不会误进），实际 ' + afterGap.count);
	assert.strictEqual(api.isDevMode(), false, '慢点 3 次不该进入');
	console.log('⑨ 慢点不误触：间隔超过 ' + api.DEV_CLICK_WINDOW_MS + 'ms 就重新计数（已先清解锁记录）');

	/* ---------------- ⑩ 退出会停掉在跑的定时器 ---------------- */
	api.setDevMode(true);
	api.runDevPreview();          /* 进入「更新中」，挂一个定时器 */
	assert.strictEqual(api.snapshotUpdate().busy, true, '演示进入更新中');
	api.setDevMode(false);        /* 中途退出 */
	assert.strictEqual(api.snapshotUpdate().busy, false, '退出立即停止演示，不留在忙碌态');
	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().note, null, '被取消的定时器不得迟到生效');
	console.log('⑩ 中途退出：定时器被清掉，没有迟到的状态更新');

	/* ---------------- ⑪ 更新中重复点击不叠加 ---------------- */
	setFetch();
	api.setDevMode(true);
	api.runDevPreview();
	api.runDevPreview();
	api.runDevPreview();
	assert.strictEqual(api.snapshotUpdate().busy, true, '更新中重复点击仍停在更新中');
	await waitFor(2600);
	assert.strictEqual(api.snapshotUpdate().note, 'done', '只推进一次，没有因多次点击而跳步');
	console.log('⑪ 更新中重复点击：被忽略，只推进一次');

	/* ---------------- ⑫ 关掉设置页**不**关开发模式（跨页面常驻） ---------------- */
	/* 用户拍板的语义：「开发模式跨页面一直存在，这是预料之中的呀」。
	   进入开发模式是模块级开关，设置页只是它唯一的入口与指示器；把设置页关掉
	   不等于要退出开发模式 —— 否则每次从设置页走开，底栏的假数据就凭空没了。

	   旧实现的 bug 正是这条：SettingsSection 卸载时的 effect cleanup 里
	   写了 `if (devMode === true) setDevMode(false)`。
	   所以这里必须**真的走一遍挂载 → 卸载**，而不是直接调 setDevMode(false) 假装；
	   直接假装的话，那段卸载复位存不存在都测不出来。 */

	/* ⑫-prep：先在**开发模式关着**的状态下挂一次设置页 ——
	   这一半同时钉住两件事：① 正常状态下设置页确实会去问真实 host 拿「当前会话使用」；
	   ② 这条平时唯一的常驻 effect 因此注册了 cleanup，卸载路径是真的被走到过的
	   （开发模式开着时它被 devOn 守卫挡掉、不注册 cleanup，见下面 ⑫ 的说明）。 */
	api.setDevMode(false);
	await settle();
	setFetch();
	const normalFetches = [];
	setFetch((url) => {
		normalFetches.push(url);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ model: 'deepseek-v4-pro' }) });
	});
	const normalMount = mountAndUnmountSettings({ useProjection: () => undefined });
	assert.strictEqual(normalMount.mounted, true, '开发模式关着时设置页能挂载');
	assert.strictEqual(normalFetches.filter((one) => one === '/dsh-desktop-statusbar/api/active-model').length, 1,
		'开发模式关着时，设置页照常拉一次真实当前会话模型，实际 ' + JSON.stringify(normalFetches));
	assert.ok(normalMount.cleanupCount > 0,
		'开发模式关着时设置页注册了 effect cleanup（卸载路径确实被走到，实际 '
		+ normalMount.cleanupCount + ' 个）');
	assert.strictEqual(api.isDevMode(), false, '⑫-prep 结束后仍在非开发模式');
	console.log('⑫-prep 非开发模式：设置页拉一次真实模型（1 次 fetch），并注册了可卸载的 effect');

	setFetch();
	/* 解锁记录先铺好，这样退出只要单击一下（下面要验的就是「点一次才退出」） */
	storage.set(api.DEV_UNLOCK_KEY, VERSION);
	api.setDevMode(true);
	assert.strictEqual(api.isDevMode(), true, '前置：开发模式正开着');
	const roundBeforeUnmount = api.devRoundOf();

	/* 开发模式开着时**一次真实请求都不许发**（项目硬约束）。这条以前抓不到：
	   ⑦ 只统计 runDevPreview 期间，而设置页挂载时那个 `ACTIVE_MODEL_URL` effect
	   当时没有 devOn 守卫 —— 审查者实测确实会发。现在真渲染一次设置页来钉住它。 */
	const devFetches = [];
	setFetch((url) => {
		devFetches.push(url);
		return Promise.resolve({ ok: true, json: () => Promise.resolve({ model: 'fake-should-not-matter' }) });
	});

	const mounted = mountAndUnmountSettings({ useProjection: () => undefined });
	assert.strictEqual(mounted.mounted, true, '设置页组件能挂载出节点（否则下面等于没测卸载）');
	await settle();
	assert.deepStrictEqual(devFetches, [],
		'开发模式开着时渲染设置页，真实 fetch 必须是 0，实际 ' + JSON.stringify(devFetches));
	/* 这里**不再**要求 cleanupCount > 0：开发模式开着时设置页把「当前会话使用」那条
	   fetch effect 整个跳过（硬约束：0 次真实 fetch），而其余 effect 在初始状态下
	   本来就不注册（编辑浮层没开、拖拽没开始）。0 个 cleanup 正是"没发请求"的旁证，
	   真正的卸载路径由上面的 ⑫-prep 覆盖。 */
	console.log('⑫-a 开发模式开着渲染设置页：真实 fetch = 0（active-model 也没发）');

	assert.strictEqual(api.isDevMode(), true,
		'关掉设置页之后开发模式**仍然开着**（跨页面常驻，不许自动复位）');
	assert.strictEqual(api.devRoundOf(), roundBeforeUnmount,
		'卸载不推进也不重置轮次（devRound 只随「进入」变化），实际 ' + api.devRoundOf());
	/* 演示态也还在：版本号、按钮可见性都是开发模式给的，卸载不该把它们清掉 */
	assert.strictEqual(api.snapshotUpdate().latest, api.DEV_VERSION,
		'卸载后演示版本号仍在（按钮还挂在开发模式的假版本上）');

	/* 卸载之后**再点一次版本号**（已解锁状态）才退出 —— 退出只能由用户手势触发 */
	api.onVersionClick();
	assert.strictEqual(api.isDevMode(), false, '卸载后单击版本号 1 次才退出开发模式');
	console.log('⑫ 关掉设置页 ⇒ 开发模式仍开着（devRound 不变），再单击版本号 1 次才退出');

	/* 反面对照：重挂设置页也不该把开发模式**打开**（开关只由手势控制）。
	   顺带验证 effect 的依赖里带了 devOn：退出开发模式之后重新挂载，
	   设置页必须**恢复**去问真实 host，否则它会一直停在「未识别」。 */
	storage.clear();
	devFetches.length = 0;
	const reopened = mountAndUnmountSettings({ useProjection: () => undefined });
	assert.strictEqual(reopened.mounted, true, '设置页能再次挂载');
	assert.strictEqual(api.isDevMode(), false, '重挂设置页不会自己进开发模式（入口只有连点版本号）');
	await settle();
	assert.strictEqual(devFetches.filter((one) => one === '/dsh-desktop-statusbar/api/active-model').length, 1,
		'退出开发模式后，设置页重新挂载会去取一次真实模型（依赖里带 devOn 才做得到），实际 '
		+ JSON.stringify(devFetches));
	console.log('⑫b 重挂设置页不会自行开启开发模式；退出开发模式后恢复真实取数');

	/* ---------------- ⑬ 真实更新路径不受开发模式影响 ---------------- */
	api.setDevMode(false);
	await settle();
	const realFetches = [];
	setFetch((url) => {
		realFetches.push(url);
		return new Promise(() => {});   /* 挂着，只看它有没有发请求 */
	});
	api.setUpdateState({ hasUpdate: true, latest: '9.9.9', busy: false, note: null, reason: null });
	api.startPluginUpdate();
	assert.strictEqual(realFetches.length, 1, '退出开发模式后，点击会打真实更新接口');
	assert.strictEqual(realFetches[0], '/dsh-desktop-statusbar/api/self-update', '打的是自有更新路由');
	assert.strictEqual(api.snapshotUpdate().busy, true, '真实更新不依赖 ctx.remote（空 ctx 下照常工作）');
	console.log('⑬ 退出后走真实路径：发出 1 次安装请求到自有路由');

	/* ============ ⑰ 空态也必须可点（P0：不加会把用户锁死在开发模式里）============
	 * 用户实测：开发模式翻到某个字段的空态（`- 轮 - 步` / `综合命中 - %` / `总计 ¥-`），
	 * 那一段**点不动** —— 因为 segmentView 返回 null 时占位对象没有 tip，
	 * 而渲染处是「tip !== null 才挂 onClick」。点不开就没法推进场景，直接被锁死。
	 * 这里钉两件事：① 空态段有 tip（可点）② 点它会推进该字段的计数。 */
	storage.clear();
	api.setDevMode(false);
	setFetch();
	{
		/* 造一个"全字段空态"的底栏：stats 全 0、usage 全 0、timeRange 0、抓不到价、余额 ok:false。
		   直接调 StatusBar 会让 devFixture 覆盖这些值，所以这里走**非开发模式**的真实投影路径 ——
		   空态可点这件事本身与开发模式无关（正式模式下"没数据"同样该能点开看一眼）。 */
		const emptyBar = renderStatusBarWith({
			sessionStats: { turns: 0, steps: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, toolMs: 0, llmMs: 0 },
			tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			contextPressure: null,
			desktopStatusbarActiveTime: { turns: 0, since: null, steps: 0, stepSince: null },
			desktopStatusbarUsage: { models: {}, calls: [], overflow: {}, current: null, turn: null, summaryParts: null },
			desktopStatusbarBalance: { ok: false }
		});
		const segs = collectByClass(emptyBar, 'dsb-seg');
		const clickable = collectByClass(emptyBar, 'dsb-seg-click');
		assert.ok(segs.length >= 5, '空态底栏渲染出多个段，实际 ' + segs.length);
		assert.ok(clickable.length >= 5,
			'**空态段必须可点**（tip 存在才挂 onClick）—— 否则用户被锁死在空态里，实际可点 '
			+ clickable.length + ' / 总段 ' + segs.length);
		/* 逐段确认：每个渲染出来的段要么是"有数据的可点段"，要么是"空态可点段"，没有死块 */
		segs.forEach((node) => {
			const key = String(node.props.key);
			assert.strictEqual(typeof node.props.onClick, 'function',
				'段 ' + key + ' 没有 onClick —— 空态死块又回来了（用户被锁死的根因）');
		});
		console.log('⑰ 空态段全部可点：' + clickable.length + ' / ' + segs.length + '，没有死块');
	}

	/* ⑰-b 点空态会推进该字段的场景计数（真正解决"出不来"） */
	storage.clear();
	api.setDevMode(true);
	assert.strictEqual(api.isDevMode(), true, '前置：开发模式开着');
	const beforeCounts = api.devFieldScenesOf().counts;
	const beforeClick = renderStatusBarInDev();
	/* 找到 counts 段并点它：开发模式下 counts 计数会 +1（进入下一格场景） */
	const countsSeg = collectByClass(beforeClick, 'dsb-seg').filter((one) => String(one.props.key) === '__segcounts')[0];
	assert.ok(countsSeg !== undefined, '找得到 counts 段');
	assert.strictEqual(typeof countsSeg.props.onClick, 'function', 'counts 段可点');
	countsSeg.props.onClick({ currentTarget: null, stopPropagation() {} });
	assert.strictEqual(api.devFieldScenesOf().counts, beforeCounts + 1,
		'点开字段后该字段场景计数 +1（这是"能翻到下一格"的唯一途径），实际 '
		+ api.devFieldScenesOf().counts + '（之前 ' + beforeCounts + '）');
	api.setDevMode(false);
	console.log('⑰-b 点开字段会推进场景计数（开发模式不会卡在同一格）');

	/* ============ ⑱ 开发模式整体零探测：组件已合并回主插件，这条路彻底没有了 ============
	   曾经有过 `/api/dev-mode` 探测路由（点版本号时问一次 + 开着时 5 秒核对一次），
	   随「不做独立组件」一并删除。这里留一条**反向守卫**：点版本号 + 反复渲染底栏，
	   整个过程中除了业务请求（价格库 / 余额 / 活跃总览）之外不许出现任何别的 URL ——
	   尤其不许再出现 `/api/dev-mode`。
	   为什么值得留：那套探测是被用户否掉的方案（单包只能一个客户端入口，组件关了代码
	   也不卸载，靠轮询"管控"名不副实）。留着这条能挡住以后有人又加回去。 */
	storage.clear();
	api.setDevMode(false);
	assert.strictEqual(api.isDevMode(), false, '前置：非开发模式');
	setFetch();
	fetchLog.length = 0;
	for (let i = 0; i < 5; i += 1) renderStatusBarInDev();
	assert.strictEqual(fetchLog.filter((one) => one.indexOf('/api/dev-mode') !== -1).length, 0,
		'渲染底栏不得发开发模式探测请求（那条路由与那套机制已经删掉了），实际 '
		+ JSON.stringify(fetchLog.filter((one) => one.indexOf('/api/dev-mode') !== -1)));
	/* 连点 5 次进入：入口是纯本地的，不许有网络往返 */
	fetchLog.length = 0;
	for (let i = 1; i <= api.DEV_CLICKS; i += 1) api.onVersionClick();
	assert.strictEqual(api.isDevMode(), true, '前置：连点 5 次进入（纯本地，不需要任何探测）');
	assert.deepStrictEqual(fetchLog, [],
		'连点进入开发模式全过程不得发任何请求（入口纯本地），实际 ' + JSON.stringify(fetchLog));
	/* 注意：非开发模式下**业务请求是正常的**（价格库 / 余额 / 活跃总览各一条），
	   所以上面只断言"探测请求为 0"，而不是"fetchLog 必须全空"。 */
	api.setDevMode(false);
	storage.clear();
	console.log('⑱ 零探测：渲染底栏 + 连点进入全程 0 请求（探测路由已随组件一起删除）');

	console.log('\nDEV MODE CHECKS PASSED');
})().catch((error) => {
	console.error('DEV MODE CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
