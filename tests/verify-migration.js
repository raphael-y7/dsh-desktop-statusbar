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
	assert.ok(store.get(NEW_KEY) !== undefined, '迁移应把内容写进新键');
	assert.strictEqual(store.get(NEW_KEY), LEGACY_CONFIG, '新键内容应与旧键一致');
	assert.strictEqual(store.get(OLD_KEY), LEGACY_CONFIG, '旧键应保留（可回退旧版本）');
	console.log('旧键迁移：读到并搬到新键，旧键保留');
}

/* 2. 两个键都有：以新键为准 */
{
	const newer = JSON.stringify({ version: 6, wrap: true, hidden: [], models: {}, modelOrder: [] });
	const { api, store } = loadWith({ [OLD_KEY]: LEGACY_CONFIG, [NEW_KEY]: newer });
	assert.strictEqual(api.snapshot().models['my-model'], undefined, '不应混入旧键内容');
	assert.strictEqual(api.snapshot().contextMeter, true, '历史配置里没有 contextMeter 时默认开启');
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

/* 4. 旧配置里还留着已下线的 tokens 段：读进来要丢掉，顺序与勾选不受影响 */
{
	const withTokens = JSON.stringify({
		version: 6, enabled: true, wrap: true, currency: 'CNY', models: {}, modelOrder: [],
		segments: ['status', 'tokens', 'counts', 'cost'],
		hidden: ['tokens', 'counts']
	});
	const { api } = loadWith({ [NEW_KEY]: withTokens });
	const segments = Array.prototype.slice.call(api.snapshot().segments);
	const hidden = Array.prototype.slice.call(api.snapshot().hidden);
	assert.strictEqual(segments.indexOf('tokens'), -1, 'tokens 段已下线，读进来要丢掉');
	assert.deepStrictEqual(segments.slice(0, 3), ['status', 'counts', 'cost'], '其余段的顺序不变');
	assert.strictEqual(segments.length, 9, '缺的段补到末尾（共 9 段），实际 ' + segments.length);
	assert.strictEqual(hidden.indexOf('tokens'), -1, '勾选状态里也不该留下 tokens');
	assert.deepStrictEqual(hidden, ['counts'], '其余勾选状态原样保留');
	console.log('下线字段：旧配置里的 tokens 被丢掉，顺序与勾选不受影响');
}

/* 4. 空闲价被写坏（旧版取消勾选「峰谷计价」时把空闲价复制成高峰价）→ 按参考价补回 */
{
	const flat = (input, cacheRead, output) => ({ input: input, cacheRead: cacheRead, cacheWrite: 0, output: output });
	const broken = JSON.stringify({
		version: 6, priceVersion: 2, hidden: [], modelOrder: ['deepseek-v4-pro'],
		models: { 'deepseek-v4-pro': { tiered: true, peak: flat(9, 0.3, 27), offPeak: flat(9, 0.3, 27) } }
	});
	const { api } = loadWith({ [NEW_KEY]: broken });
	const one = api.snapshot().models['deepseek-v4-pro'];
	assert.strictEqual(one.offPeak.input, 4.5, '空闲输入价按参考价补回，实际 ' + one.offPeak.input);
	assert.strictEqual(one.offPeak.cacheRead, 0.15, '空闲缓存价补回，实际 ' + one.offPeak.cacheRead);
	assert.strictEqual(one.offPeak.output, 13.5, '空闲输出价补回，实际 ' + one.offPeak.output);
	assert.strictEqual(one.peak.input, 9, '高峰价不动');
	/* 全天同价的模型不修：两档本来就该一样 */
	const flatOne = JSON.stringify({
		version: 6, priceVersion: 2, hidden: [], modelOrder: ['my-model'],
		models: { 'my-model': { tiered: false, peak: flat(3, 0.3, 6), offPeak: flat(3, 0.3, 6) } }
	});
	const other = loadWith({ [NEW_KEY]: flatOne }).api.snapshot().models['my-model'];
	assert.strictEqual(other.peak.input, 3, '用户自建的模型不受影响');
	console.log('价格自愈：被写坏的空闲价按参考价补回，自建模型不动');
}

/* 5. 计价单位：USD 保留，非法值回落到 CNY */
{
	const usd = JSON.stringify({ version: 6, currency: 'USD', hidden: [], models: {}, modelOrder: [] });
	assert.strictEqual(loadWith({ [NEW_KEY]: usd }).api.snapshot().currency, 'USD', '配置里的 USD 要保留');
	const junk = JSON.stringify({ version: 6, currency: 'JPY', hidden: [], models: {}, modelOrder: [] });
	assert.strictEqual(loadWith({ [NEW_KEY]: junk }).api.snapshot().currency, 'CNY', '非法币种回落到 CNY');
	const none = JSON.stringify({ version: 6, hidden: [], models: {}, modelOrder: [] });
	assert.strictEqual(loadWith({ [NEW_KEY]: none }).api.snapshot().currency, 'CNY', '没配过就是 CNY');
	console.log('计价单位：USD 保留、非法值回落 CNY、缺省 CNY');
}

/* 5b. 条目币种（task-22）：迁移用全局 currency 给**已有条目**落成显式值；条目自带值优先 */
{
	const legacyCur = JSON.stringify({ version: 6, currency: 'USD', hidden: [], modelOrder: ['my-model'],
		models: { 'my-model': { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null } } });
	const migratedCur = loadWith({ [NEW_KEY]: legacyCur }).api.snapshot();
	assert.strictEqual(migratedCur.currency, 'USD', '全局字段保留（现在只是"新增条目的默认币种"）');
	assert.strictEqual(migratedCur.models['my-model'].currency, 'USD', '已有条目按全局币种落成显式 currency');
	const mixedCur = JSON.stringify({ version: 6, currency: 'CNY', hidden: [], modelOrder: ['a', 'b'],
		models: {
			a: { currency: 'USD', peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null },
			b: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: null }
		} });
	const mixedSnap = loadWith({ [NEW_KEY]: mixedCur }).api.snapshot();
	assert.strictEqual(mixedSnap.models.a.currency, 'USD', '条目自带币种优先于默认值');
	assert.strictEqual(mixedSnap.models.b.currency, 'CNY', '没带的条目落成默认币种');
	assert.strictEqual(mixedSnap.currency, 'CNY', '默认币种字段不被条目值改写');
	console.log('条目币种：迁移落成显式值（全局 currency 当初值）· 条目自带优先 · 默认字段不被改写');
}

console.log('\nMIGRATION CHECKS PASSED');
