/**
 * 文案契约校验：直接读 client.js 里的 zh / en 词表，逐条比对期望值。
 * 用法：node verify-copy.js；退出码 0 = 全部一致，1 = 有条目不符。
 */
const fs = require('fs');
const path = require('path');
const PLUGIN = path.join(__dirname, '..', 'lib', 'client.js');
const raw = fs.readFileSync(PLUGIN, 'utf8');

/** 从 `const <name> = {` 到对应 `};` 之间的键值对 */
function readTable(name) {
	const start = raw.indexOf('\t\tconst ' + name + ' = {');
	if (start < 0) throw new Error('未找到词表: ' + name);
	const end = raw.indexOf('\n\t\t};', start);
	if (end < 0) throw new Error('词表未闭合: ' + name);
	const table = {};
	raw.slice(start, end).split('\n').forEach((line) => {
		const hit = /^\s*([A-Za-z_][A-Za-z0-9_]*): "((?:[^"\\]|\\.)*)",?\s*$/.exec(line);
		if (hit !== null) table[hit[1]] = hit[2];
	});
	return table;
}

const ZH = {
	intro: '接管对话区底部的统计行。勾选要显示的字段、拖动调整顺序或配置模型费用单价。',
	secSegments: '数据字段',
	secSegmentsHint: '勾选显示；按住拖动可调整顺序。',
	secPrices: '自定义模型价格',
	segCounts: '轮次＆步数',
	segCountsHint: '当前会话的总轮次与执行步数。',
	segStatusHint: '当前会话的运行状态及峰谷时段。',
	segCacheHitHint: '当前会话的平均缓存命中率。',
	segTtft: '首字延迟',
	segTtftHint: '首字的平均延迟。',
	segTps: '输出速度',
	segTpsHint: 'token的每秒平均输出速度。',
	segSessionTime: '运行用时',
	segSessionTimeHint: '当前会话的总计运行时间。',
	segLastCost: '本次费用',
	segLastCostHint: '当前或最近一轮交流的估算消耗费用。',
	segCost: '会话费用',
	segCostHint: '当前会话估算消耗费用，包含主模型、子代理和辅助调用。',
	segBalance: '余额',
	segBalanceHint: '账户余额，每分钟刷新。',
	segTokens: 'Token计数',
	segTokensHint: '当前会话累计消耗的模型token（鼠标悬停查看明细）。',
	priceNewModel: '自定义模型',
	secPricesHint: '填写你使用的模型单价（每百万tokens/元）。',
	priceTierPeak: '高峰时段',
	priceTierOffPeak: '空闲时段'
};

const EN = {
	intro: 'Takes over the stats line under the composer. Tick the fields to show, drag to reorder, or set model prices.',
	secSegments: 'Data fields',
	secSegmentsHint: 'Tick to show; drag to reorder.',
	secPrices: 'Custom model prices',
	secPricesHint: 'Prices per million tokens (CNY).',
	segCountsHint: 'Total turns and executed steps of the current session.',
	segStatusHint: 'Run state and peak/off-peak period of the current session.',
	segCacheHitHint: 'Average cache hit rate of the current session.',
	segTtft: 'First-token delay',
	segTtftHint: 'Average delay of the first token.',
	segTpsHint: 'Average output speed in tokens per second.',
	segSessionTime: 'Run time',
	segSessionTimeHint: 'Total run time of the current session.',
	segLastCost: 'This turn cost',
	segLastCostHint: 'Estimated cost of the current or most recent turn.',
	segCostHint: 'Estimated cost of the current session, including the main model, subagents, and helper calls.',
	segBalance: 'Balance',
	segBalanceHint: 'Account balance, refreshed every minute.',
	segTokens: 'Session tokens',
	segTokensHint: 'Model tokens consumed by the current session (hover for the breakdown).',
	priceNewModel: 'Custom model'
};

const STYLES = [
	['勾选框跟随主题（浅色近黑 / 深色近白）', 'accent-color:var(--dsw-alias-label-primary,#202020)'],
	['隐藏数字输入箭头(webkit)', 'input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none'],
	['隐藏数字输入箭头(firefox)', 'input[type=number]{-moz-appearance:textfield;appearance:textfield}'],
	['把手容器定位', 'dsb-handle{position:relative;flex:none;width:16px;height:16px;'],
	['把手点阵在行内居中', 'dsb-handle::before{content:"";position:absolute;left:4px;top:1.5px;'],
	['占位文字更淡', 'input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.5}'],
	['最后一条模型贴齐卡片底', 'dsb-model:last-child{padding-bottom:0}'],
	['数字输入右对齐', 'input[type=number]{text-align:right}']
];

let bad = 0;
function check(table, name, expect) {
	const actual = readTable(name);
	Object.keys(expect).forEach((key) => {
		if (actual[key] === expect[key]) {
			console.log('= ' + name + '.' + key);
			return;
		}
		bad += 1;
		console.log('× ' + name + '.' + key + '\n    期望: ' + expect[key] + '\n    实际: ' + String(actual[key]));
	});
}

check(readTable, 'zh', ZH);
check(readTable, 'en', EN);
STYLES.forEach(([label, needle]) => {
	if (raw.indexOf(needle) >= 0) {
		console.log('= 样式 ' + label);
		return;
	}
	bad += 1;
	console.log('× 样式 ' + label + ' 缺失: ' + needle);
});

console.log('');
console.log(bad === 0 ? '文案与样式契约全部一致' : bad + ' 项不符');
process.exit(bad === 0 ? 0 : 1);
