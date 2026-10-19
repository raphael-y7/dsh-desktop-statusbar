/**
 * 放假通知解析测试：拿 gov.cn 上 2023-2026 四年的通知原文当样本，
 * 断言解析出的"落在周一至周五的放假日"与手工核对的日期一致，
 * 并把 2026 的结果与客户端内嵌的节假日表交叉比对（两个独立来源）。
 * 用法：node verify-holidays.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const LIB = path.join(__dirname, '..', 'lib', 'holiday.js');
const FIX = path.join(__dirname, 'fixtures');

/** 期望值：从通知原文逐条整理的周一至周五放假日 */
const EXPECT = {
	'2023': ['2023-01-02', '2023-01-23', '2023-01-24', '2023-01-25', '2023-01-26', '2023-01-27',
		'2023-04-05', '2023-05-01', '2023-05-02', '2023-05-03', '2023-06-22', '2023-06-23',
		'2023-09-29', '2023-10-02', '2023-10-03', '2023-10-04', '2023-10-05', '2023-10-06'],
	'2024': ['2024-01-01', '2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16',
		'2024-04-04', '2024-04-05', '2024-05-01', '2024-05-02', '2024-05-03', '2024-06-10',
		'2024-09-16', '2024-09-17', '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-07'],
	'2025': ['2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03',
		'2025-02-04', '2025-04-04', '2025-05-01', '2025-05-02', '2025-05-05', '2025-06-02',
		'2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08'],
	'2026': ['2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
		'2026-02-20', '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05',
		'2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']
};

(async () => {
	const mod = await import('file:///' + LIB.replace(/\\/g, '/'));

	Object.keys(EXPECT).forEach((year) => {
		const text = fs.readFileSync(path.join(FIX, 'holiday-notice-' + year + '.txt'), 'utf8');
		const days = mod.parseHolidayNotice(text, Number(year));
		assert.deepStrictEqual(days, EXPECT[year], year + ' 年放假日历');
		console.log('= ' + year + '：' + days.length + ' 天，与通知原文一致');
	});

	/* 内嵌表 vs 通知原文：两处独立整理的结果必须逐项相同 */
	const client = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
	const block = client.slice(client.indexOf('const HOLIDAYS = {'), client.indexOf('const HOLIDAY_SETS'));
	const builtin = (block.match(/"\d{4}-\d{2}-\d{2}"/g) || []).map((one) => one.slice(1, -1)).sort();
	assert.strictEqual(builtin.length, EXPECT['2026'].length, '内嵌表天数与通知一致');
	assert.deepStrictEqual(builtin, EXPECT['2026'], '内嵌表要与 2026 通知原文的解析结果一致');
	console.log('= 客户端内嵌表与 2026 通知原文解析结果一致（' + builtin.length + ' 天）');

	/* host 拿到的入参是 HTML，标签要先剥掉；含"上班"的句子不能算假期 */
	const html = '<p>一、元旦：1月1日（周四）至3日（周六）放假调休，共3天。</p><p>1月4日（周日）上班。</p>';
	assert.deepStrictEqual(mod.parseHolidayNotice(html, 2026), ['2026-01-01', '2026-01-02'], 'HTML 正文解析');
	assert.deepStrictEqual(mod.parseHolidayNotice('1月4日（周日）上班。', 2026), [], '上班句不算假期');
	assert.deepStrictEqual(mod.parseHolidayNotice('', 2026), [], '空文本不报错');
	console.log('= HTML 正文、调休上班句、空文本都处理正确');

	/* ---------------------------------------------- 畸形 HTML 不能拖死主线程
	   这段处理的是外部网页（内容不受我们控制），历史实现有两个准二次复杂度的写法：
	     · `/<script[\s\S]*?<\/script>/gi`：缺闭合时从每个 `<` 往后扫到文末；
	     · `/<[^>]+>/g`：`[^>]` 没排除 `<`，大量孤立 `<` 时反复跨越大段文本。
	   实测 40 万个未闭合 `<script>` 旧实现要 6 秒、20 万孤立 `<` 要 12 秒，
	   全都卡在 host 主线程上（整个 DSH 界面无响应）。这里用**耗时上限**钉住：
	   新实现是纯线性扫描，这些输入应在毫秒级完成。 */
	const timeOf = (label, fn) => {
		const started = Date.now();
		const out = fn();
		const ms = Date.now() - started;
		assert.ok(ms < 1500, label + ' 应在 1.5 秒内完成（线性扫描），实际 ' + ms + 'ms —— '
			+ '超过说明又退回了「每个起点往后扫」的写法');
		return out;
	};
	/* 未闭合 script：拿不到闭合标签时整段丢弃，不能反复重扫 */
	const openScripts = '<script>'.repeat(20000);
	timeOf('2 万个未闭合 <script>', () => mod.holidayHtmlToText(openScripts));
	/* 大量孤立 `<`：`[^<>]` 遇到 `<` 立刻失败，不会跨越大段文本 */
	const strayLt = '<'.repeat(100000);
	timeOf('10 万个孤立 <', () => mod.holidayHtmlToText(strayLt));
	/* 正常的成对标签仍要正确剥掉（健壮性修复不能把功能改坏） */
	assert.strictEqual(mod.holidayHtmlToText('<p>甲</p><script>bad()</script><p>乙</p>'), '甲\n乙',
		'script 段整段丢掉，其余标签剥成换行');
	assert.strictEqual(mod.holidayHtmlToText('<style>.a{}</style>正文'), '正文', 'style 段同样丢掉');
	assert.strictEqual(mod.holidayHtmlToText('没有标签的纯文本'), '没有标签的纯文本', '纯文本原样返回');
	/* 超长文档按 2MB 截断：宁可解析不全，也不能让主线程卡住 */
	const huge = '<p>甲</p>' + 'x'.repeat(3 * 1024 * 1024);
	timeOf('3MB 超长文档', () => mod.holidayHtmlToText(huge));
	console.log('= 畸形 HTML（未闭合 script / 孤立 < / 3MB 超长）都在 1.5 秒内完成，标签仍正确剥除');

	console.log('');
	console.log('HOLIDAY PARSE CHECKS PASSED');
})().catch((error) => {
	console.error('HOLIDAY PARSE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
