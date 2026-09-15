/**
 * 把已安装的插件源码同步进项目（改完插件跑一次，再跑 tests/）。
 * 用法：node tools/sync-from-plugin.js
 * 只同步 lib/ 下的两个源文件；项目的 package.json 有自己的元数据，不覆盖。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = path.join(os.homedir(), '.dsh', 'local-plugins', 'dsh-desktop-statusbar');
const PROJECT = path.join(__dirname, '..');
const FILES = ['lib/client.js', 'lib/index.js'];

let changed = 0;
FILES.forEach((rel) => {
	const from = path.join(PLUGIN, rel);
	const to = path.join(PROJECT, rel);
	if (fs.existsSync(from) !== true) {
		console.log('× 找不到插件文件：' + from);
		process.exitCode = 1;
		return;
	}
	const before = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
	const now = fs.readFileSync(from, 'utf8');
	if (before === now) {
		console.log('= ' + rel + '（一致）');
		return;
	}
	fs.writeFileSync(to, now, 'utf8');
	changed += 1;
	console.log('→ ' + rel + ' 已更新');
});

console.log('');
console.log(changed === 0 ? '项目已是最新' : '同步了 ' + changed + " 个文件；接着跑：node tests/verify.js");
