/**
 * 自更新：定位 pnpm、放行发布年龄、核对实际装上的版本。
 *
 * 为什么关键用例必须用真东西：
 *   - 「点了没反应」的根因是**同步抛错**（读未声明的 ctx 服务），打桩测不出；
 *     客户端那一侧由 verify-navicon.js 覆盖「不再依赖 ctx.remote」这条接线。
 *   - 「24 小时限制」的失败模式是「看起来成功了」—— 裸 @latest 会静默装成旧版
 *     且退出码为 0。所以必须跑真的 pnpm 并回读盘上的版本。
 *
 * 用法：node tests/verify-self-update.js [--online]
 *   不带 --online 只跑纯函数（版本比对、pnpm 定位、自身定位、参数拼装）。
 *   带 --online 再跑真实的 pnpm 安装。
 */
const assert = require('assert');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const ONLINE = process.argv.includes('--online');

(async () => {
	const mod = await import('../lib/self-update.js');
	const {
		installedVersion, resolveSelfDir, resolvePnpm, runCommand,
		isReleaseAgeBlocked, selfUpdateOnce, isUpdating, lastUpdateResult,
		updateArgs, RELEASE_AGE_OVERRIDE
	} = mod;

	/* ------------------------------------------------------ 读版本 */
	const repoRoot = join(__dirname, '..');
	assert.strictEqual(installedVersion(repoRoot), JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version, '读出版本号');
	assert.strictEqual(installedVersion(join(repoRoot, 'nope')), null, '目录不存在时返回 null 而不是抛错');
	console.log('读版本：正常读到 / 缺目录不抛错');

	/* -------------------------------------------------- 自身定位 */
	const selfDir = resolveSelfDir();
	assert.strictEqual(JSON.parse(readFileSync(join(selfDir, 'package.json'), 'utf8')).name, 'dsh-desktop-statusbar', 'resolveSelfDir 指到本包根目录');
	assert.strictEqual(existsSync(join(selfDir, 'lib', 'self-update.js')), true, 'lib 就在 selfDir 下面（不是指到 lib/）');
	console.log('自身定位：' + selfDir);

	/* -------------------------------------------------- pnpm 定位 */
	const savedPnpm = process.env.DSH_DESKTOP_STATUSBAR_PNPM;
	try {
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = JSON.stringify(['node', '/x/pnpm.mjs']);
		const asArray = resolvePnpm();
		assert.strictEqual(asArray.command, 'node', '数组形式的命令被解析');
		assert.deepStrictEqual(asArray.args, ['/x/pnpm.mjs'], '数组形式的参数被解析');
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = '/usr/bin/pnpm';
		assert.strictEqual(resolvePnpm().command, '/usr/bin/pnpm', '单路径形式被接受');
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = '[]';
		assert.strictEqual(resolvePnpm().command, '[]', '空数组退化成当路径处理（不崩）');
		console.log('pnpm 定位：环境变量两种写法都支持');
	} finally {
		if (savedPnpm === undefined) delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		else process.env.DSH_DESKTOP_STATUSBAR_PNPM = savedPnpm;
	}

	/* ---------------------------------------------- 失败原因识别 */
	assert.strictEqual(isReleaseAgeBlocked('ERR_PNPM_NO_MATURE_MATCHING_VERSION 1 version'), true, '认 pnpm 11 的错误码');
	assert.strictEqual(isReleaseAgeBlocked('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'), true, '认老版本错误码');
	assert.strictEqual(isReleaseAgeBlocked('some other failure'), false, '别的失败不误判');
	console.log('失败识别：两种发布年龄错误码都认，别的不误判');

	/* ------------------------------------------------ 参数拼装 */
	const args = updateArgs(['/x/pnpm.mjs'], 'dsh-desktop-statusbar@9.9.9');
	assert.strictEqual(args[0], '/x/pnpm.mjs', 'pnpm 自身参数排在最前');
	assert.strictEqual(args.includes('add'), true, '用的是 add');
	assert.strictEqual(args.includes('--save-exact'), true, '写精确版本，避免 ^ 范围日后漂移');
	/* 归零开关的写法是「烤肉串」：pnpm 12.3.0 起会静默忽略驼峰写法 */
	assert.strictEqual(args.includes('--config.minimum-release-age=0'), true, '带上一行归零开关');
	assert.strictEqual(RELEASE_AGE_OVERRIDE, '--config.minimum-release-age=0', '开关常量就是烤肉串写法');
	assert.strictEqual(args[args.length - 1], 'dsh-desktop-statusbar@9.9.9', '目标版本在最后');
	/* 绝不能带 @latest：那会被静默降级成旧的成熟版 */
	assert.strictEqual(args.some((one) => one.includes('latest')), false, '绝不出现 latest');
	/* pnpm 11.7.0 的 add 不认 --no-frozen-lockfile（实测报 Unknown option） */
	assert.strictEqual(args.some((one) => one.includes('frozen-lockfile')), false, '不带 pnpm 不认的 frozen-lockfile 选项');
	console.log('参数拼装：' + JSON.stringify(args));

	/* -------------------------------------------- 命令执行与超时 */
	/**
	 * 有些受限执行环境不允许程序用管道捕获子进程输出（Windows 沙箱下
	 * `spawn(..., {stdio:'pipe'})` 会直接 EPERM）。插件跑在 DSH 宿主进程里，
	 * 不受这条限制（官方插件管理器就是用管道捕获 pnpm 输出的）。
	 * 这里探测一下：能跑就跑全部用例，不能跑就明确跳过并说明原因，
	 * 而不是让测试报一个与代码无关的失败。
	 */
	const probe = await runCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: repoRoot, timeoutMs: 15000 });
	const spawnBlocked = probe.exitCode === null && /EPERM|EACCES/.test(probe.stderr);
	if (spawnBlocked === true) {
		console.log('跳过子进程用例：当前执行环境不允许管道捕获子进程输出（EPERM），');
		console.log('  这是沙箱边界，不是插件问题；插件在 DSH 宿主进程里不受此限制。');
	}
	if (spawnBlocked !== true) {
		const okRun = await runCommand(process.execPath, ['-e', 'console.log("hi")'], { cwd: repoRoot, timeoutMs: 15000 });
		assert.strictEqual(okRun.exitCode, 0, '正常命令退出码 0');
		assert.ok(okRun.stdout.includes('hi'), '拿得到 stdout');
		const failRun = await runCommand(process.execPath, ['-e', 'process.exit(3)'], { cwd: repoRoot, timeoutMs: 15000 });
		assert.strictEqual(failRun.exitCode, 3, '非零退出码被如实带回');
		/* 不存在的命令要变成结构化结果，不能把异常抛出去 */
		const missingRun = await runCommand('definitely-not-a-real-command-xyz', [], { cwd: repoRoot, timeoutMs: 5000 });
		assert.strictEqual(missingRun.exitCode, null, '命令不存在时退出码为 null');
		assert.ok(missingRun.stderr.length > 0, '带回了错误信息');
		console.log('命令执行：成功 / 非零退出 / 命令不存在 都变成结构化结果');
	}

	/* -------------------------------------------------- 并发保护 */
	if (ONLINE !== true || spawnBlocked === true) {
		if (ONLINE === true && spawnBlocked === true) {
			console.log('\n在线用例需要能捕获子进程输出，已被环境挡住 —— 未执行真实安装。');
			console.log('SELF-UPDATE OFFLINE CHECKS PASSED (online skipped: 环境不允许 spawn 管道)');
			return;
		}
		console.log('\n离线用例全部通过（加 --online 再跑真实的 pnpm 安装）');
		console.log('SELF-UPDATE OFFLINE CHECKS PASSED');
		return;
	}

	/* ============================ 以下需要联网 ============================ */

	/* 建一个临时 profile，把本插件当前源码复制成「已安装」的样子，
	   并把发布年龄限制设到极大 —— 任何版本都「太新」，只有我们的豁免能救。 */
	const profile = mkdtempSync(join(tmpdir(), 'dsb-profile-'));
	const liveDir = join(profile, 'node_modules', 'dsh-desktop-statusbar');
	try {
		mkdirSync(liveDir, { recursive: true });
		/* 只复制更新流程真正需要的东西 */
		writeFileSync(join(liveDir, 'package.json'), JSON.stringify({
			name: 'dsh-desktop-statusbar',
			version: '0.0.1',            // 故意写成一个很旧的版本，好让「更新」有目标
			type: 'module',
			main: './lib/index.js'
		}, null, 2), 'utf8');
		cpSync(join(repoRoot, 'lib'), join(liveDir, 'lib'), { recursive: true });

		writeFileSync(join(profile, 'package.json'), JSON.stringify({
			name: 'dsb-test-profile',
			private: true,
			version: '0.0.0',
			dependencies: { 'dsh-desktop-statusbar': '0.0.1' }
		}, null, 2), 'utf8');
		/* 关键：把门槛设到任何已发布版本都不满足 —— 不写豁免就必然失败 */
		writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nminimumReleaseAge: 1000000000\n', 'utf8');

		/* 用真 pnpm。优先宿主随包提供的那个（与官方插件安装同版本），
		   取不到就退回 PATH 上的 pnpm。 */
		const host = resolvePnpm();
		const pnpmBin = host === null
			? null
			: (host.electron === true ? host.args[0] : null);
		const runner = pnpmBin !== null
			? { command: process.execPath, args: [pnpmBin] }
			: { command: 'pnpm', args: [] };
		console.log('\n使用的 pnpm：' + runner.command + ' ' + runner.args.join(' '));

		/* 先确认「不写豁免」确实会失败 —— 这是本修复存在的理由，必须亲眼看到 */
		const before = await runCommand(runner.command, [...runner.args, 'add', 'dsh-desktop-statusbar@2.1.1', '--dir', profile], {
			cwd: profile, timeoutMs: 180000
		});
		const beforeOutput = before.stdout + before.stderr;
		assert.notStrictEqual(before.exitCode, 0, '没有豁免时，超出发布年龄的版本必须安装失败（否则测试前提不成立）');
		assert.strictEqual(isReleaseAgeBlocked(beforeOutput), true, '失败原因确实是发布年龄，而不是别的问题');
		console.log('前提验证：不写豁免 → 安装被发布年龄拦下（这正是要修的问题）');

		/* 现在走我们的更新流程：应当自动写豁免并装上 */
		const result = await selfUpdateOnce({
			selfDir: liveDir,
			version: '2.1.1',
			logger: (message) => console.log('  [host] ' + message),
			timeoutMs: 180000
		});
		console.log('更新结果：' + JSON.stringify(result));
		assert.strictEqual(result.ok, true, '更新成功：' + JSON.stringify(result));
		assert.strictEqual(result.changedExclude, true, '确实写了发布年龄豁免');

		/* 盘上真的换成了新版本 */
		assert.strictEqual(installedVersion(liveDir), '2.1.1', '磁盘上的插件版本已更新');
		/* profile 清单也跟上了（走 pnpm 而不是手改文件，就是为了这个一致性） */
		const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
		assert.strictEqual(manifest.dependencies['dsh-desktop-statusbar'], '2.1.1', 'profile 清单同步到新版本');
		/* 豁免写进了 profile，且是一个合法块 */
		const workspace = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8');
		assert.ok(workspace.includes('minimumReleaseAgeExclude:'), '豁免块已写入');
		assert.ok(workspace.includes('dsh-desktop-statusbar@2.1.1'), '放行的正是我们请求的版本');
		console.log('端到端：2.1.1 真的装上了，profile 清单与豁免表都同步');

		/* 幂等：再来一次不该出错（已经是这个版本） */
		const again = await selfUpdateOnce({ selfDir: liveDir, version: '2.1.1', timeoutMs: 180000 });
		console.log('重复更新：' + JSON.stringify({ ok: again.ok, reason: again.reason }));
		assert.strictEqual(again.ok, true, '重复请求同一版本仍是成功，不报错');

		/* 并发保护：手动占住 running，第二次请求应当直接被挡回 */
		assert.strictEqual(isUpdating(), false, '空闲时不在更新中');
		const first = selfUpdateOnce({ selfDir: liveDir, version: '2.1.1', timeoutMs: 180000 });
		assert.strictEqual(isUpdating(), true, '发起后进入更新中');
		const second = await selfUpdateOnce({ selfDir: liveDir, version: '2.1.1', timeoutMs: 180000 });
		assert.strictEqual(second.busy, true, '并发请求被挡回并标记 busy');
		assert.strictEqual(second.reason, 'busy', '给出 busy 原因');
		await first;
		assert.strictEqual(isUpdating(), false, '跑完后回到空闲');
		assert.ok(lastUpdateResult() !== null, '留下了最近一次结果供界面展示');
		console.log('并发保护：同时只允许一个更新在跑');

		console.log('\nSELF-UPDATE ONLINE CHECKS PASSED');
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
})().catch((error) => {
	console.error('SELF-UPDATE CHECKS FAILED:', error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
