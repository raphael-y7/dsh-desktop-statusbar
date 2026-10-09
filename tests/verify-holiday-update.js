/**
 * 客户端「更新节假峰谷」逻辑测试：
 *   - 按钮常驻，目标年份永远是下一年；
 *   - 点按钮抓到日期后写进配置，峰谷判定立刻用上新表，按钮不变；
 *   - 抓取失败（未发布 / 网络错 / 后台还是旧版）时不写配置，只回一个失败结果。
 * 用法：node verify-holiday-update.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const STORAGE_KEY = 'dsh.desktopStatusBar.v1';

/** 载入一份 client.js 实例：能给预置配置、能给假的 fetch 结果 */
function load(config, fetchResult) {
	let code = fs.readFileSync(PLUGIN, 'utf8');
	const marker = '\t\texports.apply = apply;';
	code = code.replace(marker,
		'\t\texports.__test = { isPeakTime, nextHolidayYear, updateHolidays, holidaySummary };\n' + marker);

	const store = new Map();
	if (config !== null) store.set(STORAGE_KEY, JSON.stringify(config));
	const calls = [];
	const fakeWindow = {
		localStorage: {
			getItem: (key) => (store.has(key) ? store.get(key) : null),
			setItem: (key, value) => { store.set(key, value); },
			removeItem: (key) => { store.delete(key); }
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
		fetch: (url) => {
			calls.push(url);
			if (fetchResult === null) return Promise.reject(new Error('offline'));
			/* __http 用来模拟非 200 的响应（例如旧版 host 没有 /api/holidays 时的 404） */
			if (fetchResult.__http !== undefined) {
				return Promise.resolve({ ok: false, status: fetchResult.__http, json: () => Promise.resolve({}) });
			}
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fetchResult) });
		}
	};

	let captured = null;
	fakeWindow.__ModuleLoader__ = { load: (e) => { captured = e; } };
	const sandbox = {
		window: fakeWindow,
		document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, appendChild() {} }), head: { appendChild() {} } },
		console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
	};
	sandbox.globalThis = sandbox;
	const reactStub = {
		createElement: () => ({}),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {}, useRef: () => ({ current: null }),
		useSyncExternalStore: (subscribe, snapshot) => snapshot(),
		useCallback: (fn) => fn, useMemo: (fn) => fn(),
		Fragment: Symbol('Fragment')
	};
	vm.createContext(sandbox);
	vm.runInContext(code, sandbox, { filename: 'client.js' });
	const api = captured.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error('unexpected require: ' + name);
	}).__test;
	return {
		api,
		store,
		calls,
		stored: () => (store.has(STORAGE_KEY) ? JSON.parse(store.get(STORAGE_KEY)) : undefined),
	};
}

/* 北京时间 → UTC 毫秒 */
const beijing = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
const FRESH_2027 = ['2027-01-01', '2027-01-04', '2027-02-05', '2027-02-08', '2027-04-05',
	'2027-05-03', '2027-05-04', '2027-05-05', '2027-06-09', '2027-09-15', '2027-10-01', '2027-10-04'];

(async () => {
	/* 1. 按钮常驻：目标年份永远是下一年，跟日期窗口无关 */
	const first = load(null, { ok: true, days: FRESH_2027 });
	assert.strictEqual(first.api.nextHolidayYear(beijing(2026, 9, 19, 10, 0)), 2027, '2026 年里的目标是 2027');
	assert.strictEqual(first.api.nextHolidayYear(beijing(2026, 12, 24, 23, 59)), 2027, '圣诞前也是 2027');
	assert.strictEqual(first.api.nextHolidayYear(beijing(2026, 12, 25, 0, 0)), 2027, '圣诞当天仍是 2027');
	assert.strictEqual(first.api.nextHolidayYear(beijing(2027, 1, 1, 8, 0)), 2028, '跨年后指向再下一年');
	console.log('= 目标年份永远是下一年（按钮常驻，不看圣诞窗口）');

	/* 1b. 状态文案的年份：还没有下一年的表时用当年（内嵌 2026 有 19 天） */
	const before = first.api.holidaySummary(beijing(2026, 9, 19, 10, 0));
	assert.strictEqual(before.year, 2026, '没有下一年数据时年份用当年');
	assert.strictEqual(before.count, 19, '2026 年内嵌 19 个节假日');
	console.log('= 状态文案：没有 2027 数据 → 显示 2026 年 19 个节假日');

	/* 2. 没更新时 2027-01-01（周五）会按高峰算 —— 这正是要更新的原因 */
	assert.strictEqual(first.api.isPeakTime(beijing(2027, 1, 1, 10, 0)), true, '未更新时 2027 元旦按高峰');
	console.log('= 未更新时 2027-01-01 10:00 判为高峰（费用会偏高）');

	/* 3. 抓到之后：写进配置、判定改用新表，按钮不受影响（常驻） */
	const ok = await first.api.updateHolidays(2027);
	/* vm 里造出来的对象和测试进程不是同一个 realm，逐字段断言，别用 deepStrictEqual */
	assert.strictEqual(ok.ok, true, '抓取成功 :: ' + JSON.stringify(ok));
	assert.strictEqual(ok.year, 2027, '结果年份');
	assert.strictEqual(ok.count, FRESH_2027.length, '结果天数');
	assert.deepStrictEqual(first.stored().holidayDays, FRESH_2027.slice().sort(), '写入 config.holidayDays');
	assert.strictEqual(first.api.nextHolidayYear(beijing(2026, 12, 25, 0, 0)), 2027, '写完按钮还在（常驻）');
	assert.strictEqual(first.api.isPeakTime(beijing(2027, 1, 1, 10, 0)), false, '2027 元旦整天空闲');
	assert.strictEqual(first.api.isPeakTime(beijing(2027, 1, 5, 10, 0)), true, '2027-01-05（周二）仍是高峰');
	assert.strictEqual(first.api.isPeakTime(beijing(2026, 1, 1, 10, 0)), false, '内嵌表照旧生效');
	assert.strictEqual(first.api.isPeakTime(beijing(2026, 9, 25, 10, 0)), false, '内嵌表照旧生效（中秋）');
	assert.strictEqual(first.calls.length, 1, '只请求一次 host 接口');
	assert.ok(first.calls[0].indexOf('year=2027') !== -1, '请求带上目标年份：' + first.calls[0]);
	console.log('= 更新后写入配置、2027 元旦改判空闲、工作日仍是高峰、按钮仍在');

	/* 3b. 按钮右边那行状态文案的数据：有下一年的表就用下一年，否则用当年 */
	const after = first.api.holidaySummary(beijing(2026, 9, 19, 10, 0));
	assert.strictEqual(after.year, 2027, '录入 2027 后年份用下一年');
	assert.strictEqual(after.count, FRESH_2027.length, '数量来自抓取结果');
	console.log('= 状态文案：已录入 2027 → 显示 2027 年 ' + after.count + ' 个节假日');

	/* 4. 还没发布：回 not-found，不写配置 */
	const missing = load(null, { ok: false, reason: 'not-found' });
	const failed = await missing.api.updateHolidays(2027);
	assert.strictEqual(failed.ok, false, '未发布时不算成功');
	assert.strictEqual(failed.reason, 'not-found', '未发布时的原因');
	assert.strictEqual(missing.stored(), undefined, '失败不写配置');
	assert.strictEqual(missing.api.nextHolidayYear(beijing(2026, 12, 25, 0, 0)), 2027, '失败后按钮仍在，可以重试');
	console.log('= 官方还没发布时：不写配置、按钮保留');

	/* 5. 网络断了：同样不写配置 */
	const offline = load(null, null);
	const dead = await offline.api.updateHolidays(2027);
	assert.strictEqual(dead.ok, false, '离线不算成功');
	assert.strictEqual(dead.reason, 'fetch-failed', '离线原因');
	assert.strictEqual(offline.stored(), undefined, '离线不写配置');
	console.log('= 网络失败时不写配置');

	/* 6. 后台还是旧版（没有 /api/holidays 这个路由，返回 404）：要跟"官方还没发布"分开报 */
	const stale = load(null, { __http: 404 });
	const staleResult = await stale.api.updateHolidays(2025);
	assert.strictEqual(staleResult.ok, false, '404 不算成功');
	assert.strictEqual(staleResult.reason, 'no-route', '404 归为 no-route');
	assert.strictEqual(stale.stored(), undefined, '404 不写配置');
	console.log('= 后台还挂着旧版时：报 no-route（提示重启 DSH），不写配置');

	/* 6. 重复点击：同一年的日期不会重复累加 */
	const again = load({ version: 6, holidayDays: FRESH_2027.slice() }, { ok: true, days: FRESH_2027 });
	const second = await again.api.updateHolidays(2027);
	assert.strictEqual(second.ok, true, '二次抓取仍成功');
	assert.deepStrictEqual(again.stored().holidayDays, FRESH_2027.slice().sort(), '重复日期不叠加');
	console.log('= 重复更新不会把同一天写两遍');

	console.log('');
	console.log('HOLIDAY UPDATE CHECKS PASSED');
})().catch((error) => {
	console.error('HOLIDAY UPDATE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
