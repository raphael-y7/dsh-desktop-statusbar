/**
 * 发布一致性检查：版本号三处一致、打包清单与运行时入口完整。
 *
 * 为什么单独一条：插件没有构建步骤，`lib/*.js` 就是发布源码，版本号散落在
 * package.json、package-lock.json 与 client.js 的 VERSION 常量里。漏改一处，
 * 症状各不相同 —— 包版本对不上（npm 上显示旧版本）、自检提示「发现新版本」却
 * 装不上、锁文件与包描述漂移。对照历史发布踩过的坑，这里一次性钉死。
 *
 * 检查项：
 *   ① package.json 的版本号格式合法；
 *   ② package.json 的 version = lib/client.js 里的 `const VERSION`（只能有一处）；
 *   ③ package-lock.json 顶层与 `packages[""]` 的 version 都等于 package.json，
 *      且锁文件里的直接依赖与 package.json 一致（防止「顺手动了依赖」）；
 *   ④ `files` 清单列出的每个路径都真实存在；
 *   ⑤ 运行时必需文件齐全：main / exports / icon / cordis.patch.yml / 两种语言词表；
 *   ⑥ lib 里的相对导入目标都在（没有构建步骤，少一个文件就是启动即崩）；
 *   ⑦ 两个 README 引用的 docs 截图都存在（避免发布页图裂）；
 *   ⑧ 版本适配声明：顶层 `engines.dsh` 是「单下界、无上界」的合法 semver range
 *      （未来版本照样可装），且没有 `@deepseek-ai/dsh` 的 peerDependencies。
 *
 * 用法：node tests/verify-release.js；退出码 0 = 全部一致。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/**
 * 极简 semver 解析：只认 `x.y.z` 或 `x.y.z-pre`。
 * 不引第三方包：这条测试要能在离线环境用普通 node 直接跑。
 */
function parseSemver(text) {
	const hit = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
	if (hit === null) return null;
	return {
		major: Number(hit[1]),
		minor: Number(hit[2]),
		patch: Number(hit[3]),
		pre: hit[4] === undefined ? null : hit[4].split('.')
	};
}

/** 比较两个已解析版本：a 大于 b 返回正数、相等 0、小于负数（预发布版小于同号正式版）。 */
function compareSemver(a, b) {
	const core = ['major', 'minor', 'patch'];
	for (let i = 0; i < core.length; i += 1) {
		if (a[core[i]] !== b[core[i]]) return a[core[i]] > b[core[i]] ? 1 : -1;
	}
	if (a.pre === null && b.pre === null) return 0;
	/* 正式版 > 同号预发布版 */
	if (a.pre === null) return 1;
	if (b.pre === null) return -1;
	const length = Math.min(a.pre.length, b.pre.length);
	for (let i = 0; i < length; i += 1) {
		const left = a.pre[i];
		const right = b.pre[i];
		const leftNumber = /^\d+$/.test(left);
		const rightNumber = /^\d+$/.test(right);
		if (leftNumber === true && rightNumber === true) {
			if (Number(left) !== Number(right)) return Number(left) > Number(right) ? 1 : -1;
		} else if (leftNumber === true) {
			/* 数字标识的优先级低于字母标识 */
			return -1;
		} else if (rightNumber === true) {
			return 1;
		} else if (left !== right) {
			return left > right ? 1 : -1;
		}
	}
	if (a.pre.length === b.pre.length) return 0;
	return a.pre.length > b.pre.length ? 1 : -1;
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const client = readText(path.join('lib', 'client.js'));

/* 1. 包名与版本号格式 */
assert.strictEqual(pkg.name, 'dsh-desktop-statusbar', '包名必须是 dsh-desktop-statusbar');
assert.ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), 'package.json 版本号不是合法 semver：' + pkg.version);
console.log('package.json 版本:', pkg.version);

/* 2. client.js 的 VERSION 与 package.json 一致。用 VERSION 显示给用户看的地方不止一处
      （设置页脚、版本自检的 current 参数），两处不同步会让自检误报「有新版本」。 */
const versionHits = client.match(/const VERSION = "([^"]+)";/g);
assert.ok(versionHits !== null, 'client.js 里找不到 `const VERSION = "…";`，检查写法是否改了');
assert.strictEqual(versionHits.length, 1, 'client.js 里 `const VERSION` 应只有一处，实际 ' + versionHits.length + ' 处');
const clientVersion = /const VERSION = "([^"]+)";/.exec(client)[1];
assert.strictEqual(clientVersion, pkg.version,
	'版本号不一致：package.json = ' + pkg.version + '，client.js VERSION = ' + clientVersion);
console.log('client.js VERSION 与 package.json 一致');

/* 3. 锁文件：版本与直接依赖都要跟 package.json 对齐 */
assert.strictEqual(lock.name, pkg.name, 'package-lock.json 的 name 与 package.json 不一致');
assert.strictEqual(lock.version, pkg.version, 'package-lock.json 顶层 version 与 package.json 不一致');
assert.ok(lock.packages !== undefined && lock.packages[''] !== undefined, 'package-lock.json 缺 packages[""] 段');
assert.strictEqual(lock.packages[''].version, pkg.version, 'package-lock.json 的 packages[""].version 与 package.json 不一致');
assert.deepStrictEqual(lock.packages[''].dependencies, pkg.dependencies,
	'直接依赖被改动了：package-lock.json 与 package.json 的 dependencies 不一致');
console.log('package-lock.json 版本与依赖一致');

/* 4. `files` 清单：每一项都必须能对应到真实路径（写错名字时 npm 会静默漏包） */
assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json 缺 files 清单');
pkg.files.forEach((entry) => {
	assert.ok(exists(entry), 'files 清单里的路径不存在：' + entry);
});
/* 这几项是发布必需：少任何一个，装完的插件要么缺源码、要么缺说明与图标。
   `tools/` **随包一起发布**（沿用 2.1.2 起的既有行为）：里面的开发脚本
   （`npm test` / `npm run sync` / 截图、插件目录定位）是给想二次开发或本地调试的
   用户准备的，必须能被 `node tools/xxx.cjs` 直接跑到。
   它们是**手动执行**的工具，不会被自动触发（没有 postinstall，也没有任何代码 import 它们）。 */
const REQUIRED_IN_FILES = ['lib', 'tools', 'docs', 'locale', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.en.md', 'LICENSE'];
REQUIRED_IN_FILES.forEach((entry) => {
	assert.ok(pkg.files.includes(entry), 'files 清单缺必需项：' + entry);
});
/* 反面断言：测试目录与临时产物不许进发布包。
   （`tools/` 不在此列 —— 它是有意随包发布的，见上。） */
['tests', 'tests/verify.js', '_diag', 'node_modules'].forEach((entry) => {
	assert.ok(pkg.files.includes(entry) !== true, 'files 清单不该包含这个目录：' + entry);
});
console.log('files 清单:', pkg.files.join(', '));

/* 5. 运行时入口与清单文件：入口指向的文件必须真在包里，且被 files 覆盖 */
const requiredFiles = [
	['main', pkg.main],
	['exports["."]', pkg.exports === undefined ? undefined : pkg.exports['.'] && pkg.exports['.'].default],
	['exports["./client"]', pkg.exports === undefined ? undefined : pkg.exports['./client'] && pkg.exports['./client'].default],
	['icon', pkg.icon],
	['dsh.bundle.patch', pkg.dsh === undefined || pkg.dsh.bundle === undefined ? undefined : pkg.dsh.bundle.patch]
];
requiredFiles.forEach(([name, value]) => {
	assert.ok(typeof value === 'string' && value.length > 0, name + ' 未声明');
	assert.ok(exists(value), name + ' 指向的文件不存在：' + value);
});
/* exports 的 locale 通配指向目录：两种语言词表必须都在 */
['zh', 'en'].forEach((lang) => {
	assert.ok(exists(path.join('locale', lang + '.json')), '缺语言词表 locale/' + lang + '.json');
});
/* client 注入的是宿主包名，不是相对路径 */
assert.ok(pkg.dsh !== undefined && pkg.dsh.client !== undefined && Array.isArray(pkg.dsh.client.inject),
	'package.json 缺 dsh.client.inject');
pkg.dsh.client.inject.forEach((name) => {
	assert.ok(name.indexOf('@deepseek-ai/') === 0, 'dsh.client.inject 应是宿主包名：' + name);
});
console.log('运行时入口与词表齐全');

/* 6. lib 里的相对导入目标都在：插件无构建步骤，漏同步一个文件就是加载失败 */
const IMPORT_PATTERN = /(?:from\s+|import\(\s*|require\(\s*)['"]\.\/([^'"]+\.js)['"]/g;
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).sort();
let importCount = 0;
libFiles.forEach((name) => {
	const code = readText(path.join('lib', name));
	let hit;
	while ((hit = IMPORT_PATTERN.exec(code)) !== null) {
		const target = path.join('lib', hit[1]);
		importCount += 1;
		assert.ok(exists(target), name + ' 引用的 ' + target + ' 不存在（发布包会缺文件）');
	}
	IMPORT_PATTERN.lastIndex = 0;
});
console.log('lib 相对导入全部可达（' + importCount + ' 处）');

/* 7. README 引用的截图都要在：发布页与 npm 页面上图裂很难看，也不容易发现 */
['README.md', 'README.en.md'].forEach((readme) => {
	const text = readText(readme);
	const refs = text.match(/\]\((docs\/[^)]+?\.png)\)/g);
	assert.ok(refs !== null, readme + ' 里没有引用任何 docs 截图（检查图片语法是否改坏）');
	refs.forEach((ref) => {
		const rel = /\]\(([^)]+)\)/.exec(ref)[1];
		assert.ok(exists(rel), readme + ' 引用的截图不存在：' + rel);
	});
});
console.log('README 截图引用全部存在');

/* 8. 版本适配声明：官方只看**顶层** package.json.engines.dsh（semver range、includePrerelease），
      嵌套的 dsh.engines.dsh 官方不读（只有 dshmarket 兜底）。单下界、无上界 = 未来所有版本放行；
      也**不要**给 @deepseek-ai/dsh 声明 peerDependencies —— 那是其它插件安装失败的真因。 */
assert.ok(pkg.engines !== undefined && typeof pkg.engines.dsh === 'string',
	'package.json 缺顶层 engines.dsh（官方只读这一处；缺失等于无约束）');
const dshRange = pkg.engines.dsh.trim();
assert.ok(/^>=\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dshRange),
	'engines.dsh 必须是「单下界、无上界」的 range（形如 >=0.2.0-rc.2），实际：' + dshRange);
const dshLower = parseSemver(dshRange.replace(/^>=\s*/, ''));
assert.ok(dshLower !== null, 'engines.dsh 的下界不是合法 semver：' + dshRange);
/* 假想的未来版本必须满足：没有上界时 99.0.0 一定能装 */
assert.ok(compareSemver({ major: 99, minor: 0, patch: 0, pre: null }, dshLower) >= 0,
	'未来版本 99.0.0 应满足 engines.dsh（声明不能带任何上界）');
assert.strictEqual(
	pkg.peerDependencies === undefined ? undefined : pkg.peerDependencies['@deepseek-ai/dsh'],
	undefined,
	'不要给 @deepseek-ai/dsh 声明 peerDependencies：它会导致其它插件安装失败'
);
console.log('版本适配声明：engines.dsh = ' + dshRange + '（无上界，未来版本可装；无 DSH peerDependencies）');

console.log('发布一致性检查通过');
