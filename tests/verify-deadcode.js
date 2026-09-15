/**
 * 死代码常驻检查：i18n 键 / 顶层函数 / CSS 类都必须有人用。
 * 用法：node verify-deadcode.js；退出码 0 = 干净，1 = 有残留（列出名字）。
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
const client = fs.readFileSync(LIB + '\\client.js', 'utf8');
const host = fs.readFileSync(LIB + '\\index.js', 'utf8');

let bad = 0;
const report = (ok, message) => {
	if (ok !== true) bad += 1;
	console.log((ok === true ? '= ' : '× ') + message);
};

/** `const <name> = {` 到 `};` 之间的键名 */
function tableKeys(text, name) {
	const start = text.indexOf('\t\tconst ' + name + ' = {');
	if (start < 0) return null;
	const end = text.indexOf('\n\t\t};', start);
	const keys = [];
	text.slice(start, end).split('\n').forEach((line) => {
		const hit = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
		if (hit !== null) keys.push(hit[1]);
	});
	return keys;
}

/* 1. i18n：中英对称，且每个键都至少被引用一次 */
const zh = tableKeys(client, 'zh');
const en = tableKeys(client, 'en');
report(zh !== null && en !== null, '词表可解析（zh ' + (zh === null ? '缺失' : zh.length) + ' 键 / en ' + (en === null ? '缺失' : en.length) + ' 键）');
if (zh !== null && en !== null) {
	const unused = zh.filter((key) => (client.match(new RegExp('"' + key + '"', 'g')) || []).length === 0);
	report(unused.length === 0, '未引用的文案键：' + (unused.length === 0 ? '无' : unused.join(', ')));
	const onlyZh = zh.filter((k) => en.indexOf(k) === -1);
	const onlyEn = en.filter((k) => zh.indexOf(k) === -1);
	report(onlyZh.length === 0 && onlyEn.length === 0,
		'中英键一致' + (onlyZh.length + onlyEn.length === 0 ? '' : '（仅中文 ' + onlyZh.join(',') + '；仅英文 ' + onlyEn.join(',') + '）'));
}

/* 2. 顶层函数：定义之外还要被调用 */
const fnRe = /^\t\tfunction ([A-Za-z_$][A-Za-z0-9_$]*)\(/gm;
const fns = [];
let hit = null;
while ((hit = fnRe.exec(client)) !== null) fns.push(hit[1]);
const deadFns = fns.filter((fn) => (client.match(new RegExp('\\b' + fn + '\\b', 'g')) || []).length <= 1);
report(deadFns.length === 0, 'client 顶层函数 ' + fns.length + ' 个，没人调用的：' + (deadFns.length === 0 ? '无' : deadFns.join(', ')));

const hostFns = [];
const hostRe = /^(?:export )?function ([A-Za-z_$][A-Za-z0-9_$]*)\(/gm;
while ((hit = hostRe.exec(host)) !== null) hostFns.push(hit[1]);
const deadHost = hostFns.filter((fn) => (host.match(new RegExp('\\b' + fn + '\\b', 'g')) || []).length <= 1);
report(deadHost.length === 0, 'host 顶层函数 ' + hostFns.length + ' 个，没人调用的：' + (deadHost.length === 0 ? '无' : deadHost.join(', ')));

/* 3. CSS：每个类都要在 JSX 里出现，JSX 用到的每个类也都要有样式 */
const cssStart = client.indexOf('\t\tconst CSS = [');
const cssEnd = client.indexOf('].join("");', cssStart);
const css = client.slice(cssStart, cssEnd);
const jsx = client.slice(0, cssStart) + client.slice(cssEnd);
const classes = new Set();
const classRe = /\.(dsb-[a-z0-9-]+)/g;
while ((hit = classRe.exec(css)) !== null) classes.add(hit[1]);
const unusedCss = Array.from(classes).filter((name) => (jsx.match(new RegExp(name, 'g')) || []).length === 0);
report(unusedCss.length === 0, 'CSS 类 ' + classes.size + ' 个，没用到的：' + (unusedCss.length === 0 ? '无' : unusedCss.join(', ')));

const used = new Set();
const useRe = /className: ?"([^"]+)"/g;
while ((hit = useRe.exec(jsx)) !== null) {
	hit[1].split(' ').forEach((part) => { if (part.indexOf('dsb-') === 0) used.add(part); });
}
const missingStyle = Array.from(used).filter((name) => classes.has(name) !== true);
report(missingStyle.length === 0, 'JSX 用到的类 ' + used.size + ' 个，缺样式的：' + (missingStyle.length === 0 ? '无' : missingStyle.join(', ')));

console.log('');
console.log(bad === 0 ? 'DEAD CODE CHECKS PASSED' : bad + ' 项未通过');
process.exit(bad === 0 ? 0 : 1);
