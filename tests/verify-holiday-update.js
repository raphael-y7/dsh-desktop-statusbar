/**
 * 客户端「节假日自动更新」逻辑测试：
 *   - 12/31 抓下一年；当年完全缺失时任何日期都补抓（12/30 到 2/10 没开机的漏抓场景）；
 *   - 失败冷却 24 小时；已有当年数据不重复抓；开发模式不发真实请求；
 *   - 抓到日期后写进配置，峰谷判定立刻用上新表；
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
		'\t\texports.__test = { isPeakTime, shouldAutoUpdateHolidays, autoUpdateHolidays, updateHolidays };\n' + marker);

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
	/* 1. 自动更新时机：12/31 抓下一年；当年完全缺失时任何日期都补抓（长期未打开的兜底） */
	const first = load(null, { ok: true, days: FRESH_2027 });
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2026, 12, 31, 0, 0), []), 2027, '12/31 目标下一年');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2026, 12, 31, 23, 59), []), 2027, '12/31 深夜仍目标下一年');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 1, 1, 0, 0), []), 2027, '1/1 补抓当年');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 1, 7, 23, 59), []), 2027, '1/7 仍补抓');
	/* 核心漏抓场景：12/30 到 2/10 一直没打开，2/10 打开时当年仍没有任何数据 */
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 10, 9, 0), []), 2027, '2/10 打开补抓当年');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 3, 15, 9, 0), ['2026-01-01']), 2027, '3/15 只有别的年份数据仍补抓当年');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2026, 11, 30, 10, 0), []), 2026, '11/30 当年缺失也补抓');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 12, 31, 12, 0), []), 2028, '跨年后 12/31 指向再下一年');
	/* 已有目标年份任意一天 → 不再抓（避免每个 tick 重复请求） */
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 1, 2, 12, 0), ['2027-01-01']), false, '1 月已有当年数据不重复抓');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 10, 12, 0), ['2027-01-01']), false, '2/10 已有当年数据不重复抓');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 1, 2, 12, 0), ['2026-01-01']), 2027, '只有别的年份数据仍要补抓');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2026, 12, 31, 12, 0), ['2027-01-01']), 2026, '12/31 已有下一年但当年缺失 → 补当年');
	/* 失败冷却：同一年失败后 24 小时内不再重试（按年份分开记） */
	const failedAt = beijing(2027, 2, 10, 9, 0);
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 10, 20, 0), [], { 2027: failedAt }), false, '失败当天 20:00 不重试');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 11, 8, 59), [], { 2027: failedAt }), false, '失败未满 24 小时不重试');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 11, 9, 1), [], { 2027: failedAt }), 2027, '失败满 24 小时后重试');
	assert.strictEqual(first.api.shouldAutoUpdateHolidays(beijing(2027, 2, 10, 20, 0), [], { 2026: failedAt }), 2027, '别的年份的失败不影响当年');
	console.log('= 自动更新时机：12/31 抓下一年、当年缺失任意日期补抓、已有数据不重复、失败按年份 24 小时冷却');

	/* 1b. 12/31 两个候选年都缺失：连续 5 个 tick 里每个目标年只请求一次（旧实现会互相覆盖、每 tick 重试） */
	const dec31 = load(null, { ok: false, reason: 'not-found' });
	const decState = { busy: false, failed: {} };
	const decAt = beijing(2027, 12, 31, 9, 0);
	const decFired = [];
	for (let i = 0; i < 5; i += 1) decFired.push(await dec31.api.autoUpdateHolidays(decAt + i * 1000, [], decState, false));
	assert.deepStrictEqual(decFired, [true, true, false, false, false], '12/31 两个年份各尝试一次，之后全部冷却');
	assert.strictEqual(dec31.calls.length, 2, '12/31 连续 5 tick 只发 2 次请求（两个缺失年份各一次）');
	assert.ok(dec31.calls[0].indexOf('year=2028') !== -1, '第一次抓下一年：' + dec31.calls[0]);
	assert.ok(dec31.calls[1].indexOf('year=2027') !== -1, '第二次补当年：' + dec31.calls[1]);
	assert.deepStrictEqual(Object.keys(decState.failed).sort(), ['2027', '2028'], '两个年份的失败记录互不覆盖');
	/* 只有下一年缺失（当年已有数据）时：连续 5 tick 只发 1 次请求 */
	const dec31b = load(null, { ok: false, reason: 'not-found' });
	const decStateB = { busy: false, failed: {} };
	const decFiredB = [];
	for (let i = 0; i < 5; i += 1) decFiredB.push(await dec31b.api.autoUpdateHolidays(decAt + i * 1000, ['2027-01-01'], decStateB, false));
	assert.deepStrictEqual(decFiredB, [true, false, false, false, false], '单个目标年失败后 5 tick 内不再重试');
	assert.strictEqual(dec31b.calls.length, 1, '12/31 连续 5 tick 只发 1 次请求');
	console.log('= 12/31 连续 5 tick：两个缺失年份共 2 次请求、单年份只 1 次（按年份冷却）');

	/* 1c. 长期未打开（12/30 → 2/10）：2/10 打开时必须真的触发 updateHolidays 并写入当年数据 */
	const missed = load({ version: 6, holidayDays: ['2026-01-01', '2026-10-01'] }, { ok: true, days: FRESH_2027 });
	const openAt = beijing(2027, 2, 10, 9, 0);
	assert.strictEqual(missed.api.shouldAutoUpdateHolidays(openAt, missed.stored().holidayDays), 2027, '2/10 打开返回当年');
	const fired = await missed.api.autoUpdateHolidays(openAt, missed.stored().holidayDays, { busy: false, failed: null }, false);
	assert.strictEqual(fired, true, '2/10 打开触发自动抓取');
	assert.strictEqual(missed.calls.length, 1, '只发一次请求');
	assert.ok(missed.calls[0].indexOf('year=2027') !== -1, '请求抓的是当年：' + missed.calls[0]);
	assert.deepStrictEqual(missed.stored().holidayDays, ['2026-01-01', '2026-10-01'].concat(FRESH_2027).sort(), '当年数据写入配置');
	assert.strictEqual(missed.api.shouldAutoUpdateHolidays(openAt, missed.stored().holidayDays), false, '已有当年数据不再抓');
	const firedAgain = await missed.api.autoUpdateHolidays(beijing(2027, 3, 15, 9, 0), missed.stored().holidayDays, { busy: false, failed: null }, false);
	assert.strictEqual(firedAgain, false, '已有当年数据不重复请求');
	assert.strictEqual(missed.calls.length, 1, '没有多发请求');
	console.log('= 12/30 到 2/10 未打开：2/10 打开抓当年并写入，之后整年不再抓');

	/* 1d. 失败冷却：第一次失败记录年份+时间，24 小时内每个 tick 都不再发请求 */
	const cooling = load(null, { ok: false, reason: 'not-found' });
	const coolState = { busy: false, failed: {} };
	const coolAt = beijing(2027, 2, 10, 9, 0);
	assert.strictEqual(await cooling.api.autoUpdateHolidays(coolAt, [], coolState, false), true, '首次失败尝试会发出请求');
	assert.strictEqual(cooling.calls.length, 1, '首次失败一次请求');
	assert.strictEqual(coolState.failed['2027'], coolAt, '冷却记录该年份的尝试时间');
	assert.strictEqual(coolState.busy, false, '失败后 busy 复位');
	const coolTicks = [1000, 3600 * 1000, 23 * 3600 * 1000 + 59 * 60 * 1000];
	for (let i = 0; i < coolTicks.length; i += 1) {
		assert.strictEqual(await cooling.api.autoUpdateHolidays(coolAt + coolTicks[i], [], coolState, false), false, '冷却期内不重试（+' + coolTicks[i] + 'ms）');
	}
	assert.strictEqual(cooling.calls.length, 1, '冷却期内没有新请求');
	assert.strictEqual(await cooling.api.autoUpdateHolidays(coolAt + 24 * 3600 * 1000 + 1000, [], coolState, false), true, '满 24 小时后重试');
	assert.strictEqual(cooling.calls.length, 2, '重试发出第二次请求');
	assert.strictEqual(cooling.stored(), undefined, '失败不写配置');
	console.log('= 失败冷却：记录年份+时间，24 小时内不重试，满 24 小时才重试');

	/* 1e. 开发模式：自动检查一律不发真实请求 */
	const dev = load(null, { ok: true, days: FRESH_2027 });
	const devState = { busy: false, failed: {} };
	assert.strictEqual(await dev.api.autoUpdateHolidays(beijing(2027, 2, 10, 9, 0), [], devState, true), false, '开发模式不触发');
	assert.strictEqual(dev.calls.length, 0, '开发模式 0 次请求');
	assert.strictEqual(dev.stored(), undefined, '开发模式不写配置');
	console.log('= 开发模式：自动检查不 fetch、不写配置');

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
	assert.strictEqual(first.api.isPeakTime(beijing(2027, 1, 1, 10, 0)), false, '2027 元旦整天空闲');
	assert.strictEqual(first.api.isPeakTime(beijing(2027, 1, 5, 10, 0)), true, '2027-01-05（周二）仍是高峰');
	assert.strictEqual(first.api.isPeakTime(beijing(2026, 1, 1, 10, 0)), false, '内嵌表照旧生效');
	assert.strictEqual(first.api.isPeakTime(beijing(2026, 9, 25, 10, 0)), false, '内嵌表照旧生效（中秋）');
	assert.strictEqual(first.calls.length, 1, '只请求一次 host 接口');
	assert.ok(first.calls[0].indexOf('year=2027') !== -1, '请求带上目标年份：' + first.calls[0]);
	console.log('= 更新后写入配置、2027 元旦改判空闲、工作日仍是高峰');

	/* 3b. 状态文案已随按钮一起删除：holidaySummary / holidayCount / nextHolidayYear 是死代码，不再保留 */

	/* 4. 还没发布：回 not-found，不写配置 */
	const missing = load(null, { ok: false, reason: 'not-found' });
	const failed = await missing.api.updateHolidays(2027);
	assert.strictEqual(failed.ok, false, '未发布时不算成功');
	assert.strictEqual(failed.reason, 'not-found', '未发布时的原因');
	assert.strictEqual(missing.stored(), undefined, '失败不写配置');
	console.log('= 官方还没发布时：不写配置');

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
