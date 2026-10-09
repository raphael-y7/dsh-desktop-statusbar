/**
 * 防回归：跟手浮层必须自带字号（不能依赖 .dsb-settings 继承）。
 *
 * 背景（用户截图确认的真实 bug，2026-10-09）：设置页按住拖动手柄时，跟手浮层里的**字变大**。
 * 根因：浮层被 portal 到 body 之后，不再是 `.dsb-settings` 的后代，而面板的 14px 是设在
 * `.dsb-settings` 容器上的 —— 浮层继承不到，掉回 body 的 16px。
 * 修法：`.dsb-drag-card` 自己写死 `font-size`；`user-select` 同理（面板那一边是关在
 * `.dsb-row` 上的，浮层里没有 `.dsb-row` 这一层）。
 *
 * 本脚本只读 lib/client.js 的样式文本（沿用 tests/verify-copy.js 读 CSS 的手法），
 * 不需要真实浏览器。三件事：
 *   1) `.dsb-drag-card` 必须**显式**有 font-size 与 user-select:none；
 *   2) 面板侧 9 组选择器与浮层侧逐条比对，核心声明必须一致（portal 后得各留一份）；
 *   3) 浮层字号必须与 `.dsb-settings` 的字号**同值**（改一处忘另一处就红），并把
 *      `.dsb-settings` 上所有会被继承的属性都按"必须镜像"处理。
 * 另外做一次扫描，把"面板有、浮层没跟上"的差异列出来（只报告，不改 lib）。
 *
 * 用法：node tests/verify-drag-card.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const raw = fs.readFileSync(PLUGIN, 'utf8');

/* 把 `const CSS = [ ... ].join("");` 里的规则抽成 { 选择器: 声明串 }。
   规则一行一条：含 content:"" 的那条用单引号包，其余用双引号包。 */
function readRules() {
	const start = raw.indexOf('\t\tconst CSS = [');
	assert.ok(start >= 0, 'lib/client.js 里找不到 `const CSS = [`');
	const end = raw.indexOf('].join("");', start);
	assert.ok(end > start, 'CSS 数组没有 `].join("");` 结尾');
	const rules = new Map();
	raw.slice(start, end).split('\n').forEach((line) => {
		const text = line.trim().replace(/,$/, '');
		const quote = text[0];
		if (quote !== '"' && quote !== "'") return;
		if (text[text.length - 1] !== quote) return;
		const body = text.slice(1, -1);
		const brace = body.indexOf('{');
		if (brace < 0 || body[body.length - 1] !== '}') return;
		rules.set(body.slice(0, brace).trim(), body.slice(brace + 1, -1));
	});
	return rules;
}

const RULES = readRules();
assert.ok(RULES.size > 50, 'CSS 规则解析出来的条数太少（' + RULES.size + '），解析大概失效了');

const declsOf = (selector) => {
	assert.ok(RULES.has(selector), '样式里找不到规则 ' + selector);
	return RULES.get(selector);
};
/** 取某条规则里某个属性的值；没有这个属性返回 null。 */
function valueOf(selector, prop) {
	const hit = new RegExp('(?:^|;)' + prop + ':([^;]+)').exec(declsOf(selector));
	return hit === null ? null : hit[1];
}

/* ============================================================ 1. 浮层根规则自带字号 */
/* 为什么必须"显式"：浮层 portal 到 body 后继承链断了，`.dsb-settings` 上那份 14px 传不过来，
   不写就会掉回 body 的 16px（字突然变大的那个 bug）。user-select 同理。 */
const cardDecls = declsOf('.dsb-drag-card');
assert.ok(cardDecls.indexOf('font-size:') !== -1,
	'.dsb-drag-card 必须显式写 font-size（portal 到 body 后继承不到 .dsb-settings 的 14px，会掉回 body 的 16px）');
assert.ok(cardDecls.indexOf('user-select:none') !== -1,
	'.dsb-drag-card 必须显式写 user-select:none（面板那边关在 .dsb-row 上，浮层里没有这层）');
assert.ok(cardDecls.indexOf('-webkit-user-select:none') !== -1, '同时给 -webkit- 前缀，与面板那边一致');
console.log('1 浮层根规则自带 font-size 与 user-select:none（不依赖继承）');

/* ============================================================ 3. 字号与面板同值 */
const settingsFont = valueOf('.dsb-settings', 'font-size');
const cardFont = valueOf('.dsb-drag-card', 'font-size');
assert.ok(settingsFont !== null, '.dsb-settings 上要设 font-size（面板内所有文字的继承来源）');
assert.strictEqual(settingsFont, '14px', '当前口径是 14px（改口径时这里一起改）');
assert.strictEqual(cardFont, settingsFont,
	'浮层字号必须与面板同值：面板 ' + settingsFont + '、浮层 ' + cardFont + '（改一处忘另一处就红）');
console.log('3 字号同值：.dsb-settings=' + settingsFont + ' / .dsb-drag-card=' + cardFont);

/* 凡是设在容器上、会被后代继承的属性，浮层都得自己再写一份 —— 这是这次 bug 的一般化形式。
   以后往 .dsb-settings 里加了 font-family / line-height / color 之类，这里会立刻报出来。 */
const INHERITED_PROPS = ['font-size', 'font-family', 'line-height', 'letter-spacing', 'word-spacing',
	'text-align', 'text-transform', 'white-space', 'color', 'direction'];
const inheritedOnSettings = INHERITED_PROPS.filter((prop) => valueOf('.dsb-settings', prop) !== null);
assert.deepStrictEqual(inheritedOnSettings, ['font-size'],
	'目前 .dsb-settings 上会被继承的只有 font-size；新增继承属性时要同步浮层并更新这条');
inheritedOnSettings.forEach((prop) => {
	assert.strictEqual(valueOf('.dsb-drag-card', prop), valueOf('.dsb-settings', prop),
		'被继承的 ' + prop + ' 必须在浮层上镜像一份（portal 后断链）');
});
console.log('3b 继承断链：.dsb-settings 上被继承的属性 [' + inheritedOnSettings.join(', ') + '] 都已镜像');

/* ============================================================ 2. 面板侧 ↔ 浮层侧逐条比对 */
/* 浮层被 portal 到 body 后就不是 .dsb-settings 的后代，它内部那几件必须各留一份样式。
   这 9 组是浮层里真正会渲染到的类（rowParts 的构成：check > input + labels(name/desc) + handle）。 */
const PAIRS = [
	['.dsb-settings .dsb-check', '.dsb-drag-card .dsb-check'],
	['.dsb-settings .dsb-check input', '.dsb-drag-card .dsb-check input'],
	['.dsb-settings input[type=checkbox]', '.dsb-drag-card input[type=checkbox]'],
	['.dsb-settings .dsb-labels', '.dsb-drag-card .dsb-labels'],
	['.dsb-settings .dsb-name', '.dsb-drag-card .dsb-name'],
	['.dsb-settings .dsb-desc', '.dsb-drag-card .dsb-desc'],
	['.dsb-settings .dsb-handle', '.dsb-drag-card .dsb-handle'],
	['.dsb-settings .dsb-handle::before', '.dsb-drag-card .dsb-handle::before'],
	['.dsb-settings .dsb-handle-off', '.dsb-drag-card .dsb-handle-off']
];
PAIRS.forEach((pair) => {
	assert.strictEqual(declsOf(pair[1]), declsOf(pair[0]),
		'浮层侧 ' + pair[1] + ' 的声明要与面板侧 ' + pair[0] + ' 逐字一致');
});
/* 核心声明单独点名，失败信息更直白（也是契约要求覆盖的那几项） */
assert.strictEqual(valueOf('.dsb-drag-card .dsb-check', 'display'), 'flex', 'check 用 flex 排版');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-check', 'gap'), '8px', 'check 内间隙 8px');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-check', 'flex'), '1', 'check 撑满剩余宽度');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-check', 'min-width'), '0', 'check 允许收缩');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-desc', 'font-size'), '12px', '描述字号 12px');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-desc', 'line-height'), '1.5', '描述行高 1.5');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-handle', 'width'), '16px', '握把宽度 16px');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-handle', 'height'), '16px', '握把高度 16px');
assert.strictEqual(valueOf('.dsb-drag-card .dsb-handle-off', 'opacity'), '.25', '未勾选握把更淡');
assert.ok(valueOf('.dsb-drag-card .dsb-handle::before', 'box-shadow').indexOf('5px 0 0 currentColor') === 0,
	'握把点阵的 box-shadow 起点要对（相对面板那份逐字一致已由上面的整串比对守住）');
/* 面板那一行是 .dsb-row，浮层那一行就是 .dsb-drag-card 本身：行级布局也要一致 */
['display', 'align-items', 'justify-content', 'gap', 'padding', 'user-select', '-webkit-user-select']
	.forEach((prop) => {
		assert.strictEqual(valueOf('.dsb-drag-card', prop), valueOf('.dsb-settings .dsb-row', prop),
			'浮层根（= 浮层里那一行）与面板行的 ' + prop + ' 要一致');
	});
console.log('2 面板侧 9 组选择器 + 行级核心声明与浮层侧一致');

/* ============================================================ 只报告：面板有、浮层没跟上 */
/* 做法：把面板后代规则的选择器原样换成浮层前缀，看浮层有没有同一条、声明是否一致。
   只在浮层里会渲染到的类上做 —— rowParts 的构成是
   label.dsb-check > input[type=checkbox] + span.dsb-labels > (name / desc) 与 span.dsb-handle(/‑off)，
   所以无类名元素只有 input[type=checkbox] 这一个；`.dsb-row` 例外（面板的行是 .dsb-row，
   浮层那一行是 .dsb-drag-card 本身，已在上面单独比过）。 */
const CARD_CLASSES = ['dsb-check', 'dsb-labels', 'dsb-name', 'dsb-desc', 'dsb-handle', 'dsb-handle-off'];
const firstClassOf = (text) => {
	const hit = /\.([A-Za-z0-9_-]+)/.exec(text);
	return hit === null ? null : hit[1];
};
const missing = [];
const mismatched = [];
const notApplicable = [];
RULES.forEach((decls, selector) => {
	if (selector.indexOf('.dsb-settings ') !== 0) return;
	const rest = selector.slice('.dsb-settings '.length);
	const first = firstClassOf(rest);
	if (first === 'dsb-row') return;   /* 面板的行 = 浮层的根，单独比 */
	if (first !== null && CARD_CLASSES.indexOf(first) === -1) { notApplicable.push(selector); return; }
	if (first === null && rest.indexOf('input[type=checkbox]') !== 0) { notApplicable.push(selector); return; }
	const counterpart = '.dsb-drag-card ' + rest;
	if (RULES.has(counterpart) !== true) missing.push(selector + '  →  缺 ' + counterpart);
	else if (RULES.get(counterpart) !== decls) mismatched.push(selector + '  ≠  ' + counterpart);
});
if (missing.length > 0 || mismatched.length > 0) {
	console.log('差异清单（面板有、浮层没跟上；只报告，不改 lib）：');
	missing.forEach((one) => console.log('  · 浮层缺规则：' + one));
	mismatched.forEach((one) => console.log('  · 声明不一致：' + one));
} else {
	console.log('差异清单：空（面板侧那批规则浮层都跟上了）');
}
if (notApplicable.length > 0) {
	console.log('不适用：另有 ' + notApplicable.length + ' 条面板专属规则（页头 / 价格编辑区 / 页脚等），'
		+ '浮层里不渲染那些元素，无需跟。');
}
/* 已知且无害的三处，单独说明，避免以后被当成漏改：
   · `.dsb-settings .dsb-handle:active{cursor:grabbing}`：浮层是 pointer-events:none，
     握把永远进不了 :active；拖动光标由面板侧 `.dsb-settings:has(.dsb-dragging) *` 负责；
   · `.dsb-settings .dsb-row:hover` / `.dsb-settings:has(.dsb-dragging) .dsb-row:hover`：
     悬停反馈是给下面那行用的（浮层不吃指针事件，鼠标其实落在它下面）；
   · `.dsb-settings:has(.dsb-dragging) *{cursor:grabbing !important}`：同上，只管面板。 */

console.log('');
console.log('DRAG CARD CHECKS PASSED（浮层自带字号 + 两侧样式一致）');
