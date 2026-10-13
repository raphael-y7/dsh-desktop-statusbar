/**
 * 跑 tests/ 下所有 verify*.js 并汇总结果。
 * 用法：node tools/test.cjs；退出码 0 = 全部通过。
 *
 * 两个刻意的写法（都是踩过坑才改的）：
 *
 * 1. 子进程用 **stdio: 'inherit'**，不用管道捕获。
 *    原先用 `spawnSync(..., { encoding: 'utf8' })`（默认 pipe）在某些受限环境下会直接
 *    EPERM：进程根本没起来，`run.status` 是 null，于是**每个测试都被判失败**，而失败
 *    原因那一栏是空的 —— 看起来像"40 个测试全挂了"，其实一个都没跑。
 *    inherit 让子进程直接写本终端的输出，不受这条限制，失败时也能就地看到完整上下文。
 *
 * 2. 通配符用 `/^verify.*\.js$/`，**显式包含 verify.js**。
 *    如果写成 `verify-*.js`（多个连字符）会漏掉 `verify.js` —— 那是最大的一个测试，
 *    漏跑它时总数看起来"少一个"却不容易察觉。
 *
 * 另加超时：单个测试挂住时不能把整个汇总永久卡住。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'tests');
/* 单测超时（毫秒）：正常都远小于它，只有挂住时才会触发 */
const TIMEOUT_MS = 300000;

const files = fs.readdirSync(DIR).filter((name) => /^verify.*\.js$/.test(name)).sort();

let failed = 0;
for (const name of files) {
	const run = spawnSync(process.execPath, [path.join(DIR, name)], {
		stdio: 'inherit',
		timeout: TIMEOUT_MS,
	});
	if (run.status === 0) {
		console.log('= ' + name + '  通过');
		continue;
	}
	failed += 1;
	/* 失败原因要能一眼看出是什么：超时 / 被信号杀 / 非零退出码 / 进程都没起来。
	   原先只打 stderr 第一行，而 EPERM 那种情况 stderr 是空的，于是什么都没显示。 */
	let why;
	if (run.error !== undefined && run.error !== null) why = '无法启动：' + String(run.error.message);
	else if (run.signal !== null && run.signal !== undefined) why = '被信号终止：' + String(run.signal);
	else if (run.status === null) why = '退出码不可用（很可能超时）';
	else why = '退出码 ' + String(run.status);
	console.log('× ' + name + '  ' + why);
}

console.log('');

/* 一致性守卫：测试跑的都是项目 lib/ 的源码，而 DSH 实际加载的是插件目录那份。
 * 两边不一致（忘了同步）时这里直接判失败，避免"测试全绿但界面上没变化"。
 * 插件目录由 tools/plugin-dir.cjs 自动定位（换机器/换用户名都不必改代码）。
 *
 * 三个修正（原有实现的问题）：
 *   ① 报的是**项目**目录的文件数，文案却写"插件目录已同步" —— 数字对不上实际；
 *      现在报两边各自的数量。
 *   ② 只检查「项目有、插件目录没有」，反向漏了：插件目录多出一个源文件不会被发现。
 *      现在两个方向都比。
 *   ③ 原先不一致时直接 `process.exit(1)`，**在打印测试汇总之前就退出了** ——
 *      于是"同步问题"会把"测试结果"整个吞掉，看到的只是最后那行退出码。
 *      现在记为失败并继续往下打印汇总。 */
const PROJECT_LIB = path.join(__dirname, '..', 'lib');
const pluginRoot = require('./plugin-dir.cjs').pluginDir();
if (pluginRoot === null) {
	console.log('! 找不到已安装的插件目录，跳过一致性检查。');
	console.log('  可用环境变量 DSH_STATUS_BAR_PLUGIN_DIR 指向它，或把 tools/ 放在插件目录里运行。');
} else {
	const PLUGIN_LIB = path.join(pluginRoot, 'lib');
	const projectFiles = fs.readdirSync(PROJECT_LIB).filter((name) => name.endsWith('.js'));
	const pluginFiles = fs.existsSync(PLUGIN_LIB)
		? fs.readdirSync(PLUGIN_LIB).filter((name) => name.endsWith('.js'))
		: [];

	/* 两个方向都看：项目→插件（漏同步）、插件→项目（多出来的） */
	const missingInPlugin = projectFiles.filter((name) => !pluginFiles.includes(name));
	const extraInPlugin = pluginFiles.filter((name) => !projectFiles.includes(name));
	const different = projectFiles.filter((name) => {
		if (!pluginFiles.includes(name)) return false;
		return fs.readFileSync(path.join(PROJECT_LIB, name), 'utf8') !== fs.readFileSync(path.join(PLUGIN_LIB, name), 'utf8');
	});

	const issues = [];
	if (missingInPlugin.length > 0) issues.push('插件目录缺：' + missingInPlugin.join(', '));
	if (extraInPlugin.length > 0) issues.push('插件目录多出：' + extraInPlugin.join(', '));
	if (different.length > 0) issues.push('内容不一致：' + different.join(', '));

	if (issues.length > 0) {
		failed += 1;
		console.log('× 两边源码不一致 —— ' + issues.join('；'));
		console.log('  项目 → 插件：node tools/sync-to-plugin.cjs');
		console.log('  插件 → 项目：node tools/sync-from-plugin.cjs');
	} else {
		console.log('= 插件目录已同步（项目 ' + projectFiles.length + ' 个源文件 / 插件 ' + pluginFiles.length + ' 个，' + pluginRoot + '）');
	}
}
console.log(failed === 0 ? files.length + ' 个测试全部通过' : failed + ' 项失败（含测试与同步检查）');
process.exit(failed === 0 ? 0 : 1);
