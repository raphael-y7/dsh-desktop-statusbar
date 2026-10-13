/**
 * 发布年龄豁免：写 `minimumReleaseAgeExclude` 的那几个纯函数。
 *
 * 重点覆盖三件事：
 *   1. 没写过的文件能追加出一个合法块；
 *   2. 同一个包名已有条目时，追加而不是覆盖（别的插件/用户写的规则要留着）；
 *   3. pnpm「同一包名只认第一条」这个坑：同名多条必须合并成一条，
 *      否则我们追加的那条会被忽略 —— 这正是 dshmarket 记录的 #732。
 * 全程只做字符串进出，不碰真实文件、不联网。
 */
const assert = require('assert');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

(async () => {
	const mod = await import('../lib/release-age.js');
	const {
		nameOfSelector, versionOfSelector, parseExcludeBlock, unionSelectors,
		mergeExcludeIntoYaml, findProfileDir, ensureReleaseAgeExclude
	} = mod;

	/* ---------------------------------------------------------- 选择器解析 */
	assert.strictEqual(nameOfSelector('dsh-desktop-statusbar@2.2.0'), 'dsh-desktop-statusbar', '普通包名');
	assert.strictEqual(versionOfSelector('dsh-desktop-statusbar@2.2.0'), '2.2.0', '普通版本');
	/* 作用域包前面还有一个 @，不能从下标 0 开始找 */
	assert.strictEqual(nameOfSelector('@scope/pkg@1.0.0'), '@scope/pkg', '作用域包名');
	assert.strictEqual(versionOfSelector('@scope/pkg@1.0.0'), '1.0.0', '作用域包版本');
	assert.strictEqual(nameOfSelector('plain'), 'plain', '没有版本时整串就是包名');
	console.log('选择器解析：普通 / 作用域 / 无版本 三种都对');

	/* ------------------------------------------------------------ 块解析 */
	const items = parseExcludeBlock('  - a@1.0.0\n  # 一行注释\n  - @s/p@2.0.0\n');
	assert.strictEqual(items.length, 3, '两行条目 + 一行注释');
	assert.strictEqual(items[0].selector, 'a@1.0.0', '第一条');
	assert.strictEqual(items[1].kind, 'comment', '注释行被认出');
	assert.strictEqual(items[2].selector, '@s/p@2.0.0', '作用域条目');
	console.log('块解析：条目与注释区分正确');

	/* ---------------------------------------------------------- 合并同名 */
	assert.strictEqual(unionSelectors(['a@1.0.0']), '1.0.0', '单个版本');
	assert.strictEqual(unionSelectors(['a@2.0.0', 'a@1.0.0']), '2.0.0 || 1.0.0', '两个版本按出现顺序并起来');
	assert.strictEqual(unionSelectors(['a@1.0.0', 'a@1.0.0']), '1.0.0', '重复版本去重');
	console.log('同名合并：并集、去重都正确');

	/* ------------------------------------------------------- 追加到空/新 */
	const fresh = mergeExcludeIntoYaml('packages:\n  - .\n', 'dsh-desktop-statusbar', '2.2.0');
	assert.strictEqual(fresh.ok, true, '空文件合并成功');
	assert.strictEqual(fresh.changed, true, '空文件有改动');
	assert.ok(fresh.text.includes('minimumReleaseAgeExclude:'), '写出了一个块');
	assert.ok(fresh.text.includes('  - dsh-desktop-statusbar@2.2.0'), '写进了我们的版本');
	assert.ok(fresh.text.startsWith('packages:'), '原有内容留在前面');
	console.log('新建块：' + JSON.stringify(fresh.text));

	/* --------------------------------------------- 同名已有一条：追加版本 */
	const one = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - dsh-desktop-statusbar@2.1.1',
		''
	].join('\n');
	const merged = mergeExcludeIntoYaml(one, 'dsh-desktop-statusbar', '2.2.0');
	assert.strictEqual(merged.ok, true, '已有条目时合并成功');
	const lines = merged.text.split('\n').filter((line) => line.includes('dsh-desktop-statusbar'));
	assert.strictEqual(lines.length, 1, '同一个包名只保留一条规则（pnpm 只认第一条）');
	assert.ok(lines[0].includes('2.1.1') && lines[0].includes('2.2.0'), '旧版本与新版本都在这一条里：' + lines[0]);
	console.log('同名追加（#732 的坑）：' + lines[0]);

	/* --------------------------------------- 已经包含目标版本：不再重复写 */
	const already = mergeExcludeIntoYaml(one, 'dsh-desktop-statusbar', '2.1.1');
	assert.strictEqual(already.changed, false, '已经放行过就不再改动');
	assert.strictEqual(already.text, one, '文本逐字节不变');
	console.log('已放行过的版本：不重复写、正文不变');

	/* ------------------------------------ 别人的规则与我们并存：互不干扰 */
	const mixed = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - other-plugin@1.0.0',
		'  - dsh-desktop-statusbar@2.1.1',
		''
	].join('\n');
	const kept = mergeExcludeIntoYaml(mixed, 'dsh-desktop-statusbar', '2.2.0');
	assert.ok(kept.text.includes('other-plugin@1.0.0'), '别的插件的规则原样保留');
	assert.strictEqual(kept.text.split('\n').filter((l) => l.includes('dsh-desktop-statusbar')).length, 1, '我们的规则合成一条');
	console.log('与其它插件共存：别的规则没被动');

	/* ------------------------------------------ 多条同名（pnpm 的坏形态） */
	const doubled = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - dsh-desktop-statusbar@2.0.0',
		'  - dsh-desktop-statusbar@2.1.1',
		''
	].join('\n');
	const fixed = mergeExcludeIntoYaml(doubled, 'dsh-desktop-statusbar', '2.2.0');
	const fixedLines = fixed.text.split('\n').filter((l) => l.includes('dsh-desktop-statusbar'));
	assert.strictEqual(fixedLines.length, 1, '两条同名被并成一条（这就是 #732 的修复）');
	assert.ok(fixedLines[0].includes('2.0.0') && fixedLines[0].includes('2.1.1') && fixedLines[0].includes('2.2.0'), '三个版本都在：' + fixedLines[0]);
	console.log('修复同名多条：' + fixedLines[0]);

	/* --------------------------------------------------- 引号与注释不丢 */
	const quoted = [
		'minimumReleaseAgeExclude:',
		"  - '@scope/pkg@1.0.0'",
		'  - dsh-desktop-statusbar@2.1.1',
		''
	].join('\n');
	const q = mergeExcludeIntoYaml(quoted, 'dsh-desktop-statusbar', '2.2.0');
	assert.ok(q.text.includes("'@scope/pkg@1.0.0'"), '作用域包的引号写法保留');
	console.log('引号写法：保留原样');

	/* ------------------------------------------------ 实际落盘（临时目录） */
	const dir = mkdtempSync(join(tmpdir(), 'dsb-age-'));
	try {
		writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', 'utf8');
		const wrote = ensureReleaseAgeExclude(dir, '2.2.0');
		assert.strictEqual(wrote.ok, true, '落盘成功');
		assert.strictEqual(wrote.changed, true, '确实改了');
		const disk = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
		assert.ok(disk.includes('dsh-desktop-statusbar@2.2.0'), '盘上有我们的版本');

		/* 再来一次不该有变化 */
		const again = ensureReleaseAgeExclude(dir, '2.2.0');
		assert.strictEqual(again.ok, true, '第二次也成功');
		assert.strictEqual(again.changed, false, '第二次没有改动');
		assert.strictEqual(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), disk, '文件内容不变');

		/* 版本号不合法时拒绝，绝不把奇怪的值写进去 */
		const bad = ensureReleaseAgeExclude(dir, 'latest');
		assert.strictEqual(bad.ok, false, 'latest 这种非精确版本被拒绝');
		assert.strictEqual(bad.reason, 'bad-version', '给出 bad-version');
		assert.strictEqual(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'), disk, '被拒绝时文件没被动');

		/* 文件不存在时是结构化失败，不抛错 */
		const missing = ensureReleaseAgeExclude(join(dir, 'nope'), '2.2.0');
		assert.strictEqual(missing.ok, false, '文件不存在时失败');
		assert.strictEqual(missing.reason, 'unreadable', '给出 unreadable');
		console.log('落盘：写入 / 幂等 / 拒绝非法版本 / 缺文件不抛错 全部正确');

		/* findProfileDir 能从一个嵌套位置向上找到 profile */
		const { mkdirSync } = require('fs');
		mkdirSync(join(dir, 'node_modules', 'dsh-desktop-statusbar'), { recursive: true });
		assert.strictEqual(findProfileDir(join(dir, 'node_modules', 'dsh-desktop-statusbar')), dir, '向上找到 profile 目录');
		console.log('findProfileDir：从 node_modules/<包名> 找到 profile 根');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	console.log('\nRELEASE-AGE CHECKS PASSED');
})().catch((error) => {
	console.error('RELEASE-AGE CHECKS FAILED:', error && error.message ? error.message : error);
	process.exitCode = 1;
});
