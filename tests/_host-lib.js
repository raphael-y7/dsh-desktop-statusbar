/**
 * 测试工具：把 `lib/` 复制到 tests/ 下的临时目录，并 patch 出一份"导出内部符号"的 index.js，
 * 让测试能**直接调用** host 的模块级函数（sanitizePriceBook / pickPriceKey / isPeakTime / ...）。
 *
 * 为什么要复制：`lib/index.js` 有相对导入（`./balance-api.js`、`./holiday.js`），挪到别处就解析不了；
 * 而测试的写范围只允许 `tests/`，所以复制到 `tests/` 下的临时目录，并自带一份
 * `package.json`（`type: module`），免得继承 `tests/package.json` 的 commonjs。
 *
 * 用法：
 *   const source = hostLib.prepare(TMP, ['sanitizePriceBook', 'isPeakTime']);
 *   try { const host = await hostLib.loadHost(source, 'case-1'); ... }
 *   finally { hostLib.cleanup(TMP); }
 *
 * 注意：`loadHost` 的 tag 不同 → 拿到的是**新的模块实例**（模块级缓存如 `extraHolidays`
 * 会重新读盘），用来验"改盘上的文件之后重新加载会怎样"。
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

/** 复制 lib/ 到 dir 并 patch index.js 导出 names；返回 index.js 的绝对路径。 */
function prepare(dir, names) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
	/* 复制 lib 下的**全部**文件，而不是列一份固定清单：index.js 的相对导入会随功能
	   增删（例如自更新用到的 self-update.js / release-age.js）。写死清单时，新加的
	   兄弟文件不会被带上，测试就会以 ERR_MODULE_NOT_FOUND 失败，且报错信息看不出
	   是工具没同步 —— 这条曾经真的踩到过。 */
	for (const entry of fs.readdirSync(LIB, { withFileTypes: true })) {
		if (entry.isFile() !== true || entry.name.endsWith('.js') !== true) continue;
		fs.copyFileSync(path.join(LIB, entry.name), path.join(dir, entry.name));
	}
	let code = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
	code += '\nexport { ' + names.join(', ') + ' };\n';
	const target = path.join(dir, 'index.js');
	fs.writeFileSync(target, code, 'utf8');
	return target;
}

/** 导入 patch 过的 host；tag 不同就是不同模块实例（模块级缓存会重来）。 */
function loadHost(sourcePath, tag) {
	return import('file:///' + sourcePath.replace(/\\/g, '/') + '?tag=' + encodeURIComponent(String(tag)));
}

/** 删掉临时目录。 */
function cleanup(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { prepare: prepare, loadHost: loadHost, cleanup: cleanup };
