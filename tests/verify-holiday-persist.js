/**
 * host 持久化法定节假日：抓到的假期落盘后，host 的峰谷判定与客户端共用同一份日历。
 *
 * 背景（独立审查实测缺陷）：内置表只覆盖 2026，而客户端能把新一年的假期存进配置
 * （设置页「更新节假峰谷」）。host 以前只认内置表 ⇒ 2027 年起同一天底栏按空闲价、
 * 活跃总览按高峰价，**同一天差一倍**，用户点按钮也修不了 host。
 * 现方案：抓取成功时 `<DSH_HOME>/dsh-status-bar/holidays.json` 落盘，
 * `isLegalHoliday` = 内置 2026 表 ∪ 落盘表，`isPeakTime` 走它。
 *
 * 断言：
 *   1. 落盘表真的影响 host 判峰谷（2027-01-01：有表 = 空闲，表里没有 = 高峰）；
 *   1b. 同一天两侧（client / host）必须同档 —— 这条才锁住"差一倍"那个缺陷；
 *   2. `saveHolidayDays` 的合并语义：两批并起来、去重、排序，文件与返回值一致，重载仍生效；
 *   3. 内置 2026 表不依赖落盘文件。
 *
 * 全程只用隔离 DSH_HOME（tests/.dsh-test-home-holiday），不碰真实 ~/.dsh/dsh-status-bar/。
 * 用法：node tests/verify-holiday-persist.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const hostLib = require('./_host-lib.js');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');
const TMP = path.join(__dirname, '.dsh-test-home-holiday-lib');
const HOME = path.join(__dirname, '.dsh-test-home-holiday');
const HOST_EXPORTS = ['dshHome', 'holidaysPath', 'extraHolidayDays', 'saveHolidayDays', 'isLegalHoliday', 'isPeakTime'];

globalThis.setInterval = () => 0;
process.env.DSH_HOME = HOME;   /* holidaysPath/dshHome 每次调用都读它，必须在调用前设好 */

/** 北京时间的某天某点 → epoch ms（hour 用 24 小时制，转成 UTC 要减 8）。 */
const bj = (year, month, day, hour) => Date.UTC(year, month, day, hour - 8, 0, 0);
const JAN_2027 = bj(2027, 0, 1, 10);      /* 周五 10:00：在落盘表里 → 空闲；不在表里 → 高峰 */
const MAR_2027 = bj(2027, 2, 1, 10);      /* 周一 10:00：谁的表里都没有 → 高峰 */
const OCT_2026 = bj(2026, 9, 1, 10);      /* 2026 国庆（内置表）→ 空闲 */

/** 载入 client，可预置一份配置（用 holidayDays 模拟"客户端已存下下一年的假期"）。 */
function loadClient(stored) {
	let code = fs.readFileSync(CLIENT, 'utf8');
	const marker = '\t\texports.apply = apply;';
	assert.ok(code.includes(marker), 'client.js 的 exports.apply 标记找不到');
	code = code.replace(marker, '\t\texports.__test = { isPeakTime, isHolidayDate };\n' + marker);

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

(async () => {
	const source = hostLib.prepare(TMP, HOST_EXPORTS);
	try {
		const holidaysFile = path.join(HOME, 'dsh-status-bar', 'holidays.json');

		/* ============================================================ 1. 落盘表影响 host 判峰谷 */
		fs.rmSync(HOME, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(holidaysFile), { recursive: true });
		fs.writeFileSync(holidaysFile, JSON.stringify({ days: ['2027-01-01'] }), 'utf8');
		const withFile = await hostLib.loadHost(source, 'with-file');
		assert.strictEqual(withFile.holidaysPath(), holidaysFile,
			'holidays.json 落在隔离目录里（不碰真实 ~/.dsh）：实际 ' + withFile.holidaysPath());
		assert.strictEqual(new Date(JAN_2027 + 8 * 3600 * 1000).getUTCDay(), 5, '前置：2027-01-01 是周五');
		assert.strictEqual(withFile.isLegalHoliday('2027-01-01'), true, '落盘表里的日期算法定节假日');
		assert.strictEqual(withFile.isPeakTime(JAN_2027), false, '落盘表生效 ⇒ 2027-01-01 10:00 按空闲时段');
		assert.strictEqual(withFile.isPeakTime(MAR_2027), true, '落盘表不影响别的日子：2027-03-01 10:00 仍是高峰');

		/* 同一实例里新存的假期要立刻生效（缓存同步更新） */
		assert.deepStrictEqual(withFile.saveHolidayDays(['2027-05-03']), ['2027-01-01', '2027-05-03'],
			'新存的假期并进已有表（去重排序）');
		assert.strictEqual(withFile.isPeakTime(bj(2027, 4, 3, 10)), false, '新存的假期立刻影响判峰谷');

		/* 换掉盘上的文件（不含 2027-01-01）→ 新模块实例重新读盘 ⇒ 同一天同一时刻回到高峰 */
		fs.writeFileSync(holidaysFile, JSON.stringify({ days: ['2027-05-01'] }), 'utf8');
		const withoutDay = await hostLib.loadHost(source, 'without-day');
		assert.deepStrictEqual(withoutDay.extraHolidayDays(), ['2027-05-01'], '新实例读到的是新文件内容');
		assert.strictEqual(withoutDay.isLegalHoliday('2027-01-01'), false, '表里没有的日期不是假期');
		assert.strictEqual(withoutDay.isPeakTime(JAN_2027), true,
			'没有落盘假期 ⇒ 2027-01-01 10:00 是高峰（这就是"两侧差一倍"那一条）');
		console.log('1 落盘表影响 host 判峰谷：2027-01-01 有表=空闲 · 表里没有=高峰');

		/* ============================================================ 1b. 同一天两侧必须同档 */
		const clientWith = loadClient({ version: 6, priceVersion: 2, holidayDays: ['2027-01-01'] });
		const clientWithout = loadClient({ version: 6, priceVersion: 2, holidayDays: [] });
		const SAMPLES = [
			JAN_2027,                          /* 表里有的假期 */
			bj(2027, 0, 1, 15),                /* 同一天另一个高峰窗 */
			bj(2027, 0, 1, 12),                /* 同一天午休（两边都该空闲） */
			MAR_2027,                          /* 表里没有的工作日 */
			bj(2027, 4, 1, 10),                /* 周六 */
			bj(2027, 9, 1, 10),                /* 2027 国庆：表里没有 ⇒ 高峰 */
			OCT_2026                           /* 内置 2026 假期 */
		];
		const pairs = [
			{ name: '盘上有 2027-01-01', host: withFile, client: clientWith },
			{ name: '盘上没有 2027-01-01', host: withoutDay, client: clientWithout }
		];
		pairs.forEach((pair) => {
			SAMPLES.forEach((at) => {
				const key = new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
				assert.strictEqual(pair.client.isPeakTime(at), pair.host.isPeakTime(at),
					'同一天两侧必须同档（' + pair.name + ' / 北京 ' + key + '）：client='
					+ pair.client.isPeakTime(at) + ' host=' + pair.host.isPeakTime(at));
			});
		});
		/* 也把关键值钉死，免得"两边一起错"被判成通过 */
		assert.strictEqual(clientWith.isPeakTime(JAN_2027), false, 'client（配置里有该假期）判 2027-01-01 10:00 为空闲');
		assert.strictEqual(clientWithout.isPeakTime(JAN_2027), true, 'client（配置里没有该假期）判它是高峰');
		assert.strictEqual(clientWithout.isPeakTime(MAR_2027), true, '两侧都判 2027-03-01 10:00 为高峰');
		assert.strictEqual(clientWithout.isPeakTime(OCT_2026), false, '两侧都判 2026-10-01 10:00 为空闲（内置表）');
		console.log('1b 两侧对齐：' + pairs.length + ' 组 × ' + SAMPLES.length + ' 个时刻逐例同档');

		/* ============================================================ 2. saveHolidayDays 合并语义 */
		fs.rmSync(holidaysFile, { force: true });          /* 从"盘上什么都没有"开始 */
		const saver = await hostLib.loadHost(source, 'saver');
		assert.deepStrictEqual(saver.extraHolidayDays(), [], '文件不存在时当作没有假期');
		const first = saver.saveHolidayDays(['2027-01-02', '2027-01-01', '2027-01-01', 42, null]);
		assert.deepStrictEqual(first, ['2027-01-01', '2027-01-02'], '第一批：去重 + 排序 + 丢掉非字符串');
		assert.strictEqual(new Date(bj(2028, 0, 3, 10) + 8 * 3600 * 1000).getUTCDay(), 1, '前置：2028-01-03 是周一');
		const second = saver.saveHolidayDays(['2028-01-03', '2027-01-01']);
		assert.deepStrictEqual(second, ['2027-01-01', '2027-01-02', '2028-01-03'], '第二批并上第一批');
		const onDisk = JSON.parse(fs.readFileSync(holidaysFile, 'utf8'));
		assert.deepStrictEqual(onDisk.days, second, '文件内容与返回值一致');
		assert.strictEqual(typeof onDisk.updatedAt, 'number', '写盘时带 updatedAt');
		const reloaded = await hostLib.loadHost(source, 'reloaded');
		assert.deepStrictEqual(reloaded.extraHolidayDays().slice(), second, '重新加载后两批都在');
		assert.strictEqual(reloaded.isLegalHoliday('2028-01-03'), true, '重载后新一年的假期也生效');
		assert.strictEqual(reloaded.isPeakTime(bj(2028, 0, 3, 10)), false, '2028-01-03（周一 10:00）按空闲');
		console.log('2 saveHolidayDays 合并：两批并起来去重排序、文件与返回值一致、重载仍生效');

		/* ============================================================ 3. 内置 2026 表照旧生效 */
		assert.strictEqual(withoutDay.isLegalHoliday('2026-10-01'), true, '内置 2026 国庆不依赖落盘文件');
		assert.strictEqual(withoutDay.isLegalHoliday('2026-10-07'), true, '内置 2026 国庆最后一天');
		assert.strictEqual(withoutDay.isLegalHoliday('2026-12-31'), false, '不是假期的日子照旧 false');
		assert.strictEqual(withoutDay.isPeakTime(OCT_2026), false, '2026-10-01 10:00 按空闲（内置表）');
		assert.strictEqual(clientWithout.isHolidayDate('2026-10-01'), true, 'client 侧内置表同样认 2026-10-01');
		console.log('3 内置 2026 表：不依赖落盘文件，两侧都认');

		console.log('');
		console.log('HOLIDAY PERSIST CHECKS PASSED');
	} finally {
		hostLib.cleanup(TMP);
	}
})().catch((error) => {
	console.error('HOLIDAY PERSIST CHECKS FAILED: ' + (error && error.message ? error.message : error));
	process.exitCode = 1;
});
