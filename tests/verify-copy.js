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
	secSegments: '统计字段',
	secSegmentsHint: '勾选显示；按住拖动调整顺序。',
	secPrices: '自定义模型价格',
	updatePill: '发现新版本',
	updateTo: '更新 {version} 版本',
	updateRunning: '正在更新中',
	updateFailed: '更新失败',
	segContext: '上下文占用',
	segContextHint: '上下文占用明细与压缩阈值。',
	segCounts: '轮次＆步数',
	segCountsHint: '当前会话的总轮次与执行步数。',
	segStatusHint: '自动判断当前的峰谷时段。',
	segCacheHitHint: '当前会话的平均缓存命中率。',
	segTtft: '首字延迟',
	segTtftHint: '首字的平均延迟。',
	segTps: '输出速度',
	segTpsHint: 'token 的每秒平均输出速度。',
	segSessionTime: '运行用时',
	segSessionTimeHint: '当前会话的总计运行时间。',
	segLastCost: '本次费用',
	segLastCostHint: '当前或最近一轮交流的估算消耗费用，包含主模型、子代理和辅助调用。',
	segCost: '会话费用',
	segCostHint: '当前会话估算消耗费用，包含主模型、子代理和辅助调用。',
	segBalance: '余额',
	segBalanceHint: '账户余额，每分钟刷新。',
	starRepo: 'GitHub支持',
	starTip: '你的支持是我最大的动力！请帮我点亮Star吧~',
	tipHitHigh: '最高命中率',
	tipHitLow: '最低命中率',
	tipCountsTitle: '会话数据',
	tipCountsSkills: '技能注入',
	tipCountsCompactAt: '上下文压缩',
	tipCountsToolCalls: '工具调用',
	tipCompactItem: '第{index}次压缩',
	tipCompactWhere: '第{turn}轮{step}步',
	tipCompactTurnOnly: '第{turn}轮',
	/* 手动 / 轮间压缩没有 turn：落点用「发生在第几轮之后」 */
	tipCompactAfter: '第{turn}轮后',
	/* 手动调用 / 手动压缩的星号：内容 aria-hidden，含义靠这句悬停说明 */
	tipManual: '手动触发',
	tipTtftFast: '最快首字延迟',
	tipTtftSlow: '最慢首字延迟',
	tipToolTime: '工具调用',
	f_tokensTotal: '总计用量',
	tipTopUp: '充值余额',
	tipGranted: '赠金余额',
	/* WorkBuddy 积分口径的套餐气泡（标题取中性词「积分套餐」） */
	tipCreditsTitle: '积分套餐',
	tipCreditsMonthly: '（每月刷新）',
	tipCreditsRefresh: ' · {date} 刷新',
	tipCreditsExpire: ' · {date} 到期',
	tipCreditsRefreshLatest: ' · {date} 刷新(最近)',
	tipCreditsExpireLatest: ' · {date} 到期(最近)',
	tipCreditsUsed: '已用 {used} / {total}',
	priceNewModel: '自定义模型',
	/* task-24：提示行不再带币种（用户要求删掉那半句）。 */
	secPricesHint: '填写你使用的模型单价（每百万 tokens）。',
	priceTierPeak: '高峰时段',
	priceTierOffPeak: '空闲时段',
	/* task-19：未勾峰谷计价时价格行前面显示「全时段」档位名，中英都要有 */
	priceTierAllDay: '全时段'
};

const EN = {
	priceTierAllDay: 'All day',
	intro: 'Replaces the stats line under the message input. Select the fields to show, drag to reorder, or set model prices.',
	secSegments: 'Stats fields',
	secSegmentsHint: 'Select to show; drag to reorder.',
	secPrices: 'Custom model prices',
	/* task-24：不再带币种。 */
	secPricesHint: 'Prices per million tokens.',
	updatePill: 'Update available',
	updateTo: 'Update to {version}',
	updateRunning: 'Updating',
	updateFailed: 'Update failed',
	segContext: 'Context usage',
	segContextHint: 'Context occupancy breakdown and compaction threshold.',
	segCountsHint: 'Total turns and executed steps of the current session.',
	segStatusHint: 'Automatically determines the current peak / off-peak window.',
	segCacheHitHint: 'Average cache hit rate of the current session.',
	segTtft: 'Time to first token',
	segTtftHint: 'Average time to the first token.',
	segTps: 'Tokens per second',
	segTpsHint: 'Average output rate, in tokens per second.',
	f_ttft: 'TTFT {duration}',
	f_speed: 'TPS {throughput}t/s',
	f_sessionTime: 'Time {duration}',
	f_cacheHit: 'Combined hit {percent}%',
	f_counts: '{turns} Turns · {steps} Steps',
	f_lastCost: 'This turn {symbol}{cost}',
	f_tokensTurn: 'This turn usage',
	f_cost: 'Total {symbol}{cost}',
	f_balance: 'Balance {symbol}{amount}',
	f_valley: 'Off-peak',
	segSessionTime: 'Run time',
	segSessionTimeHint: 'Total run time of the current session.',
	segLastCost: 'This turn cost',
	segLastCostHint: 'Estimated cost of the current or most recent turn, including the main model, subagents, and helper calls.',
	segCostHint: 'Estimated session cost, including the main model, subagents, and helper calls.',
	segBalance: 'Balance',
	segBalanceHint: 'Account balance, refreshed every minute.',
	starRepo: 'Support on GitHub',
	starTip: 'Your support means a lot to me — please give it a star!',
	tipHitHigh: 'Highest hit rate',
	tipHitLow: 'Lowest hit rate',
	tipCountsTitle: 'Session data',
	tipCountsSkills: 'Skills injected',
	tipCountsCompactAt: 'Context compactions',
	tipCountsToolCalls: 'Tool calls',
	tipCompactItem: 'Compaction {index}',
	tipCompactWhere: 'Turn {turn}·Step {step}',
	tipCompactTurnOnly: 'Turn {turn}',
	tipCompactAfter: 'After turn {turn}',
	tipManual: 'Manually invoked',
	tipTtftFast: 'Fastest TTFT',
	tipTtftSlow: 'Slowest TTFT',
	tipToolTime: 'Tool calls',
	f_tokensTotal: 'Total usage',
	tipTopUp: 'Top-up balance',
	tipGranted: 'Granted balance',
	/* 积分口径的套餐气泡（见中文那份的同名键） */
	tipCreditsTitle: 'Points packages',
	tipCreditsMonthly: ' (monthly)',
	tipCreditsRefresh: ' · refreshes {date}',
	tipCreditsExpire: ' · expires {date}',
	tipCreditsRefreshLatest: ' · refreshes {date} (nearest)',
	tipCreditsExpireLatest: ' · expires {date} (nearest)',
	tipCreditsUsed: 'Used {used} / {total}',
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
	['数字输入右对齐（价格框那条规则一并管宽度与高度）', 'dsb-field input[type=text],.dsb-settings .dsb-field input[type=number]{width:52px;height:24px;text-align:right}'],
	['藏官方统计行挂在 html.dsb-on 上（关掉开关就恢复）', 'html.dsb-on [data-slot="conversation.composer.dock"] > *:not(.dsb-root):not(:has(.dsb-root)){display:none !important}'],
	['藏官方上下文按钮同样挂在 html.dsb-on 上', 'html.dsb-on button[aria-haspopup="dialog"][aria-label*="上下文"]'],
	['藏官方「用量」按钮（TurnUsagePanel）', 'html.dsb-on span[class$="_root"]>button[aria-haspopup="dialog"][class$="_trigger"]'],
	['气泡宽度按内容自适应', 'width:max-content;max-width:min(560px,100vw - 24px)'],
	['两列行（标签↔数值）之间留 5ch 最小间隙', '.dsb-meter-value{margin-left:auto;padding-left:5ch'],
	['令牌条里「子代理·命中」段用 75% 灰（与活跃总览高峰段同款）', '.dsb-bar-sub{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 75%,transparent)}'],
	['令牌条外框：整体圆角 + 裁切，段间 1px 间隔（原设计，gap:1px）', 'dsb-bar{display:flex;gap:1px;height:4px;border-radius:999px'],
	['令牌条分段是完整胶囊头（半径 999px 被浏览器夹到半高，未放大时也没有直边）', '.dsb-bar-seg{flex:0 1 auto;min-width:0;height:100%;border-radius:999px'],
	['令牌条分段允许收缩（小数百分比取整会略超 100%，不收缩会被右侧裁掉小段）', '.dsb-bar-seg{flex:0 1 auto;min-width:0'],
	['令牌条小段不设最小宽度（用户拍板去掉 2px 保底，极小段看不见是预期）', 'dsb-bar-seg{flex:0 1 auto;min-width:0;height:100%'],
	['工具彩条悬停段：轻微纵向放大（1.45 倍）+ 沿用胶囊圆头', '.dsb-bar-hoverable .dsb-bar-seg:hover{transform:scaleY(1.45);z-index:2}'],
	['工具彩条放开 overflow，让凸起的段不被上下裁平', '.dsb-bar-hoverable{overflow:visible}'],
	['工具彩条每段的上下判定区各外扩 7px（悬停放大更容易触发）', 'dsb-bar-hoverable .dsb-bar-seg::before{content:\\"\\";position:absolute;left:0;right:0;top:-7px;bottom:-7px}'],
	['工具彩条悬停提示：无气泡、无阴影、纯文字 11px（比标题 12px 小）', '.dsb-hover-plain{position:fixed;z-index:41;pointer-events:none;white-space:nowrap;font-size:11px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}'],
	['只有工具调用子视图把间隙收到 1ch', '.dsb-meter-tight .dsb-meter-value{padding-left:1ch}'],
	['手动调用 / 手动压缩的星号是上标（像 X² 的 ²），且不把行盒撑高', '.dsb-sup{font-size:.7em;line-height:0;vertical-align:super'],
	['积分套餐列表一屏正好 5 块（单块 37px × 5）且可滚动', '.dsb-credits-list{max-height:calc(5 * 37px);overflow-y:auto;overscroll-behavior:contain'],
	['积分套餐列表隐藏滚动条但保留滚动（不带 scrollbar-width 的旧浏览器）', 'scrollbar-width:none;-ms-overflow-style:none'],
	['积分套餐列表隐藏滚动条（WebKit / Chromium）', '.dsb-credits-list::-webkit-scrollbar{display:none}'],
	['积分套餐单块：上下两行（包名/已用 + 进度条）竖排', '.dsb-credit{display:flex;flex-direction:column;padding:2px 0 1px}'],
	['两列气泡的标题下带分隔线', 'dsb-meter-divider{display:block;height:1px'],
	['两列气泡：线到第一行再收 3px', 'dsb-meter-rows-fit{margin-top:1px}'],
	['可点行给光标与悬停底色（会话数据那三行）', 'dsb-meter-row-click{cursor:pointer'],
	['积分套餐聚合行只给光标、不给悬停灰底（独立修饰类，不影响会话数据那几行）', 'dsb-meter-row-plain{cursor:pointer}'],
	['下钻子视图分列：每列自己两列对齐', 'dsb-meter-cols{display:flex;flex-direction:row'],
	['列网格自带 display:flex（工具行只挂 .dsb-meter-cols，少了这条列会竖叠）', '.dsb-meter-cols{display:flex'],
	['分列列表高度不越过屏幕可用高度的一半', 'max-height:calc(50vh - 46px)'],
	['分列子视图放开面板宽度上限（560px 会把三列挤扁）', 'dsb-tip.dsb-meter-wide{max-width:min(880px,100vw - 24px)}'],
	/* ↓ 工具列表布局的两条红线（用户拍板）：**绝不折行**、放不下就横向滚动。
	   这四条是 layout 策略的全部落点，缺一条红线的实现就回来了：
	   · nowrap —— 折行的根源是 flex-wrap:wrap；改成 wrap 立刻回到"第二排只有一两列、右边一大片空白"
	   · overflow-x:auto —— 不折行之后必须能横向滚，否则 12 行仍放不下时内容直接被裁掉、看不见
	   · 滚动条隐藏 —— 气泡很窄，常驻滚动条会挤掉内容宽度
	   · 列 flex:none —— 否则 flex 会把列压扁（等于用"挤内容"替代折行），同样违反"理解 B" */
	['【红线】工具列网格绝不折行（flex-wrap:nowrap，折行会让第二排右边大片空白）',
		'dsb-meter-cols{display:flex;flex-direction:row;flex-wrap:nowrap'],
	['【红线】放不下时横向滚动（12 行仍放不下才走到这里，不折行也不裁掉）',
		'overflow-x:auto;overflow-y:auto'],
	['横向滚动条隐藏但保留滚动（气泡窄，常驻滚动条会挤掉内容宽度）',
		'dsb-meter-cols{display:flex;flex-direction:row;flex-wrap:nowrap;align-content:flex-start;align-items:flex-start;gap:6px 16px;max-height:calc(50vh - 46px);overflow-x:auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none}'],
	['列网格的滚动条 WebKit 下也隐藏', 'dsb-meter-cols::-webkit-scrollbar{display:none}'],
	['每列不收缩（flex:none，否则列被压扁替代滚动，宽度账失真）', 'dsb-meter-col{display:flex;flex-direction:column;flex:none}'],
	['价格三组字段整体贴右（有档位名那两行）', 'dsb-fields{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}'],
	['价格输入框够放 xx.xx（52px 宽、24px 高；选择器带 input[type] 才压得住通用规则）', 'dsb-field input[type=text],.dsb-settings .dsb-field input[type=number]{width:52px;height:24px;text-align:right}'],
	['峰谷计价勾选只占自身宽度', 'dsb-inline-check{display:flex;align-self:flex-start'],
	['勾选与计价单位同一行两端对齐', 'dsb-tier-head{display:flex;align-items:center;justify-content:space-between'],
	['币种下拉：毛玻璃 + 大圆角（与气泡同材质）', 'border-radius:var(--dsw-radius-lg,16px);background:rgb(from var(--dsw-specific-menu'],
	['气泡复刻官方菜单材质：半透明底', 'background:var(--dsw-specific-menu'],
	['气泡透明度 61.8%（不透明度 .382）', 'rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382)'],
	['气泡毛玻璃', 'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%))'],
	['气泡圆角跟随主题', 'border-radius:var(--dsw-radius-lg'],
	['浮层只留 .5px 描边（不要柔光阴影）', 'box-shadow:0 0 0 .5px var(--dsw-alias-border-l1'],
	['拖动中的行不可选中（长按拖动会刷成蓝底）', 'user-select:none;-webkit-user-select:none'],
	['跟手浮层固定在视口、不吃指针事件；z-index 1100 要盖过设置遮罩的 1000', 'dsb-drag-card{position:fixed;z-index:1100;pointer-events:none'],
	['浮层 portal 到 body 后仍带内部样式（勾选框）', '.dsb-drag-card .dsb-check{display:flex;align-items:flex-start'],
	['浮层 portal 到 body 后仍带内部样式（握把点阵）', '.dsb-drag-card .dsb-handle{position:relative;flex:none;width:16px;height:16px'],
	['浮层挂到 body 上（脱离被 backdrop-filter 改锚的祖先）', 'reactDom.createPortal(dragCardNode, document.body)'],
	['拖动中不给悬停反馈（浮层不吃指针事件，鼠标其实悬在下面那行上）', '.dsb-settings:has(.dsb-dragging) .dsb-row:hover'],
	['拖动中光标一律抓手（不然握把 grab / 文字 pointer / 空隙箭头来回跳）', ':has(.dsb-dragging) *{cursor:grabbing !important}'],
	['开关状态同步到 html.dsb-on', 'root.classList.add("dsb-on")'],
	['已过去但没数据的日子与「还没到」同色：整灰的四分之一（日块与月条共用这两个类）', 'dsb-past,.dsb-future{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 25%,transparent)}'],
	['两列行的标签↔数值之间留 5ch 最小间隙', '.dsb-meter-value{margin-left:auto;padding-left:5ch'],
	['只有工具调用子视图把间隙收到 1ch', '.dsb-meter-tight .dsb-meter-value{padding-left:1ch}'],
	['行的上下内边距不对称（1/3）补字体度量造成的 1px 下沉', '.dsb-meter-row{display:flex;align-items:center;gap:6px;padding:1px 0 3px}'],
	['可点行的悬停底色两端是半圆（胶囊）', '.dsb-meter-row-click{cursor:pointer;margin:0 -4px;padding:1px 4px 3px;border-radius:999px}'],
	['气泡左对齐基准是圆环按钮（灰底），不是里面的 SVG', 'root.querySelector(".dsb-ring-btn")']
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

/* task-19：单档价格行改用「全时段」档位名 + 常规规则，靠"没有档位名"判断的双边对齐规则已被舍弃。
   这里作为**负断言**钉住，防止有人把它加回来（加回来会让单档行的对齐方式与两档行不一致）。 */
const GONE = [
	['单档价格行双边对齐（已被舍弃：改由「全时段」档位名 + 常规规则）', 'dsb-tier:not(:has(.dsb-tier-name))'],
	['令牌条小段 2px 保底（用户拍板去掉：按实际比例显示，极小段看不见是预期）', '.dsb-bar-seg{flex:0 1 auto;min-width:2px'],
	['条形图段内透明右边框的间隔方案（会吞掉 0.76%/0.29% 这类极小段，已回退成 gap:1px）', '.dsb-bar-seg:not(:last-child){border-right:1px solid transparent'],
	['条形图分段 border-box（透明边框方案的一部分，已回退）', 'dsb-bar-seg{flex:0 1 auto;min-width:0;box-sizing:border-box'],
	['积分套餐聚合行的悬停灰底（用户拍板不要，只保留 cursor:pointer）', '.dsb-meter-row-plain:hover']
];
GONE.forEach(([label, needle]) => {
	if (raw.indexOf(needle) >= 0) {
		bad += 1;
		console.log('× 样式 ' + label + ' 仍在: ' + needle);
		return;
	}
	console.log('= 样式 ' + label + '（已移除）');
});

console.log('');
console.log(bad === 0 ? '文案与样式契约全部一致' : bad + ' 项不符');
process.exit(bad === 0 ? 0 : 1);
