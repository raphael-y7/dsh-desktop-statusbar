/**
 * 子智能体并入「总计 / 本轮 / token」+ 撤掉拆分块 + 3 秒刷新（task-12 的断言）。
 *
 * 契约（用户澄清后的最终口径）：
 *   ① 气泡里**不再**有"本会话 / 子智能体（N 个）/ 合计"三行拆分，也没有末尾小字
 *      （"含子智能体，加载中" / "只统计前 50 个"）；相关 i18n 键
 *      `tipCostSession` / `f_subagentCost` / `tipCostTotal` / `noteSubagentLoading` /
 *      `noteSubagentTruncated` 应当从 client.js 里彻底消失。
 *   ② host 路由 `?sessionId=…&since=<毫秒>`：只统计 `event.time >= since` 的事件。
 *      **task-18 起**：不传 `since` **不再等于整会话** —— host 会读父会话日志里最后一条 `turn/start`
 *      （没有就退回最后一条 `user/message`）代推本轮起点；连父会话日志都没有就本轮为空。
 *      响应里多一个 `sinceSource: 'client' | 'host' | 'none'` 说明窗口从哪来；
 *      **要整会话必须显式传 `since=0`**（客户端就是这么发的）。
 *      非法 `since`（非数 / 空 / 负数 / 未来时刻，含 2286 年与 40 位数字）一律**当没传**（交给 host 代推）。
 *      后代数量不再有 50 上限（只留 2000 的畸形数据保险值），`truncated` 因此不该出现。
 *   ③ token 并入：气泡「总计用量」与三行明细 = 本会话 + 子会话的合计数
 *      （cacheRead→命中缓存、input+cacheWrite→未命中、output→输出），**不新增行**；
 *      底栏「总计」与「本轮」也都含子智能体。
 *   ④ 节流 60s → 3s，复用现有每秒 `now` 时钟，**不新增定时器**。
 *
 * 测法：host 侧走真实 HTTP 路由（隔离 DSH_HOME，造"父 + 两个队友"的会话日志，
 * 金额/tokens 全部能手算）；client 侧用 vm 载入 client.js 直接调 `segmentView`
 * 与合并用的纯函数，数字写死手算值。
 *
 * 全程只用隔离 DSH_HOME（tests/.dsh-test-home-subagent），不碰真实 ~/.dsh/dsh-status-bar/。
 * 用法：node tests/verify-subagent-total.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const INDEX = path.join(ROOT, 'lib', 'index.js');
const HOME = path.join(__dirname, '.dsh-test-home-subagent');

globalThis.setInterval = () => 0;
process.env.DSH_HOME = HOME;

const M = 1000000;
const BEIJING = 8 * 3600 * 1000;
const bjNow = new Date(Date.now() + BEIJING);
/* 北京时间昨天 20:00（空闲档）；"本轮"再往后一小时。用昨天是为了稳在近 7 天窗口内 */
const AT = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() - 1, 12, 0, 0);
const ROUND_AT = AT + 3600 * 1000;
/* 固定单价（单档 = 全天一个价，手算无歧义）：input 3 / cacheRead 1 / cacheWrite 0 / output 6 每百万 */
const PEAK = { input: 3, cacheRead: 1, cacheWrite: 0, output: 6 };
const PRICE = { tiered: false, peak: Object.assign({}, PEAK), offPeak: Object.assign({}, PEAK) };

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

/* ============================================================ client 侧（vm 载入） */
function loadClient(stored) {
	let code = fs.readFileSync(CLIENT, 'utf8');
	const marker = '\t\texports.apply = apply;';
	assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
	code = code.replace(marker,
		'\t\texports.__test = { segmentView, subagentSummary, subagentOf, mergeTokenParts, sessionTokenParts,'
		+ ' billableParts, tokenPanelView, SUBAGENT_REFRESH_MS, SUBAGENT_TIMEOUT_MS, BALANCE_POLL_MS,'
		+ ' nextSubagentState, applyTurnFloor, SUBAGENT_STATE_EMPTY };\n' + marker);

	const store = new Map();
	if (stored !== undefined) store.set('dsh.desktopStatusBar.v1', JSON.stringify(stored));
	const fakeWindow = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, v),
			removeItem: (k) => store.delete(k)
		},
		setInterval: () => 0, clearInterval: () => {},
		setTimeout: () => 0, clearTimeout: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) })
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };
	const sandbox = {
		window: fakeWindow,
		document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error,
		setTimeout: () => 0, clearTimeout: () => 0
	};
	sandbox.globalThis = sandbox;
	const reactStub = {
		createElement: (type, props, ...children) => ({ type: type, props: props === null || props === undefined ? {} : props, children: children }),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {}, useRef: (init) => ({ current: init === undefined ? null : init }),
		useSyncExternalStore: (subscribe, snapshot) => snapshot(),
		useCallback: (fn) => fn, useMemo: (fn) => fn(), Fragment: Symbol('Fragment')
	};
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	return captured.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
}

/* ============================================================ host 侧小工具 */
function writeSession(id, parentSession, events, headerId) {
	const header = JSON.stringify({ type: 'session', id: headerId === undefined ? id : headerId, parentSession: parentSession });
	const lines = [header].concat(events.map((one) => JSON.stringify(one)));
	const dir = path.join(HOME, 'sessions', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'usage.jsonl.zstd'),
		zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}
/** 父会话日志里的"本轮起点"事件：host 在不传 `since` 时靠它代推窗口。 */
function turnStartEvent(time) {
	return { type: 'turn/start', seq: 1, time: time, data: { turn: 1 } };
}
/** 一条用量事件（与真实会话日志同形：`data.usage` + `data.turn/step`）。 */
function usageEvent(seq, turn, step, time, model, parts) {
	return {
		type: 'assistant/message', seq: seq, time: time,
		data: {
			turn: turn, step: step,
			message: { source: { kind: 'model', provider: 'test', model: model } },
			usage: {
				inputTokens: parts.input || 0,
				cacheReadTokens: parts.cacheRead || 0,
				cacheWriteTokens: parts.cacheWrite || 0,
				outputTokens: parts.output || 0
			}
		}
	};
}
const zeroTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

(async () => {
	/* ============================================================ 一、host：路由 + since 窗口 + sinceSource */
	fs.rmSync(HOME, { recursive: true, force: true });
	fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
	/* 父会话 p-1：带一条 `turn/start`（= 本轮起点）—— 不传 since 时 host 靠它代推窗口 */
	writeSession('p-1', null, [turnStartEvent(ROUND_AT)]);
	writeSession('c-1', 'p-1', [                         /* 历史 + 本轮各一笔 */
		usageEvent(1, 1, 1, AT, 'kid-model', { input: M }),            /* ¥3 */
		usageEvent(2, 2, 2, ROUND_AT, 'kid-model', { output: M })      /* ¥6 */
	]);
	writeSession('c-2', 'p-1', [                         /* 只有历史一笔 */
		usageEvent(1, 1, 1, AT, 'kid-model', { cacheRead: 2 * M })     /* ¥2 */
	]);
	/* 父会话 p-none：只有头部，没有 turn/start 也没有 user/message ⇒ host 推不出窗口 */
	writeSession('p-none', null, []);
	writeSession('n-1', 'p-none', [usageEvent(1, 1, 1, AT, 'kid-model', { input: M })]);
	/* 父会话日志**不存在**（等同于被删）：子会话照旧，host 同样推不出窗口 */
	writeSession('g-1', 'p-ghost', [usageEvent(1, 1, 1, AT, 'kid-model', { input: M })]);
	/* 后代数量：52 与 120 都要**全部计入**（上限已放宽到 2000 的畸形数据保险值） */
	writeSession('p-many', null, [turnStartEvent(ROUND_AT)]);
	for (let i = 1; i <= 52; i += 1) {
		writeSession('m-' + i, 'p-many', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })]);
	}
	writeSession('p-120', null, [turnStartEvent(ROUND_AT)]);
	for (let i = 1; i <= 120; i += 1) {
		writeSession('w-' + i, 'p-120', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })]);
	}
	/* F1「本轮只能小不能大」：父会话有**两轮**（T1 上一轮、T2 本轮），子会话两轮各一笔。
	   客户端折叠停在上一轮时会把 T1 当 since 发出去 —— host 必须把起点收敛到
	   max(客户端 since, 父日志最后一条 turn/start / user message)。单价 input 3/1M ⇒ 每笔 ¥3。 */
	const T1 = AT;
	const T2 = AT + 3600 * 1000;
	const E1 = T1 + 60 * 1000;
	const E2 = T2 + 60 * 1000;
	writeSession('p-clamp', null, [turnStartEvent(T1), turnStartEvent(T2)]);
	writeSession('k-1', 'p-clamp', [
		usageEvent(1, 1, 1, E1, 'kid-model', { input: M }),      /* 上一轮：¥3 */
		usageEvent(2, 2, 2, E2, 'kid-model', { input: M })       /* 本轮：¥3 */
	]);
	/* F2 专用夹具：120 个后代，第一次查询必须是"冷"的（别的用例查过的会话会命中缓存，
	   就数不到读了几个文件了） */
	writeSession('p-perf', null, [turnStartEvent(ROUND_AT)]);
	for (let i = 1; i <= 120; i += 1) {
		writeSession('f-' + i, 'p-perf', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })]);
	}
	/* 3b 专用夹具（"本轮起点被误判"的回归）：父会话**自己已经产出**（turn/start + 一条带
	   usage 的 assistant/message），而队友那一份**只有头部、还没有任何用量事件**。
	   旧实现这道校验看的是"队友的 total.calls" —— 这几秒里它必然是 0，于是把起点判成
	   无效（sinceSource 从 host 掉成 none，实测复现）。正确判据是**父会话自己**在窗口内
	   有没有用量事件：有，就说明这个 turn/start 是活的、起点有效。 */
	writeSession('p-warm', null, [
		turnStartEvent(ROUND_AT),
		usageEvent(1, 1, 1, ROUND_AT + 5000, 'lead-model', { input: M })
	]);
	/* 队友只在**上一轮**花过钱（¥3）：这样"整会话（总计）"有非零值，
	   而"本轮窗口"里队友是 0 —— 正好用来钉住"修正只动 host 那条路，
	   since=0 的整会话口径一个字都不许变"。 */
	writeSession('q-1', 'p-warm', [usageEvent(1, 1, 1, AT, 'kid-model', { input: M })]);
	/* 反面对照：父会话有 turn/start，但它自己**也没有**窗口内用量事件，队友同样没有
	   ⇒ 起点无从验证，仍按"宁少不多"归零 —— 这道校验不能被改没。 */
	writeSession('p-quiet', null, [turnStartEvent(ROUND_AT)]);
	writeSession('r-1', 'p-quiet', []);
	/* 反面对照 2（防"修过头"）：父会话**有用量事件，但它在窗口之前**（上一轮）。
	   证据必须是"窗口内"的，不能拿"父会话这一辈子有过用量"当通行证 ——
	   否则一个陈旧的 turn/start 会被永远当成有效起点。 */
	writeSession('p-old', null, [
		usageEvent(1, 1, 1, AT, 'lead-model', { input: M }),
		turnStartEvent(ROUND_AT)
	]);
	writeSession('s-1', 'p-old', []);

	/* fs 读探针：index.js 用 `import { readFileSync } from 'node:fs'`，
	   必须在 **import 之前**替换 builtin 上那个函数，才数得到它真实的读取次数
	   （F2 要验"只改 1 个文件时不该全量重读"）。 */
	let fsReads = 0;
	const realReadFileSync = fs.readFileSync;
	fs.readFileSync = function (...args) { fsReads += 1; return realReadFileSync.apply(this, args); };

	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	let handler = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (r) => { if (r.path === '/dsh-desktop-statusbar/api') handler = r.handler; return () => {}; } },
		credentials: undefined
	});
	assert.ok(handler !== null, 'host 路由已注册');
	const hit = (pathname, options) => new Promise((resolve) => {
		const opts = options === undefined ? {} : options;
		let status = null, body = null;
		const res = { writeHead: (c) => { status = c; }, end: (text) => { body = text; } };
		const listeners = {};
		const req = {
			url: pathname,
			method: opts.method === undefined ? 'GET' : opts.method,
			on: (name, fn) => { listeners[name] = (listeners[name] || []).concat([fn]); return req; },
			destroy: () => {}
		};
		const pending = Promise.resolve(handler(req, res));
		if (opts.body !== undefined) (listeners.data || []).forEach((fn) => fn(opts.body));
		(listeners.end || []).forEach((fn) => fn());
		pending.then(() => resolve({ status, body: body === null ? null : JSON.parse(body) }));
	});
	const SUB = '/dsh-desktop-statusbar/api/subagent-usage';
	const get = (query) => hit(SUB + '?' + query);

	const posted = await hit('/dsh-desktop-statusbar/api/prices', {
		method: 'POST',
		body: JSON.stringify({ models: { 'kid-model': PRICE } })
	});
	assert.strictEqual(posted.status, 200, '先报一份固定单价（手算基准）');

	/* 1. 显式 `since=0` = 整会话（新语义：不传不再等于整会话）：c-1 ¥3+¥6、c-2 ¥2 = ¥11 */
	const all = await get('sessionId=p-1&since=0');
	assert.strictEqual(all.status, 200, '整会话查询 200');
	assert.strictEqual(all.body.ok, true, '整会话查询 ok');
	assert.strictEqual(all.body.sessionId, 'p-1', '回带 sessionId');
	assert.strictEqual(all.body.sinceSource, 'client', '显式 since=0 ⇒ 窗口来源是客户端，实际 ' + all.body.sinceSource);
	assert.strictEqual(all.body.children.length, 2, '两个队友都在，实际 ' + JSON.stringify(all.body.children.map((c) => c.id)));
	assert.strictEqual(all.body.total.cost, 11, '整会话金额 = 3 + 6 + 2 = ¥11，实际 ' + all.body.total.cost);
	assert.deepStrictEqual(deep(all.body.total.tokens),
		{ input: M, cacheRead: 2 * M, cacheWrite: 0, output: M }, '整会话 tokens 手算对上');
	assert.strictEqual(all.body.total.calls, 3, '整会话 3 次调用');
	assert.strictEqual(all.body.truncated, undefined, '没超上限不该有 truncated');
	const byId = (payload, id) => payload.children.filter((one) => one.id === id)[0];
	assert.deepStrictEqual(deep(byId(all.body, 'c-1')),
		{ id: 'c-1', cost: 9, tokens: { input: M, cacheRead: 0, cacheWrite: 0, output: M }, calls: 2 }, 'c-1 明细手算对上');
	assert.deepStrictEqual(deep(byId(all.body, 'c-2')),
		{ id: 'c-2', cost: 2, tokens: { input: 0, cacheRead: 2 * M, cacheWrite: 0, output: 0 }, calls: 1 }, 'c-2 明细手算对上');
	console.log('一 1 since=0（整会话）：c-1 ¥3+¥6、c-2 ¥2 ⇒ ¥11 / 3 次调用，sinceSource=client');

	/* 2. 客户端给本轮起点：只剩窗口内那一笔（c-1 的 ¥6），c-2 仍在列表里但为 0 */
	const win = await get('sessionId=p-1&since=' + encodeURIComponent(String(ROUND_AT)));
	assert.strictEqual(win.body.sinceSource, 'client', '客户端给了起点 ⇒ client');
	assert.strictEqual(win.body.total.cost, 6, 'since 窗口内只有 c-1 本轮 ¥6，实际 ' + win.body.total.cost);
	assert.deepStrictEqual(deep(win.body.total.tokens),
		{ input: 0, cacheRead: 0, cacheWrite: 0, output: M }, '窗口内 tokens 只剩 output 1M');
	assert.strictEqual(win.body.total.calls, 1, '窗口内 1 次调用');
	assert.strictEqual(win.body.children.length, 2, '窗口不影响"有哪些队友"（都还列着）');
	assert.strictEqual(byId(win.body, 'c-2').cost, 0, '窗口外的队友给 0 而不是消失');
	assert.deepStrictEqual(deep(byId(win.body, 'c-2').tokens), zeroTokens(), '窗口外的队友 tokens 全 0');
	assert.ok(win.body.total.cost < all.body.total.cost, '窗口口径必须小于整会话口径');
	console.log('一 2 客户端给起点：窗口内只剩 ¥6 / 1 次调用（c-2 仍列出、为 0）');

	/* 3. **不传 since** = host 读父会话日志里最后一条 `turn/start` 代推本轮起点（task-18 新语义） */
	const inferred = await get('sessionId=p-1');
	assert.strictEqual(inferred.body.sinceSource, 'host', '不传 since ⇒ host 代推，实际 ' + inferred.body.sinceSource);
	assert.strictEqual(inferred.body.total.cost, 6, '父会话最后一条 turn/start = ROUND_AT ⇒ 只剩本轮 ¥6，实际 ' + inferred.body.total.cost);
	assert.deepStrictEqual(deep(inferred.body.total), deep(win.body.total),
		'host 代推与客户端传同一起点必须等价（只有来源不同）');
	assert.ok(inferred.body.total.cost < all.body.total.cost, '代推的窗口口径绝不是整会话');

	/* 4. 边界：`event.time >= since` 算进来；起点 +1ms ⇒ 0 */
	const pastEdge = await get('sessionId=p-1&since=' + encodeURIComponent(String(ROUND_AT + 1)));
	assert.strictEqual(pastEdge.body.total.cost, 0, '窗口起点晚于所有事件 ⇒ 0');
	assert.strictEqual(pastEdge.body.children.length, 2, '仍然列出两个队友（只是都是 0）');
	assert.strictEqual(byId(pastEdge.body, 'c-1').cost, 0, 'c-1 也没有窗口内事件了');

	/* 5. 非法 / 超长 since：新的语义是**当没传**（交给 host 代推），不再是"当整会话" */
	for (const bad of ['abc', '', 'NaN', 'undefined', '-100', '9999999999999', '1'.padEnd(40, '0')]) {
		const one = await get('sessionId=p-1&since=' + encodeURIComponent(bad));
		assert.strictEqual(one.status, 200, '非法 since 不该报错：' + String(bad));
		assert.strictEqual(one.body.sinceSource, 'host', '非法/超长 since 当没传 ⇒ host 代推：' + JSON.stringify(bad));
		assert.strictEqual(one.body.total.cost, 6,
			'当没传 ⇒ 走 host 代推的本轮窗口（¥6），不是整会话 ¥11：' + JSON.stringify(bad));
	}
	console.log('一 3/4/5 不传 ⇒ host 代推（= 客户端同起点，¥6）· 非法/超长 since 一律当没传 · 起点 +1ms ⇒ 0');

	/* 6. 父会话推不出窗口（没有 turn/start，也没有 user/message）⇒ sinceSource='none'、本轮全 0，
	      但队友仍列在 children 里（保持形状一致）；要整会话必须显式 since=0。 */
	const noStart = await get('sessionId=p-none');
	assert.strictEqual(noStart.body.sinceSource, 'none', '父会话日志里推不出起点 ⇒ none，实际 ' + noStart.body.sinceSource);
	assert.strictEqual(noStart.body.total.cost, 0, '推不出窗口 ⇒ 本轮什么都不并，实际 ' + noStart.body.total.cost);
	assert.deepStrictEqual(deep(noStart.body.total.tokens), zeroTokens(), 'tokens 全 0');
	assert.strictEqual(noStart.body.total.calls, 0, '调用数 0');
	assert.deepStrictEqual(deep(noStart.body.children),
		[{ id: 'n-1', cost: 0, tokens: zeroTokens(), calls: 0 }], '队友仍列出来、全 0（不是空数组，保持形状一致）');
	assert.deepStrictEqual(deep(noStart.body.total.stats), { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
		'没有窗口时 stats 也全 0');
	const noStartWhole = await get('sessionId=p-none&since=0');
	assert.strictEqual(noStartWhole.body.sinceSource, 'client', '显式 since=0 仍是 client');
	assert.strictEqual(noStartWhole.body.total.cost, 3, '显式要整会话 ⇒ ¥3（绝不靠"不传"退回整会话）');

	/* 7. 父会话日志不存在（等同于被删）：同样 none + 全 0，绝不退回整会话 */
	const ghost = await get('sessionId=p-ghost');
	assert.strictEqual(ghost.body.sinceSource, 'none', '父会话日志没了 ⇒ none，实际 ' + ghost.body.sinceSource);
	assert.strictEqual(ghost.body.total.cost, 0, '绝不退回整会话，实际 ' + ghost.body.total.cost);
	assert.strictEqual(byId(ghost.body, 'g-1').cost, 0, '子会话照旧列出来（全 0）');
	const ghostWhole = await get('sessionId=p-ghost&since=0');
	assert.strictEqual(ghostWhole.body.total.cost, 3, '显式 since=0 才拿整会话（¥3）');
	console.log('一 6/7 推不出窗口 ⇒ sinceSource=none、本轮全 0（队友仍列出）· 父会话日志没了也一样 · 要整会话必须显式 since=0');

	/* 7b. 「本轮起点被误判」回归（本轮修复）：父会话**自己已经产出**（turn/start 之后一条
	       带 usage 的 assistant/message），而队友那一份只有头部、窗口内一个用量事件都没有。
	       旧实现这道校验只看队友的 `total.calls` ⇒ 这几秒里必然是 0 ⇒ 把起点判成无效
	       （sinceSource 从 host 掉成 none）。父会话自己那条用量事件就是"起点是活的"的
	       直接证据，起点必须保住为 host。 */
	const warm = await get('sessionId=p-warm');
	assert.strictEqual(warm.status, 200, '父会话有产出、队友未产出：HTTP 200');
	assert.strictEqual(warm.body.ok, true, '仍然是 ok:true（形状不变）');
	assert.strictEqual(warm.body.sinceSource, 'host',
		'父会话自己窗口内有用量事件 ⇒ 起点有效、来源仍是 host（修复前这里是 none），实际 ' + warm.body.sinceSource);
	assert.strictEqual(warm.body.total.cost, 0, '队友本轮确实没产出 ⇒ 本轮队友费用 0（不是靠"判起点无效"得到的 0）');
	assert.strictEqual(warm.body.total.calls, 0, '队友窗口内 0 次调用');
	assert.strictEqual(warm.body.children.length, 1, '队友仍列出来');
	assert.deepStrictEqual(deep(warm.body.children),
		[{ id: 'q-1', cost: 0, tokens: zeroTokens(), calls: 0 }], '队友全 0（它只在上一轮花过钱）');
	/* 关键边界：这只影响 host 推窗口那条路。`since=0`（「总计」）走的是 client 分支，
	   队友上一轮那笔 ¥3 必须原样在，口径一个字都不许变。 */
	const warmWhole = await get('sessionId=p-warm&since=0');
	assert.strictEqual(warmWhole.body.sinceSource, 'client', '显式 since=0 仍是 client');
	assert.strictEqual(warmWhole.body.total.cost, 3, '总计口径不变：队友上一轮那笔 ¥3 照算，实际 ' + warmWhole.body.total.cost);
	assert.strictEqual(warmWhole.body.total.calls, 1, '总计 1 次调用');
	/* 客户端显式给起点那条路（client 分支）同样不受影响：起点取本轮 ⇒ 队友 0；
	   起点取 0 ⇒ 整会话 ¥3。与 host 那条路的差别只在"起点从哪来"。 */
	const warmClientTurn = await get('sessionId=p-warm&since=' + encodeURIComponent(String(ROUND_AT)));
	assert.strictEqual(warmClientTurn.body.sinceSource, 'client', '客户端给起点 ⇒ client（不参与这道校验）');
	assert.strictEqual(warmClientTurn.body.total.cost, 0, '客户端给的本轮起点里队友 0');
	const warmClientAll = await get('sessionId=p-warm&since=0');
	assert.deepStrictEqual(deep(warmClientAll.body.total), deep(warmWhole.body.total),
		'client 分支的整会话结果稳定（两次问同一口径逐字段相同）');
	/* 反面：父会话有 turn/start，但它自己窗口内也没有用量事件、队友也没有 ⇒ 起点仍无从验证，
	   继续按"宁少不多"归零 —— 这道校验不能被改没。 */
	const quiet = await get('sessionId=p-quiet');
	assert.strictEqual(quiet.body.sinceSource, 'none',
		'父会话自己也没产出 ⇒ 起点无从验证，仍归零为 none，实际 ' + quiet.body.sinceSource);
	assert.strictEqual(quiet.body.total.cost, 0, '仍然是 0');
	assert.deepStrictEqual(deep(quiet.body.children),
		[{ id: 'r-1', cost: 0, tokens: zeroTokens(), calls: 0 }], '队友仍列出、全 0');
	/* 反面 2（防"修过头"）：父会话有用量事件，但落在**窗口之前**（上一轮）。
	   证据必须是窗口内的，不能拿"父会话这辈子有过用量"当通行证。 */
	const oldParent = await get('sessionId=p-old');
	assert.strictEqual(oldParent.body.sinceSource, 'none',
		'父会话的用量事件在窗口之前 ⇒ 不算窗口内证据，仍归零，实际 ' + oldParent.body.sinceSource);
	assert.strictEqual(oldParent.body.total.cost, 0, '仍然 0');
	console.log('一 7b 起点证据：父会话已产出+队友未产出 ⇒ sinceSource=host（修复前 none）、费用仍 0 · '
		+ '父会话自己也没产出 / 用量落在窗口之前 ⇒ 仍 none · since=0 的整会话口径不变（¥3）');

	/* 8. 后代数量：52 个与 120 个都**全部计入**（上限已放宽到 2000 的畸形数据保险值，不再截断） */
	const many = await get('sessionId=p-many&since=0');
	assert.strictEqual(many.body.truncated, undefined, '52 个后代不该再截断');
	assert.strictEqual(many.body.sinceSource, 'client', '显式 since=0 ⇒ client');
	assert.strictEqual(many.body.children.length, 52, '52 个后代全部列出来，实际 ' + many.body.children.length);
	assert.strictEqual(many.body.total.calls, 52, '52 次调用全部计入');
	assert.strictEqual(many.body.total.cost, 156, '52 × ¥3 = ¥156，实际 ' + many.body.total.cost);
	const sumOf = (payload, pick) => payload.children.reduce((acc, one) => acc + pick(one), 0);
	assert.strictEqual(many.body.total.cost, Math.round(sumOf(many.body, (one) => one.cost) * 1e6) / 1e6, 'total.cost = 各 child 之和');
	assert.strictEqual(many.body.total.calls, sumOf(many.body, (one) => one.calls), 'total.calls = 各 child 之和');
	assert.strictEqual(many.body.total.tokens.input, sumOf(many.body, (one) => one.tokens.input), 'total.tokens 也等于各 child 之和');
	const hundred = await get('sessionId=p-120&since=0');
	assert.strictEqual(hundred.body.truncated, undefined, '120 个后代也不截断');
	assert.strictEqual(hundred.body.children.length, 120, '120 个全部列出来，实际 ' + hundred.body.children.length);
	assert.strictEqual(hundred.body.total.calls, 120, '120 次调用全部计入');
	assert.strictEqual(hundred.body.total.cost, 360, '120 × ¥3 = ¥360，实际 ' + hundred.body.total.cost);
	console.log('一 8 后代数量：52 个 ⇒ ¥156 / 52 次、120 个 ⇒ ¥360 / 120 次，都不截断且 total 与 children 自洽');

	/* 9. 没有队友：空数组 + 零值（不是 404）；非法 sessionId 仍 400 */
	const lonely = await get('sessionId=lonely-session');
	assert.strictEqual(lonely.status, 200, '没有队友也返回 200');
	assert.strictEqual(lonely.body.ok, true, 'ok 仍为 true');
	assert.strictEqual(lonely.body.sinceSource, 'none', '连父会话都没有 ⇒ none，实际 ' + lonely.body.sinceSource);
	assert.deepStrictEqual(deep(lonely.body.children), [], '没有队友 → 空数组');
	assert.strictEqual(lonely.body.total.cost, 0, '金额 0');
	assert.deepStrictEqual(deep(lonely.body.total.tokens), zeroTokens(), 'tokens 全 0');
	assert.strictEqual(lonely.body.total.calls, 0, '调用数 0');
	const bogus = await get('sessionId=');
	assert.strictEqual(bogus.status, 400, '非法 sessionId 仍 400');
	console.log('一 9 无队友：空数组 + 零值（200，sinceSource=none）· 非法 sessionId 400');

	/* 10. 队友用量缓存必须**跟价格走**：缓存键里带价格指纹。
	   否则用户在设置页改了价，气泡里的队友金额会一直显示旧价（"总计"对不上）。 */
	const doublePrice = {
		tiered: false,
		peak: { input: 6, cacheRead: 2, cacheWrite: 0, output: 12 },
		offPeak: { input: 6, cacheRead: 2, cacheWrite: 0, output: 12 }
	};
	const doubled = await hit('/dsh-desktop-statusbar/api/prices', {
		method: 'POST',
		body: JSON.stringify({ models: { 'kid-model': doublePrice } })
	});
	assert.strictEqual(doubled.status, 200, '翻倍价目表上报成功');
	const afterPrice = await get('sessionId=p-1&since=0');
	assert.strictEqual(afterPrice.body.total.cost, 22, '换价后要按新价重算（¥11 → ¥22），实际 ' + afterPrice.body.total.cost);
	await hit('/dsh-desktop-statusbar/api/prices', {
		method: 'POST',
		body: JSON.stringify({ models: { 'kid-model': PRICE } })
	});
	const restored = await get('sessionId=p-1&since=0');
	assert.strictEqual(restored.body.total.cost, 11, '换回原价后回到 ¥11，实际 ' + restored.body.total.cost);
	console.log('一 10 缓存跟价格走：¥11 →（价翻倍）¥22 →（换回）¥11');

	/* 11. F1「本轮只能小不能大」：客户端折叠停在上一轮（发来陈旧起点 T1）时，
	       host 必须把起点收敛为 max(客户端 since, 父日志最后一条 turn/start)，只收紧、不放松。
	       单价 input 3/1M ⇒ 上一轮一笔 ¥3、本轮一笔 ¥3（整会话 ¥6）。 */
	const stale = await get('sessionId=p-clamp&since=' + encodeURIComponent(String(T1)));
	const correct = await get('sessionId=p-clamp&since=' + encodeURIComponent(String(T2)));
	assert.strictEqual(stale.status, 200, '陈旧起点也要 200');
	assert.strictEqual(stale.body.total.cost, 3, '陈旧起点必须被收敛到本轮 ⇒ 只算 ¥3（修正前是 ¥6）');
	assert.strictEqual(stale.body.total.calls, 1, '只算 1 次调用（修正前是 2）');
	assert.deepStrictEqual(deep(stale.body.total), deep(correct.body.total),
		'陈旧起点的结果必须与"正确起点"逐字段相同（含 tokens/stats）');
	assert.strictEqual(correct.body.total.cost, 3, '正确起点：本轮一笔 ¥3');
	assert.strictEqual(correct.body.total.calls, 1, '正确起点：1 次调用');
	/* 只收紧：客户端给的起点比父日志最后一条更新时必须保留它（不许放松回 T2）。
	   起点取 E2+1ms ⇒ 窗口里一个事件都没有；若实现错用 min() 就会把 E2 那笔又算进来。 */
	const later = await get('sessionId=p-clamp&since=' + encodeURIComponent(String(E2 + 1)));
	assert.strictEqual(later.body.total.cost, 0, '客户端起点更晚 ⇒ 保留它（E2 之后 ⇒ 窗口内没有事件）');
	assert.strictEqual(later.body.total.calls, 0, '也不能偷偷把 T2 的事件算进来');
	/* 边界：起点正好等于事件时刻仍算进来 */
	const clampEdge = await get('sessionId=p-clamp&since=' + encodeURIComponent(String(E2)));
	assert.strictEqual(clampEdge.body.total.cost, 3, 'since 正好等于 E2 ⇒ 那一笔算进来');
	/* 不传 ⇒ host 代推最近一条 turn/start（T2）⇒ 与本轮一致 */
	const clampInferred = await get('sessionId=p-clamp');
	assert.strictEqual(clampInferred.body.total.cost, 3, '不传 ⇒ host 代推 T2 ⇒ ¥3');
	/* 显式整会话不参与收敛 */
	const clampWhole = await get('sessionId=p-clamp&since=0');
	assert.strictEqual(clampWhole.body.total.cost, 6, 'since=0 是显式整会话，不参与收敛 ⇒ ¥6（两笔）');
	assert.strictEqual(clampWhole.body.total.calls, 2, '整会话 2 次调用');
	assert.ok(stale.body.total.cost <= clampWhole.body.total.cost, '本轮永远不得大于整会话');
	/* 收敛标记 `sinceClamped`：只有真的被收紧时才出现且为 true（与 truncated 同风格），其余情况不出现 */
	assert.strictEqual(stale.body.sinceSource, 'client', '被收敛时来源仍是 client（起点是客户端给的）');
	assert.strictEqual(stale.body.sinceClamped, true, '陈旧起点被收紧 ⇒ sinceClamped=true');
	[[correct, '客户端起点与父日志推的一致（未收紧）'], [later, '客户端起点更晚（未收紧）'],
		[clampEdge, '起点正好等于事件时刻（未收紧）'], [clampInferred, '不传（host 代推，不是收紧）'],
		[clampWhole, 'since=0（显式整会话，不参与收敛）']].forEach((pair) => {
		assert.strictEqual(pair[0].body.sinceClamped, undefined, pair[1] + ' ⇒ 不该出现 sinceClamped 字段');
	});
	console.log('一 11 F1 收敛：陈旧起点 ¥' + stale.body.total.cost + ' / ' + stale.body.total.calls
		+ ' 次（= 正确起点，窗口来源 ' + stale.body.sinceSource + '）· 更晚的起点保留客户端值 · since=0 不参与收敛（¥'
		+ clampWhole.body.total.cost + '）');

	/* 12. F2 性能：120 个后代时缓存上限必须够用 —— 只改 1 个文件，重算不该退化成全量解压 */
	const indexSource = fs.readFileSync(INDEX, 'utf8');
	const maxDescendants = Number((/const SUBAGENT_MAX_DESCENDANTS = (\d+)/.exec(indexSource) || [])[1]);
	const fileCacheMax = Number((/const SUBAGENT_FILE_CACHE_MAX = (\d+)/.exec(indexSource) || [])[1]);
	assert.ok(Number.isFinite(maxDescendants) && Number.isFinite(fileCacheMax),
		'两个常量都要能从 index.js 里读到（实际 ' + maxDescendants + ' / ' + fileCacheMax + '）');
	assert.ok(fileCacheMax >= maxDescendants * 2,
		'文件缓存上限要 ≥ 后代上限 × 2（客户端固定发"整会话 + 本轮"两个窗口，一个会话要占两格）：实际 '
		+ fileCacheMax + ' vs ' + (maxDescendants * 2));
	fsReads = 0;
	const f2Cold = await get('sessionId=p-perf&since=0');
	const coldReads = fsReads;
	assert.strictEqual(f2Cold.body.children.length, 120, '120 个后代全部计入');
	assert.strictEqual(f2Cold.body.total.calls, 120, '120 次调用全部计入');
	assert.ok(coldReads >= 100, '冷启动本来就要把每个后代日志读一遍（实际 ' + coldReads + ' 次）');
	/* 只动一个后代文件：追加一条全 0 用量的"被中断尝试"（长度变了 ⇒ 该文件的缓存键失效；全 0 不计调用） */
	const touched = path.join(HOME, 'sessions', 'f-1', 'usage.jsonl.zstd');
	fs.writeFileSync(touched, zlib.zstdCompressSync(Buffer.from([
		JSON.stringify({ type: 'session', id: 'f-1', parentSession: 'p-perf' }),
		JSON.stringify(usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })),
		JSON.stringify(usageEvent(99, 9, 9, ROUND_AT, 'kid-model', {}))
	].join('\n') + '\n', 'utf8')));
	fsReads = 0;
	const f2Warm = await get('sessionId=p-perf&since=0');
	const warmReads = fsReads;
	assert.strictEqual(f2Warm.body.children.length, 120, '改一个文件后仍是 120 个后代');
	assert.strictEqual(f2Warm.body.total.calls, 120, '全 0 的那条不算调用（结果不该变）');
	assert.ok(warmReads <= 3, '只改了 1 个文件 ⇒ 重算只该重读那一个（实际 ' + warmReads + ' 次；修正前是 '
		+ coldReads + ' 次全量重读）');
	assert.ok(warmReads * 4 < coldReads, '重读次数必须远小于后代数（120）');
	console.log('一 12 F2 缓存：冷启动读 ' + coldReads + ' 次 · 只改 1 个文件后读 ' + warmReads
		+ ' 次（后代 120）· 缓存上限 ' + fileCacheMax + ' ≥ 上限×2 = ' + (maxDescendants * 2));

	/* 13. 同一个会话 id 出现在两个文件里（日志格式升级留下旧文件 / 手工复制过目录）：
	       只认**最新那一份**参与聚合 —— 既不能把同一批用量算两遍（偏大），也不能让旧文件的过期数字盖掉新的。 */
	writeSession('dup-a', 'p-dup', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })], 'dup-1');
	writeSession('dup-b', 'p-dup', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: 2 * M })], 'dup-1');
	/* 把两份文件的 mtime 定死：dup-a 旧、dup-b 新 ⇒ 必须取 dup-b（避免只靠写入顺序撞运气） */
	const nowMs = Date.now();
	fs.utimesSync(path.join(HOME, 'sessions', 'dup-a', 'usage.jsonl.zstd'), new Date(nowMs - 120000), new Date(nowMs - 120000));
	fs.utimesSync(path.join(HOME, 'sessions', 'dup-b', 'usage.jsonl.zstd'), new Date(nowMs - 60000), new Date(nowMs - 60000));
	const dup = await get('sessionId=p-dup&since=0');
	const sameId = dup.body.children.filter((one) => one.id === 'dup-1');
	assert.strictEqual(sameId.length, 1, '同一个 id 只该出现在 children 里一次（不重复计入）');
	assert.strictEqual(dup.body.total.calls, 1, '也不能算成 2 次调用，实际 ' + dup.body.total.calls);
	assert.strictEqual(dup.body.total.cost, 6, '取最新那份（input 2M × ¥3 = ¥6），不是 ¥3 也不是两份相加的 ¥9');
	assert.strictEqual(byId(dup.body, 'dup-1').cost, 6, '明细也取最新那份');
	console.log('一 13 同 id 两份文件：只认一份（取 mtime 较新者）⇒ ¥6 / 1 次，不是 ¥9 / 2 次');

	/* 14. 失败不缓存：头部读不出来的文件下次请求要重试（否则一次坏文件会让队友永远漏掉） */
	const badDir = path.join(HOME, 'sessions', 'bad-1');
	fs.mkdirSync(badDir, { recursive: true });
	fs.writeFileSync(path.join(badDir, 'usage.jsonl.zstd'), 'not a zstd frame', 'utf8');
	const badFirst = await get('sessionId=p-bad&since=0');
	assert.strictEqual(badFirst.body.children.length, 0, '头部读不出来的文件先被跳过，实际 ' + badFirst.body.children.length);
	assert.strictEqual(badFirst.body.total.cost, 0, '这一问是 0');
	writeSession('bad-1', 'p-bad', [usageEvent(1, 1, 1, ROUND_AT, 'kid-model', { input: M })]);
	const badSecond = await get('sessionId=p-bad&since=0');
	assert.strictEqual(badSecond.body.children.length, 1, '文件修好后必须重试成功（失败结果不许被永久缓存）');
	assert.strictEqual(badSecond.body.total.cost, 3, '重试成功后按 ¥3 计入');
	console.log('一 14 头部读失败不缓存：坏文件先漏掉、修好后下一问就补上（¥0 → ¥3）');

	/* ============================================================ 二、client：并入 + 撤拆分块 + 1s */
	const api = loadClient({
		version: 6, priceVersion: 2, enabled: true, wrap: true, currency: 'CNY',
		models: { 'kid-model': PRICE }, modelOrder: ['kid-model']
	});
	const t = (key, params) => {
		const dict = {
			f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
			f_tokensTotal: '总计用量', f_tokensTurn: '本轮用量',
			f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出',
			f_ttft: '首字平均 {duration}', f_cacheHit: '综合命中 {percent}%', f_speed: '综合速度 {throughput}t/s'
		};
		let out = dict[key] !== undefined ? dict[key] : '<' + key + '>';
		if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
		return out;
	};
	/* 本会话：一次调用 input 1M ⇒ ¥3；token 投影 = 命中 1M / 未命中 2M / 输出 3M */
	const TURN_CALL = { at: AT, model: 'kid-model', input: M, cacheRead: 0, cacheWrite: 0, output: 0 };
	const baseSrc = {
		usage: { cacheReadTokens: M, uncachedInputTokens: 2 * M, cacheWriteTokens: 0, outputTokens: 3 * M },
		sessionUsage: { models: {}, calls: [TURN_CALL], current: { calls: [TURN_CALL] }, last: null, turn: 1 },
		sessionModel: { provider: 'test', model: 'kid-model' },
		currency: 'CNY', now: AT, turnUsage: null
	};
	/* 队友：整会话 ¥2.5 / 命中 1M / 未命中 2M / 输出 3M；本轮 ¥1.25 / 输出 1M */
	const SUB_OK = {
		session: { ok: true, sessionId: 'p-1', children: [], total: { cost: 2.5, tokens: { input: 2 * M, cacheRead: M, cacheWrite: 0, output: 3 * M }, calls: 2 } },
		turn: { ok: true, sessionId: 'p-1', children: [], total: { cost: 1.25, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: M }, calls: 1 } }
	};
	const withSub = Object.assign({}, baseSrc, { subagent: SUB_OK });
	const noSub = Object.assign({}, baseSrc);

	/* ① 不再有拆分块与小字 */
	const tip = api.segmentView('cost', withSub, t).tip;
	assert.strictEqual(tip.kind, 'tokens', '总计气泡还是令牌面板');
	assert.strictEqual(tip.panel.rows.length, 3, '只有原来那三行：命中 / 未命中 / 输出，不新增行');
	assert.deepStrictEqual(deep(tip.panel.rows.map((one) => one.label)), ['输入(命中缓存)', '输入(未命中缓存)', '输出'], '三行文案不变');
	assert.strictEqual(tip.panel.extra, undefined, '不再有 extra 拆分块（本会话 / 子智能体 / 合计）');
	assert.strictEqual(tip.panel.note, undefined, '面板不再有末尾小字');
	assert.strictEqual(tip.note, undefined, 'tip 上也不该挂小字');
	assert.strictEqual(tip.extra, undefined, 'tip 上也不该有 extra');
	const tipText = JSON.stringify(tip);
	['子智能体', '合计', '加载中', '只统计前 50 个', 'tipCostSession', 'f_subagentCost', 'tipCostTotal', 'noteSubagent'].forEach((bad) => {
		assert.strictEqual(tipText.indexOf(bad), -1, '气泡里不该再出现：' + bad);
	});
	const clientSource = fs.readFileSync(CLIENT, 'utf8');
	['tipCostSession', 'f_subagentCost', 'tipCostTotal', 'noteSubagentLoading', 'noteSubagentTruncated'].forEach((key) => {
		assert.strictEqual(clientSource.indexOf(key), -1, '撤掉的 i18n 键不该再出现在 client.js：' + key);
	});
	['输入(命中缓存)', '输入(未命中缓存)', '输出'].forEach((text) => {
		assert.ok(clientSource.indexOf(text) >= 0, '中文文案缺：' + text);
	});
	['input (cache hit)', 'input (cache miss)', 'output'].forEach((text) => {
		assert.ok(clientSource.indexOf(text) >= 0, '英文文案缺：' + text);
	});
	assert.ok(clientSource.indexOf('including the main model, subagents') >= 0, '英文费用提示要提到子智能体');
	assert.ok(clientSource.indexOf('包含主模型、子代理和辅助调用') >= 0, '中文费用提示要提到子代理');
	console.log('二 ① 气泡只有原来三行、无拆分块/小字、5 个 i18n 键已消失、中英文案齐');

	/* ② 「总计用量」与三行 = 本会话 + 队友（手算：命中 2M / 未命中 4M / 输出 6M） */
	const merged = api.mergeTokenParts(api.sessionTokenParts(withSub.usage), api.subagentOf(SUB_OK, 'session'));
	assert.deepStrictEqual(deep(merged), { cached: 2 * M, missInput: 4 * M, output: 6 * M }, '合并后的三段手算对上');
	assert.deepStrictEqual(deep(tip.panel),
		deep(api.tokenPanelView(2 * M, 4 * M, 6 * M, t)), '面板用的正是合并后的三段');
	assert.strictEqual(tip.panel.totalText, '12,000,000', '总计用量 = 2M+4M+6M = 12,000,000');
	assert.deepStrictEqual(deep(tip.panel.rows.map((one) => one.value)), ['2,000,000', '4,000,000', '6,000,000'], '三行明细是合计数');
	const noSubTip = api.segmentView('cost', noSub, t).tip;
	assert.strictEqual(noSubTip.panel.totalText, '6,000,000', '不给队友数据时只有本会话');
	assert.notStrictEqual(tip.panel.totalText, noSubTip.panel.totalText, '有队友时总计用量必须变多');

	/* ③ 底栏「总计」与「本轮」都含队友 */
	assert.strictEqual(api.segmentView('cost', noSub, t).text, '总计 ¥3.00', '本会话单独算：input 1M × ¥3 = ¥3');
	assert.strictEqual(api.segmentView('cost', withSub, t).text, '总计 ¥5.50', '总计 = ¥3 + 队友 ¥2.5 = ¥5.50');
	const turnOnly = api.segmentView('lastCost', noSub, t);
	const turnWith = api.segmentView('lastCost', withSub, t);
	assert.strictEqual(turnOnly.text, '本轮 ¥3.00', '本轮本会话 ¥3');
	assert.strictEqual(turnWith.text, '本轮 ¥4.25', '本轮 = ¥3 + 队友本轮 ¥1.25 = ¥4.25');
	assert.strictEqual(turnWith.tip.panel.totalText, '2,000,000', '本轮用量 = 本会话未命中 1M + 队友本轮输出 1M');
	console.log('二 ②③ 总计用量 12,000,000（命中 2M/未命中 4M/输出 6M）· 总计 ¥5.50 · 本轮 ¥4.25');

	/* ③b F1（客户端侧）：陈旧窗口的「本轮」**不得大于**正确窗口的「本轮」。
	   host 那边靠"起点只收紧"把陈旧起点收敛掉；客户端这边靠闸门（轮号不一致 ⇒ turnStartMs 当 null，
	   改由 host 代推）不去发陈旧起点。这里把两个窗口的渲染结果并排断言，锁住方向。 */
	const staleTurn = { ok: true, sessionId: 'p-1', children: [], total: { cost: 2, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 2 * M }, calls: 2 } };
	const freshTurn = { ok: true, sessionId: 'p-1', children: [], total: { cost: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: M }, calls: 1 } };
	const staleView = api.segmentView('lastCost', Object.assign({}, baseSrc, { subagent: { session: SUB_OK.session, turn: staleTurn } }), t);
	const freshView = api.segmentView('lastCost', Object.assign({}, baseSrc, { subagent: { session: SUB_OK.session, turn: freshTurn } }), t);
	assert.strictEqual(freshView.text, '本轮 ¥4.00', '正确窗口：本会话 ¥3 + 队友本轮 ¥1 = ¥4.00');
	assert.strictEqual(freshView.tip.panel.totalText, '2,000,000', '正确窗口的本轮用量 = 本会话 1M + 队友 1M');
	assert.strictEqual(staleView.text, '本轮 ¥5.00', '陈旧窗口会显示 ¥5.00（¥3 + ¥2）—— 正是 F1 要挡掉的偏大');
	assert.strictEqual(staleView.tip.panel.totalText, '3,000,000', '陈旧窗口的本轮用量也会偏大（3,000,000）');
	const money = (view) => Number(view.text.replace(/[^\d.]/g, ''));
	assert.ok(money(staleView) > money(freshView), '前置：陈旧窗口确实更大（否则这条断言没有意义）');
	assert.strictEqual(money(staleView) - money(freshView), 1, '两者差的正好是"多算的那一轮"（¥1）');
	/* 客户端闸门：`foldTurnUsage` 折出来的轮号与当前轮不一致时，`turnStartMs` 必须是 null（交给 host 代推），
	   这样客户端根本不会把陈旧起点发出去。 */
	const turnStartAt = clientSource.indexOf('const turnStartMs =');
	assert.ok(turnStartAt > 0, '找得到 turnStartMs 的计算处');
	const turnSlice = clientSource.slice(Math.max(0, turnStartAt - 900), turnStartAt + 260);
	assert.ok(turnSlice.indexOf('foldedTurnNow') >= 0, 'turnStartMs 来自折叠结果');
	assert.ok(/currentTurn|curTurn|hostTurn|current\s*!==|!==\s*current|turn\s*!==/.test(turnSlice),
		'turnStartMs 要与"当前轮号"比较（轮号不一致 ⇒ 起点作废），实际切片：' + JSON.stringify(turnSlice.slice(-200)));
	assert.ok(turnSlice.indexOf('null') >= 0, '不一致时当 null（改由 host 代推）');
	console.log('二 ③b F1 客户端：正确窗口 ¥4.00/2,000,000 · 陈旧窗口 ¥5.00/3,000,000（偏大 ¥1）· 闸门按轮号判起点');

	/* ④ 场景限定为**首次加载（还没有旧值）**：拿不到数据就退回"仅本会话"。
	   task-20 起，同轮内已经成功拿到过时不许再退回（要沿用上一次的值）—— 那条在 ⑦ 组验。 */
	const BAD = [
		{ name: '整块缺失', sub: undefined },
		{ name: '两段都是 null', sub: { session: null, turn: null } },
		{ name: '接口 500 / ok:false', sub: { session: { ok: false, reason: 'scan-failed' }, turn: { ok: false, reason: 'scan-failed' } } },
		{ name: '缺 total', sub: { session: { ok: true }, turn: { ok: true } } },
		{ name: 'total 形状异常', sub: { session: { ok: true, total: { tokens: 'x' } }, turn: { ok: true, total: null } } },
		{ name: '负数 / NaN / Infinity', sub: { session: { ok: true, total: { cost: -5, tokens: { input: NaN, cacheRead: -1, cacheWrite: 0, output: Infinity } } }, turn: null } }
	];
	BAD.forEach((one) => {
		const src = one.sub === undefined ? Object.assign({}, baseSrc) : Object.assign({}, baseSrc, { subagent: one.sub });
		const view = api.segmentView('cost', src, t);
		assert.strictEqual(view.text, '总计 ¥3.00', one.name + '：数字要退回"仅本会话"');
		assert.deepStrictEqual(deep(view.tip.panel), deep(noSubTip.panel), one.name + '：面板也退回仅本会话');
		const text = JSON.stringify(view);
		['加载中', 'Loading', '子智能体', '合计', 'NaN'].forEach((bad) => {
			assert.strictEqual(text.indexOf(bad), -1, one.name + '：界面不该出现「' + bad + '」');
		});
	});
	assert.deepStrictEqual(deep(api.subagentOf(SUB_OK, 'session')), { cost: 2.5, cached: M, missInput: 2 * M, output: 3 * M },
		'正常数据按 host 口径换算：cacheRead→命中、input+cacheWrite→未命中');
	/* 部分字段坏掉：坏格子当 0、能用的数字照算。
	   这是**有意的宽容**（Lead 已确认）：宁可丢掉个别坏格子，也不要让一个字符串 / NaN
	   把整块队友数据拖成 0 —— 那样等于把好数据也藏起来了。所以这里不断言"整块退回本会话"，
	   而是逐格断言：坏的 → 0，好的 → 照常并进合计。 */
	const mixedSub = { session: { ok: true, total: { cost: '2.5', tokens: { input: '1M', cacheRead: null, cacheWrite: 3, output: 'x' } } }, turn: null };
	const mixed = api.segmentView('cost', Object.assign({}, baseSrc, { subagent: mixedSub }), t);
	assert.deepStrictEqual(deep(api.subagentOf(mixedSub, 'session')), { cost: 0, cached: 0, missInput: 3, output: 0 },
		'坏格子当 0（cost "2.5"→0、"1M"→0、null→0），好格子照算（cacheWrite 3）');
	assert.strictEqual(mixed.text, '总计 ¥3.00', 'cost 不是数字 ⇒ 金额只算本会话');
	assert.strictEqual(mixed.tip.panel.totalText, '6,000,003', '未命中多出的 3 个 token 照样并进去');
	assert.strictEqual(JSON.stringify(mixed).indexOf('NaN'), -1, '不许把 NaN 带到界面上');
	console.log('二 ④ 首次加载（还没有旧值）：六种缺数据/异常形态退回仅本会话；部分坏字段只丢坏格子（无「加载中」字样）');

	/* ⑤ 节流 1 秒（用户要"实时"），且不新增定时器 */
	assert.strictEqual(api.SUBAGENT_REFRESH_MS, 1000, '节流 60s → 1s（用户要实时）');
	assert.strictEqual(api.SUBAGENT_TIMEOUT_MS, 8000, '超时上限不变');
	/* 底栏只该有两个定时器：每秒时钟（跑起来 1s / 空闲 10s）与 60s 余额轮询。
	   队友刷新复用那个每秒时钟、超时走 AbortSignal.timeout，所以这里数出来的总数不能涨。 */
	assert.strictEqual(api.BALANCE_POLL_MS, 60000, '余额轮询仍是 60s');
	const timerCount = (clientSource.match(/setInterval\(/g) || []).length;
	assert.strictEqual(timerCount, 2, '底栏定时器只该有两处（时钟 + 余额轮询），实际 ' + timerCount);
	assert.ok(clientSource.indexOf('window.setInterval(() => load(false), BALANCE_POLL_MS)') >= 0, '余额轮询用的是 BALANCE_POLL_MS');
	const fetchAt = clientSource.indexOf('SUBAGENT_URL + "?sessionId="');
	assert.ok(fetchAt > 0, '找得到队友请求的拼装处');
	const fetchSlice = clientSource.slice(Math.max(0, fetchAt - 1200), fetchAt + 600);
	assert.ok(fetchSlice.indexOf('AbortSignal.timeout') >= 0, '超时用 AbortSignal.timeout（不自己挂 setTimeout）');
	assert.strictEqual(fetchSlice.indexOf('setTimeout('), -1, '队友请求路径里不许新增 setTimeout');
	assert.strictEqual(fetchSlice.indexOf('setInterval('), -1, '队友请求路径里不许新增 setInterval');
	assert.ok(fetchSlice.indexOf('since=') >= 0, '请求要带 since 参数');
	assert.ok(fetchSlice.indexOf('&since=') >= 0, 'since 只有拿得到本轮起点时才带');
	/* task-18 起"整会话"必须显式发 since=0；本轮起点拿不到时**不传**（交给 host 按父会话日志代推） */
	assert.ok(fetchSlice.indexOf('load(0)') >= 0, '整会话那一路要显式发 since=0');
	assert.ok(fetchSlice.indexOf('load(null)') >= 0, '拿不到本轮起点时要"不传 since"，交给 host 代推');
	console.log('二 ⑤ 节流 1000ms · 定时器仍只有两处（时钟 + 60000ms 余额轮询）· '
		+ '超时走 AbortSignal.timeout · 整会话发 since=0、拿不到起点就不传');

	/* ⑥ 会话级三项（首字平均 / 缓存命中率 / 综合速度）要把子智能体并进来；**本轮与极值仍只算本会话** */
	const STATS = { ttftMs: 2000, ttftSteps: 4, decodeMs: 4000, decodeTokens: 8000, steps: 12, turns: 3 };
	const USAGE2 = { uncachedInputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 1000, outputTokens: 5000 };
	const SUB_STATS = {
		session: {
			ok: true, sessionId: 'p-1', children: [], calls: 2, cost: 2.5,
			total: {
				cost: 2.5, calls: 2,
				tokens: { input: 2000, cacheRead: 1000, cacheWrite: 0, output: 0 },
				stats: { ttftMs: 1000, ttftSteps: 1, decodeMs: 1000, decodeTokens: 1000 }
			}
		},
		turn: {
			ok: true, sessionId: 'p-1', children: [], cost: 1.25, calls: 1,
			total: {
				cost: 1.25, calls: 1,
				tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: M },
				stats: { ttftMs: 1, ttftSteps: 1, decodeMs: 1, decodeTokens: 1 }
			}
		}
	};
	const metricSrc = Object.assign({}, baseSrc, { stats: STATS, usage: USAGE2, subagent: SUB_STATS });
	const metricNoSub = Object.assign({}, baseSrc, { stats: STATS, usage: USAGE2 });
	const viewOf = (id, src) => api.segmentView(id, src, t);
	/* 首字平均：(2000 + 1000) / (4 + 1) = 600ms ⇒ 0.6s（本会话单独 2000/4 = 500ms ⇒ 0.5s） */
	assert.strictEqual(viewOf('ttft', metricSrc).text, '首字平均 0.6s', '会话级首字平均 = (本会话 ttftMs + 子 ttftMs) / (两者 steps 之和)');
	assert.strictEqual(viewOf('ttft', metricNoSub).text, '首字平均 0.5s', '没有队友时只有本会话（对照）');
	/* 综合速度（解码速度）：(8000 + 1000) / ((4000 + 1000)/1000) = 1800 t/s（本会话单独 2000） */
	assert.strictEqual(viewOf('tps', metricSrc).text, '综合速度 1800t/s', '会话级综合速度 = 合并解码 tokens / 合并解码秒');
	assert.strictEqual(viewOf('tps', metricNoSub).text, '综合速度 2000t/s', '没有队友时只有本会话（对照）');
	/* 缓存命中率：分母 = (未缓存输入 1000 + 缓存读 3000 + 缓存写 1000) + 子 cached 1000 + 子 missInput 2000 = 8000；
	   分子 = 缓存读 3000 + 子 cached 1000 = 4000 ⇒ 50.00%（本会话单独 3000/5000 = 60.00%） */
	assert.strictEqual(viewOf('cacheHit', metricSrc).text, '综合命中 50.00%',
		'会话级命中率：分母含缓存写入，且把队友 cached/missInput 也算进分母');
	assert.strictEqual(viewOf('cacheHit', metricNoSub).text, '综合命中 60.00%', '没有队友时只有本会话（对照）');
	/* 整组不计：子会话某一组缺分子或分母（0 / 非数）时，那一组**整组**不加 —— 只加半组会把平均算歪 */
	const HALF_STATS = {
		session: Object.assign({}, SUB_STATS.session, {
			total: Object.assign({}, SUB_STATS.session.total, {
				stats: { ttftMs: 5000, ttftSteps: 0, decodeMs: 0, decodeTokens: 9000 }
			})
		}),
		turn: SUB_STATS.turn
	};
	const halfSrc = Object.assign({}, baseSrc, { stats: STATS, usage: USAGE2, subagent: HALF_STATS });
	assert.strictEqual(viewOf('ttft', halfSrc).text, '首字平均 0.5s',
		'子会话首字缺 steps ⇒ 整组不计（不是只加分子算出的 1.8s）');
	assert.strictEqual(viewOf('tps', halfSrc).text, '综合速度 2000t/s',
		'子会话解码缺 ms ⇒ 整组不计（不是只加分子算出的 4250）');
	/* 回退：子会话 stats 缺失 / 坏形状 / 负数 / NaN / Infinity ⇒ 三项与"只有本会话"逐字一致，且不出现 NaN/Infinity */
	[undefined, {}, { total: {} }, { ok: true, total: {} }, { ok: true, total: { stats: 'x' } },
		{ ok: true, total: { stats: null } },
		{ ok: true, total: { stats: { ttftMs: -1, ttftSteps: NaN, decodeMs: 'x', decodeTokens: Infinity } } }].forEach((bad) => {
		const src = Object.assign({}, baseSrc, { stats: STATS, usage: USAGE2, subagent: { session: bad, turn: null } });
		['ttft', 'tps', 'cacheHit'].forEach((id) => {
			const got = viewOf(id, src);
			assert.strictEqual(got.text, viewOf(id, metricNoSub).text, id + '：坏 stats 要退回"仅本会话"');
			assert.deepStrictEqual(deep(got), deep(viewOf(id, metricNoSub)), id + '：整棵渲染树都要退回');
			assert.strictEqual(JSON.stringify(got).indexOf('NaN'), -1, id + '：不许出现 NaN');
			assert.strictEqual(JSON.stringify(got).indexOf('Infinity'), -1, id + '：不许出现 Infinity');
		});
	});
	/* 本轮与极值仍只算本会话：tip 三行在"有/无队友"下必须逐字段相同 */
	['ttft', 'tps', 'cacheHit'].forEach((id) => {
		assert.deepStrictEqual(deep(viewOf(id, metricSrc).tip), deep(viewOf(id, metricNoSub).tip),
			id + '：气泡里的本轮/极值不得受队友影响');
	});
	console.log('二 ⑥ 会话级三项并入队友：首字 0.5s→0.6s · 速度 2000→1800t/s · 命中率 60.00%→50.00%'
		+ '（分母含缓存写入）· 缺半组整组不计 · 坏 stats 逐字退回且无 NaN/Infinity · 本轮与极值不含队友');

	/* ⑦ 跨请求状态机（task-20）：「本轮」一轮之内单调不减、没拿到不归零、换轮归零重算。
	   用户实测症状是"同一轮内跳大跳小"（¥2.25 → ¥1.00 → ¥2.25）：每年两问里任一次
	   没拿到就把队友那段当 0。实现方导出了两个纯函数 + 空状态，这里直接驱动它们。 */
	const EMPTY = api.SUBAGENT_STATE_EMPTY;
	assert.deepStrictEqual(deep(EMPTY), { sessionId: null, turnKey: null, sessionPayload: null, turnPayload: null },
		'空状态形状：没有会话 / 没有轮 / 两段都没有值');
	const payloadOf = (cost, output) => ({
		ok: true, sessionId: 'p-1', children: [],
		total: { cost: cost, calls: 1, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: output } }
	});
	const TURN_A = payloadOf(2.25, 1000);
	const TURN_B = payloadOf(3.5, 2000);
	const act = (sessionId, turnKey, slice, ok, value) => ({ sessionId: sessionId, turnKey: turnKey, slice: slice, ok: ok, value: value });

	/* ⑦1 同轮内「成功 → 失败/超时 → 成功」：数字不回落 */
	const st1 = api.nextSubagentState(EMPTY, act('p-1', 7, 'turn', true, TURN_A));
	assert.deepStrictEqual(deep(st1.turnPayload), deep(TURN_A), '成功 ⇒ 存下这一份值');
	const st1Snapshot = JSON.stringify(deep(st1));
	const st2 = api.nextSubagentState(st1, act('p-1', 7, 'turn', false, null));
	assert.deepStrictEqual(deep(st2.turnPayload), deep(TURN_A), '同轮内失败/超时 ⇒ 沿用上一次成功的值（不归零）');
	assert.strictEqual(JSON.stringify(deep(st1)), st1Snapshot, '纯函数：不改入参');
	const st3 = api.nextSubagentState(st2, act('p-1', 7, 'turn', true, TURN_B));
	assert.deepStrictEqual(deep(st3.turnPayload), deep(TURN_B), '下一次成功再把值更新上去');
	/* 下限那条也喂一遍：失败那一拍调用方传 null，由同轮粘性下限顶住 */
	const step = (value) => { const one = api.applyTurnFloor(hold, 'p-1', 7, value); hold = one.hold; return one.value; };
	let hold = null;
	assert.deepStrictEqual([step(2.25), step(null), step(2.25)], [2.25, 2.25, 2.25],
		'失败那一拍传 null ⇒ 被下限顶住，金额不回落');

	/* ⑦2 同轮内窗口变小（2.5 → 0.5 → 0.1）：显示单调不减 */
	hold = null;
	assert.deepStrictEqual([step(2.5), step(0.5), step(0.1)], [2.5, 2.5, 2.5],
		'一轮之内窗口收窄也不能跳小（只增不减）');

	/* ⑦3 换轮：本轮归零重算，且下限作废（不许上一轮的较大值顶住） */
	hold = null;
	assert.strictEqual(step(2.5), 2.5, '第 7 轮：先显示 2.5');
	const rolled = api.applyTurnFloor(hold, 'p-1', 8, 0.1);
	assert.strictEqual(rolled.value, 0.1, '换轮 ⇒ 下限作废，用新一轮的真实值（不许 2.5 顶住）');
	const turnRolled = api.nextSubagentState(st3, act('p-1', 8, 'turn', false, null));
	assert.strictEqual(turnRolled.turnPayload, null, '换轮后本轮窗口归零（不许沿用上一轮的旧值）');

	/* ⑦4 换会话：本轮窗口清空；整会话那段跨轮保留（否则「总计」每轮抖一下） */
	const sess = api.nextSubagentState(EMPTY, act('p-1', 7, 'session', true, TURN_A));
	const nextTurn = api.nextSubagentState(sess, act('p-1', 8, 'turn', false, null));
	assert.deepStrictEqual(deep(nextTurn.sessionPayload), deep(TURN_A), '整会话那段跨轮保留');
	assert.strictEqual(nextTurn.turnPayload, null, '本轮窗口随轮清空');
	const otherSession = api.nextSubagentState(nextTurn, act('p-2', 1, 'session', false, null));
	assert.strictEqual(otherSession.sessionPayload, null, '换会话 ⇒ 整会话那段也要清空（不拿别的会话的值顶）');
	assert.strictEqual(otherSession.turnPayload, null, '换会话 ⇒ 本轮窗口同样清空');

	/* ⑦5 `amount === null`（界面横杠）时下限不许把它降成 0 */
	const none = api.applyTurnFloor(null, 'p-1', 7, null);
	assert.strictEqual(none.value, null, '没有下限时 null 原样传出（横杠不该变成 ¥0.00）');
	assert.strictEqual(none.hold.value, 0, '盒子里记的下限仍是 0');
	hold = api.applyTurnFloor(null, 'p-1', 7, 1.5).hold;
	const held = api.applyTurnFloor(hold, 'p-1', 7, null);
	assert.strictEqual(held.value, 1.5, '同轮内已显示过金额 ⇒ 不该退回横杠');
	assert.notStrictEqual(held.value, 0, '也不许把旧值降成 0');
	const unknownTurn = api.applyTurnFloor(hold, 'p-1', null, 0.1);
	assert.strictEqual(unknownTurn.value, 0.1, '认不出轮次（turnKey 为 null）⇒ 不做粘性');

	/* ⑦6 首次加载（还没有旧值）⇒ 两段都是 null ⇒ 界面按"仅本会话"显示 */
	assert.deepStrictEqual(deep(api.nextSubagentState(EMPTY, act('p-1', 7, 'turn', false, null))),
		deep({ sessionId: 'p-1', turnKey: 7, sessionPayload: null, turnPayload: null }),
		'首次就没拿到 ⇒ 本轮窗口 null（没有旧值可留）');
	assert.strictEqual(api.applyTurnFloor(null, 'p-1', 7, null).value, null, '首次也没金额 ⇒ 横杠');

	/* ⑦7 端到端：状态机的结果喂给界面，用户看到的「本轮」同样不跳 */
	const turnText = (state) => api.segmentView('lastCost',
		Object.assign({}, baseSrc, { subagent: { session: SUB_OK.session, turn: state.turnPayload } }), t).text;
	let live = api.nextSubagentState(EMPTY, act('p-1', 11, 'turn', true, TURN_A));
	const shownOk = turnText(live);
	assert.strictEqual(shownOk, '本轮 ¥5.25', '本轮 = 本会话 ¥3 + 队友本轮 ¥2.25');
	live = api.nextSubagentState(live, act('p-1', 11, 'turn', false, null));
	assert.strictEqual(turnText(live), shownOk, '失败那一拍界面数字不变（不跳小）');
	live = api.nextSubagentState(live, act('p-1', 11, 'turn', true, TURN_A));
	assert.strictEqual(turnText(live), shownOk, '恢复那一拍也不跳大');
	live = api.nextSubagentState(live, act('p-1', 12, 'turn', false, null));
	assert.strictEqual(turnText(live), '本轮 ¥3.00', '换轮 ⇒ 本轮归零重算（只剩本会话 ¥3）');
	console.log('二 ⑦ 跨请求状态机：同轮内 ¥2.25 失败拍不变、窗口收窄不退（2.5→0.5→0.1 仍 2.5）'
		+ '、换轮归零且下限作废、换会话两段清空（整会话跨轮保留）、null 不降 0、首次退回仅本会话');

	console.log('');
	console.log('SUBAGENT TOTAL CHECKS PASSED');
})().catch((error) => {
	console.error('SUBAGENT TOTAL CHECKS FAILED: ' + (error && error.message ? error.message : error));
	process.exitCode = 1;
});
