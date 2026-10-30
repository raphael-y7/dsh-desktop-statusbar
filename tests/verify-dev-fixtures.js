/**
 * 开发模式假数据矩阵（`devFixture`）的离线断言。
 *
 * 背景：开发模式每**进入**一次就推进一轮假数据（模块级 `devRound`，退出不清零）：
 *   余额轮   = ((devRound - 1) % 6) + 1
 *   工具场景 = ((devRound - 1) % 4) + 1
 * 所以反复进出 6 次能看全 6 种余额形态、4 次能看全 4 种工具数量场景。
 *
 * 这个测试要证明的是「6 × 4 的矩阵真的齐、取模真的能循环、其余假数据每轮都齐全」，
 * 而不是「界面长得好看」—— 排版由人工在开发模式里看。
 *
 * 测法照 tests/verify-subagent-total.js：用 vm 载入 client.js，把
 * `exports.apply = apply;` 那一行前插一份自己的 `exports.__test`（位置在文件自带那份之后 ⇒
 * 覆盖它），直接调纯函数 devFixture(round, t)。
 *
 * 与任务书的一处出入（以**代码实现**为准）：积分套餐的「相邻同名包聚合（×4）」不在
 * devFixture 里做，而在视图层 `creditsView` 里做；devFixture 给的是**聚合前**的 7 条原始
 * rewards（不带 count）。所以「有 count>1 的裂变聚合行」这条断言是**调 creditsView 之后**
 * 断言的，同时补验了原始数组的形状与相邻性（相邻是聚合能生效的前提）。
 *
 * 用法：node tests/verify-dev-fixtures.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');

/* ============================================================ vm 载入 client.js */
function loadClient() {
	let code = fs.readFileSync(CLIENT, 'utf8');
	const marker = '\t\texports.apply = apply;';
	assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
	/* `creditsView` 也一起导出：积分套餐的「相邻同名包聚合」是在**视图层**做的，
	   devFixture 给的 rewards 是**聚合前**的原始 7 条（见下面三 ③ 的说明），
	   所以「count > 1 的裂变聚合行」只能通过它来验证。
	   `isPeakTime` / `DEV_FIELD_KEYS` / 各格数常量用来验 agentState 与 9 个字段的形态矩阵。 */
	code = code.replace(marker,
		'\t\texports.__test = { devFixture, devBalanceFixture, devToolCounts, creditsView, isPeakTime,'
		+ ' readSubagentRunning, nextSubagentRunning,'
		+ ' DEV_BALANCE_ROUNDS, DEV_BALANCE_CLICK_SCENES, DEV_TOOL_ROUNDS, DEV_BUBBLE_SCENES,'
		+ ' DEV_STATUS_SCENES, DEV_COUNTS_SCENES, DEV_TTFT_SCENES, DEV_CACHEHIT_SCENES, DEV_TPS_SCENES,'
		+ ' DEV_SESSIONTIME_SCENES, DEV_LASTCOST_SCENES, DEV_COST_SCENES, DEV_BALANCE_CLICK_SCENES,'
		+ ' DEV_CONTEXT_SCENES, DEV_CONTEXT_SCENARIO };\n' + marker);

	const fakeWindow = {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		setInterval: () => 0, clearInterval: () => {},
		setTimeout: () => 0, clearTimeout: () => {},
		requestAnimationFrame: (fn) => { fn(); return 0; },
		fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
	const sandbox = {
		window: fakeWindow,
		document: {
			querySelector: () => null, querySelectorAll: () => [],
			createElement: () => ({ dataset: {}, style: {}, innerHTML: '', appendChild() {}, querySelector: () => null }),
			body: {}, head: { appendChild() {} }
		},
		MutationObserver: class { observe() {} disconnect() {} },
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
		setTimeout: () => 0, clearTimeout: () => 0
	};
	sandbox.globalThis = sandbox;
	const reactStub = {
		createElement: () => ({}), useState: (init) => [init, () => {}], useEffect: () => {},
		useRef: () => ({ current: null }), useSyncExternalStore: (sub, snap) => snap(),
		useCallback: (fn) => fn, useMemo: (fn) => fn(), Fragment: Symbol('Fragment')
	};
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	return captured.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
}

/** 规整化：键排序后深拷贝，用来逐字段比对（不受键顺序影响）。 */
const canon = (value) => {
	if (Array.isArray(value)) return value.map(canon);
	if (value !== null && typeof value === 'object') {
		const out = {};
		Object.keys(value).sort().forEach((key) => { out[key] = canon(value[key]); });
		return out;
	}
	return value;
};
const deep = (value) => JSON.parse(JSON.stringify(canon(value)));

/** 假数据里的文案函数：这个测试不断言文案，只保证 devFixture 拿到不抛错的 t。 */
const t = (key) => '<' + key + '>';

const api = loadClient();
const clientSource = fs.readFileSync(CLIENT, 'utf8');

/* devFixture 的一级字段分两类：
   · 13 个**投影键** —— 与 StatusBar 读投影的名字一一对应，注入时按这些键覆盖；
   · 2 个**开发模式专用键** —— agentState（圆环状态色）与 devSrc（只喂 status/sessionTime 的假 now）。
     它们不是投影，混进前一组就没人分得清哪个能给 projected() 用了。 */
const PROJECTION_KEYS = [
	'balance', 'stats', 'usage', 'sessionUsage', 'timing', 'pressure', 'breakdown',
	'capacity', 'progress', 'timeRange', 'daily', 'subagent', 'sessionModel'
];
const DEV_ONLY_KEYS = ['agentState', 'devSrc'];
const FIXTURE_KEYS = PROJECTION_KEYS.concat(DEV_ONLY_KEYS);

/** 第 n 次进入开发模式时的整套假投影（1 基）。 */
const fixtureOf = (round) => api.devFixture(round, t);
/**
 * 只推进**某一个**字段的计数（其余全为 0），用来验"点哪项只变哪项"。
 * 键就是底栏字段 id（圆环用 context），与 DEV_FIELD_KEYS 一致。
 */
const scenesOf = (field, count) => {
	const one = {};
	one[field] = count;
	return api.devFixture(1, t, one);
};
/** 余额轮 = ((round - 1) % 6) + 1 对应的余额段。 */
const balanceOf = (round) => fixtureOf(round).balance;
/** 工具场景轮 = ((round - 1) % 4) + 1 对应的 toolCounts。 */
const toolsOf = (round) => fixtureOf(round).progress.toolCounts;

const toolNameLengths = (counts) => Object.keys(counts).map((name) => name.length);
const sumOf = (counts) => Object.keys(counts).reduce((acc, name) => acc + counts[name], 0);

/* 6 种余额形态的「一句话特征」，输出里用得上 */
const BALANCE_SHAPE = [
	'DeepSeek 金额（充值 70 + 赠金 30，7:3）',
	'智谱 Coding Plan 百分比配额',
	'WorkBuddy 积分（含 ×4 裂变聚合）',
	'中转站按量计费（含 spent）',
	'中转站积分制（3 套餐）',
	'DeepSeek 不足一分钱（subCent）'
];

/* ============================================================ 一、矩阵规模 */
assert.strictEqual(api.DEV_BALANCE_ROUNDS, 6, '余额轮数常量应当是 6，实际 ' + api.DEV_BALANCE_ROUNDS);
assert.strictEqual(api.DEV_TOOL_ROUNDS, 4, '工具场景轮数常量应当是 4，实际 ' + api.DEV_TOOL_ROUNDS);
console.log('一 轮数常量：余额 ' + api.DEV_BALANCE_ROUNDS + ' 轮 × 工具 ' + api.DEV_TOOL_ROUNDS + ' 轮 = 24 种组合');

/* ============================================================ 二、一级字段齐全 */
const fixtureKeys = Object.keys(fixtureOf(1)).sort();
PROJECTION_KEYS.forEach((key) => {
	assert.ok(fixtureOf(1)[key] !== undefined && fixtureOf(1)[key] !== null,
		'devFixture 必须给出投影键 ' + key + '（StatusBar 读的就是这个键）');
});
assert.deepStrictEqual(fixtureKeys.slice().sort(), FIXTURE_KEYS.slice().sort(),
	'一级字段 = 13 个投影键 + 2 个开发模式专用键，不多不少，实际 ' + JSON.stringify(fixtureKeys));
/* 再来一条更明确的守卫：**除了这 13 个，多出来的只许是 agentState 与 devSrc**。
   这样将来有人往 fixture 里塞临时字段（比如调试用的 __debug），这条会立刻红。 */
const extraKeys = fixtureKeys.filter((key) => PROJECTION_KEYS.indexOf(key) === -1).sort();
assert.deepStrictEqual(extraKeys, DEV_ONLY_KEYS.slice().sort(),
	'13 个投影键之外，只许有 agentState 与 devSrc 这两个开发模式专用键，实际多出 ' + JSON.stringify(extraKeys));
/* devSrc 不是投影：它收的是 StatusBar 那几个 state 的开发模式替代值 */
['now', 'timeline', 'running', 'partial', 'runningCalls', 'turnUsage', 'turnUsageTurn', 'turnKey']
	.forEach((key) => {
		assert.ok(Object.prototype.hasOwnProperty.call(fixtureOf(1).devSrc, key),
			'devSrc 应当带 ' + key + '（StatusBar 里 srcNow / srcTimeline / … 那几行要用）');
	});
console.log('二 一级字段 15 个 = 投影 13（' + PROJECTION_KEYS.length + '）+ 专用 2（'
	+ DEV_ONLY_KEYS.join(' / ') + '）');

/* ============================================================ 三、6 个余额轮 */
/* ① 第 1 轮：DeepSeek 金额，充值 + 赠金两段按 7:3 */
const b1 = balanceOf(1);
assert.ok(b1.toppedUp !== undefined, '① 余额第 1 轮必须有 toppedUp');
assert.ok(b1.granted !== undefined, '① 余额第 1 轮必须有 granted');
assert.strictEqual(Number(b1.toppedUp), 70, '① 充值段应当是 70，实际 ' + b1.toppedUp);
assert.strictEqual(Number(b1.granted), 30, '① 赠金段应当是 30，实际 ' + b1.granted);
assert.strictEqual(Number(b1.total), 100, '① 合计应当是 70 + 30 = 100，实际 ' + b1.total);
assert.strictEqual(Number(b1.toppedUp) + Number(b1.granted), Number(b1.total), '① 两段之和必须等于 total');
assert.strictEqual(Number(b1.toppedUp) / Number(b1.granted), 7 / 3,
	'① 两段占比必须是 7:3（' + b1.toppedUp + ' : ' + b1.granted + '）');
console.log('三 ① ' + BALANCE_SHAPE[0] + '：' + b1.toppedUp + ' : ' + b1.granted + ' = 7:3，合计 ' + b1.total);

/* ② 第 2 轮：智谱配额，isPercent 且 total 以 % 结尾 */
const b2 = balanceOf(2);
assert.strictEqual(b2.isPercent, true, '② 余额第 2 轮必须标记 isPercent');
assert.strictEqual(typeof b2.total, 'string', '② total 应当是字符串');
assert.ok(/%$/.test(b2.total), '② total 必须以 % 结尾（客户端据此不拼货币符号），实际 ' + JSON.stringify(b2.total));
assert.strictEqual(b2.currency, '', '② 百分比口径的 currency 要留空');
console.log('三 ② ' + BALANCE_SHAPE[1] + '：isPercent，total=' + b2.total);

/* ③ 第 3 轮：WorkBuddy 积分，rewards 有裂变聚合行（count > 1）
   注意实现口径：devFixture 给的 rewards 是**聚合前**的原始 7 条（1 月度 + 4 裂变 + 2 普通），
   不带 count 字段；「相邻同名包聚合成 ×4」是视图层 creditsView 干的活。
   所以这里分两步验：原始 7 条的形状与相邻性，再走 creditsView 看聚合结果。 */
const b3 = balanceOf(3);
assert.strictEqual(b3.isCredits, true, '③ 余额第 3 轮必须标记 isCredits');
assert.ok(Array.isArray(b3.rewards), '③ rewards 必须是数组');
assert.strictEqual(b3.rewards.length, 7,
	'③ 原始 rewards 应当是 7 条（1 月度包 + 4 同名裂变包 + 2 同名普通包），实际 ' + b3.rewards.length);
assert.strictEqual(b3.rewards[0].name, '专业版月度包', '③ 第 1 条是月度包，实际 ' + b3.rewards[0].name);
/* 4 个裂变包必须**相邻**：creditsView 只聚合相邻同名包，中间插别的名字就并不成 ×4 */
[1, 2, 3, 4].forEach((index) => {
	assert.strictEqual(b3.rewards[index].name, '个人版国内运营裂变包',
		'③ 第 ' + (index + 1) + ' 条必须也是裂变包（它们必须相邻才能聚合），实际 ' + b3.rewards[index].name);
});
[5, 6].forEach((index) => {
	assert.strictEqual(b3.rewards[index].name, '活动赠送包',
		'③ 第 ' + (index + 1) + ' 条是普通包，实际 ' + b3.rewards[index].name);
});
assert.strictEqual(Number(b3.total), 1280, '③ 积分总数应当是 1280，实际 ' + b3.total);

/* 走真实视图层聚合：这才是「有 count>1 的裂变聚合行」的判定处 */
const credits3 = api.creditsView(b3.rewards, b3.total, t);
assert.ok(Array.isArray(credits3.rewards), '③ creditsView 应当给出 rewards 行');
const merged3 = credits3.rewards.filter((one) => one.count > 1);
/* 聚合行的 name 被 `creditDisplayName` 剥掉了品牌前缀（"个人版国内运营裂变包" → "运营裂变包"），
   所以这里按**关键字**定位，不按原始全名比较。 */
const split3 = merged3.filter((one) => one.name.indexOf('裂变') >= 0);
assert.strictEqual(split3.length, 1,
	'③ 必须有一行是「相邻同名裂变包聚合」出来的（count > 1 且名字含「裂变」），实际 '
	+ credits3.rewards.map((one) => one.name + '×' + one.count).join(' / '));
assert.strictEqual(split3[0].count, 4, '③ 4 个同名裂变包聚合后 count 应当是 4，实际 ' + split3[0].count);
assert.strictEqual(split3[0].used, 99 * 4, '③ 聚合行的 used 应当是 4 × 99 = 396，实际 ' + split3[0].used);
assert.strictEqual(split3[0].total, 300 * 4, '③ 聚合行的 total 应当是 4 × 300 = 1200，实际 ' + split3[0].total);
assert.strictEqual(split3[0].items.length, 4, '③ 聚合行要留着 4 条原始明细（子视图逐条列出）');
/* 2 个同名普通包相邻且同名 ⇒ 同样聚合成 ×2（实现比任务书多做了一步，行为正确） */
const normal3 = credits3.rewards.filter((one) => one.count > 1 && one.name.indexOf('裂变') < 0);
assert.strictEqual(normal3.length, 1, '③ 2 个同名普通包也聚合成 1 行（实现行为，任务书没提）');
assert.strictEqual(normal3[0].count, 2, '③ 普通包聚合后 count 应当是 2，实际 ' + normal3[0].count);
/* 聚合的总条数守恒：1 + 4 + 2 = 7 条原始套餐，聚合后剩 3 行 */
assert.strictEqual(credits3.rewards.length, 3,
	'③ 聚合后应当是 3 行（月度 / 普通 / 裂变），实际 ' + credits3.rewards.length);
assert.strictEqual(credits3.rewards.reduce((acc, one) => acc + one.count, 0), 7,
	'③ 聚合不丢条目：各行 count 之和必须还是 7，实际 ' + credits3.rewards.reduce((acc, one) => acc + one.count, 0));
/* 每个 percent 都不为 0 或 100：0 看不出色条、100 看不出余量，两种都失去演示意义 */
credits3.rewards.forEach((one) => {
	assert.ok(one.percent > 0 && one.percent < 100,
		'③ 每个 percent 都该在 (0, 100) 之间，' + one.name + ' 实际 ' + one.percent);
});
assert.deepStrictEqual(deep(credits3.rewards.map((one) => Math.round(one.percent)).sort((a, b) => a - b)),
	[33, 50, 67], '③ 三档 percent 手算值应当是 50 / 33 / 67（月度 400/800、裂变 396/1200、普通 402/600）');
console.log('三 ③ ' + BALANCE_SHAPE[2] + '：原始 ' + b3.rewards.length + ' 条 → 聚合后 '
	+ credits3.rewards.length + ' 行（'
	+ credits3.rewards.map((one) => one.name + '×' + one.count).join(' / ') + '），percent '
	+ credits3.rewards.map((one) => Math.round(one.percent)).join('/'));

/* ④ 第 4 轮：中转站按量计费，带 spent */
const b4 = balanceOf(4);
assert.ok(b4.spent !== undefined, '④ 余额第 4 轮必须有 spent 字段');
assert.strictEqual(Number(b4.spent), 13.6, '④ 累计消费应当是 13.60，实际 ' + b4.spent);
assert.strictEqual(Number(b4.total), 86.4, '④ 余额应当是 86.40，实际 ' + b4.total);
console.log('三 ④ ' + BALANCE_SHAPE[3] + '：余额 ' + b4.total + ' / 已消费 ' + b4.spent);

/* ⑤ 第 5 轮：中转站积分制，rewards 没有任何聚合行 */
const b5 = balanceOf(5);
assert.strictEqual(b5.isCredits, true, '⑤ 余额第 5 轮必须标记 isCredits');
assert.ok(Array.isArray(b5.rewards) && b5.rewards.length > 0, '⑤ rewards 不能为空');
assert.strictEqual(b5.rewards.length, 3, '⑤ 应当是 3 个套餐，实际 ' + b5.rewards.length);
/* 三个名字互不相同 ⇒ 无论原始数组还是聚合结果都不该出现 count > 1 */
assert.strictEqual(new Set(b5.rewards.map((one) => one.name)).size, 3, '⑤ 三个套餐名字必须各不相同');
assert.strictEqual(b5.rewards.filter((one) => one.count > 1).length, 0,
	'⑤ 原始 rewards 里不许有聚合行，实际 ' + JSON.stringify(b5.rewards.map((one) => one.name + '×' + one.count)));
const credits5 = api.creditsView(b5.rewards, b5.total, t);
assert.strictEqual(credits5.rewards.length, 3, '⑤ 聚合后仍是 3 行（名字不同不聚合）');
assert.strictEqual(credits5.rewards.filter((one) => one.count > 1).length, 0,
	'⑤ 视图层也不许出现聚合行，实际 ' + JSON.stringify(credits5.rewards.map((one) => one.name + '×' + one.count)));
assert.deepStrictEqual(deep(credits5.rewards.map((one) => Math.round(one.percent)).sort((a, b) => a - b)),
	[25, 50, 75], '⑤ 三个 percent 应当是 25 / 50 / 75');
assert.strictEqual(Number(b5.total), 320, '⑤ 积分总数应当是 320，实际 ' + b5.total);
console.log('三 ⑤ ' + BALANCE_SHAPE[4] + '：' + b5.total + ' 积分，percent 25/50/75，无聚合行');

/* ⑥ 第 6 轮：不足一分钱，subCent + total 数值 < 0.01 */
const b6 = balanceOf(6);
assert.strictEqual(b6.subCent, true, '⑥ 余额第 6 轮必须标记 subCent');
assert.ok(Number(b6.total) < 0.01,
	'⑥ total 的数值必须小于 0.01（界面显示「余额 <¥0.01」靠它），实际 ' + JSON.stringify(b6.total));
assert.strictEqual(Number(b6.total), 0, '⑥ 展示用的 total 已被截断到分 ⇒ "0.00"，实际 ' + b6.total);
console.log('三 ⑥ ' + BALANCE_SHAPE[5] + '：subCent=true，Number(total)=' + Number(b6.total) + ' < 0.01');

/* ============================================================ 四、4 个工具场景轮 */
/* ① 3 个短名工具 */
const tc1 = toolsOf(1);
assert.strictEqual(Object.keys(tc1).length, 3, '工具场景 ① 应当是 3 个工具，实际 ' + Object.keys(tc1).length);
assert.strictEqual(fixtureOf(1).progress.toolCalls, sumOf(tc1), '工具场景 ① toolCalls 必须等于各工具次数之和');
console.log('四 ① ' + Object.keys(tc1).length + ' 个工具：' + Object.keys(tc1).join(' / '));

/* ② 18 个长短混排，其中至少有名字长度 >= 20 的 */
const tc2 = toolsOf(2);
const names2 = Object.keys(tc2);
const lens2 = toolNameLengths(tc2);
assert.strictEqual(names2.length, 18, '工具场景 ② 应当是 18 个工具，实际 ' + names2.length);
assert.ok(lens2.some((len) => len >= 20),
	'② 必须有名字长度 >= 20 的工具（长名换行/省略号要靠它暴露问题），最长实际 ' + Math.max.apply(null, lens2));
console.log('四 ② ' + names2.length + ' 个长短混排，名字长度 ' + Math.min.apply(null, lens2) + '~' + Math.max.apply(null, lens2));

/* ③ 420 个（远超一屏，触发 12 行后的横向滚动） */
const tc3 = toolsOf(3);
assert.strictEqual(Object.keys(tc3).length, 420, '③ 应当是 420 个工具，实际 ' + Object.keys(tc3).length);
console.log('四 ③ ' + Object.keys(tc3).length + ' 个工具（触发横向滚动）');

/* ④ 24 个短名，名字长度都 <= 5 */
const tc4 = toolsOf(4);
const lens4 = toolNameLengths(tc4);
assert.strictEqual(Object.keys(tc4).length, 24, '工具场景 ④ 应当是 24 个工具，实际 ' + Object.keys(tc4).length);
assert.ok(lens4.every((len) => len <= 5),
	'④ 每个名字长度都必须 <= 5，实际最长 ' + Math.max.apply(null, lens4));
console.log('四 ④ ' + Object.keys(tc4).length + ' 个短名，最长 ' + Math.max.apply(null, lens4) + ' 字符');

/* 4 个场景的 key 集合互不相同（否则「换场景」其实没变） */
const sceneKeys = [tc1, tc2, tc3, tc4].map((counts) => Object.keys(counts).sort().join(','));
assert.strictEqual(new Set(sceneKeys).size, 4, '4 个工具场景两两不同');

/* ============================================================ 五、轮次取模可循环 */
assert.deepStrictEqual(deep(balanceOf(1)), deep(balanceOf(7)),
	'round 1 与 round 7 的余额必须相同（((7-1) % 6) + 1 = 1）');
assert.deepStrictEqual(deep(toolsOf(1)), deep(toolsOf(5)),
	'round 1 与 round 5 的工具场景必须相同（((5-1) % 4) + 1 = 1）');
/* 顺带把整张矩阵走一遍：6 轮余额互不相同、4 轮工具互不相同、24 轮后完全回到起点 */
const balanceSignatures = [];
for (let round = 1; round <= api.DEV_BALANCE_ROUNDS; round += 1) {
	balanceSignatures.push(JSON.stringify(deep(balanceOf(round))));
}
assert.strictEqual(new Set(balanceSignatures).size, api.DEV_BALANCE_ROUNDS,
	'6 个余额轮必须两两不同（否则循环看起来没换形态）');
const toolSignatures = [];
for (let round = 1; round <= api.DEV_TOOL_ROUNDS; round += 1) {
	toolSignatures.push(JSON.stringify(deep(toolsOf(round))));
}
assert.strictEqual(new Set(toolSignatures).size, api.DEV_TOOL_ROUNDS, '4 个工具场景必须两两不同');
/* 轮次取模只作用于**余额**与**工具场景**两块；`subagent.sessionId` 等字段按真实轮次生成
   （"dev-<round>"），所以整张投影的周期**不是** 12 —— 这一点要写清，免得日后误以为该按 12 循环。 */
const LCM = 4 * 6 / 2;   /* 4 与 6 的最小公倍数 = 12 */
assert.deepStrictEqual(deep(balanceOf(1 + LCM)), deep(balanceOf(1)), '余额按 6 轮循环 ⇒ 12 轮后回到第 1 种');
assert.deepStrictEqual(deep(toolsOf(1 + LCM)), deep(toolsOf(1)), '工具场景按 4 轮循环 ⇒ 12 轮后回到第 1 种');
assert.notStrictEqual(fixtureOf(1).subagent.session.sessionId, fixtureOf(1 + LCM).subagent.session.sessionId,
	'子智能体的 sessionId 是 dev-<真实轮次>（每轮都不同，不参与取模）');
console.log('五 取模可循环：round1 = round7（余额）· round1 = round5（工具）· 12 轮后两块都回到起点');

/* ============================================================ 六、其余假数据每轮齐全且稳定 */
/* compacts：手动与自动两种都要有，且至少一条是「本轮之后压缩」（afterTurn） */
const compacts = fixtureOf(1).progress.compacts;
assert.ok(Array.isArray(compacts) && compacts.length > 0, 'progress.compacts 不能为空');
assert.ok(compacts.some((one) => one.manual === true), 'compacts 必须有手动压缩（manual:true）');
assert.ok(compacts.some((one) => one.manual === false), 'compacts 必须有自动压缩（manual:false）');
assert.ok(compacts.some((one) => one.afterTurn !== undefined && one.afterTurn !== null),
	'compacts 至少有一条带 afterTurn（「本轮之后压缩」那一种）');
console.log('六 compacts ' + compacts.length + ' 条：手动 ' + compacts.filter((one) => one.manual === true).length
	+ ' 条 / 自动 ' + compacts.filter((one) => one.manual === false).length + ' 条，其中带 afterTurn 的 '
	+ compacts.filter((one) => one.afterTurn !== undefined && one.afterTurn !== null).length + ' 条');

/* skills：至少一条 manual:true（手动注入的技能，气泡要单独标出来） */
const skills = fixtureOf(1).progress.skills;
assert.ok(Array.isArray(skills) && skills.length > 0, 'progress.skills 不能为空');
assert.ok(skills.some((one) => one.manual === true), 'skills 至少一条 manual:true');
console.log('六 skills ' + skills.length + ' 条，手动注入 ' + skills.filter((one) => one.manual === true).length + ' 条');

/* subagent：「总计」（session）与「本轮」（turn）两段都要 ok 且 cost > 0 */
const sub = fixtureOf(1).subagent;
['session', 'turn'].forEach((slice) => {
	const one = sub[slice];
	assert.ok(one !== undefined && one !== null, 'subagent.' + slice + ' 不能缺');
	assert.strictEqual(one.ok, true, 'subagent.' + slice + ' 必须 ok:true');
	const cost = one.total !== undefined && one.total !== null ? one.total.cost : undefined;
	assert.ok(typeof cost === 'number' && cost > 0,
		'subagent.' + slice + '.total.cost 必须 > 0（否则看不出「已把队友并进来」），实际 ' + cost);
});
console.log('六 subagent 两段都 ok：总计 ¥' + sub.session.total.cost + ' / 本轮 ¥' + sub.turn.total.cost);

/* 其余字段每轮相同（除 balance 与 toolCounts 这两个按轮变化的）：逐字段比对 round 1 与 round 2 */
const STABLE_KEYS = ['stats', 'usage', 'sessionUsage', 'timing', 'pressure', 'breakdown',
	'capacity', 'timeRange', 'daily', 'sessionModel'];
const one = fixtureOf(1);
const two = fixtureOf(2);
STABLE_KEYS.forEach((key) => {
	assert.deepStrictEqual(deep(two[key]), deep(one[key]), key + ' 每轮都该相同（只有余额与工具场景按轮变化）');
});
['turns', 'steps', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens', 'toolMs', 'llmMs'].forEach((key) => {
	assert.strictEqual(typeof one.stats[key], 'number', 'stats.' + key + ' 必须是数字');
});
['turnTtftMs', 'turnTtftSamples', 'turnDecodeMs', 'turnDecodeTokens'].forEach((key) => {
	assert.strictEqual(typeof one.timing[key], 'number', 'timing.' + key + ' 必须是数字');
});
['fastestTtft', 'slowestTtft', 'fastestTps', 'slowestTps'].forEach((key) => {
	assert.ok(one.timing[key] !== undefined && one.timing[key] !== null, 'timing.' + key + ' 不能缺（极值气泡要它）');
});
['projectedTokens', 'contextWindow'].forEach((key) => {
	assert.strictEqual(typeof one.pressure[key], 'number', 'pressure.' + key + ' 必须是数字');
});
['systemTokens', 'toolsTokens', 'messageTokens'].forEach((key) => {
	assert.strictEqual(typeof one.breakdown[key], 'number', 'breakdown.' + key + ' 必须是数字');
});
['contextWindow', 'maxOutputTokens'].forEach((key) => {
	assert.strictEqual(typeof one.capacity[key], 'number', 'capacity.' + key + ' 必须是数字');
});
assert.ok(Array.isArray(one.daily.days) && one.daily.days.length > 0, 'daily.days 不能为空');
assert.ok(one.daily.totals !== undefined && one.daily.month !== undefined && one.daily.year !== undefined,
	'daily 必须同时给 totals / month / year');
['calls', 'overflow', 'current', 'summaryParts'].forEach((key) => {
	assert.ok(one.sessionUsage[key] !== undefined, 'sessionUsage.' + key + ' 不能缺');
});
console.log('六 其余字段每轮相同且齐全：stats / usage / sessionUsage / timing / pressure / breakdown /'
	+ ' capacity / timeRange / daily / sessionModel');

/* ============================================================ 七、定时器数量不变 */
const timerCount = (clientSource.match(/setInterval\(/g) || []).length;
assert.strictEqual(timerCount, 2,
	'底栏定时器只该有两处（每秒时钟 + 余额轮询），开发模式不许新增 setInterval，实际 ' + timerCount);
assert.ok(clientSource.indexOf('BALANCE_POLL_MS') >= 0, '余额轮询仍用 BALANCE_POLL_MS');
assert.strictEqual((clientSource.match(/BALANCE_POLL_MS\)/g) || []).length > 0, true, 'BALANCE_POLL_MS 用在轮询处');
console.log('七 client.js 里 setInterval 仍只有 ' + timerCount + ' 处（时钟 + 余额轮询）');

/* ============================================================ 八、agentState（圆环状态色） */
/* 为什么由 fixture 给：真实判定读的是 running / pendingApprovals / lastAgentError，
   这几样在开发模式里仍是真实值，不会因为点圆环而变 —— 于是各档状态色永远只显示当前那一种。
   取值域就是 contextRing 认得的六个字符串（含 Agent Teams 的蓝档 teamRunning / 紫档 deepRunning），
   给别的值只会退回默认灰。 */
const AGENT_STATES = ['idle', 'running', 'error', 'approval', 'teamRunning', 'deepRunning'];
AGENT_STATES.forEach((want) => {
	assert.strictEqual(api.DEV_CONTEXT_SCENARIO.some((one) => one.state === want), true,
		'context 场景表里必须有一格是 ' + want + '（否则这个状态色在开发模式里永远看不到）');
});
/* 逐格走一遍 context 计数：agentState 必须始终在取值域内，且 6 种都出现过 */
const seenStates = [];
for (let step = 0; step < api.DEV_CONTEXT_SCENES * 2; step += 1) {
	const state = scenesOf('context', step).agentState;
	assert.strictEqual(typeof state, 'string', 'context 第 ' + step + ' 格的 agentState 必须是字符串');
	assert.ok(AGENT_STATES.indexOf(state) !== -1,
		'agentState 只能是 ' + AGENT_STATES.join(' / ') + ' 之一，第 ' + step + ' 格实际 ' + JSON.stringify(state));
	if (seenStates.indexOf(state) === -1) seenStates.push(state);
}
assert.deepStrictEqual(seenStates.slice().sort(), AGENT_STATES.slice().sort(),
	'点 context 轮换一圈必须**走遍 6 种状态**，实际只见到 ' + JSON.stringify(seenStates));
/* 蓝档 / 紫档还必须带配套的**分层占用百分比**，否则开发模式里弧长看不出跟着层级变：
   蓝色那档是"成员级最大"，紫色那档是"深层最小" —— 两个数故意不同（55 / 10），
   这样"成员取最大、深层取最小"这条规则在实机上是可以被眼睛验证的。 */
const teamScene = api.DEV_CONTEXT_SCENARIO.find((one) => one.state === 'teamRunning');
const deepScene = api.DEV_CONTEXT_SCENARIO.find((one) => one.state === 'deepRunning');
assert.strictEqual(typeof teamScene.teamContextPercent, 'number',
	'蓝档（团队成员在跑）必须给 teamContextPercent，否则弧长只能退回 Lead 自己的占用');
assert.strictEqual(typeof deepScene.deepContextPercent, 'number',
	'紫档（更深层在跑）必须给 deepContextPercent，同上');
assert.notStrictEqual(teamScene.teamContextPercent, deepScene.deepContextPercent,
	'两档的占用百分比故意不同（成员取最大 / 深层取最小），否则看不出弧长随层级变');
/* 这两格的分层值要能通过 devSrc.agentTiers 传给圆环（StatusBar 里读的就是它） */
['teamRunning', 'deepRunning'].forEach((state) => {
	const fx = scenesOf('context', AGENT_STATES.indexOf(state) === 4 ? 7 : 8);
	assert.strictEqual(fx.agentState, state, '第 ' + (state === 'teamRunning' ? 7 : 8) + ' 格应当是 ' + state);
	assert.ok(fx.devSrc.agentTiers !== undefined && fx.devSrc.agentTiers !== null,
		state + ' 那格必须带 devSrc.agentTiers（圆环弧长靠它）');
});
/* 第 0 格是进开发模式立刻看到的常规态：运行中（绿环），不是一进来就是红/黄 */
assert.strictEqual(scenesOf('context', 0).agentState, 'running',
	'context 第 0 格是「运行中」——进开发模式立刻看到的是常规态');
/* 其余字段的计数不该影响 agentState（防串扰）：agentState 只听 context */
['status', 'counts', 'cacheHit', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'].forEach((field) => {
	assert.strictEqual(scenesOf(field, 3).agentState, scenesOf('context', 0).agentState,
		'点 ' + field + ' 不许改 agentState（它只由 context 计数驱动）');
});
console.log('八 agentState 取值域 ' + AGENT_STATES.join(' / ') + '：context 轮换一圈走遍 6 种（含蓝档 teamRunning / 紫档 deepRunning），'
	+ '第 0 格 running，其余字段不串扰');

/* ============================================================ 九、devSrc.now（假「现在」） */
/* 只喂 status 与 sessionTime 两段；底栏时钟仍走真实 Date.now()。
   必须假化：status 段就是 isPeakTime(src.now) 判出来的，而真实时钟几乎永远撞不进高峰时段。 */
const devSrcOf = (status) => scenesOf('status', status).devSrc;
assert.strictEqual(typeof devSrcOf(0).now, 'number', 'devSrc.now 必须是数字（StatusBar 直接当时间戳用）');
assert.strictEqual(Number.isFinite(devSrcOf(0).now), true, 'devSrc.now 必须是有限数（不能是 NaN/Infinity）');
/* 峰谷必须真的能切换：第 0 格低谷、第 1 格高峰，用**同一个** isPeakTime 自检，
   否则会出现「号称高峰、实际低谷」的自相矛盾（写死某一天就可能踩到周末/节假日）。 */
assert.strictEqual(api.isPeakTime(devSrcOf(0).now), false,
	'status 第 0 格的假 now 必须落在低谷时段，实际 ' + new Date(devSrcOf(0).now).toISOString());
assert.strictEqual(api.isPeakTime(devSrcOf(1).now), true,
	'status 第 1 格的假 now 必须落在高峰时段，实际 ' + new Date(devSrcOf(1).now).toISOString());
assert.notStrictEqual(devSrcOf(0).now, devSrcOf(1).now, '低谷与高峰必须是两个不同的时刻');
/* 同一格反复取值必须**完全相同**：每次重渲染都换时间戳会让 sessionTime 的 elapsed 一直涨 */
assert.strictEqual(devSrcOf(0).now, devSrcOf(0).now, '同一格的 devSrc.now 必须稳定（不能每帧都变）');
/* 4 格 status 的峰谷排布：0 低谷 / 1 高峰 / 2 低谷 / 3 高峰（2 是「整块查不到」、3 是「月历年图缺」） */
assert.deepStrictEqual([0, 1, 2, 3].map((n) => api.isPeakTime(devSrcOf(n).now)),
	[false, true, false, true], 'status 4 格的峰谷排布是 低谷 / 高峰 / 低谷 / 高峰');
/* devSrc 的其余几项：开发模式没有真实会话节点可折，timeline 必须是 null，
   否则「时间窗算不出 + timeline 也算不出」那条横杠路径永远走不到 */
assert.strictEqual(devSrcOf(0).timeline, null, 'devSrc.timeline 必须是 null（横杠路径要靠它）');
/* 跨 realm 的数组原型不同，deepStrictEqual 会判不等 ⇒ 数长度 */
assert.strictEqual(devSrcOf(0).runningCalls.length, 0, 'devSrc.runningCalls 是空数组');
assert.strictEqual(devSrcOf(0).partial, null, 'devSrc.partial 是 null');
console.log('九 devSrc.now 数字且稳定：低谷 ' + new Date(devSrcOf(0).now).toISOString()
	+ ' / 高峰 ' + new Date(devSrcOf(1).now).toISOString() + '，timeline 为 null');

/* ============================================ 十、**没有任何字段会退化成横杠** */
/* 用户明确否决「没数据 → 横杠」这类演示：横杠什么都看不出来，还占一格。
   所以现在要反过来证明：**每一张表的每一格，每个字段都真的有数据**。
   判据全部照 lib/client.js 里 segmentView 的实际 if 反推（不是照任务书猜）：
     counts      —— stats.steps > 0
     ttft        —— merged.ttftSteps > 0 且 merged.ttftMs > 0（本会话 + 队友两段都算）
     cacheHit    —— 分母（本会话三段输入 + 队友命中/未命中）> 0
     tps         —— merged.decodeMs > 0 且 merged.decodeTokens > 0
     sessionTime —— timeRange.turns > 0（或 steps > 0）
     cost        —— 账本能定出价（这里只看"调用记录存在且有价"）
     lastCost    —— 本轮有调用、或队友本轮有金额
     balance     —— balance.ok === true
     status      —— 恒有（只出峰谷两个字，没有 null 分支）
   dashMeter / dashBalance / emptySegmentTip 这些**兜底代码路径保留**，
   真实环境照样会走（会话刚发出、某平台查不到余额），只是开发模式不再主动演示。 */
const scenesOfField = (field, n) => scenesOf(field, n);
/** 某字段在某一格是否「有数据」（true = 不该出现横杠）。 */
const hasData = (field, fx) => {
	if (field === 'status') return true;
	if (field === 'counts') return fx.stats.steps > 0;
	if (field === 'ttft') return fx.stats.ttftSteps > 0 && fx.stats.ttftMs > 0;
	if (field === 'cacheHit') {
		const billed = fx.usage.uncachedInputTokens + fx.usage.cacheReadTokens + fx.usage.cacheWriteTokens;
		const subTokens = fx.subagent.session.total.tokens;
		return billed + subTokens.cacheRead + subTokens.input + subTokens.cacheWrite > 0;
	}
	if (field === 'tps') return fx.stats.decodeMs > 0 && fx.stats.decodeTokens > 0;
	if (field === 'sessionTime') return fx.timeRange.turns > 0 || fx.timeRange.steps > 0;
	if (field === 'cost') {
		const priced = fx.sessionUsage.calls.some((one) => one.model !== 'model-without-price');
		return priced || fx.subagent.session.total.cost > 0;
	}
	if (field === 'lastCost') {
		/* 这一段的「有数据」不是"金额 > 0"，而是"**能显示出一个数**"。
		   ¥0.00（正在跑但本轮还没调用）也是有效形态 —— 那是 active 分支的刻意结果，不是横杠。
		   横杠只在 `amountText(null)` 时出现，条件是：本轮没调用、队友本轮也没金额、且**不在跑**。 */
		if ((fx.sessionUsage.current.calls || []).length > 0) return true;
		if (fx.subagent.turn.total.cost > 0) return true;
		return fx.devSrc.running === true;
	}
	if (field === 'balance') return fx.balance.ok === true;
	return true;
};

/* 每字段的格数（读 client.js 自己导出的常量，不在测试里写死，改表时自动跟上） */
const sceneCount = {
	status: api.DEV_STATUS_SCENES,
	counts: api.DEV_COUNTS_SCENES,
	ttft: api.DEV_TTFT_SCENES,
	cacheHit: api.DEV_CACHEHIT_SCENES,
	tps: api.DEV_TPS_SCENES,
	sessionTime: api.DEV_SESSIONTIME_SCENES,
	lastCost: api.DEV_LASTCOST_SCENES,
	cost: api.DEV_COST_SCENES,
	balance: api.DEV_BALANCE_CLICK_SCENES,
	context: api.DEV_CONTEXT_SCENES
};
const FORM = [];
Object.keys(sceneCount).forEach((field) => {
	for (let n = 0; n < sceneCount[field]; n += 1) {
		const fx = scenesOfField(field, n);
		assert.strictEqual(hasData(field, fx), true,
			field + ' 第 ' + n + ' 格退化成了横杠（用户已明确不要这类场景）');
	}
	FORM.push(field + '×' + sceneCount[field]);
});
console.log('十 没有任何字段退化成横杠：' + FORM.join(' / '));

/* 圆环：4 种状态色都要出现，且**每一格都要有足够描边长度**（0% 时红色画不出来，
   用户原话「红色在哪里？」就是这么来的）。 */
const ctxStates = [];
for (let n = 0; n < api.DEV_CONTEXT_SCENES; n += 1) {
	ctxStates.push(scenesOfField('context', n).agentState);
}
['running', 'error', 'approval', 'idle'].forEach((want) => {
	assert.ok(ctxStates.indexOf(want) !== -1,
		'圆环 4 种状态色必须都出现，缺 ' + want + '（实际 ' + ctxStates.join('/') + '）');
});
console.log('十b 圆环状态序列：' + ctxStates.join(' / '));

/* ============================================ 十一、极端值互不串扰 */
/* 用户三次强调的那条需求的测试面：**点一个字段，只有那个字段变**。
   这里逐个字段断言：把它推到「极端」那一格时，别的字段的关键量**都不变**。 */
const SNAPSHOT_KEYS = [
	(fx) => fx.stats.turns,
	(fx) => fx.stats.steps,
	(fx) => fx.stats.ttftSteps,
	(fx) => fx.stats.decodeTokens,
	(fx) => fx.usage.cacheReadTokens,
	(fx) => fx.timeRange.turns,
	(fx) => fx.sessionUsage.calls.length,
	(fx) => fx.balance.total,
	(fx) => fx.daily.days.length,
	(fx) => fx.agentState
];
const snapshotOf = (fx) => SNAPSHOT_KEYS.map((pick) => pick(fx));
/* 每个字段的「极端格」下标（0 = 正常格）。只比对**别的字段**对应的那几项快照。 */
const EXTREME_AT = {
	/* 这些字段的极端格只动它自己那几项，其余快照项必须一字不变 */
	counts: 0, ttft: 1, cacheHit: 1, tps: 1, sessionTime: 1, lastCost: 1, cost: 1, balance: 1, status: 1
};
/* 字段 → 它自己允许变化的那几个快照下标 */
const OWN_KEYS = {
	counts: [0, 1],
	ttft: [2],
	cacheHit: [4],
	tps: [3],
	sessionTime: [5],
	lastCost: [6],
	cost: [6],
	balance: [7],
	status: [8, 9].slice(0, 1)
};
Object.keys(EXTREME_AT).forEach((field) => {
	const base = snapshotOf(scenesOfField(field, 0));
	const extreme = snapshotOf(scenesOfField(field, EXTREME_AT[field]));
	const own = OWN_KEYS[field];
	for (let i = 0; i < base.length; i += 1) {
		if (own.indexOf(i) !== -1) continue;
		assert.deepStrictEqual(extreme[i], base[i],
			'点 ' + field + ' 的第 ' + EXTREME_AT[field] + ' 格，不该改动快照第 ' + i + ' 项');
	}
});
console.log('十一 防串扰：9 个字段各自推到极端格，别人的关键量一字不变');

/* ============================================ 十一b、status / context 的极端格 */
/* status 第 1 格切到高峰：只该改 devSrc.now 的峰谷，不该动余额/轮次。 */
const statusPeak = scenesOfField('status', 1);
assert.strictEqual(api.isPeakTime(statusPeak.devSrc.now), true, 'status 第 1 格：假 now 落在高峰时段');
assert.strictEqual(statusPeak.daily.ok, true, 'status 第 1 格：活跃总览有数据（横杠那格已删）');
assert.strictEqual(statusPeak.balance.ok, true, '点 status 不碰余额');
assert.strictEqual(statusPeak.stats.steps > 0, true, '点 status 不把轮次步数清零');
/* context 第 4 格是「缺口算不出」（capacity 缺 maxOutputTokens），此时余额/轮次照旧 */
const ctxNoNotch = scenesOfField('context', 4);
assert.strictEqual(ctxNoNotch.capacity.maxOutputTokens, undefined,
	'context 第 4 格：capacity 缺 maxOutputTokens（压缩点算不出 ⇒ 轨道整圈）');
assert.ok(ctxNoNotch.pressure !== null && ctxNoNotch.pressure !== undefined,
	'context 第 4 格：占用数据仍在（不是"没数据"，只是缺口算不出）');
assert.strictEqual(ctxNoNotch.balance.ok, true, '点 context 不碰余额');
assert.strictEqual(ctxNoNotch.stats.steps > 0, true, '点 context 不把轮次步数清零');
/* lastCost 第 1 格是「正在跑但本轮没调用」（显示 ¥0.00），此时总计照常算价 */
const lastCostActive = scenesOfField('lastCost', 1);
assert.strictEqual(lastCostActive.sessionUsage.current.calls.length, 0, 'lastCost 第 1 格：本轮调用为空');
assert.strictEqual(lastCostActive.sessionUsage.calls.length > 0, true, 'lastCost 第 1 格：历史调用仍在（总计照常算价）');
assert.strictEqual(lastCostActive.subagent.turn.total.cost, 0, 'lastCost 第 1 格：队友本轮金额归零');
assert.strictEqual(lastCostActive.subagent.session.total.cost > 0, true, 'lastCost 第 1 格：队友整会话金额仍留着');
console.log('十一b status / lastCost / context 的极端格也不牵动别字段（daily.ok · current.calls · pressure）');

/* ============================================ 十二、「队友在跑」的折算不能把时钟打进长睡 */
/* 用户报过的缺陷：底栏的时钟档位由「队友还有几个在跑」决定 ——
   有队友在跑 ⇒ 每秒一跳，队友数据与「总计」里队友那笔金额才会持续更新；
   没有 ⇒ 睡到下一个峰谷边界（可能几小时）。
   所以"两问都失败"**绝不能**被折算成 0，否则一次网络抖动就让界面冻结几小时。
   但"两问都成功、host 明确说 0"必须真的归零（队友全部结束后时钟要能回省电档），
   所以也不能偷懒写成"非 0 才更新"。下面把这条纯函数的三种情形都钉住。 */
assert.strictEqual(api.readSubagentRunning(null, null), null,
	'两问都失败 ⇒ readSubagentRunning 必须返回 null（表示"没有结论"），不能返回 0');
assert.strictEqual(api.readSubagentRunning({ ok: false }, { ok: false }), null,
	'两问都是 ok:false 的响应同样算"没有结论"（响应里没有 running 字段）');
assert.strictEqual(api.readSubagentRunning(undefined, undefined), null, '两问都是 undefined 也算没有结论');
assert.strictEqual(api.nextSubagentRunning(2, null, null), 2,
	'两问都失败 ⇒ 保留旧值 2（否则时钟会从每秒一档掉进几小时的长睡）');
assert.strictEqual(api.nextSubagentRunning(2, undefined, undefined), 2, 'undefined 同样保留旧值');
assert.strictEqual(api.nextSubagentRunning(2, { running: 0 }, { running: 0 }), 0,
	'两问都成功且 host 明确说 0 ⇒ 必须真的归零（队友全结束要能回省电档）');
assert.strictEqual(api.nextSubagentRunning(2, { running: 0 }, null), 0,
	'一问成功说 0、另一问失败 ⇒ 按成功那一问走（0 是明确结论，不是"没结论"）');
assert.strictEqual(api.nextSubagentRunning(0, { running: 3 }, null), 3, '任一问说 3 ⇒ 取 3');
assert.strictEqual(api.nextSubagentRunning(0, { running: 0 }, { running: 4 }), 4,
	'本轮那问说 0、整会话那问说 4 ⇒ 取 4（任一段有在跑的就算在跑）');
console.log('十二 队友在跑：两问都失败 ⇒ 保留旧值（不打进长睡）；两问都说 0 ⇒ 归零');

/* ============================================ 十三、月历的「今天」必须与月历数据同源 */
/* 月热力图/年条靠 `daily.day.date > todayKey` 区分两个灰阶（过去 / 未来）。
   `todayKey` 来自 devSrc.now，月历数据来自同一个 now —— 两边必须**同源**。
   以前月历用真实 Date.now() 生成、todayKey 用假 now（固定在 2026-11 那档），
   于是所有日期都 < todayKey，「未来日」灰阶在开发模式里一天都看不到 ——
   违反「开发模式要展示所有情况」。这里按节点实际渲染的口径直接算一遍。 */
const keyOfMs = (ms) => {
	const d = new Date(ms);
	const pad = (n) => (n < 10 ? '0' + n : String(n));
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
/* 第 0 格：月历就是「今天」所在的那个月，因此**两种灰阶都必须出现** */
const day0 = scenesOf('status', 0);
const today0 = keyOfMs(day0.devSrc.now);
assert.ok(day0.daily.month !== null && day0.daily.month !== undefined, 'status 第 0 格应当有月历数据');
assert.strictEqual(day0.daily.month.year + '-' + day0.daily.month.month, today0.slice(0, 7),
	'月历的月份必须就是「今天」所在的那个月（两边不同源 ⇒ 未来日灰阶永远为空），实际月历 '
	+ day0.daily.month.year + '-' + day0.daily.month.month + ' / 今天 ' + today0);
const pastDays = day0.daily.month.days.filter((one) => one.date <= today0);
const futureDays = day0.daily.month.days.filter((one) => one.date > today0);
assert.ok(pastDays.length > 0, '同源之后必须存在「已过去」的格子，实际 ' + pastDays.length);
assert.ok(futureDays.length > 0,
	'同源之后必须存在「还没到」的格子（否则 dsb-future 灰阶永远渲染不出来），实际 ' + futureDays.length);
/* 年条同理：12 个月里必须同一年内既有已过的月、也有还没到的月 */
assert.ok(day0.daily.year !== null && day0.daily.year !== undefined, 'status 第 0 格应当有年条数据');
const todayMonth = Number(today0.slice(5, 7));
const futureMonths = day0.daily.year.months.filter((one) => one.month > todayMonth);
assert.ok(futureMonths.length > 0,
	'年条里必须存在「还没到」的月份（否则年条的 dsb-future 永远渲染不出来），今天在第 '
	+ todayMonth + ' 月');
console.log('十三 月历/年条的「今天」与数据同源：过去 ' + pastDays.length + ' 格、未来 ' + futureDays.length
	+ ' 格，年条未来月 ' + futureMonths.length + ' 个（两个灰阶都看得到）');

console.log('');
console.log('十四 双币种假数据（用户报的遗漏：新功能在开发模式里点不到）');
/* 用户原话：「你开发模式没做对应的情况啊，我怎么验证」。
   这一轮新增了两个功能：底栏余额双币种、活跃总览金额分币种 —— 都必须有假数据能点到。 */

/* ① 余额：点击那一路有 9 格，必须有三种分币种形态（双币种 / 只有美元 / 某项为 0） */
const balanceShapes = [];
for (let n = 0; n < api.DEV_BALANCE_CLICK_SCENES; n += 1) {
	balanceShapes.push(scenesOf('balance', n).balance);
}
assert.strictEqual(balanceShapes.length, api.DEV_BALANCE_CLICK_SCENES,
	'余额点击应当有 ' + api.DEV_BALANCE_CLICK_SCENES + ' 格');
const dualShape = balanceShapes.filter((one) => Array.isArray(one.balances) && one.balances.length === 2)[0];
assert.ok(dualShape !== undefined, '必须有一格带 balances 两项（人民币 + 美元），否则双币种在开发模式里点不到');
assert.strictEqual(dualShape.balances[0].currency, 'CNY', '双币种那格第一项是人民币');
assert.strictEqual(dualShape.balances[0].total, '14.12', '人民币 14.12（用户原话那个例子）');
assert.strictEqual(dualShape.balances[1].currency, 'USD', '第二项是美元');
assert.strictEqual(dualShape.balances[1].total, '3.17', '美元 3.17');
const singleShape = balanceShapes.filter((one) => Array.isArray(one.balances) && one.balances.length === 1)[0];
assert.ok(singleShape !== undefined, '必须有一格只有一项（验证「单项不带 +」）');
assert.strictEqual(singleShape.balances[0].currency, 'USD', '单项那格是只有美元（显示 $3.17 而不是 ¥0.00+$3.17）');
const zeroShape = balanceShapes.filter((one) => Array.isArray(one.balances)
	&& one.balances.some((b) => Number(b.total) <= 0))[0];
assert.ok(zeroShape !== undefined, '必须有一格某项为 0/负数（验证「0 不出现」）');
/* 老的 6 格仍然都在（不能为了加新形态把旧形态挤掉） */
assert.ok(balanceShapes.some((one) => one.isPercent === true), '百分比配额那格仍在');
assert.ok(balanceShapes.some((one) => one.isCredits === true), '积分那格仍在');
assert.ok(balanceShapes.some((one) => one.subCent === true), '不足一分钱那格仍在（第 6 格位置不变）');
console.log('  余额 ' + api.DEV_BALANCE_CLICK_SCENES + ' 格：双币种(CNY 14.12 + USD 3.17) / 只有美元 / 某项为 0，'
	+ '老的百分比与积分形态未被挤掉');

/* ② 活跃总览：三个 fixture 都必须带 costByCurrency，且各币种之和 === cost */
const sumOfCcy = (map) => Object.keys(map === undefined || map === null ? {} : map)
	.reduce((sum, code) => sum + Number(map[code] || 0), 0);
const shapesOfCcy = (map) => {
	const keys = Object.keys(map === undefined || map === null ? {} : map).filter((code) => Number(map[code]) > 0);
	if (keys.length === 0) return 'empty';
	if (keys.length === 2) return 'mixed';
	return keys[0] === 'USD' ? 'usd' : 'cny';
};
/* scenesOf 是本文件现成的辅助函数：只推进一个字段、其余全 0 */
const statusFxOf = (n) => scenesOf('status', n);
const dailyFx = statusFxOf(0).daily;

/* 近 7 天：三种形态都要出现（否则「某项为 0 不显示 +」验证不到） */
const dayShapes = {};
dailyFx.days.forEach((one) => {
	const shape = shapesOfCcy(one.costByCurrency);
	dayShapes[shape] = (dayShapes[shape] || 0) + 1;
	assert.ok(Math.abs(sumOfCcy(one.costByCurrency) - one.cost) < 1e-6,
		'近 7 天 ' + one.date + ' 的 costByCurrency 之和必须等于 cost（'
		+ sumOfCcy(one.costByCurrency) + ' vs ' + one.cost + '）');
});
assert.ok(dayShapes.mixed > 0, '近 7 天必须有「混币」的天，实际形态 ' + JSON.stringify(dayShapes));
assert.ok(dayShapes.cny > 0, '近 7 天必须有「只有人民币」的天，实际形态 ' + JSON.stringify(dayShapes));
assert.ok(dayShapes.usd > 0, '近 7 天必须有「只有美元」的天，实际形态 ' + JSON.stringify(dayShapes));
/* 周汇总（周条悬停读它） */
assert.ok(dailyFx.totals.costByCurrency !== undefined, '周汇总 totals 也要带 costByCurrency');
assert.ok(Math.abs(sumOfCcy(dailyFx.totals.costByCurrency) - dailyFx.totals.cost) < 1e-6,
	'周汇总的 costByCurrency 之和必须等于 totals.cost');
/* 当月每个日桶 */
dailyFx.month.days.forEach((one) => {
	assert.ok(one.costByCurrency !== undefined, '当月的每天都要有 costByCurrency（' + one.date + '）');
	assert.ok(Math.abs(sumOfCcy(one.costByCurrency) - one.cost) < 1e-6,
		'当月 ' + one.date + ' 的分币种之和必须等于 cost');
});
/* 当年 12 个月桶 */
dailyFx.year.months.forEach((one) => {
	assert.ok(one.costByCurrency !== undefined, '当年第 ' + one.month + ' 月要有 costByCurrency');
	assert.ok(Math.abs(sumOfCcy(one.costByCurrency) - one.cost) < 1e-6,
		'当年第 ' + one.month + ' 月的分币种之和必须等于 cost');
});
/* 当月内（inMonth）也要三种形态都有，否则在日历上点不到 */
const monthShapes = {};
dailyFx.month.days.filter((one) => one.inMonth === true).forEach((one) => {
	const shape = shapesOfCcy(one.costByCurrency);
	monthShapes[shape] = (monthShapes[shape] || 0) + 1;
});
assert.ok(monthShapes.mixed > 0 && monthShapes.cny > 0 && monthShapes.usd > 0,
	'当月内的日子也要三种形态都有，实际 ' + JSON.stringify(monthShapes));
/* 点 status 换一格时，costByCurrency 要跟着换 */
const firstCcy0 = statusFxOf(0).daily.days[0].costByCurrency;
const firstCcy1 = statusFxOf(1).daily.days[0].costByCurrency;
assert.notStrictEqual(JSON.stringify(firstCcy0), JSON.stringify(firstCcy1),
	'点 status 改变 statusCount 时 costByCurrency 也要跟着变（否则开发模式看不出它在动）');
console.log('  活跃总览：近 7 天 ' + JSON.stringify(dayShapes) + '，当月内 ' + JSON.stringify(monthShapes)
	+ '，周/月/年三处都带 costByCurrency 且和 === cost');
/* ③ 金额量级：新规则「不足 0.01 不显示」上线后，当月日历不能整片 ¥0.00，
   否则开发模式里根本看不到分币种格式（这是用户批准修量级的原因）。 */
const visibleInMonth = dailyFx.month.days.filter((one) => one.inMonth === true
	&& Object.keys(one.costByCurrency === undefined || one.costByCurrency === null ? {} : one.costByCurrency)
		.some((code) => Math.round(Number(one.costByCurrency[code]) * 100) >= 1));
assert.ok(visibleInMonth.length > dailyFx.month.days.filter((one) => one.inMonth === true).length * 0.8,
	'当月日历里 80% 以上的日子至少要有一个币种够 0.01（否则整片 ¥0.00，验不到格式），'
	+ '实际 ' + visibleInMonth.length + ' 天可见');
/* 至少一天两个币种都够 0.01（这样悬停能看到 `¥x+$y` 而不是单项） */
const bothVisible = dailyFx.month.days.filter((one) => one.inMonth === true
	&& one.costByCurrency !== undefined && one.costByCurrency !== null
	&& Math.round(Number(one.costByCurrency.CNY || 0) * 100) >= 1
	&& Math.round(Number(one.costByCurrency.USD || 0) * 100) >= 1);
assert.ok(bothVisible.length > 0,
	'当月至少有一天人民币和美元都够 0.01（否则悬停看不到 ¥x+$y 双币种格式）');
/* 年度同样：不能整片是小额 */
const visibleYear = dailyFx.year.months.filter((one) => one.costByCurrency !== undefined
	&& one.costByCurrency !== null
	&& Object.keys(one.costByCurrency).some((code) => Math.round(Number(one.costByCurrency[code]) * 100) >= 1));
assert.strictEqual(visibleYear.length, 12,
	'年度 12 个方块都要有够 0.01 的金额（否则年度那条也验不到格式），实际 ' + visibleYear.length);
console.log('  量级：当月可见 ' + visibleInMonth.length + ' 天（其中 ' + bothVisible.length
	+ ' 天两币种都可见），年度 12 个月全可见');

/* ---- 形态 7~11：分币种 balances 必须带 toppedUp / granted ----
 * 用户问「余额的气泡改了吗？开发模式有做对应的情况吗？」——
 * 气泡里那条「按币种折算的色条」依赖每笔 balances 的 toppedUp / granted。
 * 少了它们会静默退回顶层混合值，折算逻辑在开发模式里永远演示不出来。 */
const balAt = (n) => { const f = {}; f.balance = n; return api.devFixture(1, t, f).balance; };
for (let n = 6; n <= api.DEV_BALANCE_CLICK_SCENES - 1; n += 1) {
	const one = balAt(n);
	assert.ok(Array.isArray(one.balances) && one.balances.length > 0,
		'第 ' + (n + 1) + ' 格应当有 balances');
	one.balances.forEach((b) => {
		assert.strictEqual(typeof b.toppedUp, 'string',
			'第 ' + (n + 1) + ' 格的 ' + b.currency + ' 必须带 toppedUp（否则色条折算分支走不到）');
		assert.strictEqual(typeof b.granted, 'string',
			'第 ' + (n + 1) + ' 格的 ' + b.currency + ' 必须带 granted');
		/* 每笔自洽：充值 + 赠金 === 总额 */
		assert.ok(Math.abs(Number(b.toppedUp) + Number(b.granted) - Number(b.total)) < 1e-9,
			'第 ' + (n + 1) + ' 格 ' + b.currency + '：toppedUp(' + b.toppedUp + ') + granted('
			+ b.granted + ') 必须等于 total(' + b.total + ')');
	});
}
/* 形态 10：**两个币种都要有非零赠金** —— 这是唯一能让色条出现两段的形态 */
const withGrant = balAt(9);
assert.ok(Array.isArray(withGrant.balances) && withGrant.balances.length === 2,
	'形态 10 应当是双币种，实际 ' + JSON.stringify(withGrant.balances));
assert.ok(withGrant.balances.every((b) => Number(b.granted) > 0),
	'形态 10 的两个币种都要有非零赠金（否则色条还是 100% 灰，折算分支演示不出来），实际 '
	+ JSON.stringify(withGrant.balances.map((b) => b.currency + ':' + b.granted)));
/* 顶层混合值也要与各笔之和自洽 */
const topOk = withGrant.balances.reduce((sum, b) => sum + Number(b.toppedUp), 0);
const grantOk = withGrant.balances.reduce((sum, b) => sum + Number(b.granted), 0);
assert.ok(Math.abs(topOk - Number(withGrant.toppedUp)) < 1e-9,
	'形态 10 顶层 toppedUp 应等于各笔充值之和（' + topOk + ' vs ' + withGrant.toppedUp + '）');
assert.ok(Math.abs(grantOk - Number(withGrant.granted)) < 1e-9,
	'形态 10 顶层 granted 应等于各笔赠金之和（' + grantOk + ' vs ' + withGrant.granted + '）');
/* 形态 11：只有美元且带赠金（验证折算方向） */
const usdOnlyGrant = balAt(10);
assert.strictEqual(usdOnlyGrant.balances.length, 1, '形态 11 只有一笔');
assert.strictEqual(usdOnlyGrant.balances[0].currency, 'USD', '形态 11 是美元');
assert.ok(Number(usdOnlyGrant.balances[0].granted) > 0, '形态 11 的美元也要有赠金');
/* 场景数与可点形态数一致 */
assert.strictEqual(api.DEV_BALANCE_CLICK_SCENES, 11,
	'点击形态数应为 11（6 个老形态 + 5 个分币种形态），实际 ' + api.DEV_BALANCE_CLICK_SCENES);
/* 老契约不动 */
assert.strictEqual(api.DEV_BALANCE_ROUNDS, 6,
	'DEV_BALANCE_ROUNDS 仍是 6（scenes===null 的老路径靠它），实际 ' + api.DEV_BALANCE_ROUNDS);
console.log('  形态 7~11：每笔 balances 都带 toppedUp/granted 且各自自洽；'
	+ '形态 10 两币种都有赠金（顶层也与各笔之和自洽）；场景数 11，老契约 DEV_BALANCE_ROUNDS 仍 6');

console.log('\nDEV FIXTURE CHECKS PASSED');
