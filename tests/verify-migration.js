/**
 * 存储键迁移验证：改名前配置存在旧键 dsh.miniStatusBar.v1 里，
 * 新版本要能读到它、搬到新键，并且旧键保留（方便回退旧版本）。
 * 用法：node verify-migration.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const OLD_KEY = 'dsh.miniStatusBar.v1';
const NEW_KEY = 'dsh.desktopStatusBar.v1';

/** 用给定的 localStorage 内容加载一次插件，返回它的内部快照 */
function loadWith(entries) {
	let code = fs.readFileSync(PLUGIN, 'utf8');
	const marker = '\t\texports.apply = apply;';
	code = code.replace(marker, '\t\texports.__test = { STORAGE_KEY, LEGACY_STORAGE_KEY, snapshot };\n' + marker);

	const store = new Map(Object.keys(entries).map((key) => [key, entries[key]]));
	const fakeWindow = {
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => { store.set(k, v); },
			removeItem: (k) => { store.delete(k); }
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
	};
	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

	const sandbox = {
		window: fakeWindow,
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
			head: { appendChild() {} }
		},
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });

	const reactStub = {
		createElement: () => ({}),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {},
		useRef: () => ({ current: null }),
		useSyncExternalStore: (subscribe, snapshot) => snapshot(),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		Fragment: Symbol('Fragment')
	};
	const api = captured.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
	return { api, store };
}

const LEGACY_CONFIG = JSON.stringify({
	version: 6, enabled: true, wrap: false, hidden: ['balance'], currency: 'CNY',
	models: { 'my-model': { tiered: false, peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
	modelOrder: ['my-model']
});

/* 1. 只有旧键：内容要读得到，并搬到新键 */
{
	const { api, store } = loadWith({ [OLD_KEY]: LEGACY_CONFIG });
	assert.strictEqual(api.STORAGE_KEY, NEW_KEY, '插件应使用新键');
	assert.strictEqual(api.LEGACY_STORAGE_KEY, OLD_KEY, '应保留旧键常量用于迁移');
	const models = api.snapshot().models;
	assert.ok(models['my-model'] !== undefined, '旧键里的价格库应被读到');
	assert.strictEqual(api.snapshot().wrap, false, '旧键里的开关应被读到');
	assert.ok(store.get(NEW_KEY) !== undefined, '迁移应把内容写进新键');
	assert.strictEqual(store.get(NEW_KEY), LEGACY_CONFIG, '新键内容应与旧键一致');
	assert.strictEqual(store.get(OLD_KEY), LEGACY_CONFIG, '旧键应保留（可回退旧版本）');
	console.log('旧键迁移：读到并搬到新键，旧键保留');
}

/* 2. 两个键都有：以新键为准 */
{
	const newer = JSON.stringify({ version: 6, wrap: true, hidden: [], models: {}, modelOrder: [] });
	const { api, store } = loadWith({ [OLD_KEY]: LEGACY_CONFIG, [NEW_KEY]: newer });
	assert.strictEqual(api.snapshot().wrap, true, '两键都有时应用新键');
	assert.strictEqual(api.snapshot().models['my-model'], undefined, '不应混入旧键内容');
	assert.strictEqual(store.get(OLD_KEY), LEGACY_CONFIG, '旧键不应被改写');
	console.log('新键优先：两键并存时用新键');
}

/* 3. 两个键都没有：走默认值，不报错 */
{
	const { api } = loadWith({});
	assert.ok(Array.isArray(api.snapshot().segments) && api.snapshot().segments.length > 0, '应有出厂默认段序');
	assert.strictEqual(api.snapshot().models['deepseek-flash'] !== undefined, true, '应有内嵌默认价格');
	console.log('全新安装：走默认值');
}

console.log('\nMIGRATION CHECKS PASSED');
