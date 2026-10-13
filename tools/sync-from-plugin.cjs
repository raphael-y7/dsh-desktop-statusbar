/**
 * 把已安装的插件源码同步进项目（改完插件跑一次，再跑 tests/）。
 * 用法：node tools/sync-from-plugin.cjs
 *
 * **文件清单自动扫描**，不写死。原先只列了四个文件，插件目录里新增的模块
 * （self-update.js / release-age.js）不会被搬回项目 —— 于是"插件里改了、项目里没有"，
 * 下次用 sync-to-plugin.cjs 推回去时又把改动覆盖掉。现在按插件目录的 `lib/*.js` 逐个搬。
 *
 * 只同步 lib/ 下的源码；项目的 package.json 有自己的元数据，不覆盖。
 * 插件目录由 tools/plugin-dir.cjs 自动定位（换机器/换用户名都不必改代码）：
 * 可用环境变量 DSH_STATUS_BAR_PLUGIN_DIR 显式指定。
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..');
const pluginRoot = require('./plugin-dir.cjs').pluginDir();
if (pluginRoot === null) {
  console.log('× 找不到已安装的插件目录：请设置 DSH_STATUS_BAR_PLUGIN_DIR 指向它，');
  console.log('  或把 tools/ 放在插件目录里运行。');
  process.exit(1);
}
const PLUGIN = pluginRoot;

/* 自动列出插件目录里的全部源文件，而不是写死一份清单 */
const sources = fs.readdirSync(path.join(PLUGIN, 'lib'))
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => 'lib/' + name);

let changed = 0;
sources.forEach((rel) => {
	const from = path.join(PLUGIN, rel);
	const to = path.join(PROJECT, rel);
	const before = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
	const now = fs.readFileSync(from, 'utf8');
	if (before === now) {
		console.log('= ' + rel + '（一致）');
		return;
	}
	fs.writeFileSync(to, now, 'utf8');
	changed += 1;
	console.log('→ ' + rel + ' 已更新' + (before === null ? '（项目原先没有）' : ''));
});

console.log('');
console.log(changed === 0
	? '项目已是最新（' + sources.length + ' 个源文件）'
	: '同步了 ' + changed + ' / ' + sources.length + ' 个文件；接着跑：node tools/test.cjs');
