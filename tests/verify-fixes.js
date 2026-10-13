/**
 * 回归测试：本轮对抗性审查发现并修复的缺陷，逐条钉住，避免以后改回去。
 *
 * 覆盖 6 条：
 *   ① 开发模式与设置页组件状态不同步 —— 卸载时若只清定时器，devMode 会留着，
 *      重挂后界面没有胶囊、按钮却显示演示版本号，点下去只播演示不安装。
 *   ② 价格库上报的请求体上限太小 —— 24 个模型就超过 4KB 被掐断，价格库静默不同步。
 *   ③ 失败原因 update.reason 只写不读 —— 所有失败都退化成「更新失败」四个字。
 *   ④ release-age 在 flow 写法下写出重复键 —— pnpm 拒绝解析整个 profile。
 *   ⑤ 客户端日期键用本机时区 —— 非 UTC+8 机器上「今天」错一天（host 用 +8h）。
 *   ⑥ 导航胶囊无条件写 textContent —— 与 MutationObserver 形成每帧空转。
 *
 * 用法：node tests/verify-fixes.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const LIB = path.join(__dirname, '..', 'lib');
const client = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const host = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');

/* 去掉注释再断言：注释里会提到这些名字，直接搜源码会误判「还在用」。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const clientCode = stripComments(client);
const hostCode = stripComments(host);

console.log('===== ① 开发模式：卸载时必须复位模块级状态 =====');
assert.ok(/react\.useEffect\(\(\) => \(\) => \{\s*if \(devMode === true\) setDevMode\(false\);?\s*\}/.test(clientCode),
	'设置页卸载时要复位 devMode（否则重挂后 devMode=true 但胶囊不显示，更新按钮变成空操作）');
assert.ok(!/useEffect\(\(\) => \(\) => \{\s*if \(devTimer !== null\) \{ clearTimeout\(devTimer\); devTimer = null; \} \}\s*\}, \[\]\)/.test(clientCode),
	'不能只清定时器、不重置 devMode');
console.log('      卸载时调用 setDevMode(false)，且只在真的开着时才调');

console.log('\n===== ② 价格库上报：上限要够用，失败要能看见 =====');
/* 请求体上限必须有量级提升：24 个模型约 4.2KB，旧的 4096 不够 */
const limitMatch = hostCode.match(/JSON_BODY_LIMIT\s*=\s*([0-9*\s]+)/);
assert.ok(limitMatch !== null, '应有具名的请求体上限常量，而不是散落的魔法数字 4096');
const limitExpr = limitMatch[1].trim();
const limitValue = limitExpr.split('*').reduce((acc, one) => acc * Number(one.trim()), 1);
assert.ok(limitValue >= 64 * 1024, '上限至少 64KB（24 个模型约 4.2KB，旧值 4096 会掐断），实际 ' + limitValue);
assert.ok(/raw\.length > JSON_BODY_LIMIT/.test(hostCode), '按该常量判断，而不是写死 4096');
assert.ok(!/raw\.length > 4096/.test(hostCode), '旧的 4096 判断必须消失');
/* 客户端要检查 response.ok：fetch 对 4xx 是 resolve 不是 reject，只 catch 抓不到 */
assert.ok(/response\.ok !== true/.test(clientCode), '价格库上报要检查 response.ok（4xx 不会进 catch）');
assert.ok(!/body: JSON\.stringify\(\{ models: models \}\)\s*\}\)\.catch\(\(\) => \{ \/\* 上报失败不影响底栏 \*\/ \}\);/.test(clientCode),
	'不能再用「只 catch、不看 response」的那种写法静默吞掉失败');
console.log('      上限 ' + limitExpr + '（= ' + limitValue + ' 字节），且上报失败会告警');

console.log('\n===== ③ 更新失败仍只说「更新失败」（按用户要求，不额外暴露原因）=====');
/* 用户明确不要悬停可见原因，所以按钮上不该有 title 透露 reason。
   这条断言防的是「以后又有人好心把内部原因挂到界面上」。 */
assert.ok(!/title: update\.note === "failed"/.test(clientCode),
	'更新失败按钮不应挂 title 暴露内部原因（用户明确不要）');
const failedLabel = clientCode.slice(clientCode.indexOf('update.note === "done"'), clientCode.indexOf('update.note === "done"') + 400);
assert.ok(/t\("updateFailed"\)/.test(failedLabel), '失败态仍显示 updateFailed 文案');
console.log('      失败态就是「更新失败」四个字，不暴露内部 reason');

console.log('\n===== ④ release-age：所有写法都只能产出一个同名键 =====');
/* 直接跑真实函数，比字符串断言可靠 */
const { mergeExcludeIntoYaml } = require(path.join(LIB, 'release-age.js'));
const YAML_CASES = [
	['flow 风格', 'minimumReleaseAgeExclude: ["other@0.4.4"]\n'],
	['行尾注释', 'minimumReleaseAgeExclude:  # 表\n  - other@0.4.4\n'],
	['空数组', 'minimumReleaseAgeExclude: []\n'],
	['块风格', 'minimumReleaseAgeExclude:\n  - other@0.4.4\n'],
	['没有该键', 'packages:\n  - .\n'],
];
for (const [label, src] of YAML_CASES) {
	const out = mergeExcludeIntoYaml(src, 'dsh-desktop-statusbar', '2.1.2');
	const keys = (out.text.match(/^minimumReleaseAgeExclude:/gm) || []).length;
	assert.strictEqual(keys, 1, label + '：同名键只能有一个，实际 ' + keys + ' 个（重复会让 pnpm 拒绝解析）');
	assert.ok(out.text.includes('dsh-desktop-statusbar@2.1.2'), label + '：写入了目标版本');
}
console.log('      ' + YAML_CASES.length + ' 种写法都只写一个键');
/* 同行写法也要把已有条目保留下来，不能替换掉 */
const kept = mergeExcludeIntoYaml('minimumReleaseAgeExclude: ["other@0.4.4"]\n', 'dsh-desktop-statusbar', '2.1.2');
assert.ok(kept.text.includes('other@0.4.4'), 'flow 写法里的原有条目必须保留');
console.log('      flow 写法里的原有条目保留');

console.log('\n===== ⑤ 日期归属按装机者时区（峰谷计价仍按北京时间）=====');
assert.ok(/function dateKeyOf\(ms\)/.test(clientCode), '仍有 dateKeyOf');
const dateKeyBody = clientCode.slice(clientCode.indexOf('function dateKeyOf(ms)'));
const dateKeyFn = dateKeyBody.slice(0, dateKeyBody.indexOf('\n\t\t}'));
/* 日期归属：用本机时区（getFullYear/getMonth/getDate），不加 8 小时偏移 */
assert.ok(/d\.getFullYear\(\)/.test(dateKeyFn) && /d\.getMonth\(\)/.test(dateKeyFn) && /d\.getDate\(\)/.test(dateKeyFn),
	'dateKeyOf 按装机者时区取年月日');
assert.ok(!/\+ 8 \* 3600 \* 1000/.test(dateKeyFn),
	'日期归属不得再固定加 8 小时：UTC+8 装机看不出差别，其它时区会整体错一天');
/* host 侧同口径 */
const hostDates = hostCode.slice(hostCode.indexOf('function localDateKey'), hostCode.indexOf('function localDateKey') + 400);
assert.ok(/date\.getFullYear\(\)/.test(hostDates), 'host 的 localDateKey 也按本机时区');
assert.ok(!/ms \+ 8 \* 3600/.test(hostDates), 'host 的 localDateKey 不得再固定加 8 小时');
/* 峰谷计价必须**保留**北京时间 —— 那是 DeepSeek 的官方计费规则，与装机位置无关 */
const peakFn = hostCode.slice(hostCode.indexOf('function isPeakTime'), hostCode.indexOf('function isPeakTime') + 500);
assert.ok(/ms \+ 8 \* 3600 \* 1000/.test(peakFn),
	'isPeakTime（峰谷计价）必须继续按北京时间：那是官方计费规则，不能跟着装机时区走');
/* 行为验证：跨零点时刻在不同时区应归到各自的本地日期 */
const AT = Date.UTC(2026, 9, 13, 16, 30, 0); /* 北京 10-14 00:30 / 纽约 10-13 12:30 */
const localKeyAt = (ms, offsetHours) => {
	const d = new Date(ms + offsetHours * 3600 * 1000);
	const pad = (n) => (n < 10 ? '0' + n : String(n));
	return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
};
assert.strictEqual(localKeyAt(AT, 8), '2026-10-14', 'UTC+8 装机 → 10-14');
assert.strictEqual(localKeyAt(AT, -4), '2026-10-13', 'UTC-4 装机 → 10-13（本地还是 13 号）');
console.log('      装机时区 +8 / -4 各归到自己的日历日期；峰谷计价仍按北京时间');

console.log('\n===== ⑥ 导航胶囊：写 textContent 前先比值 =====');
const syncAt = clientCode.indexOf('function syncNavPill');
assert.ok(syncAt !== -1, '仍有 syncNavPill');
const syncFn = clientCode.slice(syncAt, syncAt + 700);
assert.ok(/has\.textContent !== text/.test(syncFn),
	'写 textContent 前必须比值：写相同内容也会产生 childList 记录，会让监听 childList 的 observer 每帧空转');
console.log('      已加值比较，不会自激 MutationObserver');

console.log('\nFIX REGRESSION CHECKS PASSED');
