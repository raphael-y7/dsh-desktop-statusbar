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
		mergeExcludeIntoYaml, findProfileDir, ensureReleaseAgeExclude,
		keepRecentVersions, MAX_EXEMPT_VERSIONS
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

	/* ------------------------------------------------- 版本不累积（回归）
	   早先 `unionSelectors` 把所有历史版本永久并进同一条规则：更新 N 次后长成
	   `2.0.0 || 2.0.1 || 2.1.0 || 2.1.1 || 2.1.2 || …`。两个实际坏处：
	     · 规则无限变长，用户看不懂这一行在干什么；
	     · 更要紧：一旦某次真的写成两条同名规则，pnpm 只认第一条 → 新版本被
	       24 小时发布年龄挡下（这正是修复前磁盘上的真实状态）。
	   现在的语义是「目标版本 + 最近一个」，见 MAX_EXEMPT_VERSIONS。 */
	const DEEP = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - dsh-desktop-statusbar@2.0.0 || 2.0.1 || 2.1.0 || 2.1.1 || 2.1.2',
		'  - other-plugin@1.0.0 || 1.0.1 || 1.0.2 || 1.0.3',
		''
	].join('\n');
	const trimmed = mergeExcludeIntoYaml(DEEP, 'dsh-desktop-statusbar', '2.2.0');
	const trimLines = trimmed.text.split('\n').filter((l) => l.includes('dsh-desktop-statusbar'));
	assert.strictEqual(trimLines.length, 1, '仍然只有一条规则');
	const trimVersions = trimLines[0].replace(/^.*?@/, '').replace(/['"]/g, '').split('||').map((one) => one.trim());
	assert.ok(trimVersions.length <= MAX_EXEMPT_VERSIONS,
		'历史版本必须裁到 ' + MAX_EXEMPT_VERSIONS + ' 个以内，实际 ' + JSON.stringify(trimVersions));
	assert.ok(trimVersions.includes('2.2.0'), '目标版本在');
	assert.ok(trimVersions.includes('2.1.2'), '上一版保留（可回滚）');
	assert.ok(!trimVersions.includes('2.0.0'), '最早的被裁掉');
	/* 别人的规则一条都不能少、也不能被裁 */
	assert.ok(trimmed.text.includes('other-plugin@1.0.0 || 1.0.1 || 1.0.2 || 1.0.3'),
		'别的插件的多版本规则必须原样保留（不裁剪、不加引号）\n' + trimmed.text);
	console.log('版本不累积：' + trimLines[0].trim() + '（别人的规则原样）');

	/* ------------------------------------------------- 反复升级也不膨胀 */
	let rolling = one;
	['2.2.0', '2.3.0', '2.4.0', '2.5.0'].forEach((version) => {
		rolling = mergeExcludeIntoYaml(rolling, 'dsh-desktop-statusbar', version).text;
	});
	const rollLine = rolling.split('\n').filter((l) => l.includes('dsh-desktop-statusbar'))[0];
	const rollVersions = rollLine.replace(/^.*?@/, '').replace(/['"]/g, '').split('||').map((one) => one.trim());
	assert.ok(rollVersions.length <= MAX_EXEMPT_VERSIONS, '连续升级 4 次后仍是 ' + rollVersions.length + ' 个版本');
	assert.ok(rollVersions.includes('2.5.0'), '最后的目标版本在');
	console.log('连续升级 4 次后：' + rollLine.trim());

	/* ------------------------------------------------- 别人的规则逐字节不变
	   这是**共享文件**（多个插件共用 profile 的 pnpm-workspace.yaml）。只改我们那一行，
	   其它行一个字节都不能动 —— 包括：
	     · 不含 `||` 的简单规则（`other-plugin@1.0.0`）→ 不能被加上引号；
	     · 含 `||` 的多版本规则 → 不能丢版本、不能被裁剪、不能被引号包起来；
	     · 作用域包的引号写法 → 原样保留。
	   早先的实现把每个条目都重新生成一遍，于是 `dshmarket@1.66.22 || 1.66.32`
	   被写成 `'dshmarket@1.66.22 || 1.66.32'` —— 语义等价但改写了别人的配置。 */
	const OTHERS = [
		'  - other-plugin@1.0.0',
		'  - multi-plugin@2.0.0 || 2.0.1 || 2.0.2 || 2.0.3 || 2.0.4',
		"  - '@scope/pkg@1.0.0'",
		''
	].join('\n');
	const shared = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - dsh-desktop-statusbar@2.1.1 || 2.1.2',
		''
	].join('\n').replace('  - dsh-desktop-statusbar@2.1.1 || 2.1.2\n', '  - dsh-desktop-statusbar@2.1.1 || 2.1.2\n' + OTHERS);
	const sharedOut = mergeExcludeIntoYaml(shared, 'dsh-desktop-statusbar', '2.2.0');
	const otherLines = (text) => text.split('\n')
		.filter((line) => /^\s*-\s/.test(line))
		.filter((line) => line.indexOf('dsh-desktop-statusbar') === -1);
	assert.deepStrictEqual(otherLines(sharedOut.text), otherLines(shared),
		'别人的规则必须逐字节不变（不许加引号、不许裁剪、不许丢版本）\n'
		+ '改前：' + JSON.stringify(otherLines(shared)) + '\n改后：' + JSON.stringify(otherLines(sharedOut.text)));
	console.log('别人的规则：逐字节不变（' + otherLines(sharedOut.text).length + ' 行）');

	/* --------------------------------- 目标版本必须保住（即使它比现有的都老）
	   回滚场景：用户从 2.5.0 退回 2.0.0 → 目标版本比已保留的都小。
	   裁剪算法若只取"最大的 N 个"，会把目标版本裁掉、导致这次安装被发布年龄挡住。 */
	const rollback = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - dsh-desktop-statusbar@2.4.0 || 2.5.0',
		''
	].join('\n');
	const rb = mergeExcludeIntoYaml(rollback, 'dsh-desktop-statusbar', '2.0.0');
	const rbLine = rb.text.split('\n').filter((l) => l.includes('dsh-desktop-statusbar'))[0];
	const rbVersions = rbLine.replace(/^.*?@/, '').replace(/['"]/g, '').split('||').map((one) => one.trim());
	assert.ok(rbVersions.includes('2.0.0'),
		'回滚场景下目标版本 2.0.0 必须保留（否则这次安装被发布年龄挡住）：' + rbLine);
	assert.ok(rbVersions.length <= MAX_EXEMPT_VERSIONS, '仍然不超过上限：' + JSON.stringify(rbVersions));
	console.log('回滚到更老版本：' + rbLine.trim());

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

	/* ------------------------------------------ 安全阀：文件里已有**重复键**时拒绝写入
	   这是共享文件最坏的一种输入：`minimumReleaseAgeExclude:` 出现两次（历史遗留，
	   或两个插件各自追加过）。定位函数只找第一个块，替换后第二个原样留着 →
	   输出仍是两个同名键 → YAML `duplicated mapping key` → pnpm 拒绝加载整个 profile
	   → **所有插件都装不上**。这种状态下唯一安全的动作是什么都不做（见实现里的安全阀）。 */
	const DUP = [
		'packages:',
		'  - .',
		'',
		'minimumReleaseAgeExclude:',
		'  - other-plugin@1.0.0',
		'minimumReleaseAgeExclude:',
		'  - another@2.0.0',
		''
	].join('\n');
	const dupOut = mergeExcludeIntoYaml(DUP, 'dsh-desktop-statusbar', '2.2.0');
	assert.strictEqual(dupOut.ok, false, '已有重复键时必须拒绝写入（不能写出更坏的 YAML）');
	assert.strictEqual(dupOut.reason, 'duplicate-key', '给出 duplicate-key 原因');
	assert.strictEqual(dupOut.changed, false, '拒绝时不得声称有改动');
	assert.strictEqual(dupOut.text, DUP, '拒绝时正文必须**逐字节不变**');
	console.log('安全阀：文件已有两个 minimumReleaseAgeExclude 时拒绝写入、正文不变');

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
	/* 版本数**有上限**：只留目标版本 + 最近一个（见 MAX_EXEMPT_VERSIONS）。
	   早先这里断言「三个版本都在」，那正是"历史版本永久累积"这个缺陷被固化成期望。
	   累积的实际坏处：规则无限变长，且一旦某次写成两条同名规则，pnpm 只认第一条、
	   新版本反被发布年龄策略挡住。留 2 个是为了让用户能回滚上一版。 */
	const fixedVersions = (fixedLines[0].replace(/^.*?@/, '').replace(/['"]/g, '').split('||') || []).map((one) => one.trim());
	assert.ok(fixedVersions.length <= MAX_EXEMPT_VERSIONS, '版本数不超过上限 ' + MAX_EXEMPT_VERSIONS + '，实际 ' + JSON.stringify(fixedVersions));
	assert.ok(fixedVersions.includes('2.2.0'), '目标版本 2.2.0 必须在：' + fixedLines[0]);
	assert.ok(fixedVersions.includes('2.1.1'), '上一版 2.1.1 保留（可回滚）：' + fixedLines[0]);
	assert.ok(fixedVersions.includes('2.0.0') !== true, '更老的 2.0.0 应被裁掉：' + fixedLines[0]);
	console.log('修复同名多条（并裁剪到 ' + fixedVersions.length + ' 个版本）：' + fixedLines[0]);

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

		/* 落盘路径的安全阀：文件里已有重复键时，绝不能写盘（盘上内容保持原样） */
		const dupDir = mkdtempSync(join(tmpdir(), 'dsb-age-dup-'));
		try {
			writeFileSync(join(dupDir, 'pnpm-workspace.yaml'), DUP, 'utf8');
			const dupWrite = ensureReleaseAgeExclude(dupDir, '2.2.0');
			assert.strictEqual(dupWrite.ok, false, '落盘路径也要拒绝重复键文件');
			assert.strictEqual(dupWrite.reason, 'duplicate-key', '落盘路径给出 duplicate-key');
			assert.strictEqual(dupWrite.changed, false, '落盘路径不得声称有改动');
			assert.strictEqual(readFileSync(join(dupDir, 'pnpm-workspace.yaml'), 'utf8'), DUP,
				'拒绝时磁盘文件必须逐字节不变（否则就是把共享文件写坏了）');
		} finally {
			rmSync(dupDir, { recursive: true, force: true });
		}
		console.log('落盘：写入 / 幂等 / 拒绝非法版本 / 缺文件不抛错 / 拒绝重复键文件 全部正确');

		/* ---------------------------------------------------------------- 不产生重复键
		   这个键不只有「独占一行 + 下面挂列表」一种写法：pnpm 生态里 flow 风格
		   （`minimumReleaseAgeExclude: ["a@1.0.0"]`）、行尾注释、空数组同样常见。
		   早先只认块风格，遇到这些写法会误判成「没有这个键」而**追加出第二个同名键**，
		   YAML 直接 `duplicated mapping key`、pnpm 拒绝启动 —— 受害的是整个 profile。
		   实测（宿主自带 pnpm）确认过：修复前这些输入会被 pnpm 拒；修复后能解析。 */
		const INLINE_CASES = [
			['flow 风格：键与数组同行', 'packages:\n  - .\nminimumReleaseAgeExclude: ["other@0.4.4"]\n'],
			['行尾注释', 'packages:\n  - .\nminimumReleaseAgeExclude:  # 豁免表\n  - other@0.4.4\n'],
			['空数组同行', 'packages:\n  - .\nminimumReleaseAgeExclude: []\n'],
			['块风格（基线）', 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - other@0.4.4\n'],
		];
		for (const [label, source] of INLINE_CASES) {
			const merged = mergeExcludeIntoYaml(source, 'dsh-desktop-statusbar', '2.1.2');
			const keyCount = (merged.text.match(/^minimumReleaseAgeExclude:/gm) || []).length;
			assert.strictEqual(keyCount, 1, label + '：同名键只能有一个（重复会让 pnpm 拒绝解析），实际 ' + keyCount + ' 个');
			assert.ok(merged.text.includes('dsh-desktop-statusbar@2.1.2'), label + '：写入了我们的版本');
		}
		/* 原有条目不能被丢掉 */
		const kept = mergeExcludeIntoYaml('minimumReleaseAgeExclude: ["other@0.4.4"]\n', 'dsh-desktop-statusbar', '2.1.2');
		assert.ok(kept.text.includes('other@0.4.4'), 'flow 写法里的原有条目必须保留：' + kept.text);
		console.log('不产生重复键：flow / 行尾注释 / 空数组 / 块风格 都只写一个键，且原有条目保留');

		/* ------------------------------------------------- 末行无换行 / 零缩进（实测缺陷）
		   两个都会让 YAML 解析失败，且都是「看着不像问题」的输入：
		     · **末行没有换行符**（编辑器保存的常见形态）：正则原先要求键行后必须跟 \n，
		       匹配不上就走「文件里没这个键」分支，追加出第二个同名键。
		     · **零缩进的序列**（`- a@1.0.0` 顶格）：YAML 里合法，但重排后新旧条目
		       缩进不一致（一条两空格一条顶格），解析同样报错。 */
		const EDGE_CASES = [
			['末行无换行 + 空数组', 'packages:\n  - .\nminimumReleaseAgeExclude: []'],
			['末行无换行 + flow', 'packages:\n  - .\nminimumReleaseAgeExclude: ["other@0.4.4"]'],
			['末行无换行 + 块', 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - other@0.4.4'],
			['末行无换行 + 注释', 'packages:\n  - .\nminimumReleaseAgeExclude:  # 表'],
			['零缩进序列', 'packages:\n  - .\nminimumReleaseAgeExclude:\n- other@0.4.4\n'],
		];
		for (const [label, source] of EDGE_CASES) {
			const merged = mergeExcludeIntoYaml(source, 'dsh-desktop-statusbar', '2.1.2');
			const keyCount = (merged.text.match(/^minimumReleaseAgeExclude:/gm) || []).length;
			assert.strictEqual(keyCount, 1, label + '：同名键只能有一个，实际 ' + keyCount + ' 个');
			/* 块内所有条目行必须同一缩进，否则 YAML 会解析失败 */
			const entryIndents = merged.text.split('\n')
				.filter((line) => /^\s*-\s/.test(line))
				.map((line) => line.match(/^\s*/)[0].length);
			const kinds = Array.from(new Set(entryIndents));
			assert.strictEqual(kinds.length <= 1, true, label + '：条目缩进必须一致，实际 ' + JSON.stringify(kinds));
			assert.ok(merged.text.includes('dsh-desktop-statusbar@2.1.2'), label + '：写入了我们的版本');
		}
		console.log('末行无换行 / 零缩进：都只写一个键、缩进一致');

		/* ------------------------------------------------- 裸包名不能被收窄（实测缺陷）
		   用户写 `- dsh-desktop-statusbar`（无 @版本）的语义是**放行该包所有版本**。
		   早先无条件重排，会把它改成 `- dsh-desktop-statusbar@2.1.2`，
		   静默把「整包放行」收窄成「只放行这一个版本」—— 是倒退，不是修复。 */
		const bare = mergeExcludeIntoYaml(
			'packages:\n  - .\nminimumReleaseAgeExclude:\n  - dsh-desktop-statusbar\n',
			'dsh-desktop-statusbar', '2.1.2');
		assert.strictEqual(bare.changed, false, '裸包名已覆盖目标版本，不该改动');
		assert.ok(bare.text.includes('  - dsh-desktop-statusbar\n'), '裸包名必须原样保留（语义是放行所有版本）');
		assert.ok(bare.text.includes('dsh-desktop-statusbar@') === false, '不得把裸包名收窄成带版本的写法');
		console.log('裸包名：原样保留，不被收窄成单个版本');

		/* ------------------------------------------------- BOM / 跨行 flow / 引号标量（实测缺陷）
		   这四个是独立复审报出来的、上面那些用例**抓不到**的写法。
		   统计同名键必须用**非锚定**匹配：BOM 开头的文件里 `^minimumReleaseAgeExclude:`
		   匹配不到首行那个键，用它计数会少数一个 —— 也就是说，
		   旧断言对 BOM 这类输入是「天生抓不到」，绿了也不代表没写出重复键。 */
		const countKeys = (text) => (text.match(/minimumReleaseAgeExclude:/g) || []).length;
		const HARD_CASES = [
			['BOM + 块风格', '\uFEFFminimumReleaseAgeExclude:\n  - other@0.4.4\n'],
			['BOM + flow 同行', '\uFEFFminimumReleaseAgeExclude: ["other@0.4.4"]\n'],
			['BOM + 末行无换行', '\uFEFFminimumReleaseAgeExclude: []'],
			['flow 带行尾注释', 'minimumReleaseAgeExclude: ["other@0.4.4"] # 说明\n'],
			['跨行 flow 数组', 'minimumReleaseAgeExclude: [\n  "other@0.4.4"\n]\n'],
			['带单引号的裸标量', "minimumReleaseAgeExclude: 'dsh-desktop-statusbar@2.1.1'\n"],
			['带双引号的裸标量', 'minimumReleaseAgeExclude: "dsh-desktop-statusbar@2.1.1"\n'],
		];
		for (const [label, source] of HARD_CASES) {
			const merged = mergeExcludeIntoYaml(source, 'dsh-desktop-statusbar', '2.1.2');
			assert.strictEqual(countKeys(merged.text), 1,
				label + '：同名键只能有一个，实际 ' + countKeys(merged.text) + ' 个\n' + merged.text);
			/* 目标版本要被覆盖到：允许 `名字@1.1 || 1.2` 的合并形态 */
			const covered = merged.text.split('\n').some((line) => {
				const selector = line.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, '').trim();
				if (selector.startsWith('dsh-desktop-statusbar@') !== true) return false;
				return selector.slice('dsh-desktop-statusbar@'.length).split('||').map((v) => v.trim()).includes('2.1.2');
			});
			assert.strictEqual(covered, true, label + '：没有覆盖到目标版本 2.1.2\n' + merged.text);
			/* 幂等：再跑一次不该有改动（引号写法早先不幂等） */
			const again = mergeExcludeIntoYaml(merged.text, 'dsh-desktop-statusbar', '2.1.2');
			assert.strictEqual(again.changed, false, label + '：第二次调用不该再改动（不幂等）\n' + merged.text);
			/* 原有条目不能丢 */
			if (source.includes('other@0.4.4')) {
				assert.strictEqual(merged.text.includes('other@0.4.4'), true, label + '：原有条目丢了\n' + merged.text);
			}
		}
		console.log('BOM / 跨行 flow / 引号标量：都只写一个键、覆盖目标、幂等、不丢原条目');

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
