/**
 * 验证「设置页显示当前会话模型」这条链路：
 *   底栏（会话作用域槽）拿到会话投影 → POST 给 host；设置页 → GET 回来显示。
 * 用法：node verify-activemodel.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
let code = fs.readFileSync(PLUGIN, 'utf8');
const marker = '\t\texports.apply = apply;';
assert.ok(code.includes(marker), 'exports.apply marker not found');
code = code.replace(marker, '\t\texports.__test = { StatusBar, SettingsSection };\n' + marker);

/* ------------------------------------------------------------ hooks 替身 */
let activeHooks = null;
function makeHooks() { return { values: [], index: 0 }; }
function withHooks(bucket, fn) {
	const prev = activeHooks;
	activeHooks = bucket;
	bucket.index = 0;
	try { return fn(); } finally { activeHooks = prev; }
}
function hookSlot(init) {
	if (activeHooks === null) return { get: () => undefined, set: () => {} };
	const bucket = activeHooks;
	const at = bucket.index;
	bucket.index += 1;
	if (bucket.values.length <= at) bucket.values[at] = typeof init === 'function' ? init() : init;
	return {
		get: () => bucket.values[at],
		set: (value) => { bucket.values[at] = typeof value === 'function' ? value(bucket.values[at]) : value; }
	};
}

/* ------------------------------------------------------------ fetch 记录 */
const calls = [];
let activeModelResponse = { ok: true, provider: null, model: null };
const fakeFetch = (url, options) => {
	const opts = options === undefined ? {} : options;
	calls.push({
		url: String(url),
		method: typeof opts.method === 'string' ? opts.method : 'GET',
		body: typeof opts.body === 'string' ? opts.body : null
	});
	if (String(url).indexOf('active-model') >= 0) {
		return Promise.resolve({ json: () => Promise.resolve(activeModelResponse) });
	}
	return Promise.resolve({ json: () => Promise.resolve({ ok: false, reason: 'test' }) });
};

const store = new Map();
const fakeWindow = {
	localStorage: {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, v); },
		removeItem: (k) => { store.delete(k); }
	},
	fetch: fakeFetch,
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout: () => 0,
	clearTimeout: () => {},
	requestAnimationFrame: (fn) => { fn(); return 0; }
};

let captured = null;
const sandbox = {
	window: fakeWindow,
	document: {
		querySelector: () => null,
		querySelectorAll: () => [],
		createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
		head: { appendChild() {} },
		body: {}
	},
	console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
};
sandbox.globalThis = sandbox;
fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

const reactStub = {
	createElement(type, props, ...children) {
		return {
			type,
			props: props === null || props === undefined ? {} : props,
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
		};
	},
	useState: (init) => { const slot = hookSlot(init); return [slot.get(), slot.set]; },
	useEffect: (fn) => { hookSlot(undefined); if (typeof fn === 'function') fn(); },   /* 真的执行，fetch 才会发出去 */
	useRef: (init) => hookSlot({ current: init === undefined ? null : init }).get(),
	useSyncExternalStore: (subscribe, snapshot) => { hookSlot(undefined); return snapshot(); },
	useCallback: (fn) => { hookSlot(undefined); return fn; },
	useMemo: (fn) => { hookSlot(undefined); return fn(); },
	Fragment: Symbol('Fragment')
};

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
const api = captured.factory((name) => {
	if (name === 'react') return reactStub;
	throw new Error('unexpected require: ' + name);
}).__test;

const zh = { priceCurrent: '当前会话使用：', modelUnknown: '未识别' };
const t = (key, params) => {
	let out = zh[key] === undefined ? key : zh[key];
	if (params !== undefined) out = out.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
	return out;
};
function textOf(node) {
	if (node === null || node === undefined || node === false) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return textOf(node.children);
}
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
	/* 1. 底栏：有会话模型时上报 */
	const barProps = {
		t,
		useProjection: (key) => (key === 'desktopStatusbarModel' ? { provider: 'deepseek-official', model: 'deepseek-v4-pro' } : undefined),
		useSession: () => undefined,
		useSessions: () => undefined,
		useChat: () => undefined,
		sessionId: 'verify-session'
	};
	withHooks(makeHooks(), () => api.StatusBar(barProps));
	const posted = calls.filter((c) => c.method === 'POST' && c.url === '/dsh-desktop-statusbar/api/active-model');
	assert.strictEqual(posted.length, 1, '底栏应上报一次当前模型，实际 ' + posted.length);
	assert.deepStrictEqual(JSON.parse(posted[0].body), { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, '上报内容应是当前会话模型');
	console.log('底栏上报：', posted[0].body);

	/* 2. 底栏：没有会话模型时不上报 */
	calls.length = 0;
	withHooks(makeHooks(), () => api.StatusBar(Object.assign({}, barProps, { useProjection: () => undefined })));
	assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0, '拿不到模型时不该上报');

	/* 3. 设置页：读回上报值并显示（顺带验证模型名格式化） */
	activeModelResponse = { ok: true, provider: 'deepseek-official', model: 'deepseek-v4-pro' };
	const settingsProps = { t, useProjection: () => undefined, sessionId: 'verify-session' };
	const settingsHooks = makeHooks();
	withHooks(settingsHooks, () => api.SettingsSection(settingsProps));   /* 首次渲染触发 GET */
	await drain();
	const text = textOf(withHooks(settingsHooks, () => api.SettingsSection(settingsProps)));
	assert.ok(text.includes('当前会话使用：'), '设置页应有当前会话使用那一行');
	assert.ok(text.includes('DeepSeek-V4-Pro'), '设置页应显示上报的模型，实际：' + text.slice(0, 120));
	assert.ok(!text.includes('未识别'), '有上报值时不该显示未识别');
	console.log('设置页显示：', text.slice(text.indexOf('当前会话使用：'), text.indexOf('当前会话使用：') + 24));

	/* 4. 没上报过时仍回退未识别 */
	activeModelResponse = { ok: true, provider: null, model: null };
	const freshHooks = makeHooks();
	withHooks(freshHooks, () => api.SettingsSection(settingsProps));
	await drain();
	const text2 = textOf(withHooks(freshHooks, () => api.SettingsSection(settingsProps)));
	assert.ok(text2.includes('未识别'), '拿不到模型时应回退未识别');
	console.log('无上报时回退：未识别');

	console.log('\nACTIVE MODEL CHECKS PASSED');
})().catch((error) => {
	console.error('ACTIVE MODEL CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
