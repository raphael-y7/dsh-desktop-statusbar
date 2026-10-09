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

	console.log('');
	console.log('HOLIDAY PARSE CHECKS PASSED');
})().catch((error) => {
	console.error('HOLIDAY PARSE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error));
	process.exitCode = 1;
});
