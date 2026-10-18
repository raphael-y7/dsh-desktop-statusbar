/**
 * 断言「本轮」计费卡死（2.2.0）：host 不能把同一轮里注入的 user/message
 * （subagent-settled / team-message / tool-jobs / skill-catalog / user-approval …）
 * 当成新一轮开始去推进「本轮窗口起点」；也不能把**同轮中途真人插话（steering）**
 * 当成新轮起点（DSH 支持同一轮里用户再发消息，但轮次没变）。
 *
 * 契约：
 *   ① 真实用户输入（source.kind === 'user'）的 user/message 只有在
 *      「最后一条 turn/end 晚于最后一条 turn/start（上一轮已结束）、且消息晚于该 turn/end」
 *      时，才算"新一轮已开始、turn/start 还没落盘"的起点候选；turn 还开着时不算。
 *   ② 同轮注入的通知既不推进 host 代推的起点，也不收缩客户端给的起点（不出 sinceClamped）。
 *   ③ 日志里完全没有 turn/start 时退回最后一条真实用户消息（老兜底）。
 *   ④ 真实用户新轮仍按原规则生效（新一轮已经开始、turn/start 还没落盘的场景不能修坏）。
 *   ⑤ 客户端「同轮只增不减」粘性下限保留：它不是根因，但它会把窗口抖动放大成"冻结"，
 *      所以这里同时钉住"修复后显示值单调增长"与"旧形态下会冻结"两种行为。
 *
 * 用法：node tests/verify-billing-stall.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'lib', 'client.js');
const INDEX = path.join(ROOT, 'lib', 'index.js');
const HOME = path.join(__dirname, '.dsh-test-home-billing-stall');

/* 隔离 DSH_HOME：绝不碰真实 ~/.dsh */
process.env.DSH_HOME = HOME;

const M = 1000000;
/* 固定单档单价（峰谷同价，与"现在几点"无关）：input 3 / cacheRead 1 / cacheWrite 0 / output 6 每百万 */
const PEAK = { input: 3, cacheRead: 1, cacheWrite: 0, output: 6 };
const PRICE = { tiered: false, peak: Object.assign({}, PEAK), offPeak: Object.assign({}, PEAK) };
const AT = Date.UTC(2026, 9, 16, 12, 0, 0);
const T0 = AT;                 /* 本轮 turn/start */
const CLIENT_SINCE = T0 + 500; /* 客户端折叠出的本轮起点（轮首真实用户输入之后、队友用量之前） */
const TURN_END = T0 + 4000;    /* p-next 用：上一轮的 turn/end */
const KID_1 = T0 + 1000;       /* k-1 的用量（本轮内） */
const KID_2 = T0 + 2000;       /* k-2 的用量（本轮内） */
const SETTLED = T0 + 3000;     /* 子代理结算通知 */
const TEAM_MSG = T0 + 4400;    /* 队友消息转发通知 */
const NEXT_USER = T0 + 5000;   /* "上一轮已结束、新轮 turn/start 未落盘"的用户消息 */
const STEER_USER = T0 + 2000;  /* 同轮中途真人插话（steering）：轮没关，不能当新轮起点 */

/* ============================================================ 工具 */
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

function writeSession(id, parentSession, events) {
	const header = JSON.stringify({ type: 'session', version: 4, id: id, parentSession: parentSession });
	const lines = [header].concat(events.map((one) => JSON.stringify(one)));
	const dir = path.join(HOME, 'sessions', id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
}
/** 一条用量事件（与真实日志同形：data.usage + data.turn/step + message.source.model） */
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
function turnStartEvent(time, turn) {
	return { type: 'turn/start', seq: 1, time: time, data: { turn: typeof turn === 'number' ? turn : 1 } };
}
/** 一轮结束（DSH 日志里的 turn/end）：用来判断"轮已经关了、下一条真人消息代表新轮" */
function turnEndEvent(time, turn) {
	return { type: 'turn/end', seq: 2, time: time, data: { turn: typeof turn === 'number' ? turn : 1 } };
}
/** 真实用户输入（DSH 日志里就是 user/message + source.kind='user'） */
function userMessageEvent(seq, time) {
	return {
		type: 'user/message', seq: seq, time: time,
		data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }
	};
}
/** 同轮注入的通知（不改轮次，但旧实现会把它当成新一轮开始） */
function noticeEvent(seq, time, kind, form) {
	return {
		type: 'user/message', seq: seq, time: time,
		data: { role: 'user', source: { kind: kind, form: form || 'notice' }, content: [{ type: 'text', text: kind }] }
	};
}

/* ============================================================ client（vm 载入） */
function loadClient(stored) {
	let code = fs.readFileSync(CLIENT, 'utf8');
	const marker = '\t\texports.apply = apply;';
	assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
	code = code.replace(marker,
		'\t\texports.__test = { segmentView, applyTurnFloor, SUBAGENT_STATE_EMPTY };\n' + marker);
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
		createElement: (type, props, ...children) => ({ type, props: props === null || props === undefined ? {} : props, children }),
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

(async () => {
	/* ============================================================ 夹具 */
	fs.rmSync(HOME, { recursive: true, force: true });
	fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });

	/* 主夹具 p-stall：轮首有真实用户输入，轮中后段有两条注入通知。
	   两个队友各在本轮花 ¥3（input 1M），全部落在通知之前。 */
	writeSession('p-stall', null, [
		turnStartEvent(T0, 1),
		userMessageEvent(2, T0 + 10),
		noticeEvent(3, SETTLED, 'subagent-settled'),
		noticeEvent(4, TEAM_MSG, 'team-message')
	]);
	writeSession('k-1', 'p-stall', [usageEvent(1, 1, 1, KID_1, 'kid-model', { input: M })]);
	writeSession('k-2', 'p-stall', [usageEvent(1, 1, 1, KID_2, 'kid-model', { input: M })]);

	/* 真实用户新轮夹具 p-next：上一轮已经 turn/end，用户消息晚于该 turn/end、且晚于全部
	   队友用量（"新一轮已开始、turn/start 还没落盘"），host 代推起点必须仍是该用户消息，
	   队友本轮因此 ¥0 —— 这条老规则不能被修没。
	   父会话在新轮里自己产出了一笔用量：这是"起点是活的"的证据（否则 host 按宁少不多
	   把起点判成 none，就测不到"推进"本身）。 */
	writeSession('p-next', null, [
		turnStartEvent(T0, 1),
		turnEndEvent(TURN_END, 1),
		userMessageEvent(3, NEXT_USER),
		usageEvent(4, 2, 1, NEXT_USER + 1000, 'lead-model', { input: M })
	]);
	writeSession('n-1', 'p-next', [usageEvent(1, 1, 1, KID_1, 'kid-model', { input: M })]);

	/* 新增边界 ①：同轮中途真人插话（steering），轮**没关**（没有 turn/end）。
	   插话只是改本轮上下文、不开新轮 ⇒ 起点仍必须是 turn/start（T0），
	   插话之前队友花的 ¥3 不能被抹掉。旧实现（取最后一条真 user 消息）会推后到
	   STEER_USER ⇒ 本轮队友变成 ¥0。 */
	writeSession('p-steer', null, [
		turnStartEvent(T0, 1),
		userMessageEvent(2, T0 + 10),
		userMessageEvent(3, STEER_USER),
		usageEvent(4, 1, 1, STEER_USER + 1000, 'lead-model', { input: M })
	]);
	writeSession('s-1', 'p-steer', [usageEvent(1, 1, 1, KID_1, 'kid-model', { input: M })]);

	/* 新增边界 ②：上一轮已 turn/end，之后、新 turn/start 之前有真人消息 ⇒ 用该消息时间。
	   队友在 turn/end 之前花 ¥3（不该算本轮）、在新消息之后花 ¥3（该算）⇒ 本轮只能是 ¥3。 */
	const RACE_END = T0 + 1000;
	const RACE_USER = T0 + 2000;
	writeSession('p-race', null, [
		turnStartEvent(T0, 1),
		turnEndEvent(RACE_END, 1),
		userMessageEvent(3, RACE_USER)
	]);
	writeSession('r-before', 'p-race', [usageEvent(1, 1, 1, T0 + 500, 'kid-model', { input: M })]);
	writeSession('r-after', 'p-race', [usageEvent(1, 2, 1, T0 + 3000, 'kid-model', { input: M })]);

	/* 老兜底：日志里完全没有 turn/start（早期/异常日志）⇒ 退回最后一条真实用户消息 */
	writeSession('p-nostart', null, [userMessageEvent(2, T0 + 10)]);
	writeSession('ns-1', 'p-nostart', [usageEvent(1, 1, 1, KID_1, 'kid-model', { input: M })]);

	/* 参数化注入类型：每种一个父会话（各自一个队友，本轮 ¥3）。 */
	const NOTICE_KINDS = [
		['subagent-settled', 'notice'],
		['team-message', ''],
		['tool-jobs', 'notice'],
		['skill-catalog', 'catalog'],
		['user-approval', ''],
		['agent-message', 'relay'],
		['compact-checkpoint', ''],
		['runtime-context', 'snapshot']
	];
	NOTICE_KINDS.forEach((pair, index) => {
		const parentId = 'p-kind-' + index;
		writeSession(parentId, null, [
			turnStartEvent(T0, 1),
			userMessageEvent(2, T0 + 10),
			noticeEvent(3, SETTLED, pair[0], pair[1])
		]);
		writeSession('k-kind-' + index, parentId, [usageEvent(1, 1, 1, KID_1, 'kid-model', { input: M })]);
	});

	/* ============================================================ host 路由 */
	const mod = await import('file:///' + INDEX.replace(/\\/g, '/'));
	let handler = null;
	mod.apply({
		logger: { info: () => {} },
		effect: (fn) => fn(),
		sessionProjections: { register: () => () => {} },
		webServer: { register: (route) => { if (route.path === '/dsh-desktop-statusbar/api') handler = route.handler; return () => {}; } },
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
	assert.strictEqual(posted.status, 200, '先报固定单价（¥3 / 1M input）');

	/* ============================================================ 一、host：注入通知不推进起点 */
	/* 1. 客户端给了正确起点 ⇒ 窗口就是客户端起点：两个队友各 ¥3 ⇒ ¥6，且不该有 sinceClamped */
	const clientGiven = await get('sessionId=p-stall&since=' + encodeURIComponent(String(CLIENT_SINCE)));
	assert.strictEqual(clientGiven.status, 200, '客户端起点查询 200');
	assert.strictEqual(clientGiven.body.ok, true, 'ok:true');
	assert.strictEqual(clientGiven.body.sinceSource, 'client', '客户端给起点 ⇒ client');
	assert.strictEqual(clientGiven.body.sinceClamped, undefined,
		'注入通知不许把客户端起点往前推（旧实现这里 sinceClamped=true）');
	assert.strictEqual(clientGiven.body.total.cost, 6, '两个队友本轮各 ¥3 ⇒ ¥6，实际 ' + clientGiven.body.total.cost);
	assert.strictEqual(clientGiven.body.total.calls, 2, '两次子会话调用，实际 ' + clientGiven.body.total.calls);
	console.log('一 1 客户端起点不被注入通知推后：¥' + clientGiven.body.total.cost + ' / ' + clientGiven.body.total.calls + ' 次，无 sinceClamped');

	/* 2. 不传 since（host 代推）⇒ 本轮 turn 还开着（没有 turn/end），起点只能是 turn/start（T0） */
	const inferred = await get('sessionId=p-stall');
	assert.strictEqual(inferred.body.sinceSource, 'host', '不传 since ⇒ host 代推');
	assert.strictEqual(inferred.body.total.cost, 6,
		'host 代推必须落在 turn/start 上 ⇒ ¥6（旧实现被推到通知时刻 ⇒ ¥0）');
	assert.strictEqual(inferred.body.total.calls, 2, '两次调用都要算进来');
	assert.deepStrictEqual(deep(inferred.body.total), deep(clientGiven.body.total),
		'host 代推与客户端给同一起点必须等价（只有来源不同）');
	console.log('一 2 host 代推不被注入通知污染：¥' + inferred.body.total.cost + '（旧实现 ¥0）');

	/* 3. 整会话口径（since=0）不受影响，也不参与收敛 */
	const whole = await get('sessionId=p-stall&since=0');
	assert.strictEqual(whole.body.sinceSource, 'client', '显式 since=0 ⇒ client');
	assert.strictEqual(whole.body.total.cost, 6, '整会话口径同样 ¥6（本例本轮=整会话）');
	assert.strictEqual(whole.body.sinceClamped, undefined, 'since=0 不参与收敛');
	console.log('一 3 since=0 整会话口径不变：¥' + whole.body.total.cost);

	/* 4. 真实用户新轮仍生效：用户消息晚于队友用量 ⇒ host 代推起点 = 该消息时刻，队友本轮 0 */
	const nextTurn = await get('sessionId=p-next');
	assert.strictEqual(nextTurn.body.sinceSource, 'host', '不传 since ⇒ host 代推');
	assert.strictEqual(nextTurn.body.total.cost, 0,
		'真实用户消息晚于队友用量 ⇒ 本轮从该消息开始，队友 ¥0（原规则不许修没）');
	assert.strictEqual(nextTurn.body.total.calls, 0, '本轮队友 0 次调用');
	console.log('一 4 真实用户新轮仍按原规则推进起点：本轮队友 ¥0（防"修过头"）');

	/* 6. 同轮中途真人插话（steering，轮没关）**不能**当新轮起点：
	   起点仍是 turn/start ⇒ 插话之前队友花的 ¥3 必须照算（旧实现会推后到插话时刻 ⇒ ¥0）。 */
	const steer = await get('sessionId=p-steer');
	assert.strictEqual(steer.body.sinceSource, 'host', 'steering：host 代推');
	assert.strictEqual(steer.body.total.cost, 3,
		'steering 不改轮次，起点必须仍是 turn/start ⇒ ¥3（被推后的话是 ¥0），实际 ' + steer.body.total.cost);
	assert.strictEqual(steer.body.total.calls, 1, 'steering：插话前那 1 次队友调用要算进来');
	const steerClient = await get('sessionId=p-steer&since=' + encodeURIComponent(String(CLIENT_SINCE)));
	assert.strictEqual(steerClient.body.sinceClamped, undefined, 'steering：不许把客户端起点推到插话时刻');
	assert.strictEqual(steerClient.body.total.cost, 3, 'steering：客户端起点查询同样 ¥3');
	console.log('一 6 同轮 steering 不推进起点：本轮队友 ¥' + steer.body.total.cost + '（旧实现 ¥0）');

	/* 7. 上一轮 turn/end 之后、新 turn/start 之前的真人消息 ⇒ **要用它**：
	   turn 已经关了，这条消息代表新轮已起（turn/start 还没落盘）。
	   turn/end 之前的队友 ¥3 不该算本轮，之后的 ¥3 要算 ⇒ 本轮只能是 ¥3（拿 turn/start 当起点会是 ¥6）。 */
	const race = await get('sessionId=p-race');
	assert.strictEqual(race.body.sinceSource, 'host', '竞态：host 代推');
	assert.strictEqual(race.body.total.cost, 3,
		'上一轮已结束 ⇒ 起点用 turn/end 之后的真人消息，本轮只算后一笔 ¥3，实际 ' + race.body.total.cost);
	assert.strictEqual(race.body.total.calls, 1, '竞态：只有 turn/end 之后那 1 次调用');
	const raceClient = await get('sessionId=p-race&since=' + encodeURIComponent(String(T0 + 100)));
	assert.strictEqual(raceClient.body.sinceSource, 'client', '竞态：客户端给了更早的起点');
	assert.strictEqual(raceClient.body.sinceClamped, true, '竞态：起点被 host 收紧到真人消息时刻');
	assert.strictEqual(raceClient.body.total.cost, 3, '竞态：客户端起点也被收敛到真人消息之后 ⇒ ¥3');
	console.log('一 7 上一轮结束后的真人消息成为新起点：本轮 ¥' + race.body.total.cost + '（只算 turn/end 之后那笔）');

	/* 8. 日志里完全没有 turn/start ⇒ 退回最后一条真实用户消息（老兜底，不能丢） */
	const noStart = await get('sessionId=p-nostart');
	assert.strictEqual(noStart.body.sinceSource, 'host', '没有 turn/start ⇒ host 用真人消息兜底');
	assert.strictEqual(noStart.body.total.cost, 3, '没有 turn/start ⇒ 起点 = 最后一条真人消息 ⇒ ¥3');
	console.log('一 8 没有 turn/start 时退回真人消息（老兜底）：¥' + noStart.body.total.cost);

	/* 5. 参数化：各类同轮注入通知都不推进起点 */
	for (let i = 0; i < NOTICE_KINDS.length; i += 1) {
		const one = await get('sessionId=p-kind-' + i);
		const label = NOTICE_KINDS[i][0] + (NOTICE_KINDS[i][1] ? '/' + NOTICE_KINDS[i][1] : '');
		assert.strictEqual(one.body.sinceSource, 'host', label + '：host 代推');
		assert.strictEqual(one.body.total.cost, 3, label + '：通知不许推进起点 ⇒ ¥3，实际 ' + one.body.total.cost);
		const clientOne = await get('sessionId=p-kind-' + i + '&since=' + encodeURIComponent(String(CLIENT_SINCE)));
		assert.strictEqual(clientOne.body.sinceClamped, undefined, label + '：不许收缩客户端起点');
		assert.strictEqual(clientOne.body.total.cost, 3, label + '：客户端起点查询同样 ¥3');
	}
	console.log('一 5 参数化注入类型（' + NOTICE_KINDS.map((one) => one[0]).join(' / ') + '）都不推进起点');

	/* ============================================================ 二、client：粘性下限是放大器，不是根因 */
	const api = loadClient({
		version: 6, priceVersion: 2, enabled: true, wrap: true, currency: 'CNY',
		models: { 'kid-model': PRICE }, modelOrder: ['kid-model']
	});
	const t = (key, params) => {
		const dict = {
			f_cost: '总计 {symbol}{cost}', f_lastCost: '本轮 {symbol}{cost}',
			f_tokensTotal: '总计用量', f_tokensTurn: '本轮用量',
			f_tokensHit: '输入(命中缓存)', f_tokensMiss: '输入(未命中缓存)', f_tokensOut: '输出'
		};
		let out = dict[key] !== undefined ? dict[key] : '<' + key + '>';
		if (params) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
		return out;
	};
	const callOf = (index) => ({ at: T0 + index * 1000, model: 'kid-model', input: M, cacheRead: 0, cacheWrite: 0, output: 0 });
	const payloadOf = (cost, calls) => ({
		ok: true, sessionId: 'p-stall', children: [],
		total: { cost: cost, calls: calls, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
	});
	const box = { sessionId: null, turnKey: null, value: 0 };
	/* 每一拍：主会话本轮调用数（¥3/次）+ 队友本轮金额（修复后不再骤降） */
	const view = (turnCalls, subCost, turnKey) => {
		const calls = [];
		for (let i = 0; i < turnCalls; i += 1) calls.push(callOf(i));
		return api.segmentView('lastCost', {
			sessionId: 'p-stall',
			sessionUsage: { models: {}, calls: calls, current: { calls: calls }, last: null, turn: turnKey },
			sessionModel: { provider: 'test', model: 'kid-model' },
			currency: 'CNY', now: T0, running: true, turnUsage: null,
			lastCostTurn: turnKey, lastCostHold: box,
			subagent: { session: payloadOf(6, 2), turn: payloadOf(subCost, 2) }
		}, t);
	};
	const money = (viewValue) => Number(viewValue.text.replace(/[^\d.]/g, ''));
	/* 2a 修复后的 host 返回值：队友本轮金额稳定 ¥6，显示值随主会话调用单调增长 */
	const fixedSeq = [1, 2, 3, 4, 5].map((n) => view(n, 6, 23));
	for (let i = 1; i < fixedSeq.length; i += 1) {
		assert.ok(money(fixedSeq[i]) > money(fixedSeq[i - 1]),
			'修复后显示值必须单调增长：' + fixedSeq[i - 1].text + ' → ' + fixedSeq[i].text);
	}
	assert.strictEqual(fixedSeq[4].text, '本轮 ¥21.00', '第 5 拍 = 主会话 ¥15 + 队友 ¥6，实际 ' + fixedSeq[4].text);
	console.log('二 2a 修复后显示值单调增长：' + fixedSeq.map((one) => one.text).join(' → '));

	/* 2b 旧形态：队友本轮金额突然从 ¥24 变成 0（窗口被推后）⇒ 粘性下限把显示冻结。
	   这条证明"冻结"只是放大器；根因在 host 起点（用例 1/2 才是根因断言）。 */
	const beforeJump = view(1, 24, 23);
	const afterJump = [2, 3, 4, 5].map((n) => view(n, 0, 23));
	assert.strictEqual(beforeJump.text, '本轮 ¥27.00', '跳变前：主会话 ¥3 + 队友 ¥24，实际 ' + beforeJump.text);
	afterJump.forEach((one) => {
		assert.strictEqual(one.text, '本轮 ¥27.00', '窗口推后那一拍显示值被粘性下限冻结（不回落）：' + one.text);
	});
	console.log('二 2b 旧形态：窗口推后 ⇒ 显示冻结在 ' + beforeJump.text + '（粘性下限按设计"只增不减"，根因在 host）');

	console.log('');
	console.log('BILLING STALL CHECKS PASSED');
})().catch((error) => {
	console.error('BILLING STALL CHECKS FAILED: ' + (error && error.message ? error.message : error));
	process.exitCode = 1;
});
