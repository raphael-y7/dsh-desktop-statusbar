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
const { join, dirname } = require('path');
const { tmpdir } = require('os');

const ONLINE = process.argv.includes('--online');

(async () => {
	const mod = await import('../lib/self-update.js');
	const {
		installedVersion, resolveSelfDir, resolvePnpm, resolvePnpmDetailed, runCommand,
		isReleaseAgeBlocked, selfUpdateOnce, runSelfUpdate, isUpdating, lastUpdateResult,
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

	/* -------------------------------------------------- pnpm 定位：环境变量覆盖口 */
	/* 注意：这里不依赖任何文件候选的真实布局 —— 全部用注入的 env / execPath / exists，
	   把「环境变量覆盖口」与「文件候选搜索」两件事分开测。 */
	const savedPnpm = process.env.DSH_DESKTOP_STATUSBAR_PNPM;
	const savedHostPnpm = process.env.DSH_DESKTOP_PNPM_ENTRY;
	const fakeExists = (target) => target === '/x/pnpm.mjs';
	try {
		delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = JSON.stringify(['node', '/x/pnpm.mjs']);
		const asArray = resolvePnpm({ env: process.env, execPath: '/host/electron.exe', exists: fakeExists });
		assert.strictEqual(asArray.command, 'node', '数组形式的命令被解析');
		assert.deepStrictEqual(asArray.args, ['/x/pnpm.mjs'], '数组形式的参数被解析');
		assert.strictEqual(asArray.electron, false, '数组形式不标 electron（命令已经不是宿主 exe）');
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = '/usr/bin/pnpm';
		assert.strictEqual(resolvePnpm({ env: process.env, execPath: '/host/electron.exe', exists: fakeExists }).command, '/usr/bin/pnpm', '单路径形式被接受');
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = '[]';
		assert.strictEqual(resolvePnpm({ env: process.env, execPath: '/host/electron.exe', exists: fakeExists }).command, '[]', '空数组退化成当路径处理（不崩）');
		/* 环境变量覆盖口完全不检查文件是否存在（用户显式指定） */
		process.env.DSH_DESKTOP_STATUSBAR_PNPM = '/definitely/not/here/pnpm';
		assert.strictEqual(resolvePnpm({ env: process.env, execPath: '/host/electron.exe', exists: () => false }).command, '/definitely/not/here/pnpm', '覆盖口不检查文件存在性，原样奉还');
		console.log('pnpm 定位：环境变量两种写法都支持，也不检查存在性');
	} finally {
		if (savedPnpm === undefined) delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		else process.env.DSH_DESKTOP_STATUSBAR_PNPM = savedPnpm;
		if (savedHostPnpm === undefined) delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		else process.env.DSH_DESKTOP_PNPM_ENTRY = savedHostPnpm;
	}

	/* ------------------------------------- pnpm 定位：新版主运行时布局（核心修复） */
	/* 用**真临时目录造真文件树**跑一遍真 existsSync，确保「不是只有注入的假 exists 能过」。 */
	const layoutRoot = mkdtempSync(join(tmpdir(), 'dsb-layout-'));
	const layoutResources = join(layoutRoot, 'resources');
	const layoutNode = join(layoutResources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
	const layoutPnpm = join(layoutResources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
	const layoutLegacy = join(layoutResources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
	const layoutAsar = join(layoutResources, 'app.asar.unpacked', 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
	const hostExe = join(layoutRoot, 'DeepSeek Harness.exe');
	try {
		mkdirSync(dirname(layoutNode), { recursive: true });
		mkdirSync(dirname(layoutPnpm), { recursive: true });
		writeFileSync(layoutNode, '', 'utf8');
		writeFileSync(layoutPnpm, '', 'utf8');

		/* 1. 新版布局：找到 pnpm.mjs，且 runner 用同套运行时里的 node.exe，electron === false */
		const fresh = resolvePnpmDetailed({
			env: {},
			execPath: hostExe,
			resourcesPath: layoutResources,
			platform: 'win32',
		});
		assert.strictEqual(fresh.ok, true, '新版布局：primary-runtime 下的 pnpm.mjs 必须被找到');
		assert.strictEqual(fresh.source, 'primary-runtime', '新版布局：来源标为 primary-runtime');
		assert.strictEqual(fresh.runner.command, layoutNode, '新版布局：用同套运行时自带的 node.exe 当 runner，而不是宿主 exe');
		assert.deepStrictEqual(fresh.runner.args, [layoutPnpm], '新版布局：pnpm.mjs 作为唯一参数传入');
		assert.strictEqual(fresh.runner.electron, false, '新版布局：走自带 node.exe 时不该标 electron');
		assert.ok(Array.isArray(fresh.tried), 'tried 始终是数组');
		assert.strictEqual(fresh.tried[0].source, 'primary-runtime', 'tried 第一条就是 primary-runtime（候选顺序最前）');
		assert.strictEqual(fresh.tried[0].path, layoutPnpm, 'tried 记录了 primary-runtime 候选的完整路径');
		assert.strictEqual(fresh.tried[0].note, '命中', '命中的候选 note 写「命中」');

		/* 同一个结果也应由薄包装 resolvePnpm() 给出 */
		const wrapped = resolvePnpm({ env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32' });
		assert.deepStrictEqual(wrapped, fresh.runner, 'resolvePnpm() 是 resolvePnpmDetailed() 的薄包装：拿到同一个 runner');

		/* 2. 同套运行时里没有 node.exe 时，退回宿主 exe + ELECTRON_RUN_AS_NODE
		      （electron 由宿主判定，这里显式注入 true —— 本机普通 node 下默认是 false） */
		const noNode = resolvePnpmDetailed({
			env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32', electron: true,
			exists: (target) => target === layoutPnpm,
		});
		assert.strictEqual(noNode.ok, true, '缺少同套运行时 node.exe 时仍能找到 pnpm');
		assert.strictEqual(noNode.runner.command, hostExe, '缺 node.exe 时退回宿主 exe 当 runner');
		assert.strictEqual(noNode.runner.electron, true, '退回宿主 exe 时 electron 与宿主判定一致（此处注入 true）');
		/* 非 Electron 宿主（普通 node 跑）时退回宿主 exe，electron 就该是 false */
		const noNodePlain = resolvePnpmDetailed({
			env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32', electron: false,
			exists: (target) => target === layoutPnpm,
		});
		assert.strictEqual(noNodePlain.runner.electron, false, '非 Electron 宿主下退回宿主 exe，electron 为 false');

		/* 3. 旧布局向后兼容：runtime/pnpm/bin/pnpm.mjs */
		mkdirSync(dirname(layoutLegacy), { recursive: true });
		writeFileSync(layoutLegacy, '', 'utf8');
		const legacy = resolvePnpmDetailed({ env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32', electron: true });
		assert.strictEqual(legacy.source, 'primary-runtime', '新旧布局同时存在时优先新版布局（顺序在前）');
		rmSync(dirname(layoutNode), { recursive: true, force: true });
		/* 把 primary-runtime 的 pnpm.mjs 也删掉，才是真正的「只有旧布局」 */
		rmSync(dirname(layoutPnpm), { recursive: true, force: true });
		const legacyOnly = resolvePnpmDetailed({ env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32', electron: true });
		assert.strictEqual(legacyOnly.ok, true, '旧布局：runtime/pnpm/bin/pnpm.mjs 仍能被找到（向后兼容）');
		assert.strictEqual(legacyOnly.source, 'runtime-legacy', '旧布局：来源标为 runtime-legacy');
		assert.strictEqual(legacyOnly.runner.command, hostExe, '旧布局：runner 是宿主 exe');
		assert.deepStrictEqual(legacyOnly.runner.args, [layoutLegacy], '旧布局：pnpm.mjs 作为唯一参数传入');
		assert.strictEqual(legacyOnly.runner.electron, true, '旧布局：用宿主 exe 时 electron 与宿主判定一致（注入 true）');

		/* 4. asar-unpacked 老布局也留着 */
		mkdirSync(dirname(layoutAsar), { recursive: true });
		writeFileSync(layoutAsar, '', 'utf8');
		rmSync(join(layoutResources, 'runtime'), { recursive: true, force: true });
		const asarOnly = resolvePnpmDetailed({ env: {}, execPath: hostExe, resourcesPath: layoutResources, platform: 'win32', electron: true });
		assert.strictEqual(asarOnly.ok, true, 'asar-unpacked 老布局仍能被找到');
		assert.strictEqual(asarOnly.source, 'asar-unpacked', '来源标为 asar-unpacked');
		assert.strictEqual(asarOnly.runner.electron, true, 'asar-unpacked：runner 是宿主 exe，electron 与宿主判定一致（注入 true）');

		/* 5. 全都找不到：结构化失败 + 完整 tried，resolvePnpm() 仍是 null */
		const missingRoot = mkdtempSync(join(tmpdir(), 'dsb-missing-'));
		try {
			const missingResources = join(missingRoot, 'resources');
			mkdirSync(missingResources, { recursive: true });
			const missingExec = join(missingRoot, 'host.exe');
			const none = resolvePnpmDetailed({ env: {}, execPath: missingExec, resourcesPath: missingResources, platform: 'win32' });
			assert.strictEqual(none.ok, false, '全都找不到时 ok 为 false');
			assert.strictEqual(none.runner, null, '全都找不到时 runner 为 null');
			assert.strictEqual(none.source, null, '全都找不到时 source 为 null');
			assert.ok(Array.isArray(none.tried), '失败时 tried 仍是数组');
			const sources = none.tried.map((one) => one.source);
			assert.deepStrictEqual(sources, ['primary-runtime', 'runtime-legacy', 'asar-unpacked'], 'tried 覆盖全部三条文件候选且顺序正确');
			assert.strictEqual(none.tried[0].path, join(missingResources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), 'tried[0] 记录 primary-runtime 候选的完整路径');
			assert.strictEqual(none.tried[1].path, join(missingResources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'), 'tried[1] 记录 runtime-legacy 候选的完整路径');
			assert.strictEqual(none.tried[2].path, join(missingResources, 'app.asar.unpacked', 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'), 'tried[2] 记录 asar-unpacked 候选的完整路径');
			assert.ok(none.tried.every((one) => one.note === '不存在'), '没命中的候选 note 全写「不存在」');
			assert.strictEqual(resolvePnpm({ env: {}, execPath: missingExec, resourcesPath: missingResources, platform: 'win32' }), null, '找不到时 resolvePnpm() 仍然返回 null（向后兼容）');

			/* 推断不出 resources 目录时也要留一条说明，不能静默 */
			const noResources = resolvePnpmDetailed({ env: {}, execPath: '', resourcesPath: undefined, platform: 'win32' });
			assert.strictEqual(noResources.ok, false, '推断不出 resources 目录时 ok 为 false');
			assert.ok(noResources.tried.length > 0, '推断不出 resources 目录时也要留下一条尝试记录');
			assert.strictEqual(noResources.tried[0].path, null, '无法推断路径时 path 为 null');
			assert.ok(typeof noResources.tried[0].note === 'string' && noResources.tried[0].note.length > 0, '无法推断路径时 note 有中文说明');
			console.log('pnpm 定位：三候选顺序、失败 tried 完整、无 resources 时留痕');
		} finally {
			rmSync(missingRoot, { recursive: true, force: true });
		}

		/* 6. 环境变量优先级：插件自己的 > 宿主自己的 > 文件候选 */
		mkdirSync(dirname(layoutPnpm), { recursive: true });
		mkdirSync(dirname(layoutNode), { recursive: true });
		writeFileSync(layoutPnpm, '', 'utf8');
		writeFileSync(layoutNode, '', 'utf8');
		writeFileSync(hostExe, '', 'utf8');
		const baseOptions = { execPath: hostExe, resourcesPath: layoutResources, platform: 'win32' };

		/* 两个都设 → custom-env 赢 */
		const both = resolvePnpmDetailed({
			...baseOptions,
			env: { DSH_DESKTOP_STATUSBAR_PNPM: '/custom/pnpm', DSH_DESKTOP_PNPM_ENTRY: layoutPnpm },
		});
		assert.strictEqual(both.source, 'custom-env', '两个环境变量都设时，插件自己的覆盖口优先');
		assert.strictEqual(both.runner.command, '/custom/pnpm', '插件覆盖口的内容原样成为 command');

		/* 只设宿主变量且路径存在 → host-env，command 是 execPath */
		const hostOnly = resolvePnpmDetailed({ ...baseOptions, electron: true, env: { DSH_DESKTOP_PNPM_ENTRY: layoutPnpm } });
		assert.strictEqual(hostOnly.ok, true, '只设宿主变量且路径存在时能找到');
		assert.strictEqual(hostOnly.source, 'host-env', '只设宿主变量时来源标为 host-env');
		assert.strictEqual(hostOnly.runner.command, hostExe, 'host-env：runner 是宿主 execPath');
		assert.deepStrictEqual(hostOnly.runner.args, [layoutPnpm], 'host-env：宿主给出的 pnpm entry 作为参数');
		assert.strictEqual(hostOnly.runner.electron, true, 'host-env：用宿主 exe 时 electron 与宿主判定一致（注入 true）');

		/* 宿主变量指向不存在的路径 → 落到文件候选，并留下一条「不存在」的记录 */
		const hostMissing = resolvePnpmDetailed({ ...baseOptions, env: { DSH_DESKTOP_PNPM_ENTRY: join(layoutRoot, 'nope', 'pnpm.mjs') } });
		assert.strictEqual(hostMissing.source, 'primary-runtime', '宿主变量指向不存在的路径时落到文件候选');
		const hostAttempt = hostMissing.tried.find((one) => one.source === 'host-env');
		assert.ok(hostAttempt !== undefined, '宿主变量指向不存在的路径时，tried 里保留一条 host-env 记录');
		assert.strictEqual(hostAttempt.note, '不存在', '那条 host-env 记录的 note 写「不存在」');

		/* 空白字符串的宿主变量不产生 Attempt */
		const blankHost = resolvePnpmDetailed({ ...baseOptions, env: { DSH_DESKTOP_PNPM_ENTRY: '   ' } });
		assert.strictEqual(blankHost.tried.some((one) => one.source === 'host-env'), false, '宿主变量空白时不产生 host-env 尝试记录');

		/* 空白字符串的插件变量不产生 Attempt，继续往下走 */
		const blankCustom = resolvePnpmDetailed({ ...baseOptions, env: { DSH_DESKTOP_STATUSBAR_PNPM: '  ' } });
		assert.strictEqual(blankCustom.source, 'primary-runtime', '插件覆盖口为空白时不拦截，继续找文件候选');
		assert.strictEqual(blankCustom.tried.some((one) => one.source === 'custom-env'), false, '插件覆盖口为空白时不产生 custom-env 尝试记录');

		/* 非法 JSON 数组退回单路径，并留一条说明 */
		const badJson = resolvePnpmDetailed({ ...baseOptions, env: { DSH_DESKTOP_STATUSBAR_PNPM: '[not json' } });
		assert.strictEqual(badJson.source, 'custom-env', '非法 JSON 数组时退回单路径（仍算 custom-env 命中）');
		assert.strictEqual(badJson.runner.command, '[not json', '非法 JSON 数组时把原文当单路径');
		const badJsonAttempt = badJson.tried.find((one) => one.source === 'custom-env');
		assert.ok(badJsonAttempt !== undefined && typeof badJsonAttempt.note === 'string', '非法 JSON 数组时留下一条说明记录');
		console.log('pnpm 定位：环境变量优先级 自定义 > 宿主 > 文件候选，空白与非法输入都留痕');

		/* 7. resourcesPath 与 execPath 推断：显式 resourcesPath 优先，缺了才退回 dirname(execPath) */
		const inferred = resolvePnpmDetailed({ env: {}, execPath: join(layoutRoot, 'host', 'DeepSeek Harness.exe'), platform: 'win32' });
		assert.strictEqual(inferred.ok, false, 'execPath 推断出的 resources 下没有文件时找不到');
		assert.strictEqual(inferred.tried[0].path, join(layoutRoot, 'host', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), '没有 resourcesPath 时用 dirname(execPath)/resources 推断');
		const explicitWins = resolvePnpmDetailed({ env: {}, execPath: join(layoutRoot, 'host', 'DeepSeek Harness.exe'), resourcesPath: layoutResources, platform: 'win32' });
		assert.strictEqual(explicitWins.ok, true, '显式 resourcesPath 优先于 execPath 推断');
		assert.strictEqual(explicitWins.runner.command, layoutNode, '按显式 resourcesPath 找到同套运行时的 node.exe');
	} finally {
		rmSync(layoutRoot, { recursive: true, force: true });
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

	/* ------------------------------- 失败信息要落到 runSelfUpdate 的结果里 */
	/**
	 * 用户体验的要求：更新失败时不能只报一句「pnpm-not-found」，
	 * 得把「试过哪些路径」一起带回界面/日志，否则下次排查还得手工逐条 Test-Path。
	 *
	 * 造法：把 resources 指到一个空目录、清掉两个环境变量，pnpm 必然找不到；
	 * profile 查找放在 pnpm 之后，所以会精确地失败在 pnpm 这一步，不会走到安装。
	 */
	const noPnpmRoot = mkdtempSync(join(tmpdir(), 'dsb-nopnpm-'));
	const savedCustom = process.env.DSH_DESKTOP_STATUSBAR_PNPM;
	const savedHost = process.env.DSH_DESKTOP_PNPM_ENTRY;
	const savedExecPath = process.execPath;
	const savedResourcesPath = process.resourcesPath;
	try {
		const emptyResources = join(noPnpmRoot, 'resources');
		const fakeHost = join(noPnpmRoot, 'host.exe');
		mkdirSync(emptyResources, { recursive: true });
		writeFileSync(fakeHost, '', 'utf8');
		mkdirSync(join(noPnpmRoot, 'lib'), { recursive: true });
		writeFileSync(join(noPnpmRoot, 'lib', 'self-update.js'), '/* 占位 */', 'utf8');
		writeFileSync(join(noPnpmRoot, 'package.json'), JSON.stringify({
			name: 'dsh-desktop-statusbar', version: '0.0.1', type: 'module'
		}, null, 2), 'utf8');

		/* 真实的 resolvePnpm 读 process.execPath / process.env，所以这里改写环境。
		   execPath 在 Node 里可写（descriptor 是 writable），改完在 finally 里还原。 */
		delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		process.execPath = fakeHost;
		/* process.resourcesPath 在普通 node 里不存在；显式设成空目录，挡住真实布局 */
		Object.defineProperty(process, 'resourcesPath', { value: emptyResources, configurable: true, writable: true });

		const detail = resolvePnpmDetailed();
		assert.strictEqual(detail.ok, false, '前置：这个环境里 pnpm 确实找不到');
		assert.ok(detail.tried.length > 0, '前置：找不到时 tried 非空');

		const failResult = await runSelfUpdate({ selfDir: noPnpmRoot, version: '9.9.9' });
		assert.strictEqual(failResult.ok, false, 'pnpm 找不到时更新必须失败');
		assert.strictEqual(failResult.reason, 'pnpm-not-found', '失败原因如实写 pnpm-not-found');
		assert.ok(Array.isArray(failResult.tried), 'result.tried 必须是数组（供界面/日志展示试过的路径）');
		assert.ok(failResult.tried.length > 0, 'result.tried 不能为空，否则等于没给排查线索');
		assert.ok(failResult.tried.every((one) => typeof one === 'string'), 'result.tried 每条都是字符串（已格式化好）');
		assert.ok(failResult.tried.some((one) => one.includes('primary-runtime')), 'result.tried 里能看到 primary-runtime 候选');
		assert.ok(failResult.tried.some((one) => one.includes('runtime-legacy')), 'result.tried 里能看到 runtime-legacy 候选');
		assert.ok(failResult.tried.some((one) => one.includes('asar-unpacked')), 'result.tried 里能看到 asar-unpacked 候选');
		console.log('失败信息：runSelfUpdate 的 result.tried 带上全部候选（' + failResult.tried.length + ' 条）');
	} finally {
		/* 无论断言成败都要把进程级状态还原，避免污染后续用例 */
		process.execPath = savedExecPath;
		if (savedResourcesPath === undefined) delete process.resourcesPath;
		else Object.defineProperty(process, 'resourcesPath', { value: savedResourcesPath, configurable: true, writable: true });
		if (savedCustom === undefined) delete process.env.DSH_DESKTOP_STATUSBAR_PNPM;
		else process.env.DSH_DESKTOP_STATUSBAR_PNPM = savedCustom;
		if (savedHost === undefined) delete process.env.DSH_DESKTOP_PNPM_ENTRY;
		else process.env.DSH_DESKTOP_PNPM_ENTRY = savedHost;
		rmSync(noPnpmRoot, { recursive: true, force: true });
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
