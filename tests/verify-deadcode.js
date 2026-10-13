/**
 * 死代码常驻检查：i18n 键 / 函数 / CSS 类都必须有人用。
 * 用法：node verify-deadcode.js；退出码 0 = 干净，1 = 有残留（列出名字）。
 *
 * 判据必须跟着**实际写法**走，否则"绿了"只说明判据没看全，不代表代码干净。
 * 2026-10 修过三处覆盖缺口（当时实测数据）：
 *   1. client.js 只认两 tab 缩进的 `function` ⇒ 漏掉 7 个三 tab 的嵌套函数
 *      （addModel/removeModel/startEdit/cancelEdit/setDraftValue/setDraftTiered/saveDraft）。
 *   2. index.js 只认行首 `function`/`export function` ⇒ 漏掉 13 个 `async function`
 *      （resolveAdapterKey/queryWithAdapter/queryAccountBalance/probeLocalRoute/queryLocalAdapter/
 *      queryBalance/subagentIndexSnapshot/collectSubagentUsageNow/backfillUnpriced/collectIntoLedger/
 *      refreshWeekUsage/fetchHolidayDays/checkLatestVersion）。
 *   3. CSS 只认 `className: ?"字面量"` ⇒ JSX→样式方向只覆盖 86/110 类（78%）；
 *      拼接（`"dsb-heat-pad" + (...)`）、三元（`wide ? "a b c" : "a b"`）、
 *      `classList.add("dsb-on")`、`pill.className = "dsb-nav-pill"` 全都不在判据内。
 * 修完函数覆盖 150（client）/ 104（host），CSS 覆盖 110/110。
 */
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');
/* 用 path.join 拼，不要手写 '\\' —— 那样在 Linux/macOS 上会读不到文件，
   检查器会静默退出 1（"读不到" 被当成失败），排查起来很费时间。 */
const client = fs.readFileSync(path.join(LIB, 'client.js'), 'utf8');
const host = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');

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

/* 2. 函数：定义之外还要被调用。
   判据 `^[ \t]*(?:export\s+)?(?:async\s+)?function <name>(` —— 缩进用 [ \t]* 而不是写死 tab 数、
   前缀吃下 export/async，覆盖**任意缩进层级 + 嵌套 + 具名导出 + 异步**的实际写法，
   同时仍锚在行首（前导只有空白），不会把 `a.function(` 之类误抓成语义定义。 */
const fnRe = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\(/gm;
const fns = [];
let hit = null;
while ((hit = fnRe.exec(client)) !== null) fns.push(hit[1]);
const deadFns = fns.filter((fn) => (client.match(new RegExp('\\b' + fn + '\\b', 'g')) || []).length <= 1);
report(deadFns.length === 0, 'client 函数 ' + fns.length + ' 个，没人调用的：' + (deadFns.length === 0 ? '无' : deadFns.join(', ')));

/* 同一套判据用在新文件上：必须重新 new 一个 RegExp 实例，不能共用上面那个带 `g` 的对象
   （`g` 正则会记住 lastIndex，跨文件复用极易悄悄漏扫）。 */
const hostFns = [];
const hostRe = new RegExp(fnRe.source, fnRe.flags);
while ((hit = hostRe.exec(host)) !== null) hostFns.push(hit[1]);
const deadHost = hostFns.filter((fn) => (host.match(new RegExp('\\b' + fn + '\\b', 'g')) || []).length <= 1);
report(deadHost.length === 0, 'host 函数 ' + hostFns.length + ' 个，没人调用的：' + (deadHost.length === 0 ? '无' : deadHost.join(', ')));

/* 3. CSS：每个类都要在 JSX 里出现，JSX 用到的每个类也都要有样式 */
const cssStart = client.indexOf('\t\tconst CSS = [');
const cssEnd = client.indexOf('].join("");', cssStart);
const css = client.slice(cssStart, cssEnd);
const jsx = client.slice(0, cssStart) + client.slice(cssEnd);
const classes = new Set();
/* 字符集带上 `_`：现有 110 个类全是 [a-z0-9-]，加 `_` 不改变任何一个结果；
   但漏掉 `_` 时，`dsb-foo_bar` 这种类会在**取用侧与样式侧同时被静默丢弃**——
   两边都看不见，等于该类彻底脱离判据（实测：注入 `className: x ? "dsb-__probe" : ""`
   两边都不报，是"绿了但没看全"）。带上 `_` 后这类会如实报"缺样式"。 */
const classRe = /\.(dsb-[A-Za-z0-9_-]+)/g;
while ((hit = classRe.exec(css)) !== null) classes.add(hit[1]);

/* 取用侧：**所有字符串字面量**（双引号/单引号/反引号）里的 dsb-* 分词都算引用，
   不再只认 `className:` 紧跟字面量那一种写法。覆盖：
     · className: "a b"                    （原判据唯一认得的一种）
     · className: wide ? "a b c" : "a b"   （三元，原来是盲区）
     · "a " + cls                          （拼接，原来只有 -数字 后缀才有前缀兜底）
     · classList.add("dsb-on") / pill.className = "dsb-nav-pill"（赋值/命令式，原是盲区）
   为什么放宽到"任意字面量"是安全的、且真正堵住漏洞：类名一律以 `dsb-` 开头、
   全文件独此一家，别处几乎不会出现这个前缀；反过来若某类只被 `className:字面量` 形式引用，
   放宽前就是漏判死代码（假绿），放宽后不会。 */
const used = new Set();
/* 以 `-` 结尾的字面量是**动态类名的前缀**（实测只有 `"dsb-heat-" + scale(total) + shade`
   这一处）：它本身不是类名，但把 `dsb-heat-` 打头的类标成"已用"是正确推断
   （后缀由代码算出，静态看不见；前缀有字面量即视为已用）。 */
const dynamicPrefixes = new Set();
const literalRe = /["'`]([^"'`]*)["'`]/g;
while ((hit = literalRe.exec(jsx)) !== null) {
	hit[1].split(/[\s+]/).forEach((part) => {
		if (part.indexOf('dsb-') !== 0) return;
		if (/^dsb-[A-Za-z0-9_-]+$/.test(part) !== true) return;
		if (part.slice(-1) === '-') dynamicPrefixes.add(part);
		else used.add(part);
	});
}
const unusedCss = Array.from(classes).filter((name) => {
	if (used.has(name)) return false;
	const prefix = name.replace(/-\d+$/, '-');
	return dynamicPrefixes.has(prefix) !== true;
});
report(unusedCss.length === 0, 'CSS 类 ' + classes.size + ' 个，没用到的：' + (unusedCss.length === 0 ? '无' : unusedCss.join(', ')));

const classList = Array.from(classes);
const missingStyle = Array.from(used).filter((name) => classList.indexOf(name) < 0);
report(missingStyle.length === 0, 'JSX 用到的类 ' + used.size + ' 个，缺样式的：' + (missingStyle.length === 0 ? '无' : missingStyle.join(', ')));
/* 前缀反查：拼接出来的前缀若在 CSS 里一个类都以它打头，说明拼接的类名根本不存在（写错或已删样式） */
const missingPrefix = Array.from(dynamicPrefixes).filter((prefix) => classList.some((name) => name.indexOf(prefix) === 0) !== true);
report(missingPrefix.length === 0, '拼接的类前缀 ' + dynamicPrefixes.size + ' 个，CSS 里一个都没匹配上的：' + (missingPrefix.length === 0 ? '无' : missingPrefix.join(', ')));

console.log('');
console.log(bad === 0 ? 'DEAD CODE CHECKS PASSED' : bad + ' 项未通过');
process.exit(bad === 0 ? 0 : 1);
