/**
 * dsh-desktop-statusbar — client 侧。
 *
 * 接管对话区底部的统计行，全部走官方 contract，不改动任何官方文件：
 *   1. 往 `conversation.composer.dock`（list 槽）追加自己的 cell（id 'mini-bar'）。
 *   2. 注入 CSS 藏掉官方 StatsPills（按本插件自己的 data-dsb 标记区分，不依赖官方类名）。
 *   3. 往 `settings.section` 注册设置页：基础开关 / 数据字段（拖拽排序）/ 自定义模型价格。
 *
 * 数据来源：
 *   - 官方投影 sessionStats / tokenUsage
 *   - 本插件 host 侧注册的 desktopStatusbarModel / desktopStatusbarUsage / desktopStatusbarActiveTime
 *   - 会话作用域槽的标准 props：useSession / useSessions / useChat / sessionId
 *   - 本插件 host 侧路由 /dsh-desktop-statusbar/api/balance（余额）与 /active-model（当前模型上报）
 *
 * 还原：卸载本插件即可（CSS 与两个 cell 都由 ctx.effect 管理）。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-statusbar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		/* 跟手浮层要 portal 到 body（见 dragCard 处的长注释）。react-dom 由 DSH 的客户端
		   模块加载器提供（与 react 同一个表）；取不到就退回就地渲染，功能不受影响，
		   只是那层玻璃在场时位置会偏 —— 所以这里绝不因为缺它而抛错。 */
		const reactDom = (() => {
			try {
				return require("react-dom");
			} catch (error) {
				return null;
			}
		})();
		const canPortal = reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === "function";

		const NS = "dsh-desktop-statusbar";
		const STYLE_TAG_ID = "dsh-desktop-statusbar/styles";
		const STORAGE_KEY = "dsh.desktopStatusBar.v1";
		/** 改名前用的旧键：读到就迁移过来，保留是为了能回退到旧版本。 */
		const LEGACY_STORAGE_KEY = "dsh.miniStatusBar.v1";
		const BALANCE_URL = "/dsh-desktop-statusbar/api/balance";
		const ACTIVE_MODEL_URL = "/dsh-desktop-statusbar/api/active-model";
		/* 余额轮询：host 端不再缓存，所以这个间隔就是底栏的更新粒度（1 分钟一次） */
		const BALANCE_POLL_MS = 60000;
		const DAILY_URL = "/dsh-desktop-statusbar/api/daily-usage";
		/** 气泡定位诊断的上报端点（host 落到 tip-diag.log）。 */
		const TIP_DIAG_URL = "/dsh-desktop-statusbar/api/tip-diag";
		const PRICES_URL = "/dsh-desktop-statusbar/api/prices";
		const HOLIDAYS_URL = "/dsh-desktop-statusbar/api/holidays";
		const VERSION_URL = "/dsh-desktop-statusbar/api/version";
		/** 一键更新：由本插件自己的 host 端执行（不依赖任何别的插件，见 self-update 说明）。 */
		const SELF_UPDATE_URL = "/dsh-desktop-statusbar/api/self-update";
		/** 客户端侧更新失败的上报端点（host 写进日志；宿主自己不知道浏览器里发生了什么）。 */
		const UPDATE_FAILURE_URL = "/dsh-desktop-statusbar/api/update-failure";
		/* 子智能体（Agent Teams 的队友）用量的聚合端点：队友是**独立会话**，它的消耗不在本会话
		   的投影里，只能由 host 按 parentSession 找出来，「总计」「本轮」才真的把队友算进去。
		   带 since（毫秒）= 只要那个时刻之后的用量，客户端拿它取「本轮」这一段。 */
		const SUBAGENT_URL = "/dsh-desktop-statusbar/api/subagent-usage";
		/** 队友用量多久重拉一次：底栏本来就有一个**每秒**跳的 now 时钟（活跃时），
		    所以这里取 1 秒 —— 用户要的「实时跳动」；也不必为它新增定时器。
		    没有变化时后台只比对文件的 mtime/size（实测几毫秒），每秒重拉的开销可以忽略。 */
		const SUBAGENT_REFRESH_MS = 1000;
		/** 聚合请求自己的超时：接口卡住时不能把「总计」一直吊着，超时就退回只算本会话。
		    上百个子智能体时 host 要把所有子会话日志解压聚合，实测 146 个活跃子会话首轮聚合
		    可以明显超过 8s；超时被当成失败后客户端会沿用"上一次成功的小值"，界面就卡在偏小
		    数字上、等某一次偶然成功再跳大。所以把超时放宽到 20s（配合 host 侧按文件缓存，
		    热路径通常几百毫秒）。 */
		const SUBAGENT_TIMEOUT_MS = 20000;
		/**
		 * 配置结构版本。
		 * v6 起：`segments` 存全部段的有序列表（顺序对整份列表生效），`hidden` 存未勾选的段。
		 */
		const CONFIG_VERSION = 6;
		/** 插件版本：显示在设置页底部，用来确认页面加载的是哪一版客户端代码。 */
		const VERSION = "3.0.0";
		/** 官方参考价的版本：官方调价时改这个数字，老价格库会自动并入新参考价。 */
		const PRICE_VERSION = 2;
		/** 项目主页：设置页那个「去 GitHub 点 star」按钮跳这里（与 package.json 的 repository 同址）。 */
		const REPO_URL = "https://github.com/raphael-y7/dsh-desktop-statusbar";

		/* ------------------------------------------------------------ 价格库 */

		/** DeepSeek 参考价（CNY / 1M tokens）。高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00（法定节假日除外），空闲价为高峰价的一半。 */
		const DEFAULT_PRICES = {
			"deepseek-flash": {
				peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
				offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 }
			},
			"deepseek-v4-pro": {
				peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
				offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 }
			}
		};

		/** 官方参考价的美元表：与人民币表同一页面（2026-09 核对）。空闲价同样是高峰价的一半。 */
		const DEFAULT_PRICES_USD = {
			"deepseek-flash": {
				peak: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 },
				offPeak: { input: 0.15, cacheRead: 0.003, cacheWrite: 0, output: 0.6 }
			},
			"deepseek-v4-pro": {
				peak: { input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 },
				offPeak: { input: 0.66, cacheRead: 0.022, cacheWrite: 0, output: 1.98 }
			}
		};

		/** 取某个币种的官方参考价表。 */
		function referencePrices(currency) {
			return currency === "USD" ? DEFAULT_PRICES_USD : DEFAULT_PRICES;
		}

		/** 一组数字的中位数（偶数个取中间两个的平均）。 */
		function medianNumber(list) {
			if (list.length === 0) return null;
			const sorted = list.slice().sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
		}

		/**
		 * 人民币 ↔ 美元的统一折算率，**从两套官方参考价表推导**（不硬编码任何来历不明的数字）：
		 *   ① 对每个"两张表里都有"的模型，取它每一格非零价格在两表中的比值，得到该模型的中位比值；
		 *   ② 再对所有模型的中位比值取中位数。
		 * 当前两张表（2026-09 核对）推出：flash 6.666667、v4-pro 6.818182 → **6.742424**。
		 * 用法：`人民币金额 / REFERENCE_RATE = 美元金额`，反向乘回去。
		 * 仅供**显示层折算**与"切换条目币种时换算该条目数值"，绝不改写价格库、也不碰台账。
		 */
		const REFERENCE_RATE = (() => {
			const perModel = [];
			Object.keys(DEFAULT_PRICES).forEach((name) => {
				const usd = DEFAULT_PRICES_USD[name];
				if (usd === undefined || usd === null) return;
				const ratios = [];
				["peak", "offPeak"].forEach((tier) => {
					const left = DEFAULT_PRICES[name][tier];
					const right = usd[tier];
					if (left === undefined || left === null || right === undefined || right === null) return;
					["input", "cacheRead", "cacheWrite", "output"].forEach((field) => {
						const a = Number(left[field]);
						const b = Number(right[field]);
						if (Number.isFinite(a) === true && Number.isFinite(b) === true && a > 0 && b > 0) ratios.push(a / b);
					});
				});
				const one = medianNumber(ratios);
				if (one !== null) perModel.push(one);
			});
			return medianNumber(perModel);
		})();

		/** 币种只认 CNY / USD，其余一律当人民币（与配置读取同一口径）。 */
		function normalizeCurrency(raw) {
			return raw === "USD" ? "USD" : "CNY";
		}

		/**
		 * 一个模型条目的币种：`models[name].currency`；没写就退回默认币种（`config.currency`）。
		 * 用 pickPriceKey 匹配（与计价同一套规则），所以"会话里的模型名"和"价格库的键名"
		 * 不逐字相同也能找到同一个条目。
		 */
		function entryCurrencyOf(book, model, defaultCurrency) {
			const fallback = normalizeCurrency(defaultCurrency);
			if (book === null || book === undefined || typeof book !== "object" || typeof model !== "string") return fallback;
			const key = pickPriceKey(book, model);
			if (key === null) return fallback;
			const entry = book[key];
			if (entry === null || entry === undefined || typeof entry !== "object") return fallback;
			return entry.currency === undefined || entry.currency === null ? fallback : normalizeCurrency(entry.currency);
		}

		/**
		 * 金额换币种 —— **只用于底栏显示层**（混币折成一个数字）。
		 *
		 * 绝不用于"切换条目币种时改价格库数值"：那是用户明确反对的做法（官方价是定死的两套，
		 * 自建/改过的价该填多少由用户自己填，工具不按汇率替他算）。见 `setModelCurrency`。
		 * 同一个币种原样返回；推导不出比率时也不动。
		 */
		function convertCurrency(amount, from, to) {
			const value = Number(amount);
			if (Number.isFinite(value) !== true) return amount;
			const a = normalizeCurrency(from);
			const b = normalizeCurrency(to);
			if (a === b || REFERENCE_RATE === null || Number.isFinite(REFERENCE_RATE) !== true || REFERENCE_RATE <= 0) return value;
			/* 比率是"人民币 / 美元"：CNY → USD 就除，USD → CNY 就乘 */
			return a === "CNY" ? value / REFERENCE_RATE : value * REFERENCE_RATE;
		}

		/** 一格未填时的占位：用 `null` 表示"这里还没填过"，与用户明确填的 0 区分开。 */
		const EMPTY_TIER = { input: null, cacheRead: null, cacheWrite: null, output: null };

		/**
		 * 单个价格格：**没填过就保留成 `null`**（`null` / `undefined` / 空字符串都算没填），
		 * 其余转成数字 —— 用户明确填的 0 就是数字 0，不会被当成"没填"。
		 * 计价时 `null` 参与算术会当 0 用，所以不影响算钱，只影响编辑框要不要留空。
		 */
		function tierValue(raw) {
			if (raw === null || raw === undefined || raw === "") return null;
			const n = Number(raw);
			/* 非法输入（手改配置、粘贴进字母）当作"没填"，不要压成 0 —— 压成 0 会被当成
			   "用户明确把价定成了 0"，第二轮匹配就会拿它算钱 */
			return Number.isFinite(n) === true ? n : null;
		}

		/**
		 * 峰谷联动：官方口径里空闲价正好是高峰价的一半，所以用户只需填一档，
		 * 另一档按比例算出来 —— 填高峰 → 空闲 ÷2；填空闲 → 高峰 ×2。
		 * `raw` 是输入框里的字符串：空串原样返回（清空一档时另一档也清空），
		 * 非法输入返回空串（宁可留空让用户重填，也不要写进一个错价）。
		 */
		function linkedTierValue(raw, fromPeak) {
			if (raw === "") return "";
			const n = Number(raw);
			if (Number.isFinite(n) !== true) return "";
			const linked = fromPeak === true ? n / 2 : n * 2;
			/* 去掉浮点尾巴（0.07×2 之类），最多留 6 位小数 */
			return String(Math.round(linked * 1e6) / 1e6);
		}

		/** 把一条价格规范化成 { peak, offPeak }；旧的平铺结构视为两档同价。 */
		/** 两档数值是否逐项相同：用来识别被写坏的「空闲价 = 高峰价」。 */
		function sameTier(left, right) {
			if (left === null || left === undefined || right === null || right === undefined) return false;
			return left.input === right.input && left.cacheRead === right.cacheRead
				&& left.cacheWrite === right.cacheWrite && left.output === right.output;
		}

		function normalizePrice(entry) {
			if (entry === null || entry === undefined || typeof entry !== "object") return null;
			/* 直接复用 normalizeTier：两处口径必须一致，否则读回价格库时会把"没填"洗成 0 */
			const flatten = (value) => normalizeTier(value);
			if (entry.peak !== undefined || entry.offPeak !== undefined) {
				const peak = entry.peak === undefined || entry.peak === null ? null : flatten(entry.peak);
				const offPeak = entry.offPeak === undefined || entry.offPeak === null ? null : flatten(entry.offPeak);
				return {
					peak: peak !== null ? peak : (offPeak !== null ? offPeak : EMPTY_TIER),
					offPeak: offPeak !== null ? offPeak : (peak !== null ? peak : EMPTY_TIER)
				};
			}
			const flat = flatten(entry);
			return { peak: flat, offPeak: flat };
		}

		/* ------------------------------------------------------------ 模型名匹配 */
		/**
		 * 模型名切成词元：忽略大小写，分隔符（- . _ 空格等）都当边界。
		 * `DeepSeek-V4.1-Flash-SG` → ["deepseek","v4","1","flash","sg"]
		 */
		function modelTokens(name) {
			return typeof name === "string"
				? name.toLowerCase().split(/[^a-z0-9]+/).filter((one) => one.length > 0)
				: [];
		}

		/** 词元是否对得上：**完全相等**（大小写已经在切词时归一）。 */
		function tokenMatches(needle, hay) {
			return needle === hay;
		}

		/** 一条价格是不是"什么都没填"：两档四项加起来是 0。用来把未定价的条目挡在匹配之外。 */
		function priceIsBlank(entry) {
			const price = normalizePrice(entry);
			if (price === null) return true;
			const sum = (tier) => tier.input + tier.cacheRead + tier.cacheWrite + tier.output;
			return sum(price.peak) + sum(price.offPeak) === 0;
		}

		/**
		 * 这条价格里**有没有任何一格是数字**（= 用户真的填过）。
		 * 八格全是 `null`（只在设置页点过「添加」、还没填价就收起了）的条目，**两轮匹配都不该算数**：
		 * 否则第二轮兜底会让它命中同名模型，把该模型的费用静默算成 ¥0（实测缺陷）。
		 * "明确填了 0"的条目有数字格，第二轮兜底照常生效。
		 */
		function hasAnyPriceValue(entry) {
			if (entry === null || entry === undefined || typeof entry !== "object") return false;
			const price = normalizePrice(entry);
			if (price === null) return false;
			const tiers = [price.peak, price.offPeak];
			for (let i = 0; i < tiers.length; i += 1) {
				const one = tiers[i];
				if (one === null || one === undefined) continue;
				if (typeof one.input === "number" || typeof one.cacheRead === "number"
					|| typeof one.cacheWrite === "number" || typeof one.output === "number") return true;
			}
			return false;
		}

		/**
		 * 一轮匹配：① 同名单独先行；②③（子串命中与词元全含命中）**合并评选**，
		 * 按 weight = 词元数 * 1000 + 键名长度 取最具体的那个 —— 不能分档跑，
		 * 否则模型名里含一个短键（如 flash）就会把更具体的长键挤掉。
		 * 含数字的键只允许子串命中，不走词元档。
		 * skipBlank=true 时跳过"还没定价"（整条全 0）的条目。
		 */
		function matchPriceKeyOnce(book, model, skipBlank) {
			const keys = Object.keys(book);
			const lower = model.toLowerCase();
			/* 空键（手改配置或第三方 POST 才可能出现）不参选；八格全 null 的条目两轮都不参选；
			   skipBlank 那一轮再额外跳过"有数字、但总和为 0"的条目 */
			const usable = (key) => key.length > 0
				&& hasAnyPriceValue(book[key]) === true
				&& (skipBlank !== true || priceIsBlank(book[key]) !== true);
			/* ① 同名：单独先行，最高优先 */
			for (let i = 0; i < keys.length; i += 1) {
				if (keys[i].toLowerCase() === lower && usable(keys[i])) return keys[i];
			}
			/* ②③ 一次评选：子串命中的键与词元全含命中的键放在一起比 weight，取最具体的那个。
			   不能按"先全部子串、再全部词元"两轮跑 —— 那样模型名里只要含一个短键（如 flash），
			   就会把更具体的 deepseek-flash（只能靠词元档命中）挤掉。
			   含数字的键（如 deepseek-v4-pro）只允许子串命中，不走词元档。 */
			const tokens = modelTokens(model);
			const weightOf = (key) => modelTokens(key).length * 1000 + key.length;
			let best = null;
			let bestWeight = -1;
			for (let i = 0; i < keys.length; i += 1) {
				const key = keys[i];
				if (usable(key) !== true) continue;
				let hit = lower.indexOf(key.toLowerCase()) !== -1;
				if (hit !== true && /[0-9]/.test(key) !== true) {
					const want = modelTokens(key);
					if (want.length > 0) {
						hit = true;
						for (let k = 0; k < want.length; k += 1) {
							let found = false;
							for (let m = 0; m < tokens.length; m += 1) {
								if (tokenMatches(want[k], tokens[m]) === true) { found = true; break; }
							}
							if (found !== true) { hit = false; break; }
						}
					}
				}
				if (hit !== true) continue;
				const weight = weightOf(key);
				if (weight > bestWeight) { bestWeight = weight; best = key; }
			}
			return best;
		}

		/**
		 * 价格键 → 模型名：① 同名最优先；② 子串命中与③ 词元全含命中**合并评选**，取最具体的那个；
		 * 名字里含数字的键（如 `deepseek-v4-pro`）只认子串，不做词元匹配 ——
		 * 版本号不同的 pro 是另一个模型、另一个价，不该被旧版号吃掉。
		 *
		 * 为什么必须有词元档：默认键叫 `deepseek-flash`，而会话日志里记的是
		 * `deepseek-v4.1-flash-sg` / `deepseek-v41-flash` —— 版本号插在中间，子串匹配命不中，
		 * 于是默认价对这类模型永远不生效、每笔都被当成"没有单价"。
		 *
		 * **分两轮**：第一轮跳过"还没填价"（整条全 0）的条目 —— 用户加了条目但没填价，
		 * 不该把该模型的费用算成 0；第一轮一无所获时才放开，让"明确把某模型定为 0 价"仍算得出来。
		 * **host 侧 lib/index.js 的 pickPriceKey 必须与这里逐条同规则**，否则底栏与活跃总览会算出两个价。
		 */
		function pickPriceKey(book, model) {
			if (book === null || book === undefined || typeof book !== "object") return null;
			if (typeof model !== "string" || model.length === 0) return null;
			if (Object.keys(book).length === 0) return null;
			const strict = matchPriceKeyOnce(book, model, true);
			if (strict !== null) return strict;
			return matchPriceKeyOnce(book, model, false);
		}

		/**
		 * 按当前价格库查模型单价（规范化成峰谷两档）；匹配规则见 pickPriceKey；找不到返回 null。
		 * 顺带带上 `tiered`：**没勾「峰谷计价」的条目是全天一个价**，计价时必须两档都取 peak ——
		 * 否则空闲时段会挑到那个没填的档，把这段时间的费用全算成 0（实测缺陷）。
		 */
		function priceOf(model) {
			const book = config.models === undefined || config.models === null ? {} : config.models;
			const key = pickPriceKey(book, model);
			if (key === null) return null;
			const price = normalizePrice(book[key]);
			if (price === null) return null;
			price.tiered = isTiered(book[key]);
			return price;
		}

		/**
		 * 高峰时段判定：北京时间（UTC+8）周一至周五 9:00-12:00、14:00-18:00。
		 * 官方口径（2026-09-19 峰谷时间说明）：周末、调休上班的周末、中国法定节假日全天都按空闲时段计费，
		 * 所以高峰只落在"工作日且放假安排里没有放假"的日子。
		 */
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		/**
		 * 内嵌的放假日历：年份 → 落在周一至周五的放假日（北京时间 YYYY-MM-DD）。
		 * 依据《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）：
		 * 元旦 1/1-1/3、春节 2/15-2/23、清明 4/4-4/6、劳动节 5/1-5/5、端午 6/19-6/21、
		 * 中秋 9/25-9/27、国庆 10/1-10/7。
		 * 官方每年 10 月底到 11 月中发布下一年的安排；设置页常驻「更新节假峰谷」按钮，
		 * 点了就把下一年写进配置（holidayDays），内嵌这份只作出厂兜底。
		 */
		const HOLIDAYS = {
			"2026": [
				"2026-01-01", "2026-01-02",
				"2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
				"2026-04-06",
				"2026-05-01", "2026-05-04", "2026-05-05",
				"2026-06-19",
				"2026-09-25",
				"2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"
			]
		};
		const HOLIDAY_SETS = {};
		Object.keys(HOLIDAYS).forEach((year) => { HOLIDAY_SETS[year] = new Set(HOLIDAYS[year]); });
		/** 抓来的放假日（按年索引）；setConfig 之后由 refreshHolidays() 重算。 */
		let fetchedHolidays = {};
		function refreshHolidays() {
			const next = {};
			const days = Array.isArray(config.holidayDays) ? config.holidayDays : [];
			days.forEach((day) => {
				if (typeof day !== "string" || day.length !== 10) return;
				const year = day.slice(0, 4);
				if (next[year] === undefined) next[year] = new Set();
				next[year].add(day);
			});
			fetchedHolidays = next;
		}
		/** 这一天是不是放假安排里的假期（内嵌表 ∪ 抓来的表）。 */
		function isHolidayDate(key) {
			const year = key.slice(0, 4);
			const builtin = HOLIDAY_SETS[year];
			if (builtin !== undefined && builtin.has(key)) return true;
			const fetched = fetchedHolidays[year];
			return fetched !== undefined && fetched.has(key);
		}
		/**
		 * 「更新节假峰谷」的目标年份：永远是下一年。
		 * 官方一般 10 月底到 11 月中公布下一年的安排；按钮常驻，什么时候点都行。
		 */
		function nextHolidayYear(now) {
			const at = new Date((typeof now === "number" && now > 0 ? now : Date.now()) + 8 * 3600 * 1000);
			return at.getUTCFullYear() + 1;
		}
		/** 某一年已录入多少个节假日（内嵌 + 抓取，去重），没有就是 0。 */
		function holidayCount(year) {
			const name = String(year);
			const seen = new Set();
			const builtin = HOLIDAY_SETS[name];
			if (builtin !== undefined) builtin.forEach((day) => seen.add(day));
			const fetched = fetchedHolidays[name];
			if (fetched !== undefined) fetched.forEach((day) => seen.add(day));
			return seen.size;
		}
		/**
		 * 按钮右边那行状态文案用的概况：有下一年的表就报下一年，否则报当年；
		 * 当年也没有（跨年还没更新）就用已录入里最靠后的一年，别显示 0 天。
		 */
		function holidaySummary(now) {
			const at = new Date((typeof now === "number" && now > 0 ? now : Date.now()) + 8 * 3600 * 1000);
			const thisYear = at.getUTCFullYear();
			const nextCount = holidayCount(thisYear + 1);
			if (nextCount > 0) return { year: thisYear + 1, count: nextCount };
			const count = holidayCount(thisYear);
			if (count > 0) return { year: thisYear, count: count };
			let latest = null;
			Object.keys(HOLIDAY_SETS).concat(Object.keys(fetchedHolidays)).forEach((name) => {
				const year = Number(name);
				if (latest === null || year > latest) latest = year;
			});
			return latest === null ? { year: thisYear, count: 0 } : { year: latest, count: holidayCount(latest) };
		}

		/** 按北京时间取日期键（YYYY-MM-DD），用来查节假日。 */
		function beijingDateKey(beijing) {
			const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
			const date = String(beijing.getUTCDate()).padStart(2, "0");
			return beijing.getUTCFullYear() + "-" + month + "-" + date;
		}

		function isPeakTime(ms) {
			const at = typeof ms === "number" && ms > 0 ? ms : Date.now();
			const beijing = new Date(at + 8 * 3600 * 1000);
			const day = beijing.getUTCDay();
			if (day === 0 || day === 6) return false;
			if (isHolidayDate(beijingDateKey(beijing))) return false;
			const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60;
			for (let i = 0; i < PEAK_WINDOWS.length; i += 1) {
				if (hour >= PEAK_WINDOWS[i][0] && hour < PEAK_WINDOWS[i][1]) return true;
			}
			return false;
		}

		/**
		 * 距离下一个峰谷边界还有多少毫秒（北京时间 9:00 / 12:00 / 14:00 / 18:00）。
		 * 跨午夜不列为边界：高峰只占工作日 9-12、14-18，午夜两侧都是空闲，显示不会变。
		 */
		function msToNextPeakBoundary(from) {
			const at = typeof from === "number" && from > 0 ? from : Date.now();
			const beijing = new Date(at + 8 * 3600 * 1000);
			const dayStart = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate()) - 8 * 3600 * 1000;
			const hours = [9, 12, 14, 18];
			for (let i = 0; i < hours.length; i += 1) {
				const boundary = dayStart + hours[i] * 3600 * 1000;
				if (boundary > at) return boundary - at;
			}
			/* 今天的边界都过了：下一个是明天 9:00（33 = 24 + 9） */
			return dayStart + 33 * 3600 * 1000 - at;
		}

		/**
		 * 价格库是不是"还没填过"：**所有条目的所有格子都是空的**才算缺失。
		 * 不能再用"数值总和为 0"判断 —— 用户明确填 0（表示免费）也是一种填写，
		 * 旧判据会把这种库整个换成官方参考价，用户自己的条目直接消失（实测缺陷）。
		 */
		function pricesMissing(book) {
			if (book === null || book === undefined || typeof book !== "object") return true;
			const names = Object.keys(book);
			if (names.length === 0) return true;
			for (let i = 0; i < names.length; i += 1) {
				if (hasAnyPriceValue(book[names[i]]) === true) return false;
			}
			return true;
		}

		/**
		 * 价格缺失或全 0 时回退到官方参考价：优先向 host 要（那儿是最新的），
		 * 拿不到就用内嵌的那套（按当前计价单位取人民币或美元表）。用户填过的非 0 价格不会被覆盖。
		 */
		function ensurePrices() {
			if (!pricesMissing(config.models)) return Promise.resolve(false);
			const fallback = () => {
				setConfig({ models: normalizeModels(referencePrices(config.currency)), priceVersion: PRICE_VERSION, priceConfigured: true });
				return false;
			};
			try {
				return window.fetch(PRICES_URL, { cache: "no-store" })
					.then((response) => response.json())
					.then((data) => {
						const models = data !== null && data !== undefined && data.models !== undefined ? data.models : null;
						if (models === null || Object.keys(models).length === 0) return fallback();
						setConfig({ models: normalizeModels(models), priceVersion: PRICE_VERSION, priceConfigured: true });
						return true;
					})
					.catch(() => fallback());
			} catch (error) {
				return Promise.resolve(fallback());
			}
		}

		/** 抓下一年（或指定年）的放假安排并写进配置；返回给设置页提示用的结果（都带 year）。 */
		function updateHolidays(year) {
			return window.fetch(HOLIDAYS_URL + "?year=" + String(year), { cache: "no-store" })
				.then((response) => {
					/* 404 = 后台还是旧版（host 要重启才会挂上新路由），跟"官方还没发布"得分开说 */
					if (response.ok !== true) {
						return { ok: false, year: year, reason: response.status === 404 ? "no-route" : "http-" + String(response.status) };
					}
					return response.json().then((data) => {
						const days = data !== null && data !== undefined && Array.isArray(data.days)
							? data.days.filter((day) => typeof day === "string" && day.length === 10)
							: [];
						if (days.length === 0) {
							const reason = data !== null && data !== undefined && typeof data.reason === "string" ? data.reason : "not-found";
							return { ok: false, year: year, reason: reason };
						}
						const known = Array.isArray(config.holidayDays) ? config.holidayDays : [];
						const merged = known.concat(days.filter((day) => known.indexOf(day) === -1)).sort();
						setConfig({ holidayDays: merged });
						return { ok: true, year: year, count: days.length };
					});
				})
				.catch(() => ({ ok: false, year: year, reason: "fetch-failed" }));
		}

		function currencySymbol(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		/**
		 * 当前会话的**主模型**：消耗最多（四项 token 之和最大）的那个模型名。
		 *
		 * 为什么用累计 token 而不是"最近一次调用"：一次调用就让币种来回跳会晃；
		 * 累计量只增不减，币种因此是稳的。并列时按名字排序定一个，保证同输入同输出。
		 * 没有任何正用量（拿不到会话聚合、或全是 0）时返回 `null` —— 调用方退回默认币种。
		 */
		function mainModelOf(sessionUsage) {
			if (sessionUsage === null || sessionUsage === undefined || typeof sessionUsage !== "object") return null;
			const models = sessionUsage.models;
			if (models === null || models === undefined || typeof models !== "object") return null;
			let best = null;
			let bestTotal = 0;
			Object.keys(models).forEach((name) => {
				const one = models[name];
				if (one === null || one === undefined || typeof one !== "object") return;
				const total = (Number(one.input) || 0) + (Number(one.cacheRead) || 0)
					+ (Number(one.cacheWrite) || 0) + (Number(one.output) || 0);
				if (total <= 0) return;
				if (total > bestTotal || (total === bestTotal && best !== null && name < best)) {
					best = name;
					bestTotal = total;
				}
			});
			return best;
		}

		/**
		 * 底栏（总计 / 本轮）的显示币种 = **主模型那个条目的币种**；认不出主模型就退回
		 * "新增条目的默认币种"（`config.currency`）。与"我还没用过那个模型"无关的全局币种，
		 * 到这里彻底退出底栏显示。
		 */
		function displayCurrencyOf(book, defaultCurrency, sessionUsage) {
			const main = mainModelOf(sessionUsage);
			if (main === null) return normalizeCurrency(defaultCurrency);
			return entryCurrencyOf(book, main, defaultCurrency);
		}

		/** 按某模型条目单价算出来的金额 → 折成显示币种（只用于显示，不回写任何地方）。 */
		function toDisplayCurrency(amount, book, model, displayCurrency, defaultCurrency) {
			if (amount === null || amount === undefined) return amount;
			return convertCurrency(amount, entryCurrencyOf(book, model, defaultCurrency), displayCurrency);
		}

		/** 模型名显示用：deepseek → DeepSeek、glm → GLM、gpt → GPT，其余按 - 分段首字母大写。 */
		const MODEL_NAME_SPECIAL = { deepseek: "DeepSeek", glm: "GLM", gpt: "GPT" };
		function displayModelName(name) {
			if (typeof name !== "string" || name.length === 0) return name;
			return name.split("-").map((part) => {
				if (part.length === 0) return part;
				const special = MODEL_NAME_SPECIAL[part.toLowerCase()];
				if (special !== undefined) return special;
				return part.charAt(0).toUpperCase() + part.slice(1);
			}).join("-");
		}

		/** 该模型是否按峰谷两档计价（缺省视为两档）。 */
		function isTiered(entry) {
			return entry === null || entry === undefined || entry.tiered !== false;
		}

		/**
		 * 旧版本遗留的"全 0 条目"：八个价格格全是**数字 0**、没有任何 `null`。
		 * 那时的数据分不清"没填"与"填了 0"，只能按没填过处理（编辑时整栏留空）。
		 * 新版数据里没填的格子是 `null`，所以只要有一格是 `null` 就不会被误判。
		 */
		function isLegacyZeroEntry(entry) {
			const price = normalizePrice(entry);
			if (price === null) return false;
			const tiers = [price.peak, price.offPeak];
			for (let i = 0; i < tiers.length; i += 1) {
				const one = tiers[i];
				if (one.input !== 0 || one.cacheRead !== 0 || one.cacheWrite !== 0 || one.output !== 0) return false;
			}
			return true;
		}


		/**
		 * 按价格库算一段用量的费用（按给定时刻定峰谷），返回**未舍入的数值**。
		 * 不要在这里舍入：总计是逐条调用累加出来的，单条先砍到分会让几百次调用的误差累积成几毛钱
		 * （实测 171.8M token 的会话里少算了 0.75 元）。显示统一走 costText。
		 */
		function costOf(bucket, model, at) {
			const price = priceOf(model);
			if (price === null || bucket === undefined || bucket === null) return null;
			/* 没勾「峰谷计价」= 全天一个价：两档都取 peak，别在空闲时段挑到空档、把费用算成 0 */
			const tier = price.tiered === false ? price.peak : (isPeakTime(at) ? price.peak : price.offPeak);
			return ((bucket.input || 0) * tier.input
				+ (bucket.cacheRead || 0) * tier.cacheRead
				+ (bucket.cacheWrite || 0) * tier.cacheWrite
				+ (bucket.output || 0) * tier.output) / 1e6;
		}

		/**
		 * 按**指定档位**算一段用量的费用（不按时刻判断）。返回未舍入数值；没单价返回 null。
		 * 专供 host 回传的 overflow 用 —— 那部分已经按档归好类（host 侧判的峰谷），
		 * 这里不能再拿一个时刻去猜档位。没勾「峰谷计价」的条目两档同价，取 peak 即可。
		 */
		function costOfTier(bucket, model, peak) {
			const price = priceOf(model);
			if (price === null || bucket === undefined || bucket === null) return null;
			const tier = price.tiered === false ? price.peak : (peak === true ? price.peak : price.offPeak);
			return ((bucket.input || 0) * tier.input
				+ (bucket.cacheRead || 0) * tier.cacheRead
				+ (bucket.cacheWrite || 0) * tier.cacheWrite
				+ (bucket.output || 0) * tier.output) / 1e6;
		}

		/**
		 * 费用显示：一律两位小数，不满一分钱也进到 0.01（0.0075 → 0.01），不出现更长的小数位。
		 * 累加用 costOf 的原始值，只在这里做一次舍入。
		 */
		function costText(amount) {
			const n = Number(amount);
			/* 兜住 NaN / -0 / 负数：它们会显示成 "NaN" 或 "-0.00"，看着像坏掉了 */
			if (Number.isFinite(n) !== true || n <= 0) return "0.00";
			return n.toFixed(2);
		}

		/**
		 * 队友那一段的花费 → 折成显示币种。
		 *
		 * host 新版本会额外给 `total.costByCurrency`（按每个队友自己的条目币种分桶汇总），
		 * 这里逐桶折算再相加 —— 队友用了另一种币种时这才准。
		 * 老版本只有 `total.cost`（没带币种信息），就当作它已经是显示币种、不做折算：
		 * 队友与会话用同一个模型是最常见的情形，那时两者币种本来就相同。
		 */
		function subagentDisplayCost(total, displayCurrency) {
			if (total === null || total === undefined || typeof total !== "object") return 0;
			const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
			const byCurrency = total.costByCurrency;
			if (byCurrency !== null && byCurrency !== undefined && typeof byCurrency === "object") {
				let sum = 0;
				Object.keys(byCurrency).forEach((code) => {
					sum += convertCurrency(positive(byCurrency[code]), code, displayCurrency);
				});
				return sum;
			}
			return positive(total.cost);
		}

		/** 从队友的原始响应里取某一段的费用，并折成显示币种（拿不到就是 0）。 */
		function subagentCostOf(subagent, which, displayCurrency) {
			const payload = subagent === null || subagent === undefined ? null : subagent[which];
			if (payload === null || payload === undefined || typeof payload !== "object" || payload.ok !== true) return 0;
			return subagentDisplayCost(payload.total, displayCurrency);
		}

		/**
		 * host 返回的队友（Agent Teams 子智能体）用量 → 界面要的两个数：费用与令牌三段。
		 * 队友是**独立会话**，它的用量 host 按 parentSession 现算；拿不到（还在加载、请求失败、
		 * 后端老版本、形状不对）时一律给 0 —— 界面就退回"只算本会话"，不报错也不显示额外文字。
		 * 注意：这个形状（cost / cached / missInput / output）是既有约定，别往里塞别的字段 ——
		 * 「首字 / 解码」那两组的累计走 subagentStatsOf，两者互不影响。
		 */
		function subagentSummary(payload) {
			const none = { cost: 0, cached: 0, missInput: 0, output: 0 };
			if (payload === null || payload === undefined || typeof payload !== "object" || payload.ok !== true) return none;
			const total = payload.total;
			if (total === null || total === undefined || typeof total !== "object") return none;
			const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
			const tokens = total.tokens !== null && total.tokens !== undefined && typeof total.tokens === "object"
				? total.tokens
				: {};
			/* 令牌三段按本面板自己的口径合并：命中缓存 = cacheRead；未命中 = 未缓存输入 + 缓存写入
			   （与 billableParts 一致，否则总计用量会对不上三行之和）；输出 = output。 */
			return {
				cost: positive(total.cost),
				cached: positive(tokens.cacheRead),
				missInput: positive(tokens.input) + positive(tokens.cacheWrite),
				output: positive(tokens.output)
			};
		}

		/**
		 * 队友的首字 / 解码累计（`total.stats`）—— 只给"会话级"那三项（首字平均、综合速度）用。
		 * 单独一个函数而不是并进 subagentSummary：后者那个四字段形状是既有约定，
		 * 混进去会让别处（含测试）的深比较全变。拿不到就全 0，等于不加。
		 */
		function subagentStatsOf(subagentData) {
			const none = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 };
			const payload = subagentData === null || subagentData === undefined ? null : subagentData.session;
			if (payload === null || payload === undefined || typeof payload !== "object" || payload.ok !== true) return none;
			const total = payload.total;
			if (total === null || total === undefined || typeof total !== "object") return none;
			const stats = total.stats;
			if (stats === null || stats === undefined || typeof stats !== "object") return none;
			const positive = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
			return {
				ttftMs: positive(stats.ttftMs),
				ttftSteps: positive(stats.ttftSteps),
				decodeMs: positive(stats.decodeMs),
				decodeTokens: positive(stats.decodeTokens)
			};
		}

		/**
		 * 会话级那三项（首字平均 / 综合速度 / 缓存命中率）用的合并量 = 本会话 + 全部子会话。
		 * 「本轮」那一份**只算本页面**（用户明确要求），所以不走这里。
		 *
		 * 首字与解码都是"总量 / 样本数"的比值，所以**按组**合并：某一组只要缺了分子或分母
		 * （拿不到、为 0、非数）就整组不计 —— 只加半组会把平均值算歪（例如只有 ttftMs 没有
		 * ttftSteps）。host 只会整组给，这里是防坏响应/手改数据。
		 * 纯函数、只做几次加法：客户端每秒重算也不会成为负担。
		 */
		function mergedSessionStats(stats, sub) {
			const value = (one, key) => {
				const raw = one === null || one === undefined ? 0 : Number(one[key]);
				return Number.isFinite(raw) === true && raw > 0 ? raw : 0;
			};
			const sessionTtftMs = value(stats, "ttftMs");
			const sessionTtftSteps = value(stats, "ttftSteps");
			const sessionDecodeMs = value(stats, "decodeMs");
			const sessionDecodeTokens = value(stats, "decodeTokens");
			const sessionTtft = sessionTtftMs > 0 && sessionTtftSteps > 0;
			const sessionDecode = sessionDecodeMs > 0 && sessionDecodeTokens > 0;
			const subTtft = sub.ttftMs > 0 && sub.ttftSteps > 0;
			const subDecode = sub.decodeMs > 0 && sub.decodeTokens > 0;
			return {
				ttftMs: (sessionTtft ? sessionTtftMs : 0) + (subTtft ? sub.ttftMs : 0),
				ttftSteps: (sessionTtft ? sessionTtftSteps : 0) + (subTtft ? sub.ttftSteps : 0),
				decodeMs: (sessionDecode ? sessionDecodeMs : 0) + (subDecode ? sub.decodeMs : 0),
				decodeTokens: (sessionDecode ? sessionDecodeTokens : 0) + (subDecode ? sub.decodeTokens : 0)
			};
		}

		/** 从 host 拉回来的队友数据里取一段：`session` = 整会话（总计用），`turn` = 本轮窗口（本轮用）。 */
		function subagentOf(subagent, which) {
			return subagentSummary(subagent === null || subagent === undefined ? null : subagent[which]);
		}

		/**
		 * host 响应里的 `running`（仍在运行的子会话数）。
		 * 两段响应都会带同一个数，先取 `turn` 那一段（它与"此刻"最贴近），拿不到再退回 `session` 那段。
		 *
		 * 返回 `null` 表示**这次两问都没问出结论**（网络失败 / 非 200 / 形状不对），
		 * 调用方据此**保留旧值**、不覆盖。这一点是必须的：底栏的时钟靠这个数决定
		 * "每秒跳"还是"睡到下一个峰谷边界"，一旦把"问不到"当成 0，队友数据与「总计」里
		 * 队友那笔金额会一路冻结到几小时后 —— 正是用户报过的那个缺陷。
		 * 反过来，两问里只要有一问给出数字就按数字走：明确的 0 必须能落下去
		 * （队友真的全部结束时，时钟要能回到省电档），所以不能用"非 0 才更新"的写法。
		 */
		function readSubagentRunning(turnPayload, sessionPayload) {
			const pick = (one) => (one !== null && one !== undefined && typeof one === "object"
				&& typeof one.running === "number" && Number.isFinite(one.running) && one.running >= 0
				? Math.floor(one.running)
				: null);
			const fromTurn = pick(turnPayload);
			const fromSession = pick(sessionPayload);
			if (fromTurn === null && fromSession === null) return null;
			if (fromTurn !== null && fromTurn > 0) return fromTurn;
			if (fromSession !== null && fromSession > 0) return fromSession;
			return 0;
		}

		/**
		 * 把「这一次的两问结果」折算成 `subagentRunning` 的**下一个值**。
		 *
		 * 就是 stale-while-revalidate：这次问不到（两个 payload 都不成形状）⇒ 原样返回旧值，
		 * 调用方什么都不用判断。单独抽成纯函数，一是让调用点没有"覆盖还是跳过"的分支可写错，
		 * 二是这条规则能被离线断言住（与 `nextSubagentState` 同一个套路）。
		 *
		 * @param {number} prev 当前显示的队友在跑个数
		 * @param {object|null} turnPayload 「本轮窗口」那一问的响应
		 * @param {object|null} sessionPayload 「整会话」那一问的响应
		 * @returns {number} 下一个值（问不到就是 prev）
		 */
		function nextSubagentRunning(prev, turnPayload, sessionPayload) {
			const next = readSubagentRunning(turnPayload, sessionPayload);
			return next === null ? prev : next;
		}

		/**
		 * host 响应里的**分层**信息：`{ team, deep, teamPercent, deepPercent }`。
		 *
		 *   · `team` / `deep` —— 两个层级各自在跑的个数
		 *       `team` = 在跑的直接后代里**属于团队成员**的个数（Agent Teams 的队员）
		 *       `deep` = 其余在跑的个数（团队成员下派的孙会话 + 不在团队内的独立子智能体）
		 *   · `teamPercent` / `deepPercent` —— 那一级里在跑的人的上下文占用：
		 *       **成员取最大**（多个成员同时跑时，圆环显示占用最多的那个）
		 *       **更深层取最小**（用户原话：「成员下派的子智能体那一级别……上下文占用要显示最少的那个」）
		 *     host 算不出来时给 `null`，调用方必须退回 Lead 自己的占用，不能当 0（会把圆环弄空）。
		 *
		 * 恒有 `running === team + deep`（host 侧保证），但**这里不拿 running 反推** ——
		 * 老 host 没有这两个字段时，硬推会把"团队外独立子智能体"误算成成员。
		 * 计数字段缺失当 0，百分比字段缺失当 null（老 host / 老夹具照常能跑）。
		 *
		 * 为什么单独一个函数、不改 `readSubagentRunning` 的返回形状：那个函数被
		 * `nextSubagentRunning` 用着，而 `nextSubagentRunning` 的 `null=保留旧值 / 0=真落下`
		 * 语义是修过的真实缺陷（时钟不降档），`tests/verify-subagent-total.js` 逐字段断言它。
		 * 加字段就得同步改契约和断言，风险不对等 —— 分层只是一份"额外信息"，
		 * 用同一套"先 turn 段、再 session 段"的取法另算一遍最省事也最安全。
		 *
		 * 取值规则与 `readSubagentRunning` 一致：任一段给出合法数就用它（host 两问带同一份数）。
		 * 计数字段的 0 与"没有该字段"在这里区分得开（后者当 0，语义上等价：都不在跑）；
		 * 百分比字段则**严格区分 null 与 0** —— 0% 是真实占用，null 是算不出。
		 */
		function readSubagentTiers(turnPayload, sessionPayload) {
			const pickCount = (payload, key) => (payload !== null && payload !== undefined && typeof payload === "object"
				&& typeof payload[key] === "number" && Number.isFinite(payload[key]) && payload[key] >= 0
				? Math.floor(payload[key])
				: null);
			const pickPercent = (payload, key) => (payload !== null && payload !== undefined && typeof payload === "object"
				&& typeof payload[key] === "number" && Number.isFinite(payload[key])
				? Math.max(0, Math.min(100, payload[key]))
				: null);
			const countOf = (key) => {
				const fromTurn = pickCount(turnPayload, key);
				const fromSession = pickCount(sessionPayload, key);
				/* 与 readSubagentRunning 的取舍同构：先看 turn 段，它没有（或为 0）再看 session 段 */
				if (fromTurn !== null && fromTurn > 0) return fromTurn;
				if (fromSession !== null && fromSession > 0) return fromSession;
				return 0;
			};
			const percentOf = (key) => {
				/* 百分比用 `!== null` 判，不用 `> 0`：0% 是合法占用，不能被当成"没有"跳过 */
				const fromTurn = pickPercent(turnPayload, key);
				if (fromTurn !== null) return fromTurn;
				return pickPercent(sessionPayload, key);
			};
			return {
				team: countOf("teamRunning"),
				deep: countOf("deepRunning"),
				teamPercent: percentOf("teamContextPercent"),
				deepPercent: percentOf("deepContextPercent")
			};
		}

		/**
		 * host 推出来的**本轮起点**（毫秒）。只从「本轮窗口」那一问的响应里读 ——
		 * 整会话那一问（`since=0`）返回的起点语义是"最早的那次"，拿它当本轮起点会把
		 * 整个会话的队友花费都算进本轮（方向正是"偏大"）。
		 * 非法值（非数字 / 非正 / NaN）一律当 null，调用方据此退回"客户端折叠"或"本轮不并队友"。
		 */
		function readTurnStartMs(payload) {
			if (payload === null || payload === undefined || typeof payload !== "object") return null;
			const value = payload.turnStartMs;
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
		}

		/* ------------------------------------------- 「本轮」稳定性（同轮不跳、换轮归零） */
		/* 底栏每秒问两个窗口（整会话 / 本轮窗口），任一问失败时旧实现会把队友那段当 0，
		   于是「本轮」在同轮内跳小、下一次成功又跳大（用户实测）。下面两件纯函数负责把它稳住：
		   `nextSubagentState` 管"这次失败要不要沿用上一次成功的值"，`applyTurnFloor` 管
		   "同一轮内显示值只增不减"。两者都以**轮标识**（turnKey）为界：换了轮一律从头来。 */

		/** 空状态：没有会话、没有轮、两段都没有值。 */
		const SUBAGENT_STATE_EMPTY = { sessionId: null, turnKey: null, sessionPayload: null, turnPayload: null };

		/**
		 * 分层在跑的初始值：全 0。`all` 初值是 0 而不是 null —— 首帧没有任何结论时
		 * 底栏本来就该按"没人在跑"渲染（圆环走 idle 的透明弧），等价于旧实现 `useState(0)`。
		 * 之后每次响应：有结论就覆盖（含 0），没结论才保留旧值（见 nextSubagentTiers）。
		 */
		const SUBAGENT_TIERS_EMPTY = { all: 0, team: 0, deep: 0, teamPercent: null, deepPercent: null };

		/**
		 * 把「这一次的两问结果」折算成分层状态的**下一个值**（纯函数，便于离线断言）。
		 *
		 * 三条规则：
		 *   ① `all` 沿用 `nextSubagentRunning` 的 stale-while-revalidate：
		 *      这次问不出结论 ⇒ 原样返回 prev.all；明确的 0 ⇒ 落到 0。
		 *      这条不能变通 —— 它是修过的真实缺陷（问不到当 0 会让时钟降档、数据冻结）。
		 *   ② 计数与百分比**跟着 `all` 一起更新或一起保留**：不做"计数更新了但百分比留着旧值"
		 *      这种半更新，否则会出现"蓝色在转、弧长却是上一次某个成员的占用"的错配。
		 *   ③ 没有结论时连百分比一起保留（`prev` 里那份百分比仍属于上一个已知状态）。
		 */
		function nextSubagentTiers(prev, turnPayload, sessionPayload) {
			const nextAll = readSubagentRunning(turnPayload, sessionPayload);
			if (nextAll === null) return prev;
			const tiers = readSubagentTiers(turnPayload, sessionPayload);
			return {
				all: nextAll,
				team: tiers.team,
				deep: tiers.deep,
				teamPercent: tiers.teamPercent,
				deepPercent: tiers.deepPercent
			};
		}

		/**
		 * 队友两段取值的状态机（纯函数，组件只负责调用）。
		 *
		 * 一次"客户端到期"问两个窗口，每个窗口各自维护"上一次成功的值 + 它属于哪一轮"。
		 * `ok` 的判定由调用方统一折算：网络失败、非 200、**HTTP 200 但 `ok:false`**（后端
		 * `scan-failed` 之类）、以及形状异常（拿到的不是 `{ok:true,…}`）**都算"这一次没拿到"**。
		 *
		 * 三种情形（用户明确要求的三态）：
		 *   · 同一会话、同一轮、之前成功过 → **保留上一次成功的值**（stale-while-revalidate，
		 *     宁可用稍旧的值，也不要在同轮内把已经显示的数字打回 0）；
		 *   · 首次加载（手里没有旧值）→ `null` ⇒ 界面按"仅本会话"显示（没有旧值可留）；
		 *   · 换了轮（`turnKey` 变了）或换了会话 → **先整体清空**，绝不让上一轮的旧值顶上
		 *     （这就是用户说的"归零重算以轮次结束为准"）。
		 * 返回值是**新对象**，不原地改入参。
		 */
		function nextSubagentState(prev, action) {
			const base = prev === null || prev === undefined ? SUBAGENT_STATE_EMPTY : prev;
			const sameSession = base.sessionId === action.sessionId;
			const sameTurn = sameSession === true && base.turnKey === action.turnKey;
			/* 整会话那一段与"轮"无关（它就是本会话有史以来的队友合计，只随会话累积）：
			   只要会话没换就留着 —— 否则每次换轮都会把「总计」里的队友清一下再填回来（抖一下）。
			   「本轮窗口」那一段必须跟轮走：换轮就作废，不许让上一轮的窗口当这一轮的。 */
			const carried = sameSession === true
				? {
					sessionId: action.sessionId,
					turnKey: action.turnKey,
					sessionPayload: base.sessionPayload,
					turnPayload: sameTurn === true ? base.turnPayload : null
				}
				: { sessionId: action.sessionId, turnKey: action.turnKey, sessionPayload: null, turnPayload: null };
			const sliceKey = action.slice === "session" ? "sessionPayload" : "turnPayload";
			/* 这一段的"归属"判定：整会话只看会话，本轮窗口要看"会话 + 轮" */
			const ownerOk = sliceKey === "sessionPayload" ? sameSession : sameTurn;
			if (action.ok !== true) {
				/* 没拿到：同一归属且这一段手里已经有值 → 原样留着；否则这一段就是 null
				   （首次加载、或者刚换轮/换会话 —— 前者没有旧值可留，后者不允许留） */
				if (ownerOk === true && carried[sliceKey] !== null) return carried;
				carried[sliceKey] = null;
				return carried;
			}
			carried[sliceKey] = action.value;
			return carried;
		}

		/**
		 * 「本轮」显示值的**同轮粘性下限**（纯函数）：一轮之内只增不减。
		 *
		 * `hold` 形如 `{ sessionId, turnKey, value }`；返回 `{ value, hold }`，调用方把新 `hold`
		 * 存回自己的盒子。规则：
		 *   · 同一个会话、同一个轮 → `value = max(amount, hold.value)`（`amount` 为 null 时用旧值）；
		 *   · 换了轮/换了会话、或认不出轮次（`turnKey` 为 null）→ 不作粘性（`value = amount`）。
		 * 为什么需要它：一轮内窗口起点会移动（父会话日志多出一条 `user/message`、节点折叠的
		 * 最早时间戳变化、压缩替换节点、host 收敛起点），窗口一变数字就会小一截；用户要的是
		 * **一轮之内单调不减**，只有换轮才归零重算。
		 */
		function applyTurnFloor(hold, sessionId, turnKey, amount) {
			const usable = hold !== null && hold !== undefined && turnKey !== null
				&& hold.turnKey === turnKey && hold.sessionId === sessionId;
			const floor = usable === true && typeof hold.value === "number" && Number.isFinite(hold.value) === true
				? hold.value
				: 0;
			/* `amount === null` 是"这一拍没有可显示的金额"（界面给横杠），不是 0：
			   没有下限时要把 null 原样传出去（否则"横杠"会变成 ¥0.00，那是另一回事）；
			   有下限时用下限顶住（同轮内已经显示过金额，就不该退回横杠）。 */
			const value = amount === null || amount === undefined
				? (floor > 0 ? floor : null)
				: Math.max(amount, floor);
			return { value: value, hold: { sessionId: sessionId, turnKey: turnKey, value: value === null ? floor : value } };
		}

		/**
		 * 账本里「已结算调用指纹」集合的容量上限。
		 *
		 * 为什么需要上限：`calls` 最多 MAX_CALLS(4000) 条，但账本跨会话存活期间可能累计更多。
		 * 超出后按**插入顺序**淘汰最老的（Map 保证插入序）—— 这不会造成重复计费：
		 * 被淘汰的指纹对应的调用早已滑出 `calls` 窗口（host 那边按 4000 条滚动），不会再出现在
		 * 后续快照里；万一真的又出现（极端情况下 host 重新回放），代价是这一条被再算一次，
		 * 而不是像旧实现那样**每一拍**都重复加 overflow + 队友。取 2×MAX_CALLS 留足余量。
		 */
		const SEEN_LIMIT = 8000;

		/**
		 * 「总计」的**增量式记账**（用户拍板的口径）：
		 *   **每条调用只算一次钱，算完就固化，之后永不重算**；
		 *   没价的模型记**欠账 token**，后来补上价了只补算这部分。
		 *
		 * 为什么必须换掉旧实现（「锁定基准 + 差值修正」，已删除）：它每拍都用**当前价**把全部历史
		 * 调用重算一遍，再用 `lockedCost` 把差额盖回去 —— 有三个必错的地方：
		 *   ① 锁的是"整笔显示金额"（含 overflow 与队友），而差值修正只重算 calls
		 *      ⇒ 那两块每一拍都被重复加一次（切会话时能把上个会话的队友花费永久算进来）；
		 *   ② 首帧算不出价时 `lockedCost` 被锁成 0 且永不重建 ⇒ 补价后总计永久显示 ¥0.00；
		 *   ③ 用**数组下标**（`lockedCount`）切分新旧，而 calls 满 MAX_CALLS 后会从队首丢弃
		 *      ⇒ 下标整体错位，扣错钱。
		 *
		 * 现在的做法：账本里记一份「已经结算过的调用指纹」集合，每拍只结算**没见过的**调用。
		 * 为什么用指纹而不是时间游标：`calls` **不保证按 at 升序**（实测 verify-pricing 里就是
		 * [22:00, 10:00, 10:00]），也不是只追加（MAX_CALLS 会从队首丢弃）—— 任何"只往后推游标"
		 * 的做法都会漏算乱序到达的调用。指纹对乱序、滚动窗口、同毫秒并行调用全部免疫。
		 *
		 * `hold`（调用方 ref 里那个对象，**就地更新**）的形状：
		 *   · `sessionId`      —— 这份账属于哪个会话；变了就把整份状态清空重建
		 *   · `seen`           —— 已结算调用的指纹集合（Map: 指纹 → true），见下面 ① 的说明
		 *   · `cost`           —— 已结算金额（累计，只增）
		 *   · `tokens`         —— 已结算的 token 三段（累计，只增）
		 *   · `priced`         —— 是否**成功定价过至少一条**（用来区分「真的是 0 元」与「一条都算不出价」）
		 *   · `subCostSettled` —— 已计入的队友金额（算增量用；队友是快照，没有逐条时间戳）
		 *   · `debts`          —— 欠账，**Map**：`模型名 → { peak: 桶|null, offPeak: 桶|null }`
		 *     （用 Map 而不是普通对象：模型名是上游给的任意字符串，`__proto__` 这类键
		 *      在普通对象上会变成设原型、静默丢失 —— 详见换会话清空处的说明）
		 *
		 * 返回 `{ cost, tokens, hold }`；`cost` 为 null 表示"一条都算不出价"（界面给横杠）。
		 *
		 * 输入就是**一个素材包**（calls / overflow / subCost / tokens / 价格库等），只有这一种形态。
		 */
		function applyTotalFloor(hold, sessionId, input) {
			const prev = hold !== null && hold !== undefined && typeof hold === "object" ? hold : null;
			const sameSession = prev !== null && prev.sessionId === sessionId;
			const snap = input !== null && input !== undefined && typeof input === "object" ? input : {};
			/* 账本就地更新：调用方持有的是 useRef 里同一个对象，跨渲染靠它留住累计值 */
			const box = prev !== null ? prev : {
				sessionId: null, seen: new Map(), cost: 0, tokens: null,
				priced: false, subCostSettled: 0, debts: new Map(),
				/* ① 用的**指纹缓存**（上一拍的 calls 数组 + 它的计数表 + 长度 + 当时的兜底模型）。
				   挂在账本盒子上而不是模块级变量：盒子是 useRef 里那个对象，组件卸载即回收，不泄漏。 */
				scanCalls: null, scanCounts: null, scanFirsts: null, scanLen: -1, scanFallback: undefined
			};
			/* 换会话（含首次）：整份状态清空。清空后 seen 为空，
			   下面那段"只结算没见过的调用"自然退化成"结算现有全部调用"，不必另写一套初始化。 */
			if (sameSession !== true) {
				box.sessionId = sessionId;
				box.seen = new Map();
				box.cost = 0;
				box.tokens = null;
				box.priced = false;
				box.subCostSettled = 0;
				/* 欠账必须用 **Map** 而不是普通对象：模型名是上游给的任意字符串，
				   用 `obj[model] = slot` 时若 model 恰好是 `__proto__`，那是**设置原型**、
				   不是加键 —— `Object.keys` 遍历不到它，补价时永远结算不回来，
				   总计会永久少算这笔钱（实测确认）。`constructor` / `toString` 这类
				   虽然"碰巧能跑"（读到原型函数、把函数当字典用），也不该依赖这种巧合。
				   Map 没有原型链，任意字符串键都安全 —— 与同文件 seen 的写法一致。 */
				box.debts = new Map();
			}
			/* 兼容老账本对象（升级前 ref 里可能还留着 debts: {} 的形态）：
			   就地换成 Map，把已有条目搬过去 —— ref 跨热更新存活时不会丢欠账。 */
			if (typeof Map !== "undefined" && (box.debts instanceof Map) !== true) {
				const migrated = new Map();
				const oldDebts = box.debts;
				if (oldDebts !== null && oldDebts !== undefined && typeof oldDebts === "object") {
					Object.keys(oldDebts).forEach((model) => {
						const slot = oldDebts[model];
						if (slot !== null && slot !== undefined && typeof slot === "object") migrated.set(model, slot);
					});
				}
				box.debts = migrated;
			}
			/* 把一段用量按"它发生时的档位"记进欠账，等有价了再结算 */
			const owe = (model, peak, bucket) => {
				if (bucket === null || bucket === undefined) return;
				const one = box.debts.get(model);
				const slot = one === undefined ? { peak: null, offPeak: null } : one;
				const key = peak === true ? "peak" : "offPeak";
				const had = slot[key];
				slot[key] = had === null || had === undefined
					? { input: bucket.input || 0, cacheRead: bucket.cacheRead || 0, cacheWrite: bucket.cacheWrite || 0, output: bucket.output || 0 }
					: {
						input: had.input + (bucket.input || 0),
						cacheRead: had.cacheRead + (bucket.cacheRead || 0),
						cacheWrite: had.cacheWrite + (bucket.cacheWrite || 0),
						output: had.output + (bucket.output || 0)
					};
				box.debts.set(model, slot);
			};
			const shown = (amount, model) => toDisplayCurrency(amount, snap.models, model, snap.displayCurrency, snap.defaultCurrency);

			/* ---------- ① 逐条结算「还没结算过」的调用 ---------- */
			/* 判据是**调用指纹 + 出现次数**，不用数组下标、也不用时间游标：
			   · 不用下标：calls 是滚动窗口，队首会随 MAX_CALLS 丢弃，下标会整体错位（旧实现在这里扣错钱）；
			   · 也不用时间游标：calls **不保证按 at 升序**（实测有 [22:00, 10:00, 10:00] 这种），
			     任何"只往后推游标"的写法都会把乱序到达的早期调用永久漏掉；
			   · 用**计数**而不是"见过/没见过"：同一毫秒可能有两条完全相同的并行调用
			     （at、model、token 数都一样），只记布尔会把第二条永久当成重复。
			     每拍数一遍每个指纹在 calls 里出现几次，与账本里已结算次数比，差额才补算。
			   指纹只增不减：调用滚出 calls 窗口后计数仍留着，同指纹再来时按已结算处理
			   （宁可极低概率地少算一条，也绝不重复计费）。
			   契约保证 usageCall.at 必有（host 侧 schema），缺 at 的坏数据跳过。 */
			const calls = Array.isArray(snap.calls) ? snap.calls : [];
			/* 第一遍：数每个指纹在这一拍的 calls 里出现几次 */
			const counts = new Map();
			const firsts = new Map();
			for (let i = 0; i < calls.length; i += 1) {
				const call = calls[i];
				if (call === null || call === undefined || typeof call !== "object") continue;
				const at = typeof call.at === "number" && Number.isFinite(call.at) ? call.at : null;
				if (at === null) continue;
				const model = typeof call.model === "string" ? call.model : snap.fallbackModel;
				const print = at + "|" + String(model) + "|" + (call.input || 0) + "|"
					+ (call.cacheRead || 0) + "|" + (call.cacheWrite || 0) + "|" + (call.output || 0);
				counts.set(print, (counts.has(print) === true ? counts.get(print) : 0) + 1);
				if (firsts.has(print) !== true) firsts.set(print, call);
			}
			/* 第二遍：与账本里「已结算次数」比，只补算差额部分 */
			counts.forEach((nowCount, print) => {
				const done = box.seen.has(print) === true ? box.seen.get(print) : 0;
				if (nowCount <= done) return;
				const call = firsts.get(print);
				const model = typeof call.model === "string" ? call.model : snap.fallbackModel;
				const at = call.at;
				/* 每条单价都一样，差额直接按条数乘；没价的按条数累进欠账 */
				const one = costOf(call, model, at);
				if (one === null) {
					for (let n = done; n < nowCount; n += 1) owe(model, isPeakTime(at), call);
				} else {
					box.cost += shown(one, model) * (nowCount - done);
					box.priced = true;
				}
				box.seen.set(print, nowCount);
				/* 超出上限就淘汰最老的（Map 插入序 = 结算顺序）：见 SEEN_LIMIT 的说明 */
				while (box.seen.size > SEEN_LIMIT) {
					const oldest = box.seen.keys().next();
					if (oldest.done === true) break;
					box.seen.delete(oldest.value);
				}
			});
			/* ---------- ② overflow：只加一次 ---------- */
			/* host 把被 MAX_CALLS 截掉的最老调用按「模型 + 峰谷档」累计好了。它没有逐条时间戳，
			   只能在**首次建立账本**那一拍计入一次 —— 之后每拍再加就是旧实现那个重复计费的错。 */
			if (sameSession !== true && snap.overflow !== null && snap.overflow !== undefined
				&& typeof snap.overflow === "object") {
				Object.keys(snap.overflow).forEach((model) => {
					const byTier = snap.overflow[model];
					if (byTier === null || byTier === undefined) return;
					const peak = costOfTier(byTier.peak, model, true);
					const offPeak = costOfTier(byTier.offPeak, model, false);
					if (peak === null) owe(model, true, byTier.peak); else { box.cost += shown(peak, model); box.priced = true; }
					if (offPeak === null) owe(model, false, byTier.offPeak); else { box.cost += shown(offPeak, model); box.priced = true; }
				});
			}

			/* ---------- ③ 补算欠账：现在能算价的按**当前价**结算，仍没价的留着 ---------- */
			box.debts.forEach((slot, model) => {
				if (slot === null || slot === undefined) { box.debts.delete(model); return; }
				let done = true;
				["peak", "offPeak"].forEach((key) => {
					const bucket = slot[key];
					if (bucket === null || bucket === undefined) return;
					const one = costOfTier(bucket, model, key === "peak");
					if (one === null) { done = false; return; }
					box.cost += shown(one, model);
					box.priced = true;
					slot[key] = null;
				});
				if (done === true && slot.peak === null && slot.offPeak === null) box.debts.delete(model);
			});

			/* ---------- ④ 队友（子智能体）：只能算增量 ---------- */
			/* 它是**快照**不是逐条调用，没有时间戳，没法按时间切分 —— 这是数据形状决定的限制。
			   用「当前队友金额 − 已计入的队友金额」算增量：请求偶发失败时当前值会掉回 0，
			   取 max(0, …) 就自动不回退（防闪照旧，且不会把队友的钱重复加）。 */
			const subCost = typeof snap.subCost === "number" && Number.isFinite(snap.subCost) ? snap.subCost : 0;
			const subSettled = typeof box.subCostSettled === "number" && Number.isFinite(box.subCostSettled)
				? box.subCostSettled
				: 0;
			if (subCost > subSettled) {
				box.cost += subCost - subSettled;
				box.subCostSettled = subCost;
				box.priced = true;
			}

			/* ---------- ⑤ token 三段：本会话 + 队友，只增不减 ---------- */
			const tokens = snap.tokens;
			if (tokens !== null && tokens !== undefined && typeof tokens === "object") {
				const had = box.tokens;
				box.tokens = had === null || had === undefined
					? { cached: tokens.cached || 0, missInput: tokens.missInput || 0, output: tokens.output || 0 }
					: {
						cached: Math.max(had.cached, tokens.cached || 0),
						missInput: Math.max(had.missInput, tokens.missInput || 0),
						output: Math.max(had.output, tokens.output || 0)
					};
			}
			return {
				/* 欠账部分**不计入显示**：它还没有价，算进去只能是错的；补价后会自动结算进来 */
				cost: box.priced === true ? box.cost : null,
				tokens: box.tokens,
				hold: box
			};
		}

		/** 本会话的令牌三段 + 队友的三段：同一个数字直接相加，不新增行。
		 *  两段都容忍 null / undefined（当 0）：「总计用量」要把官方投影 + 压缩摘要 + 队友
		 *  三段加起来，其中任一段在宿主老版本 / 没数据时都可能是 null。 */
		function mergeTokenParts(parts, sub) {
			const base = parts === null || parts === undefined ? { cached: 0, missInput: 0, output: 0 } : parts;
			const extra = sub === null || sub === undefined ? { cached: 0, missInput: 0, output: 0 } : sub;
			return {
				cached: (base.cached || 0) + (extra.cached || 0),
				missInput: (base.missInput || 0) + (extra.missInput || 0),
				output: (base.output || 0) + (extra.output || 0)
			};
		}

		/** 逐字段相减，得到两次全量用量之间的增量 —— 即本轮消耗。 */
		function diffUsage(current, base) {
			if (current === null || current === undefined || base === null || base === undefined) return null;
			return {
				input: Math.max(0, current.input - base.input),
				cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
				cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
				output: Math.max(0, current.output - base.output)
			};
		}

		function normalizeTier(rawTier) {
			const entry = rawTier === null || rawTier === undefined || typeof rawTier !== "object" ? {} : rawTier;
			return {
				input: tierValue(entry.input),
				cacheRead: tierValue(entry.cacheRead),
				cacheWrite: tierValue(entry.cacheWrite),
				output: tierValue(entry.output)
			};
		}
		/**
		 * 规范化价格库。`defaultCurrency` 是"这条目没写币种时用哪个"——
		 * 老配置里币种是**全局**的（`config.currency`），迁移时把它当默认值传给每个条目，
		 * 于是"原来全部按人民币计价"的语义原样保留、一个条目都不丢币种。
		 */
		function normalizeModels(rawModels, defaultCurrency) {
			const out = {};
			if (rawModels === null || rawModels === undefined || typeof rawModels !== "object") return out;
			const fallback = normalizeCurrency(defaultCurrency);
			const names = Object.keys(rawModels);
			for (let i = 0; i < names.length; i += 1) {
				const price = normalizePrice(rawModels[names[i]]);
				if (price === null) continue;
				const raw = rawModels[names[i]];
				out[names[i]] = {
					tiered: isTiered(raw),
					/* 条目自带的币种；没写就落到默认币种（迁移语义） */
					currency: raw !== null && raw !== undefined && raw.currency !== undefined && raw.currency !== null
						? normalizeCurrency(raw.currency)
						: fallback,
					peak: normalizeTier(price.peak),
					offPeak: normalizeTier(price.offPeak)
				};
			}
			return out;
		}

		/* 节点上"这条记录发生在什么时候"在不同来源里可能叫不同名字：几个都试一遍。
		   拿不到就返回 null —— 调用方据此判断"本轮起点未知"（`turnStartMs` 为 null），
		   于是本轮不并队友（本轮只能小不能大），总计照旧按整会话并。 */
		const NODE_TIME_KEYS = ["at", "time", "timestamp", "createdAt", "startedAt", "updatedAt", "ts", "timeMs", "timestampMs"];

		/** 一个节点上的时间戳（连常见嵌套位置一起找）；找不到返回 null。 */
		function nodeTimeOf(node) {
			const holders = [node, node.data, node.message, node.meta];
			for (let i = 0; i < holders.length; i += 1) {
				const holder = holders[i];
				if (holder === null || holder === undefined || typeof holder !== "object") continue;
				for (let k = 0; k < NODE_TIME_KEYS.length; k += 1) {
					const value = holder[NODE_TIME_KEYS[k]];
					if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
				}
			}
			return null;
		}

		/** 这一轮第一条记录的时间（该轮所有节点里最早的那个）；一个都拿不到返回 null。 */
		function turnStartOf(nodes, turn) {
			let min = null;
			for (let i = 0; i < nodes.length; i += 1) {
				const node = nodes[i];
				if (node === null || node === undefined) continue;
				if (node.kind !== "assistant" || node.turn !== turn) continue;
				const at = nodeTimeOf(node);
				if (at === null) continue;
				if (min === null || at < min) min = at;
			}
			return min;
		}

		/**
		 * 把会话节点里**最后一轮**的用量折出来（节点带 turn 号与这条调用的 usage）。
		 * 返回 `{ turn, parts, at }`，没有可用节点时返回 null —— 轮号一起返回是为了让调用方
		 * 判断这份数据属于当前进行中的那一轮，还是上一轮（不能靠"往后跳一轮"猜，
		 * 当前轮还没产出节点时那样会错位到上上轮）。`at` 是这一轮第一条记录的时间，
		 * 用来问 host"本轮窗口内队友用了多少"；节点不带时间戳时为 null。
		 */
		function foldTurnUsage(nodes) {
			if (!Array.isArray(nodes)) return null;
			const turns = [];
			for (const node of nodes) {
				if (node === null || node === undefined) continue;
				if (node.kind !== "assistant") continue;
				if (typeof node.turn !== "number") continue;
				if (turns.indexOf(node.turn) === -1) turns.push(node.turn);
			}
			if (turns.length === 0) return null;
			turns.sort((a, b) => a - b);
			const target = turns[turns.length - 1];
			const acc = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let found = false;
			for (const node of nodes) {
				if (node === null || node === undefined) continue;
				if (node.kind !== "assistant" || node.turn !== target) continue;
				const usage = node.usage;
				if (usage === null || usage === undefined || typeof usage !== "object") continue;
				acc.input += usage.inputTokens || 0;
				acc.cacheRead += usage.cacheReadTokens || 0;
				acc.cacheWrite += usage.cacheWriteTokens || 0;
				acc.output += usage.outputTokens || 0;
				found = true;
			}
			return found ? { turn: target, parts: acc, at: turnStartOf(nodes, target) } : null;
		}

		/* ---------------------------------------------------------------- i18n */
		const zh = {
			nav: "状态栏",
			updatePill: "发现新版本",
			updateTo: "更新 {version} 版本",
			updateRunning: "正在更新中",
			updateFailed: "更新失败",
			updateDone: "更新成功，重启 DSH 后生效",
			/* 开发模式：连点版本号 5 次进入。不做成可见控件 —— 它面向作者调试，
			   普通用户装了插件也不该看到一个「预览」勾选框。进入后标题右侧挂一枚胶囊。 */
			devModeBadge: "开发模式",
			devModeHint: "开发模式：点更新按钮只演示状态，不会真的安装",
			sectionTitle: "状态栏设置",
			intro: "接管对话区底部的统计行。勾选要显示的字段、拖动调整顺序或配置模型费用单价。",
			segContext: "上下文占用",
			segContextHint: "上下文占用明细与压缩阈值。",
			segStatus: "峰谷判断",
			segCounts: "轮次＆步数",
			segTtft: "首字延迟",
			segCacheHit: "缓存命中率",
			segTps: "输出速度",
			segSessionTime: "运行用时",
			segCost: "会话费用",
			segLastCost: "本次费用",
			segBalance: "余额",
			/* 缺数据段的气泡标题与说明（空态也必须点得开，见 emptySegmentTip）。
			   `{label}` 换成该段自己的名字，一个键服务九段。 */
			tipEmptyTitle: "{label}",
			tipEmptyBody: "该字段当前没有数据。开发模式下点开它会推进到下一组假数据场景，不会停在这一态。",
			f_peak: "高峰",
			f_valley: "低谷",
			f_counts: "{turns} 轮 {steps} 步",
			f_ttft: "首字平均 {duration}",
			f_cacheHit: "综合命中 {percent}%",
			f_tokensHit: "输入(命中缓存)",
			f_tokensMiss: "输入(未命中缓存)",
			f_tokensOut: "输出",
			f_tokensTotal: "总计用量",
			f_tokensTurn: "本轮用量",
			tipModelTime: "模型用时",
			tipWaitTime: "等待用时",
			tipToolTime: "工具调用",
			tipTtftTurn: "本轮平均首字",
			tipTtftFast: "最快首字延迟",
			tipTtftSlow: "最慢首字延迟",
			tipTpsTurn: "本轮平均速度",
			tipTpsFast: "最快输出速度",
			tipTpsSlow: "最慢输出速度",
			tipTopUp: "充值余额",
			tipGranted: "赠金余额",
			tipQuotaLeft: "剩余配额",
			tipHitTurn: "本轮命中率",
			tipHitHigh: "最高命中率",
			tipHitLow: "最低命中率",
			tipCountsTitle: "会话数据",
			tipCountsSkills: "技能注入",
			tipCountsCompactAt: "上下文压缩",
			tipCountsToolCalls: "工具调用",
			/* 手动调用 / 手动压缩那行星号的悬停说明：星号自己 aria-hidden，含义靠这句文字给 */
			tipManual: "手动触发",
			/* 子能力（技能的子文档被读取）名字**后面**那个 † 角标的读屏文案。
			   必须与 tipManual 分开说 —— 让读屏用户也能分清"我手动敲的"与"模型自己去读的子能力"。 */
			tipSub: "子能力",
			/* 压缩明细逐条列时的两段：序号用中文序数（第一次 / 第二次），落点用「第X轮Y步」 */
			tipCompactItem: "第{index}次压缩",
			tipCompactWhere: "第{turn}轮{step}步",
			tipCompactTurnOnly: "第{turn}轮",
			/* 手动 / 轮间压缩没有 turn，用「发生在第几轮之后」给落点（afterTurn） */
			tipCompactAfter: "第{turn}轮后",
			contextAria: "上下文已用 {percent}",
			contextSystem: "系统提示词",
			contextTools: "工具定义",
			contextMessages: "对话消息",
			f_speed: "综合速度 {throughput}t/s",
			f_sessionTime: "总用时 {duration}",
			f_cost: "总计 {symbol}{cost}",
			priceTierPeak: "高峰时段",
			priceTierOffPeak: "空闲时段",
			priceTierAllDay: "全时段",
			f_balanceDash: "余额 {symbol}-",
			f_lastCost: "本轮 {symbol}{cost}",
			f_balance: "余额 {symbol}{amount}",
			f_balanceSubCent: "余额 <{symbol}0.01",
			/* WorkBuddy 积分口径的套餐气泡（只在宿主给了非空 rewards 时出现）。
			   标题用中性词「积分套餐」：列表里第一条是月度基础包，不都是「平台奖励」。 */
			tipCreditsTitle: "积分套餐",
			tipCreditsMonthly: "（每月刷新）",
			tipCreditsRefresh: " · {date} 刷新",
			tipCreditsExpire: " · {date} 到期",
			tipCreditsRefreshLatest: " · {date} 刷新(最近)",
			tipCreditsExpireLatest: " · {date} 到期(最近)",
			tipCreditsLeft: "剩余 {left} / {total}",
			dragHint: "拖动排序",
			secSegments: "统计字段",
			secSegmentsHint: "勾选显示；按住拖动调整顺序。",
			secPrices: "自定义模型价格",
			secPricesHint: "填写你使用的模型单价（每百万 tokens）。",
			segStatusHint: "自动判断当前的峰谷时段。",
			tipWeekTitle: "活跃总览",
			hoverCalls: "API请求次数",
			hoverCost: "消费金额",
			hoverYearAll: "全年",
			segCountsHint: "当前会话的总轮次与执行步数。",
			segTtftHint: "首字的平均延迟。",
			segCacheHitHint: "当前会话的平均缓存命中率。",
			segTpsHint: "token 的每秒平均输出速度。",
			segSessionTimeHint: "当前会话的总计运行时间。",
			segCostHint: "当前会话估算消耗费用，包含主模型、子代理和辅助调用。",
			segLastCostHint: "当前或最近一轮交流的估算消耗费用，包含主模型、子代理和辅助调用。",
			segBalanceHint: "账户余额，每分钟刷新。",
			priceCurrent: "当前会话使用：",
			modelUnknown: "未识别",
			unitCountTurns: " 轮",
			unitCountSteps: " 步",
			unitCountCalls: " 次",
			unitSpeed: "t/s",
			priceSuggestedHint: "价格库正使用官方参考价。",
			priceNewModel: "自定义模型",
			priceAdd: "添加",
			priceEmpty: "价格库为空 —— 输入模型名（如 deepseek-flash）后点添加。",
			priceRemove: "删除",
			priceInput: "输入(缓存未命中)",
			priceCacheRead: "输入(缓存命中)",
			priceOutput: "输出",
			priceTiered: "峰谷计价",
			priceEdit: "修改",
			priceSave: "保存",
			reset: "恢复默认设置",
			holidayUpdate: "更新节假峰谷",
			starRepo: "GitHub支持",
			starTip: "你的支持是我最大的动力！请帮我点亮Star吧~",
			holidayUpdateBusy: "正在搜索节假安排...",
			holidayUpdateOk: "已写入 {year} 年 {count} 个节假日",
			holidayUpdateFail: "抓取失败（{reason}），检查网络后重试",
			holidayUpdateNoRoute: "状态栏后台还是旧版：完全退出并重启 DSH 后再点"
		};
		const en = {
			nav: "Status Bar",
			updatePill: "Update available",
			updateTo: "Update to {version}",
			updateRunning: "Updating",
			updateFailed: "Update failed",
			updateDone: "Update succeeded — restart DSH to apply",
			devModeBadge: "Dev mode",
			devModeHint: "Dev mode: the update button only simulates states — nothing is installed",
			sectionTitle: "Status Bar Settings",
			intro: "Replaces the stats line under the message input. Select the fields to show, drag to reorder, or set model prices.",
			segContext: "Context usage",
			segContextHint: "Context occupancy breakdown and compaction threshold.",
			segStatus: "Peak / off-peak check",
			segCounts: "Turns & steps",
			segTtft: "Time to first token",
			segCacheHit: "Cache hit rate",
			segTps: "Tokens per second",
			segSessionTime: "Run time",
			segCost: "Session cost",
			segLastCost: "This turn cost",
			segBalance: "Balance",
			/* 缺数据段的气泡标题与说明（见中文那份的同名键） */
			tipEmptyTitle: "{label}",
			tipEmptyBody: "This field has no data right now. In dev mode, opening it advances to the next fixture scene instead of trapping you here.",
			f_peak: "Peak",
			f_valley: "Off-peak",
			f_counts: "{turns} Turns · {steps} Steps",
			f_ttft: "TTFT {duration}",
			f_cacheHit: "Combined hit {percent}%",
			f_tokensHit: "input (cache hit)",
			f_tokensMiss: "input (cache miss)",
			f_tokensOut: "output",
			f_tokensTotal: "Total usage",
			f_tokensTurn: "This turn usage",
			tipModelTime: "Model time",
			tipWaitTime: "Wait time",
			tipToolTime: "Tool calls",
			tipTtftTurn: "Average TTFT this turn",
			tipTtftFast: "Fastest TTFT",
			tipTtftSlow: "Slowest TTFT",
			tipTpsTurn: "Average TPS this turn",
			tipTpsFast: "Fastest TPS",
			tipTpsSlow: "Slowest TPS",
			tipTopUp: "Top-up balance",
			tipGranted: "Granted balance",
			tipQuotaLeft: "Quota left",
			tipHitTurn: "Hit rate this turn",
			tipHitHigh: "Highest hit rate",
			tipHitLow: "Lowest hit rate",
			tipCountsTitle: "Session data",
			tipCountsSkills: "Skills injected",
			tipCountsCompactAt: "Context compactions",
			tipCountsToolCalls: "Tool calls",
			/* 星号的悬停说明（见中文那份的同名键） */
			tipManual: "Manually invoked",
			/* 子能力角标的读屏文案（见中文那份的 tipSub） */
			tipSub: "Sub-skill",
			/* 压缩明细逐条列时的两段：英文直接用阿拉伯数字，落点「Turn X·Step Y」 */
			tipCompactItem: "Compaction {index}",
			tipCompactWhere: "Turn {turn}·Step {step}",
			tipCompactTurnOnly: "Turn {turn}",
			tipCompactAfter: "After turn {turn}",
			contextAria: "{percent} of context used",
			contextSystem: "System prompt",
			contextTools: "Tool definitions",
			contextMessages: "Messages",
			f_speed: "TPS {throughput}t/s",
			f_sessionTime: "Time {duration}",
			f_cost: "Total {symbol}{cost}",
			priceTierPeak: "Peak",
			priceTierOffPeak: "Off-peak",
			priceTierAllDay: "All day",
			f_lastCost: "This turn {symbol}{cost}",
			f_balance: "Balance {symbol}{amount}",
			f_balanceSubCent: "Balance <{symbol}0.01",
			/* 积分口径的套餐气泡（见中文那份的同名键） */
			tipCreditsTitle: "Points packages",
			tipCreditsMonthly: " (monthly)",
			tipCreditsRefresh: " · refreshes {date}",
			tipCreditsExpire: " · expires {date}",
			tipCreditsRefreshLatest: " · refreshes {date} (nearest)",
			tipCreditsExpireLatest: " · expires {date} (nearest)",
			tipCreditsLeft: "{left} / {total} left",
			dragHint: "Drag to reorder",
			secSegments: "Stats fields",
			secSegmentsHint: "Select to show; drag to reorder.",
			secPrices: "Custom model prices",
			secPricesHint: "Prices per million tokens.",
			segStatusHint: "Automatically determines the current peak / off-peak window.",
			tipWeekTitle: "Activity overview",
			hoverCalls: "API calls",
			hoverCost: "Cost",
			hoverYearAll: "full year",
			segCountsHint: "Total turns and executed steps of the current session.",
			segTtftHint: "Average time to the first token.",
			segCacheHitHint: "Average cache hit rate of the current session.",
			segTpsHint: "Average output rate, in tokens per second.",
			segSessionTimeHint: "Total run time of the current session.",
			segCostHint: "Estimated session cost, including the main model, subagents, and helper calls.",
			segLastCostHint: "Estimated cost of the current or most recent turn, including the main model, subagents, and helper calls.",
			segBalanceHint: "Account balance, refreshed every minute.",
			priceCurrent: "Current session:",
			modelUnknown: "unknown",
			unitCountTurns: " turns",
			unitCountSteps: " steps",
			unitCountCalls: " calls",
			unitSpeed: "t/s",
			priceSuggestedHint: "The price book uses the DeepSeek reference prices.",
			f_balanceDash: "Balance {symbol}-",
			priceNewModel: "Custom model",
			priceAdd: "Add",
			priceEmpty: "Price book is empty — type a model name (e.g. deepseek-flash) and click Add.",
			priceRemove: "Remove",
			priceInput: "Input (cache miss)",
			priceCacheRead: "Input (cache hit)",
			priceOutput: "Output",
			priceTiered: "Peak / off-peak pricing",
			priceEdit: "Edit",
			priceSave: "Save",
			reset: "Reset settings",
			holidayUpdate: "Update holidays",
			starRepo: "Support on GitHub",
			starTip: "Your support means a lot to me — please give it a star!",
			holidayUpdateBusy: "Searching the holiday schedule...",
			holidayUpdateOk: "Wrote {count} holidays for {year}",
			holidayUpdateFail: "Fetch failed ({reason}); check the network and retry",
			holidayUpdateNoRoute: "The status bar backend is still the old build — fully quit and restart DSH, then try again"
		};

		/* --------------------------------------------------------------- 段定义
		 * array 顺序即底栏渲染顺序，也是出厂默认顺序；全部段默认勾选。
		 * 「恢复默认设置」按此重排并全选，与设置页截图一致。 */
		const SEGMENTS = [
			{ id: "status", label: "segStatus", hint: "segStatusHint", def: true, short: { zh: "峰谷", en: "Period" } },
			{ id: "counts", label: "segCounts", hint: "segCountsHint", def: true, short: { zh: "轮次/步数", en: "Turns/steps" } },
			{ id: "cacheHit", label: "segCacheHit", hint: "segCacheHitHint", def: true, short: { zh: "综合命中", en: "Combined hit" } },
			{ id: "tps", label: "segTps", hint: "segTpsHint", def: true, short: { zh: "综合速度", en: "TPS" } },
			{ id: "ttft", label: "segTtft", hint: "segTtftHint", def: true, short: { zh: "首字平均", en: "TTFT" } },
			{ id: "sessionTime", label: "segSessionTime", hint: "segSessionTimeHint", def: true, short: { zh: "总用时", en: "Time" } },
			{ id: "lastCost", label: "segLastCost", hint: "segLastCostHint", def: true, short: { zh: "本轮", en: "This turn" } },
			{ id: "cost", label: "segCost", hint: "segCostHint", def: true, short: { zh: "总计", en: "Total" } },
			{ id: "balance", label: "segBalance", hint: "segBalanceHint", def: true, short: { zh: "余额", en: "Balance" } }
		];
		const KNOWN = {};
		SEGMENTS.forEach((s) => { KNOWN[s.id] = true; });
		/** 出厂默认：全部段，顺序 = 上方 SEGMENTS 声明顺序。 */
		const DEFAULT_SEGMENTS = SEGMENTS.filter((s) => s.def).map((s) => s.id);

		/* --------------------------------------------------------------- store */
		/** 读配置：新键优先；只有旧键时把内容搬到新键再用（旧键保留）。 */
		function readStored() {
			const current = window.localStorage.getItem(STORAGE_KEY);
			if (current !== null) return current;
			const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
			if (legacy === null) return null;
			try { window.localStorage.setItem(STORAGE_KEY, legacy); } catch (error) { /* 隐私模式：仅内存生效 */ }
			return legacy;
		}
		function loadConfig() {
			const fallback = {
				version: CONFIG_VERSION,
			priceConfigured: false,
				contextMeter: true,
				segments: DEFAULT_SEGMENTS.slice(),
				hidden: [],
				currency: "CNY",
				models: normalizeModels(DEFAULT_PRICES, "CNY"),
				modelOrder: Object.keys(DEFAULT_PRICES),
				holidayDays: []
			};
			try {
				const raw = readStored();
				if (raw === null) return fallback;
				const parsed = JSON.parse(raw);
				const stored = Array.isArray(parsed.segments)
					? parsed.segments.filter((id) => KNOWN[id] === true)
					: fallback.segments.slice();
				const version = typeof parsed.version === "number" ? parsed.version : 1;
				const hiddenStored = Array.isArray(parsed.hidden)
					? parsed.hidden.filter((id) => KNOWN[id] === true)
					: [];
				if (version < 6) {
					/* v5 及更早：segments 只存已勾选的段。未勾选的按出厂顺序补到末尾并标记为未勾选。 */
					DEFAULT_SEGMENTS.forEach((id) => {
						if (stored.indexOf(id) === -1) {
							stored.push(id);
							if (hiddenStored.indexOf(id) === -1) hiddenStored.push(id);
						}
					});
				}
				/* 不变量：段序覆盖全部段；hidden 只表示勾选状态 */
				DEFAULT_SEGMENTS.forEach((id) => {
					if (stored.indexOf(id) === -1) stored.push(id);
				});
				const hidden = hiddenStored.filter((id) => stored.indexOf(id) !== -1);
				/* 计价单位：只认 CNY / USD，其它值一律当人民币。
				   迁移后它只是"**新增条目的默认币种**"—— 已有条目各自带币种
				   （`models[name].currency`），任何选择器都不许再改写它们。 */
				const currency = parsed.currency === "USD" ? "USD" : "CNY";
				const reference = referencePrices(currency);
				/* 价格库落后于参考价版本时并入官方价；用户自己改过的条目不覆盖 */
				/* 价格库为空或全 0 时直接用内嵌官方价（自愈，无需手动填） */
				if (pricesMissing(normalizeModels(parsed.models, currency))) parsed.models = Object.assign({}, reference);
				const priceVersion = typeof parsed.priceVersion === "number" ? parsed.priceVersion : 0;
				/* 价格库落后于参考价版本时并入官方价：**官方价打底、用户条目优先** ——
				   官方新增的模型补进来，但用户已经存在的条目（改过价的、明确填 0 的）一律不动。
				   原来把 reference 写在后面，结果是官方价盖掉用户改过的同名条目，
				   与上面那句"用户自己改过的条目不覆盖"正好相反（实测缺陷，用户确认要修）。 */
				const models = priceVersion < PRICE_VERSION
					? normalizeModels(Object.assign({}, reference, parsed.models), currency)
					: normalizeModels(parsed.models, currency);
				/* 旧版取消勾选「峰谷计价」时会把空闲价写成高峰价的副本，再勾回来也回不去。
				   这里按参考价补回：只修"勾着峰谷计价、两档却完全相同"的官方模型。 */
				Object.keys(reference).forEach((name) => {
					const one = models[name];
					if (one === undefined || one === null || one.tiered !== true) return;
					if (!sameTier(one.peak, one.offPeak)) return;
					if (sameTier(reference[name].peak, reference[name].offPeak)) return;
					one.offPeak = Object.assign({}, reference[name].offPeak);
				});
				const priceConfigured = parsed.priceConfigured === true || priceVersion >= PRICE_VERSION;
				/* 模型顺序：显式数组（整数样式的键会被 Object.keys 排到最前，不能靠对象键序） */
				const modelOrder = [];
				(Array.isArray(parsed.modelOrder) ? parsed.modelOrder : []).forEach((name) => {
					if (typeof name === "string" && models[name] !== undefined && modelOrder.indexOf(name) === -1) modelOrder.push(name);
				});
				Object.keys(models).forEach((name) => {
					if (modelOrder.indexOf(name) === -1) modelOrder.push(name);
				});
				return {
					version: CONFIG_VERSION,
					contextMeter: parsed.contextMeter !== false,
					segments: stored,
					hidden: hidden,
					currency: currency,
					priceVersion: PRICE_VERSION,
					priceConfigured: priceConfigured,
					models: Object.keys(models).length > 0 ? models : normalizeModels(reference, currency),
					modelOrder: modelOrder.length > 0 ? modelOrder : Object.keys(reference),
					/* 抓来的放假日历：字符串数组，按年分组在 refreshHolidays() 里做 */
					holidayDays: Array.isArray(parsed.holidayDays)
						? parsed.holidayDays.filter((day) => typeof day === "string" && day.length === 10)
						: []
				};
			} catch (error) {
				return fallback;
			}
		}

		let config = loadConfig();
		refreshHolidays();
		const listeners = new Set();
		function subscribe(fn) {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		}
		function snapshot() { return config; }
		function setConfig(patch) {
			config = Object.assign({ version: CONFIG_VERSION }, config, patch);
			refreshHolidays();
			try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch (error) { /* 隐私模式下仅内存生效 */ }
			listeners.forEach((fn) => { try { fn(); } catch (error) { /* 单个订阅者失败不影响其余 */ } });
		}
		function useConfig() {
			return react.useSyncExternalStore(subscribe, snapshot, snapshot);
		}
		/** 勾选只切换显示：段序不动，取消勾选的段留在原位。 */
		function toggleSegment(id, on) {
			const hidden = (Array.isArray(config.hidden) ? config.hidden : []).filter((x) => x !== id);
			if (on !== true) hidden.push(id);
			setConfig({ hidden: hidden });
		}

		/**
		 * 官方内置价：某个价格键在**两套官方参考价表**里都有时，给出"该币种那一套定死的数字"。
		 *
		 * **判定规则**（与用户确认过）：键名必须**逐字**同时命中 `DEFAULT_PRICES` 与
		 * `DEFAULT_PRICES_USD`（不做模糊匹配 —— 用户自建的键、或官方表里没有的键一律算"非内置"）。
		 * 返回 `{ CNY: { peak, offPeak }, USD: { peak, offPeak } }`，找不到返回 `null`。
		 */
		function officialPair(name) {
			const cny = DEFAULT_PRICES[name];
			const usd = DEFAULT_PRICES_USD[name];
			if (cny === undefined || cny === null || usd === undefined || usd === null) return null;
			return {
				CNY: { peak: normalizeTier(cny.peak), offPeak: normalizeTier(cny.offPeak) },
				USD: { peak: normalizeTier(usd.peak), offPeak: normalizeTier(usd.offPeak) }
			};
		}

		/**
		 * 改**某一个模型条目**的币种。**不乘除任何比率** —— 数值只有两种去向：
		 *
		 * ① **官方内置且没被改过**（键同时命中两套官方表，且当前两档数字逐格等于该币种那一套官方值）
		 *    → 直接换成**官方另一套定死的数字**（逐字段等于目标币种的官方值）。用户的说法：
		 *    "默认两个模型的美元价格和人民币价格是定死的呀，你怎么能自己去按汇率切换呢"。
		 * ② 其余（用户自建的键、官方没有的键、或**被改过数值**的条目）→ **数值一个字都不动**，
		 *    只改 `currency` 标记 —— 另一种币种该填多少由用户自己填，工具不替他算。
		 *    "改过数值"就是这么识别的：拿当前两档跟当前币种的官方值逐格比，不一致即视为改过。
		 *
		 * 只动这一个条目：其它条目、台账、历史数字、`config.currency` 全都不动。
		 *
		 * `draftNow` 是**正在编辑的草稿**（可省）。"改没改过"必须看**用户此刻在框里看到的值**，
		 * 不能只看库里的值：用户改了价还没保存就切币种时，库里的值仍是旧的官方值，
		 * 会误判成"没改过"→ 整条换成官方另一套 → 用户刚填的数字被清空（实测反馈）。
		 *
		 * 返回 `{ entry, replaced }`；没变化返回 `null`。
		 * `replaced === true`（官方内置、且草稿仍是该币种的官方值）→ 整条换成官方另一套，
		 * 调用方必须按新数字重建草稿；否则数值一个字没动，调用方只该换草稿的币种标记，
		 * **保住用户还没保存的输入**。
		 */
		function setModelCurrency(name, code, draftNow) {
			const entry = config.models === undefined || config.models === null ? null : config.models[name];
			if (entry === null || entry === undefined) return null;
			const from = entry.currency === undefined || entry.currency === null ? normalizeCurrency(config.currency) : normalizeCurrency(entry.currency);
			const to = normalizeCurrency(code);
			if (from === to) return null;
			const official = officialPair(name);
			const current = { peak: normalizeTier(entry.peak), offPeak: normalizeTier(entry.offPeak) };
			/* 草稿里的格子是字符串（`""` = 没填），`normalizeTier` 用同一套 `tierValue` 口径转成
			   null / 数字 —— 与保存时落库的口径必须一致，否则"算不算改过"会和落库结果打架。 */
			const shown = draftNow === null || draftNow === undefined
				? current
				: { peak: normalizeTier(draftNow.peak), offPeak: normalizeTier(draftNow.offPeak) };
			const isPristineOfficial = official !== null
				&& sameTier(shown.peak, official[from].peak) && sameTier(shown.offPeak, official[from].offPeak);
			const next = {
				tiered: isPristineOfficial === true ? true : entry.tiered !== false,
				currency: to,
				peak: isPristineOfficial === true ? Object.assign({}, official[to].peak) : current.peak,
				offPeak: isPristineOfficial === true ? Object.assign({}, official[to].offPeak) : current.offPeak
			};
			const models = Object.assign({}, config.models);
			models[name] = next;
			setConfig({ models: models });
			return { entry: next, replaced: isPristineOfficial === true };
		}

		/**
		 * 「恢复默认」要写回的价格库（**分两类**，两条要求同时满足）：
		 *
		 * ① **官方内置**（键在 `DEFAULT_PRICES` 里命中）→ 恢复成**官方默认值**：逐字段等于
		 *    官方表（`tiered` 与峰谷两档一起，连官方写的 `0`/`null` 也照抄），币种回 **CNY**；
		 *    **被删掉的官方条目会被加回来**；顺序按官方表顺序排在**前面**。
		 *    **取舍**：用户改过某个官方模型的价格，恢复默认会把它覆盖回官方价 —— 这就是
		 *    "恢复默认"的语义；想留住自定义价就别用官方键（换个名字建自建条目）。
		 * ② **用户自建**（键不在官方表里）→ **原样保留**：数值、档位、`currency` 逐字段不变
		 *    （含用户明确填的 0），顺序跟在官方条目之后、保持原来的相对顺序。
		 *
		 * 判定与顺序（三条口径）：
		 *   · "官方内置"以 **`DEFAULT_PRICES` 的键**为准 —— 它才代表"官方默认价"这一集合；
		 *     （`DEFAULT_PRICES` 与 `DEFAULT_PRICES_USD` 的键集合**完全一致**，见 lib 顶部两张表，
		 *     所以不需要取并集。哪天两张表键集合不同了，这里要改成并集。）
		 *   · 官方顺序 = **`Object.keys(DEFAULT_PRICES)` 的字面顺序**，不另外定义一套；
		 *   · `modelOrder` = 官方键（官方顺序）在前 + 保留下来的自建键（原相对顺序）在后。
		 *     **用户在官方键上的排序调整会被覆盖**（"恢复默认"的语义），自建键的相对顺序保留。
		 *
		 * 只产出配置内容，不碰台账、不换算任何历史数字。
		 */
		function resetPriceBook() {
			const models = {};
			/* ① 官方：固定顺序、固定值 */
			Object.keys(DEFAULT_PRICES).forEach((name) => {
				const official = DEFAULT_PRICES[name];
				models[name] = {
					tiered: true,
					currency: "CNY",
					peak: normalizeTier(official.peak),
					offPeak: normalizeTier(official.offPeak)
				};
			});
			/* ② 自建：原样搬过来（顺序取 modelOrder 的相对顺序，不在其中的补在后面） */
			const source = config.models === undefined || config.models === null ? {} : config.models;
			const modelOrder = Object.keys(DEFAULT_PRICES).slice();
			const walk = (Array.isArray(config.modelOrder) ? config.modelOrder : []).concat(Object.keys(source));
			walk.forEach((name) => {
				if (models[name] !== undefined || modelOrder.indexOf(name) !== -1) return;
				const entry = source[name];
				if (entry === undefined || entry === null) return;
				models[name] = {
					tiered: entry.tiered !== false,
					currency: entry.currency === undefined || entry.currency === null
						? normalizeCurrency(config.currency)
						: normalizeCurrency(entry.currency),
					peak: normalizeTier(entry.peak),
					offPeak: normalizeTier(entry.offPeak)
				};
				modelOrder.push(name);
			});
			return { models: models, modelOrder: modelOrder };
		}

		/** 该段是否勾选显示：在段序里且不在 hidden 里。 */
		function isSegmentOn(cfg, id) {
			if (Array.isArray(cfg.segments) && cfg.segments.indexOf(id) === -1) return false;
			return !(Array.isArray(cfg.hidden) && cfg.hidden.indexOf(id) !== -1);
		}
		/**
		 * 拖动中算落点：浮层的下边界压过哪一行的中线，影子就往下滑到那一行；
		 * 上边界举过哪一行的中线，就往上滑。
		 * slots 是按下那一刻按原始顺序量下的各行矩形，shift 是这期间页面滚动的位移
		 * （每次移动都重新量锚点得到）—— 直接用真实矩形，行距里有没有 gap、
		 * 某行是不是比别人高，都不影响判定。
		 */
		function dropIndexAt(slots, shift, from, top, bottom) {
			let to = from;
			for (let i = from + 1; i < slots.length; i += 1) {
				const rect = slots[i];
				if (rect === null || rect === undefined) continue;
				if (bottom <= rect.top + shift + rect.height / 2) break;
				to = i;
			}
			for (let i = from - 1; i >= 0; i -= 1) {
				const rect = slots[i];
				if (rect === null || rect === undefined) continue;
				if (top >= rect.top + shift + rect.height / 2) break;
				to = i;
			}
			return to;
		}

		/** 把 from 位置的元素挪到 to 位置（不动原数组）。 */
		function moveItem(list, from, to) {
			const next = list.slice();
			next.splice(to, 0, next.splice(from, 1)[0]);
			return next;
		}

		/* ---------------------------------------------------------------- 工具 */
		/** 精确 token 数：每三位一个逗号（面板明细用）。 */
		function formatTokensExact(value) {
			const n = Math.max(0, Math.round(Number(value) || 0));
			const digits = String(n);
			let out = "";
			for (let i = 0; i < digits.length; i += 1) {
				if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
				out += digits[i];
			}
			return out;
		}

		/**
		 * token 数自适应短格式：1,000,000 → 1M、2,000,000 → 2M、1,050,000 → 1.05M。
		 * 整数不带小数，有小数最多两位且去掉尾随 0；上下文窗口这类"整刻度"数字用它。
		 */
		function formatTokensShort(value) {
			const n = Math.max(0, Number(value) || 0);
			const trim = (x) => String(Number(x.toFixed(2)));
			if (n >= 1e9) return trim(n / 1e9) + "B";
			if (n >= 1e6) return trim(n / 1e6) + "M";
			if (n >= 1e3) return trim(n / 1e3) + "K";
			return String(Math.round(n));
		}
		/** 秒级时长，保留一位小数（首字延迟这类不会超过一分钟的指标用）。 */
		/* ------------------------------------------------ 上下文占用（对齐官方口径） */
		/** 圆环几何：与官方 ContextMeter 一致（14px viewBox、2px 描边、半径 5.5） */
		const METER_RADIUS = 5.5;
		const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS;
		/** 描边宽度，与 CSS 里 .dsb-ring-track / .dsb-ring-fill 的 stroke-width 同值，改一处要同步另一处。 */
		const METER_STROKE_PX = 2;
		/** 官方把本地化句子从占位槽切开，好让百分比单独上色（中英词序不同） */
		const READING_SLOT = "\u0000";
		/** 构成三行：系统提示词 / 工具定义 / 对话消息，颜色与官方 ContextMeter 相同 */
		const METER_ROWS = [
			{ key: "systemTokens", label: "contextSystem", color: "var(--dsw-static-neutral-bluish-400)" },
			{ key: "toolsTokens", label: "contextTools", color: "#a78bfa" },
			{ key: "messageTokens", label: "contextMessages", color: "var(--dsw-static-blue-450)" }
		];

		/**
		 * 官方口径（ui-conversation 的 contextOccupancy）：
		 * 占用 = 下一次请求预计的 prompt（projectedTokens，缺省退回 provider 最近报告的 pressureTokens）
		 *        ÷ 上下文窗口，四舍五入，封顶 100%；两个数缺一个就返回 null。
		 */
		function contextOccupancy(pressure) {
			if (pressure === null || pressure === undefined) return null;
			const usedTokens = pressure.projectedTokens !== undefined && pressure.projectedTokens !== null
				? pressure.projectedTokens
				: pressure.pressureTokens;
			if (usedTokens === undefined || usedTokens === null) return null;
			if (pressure.contextWindow === undefined || pressure.contextWindow === null) return null;
			return {
				percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
				usedTokens: usedTokens,
				contextWindow: pressure.contextWindow
			};
		}

		/**
		 * 上下文压缩触发点占窗口的百分比。官方公式：
		 *   floor(min(窗口 × thresholdRatio, 窗口 − 本次请求输出上限 − headroomTokens))
		 * 两处独立印证：@deepseek-ai/dsh-compaction-basic 的 lib/index.js（resolveCompactSpec）
		 * 与同包 README.zh.md；本机 11 次真实压缩事件回验，触发点与公式最大偏差 0.6%
		 * （deepseek 1M 窗口 / 384K 输出 → 550,464，即 55.0%）。
		 * 两个比例取包默认值：thresholdRatio 虽可在 agent preset 的 compaction-basic.config 里覆盖，
		 * 但会话日志不记录当前会话用的是哪个 preset，所以只按默认算。
		 */
		const COMPACT_RATIO = 0.8;
		const COMPACT_HEADROOM = 65536;
		/**
		 * 压缩点标记的宽度，一个数管两处：圆环那边是缺口的净宽（圆头啃进去之后看得见的部分），
		 * 横条那边是实线的粗细。1px 是这个尺寸下的可靠下限——圆环描边才 2px，再宽就不像缺口
		 * 而像断了一大格；再细于 1px 会走亚像素合成，在 14px 的圈上直接发虚。
		 */
		const COMPACT_NOTCH_PX = 1;
		/** 横条用 calc 定宽，线就不随气泡变宽变窄；这是半宽。 */
		const BAR_NOTCH_HALF_PX = COMPACT_NOTCH_PX / 2;

		/**
		 * 压缩点占窗口的百分比；算不出返回 null（缺窗口或缺输出上限）——此时不开缺口。
		 * 分母就是算阈值用的那个 contextWindow，不借圆环那侧的值：两者本应是同一个模型的窗口，
		 * 借过来只会在投影短暂不同步时让缺口位置漂移。
		 * 小窗口扣不出余量时官方会直接配置报错，这里退回比例那条线。
		 */
		function compactPercent(capacity) {
			if (capacity === null || capacity === undefined) return null;
			const windowTokens = capacity.contextWindow;
			const outputTokens = capacity.maxOutputTokens;
			if (typeof windowTokens !== "number" || windowTokens <= 0) return null;
			if (typeof outputTokens !== "number" || outputTokens < 0) return null;
			const ratioLine = windowTokens * COMPACT_RATIO;
			const budgetLine = windowTokens - outputTokens - COMPACT_HEADROOM;
			const threshold = Math.floor(budgetLine > 0 ? Math.min(ratioLine, budgetLine) : ratioLine);
			if (!(threshold > 0)) return null;
			return Math.min(100, threshold / windowTokens * 100);
		}

		/**
		 * 圆环轨道在压缩点处挖一个圆头缺口，返回 strokeDasharray 的三段长度（画—空—画）。
		 * dash 上的空洞要留成「净宽 + 描边宽度」：linecap:round 让缺口两侧的两段各向洞内延伸
		 * 半个线宽（共 2px），按净宽直接开洞会被两个圆头整个填平。
		 * 三段之和必须精确等于周长——dasharray 是循环 pattern，零头会在闭合处（12 点）挤出一道假缝。
		 */
		function notchDashes(percent) {
			if (percent === null || percent === undefined) return null;
			if (!(percent > 0 && percent < 100)) return null;
			const gap = COMPACT_NOTCH_PX + METER_STROKE_PX;
			const at = METER_CIRCUMFERENCE * percent / 100;
			const head = at - gap / 2;
			const tail = METER_CIRCUMFERENCE - head - gap;
			/* 贴住两端就整条不画：挪中心会让缺口指错位置，比没缺口更糟（与横条的边界守卫同一取舍） */
			if (!(head > 0 && tail > 0)) return null;
			return head + " " + gap + " " + tail;
		}

		/**
		 * 圆环与分项面板要的数据；缺用量或缺窗口时返回 null（官方这时候也不显示）。
		 * 数字一律用千分位精确值（不缩写、不带约等于号），跟令牌面板保持同一套读法。
		 * @returns {{percent:number, used:string, window:string, rows:Array, segments:Array, compact:number|null}|null}
		 */
		function meterView(pressure, breakdown, capacity, t) {
			const occupancy = contextOccupancy(pressure);
			if (occupancy === null) return null;
			const parts = breakdown === null || breakdown === undefined
				? []
				: METER_ROWS.map((row) => ({
					label: t(row.label),
					color: row.color,
					value: Number(breakdown[row.key]) || 0
				}));
			const total = parts.reduce((sum, one) => sum + one.value, 0);
			const rows = parts.map((one) => ({
				label: one.label,
				color: one.color,
				value: formatTokensExact(one.value)
			}));
			/* 官方口径：每段宽度 = 各段占比 × 总占用百分比，所以整条只填到占用比例，不会顶满 */
			const segments = total > 0
				? parts
					.map((one) => ({ color: one.color, width: occupancy.percent * one.value / total }))
					.filter((one) => one.width > 0)
				: [{ color: undefined, width: occupancy.percent }];
			return {
				percent: occupancy.percent,
				used: formatTokensExact(occupancy.usedTokens),
				window: formatTokensShort(occupancy.contextWindow),
				rows: rows,
				segments: segments,
				compact: compactPercent(capacity)
			};
		}

		/**
		 * 没有占用数据时的圆环与面板：空环 + 横杠（`empty` 标记让面板区分"没数据"与"0%"）。
		 *
		 * 圆环是固定在栏首的底栏项，**不能因为拿不到数据就整块消失**：会话刚发出去就被
		 * 中断时最容易撞上 —— 那一刻 provider 还没报过上下文压力，整块一没，底栏就少一项，
		 * 看上去像插件坏了（实测 2026-10-09）。缺数据的面板与令牌面板同口径：一律横杠，
		 * 保证任何状态下都点得开。
		 */
		function dashMeter() {
			return {
				percent: 0,
				used: "-",
				window: "-",
				rows: [],
				segments: [],
				compact: null,
				empty: true
			};
		}

		/** 条的轨道底色，与 .dsb-bar 的 CSS 同一变量，内联覆盖时不留色差。 */
		const BAR_TRACK = "var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15))";

		/**
		 * 横条上的压缩点压一条实线（不是圆环那样的镂空）：镂空会被气泡的毛玻璃底透上来，读成缺了一段。
		 * 取色跟界面文字同一档（label-primary），主题反转时一起变——写死 #000 在暗色下会融进深底。
		 * 必须带 fallback：这个值进的是 linear-gradient 的色标，变量缺失会让整条 background 失效。
		 */
		const BAR_NOTCH_COLOR = "var(--dsw-alias-label-primary,#202020)";

		/**
		 * 分项条的轨道背景：有压缩点就在同一百分比处压一条竖线，位置与圆环缺口同一个口径。
		 * 贴住两端时不画（压在角上只会像渲染出错）。
		 */
		function barTrackStyle(compact) {
			if (compact === null || compact === undefined) return undefined;
			if (!(compact > 1 && compact < 99)) return undefined;
			const at = compact.toFixed(3);
			/* 混合 % 与 px：位置跟模型自适应，线本身定宽，不会随气泡变宽 */
			const from = "calc(" + at + "% - " + BAR_NOTCH_HALF_PX + "px)";
			const to = "calc(" + at + "% + " + BAR_NOTCH_HALF_PX + "px)";
			return {
				background: "linear-gradient(90deg," + BAR_TRACK + " 0 " + from + "," + BAR_NOTCH_COLOR
					+ " " + from + " " + to + "," + BAR_TRACK + " " + to + " 100%)"
			};
		}

		/** 官方那种分段小条（分项面板里那条）。子代理「命中」那段挂 dsb-bar-sub（75% 浅灰）。 */
		function meterBar(meter) {
			return h("span", { className: "dsb-bar", style: barTrackStyle(meter.compact) },
				meter.segments.map((segment, index) => {
					const style = { width: segment.width + "%" };
					/* 浅色子段（子代理命中）交给 CSS 的 75% 灰：这里不写颜色，否则行内样式会盖掉 class 的背景。
					   必须用 background-color 长写：`background` 简写会把 background-clip 重置成 border-box，
					   段内那条「1px 透明右边框」的间隔就不生效了（见 CSS .dsb-bar-seg:not(:last-child)）。 */
					if (segment.light !== true) style.backgroundColor = segment.color;
					return h("span", {
						className: segment.light === true ? "dsb-bar-seg dsb-bar-sub" : "dsb-bar-seg",
						key: "__bar" + index,
						style: style
					});
				}));
		}

		/**
		 * 状态位上的圆环：起点与官方一致在 12 点方向，进度是占用比例，颜色跟随运行状态。
		 * 轨道在压缩点处挖一个圆头缺口；算不出压缩点时轨道保持整圈。
		 *
		 * 六种状态：`running` 绿（Lead 在跑）/ `teamRunning` 蓝（团队成员在跑）/
		 * `deepRunning` 紫（只有更深层在跑）/ `error` / `approval` / 无类（idle）。
		 * 蓝紫两色复用总计令牌条已有的「输出」蓝与「未命中输入」紫，不新造颜色。
		 * 旋转是 CSS animation（见样式表），不占 JS 定时器。
		 */
		function contextRing(percent, state, compact) {
			const stateClass = state === "running" ? " dsb-ring-running"
				: (state === "teamRunning" ? " dsb-ring-team"
					: (state === "deepRunning" ? " dsb-ring-deep"
						: (state === "error" ? " dsb-ring-error" : (state === "approval" ? " dsb-ring-approval" : ""))));
			const offset = METER_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, percent)) / 100);
			const dashes = notchDashes(compact);
			return h("svg", {
				className: "dsb-ring" + stateClass, key: "__ring", viewBox: "0 0 14 14", width: 14, height: 14
			},
				h("circle", {
					className: "dsb-ring-track", cx: 7, cy: 7, r: METER_RADIUS,
					/* 轨道转到 12 点起，dasharray 的度量才和占用弧同一口径；
					   圆头把缺口两端收成弧形，而不是齐平的径向切口。 */
					transform: dashes === null ? undefined : "rotate(-90 7 7)",
					strokeLinecap: dashes === null ? undefined : "round",
					strokeDasharray: dashes === null ? undefined : dashes
				}),
				h("circle", {
					className: "dsb-ring-fill", cx: 7, cy: 7, r: METER_RADIUS,
					/* SVG 的弧默认从 3 点方向起，整体转 -90° 才是官方那种"12 点起、顺时针长" */
					transform: "rotate(-90 7 7)",
					strokeDasharray: METER_CIRCUMFERENCE, strokeDashoffset: offset
				}));
		}

		/** 气泡自己那一圈描边的宽度（.dsb-tip 的 box-shadow spread:0 0 0 .5px）：
		    可见边缘比 border-box 再往外这么多，左右对齐时要补掉，否则看得见的边还差半像素。 */
		const TIP_OUTLINE_PX = 0.5;

		/**
		 * 圆环的弧长取哪一个百分比（纯函数，便于离线断言）。
		 *
		 * 用户原话：「那个条还是有上下文占用的百分比的，要增长的。所以如果有多个成员同时在
		 * 运行，那么这个圆圈应该显示为同一级内上下文占用最多的那一个。成员下派的子智能体
		 * 那一级别（也就是该显示紫色的那一部分），上下文占用要显示最少的那个。」
		 *
		 * 也就是**颜色与弧长是两件独立的事**：
		 *   · 颜色 = 谁在跑（Lead 绿 / 成员蓝 / 更深紫）
		 *   · 弧长 = 那一级里在跑的人们的占用，成员取**最大**、更深层取**最小**
		 *     （"最大 / 最小"由 host 在那一级内部先聚合好 —— 只有它看得到每个子会话的占用；
		 *      客户端不重复聚合，避免两处口径打架）
		 *
		 * 其余四种状态（running / error / approval / idle）一律用 Lead 自己的 `contextMeter.percent`。
		 * 分层百分比是 `null`（老 host / 那一刻算不出）时**退回** `contextMeter.percent`：
		 * 显示 0 会让圆环突然空掉，用户只会以为插件坏了。非数字 / NaN 同样退回。
		 */
		function ringPercentOf(contextMeter, agentState, tiers) {
			const own = contextMeter === null || contextMeter === undefined || typeof contextMeter.percent !== "number"
				|| !Number.isFinite(contextMeter.percent)
				? 0
				: contextMeter.percent;
			const layered = agentState === "teamRunning"
				? (tiers === null || tiers === undefined ? null : tiers.teamPercent)
				: (agentState === "deepRunning"
					? (tiers === null || tiers === undefined ? null : tiers.deepPercent)
					: null);
			if (typeof layered !== "number" || !Number.isFinite(layered)) return own;
			return Math.max(0, Math.min(100, layered));
		}

		/** 气泡的 fixed 内联位置：JS 已按视口与底栏范围夹住；pos 为空时不写。
		    宽度交给内容（CSS width:max-content），但比底栏还宽时按底栏跨度压住，多出的列自己折行。 */
		function panelStyle(pos) {
			if (pos === null || pos === undefined) return undefined;
			const style = { left: pos.left + "px", bottom: pos.bottom + "px" };
			if (typeof pos.maxWidth === "number" && pos.maxWidth > 0) style.maxWidth = pos.maxWidth + "px";
			return style;
		}

		/**
		 * 气泡自身吃下鼠标事件：一来不会穿透点到气泡下面（页面或状态栏），
		 * 二来不会冒泡回触发项，把刚打开的气泡又切成关闭。
		 */
		function stopTipClick(event) {
			event.stopPropagation();
		}

		/**
		 * 气泡定位诊断回传：把这次算出的基准与结果发给 host 落盘（只含数字与短字符串），
		 * 便于在打不开控制台的环境里核对气泡为什么越界。任何失败都静默，不影响气泡本身。
		 *
		 * **开发模式一律不发**：那时气泡里的数字全是假的（假投影算出来的假坐标），
		 * 诊断日志只会污染 host 的 tip-diag.log，而且用户对开发模式的要求是
		 * 「所有数据都是伪造的，不许发任何真实请求」。
		 *
		 * 守的是**模块级 `devMode`** 而不是组件里的 `devActive`：两者同一份真相
		 * （`publishDev` 读的就是 devMode），但这里是模块级函数、调用点在 StatusBar 的
		 * layout effect 里，加参数会多一条「谁都得记得传」的隐式约定；而 devMode 与
		 * reportTipDiag 本来就同处一个闭包，直接读它零参数、零同步风险，且比
		 * useSyncExternalStore 的快照更早生效（进入开发模式的那一帧就不会漏发）。
		 */
		function reportTipDiag(payload) {
			if (devMode === true) return;
			try {
				window.fetch(TIP_DIAG_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				}).catch(() => { /* 静默 */ });
			} catch (error) {
				/* 静默 */
			}
		}

		/** 悬停气泡里的分项面板：标题 + 分段条 + 三行构成（复刻官方 ContextMeter）。 */
		function meterPanel(meter, t, pos, ref) {
			const [headBefore = "", headAfter = ""] = t("contextAria", { percent: READING_SLOT })
				.split(READING_SLOT).map((part) => part.trim());
			const head = [];
			if (headBefore.length > 0) head.push(h("span", { className: "dsb-meter-headline", key: "__hb" }, headBefore));
			head.push(h("span", { className: "dsb-meter-percent", key: "__hp" }, meter.empty === true ? "-" : meter.percent + "%"));
			if (headAfter.length > 0) head.push(h("span", { className: "dsb-meter-headline", key: "__ha" }, headAfter));
			head.push(h("span", { className: "dsb-meter-figures", key: "__hf" }, meter.used + " / " + meter.window));
			const rows = meter.rows.map((row, index) => h("span", { className: "dsb-meter-row", key: "__mr" + index }, [
				h("span", { className: "dsb-meter-swatch", key: "__ms", style: { background: row.color } }),
				h("span", { className: "dsb-meter-name", key: "__mn" }, row.label),
				h("span", { className: "dsb-meter-value", key: "__mv" }, row.value)
			]));
			return h("span", { className: "dsb-tip dsb-meter", key: "__tip", ref: ref, style: panelStyle(pos), onClick: stopTipClick, onMouseDown: stopTipClick }, [
				h("span", { className: "dsb-meter-head", key: "__mh" }, head),
				meterBar(meter),
				rows.length > 0 ? h("span", { className: "dsb-meter-rows", key: "__mrows" }, rows) : null
			]);
		}

		/**
		 * 令牌面板数据：第一行是总用量，第二行三段占比（顶满 100%），下面三行明细。
		 * 数字一律千分位精确值，不带单位（面板标题已经说明是 token 用量）。
		 */
		/** 没有 token 数据时的面板：不画三段条，三行都给横杠 —— 保证气泡在任何情况下都点得开。 */
		function dashTokenPanel(t) {
			return {
				totalText: "-",
				segments: [],
				rows: [
					{ label: t("f_tokensHit"), color: "var(--dsw-static-neutral-bluish-400)", value: "-" },
					{ label: t("f_tokensMiss"), color: "#a78bfa", value: "-" },
					{ label: t("f_tokensOut"), color: "var(--dsw-static-blue-450)", value: "-" }
				]
			};
		}

		/**
		 * 令牌面板数据：第一行是总用量，第二行三段占比（顶满 100%），下面三行明细。
		 * 数字一律千分位精确值，不带单位（面板标题已经说明是 token 用量）。
		 * `sub` 是子代理（队友）的三段；有子代理用量时，条上拆成 6 小段：
		 * **子代理块在左、主会话块在右**：[子·命中][子·未命中][子·输出][主·命中][主·未命中][主·输出]。
		 * 子·命中用 75% 浅灰（与活跃总览高峰段同款），子·未命中 / 子·输出用正常主色；
		 * **数字与行仍是合并口径**（主 + 子），不新增行。
		 */
		function tokenPanelView(cached, missInput, output, t, sub) {
			const total = cached + missInput + output;
			if (total <= 0) return null;
			const subParts = sub === null || sub === undefined
				? { cached: 0, missInput: 0, output: 0 }
				: {
					cached: Math.max(0, Number(sub.cached) || 0),
					missInput: Math.max(0, Number(sub.missInput) || 0),
					output: Math.max(0, Number(sub.output) || 0)
				};
			const parts = [
				/* lightSub：只有「命中」那一档的子代理段用 75% 浅灰，其余子段用主色 */
				{ label: t("f_tokensHit"), color: "var(--dsw-static-neutral-bluish-400)", value: cached, sub: subParts.cached, lightSub: true },
				{ label: t("f_tokensMiss"), color: "#a78bfa", value: missInput, sub: subParts.missInput },
				{ label: t("f_tokensOut"), color: "var(--dsw-static-blue-450)", value: output, sub: subParts.output }
			];
			/* 段顺序（用户拍板）：**子代理块在左、主会话块在右**：
			   子·命中 → 子·未命中 → 子·输出 → 主·命中 → 主·未命中 → 主·输出。
			   主段 = 合并值 - 子值，子段 = 子值；哪边是 0 就不画那一段。
			   宽度仍是占总量的比例，所以 6 小段合起来仍顶满 100%。
			   子代理命中段标 light（用活跃总览高峰段同款 75% 灰，见 CSS .dsb-bar-sub）；
			   子代理未命中 / 输出不浅化，用正常主色。 */
			const segments = [];
			parts.forEach((one) => {
				const subValue = Math.min(one.value, one.sub);
				if (subValue > 0) {
					const segment = { color: one.color, width: (subValue / total) * 100, sub: true };
					if (one.lightSub === true) segment.light = true;
					segments.push(segment);
				}
			});
			parts.forEach((one) => {
				const subValue = Math.min(one.value, one.sub);
				const mainValue = Math.max(0, one.value - subValue);
				if (mainValue > 0) segments.push({ color: one.color, width: (mainValue / total) * 100 });
			});
			return {
				totalText: formatTokensExact(total),
				segments: segments,
				rows: parts.map((one) => ({
					label: one.label,
					color: one.color,
					value: formatTokensExact(one.value)
				}))
			};
		}

		/** 令牌面板：标题 + 总量 + 顶满的三段条 + 三行明细，左右两边对齐（总计与本轮共用，只有标题不同）。 */
		function tokenPanel(panel, title, pos, ref) {
			const rows = panel.rows.map((row, index) => h("span", { className: "dsb-meter-row", key: "__tr" + index }, [
				h("span", { className: "dsb-meter-swatch", key: "__ts", style: { background: row.color } }),
				h("span", { className: "dsb-meter-name", key: "__tn" }, row.label),
				h("span", { className: "dsb-meter-value", key: "__tv" }, row.value)
			]));
			return h("span", { className: "dsb-tip dsb-meter", key: "__tip", ref: ref, style: panelStyle(pos), onClick: stopTipClick, onMouseDown: stopTipClick }, [
				h("span", { className: "dsb-meter-head", key: "__th" }, [
					h("span", { className: "dsb-meter-headline", key: "__tl" }, title),
					h("span", { className: "dsb-meter-figures", key: "__tt" }, panel.totalText)
				]),
				meterBar({ segments: panel.segments }),
				h("span", { className: "dsb-meter-rows", key: "__trows" }, rows)
			]);
		}

		/**
		 * 积分套餐面板（WorkBuddy）：标题 + 总积分，下面每个套餐一个块：
		 * 第一行 = 包名/备注 + 「已用 X / 总数」；第二行 = 一条进度。
		 *
		 * **进度条语义（与余额的「剩余配额」条完全一致，改一处必须同步另一处）**：
		 *   **灰 = 还剩多少，从左端起；透明 = 已用，在右。**
		 *   `segments` 恒为「灰(剩余%) + 透明(已用%)」，按顺序拼 —— flex 从左往右排，
		 *   所以灰在前自然贴着最左端、透明落在右边。
		 *   边界：used=0 → 只有灰 100%（额度一点没用）；used>=100 → 只有透明 100%
		 *   （用完了，露出轨道底色，不画灰）。两段都用 `width: %`，宽度由浏览器按比例切。
		 *
		 * 为什么灰是「剩余」而不是「已用」：这套面板里灰（BALANCE_COLORS.topUp）一直是
		 * 「账户里还剩多少钱」的固定色 —— 余额气泡的充值段、余额配额条的剩余段都用它。
		 * 进度条如果反过来用灰表示"已用"，同一个颜色在相邻两个气泡里含义相反，最容易读错。
		 * 为什么从**左**端起（用户拍板，来回改过一次，这里记下来免得再翻烧饼）：
		 *   灰条长度 = 剩余额度，越长剩得越多；从左读起，「还剩多少」一眼就看到，
		 *   不用先扫过一段空的已用区。用户原话：「灰条从左边起」。
		 * 「已用 X / 总数」这行文字保持不变，所以条的方向不影响读数：字在上、条在下，
		 * 条只承担"视觉比例"。
		 *
		 * `.dsb-bar` 始终渲染：used=0 时是整条灰（仍有填充），used=100 时只有空轨道。
		 * **聚合行（×N）可点**：点进去是子视图 —— 内容与主面板同一套套餐块（一行 + 一条进度），
		 * 只是每个块代表该组合并前的一个原始包（自己的名字/日期备注、真实已用/总数），竖排单列可滚动；
		 * 标题只显示聚合的显示名（不带 ×N），右侧不再重复总积分。点标题返回。
		 * 颜色与轨道高度/圆角沿用令牌/配额条那套 `.dsb-bar`；列表容器带半屏高度上限可滚动
		 * （滚动条隐藏，见 CSS），14 条套餐也不会把气泡撑出屏幕。没有新造颜色或新字号。
		 */
		function creditsPanel(panel, title, pos, ref, sub) {
			const openedAt = sub === undefined || sub === null || typeof sub.id !== "number" ? null : sub.id;
			const opened = openedAt === null || panel.rewards[openedAt] === undefined ? null : panel.rewards[openedAt];
			/* 一个套餐块 = 一行（名字/备注 + 已用/总数）+ 它自己的一条进度。
			   主列表与下钻子视图共用这一份，别各写一遍。 */
			const barOf = (one, key) => {
				const used = Math.max(0, Math.min(100, one.percent));
				/* **灰 = 剩余、从左起；透明 = 已用、在右**（与余额配额条同一套语义）。
				   用户拍板原话：「灰条从左边起」—— 灰条越长表示剩得越多，从左边读起，
				   和「还剩多少」这个问题的直觉一致。
				   只推「宽 > 0」的段，所以 used=0 只剩左边的灰 100%、used=100 只剩透明 100%。 */
				const segments = [];
				if (used < 100) {
					segments.push(h("span", {
						className: "dsb-bar-seg", key: key + "a",
						style: { width: (100 - used) + "%", backgroundColor: BALANCE_COLORS.topUp }
					}));
				}
				if (used > 0) {
					segments.push(h("span", {
						className: "dsb-bar-seg", key: key + "b",
						style: { width: used + "%", backgroundColor: "transparent" }
					}));
				}
				return h("span", { className: "dsb-bar", key: key + "bar" }, segments);
			};
			const creditBlock = (one, index, clickable) => {
				const base = "__cr" + index;
				const rowNode = h("span", {
					/* 聚合行用独立修饰类：只给 cursor:pointer，不要 .dsb-meter-row-click 的悬停灰底胶囊
					   （那是「会话数据」那类行才有的反馈，套餐行只要可点感） */
					className: clickable ? "dsb-meter-row dsb-meter-row-plain" : "dsb-meter-row",
					key: base + "r",
					onClick: clickable
						? (event) => {
							stopTipClick(event);
							if (sub.open !== undefined) sub.open(index);
						}
						: undefined
				}, [
					h("span", { className: "dsb-meter-name", key: base + "n" }, one.label),
					h("span", { className: "dsb-meter-value", key: base + "v" }, one.valueText)
				]);
				return h("span", { className: "dsb-credit", key: base }, [rowNode, barOf(one, base)]);
			};
			let body = null;
			if (opened === null) {
				body = h("span", { className: "dsb-meter-rows dsb-meter-rows-fit dsb-credits-list", key: "__clist" },
					panel.rewards.map((one, index) => creditBlock(one, index, one.count > 1)));
			} else {
				/* 子视图：每个原始包一块（与主面板同样的行 + 进度条），竖排单列、可滚动 */
				body = h("span", { className: "dsb-meter-rows dsb-meter-rows-fit dsb-credits-list", key: "__clist" },
					opened.items.map((one, index) => creditBlock(one, index, false)));
			}
			const headline = opened === null
				? h("span", { className: "dsb-meter-headline", key: "__ctl" }, title)
				: h("span", {
					/* 点标题回上一层：与 rowsPanel 子视图同一套交互。
					   标题显示聚合行的名字与数量（如「运营裂变包×12」）；右侧是**该组剩余积分**
					   （total - used，动态）。 */
					className: "dsb-meter-headline dsb-meter-back",
					key: "__ctl",
					onClick: (event) => {
						stopTipClick(event);
						if (sub.back !== undefined) sub.back();
					}
				}, opened.count > 1 ? opened.name + "×" + opened.count : opened.name);
			return h("span", {
				className: "dsb-tip dsb-meter",
				key: "__tip", ref: ref, style: panelStyle(pos), onClick: stopTipClick, onMouseDown: stopTipClick
			}, [
				h("span", { className: "dsb-meter-head", key: "__ch" }, [
					headline,
					/* 主面板右侧是全局总积分；下钻子视图换成该组剩余积分（不显示组总容量） */
					h("span", { className: "dsb-meter-figures", key: "__ctt" },
						opened === null ? panel.totalText : opened.remainingText)
				]),
				/* 与其它 rows 气泡一致：标题下一条横杠（复用 .dsb-meter-divider，不新增 CSS）。
				   只有 credits 面板加；tokenPanel 那种自带分段条的不加。 */
				h("span", { className: "dsb-meter-divider", key: "__cdiv" }),
				body
			]);
		}

		/* ------------------------------------------------------ 活跃总览柱状图 */
		/** 柱状图用的三色：与令牌面板的三段同色（命中缓存=灰 / 未命中=紫 / 输出=蓝）。 */
		const WEEK_COLORS = {
			hit: "var(--dsw-static-neutral-bluish-400)",
			miss: "#a78bfa",
			out: "var(--dsw-static-blue-450)"
		};

		/* 余额构成的两色：充值取灰（同「系统提示词」图例）、赠金取紫（同「工具定义」图例）。
		   百分比配额（GLM 那种）只有「剩余」那段上色：取灰（充值那一档）、贴右端 ——
		   "剩余"在语义上就是这个套餐里还没花掉的部分，和充值余额同属"可用"色系。 */
		const BALANCE_COLORS = {
			topUp: "var(--dsw-static-neutral-bluish-400)",
			granted: "#a78bfa"
		};

		/* 运行用时面板的三色：等待用时取灰（同「系统提示词」图例）、模型用时(解码)取紫、工具调用取蓝 */
		const DURATION_COLORS = {
			wait: "var(--dsw-static-neutral-bluish-400)",
			model: "#a78bfa",
			tool: "var(--dsw-static-blue-450)"
		};

		/**
		 * 日期键（YYYY-MM-DD），用来认「今天」那根柱子。
		 *
		 * 按**装机者所在时区**取，与 host 的 localDateKey 同一口径：使用者看的是自己
		 * 日历上的今天/昨天。曾经固定用北京时间，UTC+8 装机时看不出差别，非 UTC+8 的
		 * 机器上整块活跃总览会错一天（「今天」高亮成昨天、未来/过去的灰阶也偏）。
		 *
		 * 注意与 isPeakTime 区分：**峰谷计价**仍按北京时间，那是 DeepSeek 的官方规则；
		 * 只有「日期归属」跟着装机者时区走。
		 */
		function dateKeyOf(ms) {
			const d = new Date(ms === undefined || ms === null ? Date.now() : ms);
			const pad = (n) => (n < 10 ? "0" + n : String(n));
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
		}

		/**
		 * 活跃度分档：按**排名**切四档，而不是"数值 / 最大值"。
		 *
		 * 为什么不能用最大值比例：一旦本期有个离群值（比如某个月用量是别月的几十倍），
		 * 其余项相对它全都不足 15%，会一起塌进最浅档，整条颜色就废了。
		 * 按排名则天然铺开 —— 传入本期所有数值，返回一个"数值 → 0–4 档"的映射：
		 * 0 表示没有用量（不参与排名），1–4 按 25% / 50% / 75% 分位切。
		 */
		function heatScale(values) {
			const nums = values
				.map((one) => Math.max(0, Number(one) || 0))
				.filter((one) => one > 0)
				.sort((a, b) => a - b);
			if (nums.length === 0) return () => 0;
			const quantile = (p) => {
				const pos = (nums.length - 1) * p;
				const lo = Math.floor(pos);
				const hi = Math.ceil(pos);
				return nums[lo] + (nums[hi] - nums[lo]) * (pos - lo);
			};
			const q1 = quantile(0.25);
			const q2 = quantile(0.5);
			const q3 = quantile(0.75);
			return (value) => {
				const n = Number(value) || 0;
				if (n <= 0) return 0;
				if (n <= q1) return 1;
				if (n <= q2) return 2;
				if (n <= q3) return 3;
				return 4;
			};
		}

		/** 浮层里的一行「名称 —— 数值」：名称靠左、数值靠右（复用气泡既有的双边对齐行）。 */
		function hoverRow(key, name, value) {
			return h("span", { className: "dsb-meter-row", key: key }, [
				h("span", { className: "dsb-meter-name", key: key + "n" }, name),
				h("span", { className: "dsb-meter-figures", key: key + "v" }, value)
			]);
		}

		/** 悬停文字与「工具调用」标题之间至少留 1ch（11px 字号下约 7px）。 */
		const HOVER_PLAIN_TITLE_GAP = 7;

		/**
		 * 工具彩条悬停文字的**水平夹取范围**（用户拍板）：
		 *   左 = 「工具调用」标题四个字的右边界 **再往右 1ch**（至少离标题 1ch，不能压到标题上）；
		 *   右 = **色条本身**（`.dsb-bar`）的右边界，不能超出色条；再与视口右缘取小。
		 * 色条拿不到时退回气泡右边界；两者都没有就只用视口。
		 * 纯函数，便于单测；返回 { min, max }，max 是文字右边界能到的最远位置。
		 */
		function plainBoundsOf(headBox, barBox, viewportWidth) {
			const viewport = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			const barRight = barBox !== null && barBox !== undefined && typeof barBox.right === "number"
				? barBox.right
				: null;
			const titleRight = headBox !== null && headBox !== undefined && typeof headBox.right === "number"
				? headBox.right
				: null;
			let min = 8;
			if (titleRight !== null) min = Math.max(8, titleRight + HOVER_PLAIN_TITLE_GAP);
			let max = barRight !== null ? barRight : (viewport > 0 ? viewport - 8 : null);
			if (max === null) return null;
			if (viewport > 0) max = Math.min(max, viewport - 8);
			if (max < min) return null;
			return { min: min, max: max };
		}

		/**
		 * 把文字提示的 left 夹进 plainBoundsOf 给的范围（夹不下就贴左边界）；没有范围只夹视口。
		 */
		function clampPlainLeft(centered, width, bounds, viewportWidth) {
			const viewport = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			const viewMin = 8;
			const viewMax = viewport > 0 ? viewport - width - 8 : null;
			let min = viewMin;
			let max = viewMax;
			if (bounds !== null && bounds !== undefined) {
				min = Math.max(min, bounds.min);
				if (max === null || bounds.max - width < max) max = bounds.max - width;
			}
			if (max === null) return Math.max(min, centered);
			return Math.max(min, Math.min(centered, max));
		}

		/**
		 * 纯文字提示能不能完整放进「可用区间」（用户拍板：**放不下就不显示，绝不缩小**）。
		 *
		 * 历史：以前放不下时会等比缩小到放得下（下限 0.5）。后来用户明确要求
		 * 「工具名很长而气泡不够长时，所有悬停提示一律不出现」，缩小这条路就没意义了 ——
		 * 缩到 5.5px 的文字本来就是不可读的，不如整组不显示。所以这里只回答「放得下吗」，
		 * 不再算缩放比例。
		 *
		 * 可用区间 = plainBoundsOf 给的 min~max（再与视口夹）；没有 bounds 就退回视口两侧各留 8px。
		 * 拿不到可用宽度（无 bounds 且无视口 / 区间为负）时返回 true：
		 * 量不出来就别关，宁可显示也不误伤。
		 */
		function plainFits(textWidth, bounds, viewportWidth) {
			if (typeof textWidth !== "number" || Number.isFinite(textWidth) !== true || textWidth <= 0) return true;
			const viewport = typeof viewportWidth === "number" && viewportWidth > 0 ? viewportWidth : 0;
			let min = 8;
			let max = viewport > 0 ? viewport - 8 : null;
			if (bounds !== null && bounds !== undefined) {
				min = Math.max(min, bounds.min);
				if (max === null || bounds.max < max) max = bounds.max;
			}
			if (max === null) return true;
			const available = max - min;
			/* 区间本身就是负的（标题右边界已经越过色条右边）：没有可用的横向空间，量不出结论 */
			if (available <= 0) return true;
			return textWidth <= available;
		}

		/**
		 * 活跃总览里的消费金额文案：**按币种各算各的，不做汇率折算**。
		 *
		 * 用户原话：「各自算各自，不再换算成统一币种，就比如说我美元模型用了 7.77。
		 * 人民币模型用了 145.66。那显示就应该显示 ¥145.66+$7.77」，
		 * 以及「但是如果其中有一项为 0，也就是没产生费用，就不用显示这个 +」。
		 *
		 * 规则（顺序即优先级，全是用户拍板的）：
		 *   · **人民币在前、美元在后**，用 `+` 连接 → `¥145.66+$7.77`
		 *   · 每项 `toFixed(2)`；负数与 NaN 一律当 0（金额是浮点累加出来的，会有 -0.0000001 这种噪声）
		 *   · **某项 ≤ 0 就不出现** —— 所以只有美元时是 `$7.77`，不会出现 `¥0.00+$7.77`
		 *   · **只有一项时不带 `+`**（`¥145.66` 而不是 `¥145.66+`）
		 *   · 两项都 ≤ 0 ⇒ `¥0.00`（这一行必须有内容，不能空）
		 *   · `byCurrency` 是空对象 / undefined / 不是对象 ⇒ **退回旧的 fallbackCost 逻辑**
		 *     （`¥` + 那个混合数）：老 host 还没有这个字段，行为必须与改动前一模一样
		 *
		 * @param {object|undefined} byCurrency `{ CNY?: number, USD?: number }`（host 按币种分好桶）
		 * @param {number} fallbackCost 老的混合金额（byCurrency 拿不到时用它）
		 * @param {function} t 取文案
		 */
		function costByCurrencyText(byCurrency, fallbackCost, t) {
			/* **金额不足 0.01 就不显示**（用户原话：「只要金额不足 0.01，就直接不显示。」）。
			   以前是「≤ 0 才不显示」，于是 0.002 会被 toFixed(2) 显示成 `$0.00` —— 一个
			   "有这笔钱但看起来是零"的假零，用户明确不要。
			   判据用 `Math.round(amount * 100) >= 1`，等价于「四舍五入到分后不是 0.00」：
			     · 0.005 ⇒ round(0.5)=1 ⇒ **显示 `¥0.01`**（正好半分，进位）
			     · 0.004 ⇒ round(0.4)=0 ⇒ 过滤掉
			   负数与 NaN 仍按 0 处理（现状不变）；只认 CNY / USD 两个键（现状不变）。 */
			const showable = (value) => {
				const amount = Number.isFinite(value) && value > 0 ? value : 0;
				return amount > 0 && Math.round(amount * 100) >= 1
					? amount
					: 0;
			};
			const parts = [];
			const hasMap = byCurrency !== null && byCurrency !== undefined && typeof byCurrency === "object";
			if (hasMap === true) {
				/* 固定顺序 CNY → USD：用户要的就是「人民币在前、美元在后」 */
				["CNY", "USD"].forEach((code) => {
					const amount = showable(Number(byCurrency[code]));
					if (amount > 0) parts.push({ code: code, amount: amount });
				});
				/* 有 map 但里面一项都不过滤门槛时，分两种情况：
				   · **有 CNY/USD 键**（宿主算过、结果就是零，或都 < 0.005）⇒ `¥0.00`。
				     这一行必须有内容，不能返回空串。
				   · **完全空对象**（老 host 没有分币种数据）⇒ 走下面的 fallback，
				     用混合 cost 兜底 —— 这是改动前就有的行为，不能因为新规则把它改掉。 */
				const hasAnyKey = byCurrency.CNY !== undefined || byCurrency.USD !== undefined;
				if (parts.length === 0 && hasAnyKey === true) return currencySymbol("CNY") + "0.00";
			}
			if (parts.length === 0) {
				/* 老数据兜底：宿主根本没给 byCurrency（不是"给了但是零"）。
				   同样按新规则过滤：不足 0.01 显示 ¥0.00。 */
				const fallback = showable(Number(fallbackCost));
				return currencySymbol("CNY") + fallback.toFixed(2);
			}
			return parts.map((one) => currencySymbol(one.code) + one.amount.toFixed(2)).join("+");
		}

		/**
		 * 悬停浮层的内容：日期（或周区间）+ 三项总计 → 命中/未命中/输出三行 → API 请求次数 → 消费金额。
		 * 六行全部走「名称左、数值右」的双边对齐；数量精确到个位并带千分位，不做缩写。
		 *
		 * `byCurrency` 是 host 按币种分好的金额（`{CNY, USD}`）；拿不到时退回 `cost` 那个混合数。
		 * 参数顺序：`byCurrency` 紧跟 `cost` 之后、`t` 之前（`t` 始终是最后一个，与文件其它函数一致）。
		 */
		function hoverPanelRows(label, bucket, calls, cost, byCurrency, t) {
			const hit = Number(bucket.cacheRead) || 0;
			const miss = (Number(bucket.input) || 0) + (Number(bucket.cacheWrite) || 0);
			const out = Number(bucket.output) || 0;
			return h("span", { className: "dsb-meter-rows dsb-meter-rows-fit", key: "__hrows" }, [
				hoverRow("__h0", label, formatTokensExact(hit + miss + out)),
				hoverRow("__h1", t("f_tokensHit"), formatTokensExact(hit)),
				hoverRow("__h2", t("f_tokensMiss"), formatTokensExact(miss)),
				hoverRow("__h3", t("f_tokensOut"), formatTokensExact(out)),
				hoverRow("__h4", t("hoverCalls"), formatTokensExact(calls)),
				hoverRow("__h5", t("hoverCost"), costByCurrencyText(byCurrency, cost, t))
			]);
		}

		/** 一天的数据；某个字段缺失时按 0 算。 */
		function bucketOf(day) {
			return {
				input: Number(day.input) || 0,
				cacheRead: Number(day.cacheRead) || 0,
				cacheWrite: Number(day.cacheWrite) || 0,
				output: Number(day.output) || 0
			};
		}

		/**
		 * 把若干天并成一个桶（周条 / 全年汇总用）。
		 *
		 * 除了老的混合 `cost`（保持不动，老逻辑还读它），还按币种各累各的 `byCurrency`：
		 * 用户要求活跃总览「各自算各自、不折算」，所以周汇总不能只给一个混合数。
		 * **只写正数键**：某币种那天没有费用就不建键，让数据本身干净（显示层也会再过滤一遍）。
		 */
		function sumDays(days) {
			const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let calls = 0;
			let cost = 0;
			const byCurrency = {};
			for (const day of days) {
				if (day === null || day === undefined) continue;
				const one = bucketOf(day);
				total.input += one.input;
				total.cacheRead += one.cacheRead;
				total.cacheWrite += one.cacheWrite;
				total.output += one.output;
				calls += Number(day.calls) || 0;
				cost += Number(day.cost) || 0;
				/* 按币种累加（老 host 没有这个字段 ⇒ 跳过，只靠 cost 走旧显示） */
				const map = day.costByCurrency;
				if (map !== null && map !== undefined && typeof map === "object") {
					Object.keys(map).forEach((code) => {
						const amount = Number(map[code]);
						if (Number.isFinite(amount) && amount > 0) {
							byCurrency[code] = (byCurrency[code] || 0) + amount;
						}
					});
				}
			}
			return { bucket: total, calls: calls, cost: cost, byCurrency: byCurrency };
		}

		/**
		 * 把一笔混合金额按「形态」拆成 `costByCurrency`（分币种各算各的假数据）。
		 *
		 * 用户这一轮要的两个新功能都要在开发模式里能被点到，所以活跃总览的每个日桶/月桶
		 * 必须带上 `costByCurrency`，而且要**三种形态都有**，否则「某项为 0 就不显示 +」
		 * 这条规则根本验证不到：
		 *   · `"mixed"` —— 人民币 + 美元都有（悬停显示 `¥x+$y`）
		 *   · `"cny"`   —— 只有人民币（悬停显示 `¥x`，不带 +）
		 *   · `"usd"`   —— 只有美元（悬停显示 `$y`，不带 +，也不出现 ¥0.00）
		 *
		 * **`costByCurrency` 各项之和必须严格等于 `cost`**（这条是硬约束）：
		 * 两个数对不上，用户一眼就看出是假数据。所以这里用"先按比例切、再把差额补给 CNY"
		 * 的写法，保证分币种相加与混合值完全一致（浮点误差用四舍五入收到 4 位，
		 * 差额直接补在人民币上 —— 它总是存在的那一项）。
		 *
		 * @param {number} cost 混合金额（已是四舍五入后的值）
		 * @param {string} shape "mixed" / "cny" / "usd"
		 * @param {number} ratio 混币时美元那一小份的占比（0~1），默认 0.18
		 */
		function devCostSplit(cost, shape, ratio) {
			const sum = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
			if (sum <= 0) return {};
			if (shape === "usd") return { USD: sum };
			if (shape === "cny") return { CNY: sum };
			/* 混币：按比例切，**差额补给人民币**，保证两块相加 === sum */
			const share = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : 0.18;
			const usd = Math.round(sum * share * 10000) / 10000;
			const cny = Math.round((sum - usd) * 10000) / 10000;
			return { CNY: cny, USD: usd };
		}

		/**
		 * 按天的序号挑一种形态：让同一个 fixture 里**三种形态都出现**，
		 * 这样用户在活跃总览里逐天悬停就能看全三种写法。
		 * 序号对 3 取模 —— 稳定（同一个 index 永远同一种形态，不随重渲染乱跳）。
		 */
		function devCostShapeAt(index) {
			const rest = ((index % 3) + 3) % 3;
			if (rest === 0) return "mixed";
			if (rest === 1) return "cny";
			return "usd";
		}

		/**
		 * 当月活跃度日历：按周分块，每块是一行 7 格（周一→周日）外面套一层淡灰底板。
		 * 方块只排当月（跨月的头尾几天留空位），按用量分档上色、月内最高的一天锁紫；
		 * 底板代表整周（含跨月那几天），悬停弹浮层。
		 */
		function heatGrid(month, t, onHover, activeWeek, today) {
			if (month === null || month === undefined || !Array.isArray(month.days) || month.days.length === 0) return [];
			const todayKey = typeof today === "string" ? today : "";
			const max = Number(month.max) || 0;
			/* 分档只按当月的天算：跨月那几天留空位、不画方块，不该影响分位边界 */
			const scale = heatScale(month.days.filter((one) => one.inMonth !== false).map((one) => one.total));
			/* host 给的已经是整周对齐的网格（首周从周一起算、末周补到周日，含跨月的头尾几天），
			   所以直接每 7 天切一块，不再自己补空位。 */
			const weeks = [];
			for (let i = 0; i < month.days.length; i += 7) weeks.push(month.days.slice(i, i + 7));
			return weeks.map((days, wi) => {
				const weekSum = sumDays(days);
				const first = days.find((day) => day !== null);
				const last = days.slice().reverse().find((day) => day !== null);
				const label = first === undefined || last === undefined ? "" : first.date.slice(5) + " ~ " + last.date.slice(5);
				const hasData = weekSum.bucket.input + weekSum.bucket.cacheRead + weekSum.bucket.cacheWrite + weekSum.bucket.output > 0;
				/* 判定区常驻：没有数据的周也一样会加深，只是不弹浮层。
				   覆盖底板左右两端"露出来"的边，以及跨月天留下的空位格；方块自己报当天，不走这里。 */
				const edgeHandlers = {
					onMouseEnter: (event) => onHover(event, hasData
						? { rows: hoverPanelRows(label, weekSum.bucket, weekSum.calls, weekSum.cost, weekSum.byCurrency, t), week: wi }
						: { week: wi }),
					onMouseLeave: () => onHover(null)
				};
				const cells = days.map((day, ci) => {
					/* 日历只排当月：跨月的头尾几天不画方块（留空位），但它们属于这一周，也算周浮层的判定区 */
					if (day === null || day === undefined || day.inMonth === false) {
						return h("span", Object.assign({
							className: "dsb-heat-cell dsb-heat-empty",
							key: "__he" + wi + "_" + ci
						}, edgeHandlers));
					}
					const total = Number(day.total) || 0;
					const top = max > 0 && total === max && day.date === month.maxDate;
					/* 没用量时的灰底只有一档：已经过去的日子与还没到的日子同色（25% 灰），
					   都是「没有数据」，不再区分深浅。 */
					const shade = total > 0 || todayKey === ""
						? ""
						: day.date > todayKey ? " dsb-future" : " dsb-past";
					const cls = top ? "dsb-heat-top" : "dsb-heat-" + scale(total) + shade;
					return h("span", {
						className: "dsb-heat-cell " + cls,
						key: "__hc" + day.date,
						/* 没有用量的天不弹浮层 */
						onMouseEnter: total > 0
							? (event) => onHover(event, { rows: hoverPanelRows(day.date.slice(5), bucketOf(day), Number(day.calls) || 0, Number(day.cost) || 0, day.costByCurrency, t) })
							: undefined,
						onMouseLeave: total > 0 ? () => onHover(null) : undefined
					});
				});
				return h("span", { className: "dsb-heat-week", key: "__hw" + wi }, [
					h("span", {
						className: "dsb-heat-pad" + (activeWeek === wi ? " dsb-heat-pad-active" : ""),
						key: "__hp" + wi
					}, [
						h("span", Object.assign({ className: "dsb-heat-edge", key: "__hel" + wi }, edgeHandlers)),
						h("span", { className: "dsb-heat-weekrow", key: "__hwr" + wi }, cells),
						h("span", Object.assign({ className: "dsb-heat-edge", key: "__her" + wi }, edgeHandlers))
					])
				]);
			});
		}

		/**
		 * 标题下面那 13 个段：1–6 月在左半边、7–12 月在右半边，**正中间那一段无色**，代表全年。
		 * 配色规则与右侧月历完全一致（0 = 灰、其余 4 档蓝、当年最高的那个月锁紫）。
		 * 悬停月份段看那个月，悬停中间的无色段看全年；没有用量的月份不弹浮层。
		 */
		function yearStrip(year, t, onHover, today) {
			if (year === null || year === undefined || !Array.isArray(year.months) || year.months.length === 0) return null;
			const max = Number(year.max) || 0;
			/* 当前月份：比它大的月份还没到，灰底同样减淡一半 */
			const todayMonth = typeof today === "string" ? Number(today.slice(5, 7)) || 0 : 0;
			const scale = heatScale(year.months.map((one) => one.total));
			const cells = year.months.map((one) => {
				const total = Number(one.total) || 0;
				const top = max > 0 && total === max && one.month === year.maxMonth;
				const month = Number(one.month) || 0;
				/* 灰底同样只有一档：已经过去的月份与还没到的月份同色（25% 灰） */
				const shade = total > 0 || todayMonth === 0
					? ""
					: month > todayMonth ? " dsb-future" : " dsb-past";
				const cls = top ? "dsb-heat-top" : "dsb-heat-" + scale(total) + shade;
				const label = String(year.year) + "-" + (month < 10 ? "0" + month : String(month));
				return h("span", {
					className: "dsb-year-cell " + cls,
					key: "__yc" + month,
					onMouseEnter: total > 0
						? (event) => onHover(event, { rows: hoverPanelRows(label, bucketOf(one), Number(one.calls) || 0, Number(one.cost) || 0, one.costByCurrency, t) })
						: undefined,
					onMouseLeave: total > 0 ? () => onHover(null) : undefined
				});
			});
			/* 全年合计：各月相加，挂在中间那段无色方块上 */
			const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let calls = 0;
			let cost = 0;
			/* 各月的分币种金额也一起累加（用户要求活跃总览「各自算各自」）；
			   老数据没有这个字段就跳过，只靠 cost 走旧显示。 */
			const yearByCurrency = {};
			for (const one of year.months) {
				totals.input += Number(one.input) || 0;
				totals.cacheRead += Number(one.cacheRead) || 0;
				totals.cacheWrite += Number(one.cacheWrite) || 0;
				totals.output += Number(one.output) || 0;
				calls += Number(one.calls) || 0;
				cost += Number(one.cost) || 0;
				const map = one.costByCurrency;
				if (map !== null && map !== undefined && typeof map === "object") {
					Object.keys(map).forEach((code) => {
						const amount = Number(map[code]);
						if (Number.isFinite(amount) && amount > 0) {
							yearByCurrency[code] = (yearByCurrency[code] || 0) + amount;
						}
					});
				}
			}
			const hasYear = totals.input + totals.cacheRead + totals.cacheWrite + totals.output > 0;
			const allCell = h("span", {
				className: "dsb-year-cell dsb-year-all",
				key: "__yall",
				onMouseEnter: hasYear
					? (event) => onHover(event, { rows: hoverPanelRows(String(year.year) + " " + t("hoverYearAll"), totals, calls, cost, yearByCurrency, t) })
					: undefined,
				onMouseLeave: hasYear ? () => onHover(null) : undefined
			});
			const half = Math.floor(cells.length / 2);
			return h("span", { className: "dsb-year", key: "__year" }, cells.slice(0, half).concat([allCell], cells.slice(half)));
		}

		/**
		 * 活跃总览面板：左边周一→周日 7 根堆叠柱，柱内自下而上是
		 * 输出(蓝) / 输入·未命中(紫) / 输入·命中(灰)，配色与令牌面板的三段一致。
		 *
		 * 柱身外面是一层**透明**轨道（只负责定高与贴底），柱身自己按
		 * 「当天总量 / 本周最大值」给高度，所以每根柱子都能各自顶部圆角；
		 * 当天没有用量时柱高为 0，那一格就是纯空白，没有底色留痕。
		 * 柱子下面不标星期 —— 位置本身就是周一→周日。
		 */
		function weekBarsPanel(tip, t, pos, ref, onHover, active) {
			const activeWeek = active === undefined || active === null ? null : active.week;
			const activeBar = active === undefined || active === null ? null : active.bar;
			const days = Array.isArray(tip.days) ? tip.days : [];
			const max = days.reduce((acc, day) => Math.max(acc, Number(day.total) || 0), 0);
			const columns = days.map((day, index) => {
				const total = Number(day.total) || 0;
				const scale = max > 0 ? total / max : 0;
				/* 段高只按当天构成分配；整根柱子的高度由外层 scale 决定 */
				const seg = (value) => (total > 0 ? ((Number(value) || 0) / total) * 100 : 0);
				/* 峰谷各含完整三项，两段按比例共分整条柱子（和 = 当天总量）。
				   低谷段在下、高峰段在上；每一段内部自下而上是 输出(蓝) → 未命中(紫) → 命中(灰)，
				   所以未命中与输出在各自那一段的底部。高峰段的命中用 75% 灰区分。 */
				const peak = day.peak === undefined || day.peak === null ? null : day.peak;
				const pk = (key) => (peak === null ? 0 : Number(peak[key]) || 0);
				const hitAll = Number(day.cacheRead) || 0;
				const missAll = (Number(day.input) || 0) + (Number(day.cacheWrite) || 0);
				const outAll = Number(day.output) || 0;
				const pkHit = pk("cacheRead");
				const pkMiss = pk("input") + pk("cacheWrite");
				const pkOut = pk("output");
				const lowHit = Math.max(0, hitAll - pkHit);
				const lowMiss = Math.max(0, missAll - pkMiss);
				const lowOut = Math.max(0, outAll - pkOut);
				const hasPeak = pkHit + pkMiss + pkOut > 0;
				return h("span", {
					className: "dsb-day"
						+ (activeBar === index ? " dsb-day-active" : ""),
					key: "__wd" + index,
					/* 悬停整列都让判定区变灰 —— 没有用量的天也一样；浮层只在有用量时弹 */
					onMouseEnter: (event) => onHover(event, total > 0
						? {
							rows: hoverPanelRows(day.date.slice(5), bucketOf(day), Number(day.calls) || 0, Number(day.cost) || 0, day.costByCurrency, t),
							bar: index
						}
						: { bar: index }),
					onMouseLeave: () => onHover(null)
				}, [
					h("span", { className: "dsb-day-track", key: "__wt" }, [
						h("span", { className: "dsb-day-stack", key: "__ws", style: { height: scale * 100 + "%" } }, [
							/* 容器是 column-reverse，先写的在底部。
							   低谷段：输出(蓝) → 未命中(紫) → 命中(灰)；
							   高峰段叠在它上面：输出(蓝) → 未命中(紫) → 命中(75% 灰)。 */
							h("span", { className: "dsb-day-seg", key: "__w3", style: { height: seg(lowOut) + "%", background: WEEK_COLORS.out } }),
							h("span", { className: "dsb-day-seg", key: "__w2", style: { height: seg(lowMiss) + "%", background: WEEK_COLORS.miss } }),
							h("span", { className: "dsb-day-seg", key: "__w1", style: { height: seg(lowHit) + "%", background: WEEK_COLORS.hit } }),
							hasPeak
								? h("span", { className: "dsb-day-seg", key: "__p3", style: { height: seg(pkOut) + "%", background: WEEK_COLORS.out } })
								: null,
							hasPeak
								? h("span", { className: "dsb-day-seg", key: "__p2", style: { height: seg(pkMiss) + "%", background: WEEK_COLORS.miss } })
								: null,
							hasPeak
								? h("span", { className: "dsb-day-seg dsb-day-peak", key: "__p1", style: { height: seg(pkHit) + "%" } })
								: null
						])
					])
				]);
			});
			/* 结构：标题 → 12 个月方块 → 左边柱状图 + 右边当月活跃度。
			   总量那一行已去掉，具体数字改成悬停在柱、方块或每周底条上看。 */
			const heat = heatGrid(tip.month, t, onHover, activeWeek, tip.today);
			const strip = yearStrip(tip.year, t, onHover, tip.today);
			return h("span", {
				className: "dsb-tip dsb-meter dsb-week",
				key: "__tip",
				ref: ref,
				style: panelStyle(pos),
				/* 吃下鼠标事件：不穿透到下面，也不冒泡回去把气泡关掉 */
				onClick: stopTipClick,
				onMouseDown: stopTipClick
			}, [
				h("span", { className: "dsb-meter-head", key: "__wh" }, [
					h("span", { className: "dsb-meter-headline", key: "__wt" }, tip.title)
				]),
				/* 那条分隔线换成了 12 个月方块；只有拿不到年度数据时才退回分隔线 */
				strip === null ? h("span", { className: "dsb-meter-divider", key: "__wdiv" }) : strip,
				h("span", { className: "dsb-week-body", key: "__wbody" }, [
					h("span", { className: "dsb-week-chart", key: "__wc" }, columns),
					h("span", { className: "dsb-heat", key: "__heat" }, heat)
				])
			]);
		}

		/**
		 * 长列表分列：**每一竖列最多三行**，超过就多开一竖列（列数不设上限）。
		 * 列网格是 `flex-wrap:nowrap`（用户拍板：**绝不折行**），一排放不下就横向滚动；
		 * 在那之前先**逐档加每列行数**（3 → 4 → 5 …，上限见 LIST_ROWS_PER_COLUMN_MAX）——
		 * 行数一加，列数就变少，放得下的机会更大，而且气泡宽度会跟着收窄（用户称"理解 B"）。
		 */
		const LIST_ROWS_PER_COLUMN = 3;
		/* 工具调用每列行数的上限：再往上加会让气泡高得离谱，12 行（约 264px）够收住绝大多数工具数。
		   12 行仍放不下才真正进入横向滚动（此时列网格 overflow-x 生效）。 */
		const LIST_ROWS_PER_COLUMN_MAX = 12;
		function listColumns(rows, rowsPerColumn) {
			const size = rowsPerColumn === undefined || rowsPerColumn === null ? LIST_ROWS_PER_COLUMN : rowsPerColumn;
			const out = [];
			for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
			return out;
		}

		/**
		 * 工具调用子视图「每列行数」的下一档：放得下就保持；放不下且还没到上限就 +1。
		 * 只升不降 —— 一放不下就升、升过头也不回退，避免行数在两档之间来回跳。
		 * 到 12 行都还放不下就停在这里，由列网格的横向滚动兜底（不再折行）。
		 * 纯函数，方便单测（4→5、上限 12 这两条边界都由它钉住）。
		 * 第二参按"这一排放不下"传（历史上叫 wrapped，折行已不可能发生，语义见 toolColumnsOverflow）。
		 */
		function nextToolRows(current, wrapped) {
			if (wrapped !== true) return current;
			return current < LIST_ROWS_PER_COLUMN_MAX ? current + 1 : current;
		}

		/**
		 * 滚轮 → 横向滚动：工具调用那个列网格**只能靠鼠标滚轮**横移。
		 *
		 * 用户拍板两条（实机反馈，原话「我用的是键盘上的方向键，而不是触控板。我要求的就是
		 * 它只能由鼠标滚轮滑动」）：
		 *   ① 纵向滚轮deltaY 转成 scrollLeft —— 否则鼠标在气泡上滚滚轮只会带动整页；
		 *   ② 键盘方向键**一律不滚**（见 dsbBlockKeyScroll），原生的方向键/PageUp/Home 滚动
		 *      在 `overflow:auto` 的元素被点过之后就会生效，必须主动拦。
		 *
		 * `deltaMode` 三种（WheelEvent.DOM_DELTA_*）：
		 *   0 = 像素（触控板、大多数浏览器）→ 直接当像素用；
		 *   1 = 行（Firefox 鼠标滚轮常见）→ 乘 `WHEEL_LINE_HEIGHT`（一行≈列表行高 22px）；
		 *   2 = 页 → 乘容器可视高度（一次滚一屏，符合"翻页"的直觉）。
		 * 不这么换算的话：行模式下 deltaY 通常只有 3，直接当像素滚 3px，用户会觉得"滚了没反应"。
		 *
		 * 只在**真的能横移**时才 preventDefault：没有溢出（或已经滚到边界）时把事件放过去，
		 * 否则用户滚轮停在气泡上会把整页钉住，反而是新的"滚不动"。
		 *
		 * **逐帧惯性（momentum）**：用户第二轮反馈原话「工具调用的滚动还是不够丝滑。我想要的是
		 * 那种滑动的惯性的动效」。旧实现把 delta 直接累加到 scrollLeft（rAF 只是合并写入），
		 * 松手即停、一步到位，所以手感是"跳"而不是"滑"。
		 * 现在换成速度模型：每个容器存 `{ pos, velocity }`，滚轮只**给 velocity 加增量**，
		 * 之后每帧 `velocity *= WHEEL_FRICTION`、`pos += velocity` —— 一次自然减速的滑行。
		 *
		 * 为什么用 rAF 而不是定时器：① rAF 与屏幕刷新同步，帧率变化时滑行距离不变；
		 * ② rAF 不是定时器，不占 `setInterval` 计数（底栏只允许时钟 + 余额轮询两处）；
		 * ③ 速度衰减到阈值以下就**不再排下一帧**，空闲期一次回调都没有，不会空转。
		 * preventDefault 仍然**当场**调（不能延后：延后的话浏览器可能已经开始滚页面了）。
		 *
		 * 注意每帧写完要**顺手刷一次渐隐**（`applyColsFade`）：程序性改 scrollLeft 在部分浏览器
		 * 里不触发 scroll 事件，不主动刷的话滚到尽头渐隐会一直留着。
		 */
		const WHEEL_LINE_HEIGHT = 22;
		/**
		 * 每帧速度乘这个系数（阻尼）。0.8 是用户实机滚过之后定的：0.92 滑得太久（约 0.7 秒），
		 * 停手以后内容还在飘，手感发黏。0.8 大约 0.25 秒收住，一推就走、松手即停。
		 * 调小 → 停得更快更"实"；调大（别过 0.97）→ 更飘更远。
		 */
		const WHEEL_FRICTION = 0.8;
		/**
		 * 滚轮 delta（像素）→ 初速度（px/帧）的折算系数。
		 * 取 (1 - friction) / friction：一次手势的总位移正好约等于原始 delta
		 * （等比级数 Σ v0·f^k = v0/(1-f)），所以「滚一格走多远」与改造前一致，
		 * 变的只是尾巴上的减速曲线 —— 用户不会觉得滚轮突然变快或变慢。
		 */
		const WHEEL_VELOCITY_GAIN = (1 - WHEEL_FRICTION) / WHEEL_FRICTION;
		/** 速度低于此值（px/帧）就归零收手：再走肉眼已看不出来，白烧一帧。 */
		const WHEEL_STOP_VELOCITY = 0.1;
		/** 速度上限（px/帧）：连发事件或触控板可能给出很大的 delta，不封顶会一帧跳出半屏。 */
		const WHEEL_MAX_VELOCITY = 60;
		/** 每个容器当前的滑行状态 `{ pos, velocity }`（WeakMap：节点被回收就自动释放）。 */
		const wheelMotion = new WeakMap();
		/** 每个容器已排的 rAF id（同一节点同时只排一帧，绝不叠加）。 */
		const wheelFrame = new WeakMap();

		/** 可横移的最大距离；拿不到几何（测试替身 / 面板未挂载）时按 0 处理。 */
		function wheelMaxScroll(node) {
			const scrollWidth = typeof node.scrollWidth === "number" ? node.scrollWidth : 0;
			const clientWidth = typeof node.clientWidth === "number" ? node.clientWidth : 0;
			const maxScroll = scrollWidth - clientWidth;
			return maxScroll > 0 ? maxScroll : 0;
		}

		/** 推进一帧。返回 true = 还要接着滑，false = 收手（调用方据此清状态、不再排帧）。 */
		function stepWheelMotion(node) {
			const motion = wheelMotion.get(node);
			if (motion === undefined) return false;
			/* 节点已被 React 卸载：继续算只是烧 CPU；顺带这也是"容器销毁不泄漏"的出口
			   （WeakMap 本身不阻止回收，但排着的 rAF 会把节点多捂一帧） */
			if (typeof node.isConnected === "boolean" && node.isConnected === false) return false;
			const maxScroll = wheelMaxScroll(node);
			motion.velocity *= WHEEL_FRICTION;
			if (Math.abs(motion.velocity) < WHEEL_STOP_VELOCITY) {
				motion.velocity = 0;
				return false;
			}
			const raw = motion.pos + motion.velocity;
			const next = Math.max(0, Math.min(maxScroll, raw));
			/* 撞到两端就把速度归零：用户没要回弹，回弹会让"到底了"这个信号变模糊 */
			const hitEdge = next !== raw;
			if (hitEdge === true) motion.velocity = 0;
			motion.pos = next;
			if (typeof node.scrollLeft === "number") node.scrollLeft = next;
			applyColsFade(node);
			return hitEdge !== true;
		}

		/** 排下一帧；已有排队的就什么都不做（同一节点同时只有一帧在路上）。 */
		function scheduleWheelMotion(node) {
			if (wheelFrame.has(node) === true) return;
			const schedule = typeof window !== "undefined" && window !== null && typeof window.requestAnimationFrame === "function"
				? window.requestAnimationFrame
				: null;
			/* 没有 rAF（测试替身 / 极老环境）：由调用方同步退化，这里不排队 */
			if (schedule === null) return;
			const frame = schedule(() => {
				wheelFrame.delete(node);
				if (stepWheelMotion(node) === true) {
					scheduleWheelMotion(node);
					return;
				}
				/* 收手时清掉状态：下次滚轮从真实 scrollLeft 重新取基准，不拿过期的 pos 起跳 */
				wheelMotion.delete(node);
			});
			/* rAF 替身可能是**同步**执行的（有的测试就是这么桩的），那样上面这段已经跑到收手、
			   状态也清了；此时不能再把 id 记回去 —— 否则 wheelFrame 里留下"已排一帧"的假标记，
			   之后的滚轮永远排不上帧。 */
			if (wheelMotion.has(node) === true && wheelFrame.has(node) !== true) wheelFrame.set(node, frame);
		}

		function wheelToHorizontalScroll(event) {
			const node = event === null || event === undefined ? null : event.currentTarget;
			if (node === null || node === undefined) return;
			const maxScroll = wheelMaxScroll(node);
			/* 没溢出（含 1px 取整误差）：交回给页面，别把滚轮吃掉 */
			if (maxScroll <= 1) return;
			/* Shift + 滚轮很多浏览器已经把 deltaY 换成 deltaX 了，两个都算上 */
			const rawY = Number(event.deltaY) || 0;
			const rawX = Number(event.deltaX) || 0;
			const mode = Number(event.deltaMode) || 0;
			const perUnit = mode === 1
				? WHEEL_LINE_HEIGHT
				: (mode === 2 ? (typeof node.clientHeight === "number" && node.clientHeight > 0 ? node.clientHeight : WHEEL_LINE_HEIGHT) : 1);
			const delta = (Math.abs(rawY) >= Math.abs(rawX) ? rawY : rawX) * perUnit;
			if (delta === 0) return;
			/* 位置基准：滑行中就用我们自己推进的 pos（那才是屏幕上此刻的位置），
			   空闲时以真实 scrollLeft 为准 —— 用户拖过滚动条、或内容重排过，
			   都不会从过期位置起跳。 */
			const inFlight = wheelMotion.has(node) === true && wheelFrame.has(node) === true;
			const current = inFlight
				? wheelMotion.get(node)
				: { pos: Math.max(0, Math.min(maxScroll, Number(node.scrollLeft) || 0)), velocity: 0 };
			const atLeft = current.pos <= 0;
			const atRight = current.pos >= maxScroll - 1;
			/* 已经贴边且继续往那个方向滚：放行，让页面自己滚（别在气泡边缘"顶住"） */
			if ((delta < 0 && atLeft) || (delta > 0 && atRight)) return;
			/* preventDefault 必须当场调：延到 rAF 里浏览器可能已经开始滚页面了 */
			if (typeof event.preventDefault === "function") event.preventDefault();
			const schedule = typeof window !== "undefined" && window !== null && typeof window.requestAnimationFrame === "function"
				? window.requestAnimationFrame
				: null;
			if (schedule === null || typeof node.scrollLeft !== "number") {
				/* 没有 rAF / 没有 scrollLeft：没法逐帧缓动，退回一次性位移
				   （测试替身 / 极老环境），行为仍然正确 —— 至少内容会动。 */
				const next = Math.max(0, Math.min(maxScroll, current.pos + delta));
				if (typeof node.scrollLeft === "number") node.scrollLeft = next;
				applyColsFade(node);
				return;
			}
			/* 滚轮只给速度加增量，位置交给帧循环推进 —— 惯性就来自这里。
			   delta 先按 gain 折算成 px/帧再封顶；连发时速度是**叠加**的，所以越滚越快。 */
			const boost = delta * WHEEL_VELOCITY_GAIN;
			current.velocity = Math.max(-WHEEL_MAX_VELOCITY, Math.min(WHEEL_MAX_VELOCITY, current.velocity + boost));
			current.pos = Math.max(0, Math.min(maxScroll, current.pos));
			wheelMotion.set(node, current);
			scheduleWheelMotion(node);
		}

		/** 这些键在可滚容器上会触发原生滚动，必须拦掉（用户只要鼠标滚轮）。 */
		const SCROLL_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"];

		/**
		 * 拦方向键/翻页键：容器只有 `overflow:auto` 时，点过它一次就获得焦点，
		 * 之后按方向键浏览器会自己滚它 —— 用户明确不要这条路，全部 preventDefault。
		 * 只拦滚动键，别的键（Tab / Esc / 复制粘贴）照常放行。
		 */
		function blockKeyScroll(event) {
			const key = event === null || event === undefined ? null : event.key;
			if (typeof key !== "string" || SCROLL_KEYS.indexOf(key) === -1) return;
			if (typeof event.preventDefault === "function") event.preventDefault();
		}

		/**
		 * 右缘淡出：给 `.dsb-meter-cols` 挂 / 摘 `dsb-cols-fade` 控制遮罩要不要出现。
		 *
		 * **为什么不直接在 CSS 里常开 mask**：常开的话"已经滚到最右"时最右那一列也会被
		 * 渐变啃掉一条，看起来像内容被裁了。所以按几何切 class：
		 *   · 没溢出（scrollWidth ≈ clientWidth）→ 不挂（整排都看得见，没有"还有更多"的暗示）
		 *   · 滚到最右（scrollLeft + clientWidth ≈ scrollWidth）→ 不挂
		 *   · 其余（还有内容在右边）→ 挂上
		 * 遮罩只做视觉，**不改任何布局尺寸**（mask-image 不参与排版），所以气泡宽度/列宽不变。
		 *
		 * **性能与闪烁**（用户实机反馈「一卡一顿、闪烁」的两个成因，都在这里治）：
		 *   ① 原实现每个 scroll 事件都 `classList.toggle` —— 即使值没变也会触发样式重算，
		 *      而 mask-image 一变就要整层重新栅格化，Windows Chromium 上表现为闪。
		 *      现在用 **ref 记住上一次的完整状态（含两侧像素宽度）**，只在**真的变化**时才碰
		 *      class / 写 CSS 变量。
		 *   ② scroll 是高频事件（一次滚轮可能几十个），用 **requestAnimationFrame 合并**：
		 *      一帧最多算一次，且同一帧内到达的多个 scroll 只保留最后一次。
		 *      rAF 不是定时器（不受 setInterval 计数约束），也不会有"自己造循环"的问题 ——
		 *      每帧最多排一次，没有新 scroll 就不再排。
		 *
		 * 首次不显示的问题见 `primeColsFade`（挂载那一刻主动算一次）；
		 * **逐档加行之后不重算**的问题见 `refreshColsFade`（在 useTipLayout 里每次渲染后调一次）——
		 * 那条是用户第二次实机报的：「能完整显示、不需要滑动，右侧却挂着一道淡出」。
		 */
		const COLS_FADE_CLASS = "dsb-cols-fade";
		/**
		 * 渐隐带的宽度（px）。两侧共用同一个值，**是固定值，不随溢出量变化**。
		 * 24 → 40：用户实机看过后觉得"淡出范围太窄、像被切了一刀"，加宽到 40 才像自然淡出。
		 * 曾经试过按实际溢出量收窄（`min(40, 溢出量)`），被用户否掉，原话：
		 * 「遮罩的宽度是固定的呀，溢出两个像素，就抹两个像素，那样好看吗？」
		 * 理由：宽度随内容跳变会让同一种淡出忽宽忽窄、溢出 2px 时更是不成形；
		 * 固定 40px + 只在"挂不挂"上二值切换，观感才稳定。
		 */
		const COLS_FADE_PX = 40;
		/**
		 * 每个滚动容器上一次的 `{left, right}`（WeakMap：节点被回收就自动清掉，不泄漏）。
		 * 宽度现在是常量（只可能是 0 或 COLS_FADE_PX），所以只需记"挂不挂"这两个布尔 ——
		 * 布尔一变就整体重写两个变量，不会出现"宽度该改却没改"的情况。
		 */
		const colsFadeLast = new WeakMap();
		/** 每个滚动容器已排的 rAF id（同一帧只排一次）。 */
		const colsFadeFrame = new WeakMap();

		/**
		 * 按几何算一次该不该挂渐隐，**只在状态真的变化时**才动 class / 写内联变量。
		 * 返回 `{left, right, leftPx, rightPx}`（两个 Px 恒为 `0` 或 `COLS_FADE_PX`）。
		 *
		 * 两侧各自独立判断：
		 *   · `right` —— 右边还有没滚到的内容（`overflow - scrollLeft > 1px`）
		 *   · `left`  —— 左边已经有内容滚出去了（`scrollLeft > 1px`）
		 * 两个都为 false 时整条 mask 摘掉：不挂 class 就不参与合成，滚动时也没有额外重绘。
		 *
		 * **宽度固定 40px，不按溢出量收窄**（用户拍板，理由见 COLS_FADE_PX 上方注释）。
		 * 也就是说这里只做"该不该挂"的二值判断，不关心溢出 2px 还是 200px ——
		 * 溢出一丁点就说明要滚，那就给同样的 40px 淡出。
		 *
		 * **还能继续加行的容器一律不挂**：见下面 `data-cols-grow` 那段。
		 *
		 * 为什么用 CSS 变量而不是写死两个 class：mask-image 是单条属性，两条规则会互相覆盖，
		 * 只有把「左边留多宽 / 右边留多宽」变成变量，才能在一条 gradient 里同时表达两侧。
		 * 变量只在状态真的变化那一帧写一次，滚动过程中完全不碰。
		 */
		function applyColsFade(node) {
			const idle = { left: false, right: false, leftPx: 0, rightPx: 0 };
			if (node === null || node === undefined) return idle;
			if (node.classList === undefined || node.classList === null || typeof node.classList.add !== "function") return idle;
			if (typeof node.classList.remove !== "function") return idle;
			const scrollWidth = typeof node.scrollWidth === "number" ? node.scrollWidth : 0;
			const clientWidth = typeof node.clientWidth === "number" ? node.clientWidth : 0;
			const scrollLeft = Number(node.scrollLeft) || 0;
			const overflow = scrollWidth - clientWidth;
			/* **还能继续加行的容器一律不显示遮罩**（用户最终判据，原话：
			   「只有超过每列 12 的情况才应该有这个淡出遮罩，因为其他情况都不涉及到滚动。」）。
			   `data-cols-grow="1"` 由 rowsPanel 只挂在「工具调用子视图 + perColumn 未到 12 行」的
			   多列容器上。此时量出来的溢出只是"还没加完行"的中间态 —— 下一帧 useTipLayout 会
			   继续加行、气泡随之变宽，用户永远不需要横向滚，挂遮罩就是误报
			   （用户实机报的「4 行 × 5 列、明明能完整显示却有淡出」正是这个中间态）。
			   非 tight 的多列面板（技能列表 / 压缩列表）没有加行机制，不带这个属性 ⇒ 照旧按
			   几何决定，溢出就是真要滚。
			   用 DOM 属性而不是给函数加参数：applyColsFade 的调用点有 4 处（挂载 ref、onScroll、
			   滚轮写入后、refreshColsFade），挨个传参会漏；属性跟着节点走，谁调都读得到。 */
			const growable = typeof node.getAttribute === "function" && node.getAttribute("data-cols-grow") === "1";
			/* 1px 容差与 toolColumnsOverflow 同口径：亚像素取整不该被当成"还有内容" */
			const hiddenRight = overflow - scrollLeft;
			const showRight = growable !== true && overflow > 1 && hiddenRight > 1;
			const showLeft = growable !== true && overflow > 1 && scrollLeft > 1;
			/* 宽度**固定** COLS_FADE_PX：只在"挂不挂"上二值切换，不按溢出量收窄
			   （用户拍板理由见 COLS_FADE_PX 上方注释）。所以这里只有 0 / 40 两种值。 */
			const state = {
				right: showRight,
				left: showLeft,
				rightPx: showRight === true ? COLS_FADE_PX : 0,
				leftPx: showLeft === true ? COLS_FADE_PX : 0
			};
			const last = colsFadeLast.get(node);
			/* **只有"挂不挂"真的变化才动 DOM**（关键：没变时连 classList / style 都不碰，不会每帧重新栅格化）。
			   宽度是常量，所以只比两个布尔就够 —— 布尔一变，两个变量整体重写（恒为 0 / 40）。 */
			if (last !== undefined && last.left === state.left && last.right === state.right) return state;
			colsFadeLast.set(node, state);
			if (state.left !== true && state.right !== true) {
				node.classList.remove(COLS_FADE_CLASS);
				return state;
			}
			node.classList.add(COLS_FADE_CLASS);
			/* 只在拿得到内联样式时才写（测试替身可能没有 style） */
			if (node.style !== undefined && node.style !== null && typeof node.style.setProperty === "function") {
				node.style.setProperty("--dsb-fade-l", state.leftPx + "px");
				node.style.setProperty("--dsb-fade-r", state.rightPx + "px");
			}
			return state;
		}

		/** 首次挂载 / 尺寸变化时主动算一次：光等 onScroll 的话，刚打开的面板永远等不到事件。 */
		function primeColsFade(node) {
			if (node === null || node === undefined) return;
			applyColsFade(node);
		}

		/**
		 * 对一个**面板**里所有列网格重算渐隐。
		 *
		 * 为什么需要这个入口：渐隐原来只在「挂载那一刻」和「滚动时」重算，而工具气泡会
		 * **逐档加行**（3 → 4 → 5 …）—— 加完之后列数变少、气泡变宽，可能已经不需要滚动了，
		 * 但节点被 React 复用（key 没变、ref 是模块级常量），ref 不会再触发 ⇒ 遮罩一直留着。
		 * 用户实机看到的就是「4 行 × 5 列、明明不用滚，右侧却有一道淡出」。
		 *
		 * 取法与 toolColumnsOverflow 完全一致（同为 `panel.querySelectorAll(".dsb-meter-cols")`）。
		 * 拿不到 DOM 几何（测试替身）时 applyColsFade 自己会兜住，不报错。
		 */
		function refreshColsFade(panel) {
			if (panel === null || panel === undefined) return;
			if (typeof panel.querySelectorAll !== "function") return;
			const grids = panel.querySelectorAll(".dsb-meter-cols");
			if (grids === null || grids === undefined) return;
			for (let g = 0; g < grids.length; g += 1) applyColsFade(grids[g]);
		}

		/**
		 * 列网格的回调 ref：**必须是模块级常量**，不能放进渲染函数里。
		 *
		 * 为什么：React 在 ref 回调的**引用**变化时会先 `ref(null)` 再 `ref(node)`。
		 * 渲染函数里每帧都写 `const colsFadeRef = (node) => ...`，等于每帧都换一个新函数，
		 * 于是底栏每秒一次的重渲染都会重新触发一次 ref 回调 —— 而 `applyColsFade` 第一件事
		 * 就是读 `scrollWidth` / `clientWidth`，那是**强制同步布局**。打开多列工具气泡
		 * （尤其 420 个工具那档）期间就变成每秒一次强制布局，正是用户报的「一卡一顿」。
		 * 换成模块级常量后引用永远不变，只在真正挂载/卸载时才跑。
		 *
		 * （这里也不能用 react.useRef：rowsPanel 是 StatusBar 渲染时直接调用的普通函数，
		 *   在里面调 hook 会往 hook 链里插一个时有时无的 hook，破坏 hook 顺序。）
		 */
		const colsFadeRef = (node) => { primeColsFade(node); };

		/**
		 * onScroll 入口：用 rAF 合并，一帧最多算一次。
		 * `event.currentTarget` 在异步回调里会变成 null（React 合成事件会回收），所以**先取出节点**。
		 */
		function syncColsFade(event) {
			const node = event === null || event === undefined ? null : event.currentTarget;
			if (node === null || node === undefined) return;
			/* 已经排过这一帧：什么都不做（被合并掉） */
			if (colsFadeFrame.has(node) === true) return;
			const schedule = typeof window !== "undefined" && window !== null && typeof window.requestAnimationFrame === "function"
				? window.requestAnimationFrame
				: null;
			if (schedule === null) {
				/* 没有 rAF（测试替身 / 极老环境）：直接算，退化成同步版本，行为仍然正确 */
				applyColsFade(node);
				return;
			}
			const frame = schedule(() => {
				colsFadeFrame.delete(node);
				applyColsFade(node);
			});
			colsFadeFrame.set(node, frame);
		}

		/**
		 * 工具调用子视图的列网格**是否横向放不下**：放不下返回 true，交给 nextToolRows 逐档加行
		 * （3 → 4 → 5 …，行数加上去列数就变少，直到一排放得下）。
		 *
		 * 为什么不是「量各列 top 判断折行」：列网格已改成 `flex-wrap:nowrap`（用户拍板：
		 * **绝不能折行**），折行在任何情况下都不会发生 —— 再按 top 判会恒为 false，
		 * 逐档加行就彻底失效了。改成量**内容宽度 vs 容器宽度**（scrollWidth > clientWidth），
		 * 这才是 nowrap 下"放不下"的唯一表现，也是加行的原始动机。
		 *
		 * 判据用 `1px` 容差：scrollWidth / clientWidth 都是整数，亚像素取整可能差 1px，
		 * 差 1px 不该被当成溢出，否则会白加一档行数。真溢出时通常差几十上百像素。
		 *
		 * **所有支持逐档加行的子视图**都参与：工具调用、技能注入、上下文压缩这三个
		 * （它们的列表对象上带 `growable: true`，渲染时多列容器会带 `data-cols-growable`）。
		 * 以前这里只认 `dsb-meter-tight`，于是后两个列表固定 3 行、直接横向滚动 ——
		 * 用户明确要求「技能注入也和工具调用同理……上下文压缩也同理」。
		 * **不能用 tight 当判据**：tight 是视觉样式（收窄名字与数值的间隙），只适合短英文工具名；
		 * 技能名和「第二次压缩*」都很长，套 tight 会挤在一起。所以判据换成能力标记。
		 * 拿不到 DOM 几何（测试替身 / 面板还没挂上）时一律当"放得下"，避免在非浏览器环境里误判。
		 */
		function toolColumnsOverflow(panel) {
			if (panel === null || panel === undefined) return false;
			if (typeof panel.querySelector !== "function" || typeof panel.querySelectorAll !== "function") return false;
			/* `data-cols-growable` 表示"这类列表支持加行"（与 `data-cols-grow` 不是一回事：
			   后者表示"当前还没加到 12 行上限"，只给遮罩判据用）。两者都要，别合并。 */
			if (panel.querySelector("[data-cols-growable]") === null) return false;
			const grids = panel.querySelectorAll(".dsb-meter-cols");
			if (grids === null || grids === undefined) return false;
			for (let g = 0; g < grids.length; g += 1) {
				const node = grids[g];
				if (node === null || node === undefined) continue;
				const scrollWidth = typeof node.scrollWidth === "number" ? node.scrollWidth : null;
				const clientWidth = typeof node.clientWidth === "number" ? node.clientWidth : null;
				if (scrollWidth === null || clientWidth === null) continue;
				if (clientWidth <= 0) continue;
				if (scrollWidth - clientWidth > 1) return true;
			}
			return false;
		}

		/**
		 * 两列面板：标题 + 主数值，下面若干「名称 / 数值」行（用时、极值、命中率、余额、会话数据这类段用）。
		 * 行上带 sub 的（会话数据那三行）点一下就把整个气泡换成子视图：标题变成子视图名、内容换成列表，
		 * 子视图沿用主气泡的字号字色（不是二次气泡），点标题回到上一层。
		 * 子视图的列表每列最多三行、超了往右加列（工具调用那档按量测逐档加到 4、5 … 直到不折行）。
		 */
		function rowsPanel(tip, pos, ref, sub) {
			const rows = tip.rows === undefined ? [] : tip.rows;
			/* 列网格的 ref：节点一挂上就量一次几何（右缘渐隐"首次就要显示"靠它）。
			   **注意这里不能用 react.useRef** —— rowsPanel 是 StatusBar 渲染时**直接调用的普通函数**
			   （不是组件），在里面调 hook 会往 StatusBar 的 hook 链里插一个条件下才出现的 hook，
			   破坏 hook 顺序。所以用**回调 ref**：React 挂载节点时回调一次，值不进 hook 链。
			   ref 用模块级常量（见 colsFadeRef 定义处）：每帧新建函数会让 React 每帧重跑一次
			   ref 回调，进而每帧强制同步布局。 */
			const openedAt = sub === undefined || sub === null || typeof sub.id !== "number" ? null : sub.id;
			const opened = openedAt === null || rows[openedAt] === undefined || rows[openedAt].sub === undefined
				? null
				: rows[openedAt].sub;
			/* 一行里的三块：色块（可选，与上面那条色条一一对应）+ 名称 + 数值。
			   名称也可能是节点数组（手动调用 / 手动压缩的名字**后面**要挂上标星号，
			   子能力的名字后面挂 `+` 角标 —— 拼成字符串就插不进去了），这里原样交给
			   React 当子节点。可点行与普通行共用这一份，别各写一遍。 */
			const parts = (row, key) => [
				row.color === undefined || row.color === null
					? null
					: h("span", { className: "dsb-meter-swatch", key: key + "c", style: { background: row.color } }),
				h("span", { className: "dsb-meter-name", key: key + "n" }, row.label),
				row.value === undefined || row.value === null || row.value === ""
					? null
					: h("span", { className: "dsb-meter-value", key: key + "v" }, row.value)
			];
			const cell = (row, key) => h("span", { className: "dsb-meter-row", key: key }, parts(row, key));
			let body = null;
			/* 分列的子视图比单列宽：面板默认 560px 上限会把三列挤扁，这里放开一档 */
			let wide = false;
			if (opened === null) {
				body = h("span", { className: "dsb-meter-rows dsb-meter-rows-fit", key: "__xrows" },
					rows.map((row, index) => {
						if (row.sub === undefined || row.sub === null) return cell(row, "__xr" + index);
						return h("span", {
							className: "dsb-meter-row dsb-meter-row-click",
							key: "__xr" + index,
							onClick: (event) => {
								stopTipClick(event);
								if (sub.open !== undefined) sub.open(index);
							}
						}, parts(row, "__xr" + index));
					}));
			} else {
				/* 每列几行：**支持加行的三个子视图**（工具调用 / 技能注入 / 上下文压缩）
				   由 StatusBar 量完 DOM 后逐档加（3 → 4 → 5 …，最多 12），其余子视图照旧 3。
				   判据用 `growable`（能力）而不是 `tight`（视觉）：tight 只管把名字与数值的
				   间隙收到 1ch，只适合短英文工具名；技能名与「第二次压缩*」都很长，套了会挤。
				   所有行统一走**一个**列网格 —— 工具名就是原生英文名，
				   不再有「中文/英文整行块」两套结构。 */
				const perColumn = opened.growable === true && sub !== undefined && sub !== null
					&& typeof sub.rowsPerColumn === "number"
					? sub.rowsPerColumn
					: LIST_ROWS_PER_COLUMN;
				const columns = listColumns(opened.rows, perColumn);
				wide = columns.length > 1;
				/* 一列时不套外层（与其它面板的行结构完全一致），分列才多一层；
				   子视图带 tight 的（工具调用）另挂一个类，把名字与数值的间隙收紧 */
				const cls = "dsb-meter-rows dsb-meter-rows-fit"
					+ (columns.length > 1 ? " dsb-meter-cols" : "")
					+ (opened.tight === true ? " dsb-meter-tight" : "");
				/* 多列时的交互约定（用户拍板）：
				   · 横向滚动**只能用鼠标滚轮** —— onWheel 把 deltaY 转成 scrollLeft 并
				     preventDefault（详见 wheelToHorizontalScroll 的 deltaMode 说明）；
				   · 方向键/翻页键一律拦掉（onKeyDown + blockKeyScroll）；
				   · **不可聚焦**：tabIndex -1 让它不参与 Tab 序列，也不给浏览器"点过就获得焦点、
				     随后方向键能滚"的机会。overlay 上的焦点由 stopTipClick 挡住冒泡来保证。
				   · 右缘淡出：`ref: colsFadeRef` 在**挂载那一刻**就量一次几何（这就是"首次打开
				     也要有渐隐"的修法 —— 光靠 onScroll 永远等不到首次事件），之后滚动由
				     syncColsFade 用 rAF 合并着维护。
				   · `data-cols-grow="1"`：**这个容器还能继续加行**（支持加行的子视图且未到 12 行上限）。
				     applyColsFade 见到它就不显示遮罩 —— 加行机制保证未到上限前程序会继续加行，
				     此时"量出来溢出"只是还没加完行的中间态，用户并不会真的需要横向滚。
				     用户最终判据原话：「只有超过每列 12 的情况才应该有这个淡出遮罩，
				     因为其他情况都不涉及到滚动。」
				   · `data-cols-growable="1"`：**这类列表支持加行**（能力标记，与上面那个不是一回事）。
				     它跟着 `opened.growable` 走，加到 12 行上限后**依然带着** —— 因为
				     `toolColumnsOverflow` 靠它判断"要不要量溢出"，而那时仍然需要量
				     （量出来才知道该不该显示遮罩）。两个属性都留着，别合并。 */
				const canGrow = opened.growable === true;
				const stillGrowable = canGrow === true && perColumn < LIST_ROWS_PER_COLUMN_MAX;
				const colProps = columns.length > 1
					? {
						className: cls,
						key: "__xrows",
						ref: colsFadeRef,
						tabIndex: -1,
						onWheel: wheelToHorizontalScroll,
						onKeyDown: blockKeyScroll,
						onScroll: syncColsFade,
						"data-cols-growable": canGrow === true ? "1" : undefined,
						"data-cols-grow": stillGrowable === true ? "1" : undefined
					}
					: { className: cls, key: "__xrows" };
				body = columns.length > 1
					? h("span", colProps,
						columns.map((column, at) => h("span", { className: "dsb-meter-col", key: "__col" + at },
							column.map((row, index) => cell(row, "__c" + at + "r" + index)))))
					: h("span", colProps,
						(columns[0] === undefined ? [] : columns[0]).map((row, index) => cell(row, "__r" + index)));
			}
			/* 标题下那条：根视图用 tip.segments（余额/用时那种），子视图用 opened.segments（工具调用彩条）；
			   都没有就退回普通分隔线。彩条里的 title 只做悬浮提示，不加交互。 */
			const barSegments = opened === null
				? (Array.isArray(tip.segments) ? tip.segments : [])
				: (Array.isArray(opened.segments) ? opened.segments : []);
			return h("span", {
				className: wide === true ? "dsb-tip dsb-meter dsb-meter-wide" : "dsb-tip dsb-meter",
				key: "__tip", ref: ref, style: panelStyle(pos), onClick: stopTipClick, onMouseDown: stopTipClick
			}, [
				h("span", { className: "dsb-meter-head", key: "__xh" }, [
					opened === null
						? h("span", { className: "dsb-meter-headline", key: "__xt" }, tip.title)
						: h("span", {
							/* 点标题回上一层：不加返回箭头，靠光标与悬停变亮表示可点 */
							className: "dsb-meter-headline dsb-meter-back",
							key: "__xt",
							onClick: (event) => {
								stopTipClick(event);
								if (sub.back !== undefined) sub.back();
							}
						}, opened.title),
					tip.head === undefined || tip.head === null
						? null
						: h("span", { className: "dsb-meter-figures", key: "__xhf" }, tip.head)
				]),
				/* 有分段数据就画色条（与令牌面板同一条），否则还是那条普通分隔线。
				   子视图的彩条（工具调用）每段挂插件自己的悬停处理：**只显示一行纯文字**
				   （工具名 + 占比），没有气泡、没有阴影（用户拍板）。 */
				barSegments.length > 0
					? h("span", {
						/* 悬停放大的动效**只在工具调用这个下钻子视图**启用：opened 非空且是 tight 列表才挂
						   dsb-bar-hoverable。根视图的分段条（余额/用时）与其它子视图一律是普通 .dsb-bar，
						   不参与任何悬停放大/过渡。 */
						className: opened !== null && opened.tight === true
							? "dsb-bar dsb-bar-hoverable"
							: "dsb-bar",
						key: "__xbar"
					}, barSegments.map((one, index) => {
						const segProps = {
							className: "dsb-bar-seg",
							key: "__xseg" + index,
							/* background-color 长写（不是 background 简写）：简写会把 background-clip 重置成
							   border-box，段内 1px 透明右边框的分隔就失效了 */
							style: { width: one.width + "%", backgroundColor: one.color }
						};
						if (opened !== null && sub !== undefined && sub !== null && typeof sub.hover === "function"
							&& one.name !== undefined && sub.hoverSuppressed !== true) {
							/* 用户拍板：不要气泡，只显示一行文字（工具名 + 占比），贴在鼠标上方最近处 */
							segProps.onMouseEnter = (event) => sub.hover(event, {
								plain: one.name + " " + one.percentText,
								follow: true
							});
							/* 在同一个色段里移动时只更新文字位置，不重建内容（避免闪断） */
							segProps.onMouseMove = (event) => {
								if (typeof sub.hoverMove === "function") sub.hoverMove(event);
								if (typeof event.stopPropagation === "function") event.stopPropagation();
							};
							segProps.onMouseLeave = () => sub.hover(null);
						}
						return h("span", segProps);
					}))
					: h("span", { className: "dsb-meter-divider", key: "__xdiv" }),
				body
			]);
		}

		/** 计价分量 → 令牌面板三段（未命中 = 未缓存输入 + 缓存写入，与官方 tokenUsage 同口径）。 */
		function billableParts(bucket) {
			return {
				cached: bucket.cacheRead || 0,
				missInput: (bucket.input || 0) + (bucket.cacheWrite || 0),
				output: bucket.output || 0
			};
		}

		/** 官方 tokenUsage 投影 → 同样的三段；没数据时返回 null。 */
		function sessionTokenParts(usage) {
			if (usage === undefined || usage === null) return null;
			return billableParts({
				cacheRead: usage.cacheReadTokens,
				input: usage.uncachedInputTokens,
				cacheWrite: usage.cacheWriteTokens,
				output: usage.outputTokens
			});
		}

		/**
		 * 宿主投影里的「压缩摘要 token 累计」→ 与本面板同样的三段。
		 *
		 * 为什么要单独加这一份：**「总计费用」含摘要，「总计用量」原本不含** ——
		 * 费用是我们自己逐条算的（`addCallTotals` 对 `compaction/summary` 也累加），
		 * 而用量来自官方 `tokenUsage` 投影，官方只折 `assistant` 事件、不含压缩摘要。
		 * 结果同一个气泡里两个数字口径不一致。用户拍板「官方投影继续用，只把摘要这部分
		 * 额外加上」，这个函数就是那个「额外加上」的部分。
		 *
		 * 口径必须与 `billableParts` 一致：`input` + `cacheWrite` 都算未命中（missInput），
		 * `cacheRead` 算命中，`output` 算输出 —— 否则三行明细与总计对不上。
		 * 宿主老版本没有 `summaryParts`（或值为空）时返回 null，调用方跳过即可。
		 */
		function summaryTokenParts(summaryParts) {
			if (summaryParts === undefined || summaryParts === null || typeof summaryParts !== "object") return null;
			return billableParts(summaryParts);
		}

		/**
		 * 令牌面板的 tip。没有数据也给面板（三行横杠）—— 气泡必须任何情况下都点得开。
		 * `sub` 是子代理三段：条上会拆出浅色子段；`parts` 为 null（本会话还没上报用量）
		 * 但有子代理数据时，用子代理的三段当合并值，不能退化成横杠（否则队友的量看不见）。
		 */
		function tokensTip(parts, title, t, sub) {
			const subParts = sub === null || sub === undefined ? null : sub;
			const merged = parts === null || parts === undefined
				? (subParts === null ? null : { cached: subParts.cached, missInput: subParts.missInput, output: subParts.output })
				: parts;
			const panel = merged === null ? null : tokenPanelView(merged.cached, merged.missInput, merged.output, t, subParts);
			return { kind: "tokens", title: title, panel: panel === null ? dashTokenPanel(t) : panel };
		}

		/** 毫秒 → 面板里的时长文本（精确到秒）；0 或缺数据给横杠。 */
		function tipDuration(ms) {
			/* 面板要精确到秒，底栏那条省秒（宽度有限）。 */
			const text = formatDuration(ms, true);
			return text === null ? "-" : text;
		}

		/**
		 * 运行用时面板的三段色条：等待用时=灰、模型用时(解码)=紫、工具调用=蓝。
		 * 三者都是 0 时返回空数组，面板退回那条普通分隔线。
		 */
		function durationSegments(waitMs, modelMs, toolMs) {
			const wait = Math.max(0, Number(waitMs) || 0);
			const model = Math.max(0, Number(modelMs) || 0);
			const tool = Math.max(0, Number(toolMs) || 0);
			const total = wait + model + tool;
			if (total <= 0) return [];
			return [
				{ color: DURATION_COLORS.wait, width: (wait / total) * 100 },
				{ color: DURATION_COLORS.model, width: (model / total) * 100 },
				{ color: DURATION_COLORS.tool, width: (tool / total) * 100 }
			].filter((one) => one.width > 0);
		}

		/** 本轮命中率：这一轮的输入 token 里命中缓存的比例；本轮还没有调用给横杠。
		    读插件自己的 desktopStatusbarUsage 投影 —— 官方 tokenUsage 只有会话累计值。
		    注意字段是短名（input / cacheRead / cacheWrite），与官方投影的 *Tokens 不同名。 */
		function turnHitRate(sessionUsage) {
			const current = sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.current;
			if (current === null || current === undefined) return "-";
			const denominator = (current.input || 0) + (current.cacheRead || 0) + (current.cacheWrite || 0);
			if (denominator <= 0) return "-";
			return hitRateText(((current.cacheRead || 0) / denominator) * 100);
		}

		/** 本轮平均首字（秒，一位小数）；本轮还没有样本给横杠。 */
		function turnAverageTtft(timing) {
			if (timing === null || timing === undefined) return "-";
			const samples = timing.turnTtftSamples || 0;
			if (samples <= 0) return "-";
			const text = formatSeconds(timing.turnTtftMs / samples);
			return text === null ? "-" : text + "s";
		}

		/** 本轮平均输出速度；本轮还没有可测样本给横杠。 */
		function turnAverageTps(timing, t) {
			if (timing === null || timing === undefined) return "-";
			const decodeMs = timing.turnDecodeMs || 0;
			const tokens = timing.turnDecodeTokens || 0;
			if (decodeMs <= 0 || tokens <= 0) return "-";
			return formatThroughput(tokens / (decodeMs / 1000)) + t("unitSpeed");
		}

		/** 首字极值（毫秒）→ "9.3s"；没有样本给横杠。 */
		function tipSeconds(mark) {
			if (mark === null || mark === undefined) return "-";
			const text = formatSeconds(mark.value);
			return text === null ? "-" : text + "s";
		}

		/** 速度极值（tokens/秒）→ "42t/s"；没有样本给横杠。 */
		function tipSpeed(mark, t) {
			if (mark === null || mark === undefined) return "-";
			return formatThroughput(mark.value) + t("unitSpeed");
		}

		/** 中文序数里的数字：1 → 一、11 → 十一、21 → 二十一、101 → 一百零一。三位数以外退回阿拉伯数字。 */
		function chineseNumber(value) {
			const n = Math.round(Number(value) || 0);
			if (!(n >= 1 && n <= 999)) return null;
			const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
			const under100 = (num) => {
				if (num < 10) return DIGITS[num];
				if (num < 20) return "十" + (num % 10 === 0 ? "" : DIGITS[num % 10]);
				return DIGITS[Math.floor(num / 10)] + "十" + (num % 10 === 0 ? "" : DIGITS[num % 10]);
			};
			if (n < 100) return under100(n);
			const rest = n % 100;
			const head = DIGITS[Math.floor(n / 100)] + "百";
			if (rest === 0) return head;
			return head + (rest < 10 ? "零" + DIGITS[rest] : under100(rest));
		}

		/**
		 * 手动调用 / 手动压缩那一项的星号：做成**上标**（像 X² 的 ²），不是普通的星号字符。
		 * 读屏要能听到「手动触发」：span 默认是 generic 角色、aria-label 会被忽略，
		 * 所以给它 img 角色当纯图形标注，视觉里仍然只有那个 *。
		 * title 留给鼠标悬停；中英界面都要显示，所以由调用方传当前语言的 t 进来。
		 */
		function manualStar(t) {
			/* 只有读屏名称，**不挂 title**：星号只有 11px，鼠标几乎落不到它上面，
			   留一个原生悬停气泡只会是"偶尔冒出来一下"的意外行为（用户明确不要）。
			   aria-label 保留 —— 它只服务屏幕阅读器，不产生任何可见元素。 */
			return h("span", {
				className: "dsb-sup",
				key: "__star",
				role: "img",
				"aria-label": t("tipManual")
			}, "*");
		}

		/**
		 * **子能力**（`sub: true`）名字后面的角标：一个上标的 `+`。
		 *
		 * 符号由用户指定（先前试过 `†`，用户看完实机后要求换成 `+`）。
		 * `+` 比 `*` / `†` **笔画细、体量小**，同一个 `.dsb-sup` 字号（.7em）下会显得比星号轻一档，
		 * 所以额外挂一个 `.dsb-sup-strong` 修饰类，把字重提到 600 —— 只改粗细，**不改字号与抬高量**：
		 * 两种角标的行盒高度必须一样，否则同一列表里一行高一行低（`.dsb-sup` 的 line-height:0 就是为此），
		 * 只加粗不会碰到这一点。
		 *
		 * 读屏另有文案（`tipSub`），不与手动的「手动触发」重名。
		 */
		function subStar(t) {
			/* 与 manualStar 同样不挂 title：亚 11px 的角标上没有可停留的鼠标热区 */
			return h("span", {
				className: "dsb-sup dsb-sup-strong",
				key: "__substar",
				role: "img",
				"aria-label": t("tipSub")
			}, "+");
		}

		/** 子视图没有内容时给一行横杠：气泡任何情况下都要打得开，也不能是一片空白。 */
		function emptyList(title) {
			return { title: title, rows: [{ label: title, value: "-" }] };
		}

		/**
		 * 技能注入子视图：只列名字，**不显示统计次数**（用户明确要求：次数只用来排序）。
		 * 同名注入在内部聚合计数，排序 = **名字短的在前** → 注入次数多的在前 → 字典序；
		 * 次数只参与排序，不进界面（与工具调用「次」那套无关）。
		 *
		 * 两种角标（用户拍板：**平铺、不加父技能前缀**，两个都挂在名字**后面**）：
		 *   · 手动调用的技能（`manual: true`）→ `名字*`（manualStar 上标）
		 *   · 子能力（`sub: true`，模型读了某技能的子能力文档）→ `名字+`（subStar 上标）
		 * 同名聚合时"只要其中有一次是手动就算手动"、"只要有一次是子能力就算子能力" ——
		 * 聚合规则沿用现状，不做分组、不按来源拆行。
		 * 全局提示词（AGENTS.md 这类）**固定排第一**：它也是注入的一种，但不是技能调用，
		 * 不参与上面那套技能排序；其余技能照常排（子能力与普通技能混在同一个列表里）。
		 */
		function skillList(skills, globalInstruction, t) {
			const title = t("tipCountsSkills");
			const names = [];
			const counts = new Map();
			const manual = new Set();
			/* 子能力是**新增的可选字段**：老宿主 / 旧 state 里根本没有 `sub`，
			   这里一律按 false 处理（不是"未知"），旧数据因此渲染得与改动前一模一样。 */
			const subs = new Set();
			const pinned = typeof globalInstruction === "string" && globalInstruction.length > 0 ? globalInstruction : null;
			const add = (name, isManual, isSub) => {
				const key = String(name);
				if (key.length === 0) return;
				if (counts.has(key) !== true) {
					counts.set(key, 0);
					names.push(key);
				}
				counts.set(key, counts.get(key) + 1);
				if (isManual === true) manual.add(key);
				if (isSub === true) subs.add(key);
			};
			if (pinned !== null) add(pinned, false, false);
			if (Array.isArray(skills)) {
				skills.forEach((entry) => {
					/* 契约是 `{ name, manual, sub? }`；旧宿主（还没升级的那一半）只给字符串，兼容一下 */
					if (typeof entry === "string") {
						add(entry, false, false);
						return;
					}
					if (entry === null || entry === undefined || typeof entry.name !== "string") return;
					add(entry.name, entry.manual === true, entry.sub === true);
				});
			}
			if (names.length === 0) return emptyList(title);
			const rest = names.filter((name) => name !== pinned);
			rest.sort((a, b) => a.length - b.length
				|| counts.get(b) - counts.get(a)
				|| (a < b ? -1 : (a > b ? 1 : 0)));
			const ordered = pinned !== null && counts.has(pinned) ? [pinned].concat(rest) : rest;
			/* 行上只有名字 + 两种角标，不带 value —— 次数只用于上面的排序。
			   角标**都挂在名字后面**（用户拍板，实机看完改回来的）：手动 `*` → `名字*`，
			   子能力 `+` → `名字+`。以前试过"手动星号前置、子能力后置"靠前后位置区分，
			   但用户指出**子能力不可能由他手动调用**，两者不会落在同一个名字上，不需要位置区分；
			   而"星号在后"读起来更像脚注标注，也与压缩列表保持同一种写法。
			   （代码仍兼容两者同时出现的情况：那时渲染成 `名字*+`，谁在前谁在后都不影响识别。） */
			return {
				title: title,
				rows: ordered.map((name) => {
					const isManual = manual.has(name) === true;
					const isSub = subs.has(name) === true;
					if (isManual !== true && isSub !== true) return { label: name };
					const label = [name];
					if (isManual === true) label.push(manualStar(t));
					if (isSub === true) label.push(subStar(t));
					return { label: label };
				}),
				/* **支持逐档加行**（用户原话：「技能注入也和工具调用同理呀，如果超过每列 3 个
				   依然排不下，就是加每列的个数啊，而不是直接可滚动啊」）。
				   注意这里是**能力**标记，与 `tight`（视觉：把名字与数值的间隙收到 1ch）无关 ——
				   技能名很长，套 tight 会把长名字挤在一起，所以两者必须分开。 */
				growable: true
			};
		}

		/* 工具调用分段条的 32 色（按 01→32 顺序使用、浅→浓，每 8 个一行）。
		   颜色跟着「显示顺序」走：第 1 个工具用第 1 色，超过 32 个循环回第 1 色。 */
		const TOOL_BAR_COLORS = [
			"#FFBFD1", "#FFC5AB", "#F4D06A", "#B0E693", "#72ECD6", "#93E0FF", "#C3D2FF", "#EBC1FF",
			"#FFA29E", "#F5AE60", "#C0C762", "#77D6A1", "#57D4DE", "#87C5FF", "#C0B3FC", "#EDA3D8",
			"#EB9067", "#CAA63E", "#88BC6B", "#42C2AD", "#54B9DD", "#91A7EC", "#C496D9", "#E68BA8",
			"#CA8634", "#989E36", "#4DAD79", "#1BAAB4", "#609CD4", "#998BD1", "#C27BAF", "#D67774"
		];

		/**
		 * 「工具调用」子视图：直接显示**原生工具名**（不翻译，用户拍板：翻不准就用原名）。
		 * **先按名字长度升序（短的在前），同长再按调用次数降序，最后字典序**；
		 * 同名（同名原始名）合并计数 —— 不同工具天然不同名，不会被合并。
		 * 名字短、列多，标 tight 让名字与次数之间的间隙收到 1ch。
		 * 所有行统一走一个列网格：每列默认 3 行，折行时逐档 4→5…（上限 12，见 LIST_ROWS_PER_COLUMN_MAX；
		 * LIST_ROWS_PER_COLUMN 是默认值 3，别把两者搞混）。
		 * 同时给出 `segments`：标题下那条彩条，按上面的显示顺序取 32 色（第 33 个循环回第 1 色），
		 * 宽度 = 该工具次数 ÷ 总次数；每段带 `name` / `percentText`（两位小数占比），给状态栏的悬停提示用。
		 */
		function toolList(counts, t) {
			const title = t("tipCountsToolCalls");
			/* `growable: true` 见 skillList 末尾的说明：能力标记，表示这个子视图支持逐档加行。
			   工具调用是最早支持的那个（也是唯一需要 tight 视觉收紧的：原生工具名都是短英文）。 */
			if (counts === null || typeof counts !== "object") return Object.assign(emptyList(title), { tight: true, growable: true });
			const entries = Object.keys(counts)
				.map((name) => ({ label: name, count: Number(counts[name]) || 0 }))
				.filter((one) => one.count > 0)
				.sort((a, b) => a.label.length - b.label.length
					|| b.count - a.count
					|| (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)));
			if (entries.length === 0) return Object.assign(emptyList(title), { tight: true, growable: true });
			const total = entries.reduce((sum, one) => sum + one.count, 0);
			const rows = entries.map((one) => ({ label: one.label, value: formatTokensExact(one.count) + t("unitCountCalls") }));
			const segments = entries.map((one, index) => {
				const percent = (one.count / total) * 100;
				return {
					color: TOOL_BAR_COLORS[index % TOOL_BAR_COLORS.length],
					width: percent,
					/* 悬停浮层用：工具名 + 占比（两位小数，不带次数；浮层由 StatusBar 的 onHover 统一渲染） */
					name: one.label,
					percentText: percent.toFixed(2) + "%"
				};
			});
			return { title: title, rows: rows, tight: true, segments: segments, growable: true };
		}

		/**
		 * 「上下文压缩」子视图：逐条列出每次压缩落在第几轮第几步（顺序就是发生的顺序）。
		 * host 已经滤掉失败的压缩，这里只按契约渲染。落点三档：
		 *   turn 是数字 → 「第X轮Y步」（step 为空时「第X轮」）；
		 *   turn 为 null（手动 /compact 的轮间压缩）→ 用 afterTurn 显示「第X轮后」，
		 *     否则手动压缩只剩一个横杠，用户看不出它发生在哪儿（2026-10 实测反馈）；
		 *   afterTurn 也没有 → 「-」。
		 *
		 * 手动压缩（`manual: true`）在**名字后面**跟上标星号（「第二次压缩*」），与技能列表
		 * 里「手动调用的技能」保持同一种写法（用户拍板：两种列表的星号都挂在名字后）。
		 * 星号挂在**整个名字**之后、不进序号内部 —— 序号本身仍是完整的「第二次」，
		 * 不会被拆成「第二*次」。以前一度挪到名字前（「*第二次压缩」），实机看完后用户
		 * 要求改回行尾：星号在后读起来更像脚注标注，与技能列表也一致。
		 */
		function compactList(compacts, t) {
			const title = t("tipCountsCompactAt");
			if (compacts === null || compacts === undefined || compacts.length === 0) return emptyList(title);
			const ordinal = detectLocale(t) === "zh";
			const rows = compacts.map((one, at) => {
				const index = at + 1;
				const word = ordinal === true ? chineseNumber(index) : null;
				const text = word === null ? String(index) : word;
				const mark = one === null || one === undefined ? {} : one;
				const turn = typeof mark.turn === "number" ? mark.turn : null;
				const step = typeof mark.step === "number" ? mark.step : null;
				const afterTurn = typeof mark.afterTurn === "number" ? mark.afterTurn : null;
				const label = t("tipCompactItem", { index: text });
				return {
					/* 星号在名字**后面**（与 skillList 一致）：手动压缩是「第二次压缩*」 */
					label: mark.manual === true ? [label, manualStar(t)] : label,
					value: turn !== null
						? (step === null ? t("tipCompactTurnOnly", { turn: turn }) : t("tipCompactWhere", { turn: turn, step: step }))
						: (afterTurn === null ? "-" : t("tipCompactAfter", { turn: afterTurn }))
				};
			});
			/* 与技能注入、工具调用同一套：**支持逐档加行**，不是直接横向滚动
			   （用户原话：「上下文压缩也同理啊」）。
			   同样只是能力标记 —— 压缩条目的名字（「第二次压缩*」）也不短，不能套 tight。 */
			return { title: title, rows: rows, growable: true };
		}

		/** 余额接口给的金额字符串；没有这个字段时按 0.00 显示。 */
		function balanceAmount(value) {
			return typeof value === "string" && value.length > 0 ? value : "0.00";
		}

		/**
		 * 积分数字（used / total）→ 显示文本：**保留两位小数、去掉无意义的尾零**。
		 * 上游给的是原始 number，实测带浮点尾数（12.389999979999999、552.42999936），
		 * 直接 String() 会显示一长串；这里四舍五入到分位：552.43 / 12.39 / 500。
		 */
		function formatCredits(value) {
			const n = Number(value);
			if (Number.isFinite(n) !== true) return "0";
			return String(Math.round(n * 100) / 100);
		}

		/**
		 * 积分套餐的一行文字：包名 + 备注（月度刷新 / 每月刷新兜底 / 到期），不排序。
		 * 聚合行（count > 1）名称带「×X」，日期换用「(最近)」版文案 —— 合并后只代表合计与最近到期日。
		 */
		function creditsLabel(one, t) {
			const merged = typeof one.count === "number" && one.count > 1;
			let label = merged ? one.name + "×" + one.count : one.name;
			if (one.monthly === true) {
				/* 月度包：有刷新日期就给日期，没有才退回「每月刷新」 */
				if (typeof one.refreshAt === "string" && one.refreshAt.length >= 10) {
					label += t(merged ? "tipCreditsRefreshLatest" : "tipCreditsRefresh", { date: one.refreshAt.slice(5, 10) });
				} else {
					label += t("tipCreditsMonthly");
				}
			} else if (typeof one.expireAt === "string" && one.expireAt.length >= 10) {
				label += t(merged ? "tipCreditsExpireLatest" : "tipCreditsExpire", { date: one.expireAt.slice(5, 10) });
			}
			return label;
		}

		/* 积分套餐名里的公共前缀：按顺序剥、只剥开头、可连续剥（例如
		   CodeBuddy个人版国内运营裂变包 → 个人版国内运营裂变包 → 国内运营裂变包 → 运营裂变包）。
		   纯本地实现，不查任何外部数据：上游以后新增什么套餐名都照样能剥。 */
		const CREDITS_NAME_PREFIXES = ["CodeBuddy", "个人版", "国内"];

		/**
		 * 显示用的套餐名：**保持上游原名，只剥渠道前缀**（不翻译）。
		 *
		 * 为什么不翻译：国内站（region=cn）的包名上游就是中文、国际站（region=global）上游就是英文，
		 * 本来就该原样显示。以前维护过一张双向映射表，但上游随时可能出新包
		 * （如国际站的 `Launch Bonus`），表里没覆盖到就会漏翻、比不翻更糟 —— 所以整张表已删除。
		 *
		 * 剥前缀规则（纯本地、可连续剥、大小写不敏感、**只剥开头**）：
		 *   ① 按 CREDITS_NAME_PREFIXES 顺序反复剥，直到一轮下来一个都没剥掉；
		 *   ② 全剥完是空串时保留原名 —— 不能给用户一行只有「· 11-01 到期」没有名字的东西；
		 *   ③ 前缀出现在中间（如 `我的CodeBuddy包`）不剥，因为只匹配开头。
		 *
		 * 入参 `t` 已不再使用（保留形参是为了不动调用方），但**不要**据此认为它有用。
		 */
		function creditDisplayName(name) {
			let out = name;
			let stripped = true;
			while (stripped === true) {
				stripped = false;
				for (let i = 0; i < CREDITS_NAME_PREFIXES.length; i += 1) {
					const prefix = CREDITS_NAME_PREFIXES[i];
					if (out.toLowerCase().indexOf(prefix.toLowerCase()) === 0) {
						out = out.slice(prefix.length);
						stripped = true;
						break;
					}
				}
			}
			return out.length === 0 ? name : out;
		}

		/* 裂变包的名字特征：同名包会聚合成「×N」一行、动辄十几条，排在中间会把正经套餐挤下去。
		   只按名字里有没有这两个字判断，不查任何外部清单 —— 上游新增什么裂变包都不用改代码。 */
		const CREDITS_SPLIT_KEYWORD = "裂变";

		/**
		 * 积分套餐的显示顺序（用户拍板，三档）：
		 *   ① **每月固定刷新的套餐永远第一行** —— 月度包是天天要看的那个，位置不能漂；
		 *   ② **裂变包永远最后** —— 它们会聚合成「×11」这种一行，放在中间太占位；
		 *   ③ 其余按**过期时间先后**排，最先要过期的排最前 —— 快用完的用户得先看见。
		 * 每一档内部同样按日期升序；**没有日期的排在同档有日期的之后**（不猜日期，也不让它插到前面）。
		 * 日期取哪个字段跟着套餐性质走：月度包看「下期刷新」，一次性包看「到期」。
		 * Array.prototype.sort 稳定，日期相同或都缺日期时保持上游原顺序，不会每次刷新跳来跳去。
		 */
		function creditsSortGroup(one) {
			if (one.monthly === true) return 0;
			if (String(one.name).indexOf(CREDITS_SPLIT_KEYWORD) !== -1) return 2;
			return 1;
		}

		/** 排序用的日期：月度包取刷新日、其余取到期日；都没有给空串（排在有日期的之后）。 */
		function creditsSortDate(one) {
			const value = one.monthly === true ? one.refreshAt : one.expireAt;
			return typeof value === "string" && value.length > 0 ? value : "";
		}

		function creditsSort(rows) {
			return rows.slice().sort((a, b) => {
				const groupA = creditsSortGroup(a);
				const groupB = creditsSortGroup(b);
				if (groupA !== groupB) return groupA - groupB;
				const dateA = creditsSortDate(a);
				const dateB = creditsSortDate(b);
				if (dateA === dateB) return 0;
				/* 空串（没有日期）恒排在最后 */
				if (dateA.length === 0) return 1;
				if (dateB.length === 0) return -1;
				return dateA < dateB ? -1 : 1;
			});
		}

		/** 两个 ISO 日期里取更早的那个（null 不参与）；合并相邻同名包时「只显示最近到期日」。 */
		function earliestDate(a, b) {
			if (a === null || a === undefined) return b === undefined ? null : b;
			if (b === null || b === undefined) return a;
			return a <= b ? a : b;
		}

		/**
		 * 积分套餐面板数据：`{ title, totalText, rewards[] }`。
		 * 每个套餐带上显示用字段（label / valueText / percent），渲染函数只负责画。
		 * **相邻且显示名相同**的套餐合并成一行：used/total 相加、percent 按合计重算、count 记原条数；
		 * 日期只取最近的一个（monthly 取最早 refreshAt，否则取最早 expireAt），不显示区间。
		 * 顺序：合并完再交给 `creditsSort` 排三档（月度置顶 / 其余按到期升序 / 裂变包置底）。
		 * 字段缺失（name 不是非空字符串）的套餐直接跳过。
		 * percent = clamp(used / total × 100, 0, 100)，total<=0 时给 0（画空轨道）。
		 */
		function creditsView(rewards, totalText, t) {
			const list = Array.isArray(rewards) ? rewards : [];
			const merged = [];
			list.forEach((one) => {
				if (one === null || one === undefined || typeof one !== "object") return;
				if (typeof one.name !== "string" || one.name.length === 0) return;
				const name = creditDisplayName(one.name);
				const used = Number(one.used) || 0;
				const total = Number(one.total) || 0;
				const monthly = one.monthly === true;
				const expireAt = typeof one.expireAt === "string" && one.expireAt.length >= 10 ? one.expireAt : null;
				const refreshAt = typeof one.refreshAt === "string" && one.refreshAt.length >= 10 ? one.refreshAt : null;
				/* 每个原始包自己保留一份明细（子视图里逐条列出，各自真实值 + 自己的日期备注） */
				const itemLabel = creditsLabel({ name: name, monthly: monthly, expireAt: expireAt, refreshAt: refreshAt, count: 1 }, t);
				const item = {
					name: one.name,
					used: used,
					total: total,
					expireAt: expireAt,
					refreshAt: refreshAt,
					monthly: monthly,
					label: itemLabel,
					/* 显示**剩余**而不是已用（用户要求：「不要显示已用，显示剩余」）。
					   `used` 仍然留着 —— 进度条宽度与 percent 都要它，只是不出现在文字里。
					   left 夹到 0：脏数据里 used > total 时绝不能显示负数。 */
					valueText: t("tipCreditsLeft", { left: formatCredits(Math.max(0, total - used)), total: formatCredits(total) }),
					percent: total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0
				};
				const last = merged.length > 0 ? merged[merged.length - 1] : null;
				if (last !== null && last.name === name) {
					last.used += used;
					last.total += total;
					last.count += 1;
					last.expireAt = earliestDate(last.expireAt, expireAt);
					last.refreshAt = earliestDate(last.refreshAt, refreshAt);
					last.items.push(item);
					return;
				}
				merged.push({
					name: name, used: used, total: total, count: 1,
					expireAt: expireAt, refreshAt: refreshAt, monthly: monthly, items: [item]
				});
			});
			/* 顺序：**先按原顺序聚合相邻同名包，最后再整体排序** —— 不能先排序，
			   排序会把这 11 个裂变包按日期打散，聚合就失效了（它们必须相邻才能并成一行）。 */
			const rows = creditsSort(merged.map((one) => {
				/* 该组剩余积分 = 总容量 - 已用（不小于 0）；下钻标题右侧显示它，随用量动态变化 */
				const remaining = Math.max(0, one.total - one.used);
				return {
					name: one.name,
					used: one.used,
					total: one.total,
					remaining: remaining,
					remainingText: formatCredits(remaining),
					count: one.count,
					items: one.items,
					expireAt: one.expireAt,
					refreshAt: one.refreshAt,
					monthly: one.monthly,
					label: creditsLabel(one, t),
					/* 聚合行同样显示**剩余**（与原始包 items 一致）；left 同样夹到 0，脏数据不出负数。
					   这里复用上面算好的 `remaining`（`Math.max(0, total - used)`），
					   保证"文字里的剩余"与"下钻标题右侧的剩余"是同一个数。 */
					valueText: t("tipCreditsLeft", { left: formatCredits(remaining), total: formatCredits(one.total) }),
					percent: one.total > 0 ? Math.max(0, Math.min(100, (one.used / one.total) * 100)) : 0
				};
			}));
			return { title: t("tipCreditsTitle"), totalText: totalText, rewards: rows };
		}

		/** 单次调用的缓存命中率（%）；这次调用一个输入 token 都没有时返回 null（算不出比例）。 */
		function hitRateOf(call) {
			const denominator = (call.input || 0) + (call.cacheRead || 0) + (call.cacheWrite || 0);
			if (denominator <= 0) return null;
			return ((call.cacheRead || 0) / denominator) * 100;
		}

		/** 命中率文本：四舍五入到小数点后三位，第三位是 0 也照留（99.995%、50.000%）。 */
		function hitRateText(percent) {
			return percent.toFixed(3) + "%";
		}

		/** 逐条调用里的最高/最低命中率；没有可用样本时返回 null（气泡里显示横杠）。 */
		function cacheHitExtremes(sessionUsage) {
			const calls = sessionUsage === undefined || sessionUsage === null || Array.isArray(sessionUsage.calls) !== true
				? []
				: sessionUsage.calls;
			let high = null;
			let low = null;
			for (let i = 0; i < calls.length; i += 1) {
				const rate = hitRateOf(calls[i]);
				if (rate === null) continue;
				if (high === null || rate > high) high = rate;
				if (low === null || rate < low) low = rate;
			}
			if (high === null) return null;
			return { high: hitRateText(high), low: hitRateText(low) };
		}

		/** 毫秒 → 秒（一位小数）；没有数据给 null。首字延迟这类不会超过一分钟的指标用它。 */
		function formatSeconds(ms) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			return String(Math.round(n / 100) / 10);
		}
		/** 时长按最小单位给：>=1h 用 h/m（withSeconds 时再带秒），>=1m 用 m/s，不足一分钟只给整数秒；
		    分钟与秒之间不加空格。面板要精确到秒传 true，底栏那条省秒（宽度有限）不传。 */
		function formatDuration(ms, withSeconds) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			const whole = Math.round(n / 1000);
			if (whole < 60) return whole + "s";
			const minutes = Math.floor(whole / 60);
			if (minutes < 60) return minutes + "m" + (whole % 60) + "s";
			const head = Math.floor(minutes / 60) + "h" + (minutes % 60) + "m";
			return withSeconds === true ? head + (whole % 60) + "s" : head;
		}
		function formatThroughput(tokensPerSecond) {
			return String(Math.round(Number(tokensPerSecond) || 0));
		}
		function billedInputTokens(usage) {
			return (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
		}
		function elapsedFromTimeline(timeline, now) {
			if (timeline === undefined || timeline === null) return null;
			const turns = timeline.turns;
			let list = [];
			try {
				if (turns !== undefined && turns !== null && typeof turns.values === "function") list = Array.from(turns.values());
				else if (Array.isArray(turns)) list = turns;
			} catch (error) {
				return null;
			}
			let start = null;
			let end = null;
			for (const turn of list) {
				if (turn === undefined || turn === null) continue;
				const began = turn.start !== undefined && turn.start !== null ? turn.start.time : undefined;
				const finished = turn.end !== undefined && turn.end !== null ? turn.end.time : undefined;
				if (typeof began === "number" && (start === null || began < start)) start = began;
				if (typeof finished === "number" && (end === null || finished > end)) end = finished;
			}
			if (start === null) return null;
			return Math.max(0, (end === null ? now : end) - start);
		}

		/* ------------------------------------------------------------ 段取值 */
		/**
		 * 峰谷段的气泡数据：host 扫会话日志得到「本周每天」的 token 用量。
		 * 数据还没回来时也给面板（空柱 + 一句提示），保证气泡任何情况下都点得开。
		 */
		function weeklyTip(src, t) {
			const daily = src.daily;
			const ok = daily !== null && daily !== undefined && daily.ok === true && Array.isArray(daily.days);
			const totals = ok && daily.totals !== undefined && daily.totals !== null ? daily.totals : null;
			return {
				kind: "bars",
				title: t("tipWeekTitle"),
				days: ok ? daily.days : [],
				total: totals === null ? 0 : Number(totals.total) || 0,
				calls: totals === null ? 0 : Number(totals.calls) || 0,
				/* 本周花费由 host 按模型单价 + 当时峰谷价算好（单位：人民币元） */
				cost: totals === null ? 0 : Number(totals.cost) || 0,
				/* 当月每日用量：右侧活跃度日历用 */
				month: ok && daily.month !== undefined && daily.month !== null ? daily.month : null,
				/* 当年 12 个月聚合：标题下面那 12 个方块用 */
				year: ok && daily.year !== undefined && daily.year !== null ? daily.year : null,
				today: dateKeyOf(src.now)
			};
		}

		function segmentView(id, src, t) {
			const stats = src.stats;
			const usage = src.usage;
			/* 底栏费用用的币种 = **显示币种**（主模型条目的币种，见 displayCurrencyOf），
			   不再是那个全局的"新增条目默认币种" —— 用户报的正是"没用过的模型也能改底栏币种"。 */
			const symbolCurrency = normalizeCurrency(src.currency);
			const symbol = currencySymbol(symbolCurrency);

						if (id === "status") {
				/* 拆分后这一段只出峰谷两个字：上下文占用圆环是独立开关，固定挂在栏首。
				   点开看本周每天的用量（host 扫会话日志按天汇总，窗口周一 00:00 起）。 */
				const period = src.now === undefined || src.now === null ? "" : (isPeakTime(src.now) ? t("f_peak") : t("f_valley"));
				return { id: id, text: period, tip: weeklyTip(src, t) };
			}

			if (id === "counts") {
				if (stats === undefined || stats === null || !(stats.steps > 0)) return null;
				const progress = src.progress === undefined || src.progress === null ? null : src.progress;
				const skills = progress === null || Array.isArray(progress.skills) !== true ? null : progress.skills;
				const toolCounts = progress === null || progress.toolCounts === null || typeof progress.toolCounts !== "object"
					? null
					: progress.toolCounts;
				const compacts = progress === null || Array.isArray(progress.compacts) !== true ? null : progress.compacts;
				/* 全局提示词（AGENTS.md 这类）也算一次注入，所以并进技能注入那个数里 */
				const globalInstruction = progress === null || typeof progress.globalInstruction !== "string"
					? null
					: progress.globalInstruction;
				const numOf = (key) => progress === null || typeof progress[key] !== "number" ? null : progress[key];
				/* 全局提示词（AGENTS.md 这类）也算一次注入，所以并进技能注入那个数里 */
				const skillCount = skills === null && globalInstruction === null
					? null
					: (skills === null ? 0 : skills.length) + (globalInstruction === null ? 0 : 1);
				const toolCallCount = numOf("toolCalls");
				const compactCount = numOf("compactCount");
				/* 三行形状一致：标签、数值（没数据给横杠）、子视图。
				   0 和「没数据」都不给子视图 —— 点开也没东西看，那一行连可点样式都不该有（见 rowsPanel）。 */
				const countRow = (label, count, build) => ({
					label: label,
					value: count === null ? "-" : formatTokensExact(count),
					sub: typeof count === "number" && count > 0 ? build() : null
				});
				return {
					id: id,
					text: t("f_counts", { turns: stats.turns || 0, steps: stats.steps || 0 }),
					/* 四个数全由 host 的 desktopStatusbarProgress 折出来（官方 sessionStats 只有 turns / steps 与耗时）。
					   这一层只给个数，不带单位；有内容的那几行带 sub，点开换成子视图。
					   顺序：上下文压缩 → 技能注入 → 工具调用。 */
					tip: {
						kind: "rows",
						title: t("tipCountsTitle"),
						rows: [
							countRow(t("tipCountsCompactAt"), compactCount, () => compactList(compacts, t)),
							countRow(t("tipCountsSkills"), skillCount, () => skillList(skills, globalInstruction, t)),
							countRow(t("tipCountsToolCalls"), toolCallCount, () => toolList(toolCounts, t))
						]
					}
				};
			}

			if (id === "ttft") {
				/* 会话级首字平均 = (本会话 ttftMs + 全部子会话 ttftMs) / (本会话 ttftSteps + 子 ttftSteps)：
				   用户要求「首字平均」把子智能体算上。**气泡里那个"本轮平均首字"仍只算本页面**
				   （用户明确要求），所以它照旧读 host 的 timing 投影（那本身就是 per-session 的）。 */
				const merged = mergedSessionStats(stats, subagentStatsOf(src.subagent));
				if (!(merged.ttftSteps > 0) || !(merged.ttftMs > 0)) return null;
				const duration = formatSeconds(merged.ttftMs / merged.ttftSteps);
				if (duration === null) return null;
				const timing = src.timing === undefined || src.timing === null ? null : src.timing;
				return {
					id: id,
					text: t("f_ttft", { duration: duration + "s" }),
					tip: {
						kind: "rows",
						title: t("segTtft"),
						rows: [
							{ label: t("tipTtftTurn"), value: turnAverageTtft(timing) },
							{ label: t("tipTtftFast"), value: tipSeconds(timing === null ? null : timing.fastestTtft) },
							{ label: t("tipTtftSlow"), value: tipSeconds(timing === null ? null : timing.slowestTtft) }
						]
					}
				};
			}

			if (id === "cacheHit") {
				if (usage === undefined || usage === null) return null;
				/* 会话级命中率用**合并后的用量**重算：分母口径与本面板一致
				   （命中 + 未命中，未命中 = 未缓存输入 + 缓存写入），只是把队友那一份也加进来。
				   气泡里"本轮命中率"照旧只算本页面（用户明确要求）。 */
				const sub = subagentOf(src.subagent, "session");
				const denominator = billedInputTokens(usage) + sub.cached + sub.missInput;
				if (denominator <= 0) return null;
				const numerator = (usage.cacheReadTokens || 0) + sub.cached;
				const percent = Math.min(99.99, (numerator / denominator) * 100).toFixed(2);
				const extremes = cacheHitExtremes(src.sessionUsage);
				return {
					id: id,
					text: t("f_cacheHit", { percent: percent }),
					/* 点开看单次调用的最高/最低命中率（底栏那个是整会话的累计值） */
					tip: {
						kind: "rows",
						title: t("segCacheHit"),
						rows: [
							{ label: t("tipHitTurn"), value: turnHitRate(src.sessionUsage) },
							{ label: t("tipHitHigh"), value: extremes === null ? "-" : extremes.high },
							{ label: t("tipHitLow"), value: extremes === null ? "-" : extremes.low }
						]
					}
				};
			}

			if (id === "tps") {
				/* 会话级综合速度 = (本会话 decodeTokens + 子 decodeTokens) / ((本会话 decodeMs + 子 decodeMs)/1000)：
				   用户要求「综合速度」把子智能体算上。气泡里"本轮平均速度"仍只算本页面（明确要求）。 */
				const merged = mergedSessionStats(stats, subagentStatsOf(src.subagent));
				if (!(merged.decodeMs > 0) || !(merged.decodeTokens > 0)) return null;
				const throughput = formatThroughput(merged.decodeTokens / (merged.decodeMs / 1000));
				const timing = src.timing === undefined || src.timing === null ? null : src.timing;
				return {
					id: id,
					text: t("f_speed", { throughput: throughput }),
					tip: {
						kind: "rows",
						title: t("segTps"),
						rows: [
							{ label: t("tipTpsTurn"), value: turnAverageTps(timing, t) },
							{ label: t("tipTpsFast"), value: tipSpeed(timing === null ? null : timing.fastestTps, t) },
							{ label: t("tipTpsSlow"), value: tipSpeed(timing === null ? null : timing.slowestTps, t) }
						]
					}
				};
			}

			/* 总用时 = 各轮用时之和（与官方"本轮总用时"同口径） */
			if (id === "sessionTime") {
				let elapsed = null;
				const range = src.timeRange;
				if (range !== undefined && range !== null) {
					if (typeof range.turns === "number" && range.turns > 0) {
						elapsed = range.turns;
						if (typeof range.since === "number") elapsed += Math.max(0, src.now - range.since);
					} else if (typeof range.steps === "number" && range.steps > 0) {
						elapsed = range.steps;
						if (typeof range.stepSince === "number") elapsed += Math.max(0, src.now - range.stepSince);
					}
				}
				if (elapsed === null || elapsed <= 0) elapsed = elapsedFromTimeline(src.timeline, src.now);
				if (elapsed === null) return null;
				const duration = formatDuration(elapsed);
				if (duration === null) return null;
				const sessionStats = stats === undefined || stats === null ? null : stats;
				const num = (key) => (sessionStats === null ? 0 : Number(sessionStats[key]) || 0);
				const llmMs = num("llmMs");
				const waitMs = num("ttftMs");
				const toolMs = num("toolMs");
				const decodeMs = num("decodeMs");
				/* 模型用时 = 解码：优先用官方 decodeMs；老日志没有 timing 时用「模型用时 − 首 token」兜底 */
				const modelMs = decodeMs > 0 ? decodeMs : Math.max(0, llmMs - waitMs);
				return {
					id: id,
					text: t("f_sessionTime", { duration: duration }),
					/* 三个数都来自官方 sessionStats：
					   等待用时 = 首 token 延迟（请求排队 + 网络 + 预填充）
					   模型用时 = 解码（首个 token → 输出结束），官方叫 decode
					   工具调用 = 工具执行墙钟；并行工具各算各的，之和可能大于墙钟总用时（口径不同，不互相比较） */
					tip: {
						kind: "rows",
						title: t("segSessionTime"),
						/* 分隔线换成三段色条：等待灰 / 模型用时紫 / 工具调用蓝，按各自耗时占比分段 */
						segments: durationSegments(waitMs, modelMs, toolMs),
						rows: [
							{ label: t("tipWaitTime"), value: tipDuration(waitMs), color: DURATION_COLORS.wait },
							{ label: t("tipModelTime"), value: tipDuration(modelMs), color: DURATION_COLORS.model },
							{ label: t("tipToolTime"), value: tipDuration(toolMs), color: DURATION_COLORS.tool }
						]
					}
				};
			}

			if (id === "cost") {
				const sessionUsage = src.sessionUsage;
				const calls = sessionUsage === undefined || sessionUsage === null || Array.isArray(sessionUsage.calls) !== true
					? []
					: sessionUsage.calls;
				const fallbackModel = src.sessionModel !== undefined && src.sessionModel !== null ? src.sessionModel.model : null;
				/* 被 host 的 MAX_CALLS 截掉的那部分（host 按「模型 + 峰谷档」累计好给回来）。
				   不补这一段的话，长会话的费用只算了最近 4000 条 —— 实测 5000 次少 20%、
				   2 万次少 80%，而「总计用量」用的是官方全量数据，两者会在同一个界面上对不上。
				   档位由 host 按北京时间判定（与逐条计价同一套规则），所以这里直接按档取价即可。 */
				const overflow = sessionUsage === undefined || sessionUsage === null
					|| sessionUsage.overflow === undefined || sessionUsage.overflow === null
					|| typeof sessionUsage.overflow !== "object"
					? {}
					: sessionUsage.overflow;
				/* 队友（子智能体）是**独立会话**，它的用量不在本会话调用表里，
				   host 按 parentSession 算好单独给回来；这里把金额并进「总计」，
				   不另开一行也不加任何提示字 —— 用户报的正是"总计没算队友"。 */
				const sub = subagentOf(src.subagent, "session");
				const subCost = subagentCostOf(src.subagent, "session", symbolCurrency);
				/* 「总计用量」= 官方投影 + 压缩摘要 + 队友。
				   为什么必须加摘要那一份：官方 `tokenUsage` 只折 assistant 事件、**不含压缩摘要**，
				   而「总计费用」是我们自己逐条算的、**含摘要**；不加的话同一气泡里两个数字
				   口径不一致（费用把摘要算进去了、用量没算）。宿主老版本没有 summaryParts，
				   这里会是 null，`mergeTokenParts` 对 null 段当 0 处理 —— 行为退回改动前。 */
				const mergedTokens = mergeTokenParts(
					mergeTokenParts(sessionTokenParts(src.usage), summaryTokenParts(src.sessionUsage === undefined || src.sessionUsage === null
						? null
						: src.sessionUsage.summaryParts)),
					sub);
				/* 增量式记账：把**原始素材**交给 applyTotalFloor，由它自己决定"哪些还没结算过"。
				   逐条计价、峰谷判定（按每条自己的 at）、overflow 兜底、队友增量、欠账补算
				   全在那一个函数里 —— 这里不再做任何重算，也不再有锁定基准与差值修正。 */
				const held = applyTotalFloor(src.totalHold, src.sessionId, {
					calls: calls,
					fallbackModel: fallbackModel,
					overflow: overflow,
					subCost: subCost,
					tokens: mergedTokens,
					models: src.models,
					displayCurrency: symbolCurrency,
					defaultCurrency: src.defaultCurrency
				});
				return {
					id: id,
					/* 一条都算不出价（本会话与队友都没价）时给横杠：与"这笔真的是 0"区分开 */
					text: t("f_cost", { symbol: symbol, cost: held.cost === null ? "-" : costText(held.cost) }),
					/* token 计数并进总计：本会话的 + 队友的，同一个数字相加，不新增行；
					   条形图里队友那部分单独成块画在左边（sub） */
					tip: tokensTip(held.tokens, t("f_tokensTotal"), t, sub)
				};
			}

						/* 本轮费用：优先按 node.turn 折叠（与官方"本轮用量"同源），否则退回差分 */
			if (id === "lastCost") {
				const fallbackModel = src.sessionModel !== undefined && src.sessionModel !== null ? src.sessionModel.model : null;
				const sessionUsageNow = src.sessionUsage;
				const turnCalls = sessionUsageNow !== undefined && sessionUsageNow !== null
					&& sessionUsageNow.current !== null && sessionUsageNow.current !== undefined
					&& Array.isArray(sessionUsageNow.current.calls)
					? sessionUsageNow.current.calls
					: null;
				/* 本轮的 token 汇总与定价一起算：即使价格库里没有这个模型（算不出钱），
				   也要留住 token 汇总 —— 本轮气泡照样能点开看明细。 */
				const turnParts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
				let turnTotal = 0;
				let turnPriced = false;
				const turnList = turnCalls === null ? [] : turnCalls;
				for (let i = 0; i < turnList.length; i += 1) {
					const callModel = typeof turnList[i].model === "string" ? turnList[i].model : fallbackModel;
					const one = costOf(turnList[i], callModel, turnList[i].at);
					turnParts.input += turnList[i].input || 0;
					turnParts.cacheRead += turnList[i].cacheRead || 0;
					turnParts.cacheWrite += turnList[i].cacheWrite || 0;
					turnParts.output += turnList[i].output || 0;
					if (one === null) continue;
					turnPriced = true;
					/* 同样按每条自己的条目币种折到显示币种（见「总计」那段的注释） */
					turnTotal += toDisplayCurrency(Number(one), src.models, callModel, symbolCurrency, src.defaultCurrency);
				}
				/* 本轮也要含队友，但**只取"本轮窗口"那一份**（host 按客户端传的起点、
				   或它自己从父会话日志推的起点算出来的）。两处起点都没有时 host 返回全 0 ⇒
				   本轮一点队友都不并：用户明确要求「本轮的数值只能小不能大」，宁可少算，
				   也绝不能把队友的整会话花费当成"本轮"塞进来。总计那一项不受影响 ——
				   它自己那一问显式带 since=0，按整会话口径并队友。 */
				const subTurn = subagentOf(src.subagent, "turn");
				/* 队友这一段折到显示币种后的金额（逐桶折算，见 subagentDisplayCost） */
				const subTurnCost = subagentCostOf(src.subagent, "turn", symbolCurrency);
				const turnTip = tokensTip(mergeTokenParts(billableParts(turnParts), subTurn), t("f_tokensTurn"), t, subTurn);
				/* 「本轮」同轮内只增不减（用户实测要求）：把这次的金额过一遍粘性下限。
				   窗口起点在一轮内可能移动（父会话日志多一条 user/message、折叠出的最早时间戳变化、
				   host 收敛起点），窗口一变数字就会小一截；这里把已经显示过的最大值兜住，
				   换轮/换会话则作废重算（见 applyTurnFloor）。下限只作用于**金额**，
				   气泡里的 token 明细照实显示本次真正拿到的那份。 */
				const holdBox = src.lastCostHold;
				const holdKey = src.lastCostTurn === undefined ? null : src.lastCostTurn;
				const settleAmount = (amount) => {
					const next = applyTurnFloor(holdBox, src.sessionId, holdKey, amount);
					if (holdBox !== null && holdBox !== undefined && typeof holdBox === "object") {
						holdBox.sessionId = next.hold.sessionId;
						holdBox.turnKey = next.hold.turnKey;
						holdBox.value = next.hold.value;
					}
					return next.value;
				};
				const amountText = (amount) => (amount === null || amount === undefined ? "-" : costText(amount));
				if (turnPriced === true || subTurnCost > 0) {
					return {
						id: id,
						text: t("f_lastCost", { symbol: symbol, cost: amountText(settleAmount(turnTotal + subTurnCost)) }),
						/* 本轮点开的是本轮 token 明细，读法与总计那个面板同一套 */
						tip: turnTip
					};
				}
				/* 本轮是不是正在跑（与状态段同一套判断） */
				const active = src.running === true
					|| (src.partial !== undefined && src.partial !== null)
					|| (Array.isArray(src.runningCalls) && src.runningCalls.length > 0);
				/* 节点折叠出来的用量：只有轮号等于 host 说的当前轮，才算本轮正在进行中的账。
				   拿不到轮号（旧版后台之类）时退回老做法 —— 宁可显示得保守一点，也别一直顶着 0.00。
				   注意它只用来算钱：会话节点上的 usage 字段口径与官方投影不同（实测同一轮
				   input 会少掉一截），拿它填 token 明细会让"本轮"和"总计"对不上。 */
				const foldedTurn = typeof src.turnUsageTurn === "number" ? src.turnUsageTurn : null;
				const currentTurn = typeof src.currentTurn === "number" ? src.currentTurn : null;
				const bucket = src.turnUsage !== null && src.turnUsage !== undefined ? src.turnUsage : null;
				const sameTurn = foldedTurn !== null && (currentTurn === null || foldedTurn === currentTurn);
				if (active === true && bucket !== null && sameTurn === true) {
					const runningCost = costOf(bucket, fallbackModel, src.now);
					if (runningCost !== null) {
						return { id: id, text: t("f_lastCost", { symbol: symbol, cost: amountText(settleAmount(toDisplayCurrency(runningCost, src.models, fallbackModel, symbolCurrency, src.defaultCurrency) + subTurnCost)) }), tip: turnTip };
					}
				}
				/* 新一轮已经开跑、但还没有属于它的调用：必须归零，不能退回上一轮
				   —— 节点折叠曾错位一轮，底栏显示成上上轮的金额，这条就是为堵它留的。
				   一次模型调用都还没完成过（第一轮）时没有"归零"可言，跟总计一样给横杠；
				   但队友已经在本轮里花了钱的话，就把那一份显示出来。
				   等这一轮真的产生了调用，上面那条精确口径就接管了。
				   「粘性下限」在这里也生效：同轮内刚才显示过更大的数字，就不因为这一拍拿不到
				   本轮数据而跳回 0（换轮时 holdKey 变了，下限自然作废）。 */
				if (active === true) {
					const settled = src.sessionUsage !== undefined && src.sessionUsage !== null
						&& Array.isArray(src.sessionUsage.calls) === true
						&& src.sessionUsage.calls.length > 0;
					const live = settled === true || subTurnCost > 0 ? subTurnCost : null;
					return {
						id: id,
						text: t("f_lastCost", { symbol: symbol, cost: amountText(settleAmount(live)) }),
						tip: turnTip
					};
				}
				/* 空闲：显示最近完成的一轮（节点折叠 → 官方差分兜底），同样只出金额。
				   没有可用数据时也给 ¥0.00：本轮不整段消失，底栏长度稳定，
				   也不会退回上一轮（节点折叠曾错位一轮，显示成上上轮）的旧金额。
				   队友那一份只有"本轮窗口"（拿不到起点就是 0），所以这里的数字只会
				   比"只算本会话"时更大一点点、绝不会变成整会话的花费。 */
				const cost = bucket === null ? null : costOf(bucket, fallbackModel, src.now);
				const idleCost = cost === null ? null : toDisplayCurrency(cost, src.models, fallbackModel, symbolCurrency, src.defaultCurrency);
				const idleValue = idleCost === null && subTurnCost === 0 ? null : (idleCost === null ? 0 : idleCost) + subTurnCost;
				return {
					id: id,
					text: t("f_lastCost", { symbol: symbol, cost: amountText(settleAmount(idleValue)) }),
					tip: turnTip
				};
			}

						if (id === "balance") {
				/* 这个会话的余额是不是「积分」口径（WorkBuddy 等）：积分不带货币符号，
				   气泡里也只给总数、不列构成。成功响应自己带 isCredits；拿不到响应时
				   （查询中 / 查询失败）按会话 provider 判断，免得积分会话在失败态下又冒出个 ¥。 */
				const balanceIsCredits = (value) => {
					if (value !== null && value !== undefined && value.isCredits === true) return true;
					const model = src.sessionModel;
					const provider = model === null || model === undefined || model.provider === undefined || model.provider === null
						? ""
						: String(model.provider).toLowerCase();
					return provider.includes("workbuddy") || provider.includes("codebuddy");
				};
				/* 查不到余额（还没查到 / 该平台没配 key / 查询失败）时用同一套两行结构，值都是横杠：
				   气泡里仍然是「充值余额 / 赠金余额」两行，只是没有数字。
				   积分口径没有构成可分，这两行不给 —— 而且它整个气泡都不该出现（见下）。 */
				const dashBalance = () => {
					const credits = balanceIsCredits(src.balance);
					const dashSymbol = credits ? "" : currencySymbol(src.currency);
					if (credits === true) {
						/* 积分口径不给 tip：段没有 tip 就不会变成可点击项（见渲染处的 tip !== null），
						   点不出、悬停也不弹。积分只有一个总数、没有可展开的内容，
						   弹一个只有标题的空气泡只会让人以为能点。 */
						return { id: id, text: t("f_balanceDash", { symbol: dashSymbol }) };
					}
					return {
						id: id,
						text: t("f_balanceDash", { symbol: dashSymbol }),
						tip: {
							kind: "rows",
							title: t("segBalance"),
							rows: [
								{ label: t("tipTopUp"), value: dashSymbol + "-" },
								{ label: t("tipGranted"), value: dashSymbol + "-" }
							]
						}
					};
				};
				/* 显示哪一家的余额由 host 按「会话实际用的模型/平台」决定，这里只看结果：
				   查到了就显示，没查到（该平台没配 key / 请求失败）才是横杠。 */
				const balance = src.balance;
				if (balance === null || balance === undefined) return dashBalance();
				if (balance.ok !== true) return dashBalance();
				if (typeof balance.total !== "string") return dashBalance();
				/* 余额用接口自己报的币种：账户里是人民币就显示 ¥，不跟着上面的计价单位走 */
				/* 百分比口径（GLM 配额）与积分口径（WorkBuddy）都不带货币符号，
				   否则会显示成 ¥37.50% / ¥177 这种把积分当钱的写法 */
				const isCredits = balanceIsCredits(balance);
				const balSymbol = balance.isPercent === true || isCredits === true
					? ""
					: currencySymbol(balance.currency !== undefined && balance.currency !== null ? balance.currency : src.currency);
				/* 积分口径：段只显示总积分；**宿主给了非空 rewards 时**才生成「积分套餐」气泡
				   （kind:'credits'，每个套餐一行 + 一条已用进度条，面板外壳与令牌面板同一套样式）。
				   rewards 为空 / 缺字段 / 旧插件 → 照旧不给 tip：没有可展开的内容，
				   弹一个只有标题的空气泡只会让人以为还能点。 */
				if (isCredits === true) {
					const creditsText = t("f_balance", { symbol: balSymbol, amount: balance.total });
					const panel = creditsView(balance.rewards, balance.total, t);
					if (panel.rewards.length === 0) return { id: id, text: creditsText };
					return {
						id: id,
						text: creditsText,
						tip: { kind: "credits", title: t("tipCreditsTitle"), panel: panel }
					};
				}
				/* 分隔线换成色条，两种情况各一套：
				   金额余额（DeepSeek 等）= 充值 : 赠金，按金额占比分两段（灰 / 紫）；
				   百分比配额（GLM 等）= 剩余（灰）在左、已用（透明）在右。
				   这条色条的方向是「灰 = 剩余、在左」，与积分套餐条（creditsView）同一套语义，
				   改一处必须同步另一处。
				   余额为负或拿不到数字时算不出占比，就不给 segments，面板退回普通分隔线。 */
				const isQuota = balance.isPercent === true;
				/* 色条的「充值 : 赠金」两段。**分币种时先折汇率再相加**（用户原话：
				   「色调的比例就两者混合，不要拆分出来 4 个色条」「金额两者相加」，且明确
				   选了"折汇率后再加"而不是把 13.14 和 5.21 直接相加 —— 后者是拿两种不同的
				   计价单位相加，数字没有意义）。
				   折算目标币种用 `symbolCurrency`（= `normalizeCurrency(src.currency)`）：
				   与底栏「总计 / 本轮」是同一个数（`segmentView` 里所有金额都折到它）；
				   内部拿不到时 `convertCurrency` 自己会原样返回，不会抛。
				   **仍然是两段**（灰 = 充值总额、紫 = 赠金总额），不按币种拆成四段。
				   拿不到 `toppedUp` / `granted`（老 host 或 task-66 之前）⇒ 完全退回
				   `balance.toppedUp` / `balance.granted` 那条老逻辑，行为零变化。 */
				const balanceTopUpRows = (() => {
					if (Array.isArray(balance.balances) !== true || balance.balances.length === 0) return null;
					let topSum = 0;
					let grantSum = 0;
					let sawAny = false;
					balance.balances.forEach((one) => {
						if (one === null || one === undefined || typeof one !== "object") return;
						if (one.toppedUp === undefined && one.granted === undefined) return;
						sawAny = true;
						const code = one.currency === "USD" ? "USD" : "CNY";
						topSum += convertCurrency(Number(one.toppedUp) || 0, code, symbolCurrency);
						grantSum += convertCurrency(Number(one.granted) || 0, code, symbolCurrency);
					});
					/* 一个币种都没带这两个字段 ⇒ 当作"拿不到"，回退老口径 */
					if (sawAny !== true) return null;
					return { topUp: topSum, granted: grantSum };
				})();
				const topUp = balanceTopUpRows === null ? (Number(balance.toppedUp) || 0) : balanceTopUpRows.topUp;
				const granted = balanceTopUpRows === null ? (Number(balance.granted) || 0) : balanceTopUpRows.granted;
				const balanceSum = Math.max(0, topUp) + Math.max(0, granted);
				/* ⚠ 百分比配额（智谱 Coding Plan 等）的 `total` 是**已用**百分比，不是余额。
				   上游解析器（lib/balance-api.js 的 deepseek 适配器 parse 里的 isPercent 分支）把接口给的 `percentage` 原样当 `total` 返回 ——
				   那个字段语义就是"已用"，所以这里必须自己减一次得到"剩余"。
				   **底栏那行文字与气泡这行必须同源**：两处都用 `quotaLeft`，否则就会出现
				   「底栏 余额 62.50%、气泡 剩余配额 37.50%」这种同屏打架（用户 2026-10 实机报的就是它）。
				   改这里之前先看一眼 segmentView 末尾那两行 f_balance / f_balanceSubCent 的 return 取值。 */
				const quotaUsed = isQuota ? Math.max(0, Math.min(100, Number(String(balance.total).replace("%", "")) || 0)) : 0;
				const quotaLeft = isQuota ? Math.max(0, 100 - quotaUsed) : 0;
				/* 百分比配额（GLM 等）：**剩余（灰）占左段、已用（透明）在右**。
				   用户拍板原话：「灰条从左边起」—— 灰条长度 = 剩余额度，越长剩得越多，
				   从左读起一眼就知道"还剩多少"，不用先扫过一段空的已用区。
				   为什么用灰而不是蓝：灰是这套面板里"账户里的钱"的固定色（充值段、余额配额条都用它），
				   蓝色留给"用量/命中"这类过程指标，语义不再混。
				   为什么仍要两段而不是单段 + 右侧留空：气泡是 width:max-content，条又是 flex 容器，
				   单个百分比段在"容器宽度由谁决定"上循环，实际渲染比例会偏；
				   两段显式百分比之和为 100%，宽度由浏览器按比例切，不会漂。
				   行只列「剩余配额」一行并带同款灰图例；已用那边不列行。 */
				const balanceSegments = isQuota
					? [
						{ color: BALANCE_COLORS.topUp, width: quotaLeft },
						{ color: "transparent", width: quotaUsed }
					].filter((one) => one.width > 0)
					: balanceSum > 0
						? [
							{ color: BALANCE_COLORS.topUp, width: (Math.max(0, topUp) / balanceSum) * 100 },
							{ color: BALANCE_COLORS.granted, width: (Math.max(0, granted) / balanceSum) * 100 }
						].filter((one) => one.width > 0)
						: [];
				/* 气泡里仍然是那两行：**「充值余额」/「赠金余额」**，label 一个字不改。
				   用户这一轮要的是「值里体现两种币种的构成」，**不是**把行改成 CNY / USD
				   （原话：「你改了我的项，原本气泡里面只显示充值余额和赠金余额，
				   我没有让你把它改成 CNY 和 USD」—— 上一版按币种分行是错的，已回退）。

				   所以：
				     · 充值余额那行的值 = 各币种 `toppedUp` 拼起来的串（`¥13.14+$5.21`）
				     · 赠金余额那行的值 = 各币种 `granted` 拼起来的串（`¥2.50+$1.00`）
				   拼串复用 `costByCurrencyText`：它已经实现了「人民币在前、美元在后、
				   某项 ≤0 不出现（含不足 0.01）、只有一项不带 +、全 0 给 ¥0.00」这一整套规则，
				   与底栏那行文字、活跃总览用的是同一套 —— 三处口径必须一致。

				   兜底：`balances` 空、或每笔都没有 `toppedUp`/`granted`（老宿主）⇒
				   完全退回改动前的 `balSymbol + balanceAmount(...)`，行为零变化。 */
				const currencyMapsOf = (() => {
					if (Array.isArray(balance.balances) !== true || balance.balances.length === 0) return null;
					const topUpMap = {};
					const grantedMap = {};
					let sawAny = false;
					balance.balances.forEach((one) => {
						if (one === null || one === undefined || typeof one !== "object") return;
						if (one.toppedUp === undefined && one.granted === undefined) return;
						sawAny = true;
						const code = one.currency === "USD" ? "USD" : "CNY";
						/* 同币种多笔防御性累加（宿主一般已合并，这里再收一遍不会错） */
						const topAmount = Number(one.toppedUp);
						if (Number.isFinite(topAmount) && topAmount > 0) topUpMap[code] = (topUpMap[code] || 0) + topAmount;
						const grantAmount = Number(one.granted);
						if (Number.isFinite(grantAmount) && grantAmount > 0) grantedMap[code] = (grantedMap[code] || 0) + grantAmount;
					});
					/* 一笔都没带这两个字段 ⇒ 当作"拿不到"，走下面的老逻辑 */
					if (sawAny !== true) return null;
					return { topUp: topUpMap, granted: grantedMap };
				})();
				const balanceRows = isQuota
					? [{ label: t("tipQuotaLeft"), value: quotaLeft.toFixed(2) + "%", color: BALANCE_COLORS.topUp }]
					: (currencyMapsOf !== null
						? [
							/* 两个 map 都为空 ⇒ costByCurrencyText 给 ¥0.00（那一行必须有内容，不能空串） */
							{ label: t("tipTopUp"), value: costByCurrencyText(currencyMapsOf.topUp, 0, t), color: BALANCE_COLORS.topUp },
							{ label: t("tipGranted"), value: costByCurrencyText(currencyMapsOf.granted, 0, t), color: BALANCE_COLORS.granted }
						]
						: [
							{ label: t("tipTopUp"), value: balSymbol + balanceAmount(balance.toppedUp), color: BALANCE_COLORS.topUp },
							{ label: t("tipGranted"), value: balSymbol + balanceAmount(balance.granted), color: BALANCE_COLORS.granted }
						]);
				/* 余额气泡：配额口径一行；金额口径**固定两行**（充值余额 / 赠金余额，
				   值与是否分币种无关 —— 分币种只影响那两行的**值怎么写**，不影响行数）。
				   **不再显示「累计消费」**：用户明确要求「所有的都不显示累计消费」。
				   宿主侧 `spent` 字段照旧返回（智谱适配器会给），但客户端一律不画 ——
				   这一行口径与「总计」不同源、又只在部分平台出现，
				   摆在同一张气泡里容易被当成同一个数字。 */
				const tip = {
					kind: "rows",
					title: t("segBalance"),
					segments: balanceSegments,
					rows: balanceRows
				};
				/* 不足一分钱时官方显示 <¥0.01，这里跟着来 */
				if (balance.subCent === true) return { id: id, text: t("f_balanceSubCent", { symbol: balSymbol }), tip: tip };
				/* 底栏那行文字：**百分比配额走 `quotaLeft`（剩余），不走 `balance.total`（已用）**。
				   与上面气泡那行同一个数（都是 quotaLeft），所以「余额 37.50%」点进去就是
				   「剩余配额 37.50%」，不会同屏打架。
				   `balSymbol` 在 isPercent 时已经是空串（见 segmentView 里 const balSymbol 那行），所以不会出现 "¥37.50%"。
				   其余口径（金额 / 积分）照旧用 `balance.total` —— 那两种的 total 本来就是余额本身。 */

				/* **双币种余额**（用户要求：「有一些 API，它是人民币和美元两个余额共存的，
				   应该都能查到，也就是显示成 ¥14.12+$3.17 这种格式」）。
				   仅指底栏那行文字 —— 气泡里那两行充值/赠金**不动**（用户明确说「不是指点击气泡里」）。

				   数据来源：host 的 `balance.balances`（`[{currency, total}, …]`，只含 > 0 的币种）。
				   格式**复用活跃总览那套** `costByCurrencyText`：人民币在前、美元在后，
				   某项 ≤ 0 不出现、只有一项不带 `+`、两项都没有就给 ¥0.00 —— 两处口径必须一致，
				   否则同一个 `¥14.12+$3.17` 的写法在两个地方会长得不一样。
				   把数组转成它要的 `{CNY: n, USD: n}`：同币种多笔就累加（host 一般已合并，
				   这里再加一遍是防重复项）。

				   **两个易错点**：
				   ① `fallbackCost` 必须传 **0**、不能传 `balance.total` —— 一旦进了双币种分支，
				      就说明 host 给了分币种数据，不该再拿那个混合 total 兜底；
				   ② 拼好的串**自带 ¥/$ 符号**，所以下面 `balSymbol` 要传空串，
				      否则会出现 `¥¥14.12+$3.17`。
				   老 host / 老数据没有 `balances` ⇒ 完全走原来的单币种逻辑，行为零变化。 */
				const balances = balance.balances;
				const hasBalances = Array.isArray(balances) && balances.length > 0;
				let balAmountText = null;
				let balTextSymbol = balSymbol;
				if (isQuota !== true && hasBalances === true) {
					const map = {};
					for (const one of balances) {
						if (one === null || one === undefined || typeof one !== "object") continue;
						const amount = Number(one.total);
						if (!Number.isFinite(amount) || amount <= 0) continue;
						const code = one.currency === "USD" ? "USD" : "CNY";
						map[code] = (map[code] || 0) + amount;
					}
					if (Object.keys(map).length > 0) {
						balAmountText = costByCurrencyText(map, 0, t);
						/* 串里已经有符号了，外层不能再补一个 */
						balTextSymbol = "";
					}
				}
				if (balAmountText === null) {
					balAmountText = isQuota === true ? quotaLeft.toFixed(2) + "%" : balance.total;
				}
				return { id: id, text: t("f_balance", { symbol: balTextSymbol, amount: balAmountText }), tip: tip };
			}

						return null;
		}

		/* ------------------------------------------------------- 缺数据占位显示
		 * 段名说明这一段统计的是什么，缺数据的位置用横杠顶上，
		 * 计数、比率、速度、时长各自带上单位（- 轮 - 步 / -m -s / - t/s），
		 * 金额段无数据只留横杠，不写「暂无」这类文字。 */
		function detectLocale(t) {
			return t("segCounts") === zh.segCounts ? "zh" : "en";
		}
		function segmentText(id, view, t, currency) {
			if (view !== null && view !== undefined) return view.text;
			const segment = SEGMENTS.filter((s) => s.id === id)[0];
			if (segment === undefined || segment.short === undefined) return "";
			const locale = detectLocale(t);
			const label = segment.short[locale] !== undefined ? segment.short[locale] : segment.short.zh;
			const dash = "-";
			/* 横杠占位也用**显示币种**的符号（与有数据时一致）；没传就退回默认币种 */
			const symbol = currencySymbol(normalizeCurrency(currency === undefined || currency === null ? config.currency : currency));
			if (id === "counts") return dash + t("unitCountTurns") + " " + dash + t("unitCountSteps");
			if (id === "cacheHit") return label + " " + dash + " %";
			if (id === "ttft") return label + " " + dash + " s";
			/* 速度占位不带单位：英文那边标签已经是 TPS，再跟 t/s 就重复了 */
			if (id === "tps") return label + " " + dash;
			if (id === "sessionTime") return label + " " + dash + "m " + dash + "s";
			if (id === "cost" || id === "lastCost") return label + " " + symbol + dash;
			if (id === "balance") return t("f_balanceDash", { symbol: symbol });
			return dash;
		}

		/**
		 * 缺数据的段也要有一个气泡（**P0：不加就会把用户锁死**）。
		 *
		 * `segmentView` 返回 null 时，渲染处原本只拿到 `{ id, text }`、没有 tip，
		 * 而那段 JSX 是「tip !== null 才挂 onClick」—— 于是这一格变成死块：
		 * 点不开 → 推进场景的代码（在 toggleTip 里）永远不执行 → 用户停在这个空态出不来。
		 * 开发模式下尤其致命：底栏整排横杠、假数据还在，用户既退不出去也翻不到下一格。
		 *
		 * 所以气泡一定要有，内容则**刻意极简**（一行解释 + 一行横杠）：
		 *   · 这一段的真实内容是"没有数据"，编不出有意义的明细；
		 *   · 但用户点它本来也不是为了看内容，而是为了推进到下一格（开发模式）
		 *     或至少确认"这里确实没数据"（正式模式）。
		 * 用 `kind: "rows"` 是为了复用现成的两列面板外壳，不再造一种新面板类型。
		 */
		function emptySegmentTip(id, view, t, currency) {
			const segment = SEGMENTS.filter((s) => s.id === id)[0];
			const locale = detectLocale(t);
			const label = segment === undefined || segment.short === undefined
				? t("segBalance")
				: (segment.short[locale] !== undefined ? segment.short[locale] : segment.short.zh);
			return {
				kind: "rows",
				title: t("tipEmptyTitle", { label: label }),
				rows: [
					/* 值就用该段自己的横杠占位文案，保证气泡与底栏读的是同一句话 */
					{ label: t("tipEmptyTitle", { label: label }), value: segmentText(id, null, t, currency) },
					{ label: t("tipEmptyBody"), value: "" }
				]
			};
		}
		/* ---------------------------------------------------------------- css */
		const CSS = [
			/* 接管输入框下方的统计行：dock 里凡“不是本插件那一项”的都藏掉（也就是官方 StatsPills）。
			 * 两条不依赖官方构建 hash 的要点：
			 *   1. 用 .dsb-root 认自己，而不是官方组件的类名（hash 会随 DSH 更新变，2.0.10 踩过）；
			 *   2. 自己带标记与“后代里带标记”都要判 —— :has() 只看后代，漏掉前者会把自己的行也藏掉。
			 * 整条规则挂在 html.dsb-on 上：这个类由插件挂载/卸载时增删（设置页里
			 * **没有**「启用状态栏」开关，别按那个理解）。卸下后官方原本的统计行与
			 * 上下文按钮随即恢复（否则关掉插件只剩一片空白）。 */
			'html.dsb-on [data-slot="conversation.composer.dock"] > *:not(.dsb-root):not(:has(.dsb-root)){display:none !important}',
			/* 官方新版在输入卡片下方右侧另有一个上下文占用按钮：已被本插件的圆环接管，藏掉它。
			 * 用 aria-label 认它（中文含"上下文"、英文含"context used"，随语言变），不碰官方 hash 类名。 */
			'html.dsb-on button[aria-haspopup="dialog"][aria-label*="上下文"],html.dsb-on button[aria-haspopup="dialog"][aria-label*="context used"]{display:none !important}',
			/* 官方的「用量 9.9M tok」按钮（TurnUsagePanel）：同一份数据已由本轮/总计两个气泡接管，藏掉。
			 * 它的类名是 CSS module 的 <hash>_root / <hash>_trigger，hash 随构建变，因此按后缀认结构：
			 * root 外壳里包着带 aria-haspopup 的 trigger 按钮（trigger 本身没有 aria-label 可认）。 */
			'html.dsb-on span[class$="_root"]>button[aria-haspopup="dialog"][class$="_trigger"]{display:none !important}',
			".dsb-root{display:flex;align-items:center;justify-content:center;gap:2px;width:100%;max-width:var(--dsh-chat-content-width);box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;margin:0 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			/* 上下文占用：圆环、分段小条与分项面板都按官方 ContextMeter 的几何与配色复刻 */
			".dsb-ring{flex:none;width:14px;height:14px}",
			".dsb-ring-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:3px;margin-right:5px;background:0 0;border:none;border-radius:50%;cursor:pointer;color:var(--dsw-alias-label-tertiary)}",
			'.dsb-ring-btn:hover,.dsb-ring-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary)}',
			".dsb-seg-click{position:relative;cursor:pointer;border-radius:999px;padding:1px 6px;margin:0 -6px}",
			'.dsb-seg-click:hover,.dsb-seg-click[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));color:var(--dsw-alias-label-secondary)}',
			".dsb-ring-track{fill:none;stroke:var(--dsw-alias-border-l3,rgba(127,127,127,.25));stroke-width:2px}",
			".dsb-ring-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}",
			/* 运行时：绿色那段在淡灰圆圈里匀速转，像加载圈。
			   -90° 必须写进关键帧：circle 上的 SVG transform="rotate(-90 7 7)"（把弧的起点挪到 12 点）
			   会被 CSS transform 整个覆盖，不写回来就会从 3 点起、看起来跑偏。
			   transform-box:view-box + origin:center 让旋转中心稳稳落在 viewBox 中心 (7,7)。 */
			"@keyframes dsb-ring-spin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}",
			".dsb-ring-running .dsb-ring-fill{stroke:#22c55e;transform-box:view-box;transform-origin:center;animation:dsb-ring-spin 1.4s linear infinite}",
			/* 蓝色 / 紫色两档（Agent Teams 场景，用户新需求）：
			   绿 = Lead 在跑、蓝 = 团队成员在跑、紫 = 只有成员下派的孙会话或团队外独立子智能体在跑。
			   两个颜色**复用总计令牌条已有的两个色**，不新造：
			     蓝 = var(--dsw-static-blue-450) —— 总计「输出」那段用的就是它
			     紫 = #a78bfa                      —— 总计「未命中输入」那段用的就是它
			   旋转与绿色那一档完全同参数（1.4s linear infinite，同一个 keyframes），
			   三种颜色在观感上是同一件事，只有颜色不同 —— 用户要的就是这个。
			   **旋转是 CSS animation，不占任何 JS 定时器**（`setInterval` 计数仍为 2）。 */
			".dsb-ring-team .dsb-ring-fill{stroke:var(--dsw-static-blue-450);transform-box:view-box;transform-origin:center;animation:dsb-ring-spin 1.4s linear infinite}",
			".dsb-ring-deep .dsb-ring-fill{stroke:#a78bfa;transform-box:view-box;transform-origin:center;animation:dsb-ring-spin 1.4s linear infinite}",
			/* 减弱动效偏好下三档一起停：蓝紫与绿色同待遇，不能只停一个 */
			"@media (prefers-reduced-motion: reduce){.dsb-ring-running .dsb-ring-fill,.dsb-ring-team .dsb-ring-fill,.dsb-ring-deep .dsb-ring-fill{animation:none}}",
			".dsb-ring-error .dsb-ring-fill{stroke:#ef4444}",
			".dsb-ring-approval .dsb-ring-fill{stroke:#f59e0b}",
			/* 条形图恢复原设计：**段与段之间 1px 间隔（gap:1px）+ 分段 1px 圆角**。
			   曾试过「段内 1px 透明右边框 + background-clip:padding-box」来固定间隔，但边框算在段宽内，
			   0.76% / 0.29% 这种亚像素小段会被整段吃掉、直接看不见（实测紫/蓝段消失）—— 已回退。
			   间隔 1–2px 的观感差异是小数百分比宽度 + 像素取整造成的，不再用会吞掉小段的办法去「修」。
			   整条外框圆角与裁切仍由 .dsb-bar 的 border-radius + overflow:hidden 负责。 */
			".dsb-bar{display:flex;gap:1px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));overflow:hidden;margin:6px 0 2px}",
			/* 段宽是「各段占比 %」：允许收缩（flex:0 1 auto），否则小数百分比取整后总宽略超 100% 会被
			   `.dsb-bar` 的 overflow:hidden 从**右侧**裁掉小段。**不设最小宽度**（用户拍板去掉 2px 保底）：
			   极小段可能不足 1px、由浏览器自行渲染或直接看不见，这是预期 —— 精确比例以面板里那三行数字为准。
			   圆角 999px：条高只有 4px，浏览器会把半径夹到半高，所以每段两端都是完整半圆（胶囊头），
			   不会出现任何竖直直边 —— 未放大时也是圆的。 */
			".dsb-bar-seg{flex:0 1 auto;min-width:0;height:100%;border-radius:999px;background:var(--dsw-alias-label-tertiary)}",
			/* 令牌条里「子代理·命中」那一段：与活跃总览柱状图的高峰段同一处理（75% 灰）。
			   只有命中这一档的浅色子段用这个类；子代理未命中 / 输出仍用正常主色（行内 background-color 长写）。 */
			".dsb-bar-sub{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 75%,transparent)}",
			/* 工具调用彩条的悬停动效：鼠标移到某一段时该段轻微纵向放大，像从条上凸起一块。
			   平时 .dsb-bar 仍是 overflow:hidden（保住两端的圆角裁切）；工具彩条这个类放开裁切，
			   否则 4px 高的段放大会被条上下切平，看不出"凸起"。scaleY(1.45) 后约 6px（用户要求放大倍率收窄）。
			   圆角沿用 999px：放大后仍是完整胶囊头（左右两端是半圆），不会变成直角方块。
			   ::before 是**透明的放大判定区**：上下各外扩 7px（用户要求上下判定范围放宽），
			   鼠标在条上方/下方几个像素内也算悬停到这一段；左右不越界，不会抢相邻段的判定。
			   transition 用缓出曲线、时长稍长，段与段之间的放大/复原更顺滑。 */
			".dsb-bar-hoverable{overflow:visible}",
			".dsb-bar-hoverable .dsb-bar-seg{position:relative;transition:transform .2s cubic-bezier(.16,1,.3,1)}",
			".dsb-bar-hoverable .dsb-bar-seg::before{content:\"\";position:absolute;left:0;right:0;top:-7px;bottom:-7px}",
			".dsb-bar-hoverable .dsb-bar-seg:hover{transform:scaleY(1.45);z-index:2}",
			/* 工具彩条的悬停提示：**不要气泡、也不要阴影**，只显示一行文字（比 10px 的悬停浮层大、
			   但小于 12px 的标题）。位置由 JS 给 left/top，贴在鼠标上方很近处。 */
			/* 气泡上的工具名悬停提示。**z-index = 106，必须始终比气泡（105）高一层**：
			   它是气泡内部的提示，被自己的容器盖住就没意义了。
			   106 同样夹在官方档位的 101（子菜单）与 1000（对话框/遮罩）之间 ——
			   盖得住对话区的浮动控件，又盖不住系统级弹层。详见 `.dsb-tip` 那段的说明。 */
			".dsb-hover-plain{position:fixed;z-index:106;pointer-events:none;white-space:nowrap;font-size:11px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
			/* 宽度按内容自适应：width:max-content 让气泡收到"最长那一行"的宽度，
			 * 行内标签与数值之间至少留 5ch（.dsb-meter-value 的 padding-left），所以不会出现大片留白；
			 * 内容超过 max-width 时退回换行（white-space:normal）。 */
			".dsb-tip.dsb-meter{width:max-content;max-width:min(560px,100vw - 24px);white-space:normal;font-size:12px;line-height:18px}",
			".dsb-meter-head{display:flex;align-items:center;gap:6px}",
			".dsb-meter-headline{color:var(--dsw-alias-label-primary)}",
			".dsb-meter-percent{color:var(--dsw-alias-label-primary);font-weight:500}",
			/* 标签与数值之间至少留 5ch：配合上面的 width:max-content，气泡宽度就是
			 * "最长那一行的标签 + 五个空格 + 数值"，其余行在这个宽度里右对齐（间隙更大）。
			 * 悬停浮层那 6 行也是这个类（hoverRow 拼的是 dsb-meter-figures），
			 * 它另有一条更专指的覆盖在下面（.dsb-tip.dsb-hovercard）。 */
			".dsb-meter-figures{margin-left:auto;padding-left:5ch;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}",
			/* 复刻官方「会话统计」面板：标题下面那条细线（有进度条的面板不加，条本身就分隔了） */
			".dsb-meter-divider{display:block;height:1px;margin:5px 0 0;background:var(--dsw-alias-separator-primary,rgba(127,127,127,.3))}",
			".dsb-meter-rows{display:flex;flex-direction:column;margin-top:4px}",
			/* 两列气泡（标题下带分隔线的那几个）线到第一行再收 3px */
			".dsb-meter-rows-fit{margin-top:1px}",
			/* 行的上下内边距故意不对称（上 1 下 3，总高不变）：12px 字在 18px 行盒里，
			   字体度量本身就让字形视觉中心比行盒中心低 1px（msyh/segoeui 的 ascent 12.70 / descent 3.14，
			   基线落在 13.78）。补这 1px 之后悬停底色的上下留白才是均等的 —— 别"修正"回 2px/2px。 */
			".dsb-meter-row{display:flex;align-items:center;gap:6px;padding:1px 0 3px}",
			".dsb-meter-swatch{flex:none;width:8px;height:8px;border-radius:2px}",
			".dsb-meter-name{color:var(--dsw-alias-label-secondary)}",
			/* 两列面板里的行：标签与数值之间至少留 5ch（工具调用那个子视图另有一条更紧的覆盖，
			   见 .dsb-meter-tight），其余行在这个宽度里右对齐。 */
			".dsb-meter-value{margin-left:auto;padding-left:5ch;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
			/* 手动调用 / 手动压缩的星号：做成上标（像 X² 的 ²），不是普通的星号字符。
			   .7em 收小、vertical-align:super 抬到基线以上；line-height:0 防止把行盒撑高
			   （行高 18px 是按字体度量算好的，多 1px 同排的行就会错位）。
			   星号挂在名字**后面**（"ponytail*"）：用户拍板 —— 子能力不可能由他手动调用，
			   所以两种角标不会落在同一个名字上，不需要靠前后位置去区分。 */
			".dsb-sup{font-size:.7em;line-height:0;vertical-align:super;margin-left:1px}",
			/* 子能力的 `+` 角标单独加粗：`+` 在这个字号下笔画比 `*` 细一档，不加粗会显得"没画完"。
			   **只改字重**，字号与行盒都不动（前者会改变两种角标的体量差，后者会撑高行盒）——
			   与 .dsb-sup 同一套抬升量，同一列表里两行才一样高。 */
			".dsb-sup-strong{font-weight:600}",
			/* 积分套餐列表：同一屏最多显示 5 个套餐块，超出就往下滑。高度按单块 37px 推算：
			   .dsb-credit 上下 padding 2+1=3px + .dsb-meter-row（line-height 18 + padding 1+3=4 → 22px）
			   + .dsb-bar（height 4 + margin 6+2=8 → 12px）= 37px；5 块 = 185px。
			   **改块内间距/行高时要同步这个数**。下钻子视图复用同一个类，因此同样最多 5 块可滚。
			   **滚动条隐藏但保留滚动**：气泡很窄，常驻滚动条会挤掉内容宽度；
			   Firefox/旧 Edge 用 scrollbar-width:none / -ms-overflow-style:none，
			   WebKit/Chromium 用下面那条 ::-webkit-scrollbar。 */
			".dsb-credits-list{max-height:calc(5 * 37px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none}",
			".dsb-credits-list::-webkit-scrollbar{display:none}",
			/* 积分套餐的单块：上面一行「包名/备注 + 已用/总量」，下面一条进度 */
			".dsb-credit{display:flex;flex-direction:column;padding:2px 0 1px}",
			/* 工具调用子视图：名字短、列多，5ch 太占宽度，收到 1ch */
			".dsb-meter-tight .dsb-meter-value{padding-left:1ch}",
			/* 可点行（会话数据那几行）：光标 + 悬停底色，跟设置页那些可点项同一套反馈。
			   底色两端做成半圆（胶囊），行尾不加箭头 —— 只靠底色与光标表示可点。
			   上下内边距跟 .dsb-meter-row 保持一致（1/3），可点与不可点的行文字才不会错位。 */
			".dsb-meter-row-click{cursor:pointer;margin:0 -4px;padding:1px 4px 3px;border-radius:999px}",
			".dsb-meter-row-click:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
			/* 积分套餐的聚合行：只要 cursor:pointer，**不要**上面那个悬停灰底（用户拍板）。
			   走独立修饰类，不碰「会话数据」那些可点行的悬停样式。 */
			".dsb-meter-row-plain{cursor:pointer}",
			/* 子视图标题就是返回入口：不加返回箭头，悬停变亮 */
			".dsb-meter-back{cursor:pointer}",
			".dsb-meter-back:hover{color:var(--dsw-alias-label-secondary)}",
			/* 子视图列表分列：每列最多三行（由 listColumns 决定），每列自己两列对齐。
			   **绝不折行**（用户拍板）：`flex-wrap:nowrap` 让所有列排成一排，一排放不下时由
			   横向滚动兜底（`overflow-x:auto`），而不是折到下一排 —— 折行会让"第二排只有一两列、
			   右边一大片空白"，用户明确禁止。优先级链：先加每列行数（列数随之变少）直到放得下，
			   只有 12 行仍放不下才真的滚动（判定见 toolColumnsOverflow / nextToolRows）。
			   宽度方向：气泡是 `width:max-content`，列数少了宽度自然跟着收窄（"理解 B"：
			   宽度 = 加完行数之后刚好不折的那个宽度，不许停在加行之前的旧宽度）。
			   **必须自带 display:flex**：这个类是从块级堆叠变成横向排布的那一步 ——
			   少了它，各列会被当成块级元素上下叠成一段（实测踩过）。
			   滚动条隐藏但保留滚动：沿用 .dsb-credits-list 那套写法（见下方 ::-webkit-scrollbar）。 */
			".dsb-meter-cols{display:flex;flex-direction:row;flex-wrap:nowrap;align-content:flex-start;align-items:flex-start;gap:6px 16px;max-height:calc(50vh - 46px);overflow-x:auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none}",
			".dsb-meter-cols::-webkit-scrollbar{display:none}",
			/* 右缘淡出（用户批准）：还有内容在右边时，最右 COLS_FADE_PX（40px）从实到透明，
			   暗示"往右还有"。**只是视觉遮罩**：mask-image 不参与排版，宽度/列宽/滚动范围
			   一个像素都不变。
			   **宽度固定 40px**（`--dsb-fade-r` 由 applyColsFade 写成 `40px` 或 `0px`），
			   不随溢出量收窄 —— 用户拍板原话：「遮罩的宽度是固定的呀，溢出两个像素，就抹两个
			   像素，那样好看吗？」宽度随内容跳变会忽宽忽窄、2px 那档更不成形；
			   固定 40px + 只在"挂不挂"上二值切换，观感才稳定。常量与 JS 里的 COLS_FADE_PX
			   是同一个数，改一处必须同步。
			   这个类由 applyColsFade 按几何切换（没溢出、或已经滚到最右时摘掉），且**在逐档加行
			   之后会由 refreshColsFade 重算一次** —— 所以"加完行已经不用滚了"时遮罩会立刻消失。
			   更根本的一条判据：**还能继续加行的容器（`data-cols-grow="1"`）一律不挂遮罩** ——
			   加行机制保证未到 12 行前程序会继续加行，用户不会真的需要滚；只有加到 12 行仍溢出
			   才显示（用户原话：「只有超过每列 12 的情况才应该有这个淡出遮罩」）。
			   **为什么保留 mask 而不用绝对定位覆盖层**：用户反馈的闪烁根因是"每个 scroll 事件
			   都 toggle class ⇒ mask 每帧重新栅格化"，这一点已在 applyColsFade 里治掉
			   （只在"挂不挂"真的变化时才碰 class ⇒ 一次滚动过程中 mask 完全不变，只在一个
			   边界处变一次）。mask 的另一个好处是**零布局改动**：覆盖层方案得给滚动容器加一层
			   `position:relative` 的包裹元素，而气泡宽度是 `width:max-content` ——
			   多一层包裹会改变"宽度由谁决定"的链路，容易让超宽气泡的宽度算错（那正是这套
			   自适应宽度反复踩过的坑）。既然闪烁已从根上解决，就不引入布局风险。
			   `-webkit-mask-image` 与标准写法并列：DSH 桌面端是 Chromium，新版本支持标准属性，
			   但旧内核只认带前缀那个，两个都写才不是"在这台机器上不生效"。 */
			".dsb-cols-fade{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 var(--dsb-fade-l,0px),#000 calc(100% - var(--dsb-fade-r,0px)),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 var(--dsb-fade-l,0px),#000 calc(100% - var(--dsb-fade-r,0px)),transparent 100%)}",
			/* 每列**不收缩**（flex:none）：容器放不下时 flex 默认会先把列压扁（flex-shrink:1），
			   那等于用"挤扁内容"替代折行 —— 同样是用户禁止的坏形态，而且会让"是否溢出"的
			   判定失真。列保持自身内容宽度，放不下就交给上面的横向滚动。 */
			".dsb-meter-col{display:flex;flex-direction:column;flex:none}",
			".dsb-tip.dsb-meter-wide{max-width:min(880px,100vw - 24px)}",
			/* 活跃总览：标题 → 分隔线 → 数值行 → 左边柱状图 + 右边当月活跃度 */
			".dsb-week{display:flex;flex-direction:column;gap:4px}",
			/* 分隔线在 flex 列里由 gap 管间距，自身的 margin 去掉，免得标题与线之间被撑开 */
			".dsb-week .dsb-meter-divider{margin:0}",
			/* 左右两块：左边柱状图、右边当月活跃度日历。
			   宽度账（加起来正好是 169px，与上面的月份条等宽）：
			   柱区 65 + 行间距 6 + 月历 98 = 169。行间距从 12 收到 6，柱区就多出 6px 往右延展，
			   右侧离月历的周反馈条还剩一点空隙，不会贴上。 */
			".dsb-week-body{display:flex;align-items:flex-end;justify-content:space-between;gap:6px}",
			/* 柱身对齐「总计用量」那条横条的纤细感：5px 宽、最高 65px，细长而不是方块。
			   柱区给足 65px 并用 space-between 摊开，柱间距约 5px（4px 是最小值）。 */
			".dsb-week-chart{display:flex;align-items:flex-end;justify-content:space-between;gap:4px;width:65px}",
			/* 月份条：1–6 月 + 中间无色的全年段 + 7–12 月，共 13 段平分这一行。
			   高矮取「总计用量」那条色条（4px）；169px 是下面那行「柱图 + 月历」的实际宽度。 */
			".dsb-year{display:flex;gap:2px;width:169px;margin:2px 0}",
			".dsb-year-cell{flex:1 1 0;height:4px;border-radius:2px}",
			/* 中间那段无色：不表示任何月份，只作为「全年」的悬停入口；
			   悬停时变红 #fa8b8b —— 与紫 #a78bfa 严格同饱和度同明度：
			   #a78bfa = hsl(255, 91.7%, 76.3%)  →  #fa8b8b = hsl(0, 91.7%, 76.3%) */
			".dsb-year-all{background:transparent}",
			".dsb-year-all:hover{background:#fa8b8b}",
			/* 活跃度日历：按周分块，每块是一行 7 格（周一→周日），外面套一层淡灰底板 */
			/* 高度锁 65px = 柱区的高度，行间距用 space-between 自动分配（5 周时约 3.75px、6 周时约 1px），
			   这样月历的上下边界与柱区严格对齐，不会因为当月跨 5 周还是 6 周而错开。 */
			".dsb-heat{display:flex;flex-direction:column;justify-content:space-between;height:65px}",
			".dsb-heat-week{display:flex;flex-direction:column}",
			/* 底板平时完全透明，只有悬停到"能读周数据"的区域时才由 active 类浮出淡灰：
			   左右各留一块 8px 的露出区，中间是 7 个方块；两端半圆，上下与方块齐平。 */
			".dsb-heat-pad{display:flex;align-items:center;border-radius:999px}",
			".dsb-heat-edge{display:block;position:relative;width:8px;align-self:stretch}",
			/* 热区比露出的那块再宽一点：左右各 4px、上下各 3px（上下正好等于行距，不压到邻行） */
			".dsb-heat-edge::before{content:\"\";position:absolute;left:-4px;right:-4px;top:-3px;bottom:-3px}",
			/* 悬停在"能读周数据"的区域时底板加深：左右露出区 + 跨月天留下的空位格，方块不算 */
			/* 悬停时这条底板浮出：用与格子同一套灰的 25% */
			".dsb-heat-pad-active{background-color:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 25%,transparent)}",
			".dsb-heat-weekrow{display:flex;gap:2px}",
			".dsb-heat-cell{width:10px;height:10px;border-radius:2px}",
			".dsb-heat-empty{background:transparent}",
			/* 0 = 当天没用量，用「系统提示词」那一项的灰占位；今天这一格是基准（整灰） */
			".dsb-heat-0{background:var(--dsw-static-neutral-bluish-400)}",
			/* 已经过去但没用量的日子 / 还没到的日子：都算「没有数据」，统一成整灰的四分之一。
			   日块与月条共用这两个类，所以这一条同时管两处。 */
			".dsb-past,.dsb-future{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 25%,transparent)}",
			/* 四档蓝：25 / 50 / 75 / 100 */
			".dsb-heat-1{background:color-mix(in srgb,var(--dsw-static-blue-450,#3b82f6) 25%,transparent)}",
			".dsb-heat-2{background:color-mix(in srgb,var(--dsw-static-blue-450,#3b82f6) 50%,transparent)}",
			".dsb-heat-3{background:color-mix(in srgb,var(--dsw-static-blue-450,#3b82f6) 75%,transparent)}",
			".dsb-heat-4{background:var(--dsw-static-blue-450,#3b82f6)}",
			/* 月内用量最高的那一天固定紫，取「工具调用」那一项的颜色 */
			".dsb-heat-top{background:#a78bfa}",
			/* 悬停浮层：与主气泡同一套质感，但字号比标题（12px）更小、行距更紧、数值不加粗。
			   选择器必须带上 .dsb-tip.dsb-meter 这一段，否则压不过主气泡那两条高优先级的字号声明。 */
			".dsb-tip.dsb-hovercard{font-size:10px;line-height:14px}",
			".dsb-tip.dsb-hovercard .dsb-meter-rows{margin-top:2px}",
			".dsb-tip.dsb-hovercard .dsb-meter-row{padding:0;gap:4px}",
			".dsb-tip.dsb-hovercard .dsb-meter-figures{font-weight:400;padding-left:5ch}",
			/* 柱的悬停：::before 只负责把热区左右各撑 2px（透明、看不见）；
			   变灰反馈由下面的 `.dsb-day-active .dsb-day-track` 画（JS 状态加类，
			   严格不超出柱身那 5px）。用 :hover 的话划过柱间缝隙会一闪一闪。 */
			".dsb-day{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;width:5px}",
			/* 热区：左右各撑 2px，透明看不见（让鼠标不会掉进柱间 4px 的缝） */
			".dsb-day::before{content:\"\";position:absolute;left:-2px;right:-2px;top:0;bottom:0;border-radius:3px}",
			/* 反馈条平时完全透明（只负责把基准高度撑住、让柱身贴底），
			   只有悬停那一列才由 active 类浮出淡灰；高度与月历一致，见下面 .dsb-heat。 */
			".dsb-day-track{display:flex;align-items:flex-end;width:5px;height:65px;border-radius:3px}",
			".dsb-day-active .dsb-day-track{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 25%,transparent)}",
			/* 柱身高度由内联 style 按占比给；顶部做成半圆（999px 会被宽度限制成半径 2.5px），底部平贴基线 */
			".dsb-day-stack{display:flex;flex-direction:column-reverse;width:5px;border-radius:999px 999px 0 0;overflow:hidden}",
			".dsb-day-seg{display:block;width:100%}",
			/* 柱子顶部那一截：高峰时段用掉的命中缓存，用与格子同一套灰的 75% */
			".dsb-day-peak{background:color-mix(in srgb,var(--dsw-static-neutral-bluish-400) 75%,transparent)}",
			".dsb-seg{white-space:nowrap}",
			/* 气泡相对状态栏定位 */
			".dsb-root{position:relative}",
			/* 方位由 JS 按视口夹住（fixed + 内联 left/bottom），这里不再写死 */
			/* 材质复刻官方的菜单浮层（stats 面板 / 各 ui-* 包里的 panel 都是这套）：
			 * 半透明底 --dsw-specific-menu（浅 #f8f9fa94 / 深 #43454a73）
			 * + backdrop-filter blur(40px) saturate(150%) 的毛玻璃，
			 * 圆角 --dsw-radius-lg(16px)，描边用 .5px 细线（不上柔光阴影）。
			 * 变量是主题层定义的，官方改材质时这里跟着变；取不到就退回原来的实心底。 */
			/* 透明度按"透出 61.8%"来：保留主题材质色的 RGB，只把 alpha 压到 .382
			 * （rgb(from …) 是 CSS 相对颜色语法，Chromium 119+ 支持；不支持时上一行的官方原值仍然生效）。 */
			/* 柔光阴影去掉：只留 .5px 描边，浮层看起来更利落 */
			/* box-sizing:border-box 必须留着：内联宽度要含 padding，否则面板右边缘会比对齐点偏出 22px */
			/* 底栏气泡。**z-index = 105，不是随手取的数**：
			   官方前端（dsh-web-frontend）的层级档位是 1 / 2 / 6 / 10 / 70 / 100 / 101 / 1000 / 1100，
			   其中 100 = 气泡/卡片/hovercard/下拉列表、101 = 子菜单、1000 = 对话框与遮罩、
			   1100 = portal / toast。105 刚好夹在 101 和 1000 之间，两头都照顾到：
			     · 高于 100/101 ⇒ 对话区那些浮动控件（比如右下角「拉到最后」那个圆形按钮）
			       会被压在气泡下面，不再挡住气泡最后一列的内容（用户实机报的就是它）；
			     · 低于 1000/1100 ⇒ 对话框、遮罩、toast 仍然盖在气泡之上 ——
			       那些是用户必须能点到的系统级弹层，被数据气泡挡住就是严重问题。
			   早先这里是 40，比官方浮动控件低，所以按钮压在了气泡上。 */
			".dsb-tip{position:fixed;box-sizing:border-box;padding:6px 10px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f));background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3));white-space:nowrap;z-index:105;pointer-events:auto}",
			".dsb-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			/* 整块禁选（用户拍板）：底栏、底栏气泡、设置页按住鼠标拖动会刷出蓝色选中底，
			   看着像出了 bug。这三处都是插件自己画的纯展示/操作界面，用户没有复制文字的需求；
			   ::selection 一并写成透明 —— 只写 user-select:none 时，某些内核在
			   "先按下再拖动"的路径上仍会画一层选中色。 */
			".dsb-root,.dsb-tip,.dsb-settings,.dsb-hover-plain,.dsb-drag-card{user-select:none;-webkit-user-select:none}",
			".dsb-root ::selection,.dsb-tip ::selection,.dsb-settings ::selection,.dsb-hover-plain::selection,.dsb-drag-card ::selection{background:transparent;color:inherit}",
			/* 设置页里的输入框要能选中/编辑（改价格那几个 number 框）：单独放开 */
			".dsb-settings input,.dsb-settings textarea{user-select:text;-webkit-user-select:text}",
			/* 这里的 14px 是面板内所有文字的继承来源；挂到 body 的跟手浮层继承不到它，
			   那边（.dsb-drag-card）自己写死了一份 —— 改这里要同步那边。 */
			".dsb-settings{display:flex;flex-direction:column;gap:18px;font-size:14px}",
			/* 页头：与官方 Agent 预设设置页同款（18px/600，标题与说明间距 12px） */
			".dsb-settings .dsb-head{display:flex;flex-direction:column;gap:12px}",
			".dsb-settings .dsb-pagetitle{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dsb-settings .dsb-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}",
			".dsb-settings .dsb-section{display:flex;flex-direction:column;gap:8px}",
			".dsb-settings .dsb-sectitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;letter-spacing:.02em}",
			".dsb-settings .dsb-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}",
			".dsb-settings .dsb-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1,transparent);user-select:none;-webkit-user-select:none}",
			".dsb-settings .dsb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}",
			/* 拖动中不给悬停反馈：浮层不吃指针事件，鼠标其实悬在下面那行上，会莫名发灰 */
			".dsb-settings:has(.dsb-dragging) .dsb-row:hover{background:var(--dsw-alias-bg-layer-1,transparent)}",
			/* 拖动中光标一律抓手：光标由鼠标底下那个元素决定，而浮层不吃指针事件，
			   底下既可能是握把（grab）、文字（pointer）、也可能是行间空隙（默认箭头）。
			   !important 是因为这些元素各自都写了 cursor，靠继承压不住握把那条。 */
			".dsb-settings:has(.dsb-dragging) *{cursor:grabbing !important}",
			".dsb-settings .dsb-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;min-width:0}",
			".dsb-settings .dsb-check input{flex:none;margin:2px 0 0}",
			".dsb-settings input[type=checkbox]{accent-color:var(--dsw-alias-label-primary,#202020)}",
			".dsb-settings .dsb-labels{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsb-settings .dsb-name{color:var(--dsw-alias-label-primary)}",
			".dsb-settings .dsb-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}",
			/* 被拿起来的那一行：原位留个淡影，跟手的是下面那张卡 */
			".dsb-settings .dsb-row.dsb-dragging{opacity:.32}",
			/* 跟手浮层：portal 到 body 之后就不再是 .dsb-settings 的后代，
			   所以样式挂它自己的类（.dsb-drag-card），不再写后代选择器。
			   z-index 取 1100：DSH 里面板类浮层（stat-dialog 等）就是这个量级，
			   必须高过设置遮罩的 1000，否则浮层会沉到设置面板背后。
			   背景色用 var(--dsw-specific-menu) 的兜底链：portal 到 body 后依然继承得到
			   :root 上的主题变量，玻璃材质与气泡保持一致。
			   **字号必须自己写死 14px**：面板那 14px 是设在 .dsb-settings 容器上的，
			   浮层挂到 body 后就继承不到，会掉回 body 的 16px —— 一按拖动手柄字就变大
			   （实测 2026-10-09）。user-select 同理：面板是 .dsb-row 上关掉的。
			   改 .dsb-settings 的字号时，这里要同步。 */
			".dsb-drag-card{position:fixed;z-index:1100;pointer-events:none;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 8px;border-radius:var(--dsw-radius-md,12px);font-size:14px;user-select:none;-webkit-user-select:none;background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3))}",
			/* 浮层被 portal 到 body 之后就不是 .dsb-settings 的后代了，
			   它内部那几件（勾选框 / 名称 / 描述 / 握把点阵）得再写一份挂在自己名下，
			   否则浮层里的行会退化成无样式的裸文本。规则内容与上面那组逐字一致。 */
			".dsb-drag-card .dsb-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;min-width:0}",
			".dsb-drag-card .dsb-check input{flex:none;margin:2px 0 0}",
			".dsb-drag-card input[type=checkbox]{accent-color:var(--dsw-alias-label-primary,#202020)}",
			".dsb-drag-card .dsb-labels{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsb-drag-card .dsb-name{color:var(--dsw-alias-label-primary)}",
			".dsb-drag-card .dsb-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}",
			".dsb-drag-card .dsb-handle{position:relative;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:grab}",
			'.dsb-drag-card .dsb-handle::before{content:"";position:absolute;left:4px;top:1.5px;width:3px;height:3px;border-radius:50%;background:currentColor;box-shadow:5px 0 0 currentColor,0 5px 0 currentColor,5px 5px 0 currentColor,0 10px 0 currentColor,5px 10px 0 currentColor}',
			".dsb-drag-card .dsb-handle-off{opacity:.25}",
			".dsb-settings .dsb-handle{position:relative;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:grab}",
			'.dsb-settings .dsb-handle::before{content:"";position:absolute;left:4px;top:1.5px;width:3px;height:3px;border-radius:50%;background:currentColor;box-shadow:5px 0 0 currentColor,0 5px 0 currentColor,5px 5px 0 currentColor,0 10px 0 currentColor,5px 10px 0 currentColor}',
			".dsb-settings .dsb-handle:active{cursor:grabbing}",
			/* 未勾选的段也能调位置，所以光标跟勾选时一样是抓手，只是点阵淡一些 */
			".dsb-settings .dsb-handle-off{opacity:.25}",
			/* 价格库 */
			".dsb-settings .dsb-card{border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.25));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
			".dsb-settings .dsb-current{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}",
			".dsb-settings .dsb-current b{color:var(--dsw-alias-label-primary);font-weight:600}",
			/* 「更新节假峰谷」+ 状态提示整体贴到这一行的右端，与下面的添加/修改按钮同一条右边界；
			   提示在按钮前面，出现时按钮的右边界不动 */
			".dsb-settings .dsb-current-act{display:flex;align-items:center;gap:8px;margin-left:auto}",
			".dsb-settings .dsb-models{display:flex;flex-direction:column}",
			".dsb-settings .dsb-model{position:relative;display:flex;flex-direction:column;gap:8px;padding:6px 0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.18))}",
			/* 编辑区：毛玻璃浮层，从卡片头部下方展开，盖在下面的内容上 */
			".dsb-settings .dsb-edit-pop{position:absolute;top:calc(100% - 2px);left:0;right:0;z-index:55;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-lg,16px);background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3))}",
			".dsb-settings .dsb-tier{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsb-settings .dsb-tier-name{flex:none;width:48px;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsb-settings .dsb-model:first-child{border-top:0;padding-top:0}",
			".dsb-settings .dsb-model:last-child{padding-bottom:0}",
			".dsb-settings .dsb-model-name{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}",
			".dsb-settings .dsb-model-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}",
			".dsb-settings .dsb-model-actions{display:flex;gap:6px;flex:none}",
			/* 峰谷计价那个勾选只占"勾选框 + 四个字"的宽度，不然整行都能点 */
			".dsb-settings .dsb-inline-check{display:flex;align-self:flex-start;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			/* 勾选在左、计价单位在右 */
			".dsb-settings .dsb-tier-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			/* 币种只有条目这一个下拉：CSS 给它的位置留白（条目级选择器与"峰谷计价"同一行） */
			".dsb-settings .dsb-currency-pick{display:flex;align-items:center;gap:8px}",
			".dsb-settings .dsb-select{position:relative}",
			/* 就一个窄框，字号跟旁边的「峰谷计价」一致，不带下拉箭头 */
			".dsb-settings .dsb-select-btn{display:inline-flex;align-items:center;height:22px;padding:0 8px;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));border-radius:6px;cursor:pointer}",
			/* 下拉复刻底栏气泡那套材质：半透明菜单底 + 毛玻璃 + 大圆角 + .5px 描边柔光 */
			/* 宽度贴合文字：原先写死 min-width:92px，只有三个字母的菜单右边空出一大截。
			   材质保持毛玻璃，只把不透明度从 .382 提到 .618 —— 原来太透，底下价格卡上的数字会透上来。 */
			".dsb-settings .dsb-select-menu{position:absolute;top:calc(100% + 4px);right:0;padding:4px;border-radius:var(--dsw-radius-lg,16px);background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .618);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3));z-index:60}",
			".dsb-settings .dsb-select-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}",
			".dsb-settings .dsb-select-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".dsb-settings .dsb-select-item-on{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
			/* 三组字段整体贴右边缘：左边留给时段名，右边一列对齐。
			   未勾选「峰谷计价」时那行也走同一套 —— 左边是「全时段」标签，
			   不再用"单档那行没有档位名"时的那条双边对齐规则（用户嫌它跟勾选后的两行不一致）。 */
			".dsb-settings .dsb-fields{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}",
			".dsb-settings .dsb-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			/* 够放 xx.xx 就行，输入框不再拉一大条 */
			/* 价格框：只有它 24px。选择器必须带 input[type=...] —— 通用规则
			   `.dsb-settings input[type=number]{height:28px}` 的权重与 `.dsb-field input` 相等、
			   又排在后面，会把高度覆盖回去（实测踩过：用户看到"又变高了"）。
			   自定义模型的名称框走通用规则，保持 28px。 */
			".dsb-settings .dsb-field input[type=text],.dsb-settings .dsb-field input[type=number]{width:52px;height:24px;text-align:right}",
			".dsb-settings input[type=number]::-webkit-outer-spin-button,.dsb-settings input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
			".dsb-settings input[type=number]{-moz-appearance:textfield;appearance:textfield}",
			".dsb-settings input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.5}",
			".dsb-settings input[type=text],.dsb-settings input[type=number],.dsb-settings select{box-sizing:border-box;height:28px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));border-radius:6px;outline:none}",
			".dsb-settings input[type=text]:focus,.dsb-settings input[type=number]:focus,.dsb-settings select:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}",
			".dsb-settings .dsb-addrow{display:flex;gap:8px;align-items:center}",
			".dsb-settings .dsb-addrow input{flex:1;min-width:0}",
			".dsb-settings .dsb-action{box-sizing:border-box;height:28px;padding:0 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));border-radius:6px;cursor:pointer;white-space:nowrap}",
			".dsb-settings .dsb-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
			".dsb-settings .dsb-action-sm{height:24px;padding:0 8px;font-size:12px}",
			/* 「正在更新中」后面那三个点：依次亮起，表示还在跑 */
			".dsb-dots{margin-left:1px}",
			".dsb-dots span{animation:dsb-dot 1.2s ease-in-out infinite}",
			".dsb-dots span:nth-child(2){animation-delay:.2s}",
			".dsb-dots span:nth-child(3){animation-delay:.4s}",
			"@keyframes dsb-dot{0%,60%,100%{opacity:.25}30%{opacity:1}}",
			"@media (prefers-reduced-motion: reduce){.dsb-dots span{animation:none;opacity:1}}",
			".dsb-settings .dsb-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
			/* 版本号贴右侧、与按钮底边对齐 */
			".dsb-settings .dsb-version{margin-left:auto;align-self:flex-end;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);opacity:.75}",
			/* 「GitHub 支持」的悬停提示：外层只定位，气泡本身沿用 .dsb-tip 的毛玻璃材质；
			   左边界与按钮左边界对齐（left:0），浮在按钮正上方 */
			".dsb-settings .dsb-star-wrap{position:relative;display:inline-flex}",
			".dsb-settings .dsb-star-tip{position:absolute;left:0;bottom:100%;margin-bottom:6px;font-size:12px;visibility:hidden;opacity:0;transition:opacity .12s ease}",
			".dsb-settings .dsb-star-wrap:hover .dsb-star-tip,.dsb-settings .dsb-star-wrap:focus-within .dsb-star-tip{visibility:visible;opacity:1}",
			/* 导航项后面的「发现新版本」胶囊：细描边圆角胶囊 + 次级文字色，字号刻意比导航文字小一档 */
			".dsb-nav-pill{box-sizing:border-box;margin-left:4px;padding:0 5px;border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));border-radius:999px;font-size:8px;line-height:1.4;font-weight:400;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			/* 开发模式**不给可见开关**：入口是页脚版本号的「连点 5 次」。
			   胶囊做成标题的上标角标（像 x² 的那个 2）：
			     · 行内 flex + 靠左对齐 → 胶囊紧跟着标题文字，不甩到面板最右；
			     · align-items:flex-start → 胶囊浮在标题文字的右上角，而不是垂直居中。
			   三个刻意的取值：
			     · font-size 与「发现新版本」那枚导航胶囊**逐字一致**（都走 .dsb-nav-pill 的 8px），
			       所以这里不覆盖字号 —— 覆盖过一次（10px）就显得比导航那枚大，两处观感不统一。
			     · **不做负 margin-top**：父级 .dsb-head 是纵向 flex，把胶囊往上顶出容器会被裁掉
			       （实测缺陷：胶囊上边框被切）。
			     · 用 `margin-top:2px` **往下压一点**：标题是 18px、行盒有约 2px 的行距余量，
			       胶囊要落在这段余量里，顶端才不高于标题文字的上边界。 */
			".dsb-settings .dsb-titlerow{display:flex;align-items:flex-start;justify-content:flex-start;gap:4px}",
			".dsb-settings .dsb-dev-pill{margin-left:0;margin-top:2px;padding:0 5px;cursor:default}",
			".dsb-settings .dsb-version{user-select:none;-webkit-user-select:none}",
		].join("");

		/* 导航图标使用外部传入的 gauge（24x24 lucide，stroke=currentColor，随主题变色） */
		const NAV_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';

		/**
		 * 把设置导航里本插件那一项的前导图标换成 gauge。
		 * 定位方式是按导航文案匹配（DSH 没给导航项留 id 属性），匹配不到就什么都不做。
		 */
		/* 导航项里挂「发现新版本」胶囊用：标记本插件那一项，避免胶囊文字混进文案后匹配不上。 */
		const NAV_MARK = "data-dsb-nav";

		/**
		 * 版本自检结果 —— 导航胶囊和设置页那颗「更新」按钮共用这一份，两边同进同出。
		 * 默认什么都没有：只有 registry 上确实更新才显示，查不到就安静地不显示。
		 * note 是更新动作的结果：null / "done" / "failed"。
		 * failedTarget 记「失败的那次试的是哪个版本」：失败态点一下退回可重试时，
		 * 文案要回到那个版本号（而不是 last 里可能已被刷新的别的版本）。
		 */
		let updateState = { hasUpdate: false, latest: null, busy: false, note: null, reason: null, failedTarget: null };

		/**
		 * 开发模式（连点版本号 5 次进入）：让作者在没有新版本的时候也能看到更新按钮的
		 * **全部**状态与动效，用来检查「点下去有没有反馈、文案看不看得懂、失败会不会静默」。
		 *
		 * 打开后：
		 *   - 按钮**常驻**显示（不看 registry 有没有新版），版本号用一个假的演示版本；
		 *   - 每点一次，依次演示「更新中 → 已更新 → 更新失败 → 回到空闲」四种状态；
		 *   - **绝不发安装请求**：走的是纯本地的状态机，不碰任何网络与子进程。
		 *
		 * 为什么不给一个可见的开关：普通用户装了这插件，界面上不该多出一个面向作者的调试项。
		 * 入口做成「连点版本号 5 次」——记得住、够隐蔽，也不会被误触（这是常见的开发者模式手势）。
		 * 进入后标题右侧挂一枚「开发模式」胶囊，明确告诉你当前处于这个状态；再连点 5 次退出。
		 *
		 * 它只影响本插件的界面，不改变任何真实配置；退出即恢复原样。
		 */
		let devMode = false;
		/** 演示用的假版本号：一眼看出不是真版本，避免被误当成真实更新。 */
		const DEV_VERSION = "9.9.9";
		/** 演示用的假失败原因，走的就是真实失败时那条显示路径。 */
		const DEV_FAIL_REASON = "release-age";
		/** 「更新中」演示的时长：够看清三个点的动效，又不至于让人等。 */
		const DEV_BUSY_MS = 2200;
		/** 进入/退出开发模式需要连点几次版本号。 */
		const DEV_CLICKS = 5;
		/** 连点计数：两次点击间隔超过这个毫秒数就重新计数（否则慢慢点 5 次也会进去）。 */
		const DEV_CLICK_WINDOW_MS = 1500;

		/* ---------------------------------------------- 开发模式：解锁记忆 */
		/**
		 * 「解锁过开发模式」记在 localStorage 里，**存的是解锁时的 VERSION**。
		 * 为什么存版本而不是一个 true：版本号升级后 VERSION 常量变了，旧记录自动失效，
		 * 于是要求重新连点 DEV_CLICKS 次 —— 既不用额外写迁移代码，也不会让作者在升级后
		 * 忘了手势还能一键进出。
		 *
		 * 这个键与配置无关（不参与 CONFIG_VERSION 迁移），因为它只影响一个隐藏手势。
		 */
		const DEV_UNLOCK_KEY = "dsh.desktopStatusBar.devUnlock";

		/** 读「解锁时的版本」；任何异常都当没解锁（无痕模式下 localStorage 读写会抛错）。 */
		function devUnlockVersion() {
			try {
				const raw = window.localStorage.getItem(DEV_UNLOCK_KEY);
				return typeof raw === "string" && raw.length > 0 ? raw : null;
			} catch (error) {
				return null;
			}
		}

		/** 记住「这一版已经解锁过」。写不进去（无痕模式）就返回 false，行为退化成每次都要连点。 */
		function rememberDevUnlock() {
			try {
				window.localStorage.setItem(DEV_UNLOCK_KEY, VERSION);
				return true;
			} catch (error) {
				return false;
			}
		}

		/* ------------------------- 开发模式：每字段独立计数（点哪项只变哪项） */
		/**
		 * 用户明确要求（第三次强调，前两次实现都没对上）：
		 *   「点其中一个底栏，为什么其他所有的底栏都变了？点一个，应该只变那一个啊」
		 *   「我要求的是，点底栏其中一项，它自己那一项就切换情况」
		 *
		 * 所以**每个能开气泡的字段各有一个独立计数器**，点开 X 只让 X +1，其余一动不动。
		 * 早先只有一个全局 `devBubbleTick`，任何气泡打开都 +1，于是点一个全变 —— 那是错的。
		 *
		 * 键就是底栏字段的 id（与 SEGMENTS 的 id 一致，圆环用 "context"）：
		 *   status / counts / cacheHit / tps / ttft / sessionTime / lastCost / cost / balance / context
		 */
		const DEV_FIELD_KEYS = [
			"status", "counts", "cacheHit", "tps", "ttft",
			"sessionTime", "lastCost", "cost", "balance", "context"
		];

		/** 一份全 0 的字段计数表（每次进入开发模式都从这里重来）。 */
		function devEmptyFieldScenes() {
			const out = {};
			DEV_FIELD_KEYS.forEach((key) => { out[key] = 0; });
			return out;
		}

		/** 第几次进入开发模式（退出不清零；只做"这是第几次"的记录，不再驱动余额）。 */
		let devRound = 0;

		/** 每字段独立计数器：{ status: 0, counts: 0, ..., balance: 0, context: 0 }。 */
		let devFieldScenes = devEmptyFieldScenes();

		/** 给 StatusBar / 设置页订阅用的快照：必须**换对象才换引用**，否则 useSyncExternalStore 会死循环。 */
		let devSnapshot = { on: false, round: 0, fields: devEmptyFieldScenes() };
		const devListeners = new Set();
		function subscribeDev(fn) {
			devListeners.add(fn);
			return () => { devListeners.delete(fn); };
		}
		function snapshotDev() { return devSnapshot; }
		function useDevState() {
			return react.useSyncExternalStore(subscribeDev, snapshotDev, snapshotDev);
		}
		/**
		 * 模块级标记一变就通知：开发模式的假数据必须立刻出现在底栏上。
		 * 快照里的 `fields` 每次**复制一份** —— 组件按 `fields.xxx` 读到的是稳定的数字，
		 * 而对象本身换引用才能让 useSyncExternalStore 认为"变了"（不换引用会死循环或者不刷新）。
		 */
		function publishDev() {
			devSnapshot = { on: devMode === true, round: devRound, fields: Object.assign({}, devFieldScenes) };
			devListeners.forEach((fn) => { try { fn(); } catch (error) { /* 单个订阅者失败不影响其余 */ } });
		}

		/* ------------------- 开发模式：工具形态场景（5 种，只由 counts 这一个计数驱动） */
		/**
		 * 工具调用气泡的**形态**（几列、名字多长）：
		 *   ① 短气泡（3 个短名） ② 18 个中长名 ③ 420 个极端 ④ 24 个（2 列 × 12 行） ⑤ 长短名极端混排
		 * 它只听 `counts` 那一个计数 —— 用户要的是"点 counts 才换 counts"，点余额不该把
		 * 工具形态也换掉（那正是前两版被否掉的行为）。
		 */
		const DEV_BUBBLE_SCENES = 5;

		/** 某个字段当前的计数（未初始化 / 非法值都当 0）。 */
		function devFieldCount(key) {
			if (devFieldScenes === null || devFieldScenes === undefined) return 0;
			const value = devFieldScenes[key];
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
		}

		/**
		 * 冒泡：**点开哪个字段就只推进哪个字段**（关闭不推进；开发模式外调用一律无效）。
		 * @param {string} fieldId 字段 id（见 DEV_FIELD_KEYS）
		 * @returns {number} 推进后的该字段计数
		 */
		function advanceDevBubbleScene(fieldId) {
			if (devMode !== true) return 0;
			if (typeof fieldId !== "string" || DEV_FIELD_KEYS.indexOf(fieldId) === -1) return 0;
			devFieldScenes[fieldId] = devFieldCount(fieldId) + 1;
			publishDev();
			return devFieldScenes[fieldId];
		}

		/** 重置所有字段计数（进入开发模式时调用；退出时也清一遍，保证下次从第 1 组开始）。 */
		function resetDevFieldScenes() {
			devFieldScenes = devEmptyFieldScenes();
		}
		/** 余额轮数 / 工具场景轮数，决定 ((轮-1) % N) + 1 的取模。 */
		const DEV_BALANCE_ROUNDS = 6;
		const DEV_TOOL_ROUNDS = 4;

		/* ------------------- 开发模式：上下文圆环的形态（只由 context 计数驱动） */
		/**
		 * 圆环要展示 **4 种状态色 × 占用极端** 的组合，每一种都必须在图上**看得见**。
		 *
		 * 一条实测教训（用户原话「红色在哪里？」）：最早 error 那格配的是 percent=0，
		 * 状态类确实挂上了、`stroke:#ef4444` 也确实生效，但**描边长度是 0 像素** ——
		 * 红色一点都画不出来。所以现在每一格都给足可见的占用；error 给两格
		 * （65% 中等、92% 接近满），让"红 + 长描边 + 缺口"能同时出现。
		 *
		 * **不再演示 dashMeter（空环 + 横杠）那一格**：用户明确否决了"没数据也占一格"
		 * —— 横杠什么信息都看不出来。兜底代码路径（meterView 返回 null ⇒ dashMeter）
		 * 当然还在，真实环境照样会走（比如会话刚发出时），只是开发模式不主动演它。
		 *
		 * 格序：
		 *   0 running 55%   —— 常规态（进开发模式立刻看到的就是它）
		 *   1 error 65%     —— 红色，中等长度
		 *   2 error 92%     —— 红色，接近满环 + 缺口
		 *   3 approval 97%  —— 黄色，将满
		 *   4 idle 55% + 缺口算不出 —— 灰色，且轨道保持整圈（capacity 缺 maxOutputTokens）
		 *   5 running 100%  —— 满环，描边整圈闭合
		 *   6 idle 0%       —— 空环（占用 0 这个极端本身，不是"没数据"）
		 *   7 teamRunning 55% —— **蓝色旋转**：只有团队成员在跑，弧长 = 成员级最大占用
		 *   8 deepRunning 10% —— **紫色旋转**：只有更深层在跑，弧长 = 深层最小占用
		 *
		 * 最后两格是 Agent Teams 那两档颜色。它们的 `percent` 是"Lead 自己的占用"，
		 * 与真实环境一样：**颜色由谁在跑决定，弧长切到分层百分比**（见 ringPercentOf）。
		 * 这里故意给两格差异明显的数（55 / 10），开发模式一眼就能看出弧长真的跟着层级变。
		 */
		const DEV_CONTEXT_SCENES = 9;
		/** 假上下文窗口（1M，与官方默认同量级）。压力与容量两处必须用同一个数，否则占用率会自相矛盾。 */
		const DEV_CONTEXT_WINDOW = 1000000;
		/** 本次请求的输出上限（384K，官方默认）——压缩点算得出与否就取决于它在不在。 */
		const DEV_CONTEXT_MAX_OUTPUT = 384000;
		const DEV_CONTEXT_SCENARIO = [
			{ state: "running", percent: 55, notchKnown: true },
			{ state: "error", percent: 65, notchKnown: true },
			{ state: "error", percent: 92, notchKnown: true },
			{ state: "approval", percent: 97, notchKnown: true },
			{ state: "idle", percent: 55, notchKnown: false },
			{ state: "running", percent: 100, notchKnown: true },
			{ state: "idle", percent: 0, notchKnown: true },
			/* 蓝档：成员级占用取**最大**（55），比 Lead 自己的 20 大一截，弧长变化看得出来 */
			{ state: "teamRunning", percent: 20, notchKnown: true, teamRunning: 2, deepRunning: 0, teamContextPercent: 55, deepContextPercent: null },
			/* 紫档：深层占用取**最小**（10），比 Lead 自己的 20 小，方向相反也好认 */
			{ state: "deepRunning", percent: 20, notchKnown: true, teamRunning: 0, deepRunning: 3, teamContextPercent: null, deepContextPercent: 10 }
		];

		/** 假数据的「现在」：模块加载那一刻固定下来。
		    为什么必须固定：总计账本按「调用时刻 + token 数」做指纹去重，如果假数据的 at 每帧都变，
		    每一帧都会被当成一批新调用 —— 底栏上的金额会自己往上涨。 */
		const DEV_FIXTURE_ANCHOR = Date.now();

		/* ------------------- 开发模式：其余 9 个字段的形态矩阵（每字段独立计数） */
		/**
		 * 用户要「开发模式下展示各种情况、各种状态以及极端状况」。
		 *
		 * **但「没数据 → 横杠」整类已经被用户否掉**（原话：「就不要做横杠形态啊，
		 * 既然都没数据，我看得出来什么?」）。理由站得住：横杠什么都看不出来，
		 * 占一格纯浪费；而且它曾经把用户锁死过一次（点不动就翻不到下一格）。
		 * 所以现在每张表**只保留两类**：
		 *   ① 正常有数据  ② 极端值（极大/极小/边界）
		 * 兜底代码路径（segmentText 的横杠、dashMeter、dashBalance、emptySegmentTip）
		 * **一律保留** —— 真实环境照样会走（会话刚发出、某平台查不到余额等），
		 * 只是开发模式不再主动演示它们。
		 */
		const DEV_STATUS_SCENES = 2;
		const DEV_COUNTS_SCENES = 5;
		const DEV_TTFT_SCENES = 2;
		const DEV_CACHEHIT_SCENES = 3;
		const DEV_TPS_SCENES = 2;
		const DEV_SESSIONTIME_SCENES = 3;
		const DEV_LASTCOST_SCENES = 3;
		const DEV_COST_SCENES = 3;
		/**
		 * 余额的两个格数**故意不同**，别混：
		 *   · `DEV_BALANCE_ROUNDS = 6` —— 老契约：`devFixture(round)` 不传字段计数时按它取模，
		 *     tests 的 6 轮矩阵断言钉着它，**不要动**。
		 *   · `DEV_BALANCE_CLICK_SCENES = 11` —— 点余额气泡那一路（每点一次换一格）。
		 *     1~6 是最初那 6 种形态；7~11 是分币种相关的五种
		 *     （双币种 / 只有美元 / 某项为 0 / 两币种都有赠金 / 只有美元带赠金）。
		 */
		const DEV_BALANCE_CLICK_SCENES = 11;

		/**
		 * 假「现在」：**只喂 status 与 sessionTime 两段**，底栏时钟仍走真实 Date.now()。
		 *
		 * 为什么必须假化：status 段就是 `isPeakTime(src.now)` 判出来的，而时钟 state 永远给
		 * 真实时刻 —— 于是"高峰"那一支在开发模式里几乎永远点不到（除非正好在 9-12 / 14-18）。
		 * 用户要看到峰谷两种形态，就必须能人为把"现在"放进指定的时段。
		 *
		 * 为什么只改 src.now 而不改组件 state：改 state 会连带影响每秒时钟的节奏、
		 * sessionTime 的 elapsed 累计、以及"当前是否在跑"的判定 —— 牵一发动全身。
		 * 只在 src 组装处覆盖一次，退出开发模式立刻恢复真实值，风险最小。
		 *
		 * 日期从 2026-11-02（周一）起往后找第一个"按 isPeakTime 判定真的符合"的日子：
		 * 不能硬编码某一天 —— 那天可能是周末或法定节假日（HOLIDAY_SETS 会把它判成低谷），
		 * 写死就会出现「号称高峰、实际低谷」的自相矛盾。运行时用同一个 isPeakTime 自检。
		 */
		const DEV_NOW_CACHE = new Map();
		function devNowAt(wantPeak) {
			const key = wantPeak === true ? "peak" : "valley";
			if (DEV_NOW_CACHE.has(key) === true) return DEV_NOW_CACHE.get(key);
			/* 北京时间的 10:00 落在高峰、20:00 落在低谷；Date.UTC 的小时数要减 8 才是北京小时 */
			const hourUtc = wantPeak === true ? 2 : 12;
			const base = Date.UTC(2026, 10, 2);
			for (let day = 0; day < 60; day += 1) {
				const at = base + day * 86400000 + hourUtc * 3600000;
				if (isPeakTime(at) === (wantPeak === true)) {
					DEV_NOW_CACHE.set(key, at);
					return at;
				}
			}
			/* 六十天都找不到（理论上不可能）：退回固定锚点，至少不崩 */
			DEV_NOW_CACHE.set(key, DEV_FIXTURE_ANCHOR);
			return DEV_FIXTURE_ANCHOR;
		}

		/** counts 技能那一路的 30 条名字池（要能看出多列 + 逐档加行，名字长短也要有差）。 */
		const DEV_SKILL_NAMES = [
			"i-have-adhd", "ponytail", "cangjie-skill", "ui-ux-pro-max", "chanlun",
			"office", "office-docx", "office-xlsx", "office-pptx", "office-render",
			"web-search", "web-fetch", "todo-write", "subagent", "workflow",
			"ralph", "goal-tools", "skill-install", "agent-team", "cordis-plugin",
			"diagnose-sandbox", "dsh-badge", "trade-data", "futu-skill", "hithink",
			"zhouyi", "sunzi", "mao-works", "gann-trend", "elliott-wave"
		];

		/* 本地日期键用现成的 dateKeyOf（同文件的 dateKeyOf 函数）—— 这里原先另写了一份 devDateKey，
		   与它逐字节相同（只有"ms 缺省时怎么兜底"不同，而假数据的两个调用点都必传实参），
		   属于重复实现，已删（审查报告 2-5 条）。 */

		/* ------------------------------ 确定性伪随机（以"场景"为种子） */
		/**
		 * 以 `seed` 为基础的确定性伪随机数发生器（xorshift32）。
		 *
		 * 为什么**必须**用这个而不是 `Math.random()`：
		 *   假数据在底栏每次重渲染时都会重新生成。用真随机的话，同一屏里两次渲染的数字不同 ⇒
		 *   ① 用户看到数字在抖；② 「总计」账本按"调用时刻 + token 数"做指纹去重，每次都是新指纹，
		 *   金额会自己往上涨。
		 * 所以：**同一个 seed ⇒ 永远同一串数**（同场景完全稳定），换 seed 才换一组（看起来没规律）。
		 * 这正是用户要的「随机呀」+ 我们要的「可复现」。
		 *
		 * xorshift32 选它是因为：实现只有三行、状态就是一个 32 位整数、分布够用；
		 * 不需要密码学强度（这只是演示数据）。
		 */
		function devRandom(seed) {
			/* seed 0 是 xorshift 的退化点（永远输出 0），先抬到非零 */
			let state = (Number(seed) | 0) || 0x9e3779b9;
			return function next() {
				state ^= state << 13; state |= 0;
				state ^= state >>> 17;
				state ^= state << 5; state |= 0;
				/* 转成 [0,1)：>>> 0 把它当无符号整数 */
				return ((state >>> 0) % 100000) / 100000;
			};
		}

		/** 把若干场景计数混成一个种子（不同字段组合 ⇒ 不同 seed）。 */
		function devSeedOf() {
			let seed = 0x12345678;
			for (let i = 0; i < arguments.length; i += 1) {
				const value = typeof arguments[i] === "number" && Number.isFinite(arguments[i]) ? arguments[i] : 0;
				seed = ((seed * 31) + (value | 0)) | 0;
			}
			return seed;
		}

		/** 用伪随机取一个区间内的整数（含两端）。 */
		function devRandInt(next, min, max) {
			const lo = Math.ceil(min);
			const hi = Math.floor(max);
			if (hi <= lo) return lo;
			return lo + Math.floor(next() * (hi - lo + 1));
		}

		/**
		 * 工具场景 ③ 的名字池（420 条那档专用）
		 *
		 * 用户实机反馈：「工具调用极端情况可滚动的那个情况，工具名太整齐了，看不出效果」。
		 * 旧实现生成 `tool_001` ~ `tool_420`：全部 8 字符、同前缀、同长度，而列表是
		 * **按名字长度升序**排的 ⇒ 排出来是一块方正网格，横向滚动滚的全是同样的格子。
		 *
		 * 现在改用**真实工具名**，长度从 2 到 37 连续分布，分成四段：
		 *   · 短名区（2~3 字符）   5 个 —— `ls` / `cat` / `pwd`，排在最前
		 *   · 原生区（4~18 字符）  59 个 —— `read` / `git_log` / `stream_read`……
		 *   · MCP 中段（11~21）   336 个 —— `mcp__fs__get` / `mcp__k8s__deploy`……
		 *   · 极长名（25~37）     20 个 —— `mcp__brave_search__wait_for_selector`……
		 * 排序按长度分组，所以滚轮滚过去会依次看到「几格窄的 → 越来越宽 → 最后一大片很宽」，
		 * 一眼能看出确实在滚；最后那批极长名也正好触发 hoverSuppressed。
		 *
		 * **坚决不加数字后缀**：给名字补序号会把长度重新抹平，等于把旧问题换个地方重演。
		 * 420 条互不相同的名字全部由"真实前缀 × 真实动词"组合出来 —— 这些形状在真实的
		 * 工具/MCP 客户端里就是这么写的，不是占位符。
		 */
		const DEV_TOOL_SHORT_NAMES = ["ls", "cat", "pwd", "top", "awk"];
		const DEV_TOOL_BUILTIN_NAMES = [
			"read", "edit", "bash", "glob", "grep", "pwsh", "write", "skill", "task", "wait",
			"kill", "list", "open", "save", "copy", "move", "undo", "redo", "test", "lint",
			"sync", "push", "pull", "dump", "load", "tidy",
			"fs_read", "fs_write", "git_log", "git_diff", "git_show", "sql_query", "http_get",
			"web_fetch", "web_search", "todo_write", "multi_edit", "subagent", "notebook",
			"image_gen", "db_query", "db_migrate", "fs_tree", "git_blame", "git_stash",
			"task_wait", "task_kill", "task_list", "file_open", "file_save", "memory_read",
			"cache_get", "queue_push", "stream_read", "log_query", "health_check", "cron_list",
			"uuid_generate", "semver_compare"
		];
		/* MCP 中段：短服务名 × 短动词，组合出来 11~21 字符（落在「其余在 4~20」那条要求附近）。
		   服务名长短也拉开（`fs` 2 字符 → `postgres` 8 字符），这样中段自身也有梯度，
		   而不是从短名区到长名区中间夹一大块等长格子。 */
		const DEV_MCP_SERVERS = ["fs", "db", "s3", "git", "k8s", "aws", "ssh", "dns", "http", "redis", "kafka", "postgres"];
		const DEV_MCP_VERBS = [
			"get", "set", "put", "del", "run", "list", "find", "read", "push", "pull",
			"sync", "copy", "move", "open", "save", "test", "lint", "scan", "watch", "build",
			"deploy", "restart", "status", "logs", "tail", "merge", "query", "reload"
		];
		/* 极长名：长服务名 × 长动词，组合出来 25~37 字符（触发悬停抑制那一档） */
		const DEV_MCP_LONG_SERVERS = ["playwright", "filesystem", "memory_bank", "brave_search"];
		const DEV_MCP_LONG_VERBS = [
			"merge_pull_request", "wait_for_selector", "evaluate_script", "download_file", "add_comment"
		];

		/**
		 * 工具场景（`desktopStatusbarProgress.toolCounts` 的假值）。编号与含义：
		 *   ① 3 个短名工具（4~7 字符，最窄的一档） ② 18 个名字 2~27 字符（含 >=20 字符的）
		 *   ③ 420 个**真实长短名混排**（见上面那四组名字池；2~37 字符连续分布）
		 *   ④ 24 个 4~5 字符短名（2 列 × 12 行）
		 *   ⑤ 长短名**极端**混排：2 字符与 50+ 字符同屏（只供"点 counts 换形态"那一路）
		 *
		 * ①~④ 同时供 `devFixture(round)` 按轮取模用（每轮一种，旧的演示节奏靠它）；
		 * ⑤ 只在 counts 计数推进时出现，不进轮次取模 ——
		 * 否则 devFixture 的 4 轮循环会被打破（tests/verify-dev-fixtures.js 有断言盯着）。
		 */
		function devToolCounts(scene) {
			const out = {};
			if (scene === 1) {
				out.read = 7;
				out.edit = 3;
				out.browser = 2;
				return out;
			}
			if (scene === 2) {
				/* 名字长度 3~27 混排：底栏的工具列表按名字长度升序排，能看出长短混排的效果 */
				const names = [
					"cat", "ls", "grep", "read", "edit", "bash", "pwsh", "glob", "write", "skill",
					"subagent", "web_fetch", "web_search", "todo_write", "multi_edit",
					"mcp__demo__search", "mcp__playwright__screenshot", "mcp__agents__spawn_subagent"
				];
				names.forEach((name, index) => { out[name] = 1 + (index % 5); });
				return out;
			}
			if (scene === 3) {
				/* 420 条 = 5 短 + 59 原生 + 336 中段 MCP + 20 极长 MCP。
				   次数 1~12 各不相同，悬停占比条因此不会全一样。
				   写入顺序按"短→中→长"，JSON 里读起来也能看出梯度（列表自己排序，与写入顺序无关）。 */
				let index = 0;
				const put = (name) => {
					out[name] = 1 + ((index * 5) % 12);
					index += 1;
				};
				DEV_TOOL_SHORT_NAMES.forEach(put);
				DEV_TOOL_BUILTIN_NAMES.forEach(put);
				DEV_MCP_SERVERS.forEach((server) => {
					DEV_MCP_VERBS.forEach((verb) => put("mcp__" + server + "__" + verb));
				});
				DEV_MCP_LONG_SERVERS.forEach((server) => {
					DEV_MCP_LONG_VERBS.forEach((verb) => put("mcp__" + server + "__" + verb));
				});
				return out;
			}
			if (scene === 4) {
				/* 24 个 4~5 字符短名：24 ÷ 12 行 = 2 列，正好停在上限那一档 */
				const short = [
					"read", "edit", "bash", "glob", "grep", "pwsh", "task", "wait",
					"kill", "list", "open", "save", "copy", "move", "undo", "redo",
					"test", "lint", "sync", "push", "pull", "dump", "load", "tidy"
				];
				short.forEach((name, index) => { out[name] = 1 + (index % 4); });
				return out;
			}
			/* ⑤ 长短名极端混排：2 字符的挤在最前、30+ 字符的排在最后（列表按长度升序）。
			   用来暴露「短名时名字与次数的间隙」与「长名时悬停提示放不下就整组关掉」这两条边界。 */
			const mixed = [
				"lm", "ok", "go", "up", "id", "ip",
				"read", "edit", "bash", "glob", "grep", "skill",
				"web_search", "todo_write", "mcp__demo__search",
				"mcp__playwright__screenshot",
				"mcp__agents__spawn_subagent__with_extra_long_suffix",
				"mcp__external__fetch_and_transform_document_pipeline"
			];
			mixed.forEach((name, index) => { out[name] = 1 + (index % 6); });
			return out;
		}

		/**
		 * 11 种余额形态（点余额那一项的轮换顺序见 DEV_BALANCE_CLICK_SCENES）：
		 *   ① DeepSeek 金额（充值 70 + 赠金 30，色条按 7:3 分两段）
		 *   ② 智谱 Coding Plan 百分比配额（isPercent，已用 62.50%）
		 *   ③ WorkBuddy 积分（1280，rewards：1 个月度包 + 4 个同名裂变包 + 2 个同名普通包）
		 *   ④ 中转站按量计费（USD 86.40 + 累计消费 13.60）
		 *   ⑤ 中转站积分制（320 积分，3 个套餐 25% / 50% / 75%）
		 *   ⑥ DeepSeek 不足一分钱（subCent:true + 已截断的 "0.00" ⇒ 界面显示「余额 <¥0.01」）
		 *   ⑦ 人民币 + 美元双币种（¥14.12 + $3.17，底栏 `余额 ¥14.12+$3.17`）
		 *   ⑧ 只有美元一项（`余额 $3.17`，验证单项不带 +）
		 *   ⑨ 美元项为 0（`余额 ¥14.12`，验证 0 那项不出现）
		 *   ⑩ **两币种都有赠金**（CNY 10.00+2.50 / USD 4.00+1.00 ⇒ 色条灰约 80% / 紫约 20%）
		 *   ⑪ 只有美元且带赠金（验证 USD→CNY 折算方向是乘）
		 *
		 * 字段名照宿主真实响应（lib/index.js 的 queryBalance / balance-api.js 的 parse）：
		 * ok / at / currency / total / toppedUp / granted / spent / subCent / isPercent / isCredits / rewards。
		 * **3.0.0 起 `balances` 每笔也带 `toppedUp` / `granted`**（`{currency, total, toppedUp, granted}`）：
		 * 气泡里那条「按币种折算的色条」靠它算比例；少了这两个字段会静默退回顶层混合值，
		 * 于是折算逻辑在开发模式里永远演示不出来（这正是 ⑩ 存在的意义）。
		 */
		function devBalanceFixture(which) {
			const at = DEV_FIXTURE_ANCHOR;
			if (which === 1) {
				return {
					ok: true, at: at, source: "dev", currency: "CNY",
					total: "100.00", toppedUp: "70.00", granted: "30.00", available: true,
					parts: [{ label: "toppedUp", amount: "70.00" }, { label: "granted", amount: "30.00" }]
				};
			}
			if (which === 2) {
				/* 百分比口径：total 带 %、currency 留空（客户端据此不拼货币符号），
				   气泡里只列「剩余配额」一行 = 100 - 62.50 = 37.50% */
				return {
					ok: true, at: at, source: "dev", provider: "zhipu", currency: "",
					total: "62.50%", isPercent: true, parts: [], toppedUp: "0.00", granted: "0.00"
				};
			}
			if (which === 3) {
				/* WorkBuddy 积分：rewards 的顺序**必须**是「月度包 → 4 个同名裂变包 → 2 个同名普通包」。
				   客户端只聚合**相邻同名**包（先聚合、后排序），中间插了别的名字就并不成 ×4 / ×2。
				   聚合后的 percent：月度 400/800=50%、裂变 396/1200=33%、普通 402/600=67%。 */
				const split = { name: "个人版国内运营裂变包", used: 99, total: 300, monthly: false, expireAt: "2026-12-31", refreshAt: null };
				const normal = { name: "活动赠送包", used: 201, total: 300, monthly: false, expireAt: "2026-11-20", refreshAt: null };
				return {
					ok: true, at: at, source: "dev", provider: "workbuddy", currency: "",
					total: "1280", isCredits: true, parts: [],
					rewards: [
						{ name: "专业版月度包", used: 400, total: 800, monthly: true, expireAt: null, refreshAt: "2026-11-01" },
						split, split, split, split,
						normal, normal
					]
				};
			}
			if (which === 4) {
				return {
					ok: true, at: at, source: "dev", currency: "USD",
					total: "86.40", toppedUp: "86.40", granted: "0.00", spent: "13.60",
					parts: [{ label: "toppedUp", amount: "86.40" }, { label: "spent", amount: "13.60" }]
				};
			}
			if (which === 5) {
				/* 积分制中转站：3 个**不同名**套餐（不聚合），percent 25 / 50 / 75，没有裂变包 */
				return {
					ok: true, at: at, source: "dev", currency: "",
					total: "320", isCredits: true, parts: [],
					rewards: [
						{ name: "标准套餐", used: 25, total: 100, monthly: false, expireAt: "2026-12-15", refreshAt: null },
						{ name: "专业套餐", used: 100, total: 200, monthly: false, expireAt: "2026-11-30", refreshAt: null },
						{ name: "团队套餐", used: 300, total: 400, monthly: false, expireAt: "2026-11-10", refreshAt: null }
					]
				};
			}
			if (which === 7) {
				/* ⑦ **人民币 + 美元双币种**（用户原话那个例子：「我美元模型用了 7.77。
				   人民币模型用了 145.66。那显示就应该显示 ¥145.66+$7.77」）。
				   这里用 14.12 / 3.17 两个数（任务指定），底栏应显示 `余额 ¥14.12+$3.17`。
				   注意 `total` 仍给一个混合值（17.29 = 14.12 + 3.17）：老 host 没有 balances 时
				   靠它兜底，两者语义一致才不矛盾。

				   **每笔 balances 都带 toppedUp / granted**（3.0.0 起宿主也给）：
				   没有这两个字段的话，气泡里「按币种折算的色条」永远走回退分支
				   （只能拿顶层混合值），折算逻辑在开发模式里就一次都演示不出来。
				   本形态赠金全是 0 ⇒ 色条会是一整段灰（这是正确表现，见形态 10 的双向赠金）。 */
				return {
					ok: true, at: at, source: "dev", currency: "CNY",
					total: "17.29", toppedUp: "17.29", granted: "0.00",
					parts: [{ label: "toppedUp", amount: "17.29" }, { label: "granted", amount: "0.00" }],
					balances: [
						{ currency: "CNY", total: "14.12", toppedUp: "14.12", granted: "0.00" },
						{ currency: "USD", total: "3.17", toppedUp: "3.17", granted: "0.00" }
					]
				};
			}
			if (which === 8) {
				/* ⑧ **只有美元一项**：验证「单项不带 +」——底栏应是 `余额 $3.17`，
				   不能出现 `¥0.00+$3.17` 那种写法。 */
				return {
					ok: true, at: at, source: "dev", currency: "USD",
					total: "3.17", toppedUp: "3.17", granted: "0.00",
					parts: [{ label: "toppedUp", amount: "3.17" }, { label: "granted", amount: "0.00" }],
					balances: [{ currency: "USD", total: "3.17", toppedUp: "3.17", granted: "0.00" }]
				};
			}
			if (which === 9) {
				/* ⑨ **美元项为 0**：验证用户那条规则「其中有一项为 0…就不用显示这个 +」。
				   底栏应仍是 `余额 ¥14.12`（0 那项被过滤掉），不会出现 `¥14.12+$0.00`。 */
				return {
					ok: true, at: at, source: "dev", currency: "CNY",
					total: "14.12", toppedUp: "14.12", granted: "0.00",
					parts: [{ label: "toppedUp", amount: "14.12" }, { label: "granted", amount: "0.00" }],
					balances: [
						{ currency: "CNY", total: "14.12", toppedUp: "14.12", granted: "0.00" },
						{ currency: "USD", total: "0", toppedUp: "0", granted: "0" }
					]
				};
			}
			if (which === 10) {
				/* ⑩ **两个币种都有赠金** —— 这是唯一能让「按币种折算的色条」真正出效果的形态。
				   前几种形态赠金全是 0，色条只会是一整段灰，折算逻辑等于没演示；
				   这里两个币种各带一部分赠金，折算后应当出现灰 / 紫两段。

				   数值自洽（每笔 toppedUp + granted === total，顶层也等于各笔之和）：
				     · CNY：10.00 充值 + 2.50 赠金 = 12.50
				     · USD： 4.00 充值 + 1.00 赠金 =  5.00
				     · 顶层：14.00 充值 + 3.50 赠金 = 17.50
				   色条预期（REFERENCE_RATE ≈ 6.7424，折到 CNY）：
				     充值 = 10.00 + 4.00×6.7424 = 36.97
				     赠金 =  2.50 + 1.00×6.7424 =  9.24
				     ⇒ **灰约 80% / 紫约 20%**（仍是两段，不按币种拆四段）。
				   若看到的是「灰 100%」或「灰 87.9%（直接相加没折算）」，说明折算分支没生效。 */
				return {
					ok: true, at: at, source: "dev", currency: "CNY",
					total: "17.50", toppedUp: "14.00", granted: "3.50",
					parts: [{ label: "toppedUp", amount: "14.00" }, { label: "granted", amount: "3.50" }],
					balances: [
						{ currency: "CNY", total: "12.50", toppedUp: "10.00", granted: "2.50" },
						{ currency: "USD", total: "5.00", toppedUp: "4.00", granted: "1.00" }
					]
				};
			}
			if (which === 11) {
				/* ⑪ **只有美元且带赠金** —— 验证折算方向（USD → CNY 是**乘**汇率，不是除）。
				   如果方向搞反了，充值/赠金都会被缩小 45 倍，但**比例仍可能是 80:20**，
				   所以单看百分比看不出错 —— 这条形态主要配合下面 `devBalanceFixture`
				   的数值断言一起看（折算绝对值对不对）。
				   数值：USD 4.00 充值 + 1.00 赠金 = 5.00，比例仍是 灰 80% / 紫 20%。 */
				return {
					ok: true, at: at, source: "dev", currency: "USD",
					total: "5.00", toppedUp: "4.00", granted: "1.00",
					parts: [{ label: "toppedUp", amount: "4.00" }, { label: "granted", amount: "1.00" }],
					balances: [{ currency: "USD", total: "5.00", toppedUp: "4.00", granted: "1.00" }]
				};
			}
			/* ⑥ 不足一分钱：宿主判定的是**未截断**的 total（0 < total < 0.01 ⇒ subCent:true），
			   而显示用的 total 已经被 formatBalanceAmount 截到分 ⇒ "0.00"。
			   客户端只要看到 subCent:true 就显示「余额 <¥0.01」，两个字段必须成对出现。
			   **保持在第 6 格**：`DEV_BALANCE_ROUNDS`（6 轮矩阵）那条旧契约是按它断言的，
			   新加的分币种形态排在它后面（7~11），不能把 6 挤走。 */
			return {
				ok: true, at: at, source: "dev", currency: "CNY",
				total: "0.00", subCent: true, toppedUp: "0.00", granted: "0.00",
				parts: [{ label: "toppedUp", amount: "0.00" }, { label: "granted", amount: "0.00" }]
			};
		}

		/** 单次调用的用量记录（desktopStatusbarUsage.calls 的元素，字段照 usageCall schema）。 */
		function devUsageCall(atMs, input, cacheRead, cacheWrite, output) {
			return {
				at: atMs,
				model: "deepseek-flash",
				input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output
			};
		}

		/**
		 * desktopStatusbarUsage 的假值。
		 *
		 * 两个独立驱动：
		 *   · `costCount`  —— 「总计」那一堆历史调用（calls / models / overflow）
		 *   · `lastCostCount` —— 「本轮」那一条（current）与轮号（turn）
		 * 分成两份的原因：用户要求"点总计只变总计、点本轮只变本轮"。早先一个计数同时驱动两者，
		 * 点任一个都会让另一个的数字跳。
		 *
		 * 金额会**随计数明显变大**：costCount 越大，历史调用的 token 越多（每 +1 多一批），
		 * 所以「总计」的金额单调上涨、一眼看得出变化。
		 *
		 * 时间戳全部以 DEV_FIXTURE_ANCHOR 为基准且与计数无关 ⇒ 同一场景反复调用得到完全相同的
		 * 指纹（总计账本按"时刻 + token"去重，乱变会让钱自己涨）。
		 */
		function devSessionUsageFixture(costCount, lastCostCount, baseTurn, turnEmpty) {
			const anchor = DEV_FIXTURE_ANCHOR;
			/* 历史调用：条数与 token 量都随 costCount 增长（阶梯明显，不是微调） */
			const history = devRandom(devSeedOf(7, costCount));
			const callTotal = 3 + costCount * 2;
			const calls = [];
			for (let i = 0; i < callTotal; i += 1) {
				const scale = (costCount + 1) * (0.6 + history() * 0.9);
				calls.push(devUsageCall(
					anchor - (callTotal - i) * 60000,
					Math.round(devRandInt(history, 4000, 40000) * scale),
					Math.round(devRandInt(history, 60000, 700000) * scale),
					Math.round(devRandInt(history, 0, 12000) * scale),
					Math.round(devRandInt(history, 6000, 60000) * scale)
				));
			}
			const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			calls.forEach((one) => {
				total.input += one.input;
				total.cacheRead += one.cacheRead;
				total.cacheWrite += one.cacheWrite;
				total.output += one.output;
			});
			/* 本轮：只由 lastCostCount 驱动；轮号跟着它走，这样「本轮」的粘性下限会作废重算 */
			const turnNext = devRandom(devSeedOf(8, lastCostCount));
			const turnNo = typeof baseTurn === "number" && Number.isFinite(baseTurn) ? baseTurn : 1;
			const turnScale = (lastCostCount + 1) * (0.7 + turnNext() * 1.1);
			const currentCall = devUsageCall(
				anchor - 240000,
				Math.round(devRandInt(turnNext, 3000, 30000) * turnScale),
				Math.round(devRandInt(turnNext, 40000, 500000) * turnScale),
				Math.round(devRandInt(turnNext, 0, 8000) * turnScale),
				Math.round(devRandInt(turnNext, 4000, 50000) * turnScale)
			);
			const current = {
				provider: "deepseek-official", model: "deepseek-flash", time: currentCall.at,
				input: currentCall.input, cacheRead: currentCall.cacheRead,
				cacheWrite: currentCall.cacheWrite, output: currentCall.output,
				/* turnEmpty：本轮还没有任何调用。
				   segmentView 的 lastCost 就是按 current.calls 逐条算价的 —— 留一条就一定会
				   算出金额，"正在跑但本轮没调用（¥0.00）"与"空闲无数据（¥-）"两格就都到不了。
				   轮号（turn）仍保留：它只用来判断"这份用量属不属于本轮"，与本轮有没有调用无关。 */
				calls: turnEmpty === true ? [] : [currentCall]
			};
			return {
				models: { "deepseek-flash": total },
				calls: calls,
				overflow: {},
				/* 轮号由本轮计数推出：一变「本轮」的轮标识就变，粘性下限自动作废 */
				turn: turnNo + lastCostCount * 7,
				current: current,
				last: calls.length > 2 ? {
					provider: "deepseek-official", model: "deepseek-flash", time: calls[calls.length - 2].at,
					input: calls[calls.length - 2].input, cacheRead: calls[calls.length - 2].cacheRead,
					cacheWrite: calls[calls.length - 2].cacheWrite, output: calls[calls.length - 2].output,
					calls: [calls[calls.length - 2]]
				} : current,
				/* 压缩摘要那一份额外累计（「总计用量」要把它加到官方投影上） */
				summaryParts: {
					input: Math.round(total.input * 0.03),
					cacheRead: Math.round(total.cacheRead * 0.01),
					cacheWrite: 0,
					output: Math.round(total.output * 0.015)
				}
			};
		}

		/**
		 * 当一个月的日历假值（字段照 lib/index.js 的 monthUsagePayload）。
		 *
		 * **月份由 status 计数轮换**：用户实机反馈「一直在用 10 月份的呢」—— 早先这里写死
		 * `new Date(now)` 取当前月，所以月热力图永远停在本月，换月这个 UI 形态根本看不到。
		 * 现在从**当前月往前推** `shift` 个月（0 = 本月、1 = 上月…），点一次 status 就翻一页。
		 * 往前推而不是随便取，是为了"连续看几个月"这件事本身说得通。
		 *
		 * 每天的用量用确定性伪随机生成（同一个月 ⇒ 同一组数），所以柱高有高有低、不是斜线。
		 */
		function devMonthFixture(now, shift) {
			const back = typeof shift === "number" && Number.isFinite(shift) && shift > 0 ? Math.floor(shift) : 0;
			const today = new Date(now);
			/* 用 Date 的月份归一化能力往前推（它会自动跨年） */
			const first = new Date(today.getFullYear(), today.getMonth() - back, 1);
			const year = first.getFullYear();
			const month = first.getMonth() + 1;
			const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
			const daysInMonth = new Date(year, month, 0).getDate();
			const lastWeekday = (new Date(year, month - 1, daysInMonth).getDay() + 6) % 7;
			const gridDays = daysInMonth + firstWeekday + (6 - lastWeekday);
			const gridStart = new Date(year, month - 1, 1 - firstWeekday);
			/* 这个月的伪随机种子 = 年月（同一个月永远同一组数） */
			const next = devRandom(devSeedOf(11, year * 100 + month));
			const days = [];
			let max = 0;
			let maxDate = null;
			for (let i = 0; i < gridDays; i += 1) {
				const at = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i).getTime();
				const key = dateKeyOf(at);
				const inMonth = i >= firstWeekday && i < firstWeekday + daysInMonth;
				/* 每天的量：伪随机 + 周末更低（真实用量确实有周末效应），不是等差 */
				const weekday = (new Date(at).getDay() + 6) % 7;
				const weekend = weekday >= 5 ? 0.35 : 1;
				const total = inMonth === true
					? Math.round((600 + next() * 9000) * weekend)
					: 0;
				const input = Math.round(total * (0.08 + next() * 0.12));
				const cacheRead = Math.round(total * (0.6 + next() * 0.18));
				const cacheWrite = Math.round(total * (0.01 + next() * 0.03));
				const output = Math.max(0, total - input - cacheRead - cacheWrite);
				/* 量级与 devDailyFixture 对齐（1 元级）：原来是 `total/1e6`，当月单日只有 0.01 级，
				   而「金额不足 0.01 不显示」那条规则一上，日历上会全是 ¥0.00 —— 开发模式就验证不到
				   分币种格式了。把 1e6 改成 1e4 等于放大 100 倍，落到 1~几元这一档。
				   （只动量级，不动拆币逻辑：costByCurrency 各项之和仍严格等于 cost。） */
				const dayCost = total > 0 ? Math.round(total / 1e4 * 2.2 * 10000) / 10000 : 0;
				days.push({
					date: key,
					inMonth: inMonth,
					total: total,
					calls: total > 0 ? Math.round(1 + next() * 9) : 0,
					cost: dayCost,
					/* 分币种：按格序号轮换三种形态（混币 / 只有人民币 / 只有美元），
					   各币种之和 === cost；合计为 0 的天给空对象（没费用就没有币种） */
					costByCurrency: devCostSplit(dayCost, devCostShapeAt(i)),
					input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output
				});
				if (inMonth === true && total > max) {
					max = total;
					maxDate = key;
				}
			}
			return { year: year, month: month, max: max, maxDate: maxDate, days: days };
		}

		/**
		 * 当年 12 个月聚合假值（字段照 lib/index.js 的 yearUsagePayload）。
		 * 每月一个伪随机量（同一年的值稳定），不是"逐月 +9000"那种斜线。
		 */
		function devYearFixture(now, shift) {
			const back = typeof shift === "number" && Number.isFinite(shift) && shift > 0 ? Math.floor(shift) : 0;
			const first = new Date(new Date(now).getFullYear(), new Date(now).getMonth() - back, 1);
			const year = first.getFullYear();
			const next = devRandom(devSeedOf(12, year));
			const months = [];
			let max = 0;
			let maxMonth = null;
			for (let m = 1; m <= 12; m += 1) {
				const input = Math.round(devRandInt(next, 8000, 260000));
				const cacheRead = Math.round(devRandInt(next, 60000, 3200000));
				const cacheWrite = Math.round(devRandInt(next, 0, 40000));
				const output = Math.round(devRandInt(next, 20000, 420000));
				const total = input + cacheRead + cacheWrite + output;
				/* **保持 1e6 不动**：年度桶的 `total` 是「四个 token 数相加」（百万级），
				   本身比月度的单日 `total`（几百）大 ~400 倍，所以 1e6 算出来就是 1~5 元，
				   已经是与 devDailyFixture 同量级。真正太小的是月度那条（见 devMonthFixture）。 */
				const monthCost = Math.round(total / 1e6 * 2.2 * 10000) / 10000;
				months.push({
					month: m, total: total, calls: devRandInt(next, 4, 120),
					cost: monthCost,
					/* 分币种：12 个月也轮换三种形态，各币种之和 === cost */
					costByCurrency: devCostSplit(monthCost, devCostShapeAt(m - 1)),
					input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output
				});
				if (total > max) {
					max = total;
					maxMonth = m;
				}
			}
			return { year: year, max: max, maxMonth: maxMonth, months: months };
		}

		/**
		 * 活跃总览（峰谷气泡）假值：近 7 天 + 当月日历 + 12 个月方块，字段照 /api/daily-usage。
		 *
		 * **全部由 status 计数驱动**（用户要"点峰谷那一项只变峰谷"）：
		 *   · 月份往前翻 `status` 个月（月热力图不再永远停在本月）
		 *   · 近 7 天的柱高用确定性伪随机生成，有高有低 —— 用户原话「随机呀，懂不懂什么叫随机？」，
		 *     明确不要"每天比前一天多 1200"那种等差斜线
		 * 同一 status 值 ⇒ 同一组数（同场景稳定，总计账本不会被带乱）。
		 */
		function devDailyFixture(now, statusCount) {
			const shift = typeof statusCount === "number" && Number.isFinite(statusCount) && statusCount > 0
				? Math.floor(statusCount)
				: 0;
			const today = new Date(now);
			const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime();
			/* 种子里带 shift：每翻一次月/点一次 status，整组数都换一遍 */
			const next = devRandom(devSeedOf(13, shift));
			const days = [];
			const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0, cost: 0 };
			for (let i = 0; i < 7; i += 1) {
				const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + i).getTime();
				const weekday = (new Date(at).getDay() + 6) % 7;
				/* 周末低谷 + 每根柱子独立随机：相邻两天可能相差好几倍，也可能相近 —— 看不出规律 */
				const weekend = weekday >= 5 ? 0.3 : 1;
				const input = Math.round(devRandInt(next, 2000, 30000) * weekend);
				const cacheRead = Math.round(devRandInt(next, 30000, 900000) * weekend);
				const cacheWrite = Math.round(devRandInt(next, 0, 9000) * weekend);
				const output = Math.round(devRandInt(next, 4000, 120000) * weekend);
				const total = input + cacheRead + cacheWrite + output;
				const cost = Math.round(total / 1e6 * 2.2 * 10000) / 10000;
				const peakRatio = 0.35 + next() * 0.4;
				const peak = {
					input: Math.round(input * peakRatio), cacheRead: Math.round(cacheRead * peakRatio),
					cacheWrite: Math.round(cacheWrite * peakRatio), output: Math.round(output * peakRatio)
				};
				peak.total = peak.input + peak.cacheRead + peak.cacheWrite + peak.output;
				/* 分币种金额：三天形态轮换（混币 / 只有人民币 / 只有美元），
				   与 `cost` 严格相等 —— 悬停逐天看就能看到 `¥x+$y`、`¥x`、`$y` 三种写法。 */
				const costByCurrency = devCostSplit(cost, devCostShapeAt(i));
				days.push({
					date: dateKeyOf(at), input: input, cacheRead: cacheRead, cacheWrite: cacheWrite,
					output: output, total: total, calls: Math.round(2 + next() * 14),
					peak: peak, cost: cost, costByCurrency: costByCurrency
				});
				totals.input += input;
				totals.cacheRead += cacheRead;
				totals.cacheWrite += cacheWrite;
				totals.output += output;
				totals.total += total;
				totals.calls += days[days.length - 1].calls;
				totals.cost += cost;
			}
			totals.cost = Math.round(totals.cost * 10000) / 10000;
			/* 周汇总也要带分币种（周条悬停读的是 totals）：把 7 天各自那份相加，
			   各币种之和因此**严格等于** totals.cost（不是另外造一个数）。 */
			const totalsByCurrency = {};
			days.forEach((one) => {
				const map = one.costByCurrency;
				if (map === null || map === undefined || typeof map !== "object") return;
				Object.keys(map).forEach((code) => {
					totalsByCurrency[code] = Math.round(((totalsByCurrency[code] || 0) + map[code]) * 10000) / 10000;
				});
			});
			totals.costByCurrency = totalsByCurrency;
			return {
				ok: true, at: now, rangeStart: start,
				days: days, totals: totals,
				month: devMonthFixture(now, shift), year: devYearFixture(now, shift)
			};
		}

		/**
		 * 队友（子智能体）用量假值：`session`（整会话，供「总计」）与 `turn`（本轮窗口，供「本轮」）
		 * 两段都给 ok:true 且 cost > 0，界面上两侧都能看出「已经把队友并进来」。
		 *
		 * **刻意不随任何字段计数变化**（`seed` 只由 devRound 决定）：队友那两段同时进「总计」
		 * 与「本轮」，一旦跟着某字段变，点别的气泡时金额也会动 —— 那正是用户反对的串扰。
		 * 字段照 /api/subagent-usage 的真实响应（total.cost / tokens / calls / stats / costByCurrency）。
		 */
		function devSubagentFixture(sessionId, seed) {
			const next = devRandom(devSeedOf(14, seed));
			const pick = (min, max) => devRandInt(next, min, max);
			const tokensOf = (input, cacheRead, cacheWrite, output) => ({
				input: input, cacheRead: cacheRead, cacheWrite: cacheWrite, output: output
			});
			const sessionCost = Math.round((0.4 + next() * 6) * 100) / 100;
			const turnCost = Math.round((0.1 + next() * 1.6) * 100) / 100;
			const sessionTokens = tokensOf(pick(8000, 40000), pick(40000, 220000), pick(0, 3000), pick(12000, 70000));
			const turnTokens = tokensOf(pick(1000, 8000), pick(6000, 40000), 0, pick(2000, 16000));
			return {
				session: {
					ok: true, sessionId: sessionId, sinceSource: "client", running: 0,
					children: [{ id: "dev-subagent-1", cost: sessionCost, tokens: sessionTokens, calls: pick(3, 20) }],
					total: {
						cost: sessionCost, costByCurrency: { CNY: sessionCost }, tokens: sessionTokens,
						calls: pick(3, 20),
						stats: {
							ttftMs: pick(2000, 12000), ttftSteps: pick(1, 4),
							decodeMs: pick(8000, 60000), decodeTokens: pick(2000, 12000)
						}
					}
				},
				turn: {
					ok: true, sessionId: sessionId, sinceSource: "client", running: 0,
					children: [{ id: "dev-subagent-1", cost: turnCost, tokens: turnTokens, calls: pick(1, 5) }],
					total: {
						cost: turnCost, costByCurrency: { CNY: turnCost }, tokens: turnTokens, calls: pick(1, 5),
						stats: { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
					}
				}
			};
		}


		/* ----------------------- 每个数据槽听哪个字段计数（点哪项只变哪项的核心）
		 *
		 * 归属取舍（写在 devFixture 里，没单列成映射表 —— 那张表自从写好后一次都没被读过，
		 * 各槽位全是硬编码的，留着只会让人以为改表就能改行为）：
		 *   · `stats.decodeMs` / `decodeTokens` —— 归 **tps**。它们同时被「综合速度」
		 *     （decodeTokens/decodeMs）与「总用时」气泡的"模型用时"读，二选一；
		 *     归 tps 是因为那两项是速度的直接分子分母，归 sessionTime 会让"点总用时"时
		 *     速度也跟着变（更违反"点哪项只变哪项"）。
		 *     代价：点 tps 时总用时气泡里的"模型用时"一行也会变 —— 但底栏那个总时长不变，
		 *     属于可接受的最小串扰。
		 *   · `sessionUsage.current`（本轮）—— 归 **lastCost**。它同时被「本轮费用」与
		 *     「本轮命中率」读；本轮费用是那个字段的主数字，命中率另有 usage 那条路。
		 *   · `sessionUsage.turn` —— 归 **lastCost**。它一变「本轮」的轮标识就变，
		 *     同轮粘性下限自动作废、本轮金额因此能真的跟着换，而不是被旧下限锁住。
		 *   · `usage.*`（官方 tokenUsage）—— 归 **cacheHit**。综合命中率的分母就是它；
		 *     它同时也进「总计」气泡的 token 明细（底栏金额不受影响），属于可接受串扰。
		 *   · 表里没提到的槽位（例如 subagent、sessionModel）**永远不变** ——
		 *     这样点任何一个气泡都不会顺手改到别人的数据。
		 */

		/**
		 * 生成整套假投影。
		 *
		 * 入参 `fieldScenes` 是**每字段独立计数**（见 DEV_FIELD_KEYS）：
		 *   { status:0, counts:2, cacheHit:0, tps:0, ttft:0, sessionTime:0,
		 *     lastCost:0, cost:1, balance:3, context:0 }
		 * 每个槽位只读自己那个字段的计数，于是：
		 *   **点开哪个气泡，就只有那个气泡的数据变**。
		 *
		 * 完全不传时所有计数为 0，且 balance / toolCounts 仍按 round 取模 ——
		 * 这样 `devFixture(round, t)` 这个纯函数契约与 tests/verify-dev-fixtures.js 的
		 * 6 轮余额 / 4 轮工具断言原样成立。
		 *
		 * 一级字段（与 StatusBar 读投影的名字一一对应，注入时按这些键覆盖）：
		 *   balance / stats / usage / sessionUsage / timing / pressure / breakdown /
		 *   capacity / progress / timeRange / daily / subagent / sessionModel
		 */
		function devFixture(round, t, fieldScenes) {
			const value = typeof round === "number" && Number.isFinite(round) ? Math.max(1, Math.floor(round)) : 1;
			/* 归一化第三个参数：只接受对象（调用方一律传对象或 undefined） */
			const scenes = fieldScenes !== null && fieldScenes !== undefined && typeof fieldScenes === "object"
				? fieldScenes
				: null;
			const countOf = (key) => {
				if (scenes === null) return 0;
				const raw = scenes[key];
				return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
			};

			const balanceCount = countOf("balance");
			const statusCount = countOf("status");
			const countsCount = countOf("counts");
			const ttftCount = countOf("ttft");
			const tpsCount = countOf("tps");
			const cacheHitCount = countOf("cacheHit");
			const sessionTimeCount = countOf("sessionTime");
			const costCount = countOf("cost");
			const lastCostCount = countOf("lastCost");
			const contextCount = countOf("context");

			const at = DEV_FIXTURE_ANCHOR;

			/* ---------- 余额：只听 balance ---------- */
			/* 没传场景时按 round 取模（旧契约，测试的 6 轮矩阵契约不变）；
			   传了就从第 1 种起、每点一次前进一种。
			   **点击时是 11 格**（见 DEV_BALANCE_CLICK_SCENES）：1~6 是最初的 6 种真实形态
			   （金额 / 百分比配额 / 积分 / USD / 积分制 / 不足一分钱），7~11 是五种分币种形态
			   （双币种 / 只有美元 / 某项为 0 / 两币种都有赠金 / 只有美元带赠金）。**不再有「完全查不到」那一格**
			   （ok:false ⇒ 两行横杠）—— 用户已明确不要演示横杠。
			   dashBalance 兜底路径保留，真实环境照样会走。
			   （原先这里还有一个 balanceClickScene 变量，取值后从未被读，已删。） */
			/* 两条路用**不同的格数**，别混：
			   · `scenes === null`（不传字段计数，测试用的旧契约）⇒ 按老契约 `DEV_BALANCE_ROUNDS`（6 轮）
			     取模，tests 的 6 轮矩阵断言钉着它；
			   · 点余额气泡那一路 ⇒ 走 `DEV_BALANCE_CLICK_SCENES`（11 格），每点一次换一格。
			   **两者故意不同**：老契约（6 轮）只服务于 `scenes === null` 那条路径，
			   点击路径按 11 格走，1~6 的原形态和 7~11 的分币种形态才都能点到。 */
			const balanceRound = scenes === null
				? ((value - 1) % DEV_BALANCE_ROUNDS) + 1
				: (balanceCount % DEV_BALANCE_CLICK_SCENES) + 1;
			/* ---------- 轮次/步数/工具形态：只听 counts ---------- */
			/* counts 5 格，**全部有数据**（横杠那格已按用户要求删掉）：
			   0 正常 / 1 **技能 30 条**（多列 + 逐档加行）/ 2 压缩 20 条（列表滚动）/
			   3 工具 0 条（子视图里一行占位，但**底栏本身仍有轮次步数**，不是横杠）/
			   4 技能 6 条且同时带 * 与 + 两种角标。
			   工具形态本身有 5 档（DEV_BUBBLE_SCENES），与上面不是一一对应，仍按 counts 取模轮换。 */
			const countsScene = countsCount % DEV_COUNTS_SCENES;
			const toolRound = scenes === null
				? ((value - 1) % DEV_TOOL_ROUNDS) + 1
				: (countsCount % DEV_BUBBLE_SCENES) + 1;
			const toolCounts = countsScene === 3 ? {} : devToolCounts(toolRound);
			let toolCalls = 0;
			Object.keys(toolCounts).forEach((name) => { toolCalls += toolCounts[name]; });

			/* counts 这一路的伪随机：轮次、步数、技能条数都从这里出。
			   **压缩不再单独随机条数** —— 见下面 compacts 生成处的说明。 */
			const countsNext = devRandom(devSeedOf(2, countsCount));
			/* 轮次与步数**永远有值**：横杠那一格删掉之后，`segmentView` 的 `!(stats.steps > 0)`
			   分支在开发模式里不再被触发（它作为兜底仍然留着）。 */
			const turns = devRandInt(countsNext, 3, 48);
			const steps = devRandInt(countsNext, turns + 2, turns * 9 + 12);
			const turnNo = devRandInt(countsNext, 1, turns);
			const turnSteps = devRandInt(countsNext, 1, 9);
			/* 第 1 格 30 条技能（多列 + 逐档加行）、第 4 格 6 条但两种角标都在 */
			const skillCount = countsScene === 1 ? DEV_SKILL_NAMES.length
				: (countsScene === 4 ? 6 : devRandInt(countsNext, 2, 5));
			/* 第 0 格：压缩 20 条 —— 超过列表的半屏高度上限，点进去要能滚 */
			const compactTotal = countsScene === 0 ? 20 : devRandInt(countsNext, 2, 4);

			/* ---------- 首字：只听 ttft ---------- */
			/* 2 格，都有数据：0 正常 / 1 极端慢（2 次共 68000ms ⇒ 平均 34s，单次 30 秒以上） */
			const ttftScene = ttftCount % DEV_TTFT_SCENES;
			const ttftNext = devRandom(devSeedOf(3, ttftCount));
			const ttftSteps = ttftScene === 1 ? 2 : devRandInt(ttftNext, 2, 30);
			const ttftMs = ttftScene === 1 ? 68000 : devRandInt(ttftNext, ttftSteps * 300, ttftSteps * 9000);
			const turnTtftMs = devRandInt(ttftNext, 400, 14000);
			const fastestTtft = devRandInt(ttftNext, 300, 1600);
			const slowestTtft = ttftScene === 1 ? 34000 : devRandInt(ttftNext, 2500, 42000);

			/* ---------- 速度：只听 tps ---------- */
			/* 2 格，都有数据：0 正常 / 1 个位数速度（1200 tokens / 200s = 6 t/s） */
			const tpsScene = tpsCount % DEV_TPS_SCENES;
			const tpsNext = devRandom(devSeedOf(4, tpsCount));
			const decodeMs = tpsScene === 1 ? 200000 : devRandInt(tpsNext, 20000, 2100000);
			const decodeTokens = tpsScene === 1 ? 1200 : devRandInt(tpsNext, 5000, 520000);
			const fastestTps = tpsScene === 1 ? 9 : devRandInt(tpsNext, 60, 180);
			const slowestTps = tpsScene === 1 ? 6 : devRandInt(tpsNext, 3, 40);
			const turnDecodeMs = devRandInt(tpsNext, 300, 30000);
			const turnDecodeTokens = devRandInt(tpsNext, 20, 3600);

			/* ---------- 命中率：只听 cacheHit ---------- */
			/* 3 格，都有数据：0 正常 / 1 顶到 99.99% 封顶 / 2 一次都没命中（0%） */
			const hitScene = cacheHitCount % DEV_CACHEHIT_SCENES;
			const hitNext = devRandom(devSeedOf(5, cacheHitCount));
			let usage;
			if (hitScene === 1) {
				/* 未命中只留 1 个 token：比例 99.99999…%，被 Math.min(99.99, …) 压到封顶值 */
				usage = { uncachedInputTokens: 1, cacheReadTokens: 8000000, cacheWriteTokens: 0, outputTokens: 120000 };
			} else if (hitScene === 2) {
				/* 命中为 0：分母全落在未命中那一侧，比例正好 0% */
				usage = { uncachedInputTokens: 900000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 120000 };
			} else {
				usage = {
					uncachedInputTokens: devRandInt(hitNext, 20000, 1800000),
					cacheReadTokens: devRandInt(hitNext, 200000, 26000000),
					cacheWriteTokens: devRandInt(hitNext, 0, 460000),
					outputTokens: devRandInt(hitNext, 30000, 2400000)
				};
			}

			/* ---------- 总用时：只听 sessionTime ---------- */
			/* 3 格，都有数据：0 分钟级 / 1 超过 1 小时（4500000ms = 1h15m）/ 2 不足一分钟（42000ms = 42s） */
			const timeScene = sessionTimeCount % DEV_SESSIONTIME_SCENES;
			const timeNext = devRandom(devSeedOf(6, sessionTimeCount));
			const llmMs = timeScene === 1 ? 3000000 : devRandInt(timeNext, 60000, 2400000);
			const toolMs = timeScene === 1 ? 900000 : devRandInt(timeNext, 12000, 900000);
			const durationMs = timeScene === 1 ? 4500000
				: (timeScene === 2 ? 42000 : llmMs + toolMs + devRandInt(timeNext, 30000, 2600000));

			/* ---------- 上下文占用：只听 context ---------- */
			/* 点一次 context 前进一格：第 0 格是进开发模式立刻看到的常规态，1~5 格是各极端。
			   占用百分比、缺口算不算得出、有没有窗口，**三样都从同一张表出** ——
			   各自随机的话很容易撞出「0% 却算得出缺口」「缺窗口却画着占用」这种自相矛盾的组合，
			   而开发模式的意义恰恰是每种形态都能被如实地看一眼。 */
			const ctxScene = DEV_CONTEXT_SCENARIO[contextCount % DEV_CONTEXT_SCENES];
			const ctxNext = devRandom(devSeedOf(9, contextCount));
			/* 占用率直接从 percent 反算成 token 数（0% 就是真的一个 token 都没占）。
			   这里**不再判「有没有窗口」**：场景表 7 格全都带 percent，而「缺 contextWindow ⇒
			   dashMeter 空环 + 横杠」那一格已按用户要求删掉 —— 留着那个判断只会恒为 true，
			   属于死分支（审查报告 2-3 条）。dashMeter 本身作为兜底仍留在 meterView 里。 */
			const projectedTokens = Math.round(DEV_CONTEXT_WINDOW * ctxScene.percent / 100);
			/* 分项三段之和必须等于总占用：小占用时先给每段封顶（总占用的三分之一），
			   否则 0% 那格会算出负数消息段，圆环与分项气泡立刻自相矛盾。 */
			const segmentCap = Math.floor(projectedTokens / 3);
			const systemTokens = projectedTokens === 0 ? 0 : Math.min(devRandInt(ctxNext, 1200, 4200), segmentCap);
			const toolsTokens = projectedTokens === 0 ? 0 : Math.min(devRandInt(ctxNext, 4500, 22000), segmentCap);
			const messageTokens = Math.max(0, projectedTokens - systemTokens - toolsTokens);

			/* ---------- 总计：只听 cost；本轮：只听 lastCost ---------- */
			/* lastCost 3 格，**三格都有金额**（横杠那格已删）：
			   0 有调用（正常） / 1 正在跑但本轮还没有调用（active 分支，显示 ¥0.00）/
			   2 空闲、显示最近一轮。
			   `turnKey` 跟着 lastCost 计数走：否则「本轮只增不减」的下限会把上一格的大数字
			   顶住，¥0.00 那条分支永远出不来（下限的作废条件就是换轮）。
			   第 1 格要连 sessionUsage.current.calls 一起清空 —— 留着一条就一定能算出金额，
			   ¥0.00 那条分支永远到不了（见 devSessionUsageFixture 的 turnEmpty）。 */
			const lastCostScene = lastCostCount % DEV_LASTCOST_SCENES;
			const devRunning = lastCostScene === 1;
			const devTurnKey = "dev-turn-" + String(lastCostScene);
			/* 第 1 格「在跑但还没调用」要求本轮用量为空 */
			const devTurnEmpty = lastCostScene === 1;

			/* cost 3 格，**三格都有金额显示**（横杠那格已删）：
			   0 正常（队友也并入）/ 1 队友不并入（看总计只算本会话）/ 2 金额暴涨（长会话极端）。
			   「算不出价」那条兜底（held.cost === null ⇒ ¥-）仍然留着，只是不再演示。 */
			const costScene = costCount % DEV_COST_SCENES;
			const subSessionZeroed = costScene === 1;
			const sessionUsage = devSessionUsageFixture(costCount, lastCostCount, turnNo, devTurnEmpty);

			/* ---------- 活跃总览：只听 status ---------- */
			/* status 2 格，**都有数据**（"整块查不到"那两格已删）：
			   0 低谷 + 数据齐全 / 1 高峰 + 数据齐全。 */
			const statusScene = statusCount % DEV_STATUS_SCENES;
			const peakNow = statusScene === 1;
			/* 假「现在」：月历、年条、峰谷文字、总用时 elapsed **必须同源**。
			   用真实 `Date.now()`（at）去生成月历、却用假 now 去算「今天」的话，两边会跨月：
			   月历落在真实当月、todayKey 落在假 now 那个月，于是 `day.date > todayKey`
			   永远不成立 —— 月热力图与年条那两个"未来日"灰阶在开发模式里一天都看不到。
			   开发模式的意义就是每种形态都能被看一眼，所以统一取 devNowAt（同一个峰谷档）。 */
			const dailyNow = devNowAt(peakNow);
			const daily = devDailyFixture(dailyNow, statusCount);

			/* 轮次项气泡那三行：压缩固定两条（自动 + 手动，展示契约），技能条数听 counts */
			const skillPool = [
				{ name: "i-have-adhd", manual: true },
				{ name: "cangjie-skill", manual: false },
				{ name: "ponytail", manual: false },
				{ name: "deepseek-harness", manual: false },
				{ name: "sub-capability-demo", manual: false, sub: true }
			];
			/* 技能列表：**第 1 格 30 条**（触发多列 + 逐档加行）、**第 4 格 6 条**且两种角标都在，
			   其余格沿用原来那 2~5 条的小池子。
			   这里必须取 DEV_SKILL_NAMES（30 条名字池）而不是下面那个只有 5 条的 skillPool：
			   5 条无论怎么 slice 都凑不出 30 条 —— 那正是旧代码「30 条那格永远出不来」的根因
			   （旧条件是 `=== 3 || === 5`，而 countsScene 只可能是 0~4，5 永不成立，
			   而 count 为 30 的第 1 格又落到了 `skillPool.slice(0, 30)`，被截成 5 条）。
			   变量名不能叫 skillList —— 那是同名的列表构造函数，遮蔽了会静默改掉语义。 */
			const devSkills = countsScene === 1 || countsScene === 4
				? DEV_SKILL_NAMES.slice(0, skillCount).map((name, index) => ({
					name: name,
					/* 第 4 格：隔三个标一种来源，`名字*` 与 `名字+` 都能看到 */
					manual: countsScene === 4 ? index % 3 === 0 : index % 5 === 1,
					sub: countsScene === 4 ? index % 3 === 1 : index % 5 === 3
				}))
				: skillPool.slice(0, skillCount);

			/* 队友两段（几处刻意归零，各自只服务一个形态，都不动别人的那份）：
			   · cost 第 1 格「一条都算不出价」—— 队友金额一进账本就会把 priced 置 true，
			     不归零就永远走不到横杠；第 2 格「队友不并入」同样清零。
			   · lastCost 第 1 格「正在跑但本轮没调用」要 ¥0.00、第 3 格要横杠 ——
			     两者都要求本轮队友金额为 0，否则活分支会直接把队友那笔显示出来。
			   · ttft / tps / cacheHit 的「没数据」与「极端值」格：这三个段都是
			     **本会话 + 队友**合并后再算的（mergedSessionStats / billedInputTokens + sub），
			     本会话那一半清零了，队友那份仍会把结果抬起走 —— 横杠与个位数速度因此永远出不来。
			     所以按字段只清**它自己依赖的那几项**（ttft 组 / decode 组 / tokens 组互不重叠），
			     避免"点首字却把速度也改了"这种串扰。 */
			const subagent = devSubagentFixture("dev-" + String(value), devSeedOf(10));
			const zeroCostOf = (slice) => {
				slice.total.cost = 0;
				slice.total.costByCurrency = { CNY: 0 };
				slice.children.forEach((one) => { one.cost = 0; });
			};
			if (subSessionZeroed === true) zeroCostOf(subagent.session);
			/* 只清「在跑但还没调用」那一格（lastCost 第 1 格）：要把 ¥0.00 显示出来，
			   本轮队友那份金额必须是 0，否则活分支会直接把队友那笔显示成金额。
			   （原来还有第 3 格「算不出价 ⇒ 横杠」，那格已按用户要求删掉。） */
			if (lastCostScene === 1) zeroCostOf(subagent.turn);
			/* 队友的 stats 两段都在 session 那份里（subagentStatsOf 只读 session.total.stats） */
			const subStats = subagent.session.total.stats;
			if (ttftScene !== 0) {
				subStats.ttftMs = 0;
				subStats.ttftSteps = 0;
			}
			if (tpsScene !== 0) {
				subStats.decodeMs = 0;
				subStats.decodeTokens = 0;
			}
			/* 命中率：两个极端格都要把队友那份也清掉，否则合并后的比例永远到不了 0 / 99.99：
			   第 1 格要封顶（队友输入会把比例拉回常态）、第 2 格要命中为 0
			   （队友的 cacheRead 会把它抬起来）。 */
			if (hitScene === 1 || hitScene === 2) {
				subagent.session.total.tokens.cacheRead = 0;
				if (hitScene === 1) {
					/* 封顶那一格必须一个未命中 token 都不留 —— 分母只靠本会话那 1 个 */
					subagent.session.total.tokens.input = 0;
					subagent.session.total.tokens.cacheWrite = 0;
				}
			}

			return {
				/* 余额：6 种形态轮换（**不再有 ok:false 那格**，横杠不演示）。
				   dashBalance 兜底仍在 client.js 里，真实环境查不到余额时照旧用。 */
				balance: devBalanceFixture(balanceRound),
				/* 官方 sessionStats：底栏的轮次/步数、首字平均、综合速度、总用时都读它 */
				stats: {
					turns: turns, steps: steps,
					ttftMs: ttftMs, ttftSteps: ttftSteps,
					decodeMs: decodeMs, decodeTokens: decodeTokens,
					toolMs: toolMs, llmMs: llmMs
				},
				/* 官方 tokenUsage：综合命中率的分母 */
				usage: usage,
				sessionUsage: sessionUsage,
				timing: {
					samples: ttftSteps,
					fastestTtft: { value: fastestTtft, at: at - 1200000, model: "deepseek-flash" },
					slowestTtft: { value: slowestTtft, at: at - 240000, model: "deepseek-flash" },
					fastestTps: { value: fastestTps, at: at - 1200000, model: "deepseek-flash" },
					slowestTps: { value: slowestTps, at: at - 240000, model: "deepseek-flash" },
					/* 本轮轮号跟着 lastCost 走：它一变「本轮」的粘性下限就作废 */
					turn: sessionUsage.turn,
					turnTtftMs: turnTtftMs,
					turnTtftSamples: 1,
					turnDecodeMs: turnDecodeMs,
					turnDecodeTokens: turnDecodeTokens
				},
				/* 上下文占用：官方 contextPressure / contextBreakdown + 本插件折的 capacity。
				   capacity 照 host 的 sessionCapacitySchema（在 lib/index.js，就是 .strict() 那段）给全三个字段 ——
				   少一个 updatedAt 的话真实投影过不了校验，假数据也要同一套形状。
				   这里**只保留「有窗口」这一种形态**：`contextOccupancy` 见到窗口缺失就返回 null、
				   圆环退回空环 + 横杠，而那个形态用户明确不要（「都没数据，我看得出来什么？」）。
				   兜底代码仍在 meterView / dashMeter 里（真实环境会话刚发出时照样会走），
				   只是开发模式不再主动演示它。 */
				pressure: { projectedTokens: projectedTokens, pressureTokens: projectedTokens, contextWindow: DEV_CONTEXT_WINDOW },
				breakdown: { systemTokens: systemTokens, toolsTokens: toolsTokens, messageTokens: messageTokens },
				/* 缺 maxOutputTokens ⇒ compactPercent 返回 null ⇒ 圆环不挖缺口、横条不压竖线。
				   其余格给齐三字段，缺口就能算出来（1M 窗口 / 384K 输出 → 55.0%，与实机一致）。 */
				capacity: ctxScene.notchKnown === true
					? { contextWindow: DEV_CONTEXT_WINDOW, maxOutputTokens: DEV_CONTEXT_MAX_OUTPUT, updatedAt: null }
					: { contextWindow: DEV_CONTEXT_WINDOW, updatedAt: null },
				/* 轮次项气泡那三行：压缩 / 技能注入 / 工具调用。
				   压缩的**条数与列表必须是同一个数据源**：用户实机看到「上下文压缩 4」点进去只有 2 条，
				   因为条数是独立随机的、列表是写死两条。现在先按 compactTotal 生成数组，
				   再让 `compactCount` 直接取数组长度 —— 数字与点开的条数**不可能**再对不上。
				   展示契约（必须同时存在，不能因为"随机"被切掉）：
				     · 至少一条自动压缩（带轮号 turn/step，manual:false）
				     · 至少一条手动压缩（轮间压缩，turn:null + afterTurn，manual:true）
				   所以 compactTotal 下限是 2；多出来的按序补自动压缩，轮号往前推。 */
				progress: (() => {
					const compacts = [];
					const total = Math.max(2, compactTotal);
					for (let i = 0; i < total; i += 1) {
						if (i === total - 1) {
							/* 最后一条固定是「手动 / 轮间压缩」：turn=null，落点靠 afterTurn */
							compacts.push({ turn: null, step: null, afterTurn: Math.max(1, turnNo - 1), manual: true });
						} else {
							/* 其余是自动压缩：轮号从前往后推，步号取本轮步数 */
							compacts.push({
								turn: Math.max(1, turnNo - (total - 1 - i)),
								step: turnSteps,
								afterTurn: null,
								manual: false
							});
						}
					}
					return {
						turn: turnNo, turnSteps: turnSteps,
						toolCalls: toolCalls, toolCounts: toolCounts,
						skills: devSkills,
						globalInstruction: "AGENTS.md",
						/* **直接取数组长度**：一个数据源，行数与点开后的条数永远一致 */
						compactCount: compacts.length,
						compactStep: compacts[compacts.length - 1].step,
						compacts: compacts
					};
				})(),
				/* 总用时（desktopStatusbarActiveTime）：空闲态，只有累计值、没有进行中的基线。
				   第 1 格 durationMs 为 0 ⇒ segmentView 先看时间窗（0 不算），
				   再退回 timeline；那条路也要一起断（见 devSrc.timeline），否则横杠出不来。 */
				timeRange: { turns: durationMs, since: null, steps: 0, stepSince: null },
				daily: daily,
				/* 队友那两段**不随任何字段变**：它同时进「总计」与「本轮」，一旦跟着变就会
				   让点别的气泡时金额也动 —— 那正是用户反对的串扰。
				   （cost 第 1/2 格与 lastCost 第 1/3 格例外，各自只清金额、不动令牌，见上） */
				subagent: subagent,
				sessionModel: { provider: "deepseek-official", model: "deepseek-flash", updatedAt: at },
				/* 圆环状态色：**只听 context 计数**，与占用百分比同表同格。
				   为什么必须由 fixture 给：真实判定读的是 running / pendingApprovals /
				   lastAgentError / 分层在跑，这几样在开发模式里仍是真实值、不会因为点圆环而变 ——
				   于是各档状态色在开发模式里永远只显示当前那一种，用户看不到其余的。
				   取值域就是 contextRing 认得的那六个字符串；给别的值只会退回默认灰。 */
				agentState: ctxScene.state,
				/* **不是投影，是 StatusBar 那几个 state 的开发模式替代值**，所以单独收在一个键里，
				   不跟上面那些"与投影同名"的字段混在一起（混了以后没人分得清哪个能给 projected() 用）。
				   每一项的用途见 StatusBar 里 srcNow / srcTimeline / … 那几行。 */
				devSrc: {
					/* 分层在跑的**开发模式替代值**：让蓝档 / 紫档连弧长都能被点到。
					   `ringPercentOf` 在 agentState 是 teamRunning / deepRunning 时会优先读它，
					   所以那两格必须带上对应百分比（见 DEV_CONTEXT_SCENARIO 最后两格）。
					   其余格给全 0 / null ⇒ ringPercentOf 原样退回 Lead 自己的占用，与真实环境一致。
					   形状与 host 那四个字段同名，免得两套名字对不上。
					   **放在 devSrc 里而不是顶层**：`devFixture` 的顶层键数被既有测试逐个数着
					   （13 个投影键 + 2 个开发模式专用键），而 devSrc 本来就是"开发模式专用替代值"
					   的容器，语义正好。 */
					agentTiers: {
						team: typeof ctxScene.teamRunning === "number" ? ctxScene.teamRunning : 0,
						deep: typeof ctxScene.deepRunning === "number" ? ctxScene.deepRunning : 0,
						teamPercent: typeof ctxScene.teamContextPercent === "number" ? ctxScene.teamContextPercent : null,
						deepPercent: typeof ctxScene.deepContextPercent === "number" ? ctxScene.deepContextPercent : null
					},
					/* status 的峰谷与 sessionTime 的 elapsed 都读 now。真实 now 每秒在跳，
					   永远落在"此刻"那个时段，「高峰」那一支几乎点不到；假 now 从同一张
					   时段表里取，峰谷与柱状图因此自洽。
					   **必须与上面的 dailyNow 是同一个值**：气泡里"今天"那根柱/那一格
					   靠 `dateKeyOf(src.now)` 与月历数据比大小，两边不同源就一定是跨月的
					   （一个真实当月、一个假当月），未来日灰阶因此永远出不来。 */
					now: dailyNow,
					/* 开发模式没有真实会话节点可折：给 null，让「时间窗算不出 + timeline 也算不出」
					   这条横杠路径真的走得通。 */
					timeline: null,
					/* 只服务「本轮正在跑但还没调用」那一格（那段判定读的就是这三样） */
					running: devRunning,
					partial: null,
					runningCalls: [],
					/* 本轮用量与"这份用量属于哪一轮"：给确定值，形态才可复现。
					   第 1 格（在跑但还没调用）与第 3 格（算不出价）都必须是 null：
					   第 1 格若留着用量，segmentView 就会走「本轮正在进行中的精确口径」算出金额，
					   ¥0.00 那条 active 分支永远到不了；第 3 格要的就是整份拿不到 ⇒ 横杠。 */
					turnUsage: devTurnEmpty === true
						? null
						: {
							input: sessionUsage.current.input, cacheRead: sessionUsage.current.cacheRead,
							cacheWrite: sessionUsage.current.cacheWrite, output: sessionUsage.current.output
						},
					turnUsageTurn: sessionUsage.turn,
					/* 换格即换轮：粘性下限随之作废，横杠与 ¥0.00 才出得来 */
					turnKey: devTurnKey
				}
			};
		}

		const updateListeners = new Set();
		function subscribeUpdate(fn) {
			updateListeners.add(fn);
			return () => { updateListeners.delete(fn); };
		}
		function snapshotUpdate() { return updateState; }
		function setUpdateState(patch) {
			updateState = Object.assign({}, updateState, patch);
			updateListeners.forEach((fn) => { try { fn(); } catch (error) { /* 单个订阅者失败不影响其余 */ } });
		}
		function useUpdateState() {
			return react.useSyncExternalStore(subscribeUpdate, snapshotUpdate, snapshotUpdate);
		}

		/** 挂/撤导航项后面的胶囊；同一个单元格只留一个。 */
		function syncNavPill(cell, text) {
			const has = typeof cell.querySelector === "function" ? cell.querySelector(".dsb-nav-pill") : null;
			if (updateState.hasUpdate !== true) {
				if (has !== null && typeof has.remove === "function") has.remove();
				return;
			}
			/* 已经挂上就只更新文字。**必须先比值**：写 textContent 即使内容一样也会
			   替换文本节点、产生 childList 记录，而上面那个 observer 监听的正是
			   childList+subtree —— 不比较就会「写 → 触发 → 下一帧再写」一直空转。 */
			if (has !== null) {
				if (has.textContent !== text) has.textContent = text;
				return;
			}
			const pill = document.createElement("span");
			pill.className = "dsb-nav-pill";
			pill.textContent = text;
			if (typeof cell.appendChild === "function") cell.appendChild(pill);
		}

		/**
		 * 问宿主端 registry 上有没有更新版（宿主启动时自检一次，结果挂在 /api/version 上）。
		 * 查不到（离线、被墙、自检还没跑完）返回 null，界面保持不显示 —— 宁可少显示，
		 * 也别挂一个点不开的假提示。
		 */
		function loadUpdateFlag() {
			/* 宿主是拿 ?current= 里的版本来比大小的；不带就等于没版本可比，会被当成「没有新版」。 */
			return window.fetch(VERSION_URL + "?current=" + encodeURIComponent(VERSION), { cache: "no-store" })
				.then((response) => (response.ok === true ? response.json() : null))
				.then((payload) => payload === null || payload === undefined ? null : {
					hasUpdate: payload.hasUpdate === true,
					latest: typeof payload.latest === "string" && payload.latest.length > 0 ? payload.latest : null
				})
				.catch(() => null);
		}

		/** 从更新结果里抠出人能看懂的原因；拿不到就给空串。 */
		function reasonOf(result) {
			const raw = result === null || result === undefined ? null : result.reason;
			return typeof raw === "string" && raw.length > 0 ? raw : "";
		}

		/**
		 * 客户端侧失败上报：把「浏览器里到底怎么失败的」写成一条日志交给 host。
		 *
		 * 宿主侧失败它自己会记（`update: 结果 {...}`），但**客户端**这边的失败
		 * （fetch 被代理拦、响应解不出来、网络断）宿主完全看不见 —— 用户点完只看到
		 * 「更新失败」，日志里没有任何痕迹，想拿日志问 AI 也无从下手。
		 *
		 * 只发诊断字段、不改任何状态；任何异常都静默（日志补不上不能连累界面）。
		 */
		function reportUpdateFailure(info) {
			try {
				window.fetch(UPDATE_FAILURE_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(info)
				}).catch(() => { /* 静默 */ });
			} catch (error) {
				/* 静默 */
			}
		}

		/**
		 * 一键更新：调**本插件自己的** host 路由，由它自己跑 pnpm 把新版本装上。
		 *
		 * 为什么不用 DSH 官方的 `ctx.remote.pluginManager.installBundle`：
		 *   1. 那个服务由「插件管理器」这个**别的插件**提供。没装它的 profile 上，
		 *      读 `ctx.remote` 会直接抛错（DSH 的依赖注入对未声明服务就这个行为），
		 *      异常冒出 onClick 没人接 —— 界面表现就是「点了完全没反应」。
		 *   2. 它跑裸 `pnpm add pkg@版本`，会被 pnpm 11 的 24 小时发布年龄策略拦下
		 *      （报 NO_MATURE_MATCHING_VERSION），新版本刚发布时装不上。
		 *
		 * 所以更新必须由插件自己完成：host 端先把这个精确版本写进 profile 的
		 * `minimumReleaseAgeExclude` 放行，再用精确版本安装。
		 *
		 * **装完要重启 DSH，光刷新页面不生效**：插件包元数据（含 client.js 的 revision）
		 * 在 DSH 里「缓存至重启」（见 dsh-client-modules 的说明），刷新只会重新拉同一份
		 * 旧 bundle。官方插件管理器也是这个口径（「已安装，下次启动后加载」）。
		 * 按钮文案据此提示重启，而不是刷新。
		 */
		function startPluginUpdate() {
			/* 开发模式下只演示：不真实安装（见 runDevPreview） */
			if (devMode === true) { runDevPreview(); return; }
			if (updateState.latest === null || updateState.busy === true) return;
			const target = updateState.latest;
			/* 失败时记下"这个版本已经试过了"：按钮点一下回到可重试文案时要用它。 */
			setUpdateState({ busy: true, note: null, reason: null, failedTarget: null });
			const startedAt = Date.now();
			/* 失败收敛到一处：状态 + 日志。三条失败路径（响应解不出 / 应答 ok:false / 网络异常）
			   都走这里，保证每一条都在日志里留下同样的字段。 */
			const fail = (reason, extra) => {
				const info = Object.assign({
					reason: reason,
					target: target,
					current: VERSION,
					at: Date.now(),
					elapsedMs: Date.now() - startedAt
				}, extra === undefined ? {} : extra);
				reportUpdateFailure(info);
				setUpdateState({ busy: false, note: "failed", reason: reason, failedTarget: target });
			};
			window.fetch(SELF_UPDATE_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ version: target })
			}).then((response) => {
				/* fetch 对 4xx/5xx 是 **resolve** 不是 reject：必须自己看状态码，
				   否则 403（跨站防护）/ 409（正在更新）/ 500 都会被当成"响应解不出来"。 */
				if (response.ok !== true) {
					fail("http-error", { stage: "request", httpStatus: response.status });
					return null;
				}
				return response.json();
			})
				.then((payload) => {
					/* null 有两种来源：上面的 HTTP 错误（已处理过）或 JSON 解析失败 */
					if (payload === null || payload === undefined) return;
					const ok = payload.ok === true;
					if (ok === true) {
						setUpdateState({ busy: false, note: "done", reason: null, failedTarget: null });
						return;
					}
					/* 宿主明确回了失败原因（release-age / verify-failed / pnpm-failed…）：
					   宿主自己已经记过日志，这里补的是"客户端看到的那一份"，两边能对上。 */
					fail(reasonOf(payload), { stage: "host", detail: JSON.stringify(payload).slice(0, 300) });
				})
				.catch((error) => {
					const detail = error !== null && error !== undefined && typeof error.message === "string"
						? error.message
						: String(error);
					fail("network", { stage: "request", detail: detail });
				});
		}

		/**
		 * 开发模式下的一次点击：纯本地状态机，走完「更新中 → 已更新 → 更新失败 → 空闲」。
		 *
		 * 用真的 setUpdateState / 真的渲染分支，所以看到的动效、文案、按钮禁用行为
		 * 与真实更新**完全一致**；唯一的区别是不发请求、不安装。
		 */
		function runDevPreview() {
			const phase = updateState.note;
			if (updateState.busy === true) return;
			if (phase === null) {
				/* ① 更新中：亮起那三个点 */
				setUpdateState({ busy: true, note: null, reason: null, latest: DEV_VERSION });
				devTimer = setTimeout(() => {
					devTimer = null;
					/* ② 已更新 */
					setUpdateState({ busy: false, note: "done", reason: null });
				}, DEV_BUSY_MS);
				return;
			}
			if (phase === "done") {
				/* ③ 更新失败：走真实失败那条显示路径 */
				setUpdateState({ busy: false, note: "failed", reason: DEV_FAIL_REASON });
				return;
			}
			/* ④ 回到空闲，可以再点一遍 */
			setUpdateState({ busy: false, note: null, reason: null, latest: DEV_VERSION });
		}

		/** 开发模式里「更新中」那一步的定时器；退出开发模式或卸载时要清掉。 */
		let devTimer = null;

		/**
		 * 「更新失败」那一态下点按钮：**只把状态退回可重试，不直接重试**。
		 *
		 * 用户原话：「"更新失败"还能点啊，点完就回到，更新X.X.X版本这个按钮，
		 * 然后用户就会再点一次更新来重试更新。」
		 * ——所以这里是"点一下退回去、再点一下才真装"，不是"点一下就重装"：
		 * 前者用户看得见自己点过了、也能先确认网络/版本再动手；后者会让人以为
		 * 按钮没反应（毕竟失败→重装→再失败 的往返太快）。
		 *
		 * 退回后的文案是「更新到 X.X.X 版本」，那个版本号取失败时记下的 failedTarget
		 * （比 updateState.latest 更可靠：latest 若被后台刷新改掉，文案会跳到别的版本）。
		 */
		function dismissUpdateFailure() {
			const target = updateState.failedTarget === null || updateState.failedTarget === undefined
				? updateState.latest
				: updateState.failedTarget;
			setUpdateState({ busy: false, note: null, reason: null, latest: target, failedTarget: null });
		}

		/**
		 * 更新按钮的点击入口：按当前状态分派。
		 *   · 失败态 → 只退回可重试（不重试，见 dismissUpdateFailure）
		 *   · 其余   → 真的发起一次更新
		 * 更新中（busy）按钮本来就是 disabled，走不到这里。
		 */
		function onUpdateClick() {
			if (updateState.note === "failed") {
				dismissUpdateFailure();
				return;
			}
			startPluginUpdate();
		}

		/** 开发模式当前是否开着（给测试与自检读）。 */
		function isDevMode() {
			return devMode;
		}

		/**
		 * 开关开发模式。
		 * 打开时把状态摆成「有新版本可更新」的样子（但版本号是假的一眼可辨），
		 * 关闭时清掉定时器并恢复成「没有更新」。
		 *
		 * 进入时做两件事：
		 *   · `devRound` +1（退出**不清零**）：只作为"这是第几次进开发模式"的记录；
		 *   · **所有字段计数归零**：一次开发模式就是一次「从头看一遍」，
		 *     上次点到第几种不影响这次（用户明确要求重置）。
		 * 退出时也把字段计数清一遍，保证下次进来从第 1 组开始、且不会残留到真实界面。
		 */
		function setDevMode(on) {
			const was = devMode;
			devMode = on === true;
			if (devMode === true && was !== true) {
				devRound += 1;
				resetDevFieldScenes();
			}
			if (devMode !== true) resetDevFieldScenes();
			/* 通知底栏：假数据（含 sessionId 换成 dev-<round>-c<cost计数>、各字段计数归零）
			   必须立刻生效 / 撤销。 */
			publishDev();
			if (devTimer !== null) { clearTimeout(devTimer); devTimer = null; }
			if (devMode === true) {
				setUpdateState({ hasUpdate: true, latest: DEV_VERSION, busy: false, note: null, reason: null });
			} else {
				/* 关掉时**同步**把演示相关状态一次清干净：忙碌态、结论、演示版本、按钮可见性。
				   这几项都先落到「没有更新」，再去问真实的 registry 结果 —— 反过来（先等网络）
				   会让按钮在关掉之后还多显示一会儿，看起来像没关掉。
				   清 busy 尤其必要：演示可能正停在「更新中」，只撤按钮不撤 busy，
				   界面会留在一个永远转下去的「正在更新中」。 */
				setUpdateState({ hasUpdate: false, latest: null, busy: false, note: null, reason: null });
				loadUpdateFlag().then((result) => {
					if (result !== null) setUpdateState(result);
				});
			}
		}

		/**
		 * 版本号被点了一下。两种手势，取决于「这一版解锁过没有」：
		 *
		 *   · **解锁过**（localStorage 里记的版本 === 当前 VERSION）→ 单击直接切换开关。
		 *     作者改这一块的界面时会反复进出，每次都连点 5 下太折腾。
		 *   · **没解锁过**（首次、换了版本、或 localStorage 写不进去）→ 连点 DEV_CLICKS 次，
		 *     成功后把当前 VERSION 记下来。普通用户装了这插件，界面上不该多出一个面向
		 *     作者的调试项；连点是常见的开发者模式手势：记得住、也不会被误触。
		 *
		 * 「记版本」而不是「记一个 true」：VERSION 一升级，旧记录自动失配 ⇒ 重新要求连点，
		 * 不需要任何迁移代码。两次点击间隔超过 DEV_CLICK_WINDOW_MS 就重新计数 ——
		 * 否则慢慢点 5 次也会进去。
		 *
		 * 纯同步：开发模式是主插件的一部分，没有任何"组件在不在"要问宿主 ——
		 * 入口只看这一次点击的手势。
		 *
		 * @returns {object} 供测试断言的计数快照
		 */
		function onVersionClick() {
			/* 解锁记忆读不出来（无痕模式抛错 / 从没写过）⇒ 按未解锁走，退化成"每次都连点" */
			if (devUnlockVersion() === VERSION) {
				devClickCount = 0;
				devClickAt = 0;
				setDevMode(devMode !== true);
				return { count: 0, on: devMode };
			}
			const now = Date.now();
			if (devClickAt !== 0 && now - devClickAt > DEV_CLICK_WINDOW_MS) devClickCount = 0;
			devClickAt = now;
			devClickCount += 1;
			if (devClickCount >= DEV_CLICKS) {
				devClickCount = 0;
				devClickAt = 0;
				const next = devMode !== true;
				setDevMode(next);
				/* 只在**进入**时记解锁（退出不记）：写失败（无痕模式）就静默，行为仍是每次连点 */
				if (next === true) rememberDevUnlock();
			}
			return { count: devClickCount, on: devMode };
		}

		/** 连点计数与最近一次点击时刻。 */
		let devClickCount = 0;
		let devClickAt = 0;

		/**
		 * 把设置导航里本插件那一项的前导图标换成 gauge。
		 * 定位方式是按导航文案匹配（DSH 没给导航项留 id 属性），匹配不到就什么都不做。
		 * 顺带在这项后面挂「发现新版本」胶囊 —— 加了胶囊后文案就不再等于标签，所以首次命中打个标记。
		 */
		function installNavIcon(getLabel, getPill) {
			const apply = () => {
				const label = getLabel();
				if (typeof label !== "string" || label.length === 0) return;
				const cells = document.querySelectorAll("nav button");
				for (let i = 0; i < cells.length; i += 1) {
					const cell = cells[i];
					const marked = typeof cell.getAttribute === "function" && cell.getAttribute(NAV_MARK) === "1";
					if (marked !== true && String(cell.textContent).trim() !== label) continue;
					if (marked !== true && typeof cell.setAttribute === "function") cell.setAttribute(NAV_MARK, "1");
					if (typeof getPill === "function") syncNavPill(cell, String(getPill()));
					if (cell.querySelector(".lucide-gauge") !== null) continue;   /* 已经换过 */
					const first = cell.firstElementChild;
					if (first === null || typeof first.tagName !== "string" || first.tagName.toLowerCase() !== "svg") continue;
					const box = document.createElement("span");
					box.innerHTML = NAV_ICON_SVG;
					const gauge = box.firstElementChild;
					if (gauge === null) continue;
					first.replaceWith(gauge);
				}
			};
			let scheduled = false;
			const schedule = () => {
				if (scheduled === true) return;   /* 面板每次挂载/切换只扫一帧 */
				scheduled = true;
				window.requestAnimationFrame(() => { scheduled = false; apply(); });
			};
			apply();
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			/* 版本状态一变就重挂一次胶囊：查完发现没新版（撤掉）、或有新版（挂上） */
			const stopWatch = subscribeUpdate(apply);
			/* 启动自检一次。卸载之后结果才到的话直接丢弃，别再往 DOM 里塞东西。
			   开发模式期间也要丢弃：它是模块级开关，用户可能在这次网络请求返回前就连点
			   进去了，此时真实结果会把演示状态冲掉 —— 胶囊还在、按钮却没了。 */
			let alive = true;
			loadUpdateFlag().then((result) => {
				if (alive !== true || result === null) return;
				if (devMode === true) return;
				setUpdateState(result);
			});
			return () => {
				alive = false;
				stopWatch();
				observer.disconnect();
			};
		}

		function installStyles() {
			if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') === null) {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-desktop-statusbar";
				tag.dataset.pluginCss = STYLE_TAG_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			return () => {
				const tag = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]');
				if (tag !== null) tag.remove();
			};
		}

		/** 该槽给的是 selector hook；包一层以保持"hook 调用顺序稳定"的语义。 */
		function pick(hook, selector, fallback) {
			if (typeof hook !== "function") return fallback;
			return hook(selector);
		}

		/** 优先用 layout effect（绘制前就把气泡摆好），环境没有时退回普通 effect。 */
		const useTipLayout = typeof react.useLayoutEffect === "function" ? react.useLayoutEffect : react.useEffect;

		/* ------------------------------------------------------------- 底栏组件 */
		function StatusBar(props) {
			const t = props.t;
			const useProjection = props.useProjection;
			const useSession = props.useSession;
			const realSessionId = props.sessionId;
			const cfg = useConfig();

			/* 开发模式：开着的时候整条底栏改吃假数据（见 devFixture）。
			   `devState.round` 与各字段计数都是**原始值**，给下面几个 effect 当依赖用 ——
			   依赖一个每次都新建的对象会让 effect 每帧重跑。

			   `devState.fields` 是**每字段独立计数**（{ status, counts, ttft, tps, cacheHit,
			   sessionTime, cost, lastCost, balance, context }）：点开哪个气泡就只推进哪个计数，
			   于是只有那个气泡的数据变。这正是用户要的「点一个，只变那一个」。 */
			const devState = useDevState();
			const devActive = devState.on === true;
			/* 各字段计数单独拎出来：effect 依赖数组要用原始值（不能依赖整个 fields 对象，
			   否则任何字段一变所有 effect 都重跑 —— 又回到"点一个全变"）。 */
			const devFields = devState.fields !== null && devState.fields !== undefined ? devState.fields : {};
			const devBalanceCount = devFields.balance;
			const devStatusCount = devFields.status;
			const devCostCount = devFields.cost;
			/* 假数据体量大（420 个工具名那档），按「是否开发模式 + 各字段计数」缓存一份：
			   底栏每秒重渲染一次，不缓存就是每秒重建一遍。 */
			const devData = react.useMemo(
				() => (devActive === true ? devFixture(devState.round, t, devState.fields) : null),
				[devActive, devState.round,
					devFields.status, devFields.counts, devFields.cacheHit, devFields.tps, devFields.ttft,
					devFields.sessionTime, devFields.lastCost, devFields.cost, devFields.balance, devFields.context]
			);
			/** 取一个投影：开发模式下用假值覆盖（只覆盖 fixture 里真的给了的键）。 */
			const projected = (name, real) => (devData !== null && devData[name] !== undefined ? devData[name] : real);

			const stats = projected("stats", useProjection("sessionStats"));

			const usage = projected("usage", useProjection("tokenUsage"));
			const sessionModel = projected("sessionModel", useProjection("desktopStatusbarModel"));
			const sessionUsage = projected("sessionUsage", useProjection("desktopStatusbarUsage"));
			const timeRange = projected("timeRange", useProjection("desktopStatusbarActiveTime"));
			/* 逐次调用的首字/速度极值（host 侧折出来的，官方 sessionStats 只有累计值） */
			const timing = projected("timing", useProjection("desktopStatusbarTiming"));
			/* 上下文占用直接读 DSH 自带的两个投影，跟官方那一行同源同口径 */
			const pressure = projected("pressure", useProjection("contextPressure"));
			const breakdown = projected("breakdown", useProjection("contextBreakdown"));
			/* 压缩点的两个入参（窗口 + 本次请求输出上限）由本插件从请求事件里折出来 */
			const capacity = projected("capacity", useProjection("desktopStatusbarCapacity"));
			/* 轮次项气泡那三行（上下文压缩 / 技能注入 / 工具调用）同样由本插件折 */
			const progress = projected("progress", useProjection("desktopStatusbarProgress"));
			/* 会话标识：开发模式下换成 `dev-<轮次>-c<cost计数>` —— applyTotalFloor / applyTurnFloor
			   都以它为界，换了就等于「换会话」，账本自动清空重算。
			   **必须带上 cost 计数**：只带 round 的话，点「总计」气泡时 round 不变，
			   applyTotalFloor 认为是同一会话、只结算"没见过的调用指纹"，而假数据时间戳固定
			   （DEV_FIXTURE_ANCHOR）⇒ 指纹全见过 ⇒ 一分钱都不会再加（用户实测的"总计点开不涨"）。
			   只带 cost 计数（不带别的字段计数）也很重要：点别的气泡时总计账本不能被重置，
			   否则就是反向串扰。 */
			const sessionId = devData !== null
				? "dev-" + String(devState.round) + "-c" + String(typeof devCostCount === "number" ? devCostCount : 0)
				: realSessionId;
			/* 设置页拿不到会话投影，把当前模型上报给 host，供设置页读取 */
			const reportedModel = sessionModel !== null && sessionModel !== undefined && typeof sessionModel.model === "string" && sessionModel.model.length > 0
				? sessionModel.model
				: null;
			const reportedProvider = sessionModel !== null && sessionModel !== undefined && typeof sessionModel.provider === "string" ? sessionModel.provider : null;
			react.useEffect(() => {
				/* 开发模式：假模型绝不报给 host —— 否则设置页会照着假数据改真实会话的「当前模型」，
				   而且开发模式要求一个真实请求都不发。 */
				if (devActive === true) return;
				if (reportedModel === null) return;
				window.fetch(ACTIVE_MODEL_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: reportedProvider, model: reportedModel })
				}).catch(() => { /* 上报失败不影响底栏 */ });
			}, [reportedModel, reportedProvider, devActive]);

			/* 价格库上报给 host：活跃总览的 cost 是 host 记账时算的，
			   它拿不到 localStorage，必须由这里把当前价格库送过去，
			   否则用户在设置页加/改的单价只对底栏生效（实测 2026-10-07）。
			   models 一变就重报；host 侧比对指纹后只结算"欠账"——
			   即当时没有单价、还没算钱的那部分用量，已经算好的历史费用不动。 */
			const reportedPrices = react.useMemo(() => JSON.stringify(cfg.models === undefined || cfg.models === null ? {} : cfg.models), [cfg.models]);
			react.useEffect(() => {
				/* 开发模式：一次真实请求都不发（verify-dev-mode ⑦ 盯着这条） */
				if (devActive === true) return;
				let models = null;
				try {
					models = JSON.parse(reportedPrices);
				} catch (error) {
					return;
				}
				if (models === null || Object.keys(models).length === 0) return;
				window.fetch(PRICES_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ models: models })
				}).then((response) => {
					/* 失败要说出来。原先只有 `.catch(() => {})`，而 fetch 对 4xx/5xx 是
					   **resolve** 不是 reject —— 上报被拒（如体积超限返回 400）时既不进
					   catch 也没人看 response，于是用户的价目表一直送不到 host。
					   后果分两种：**新产生**的用量会按内置官方价计费（不是用户填的价）；
					   只在自定义表里的模型则永远算不出钱、一直留在欠费明细里。
					   已算好的费用不受影响，也不会被改写 —— 那是既定语义。
					   底栏本身不受影响，所以只告警、不改界面。 */
					if (response.ok !== true) {
						console.warn("[dsh-desktop-statusbar] 价格库上报被拒 HTTP " + String(response.status) + "，host 会继续用内置参考价给新用量记账");
					}
				}).catch((error) => {
					console.warn("[dsh-desktop-statusbar] 价格库上报失败：" + String(error && error.message));
				});
			}, [reportedPrices, devActive]);

			const running = pick(useSession, (s) => s.running, undefined);
			const partial = pick(useSession, (s) => s.partial, undefined);
			const runningCalls = pick(useSession, (s) => s.runningCalls, undefined);
			const lastAgentError = pick(useSession, (s) => s.lastAgentError, undefined);
			const pendingApprovals = pick(useSession, (s) => s.pendingApprovals, undefined);
			const timeline = pick(props.useChat, (s) => s.timeline, undefined);
			const chatNodes = pick(props.useChat, (s) => (s.legacy === undefined || s.legacy === null ? undefined : s.legacy.nodes), undefined);

			const [now, setNow] = react.useState(() => Date.now());
			const [balance, setBalance] = react.useState(null);
			const [daily, setDaily] = react.useState(null);
			/* 子智能体（Agent Teams 队友）的用量汇总：host 按 parentSession 现算，异步取。
			   状态里带着"这份值属于哪个会话、哪一轮"（`nextSubagentState` 的契约，见那里的注释）：
			   同一轮里某次请求失败就沿用上一次成功的值，换了轮/换了会话一律清空重算，
			   界面上不出现任何提示文字。段落取值用 `subagentState.sessionPayload / turnPayload`。 */
			const [subagentState, setSubagentState] = react.useState(SUBAGENT_STATE_EMPTY);
			/* 队友里**还在跑**的分层情况（host 响应里的 `running` / `teamRunning` / `deepRunning` +
			   两级的占用百分比）。两个用途：
			   ① `all > 0` 时让时钟继续每秒跳 —— 主对话已经结束、但队友还在干活，
			      否则「总计」与队友数据会静止到下一个峰谷边界（可能几小时），
			      用户看到的症状是「必须点开总计气泡才刷新」；
			   ② 决定上下文圆环的颜色（Lead 绿 / 成员蓝 / 更深层紫）与弧长（那两级各自的占用）。
			   **合并成一个对象 state**：五个数放一起，一次 setState 收尾 —— 拆成五个
			   state 会让同一份响应触发五次重渲染，而底栏每秒本来就在重渲染。
			   单独一个 state 而不是塞进 subagentState：后者是两段取值的状态机，
			   形状被既有测试逐字段断言着（见 nextSubagentState 的契约），不该混进新字段。
			   **语义必须守住**：`all === null` 表示"这次没结论、保留旧值"；`all === 0` 是
			   真空闲、必须落下去（这是修过的真实缺陷：把"问不到"当 0 会让时钟降到省电档）。 */
			const [subagentTiers, setSubagentTiers] = react.useState(SUBAGENT_TIERS_EMPTY);
			const subagentRunning = subagentTiers.all;
			/* host 推出来的**本轮起点**（`turnStartMs`）+ 它属于哪个会话/哪一轮。
			   只在客户端自己折叠不出起点（或折叠出的是上一轮）时兜底用，主路径不碰它。
			   带 sessionId / turnKey 是为了换会话、换轮时自动失配 —— 复用 nextSubagentState
			   那套「归属对不上就作废」的判定思路，不另立一套。 */
			const hostTurnStartRef = react.useRef({ sessionId: null, turnKey: null, value: null });
			/* 「本轮」显示值的粘性下限盒子（同轮内只增不减，换轮作废）：一个可变盒子，
			   由 lastCost 段在渲染时更新，跨渲染靠这个 ref 留住（见 applyTurnFloor）。 */
			const lastCostHoldRef = react.useRef({ sessionId: null, turnKey: null, value: 0 });
			/* 「总计」的**增量式账本**（见 applyTotalFloor 的长注释）：
			   { sessionId, seen, cost, tokens, priced, subCostSettled, debts }。
			   一个可变盒子：段里渲染时按需把它推到最新，跨渲染靠这个 ref 留住累计值。
			   换会话时整份状态由 applyTotalFloor 自己清空，这里不必额外处理。 */
			const totalHoldRef = react.useRef({
				sessionId: null, seen: new Map(), cost: 0, tokens: null,
				priced: false, subCostSettled: 0, debts: new Map()
			});
			/* 点开「总计」气泡时 +1：强制重拉一次队友用量（别的触发条件都带 SUBAGENT_REFRESH_MS 节流） */
			const [subagentTick, setSubagentTick] = react.useState(0);
			const [tipId, setTipId] = react.useState(null);
			const [tipPos, setTipPos] = react.useState(null);
			/* 气泡里的下钻层：null = 根视图，数字 = 点开了第几行（会话数据那三行的子视图）。
			   换字段、收起气泡都要清掉，否则下次打开会停在上次的子视图上。 */
			const [tipSub, setTipSub] = react.useState(null);
			/* 积分套餐气泡的下钻层：null = 根视图，数字 = 点开了第几个聚合行（×N 那行）。
			   换字段 / 收起气泡 / 点标题返回都清掉，下次打开回到套餐列表。 */
			const [creditSub, setCreditSub] = react.useState(null);
			/* 子视图「每列几行」：默认 3 行一列；量到一排放不下（列被折到下一排）就
			   逐档 +1（最多 12 行，见下面气泡定位那条 layout effect）。换字段 / 换子视图都重置回 3。
			   **名字保留 `toolRows`（历史原因），但它现在服务三个列表**：工具调用、技能注入、
			   上下文压缩 —— 后两个是用户后加的（「技能注入也和工具调用同理……上下文压缩也同理」）。
			   三者共用同一个 `rowsPanel` 入口与同一个 state，所以三处 `setToolRows(LIST_ROWS_PER_COLUMN)`
			   重置（换字段 / sub.open / sub.back）对三者一视同仁，不需要各写一份。
			   改名成 listRows 会牵动既有测试里对这个名字的引用，收益不值当。 */
			const [toolRows, setToolRows] = react.useState(LIST_ROWS_PER_COLUMN);
			/* 柱 / 方块 / 每周底条的悬停浮层：内容 + 触发元素的位置（自己算 fixed 坐标） */
			const [hoverCard, setHoverCard] = react.useState(null);
			const [hoverPos, setHoverPos] = react.useState(null);
			/* 工具彩条段悬停的「无气泡纯文字」内容（工具名 + 占比）；有值时只渲染一行文字 */
			const [hoverPlain, setHoverPlain] = react.useState(null);
			/* 工具名悬停提示**整组开关**（用户拍板）：当前气泡放不下那行小字时置 true，
			   此后所有工具名的悬停都不再挂 onMouseEnter。由气泡定位 effect 量出实际宽度后判定
			   （见 plainFits）；换气泡 / 换子视图时由那条 effect 重新得出结论。 */
			const [hoverPlainOff, setHoverPlainOff] = react.useState(false);
			/* 纯文字提示的固定垂直位置（与气泡标题行文字居中对齐）：定位 effect 算好后存这里，
			   段内左右移动时直接复用，保证「只左右移动、不上下移动」且不抖。 */
			const hoverPlainTopRef = react.useRef(null);
			/* 纯文字提示的水平夹取范围：左 = 「工具调用」标题右边界 + 1ch，右 = 色条右边界
			   （再与视口右缘取小）。定位 effect 里算一次存这里，段内移动时复用。 */
			const hoverPlainBoundsRef = react.useRef(null);
			/* 当前悬停的是哪一周（用来给那条底板加深）；悬停方块/柱子时为 null */
			const [hoverWeek, setHoverWeek] = react.useState(null);
			/* 当前悬停的是哪一根柱（那一列的判定区变灰）；不在柱上时为 null */
			const [hoverBar, setHoverBar] = react.useState(null);
			const hoverRef = react.useRef(null);
			/* 工具调用彩条悬停时「跟着鼠标走」：鼠标坐标（clientX / clientY）。
			   仅鼠标跟随型浮层（payload.follow === true）设置；活跃总览的柱/方块不设，仍贴整个气泡上方。 */
			const [hoverMouse, setHoverMouse] = react.useState(null);
			const hoverTimerRef = react.useRef(null);
			/* 收起延后一小会儿：鼠标在相邻的空位格之间横向移动会先 leave 再 enter，
			   当场清空就会一闪一闪；紧接着的新悬停会把定时器取消掉，等于没关过。 */
			const closeHoverSoon = react.useCallback(() => {
				if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
				hoverTimerRef.current = setTimeout(() => {
					hoverTimerRef.current = null;
					setHoverCard(null);
					setHoverPos(null);
					setHoverWeek(null);
					setHoverBar(null);
					setHoverPlain(null);
					setHoverMouse(null);
				}, 110);
			}, []);
			/* payload 为对象：rows 有值时弹浮层，plain 有值时只显示一行文字（无气泡），
			   week 有值时那条底板加深，bar 有值时那根柱的判定区变灰。
			   follow === true 时浮层跟着鼠标走（贴鼠标上方、水平居中）。
			   传空表示离开判定区（延后收起，避免在相邻区域间横向移动时闪烁）。 */
			const onHover = react.useCallback((event, payload) => {
				if (payload === null || payload === undefined) {
					closeHoverSoon();
					return;
				}
				if (hoverTimerRef.current !== null) {
					clearTimeout(hoverTimerRef.current);
					hoverTimerRef.current = null;
				}
				setHoverPos(null);
				const pointer = event !== null && event !== undefined
					&& typeof event.clientX === "number" && typeof event.clientY === "number"
					? { x: event.clientX, y: event.clientY }
					: null;
				setHoverMouse(payload.follow === true ? pointer : null);
				setHoverPlain(typeof payload.plain === "string" ? payload.plain : null);
				setHoverCard(payload.rows === undefined ? null : payload.rows);
				setHoverWeek(typeof payload.week === "number" ? payload.week : null);
				setHoverBar(typeof payload.bar === "number" ? payload.bar : null);
			}, [closeHoverSoon]);
			/* 同一色段里移动：**直接写提示的 left**，不走 setState —— 跟鼠标是同一帧，
			   不会有 React 重渲染 + layout effect 的一到两帧延迟（用户实测「不跟手」）。
			   纯文字提示**只左右移动、上下固定**（垂直位置与气泡标题文字居中对齐，
			   固定值由定位 effect 算好后存在 hoverPlainTopRef 里）；气泡版仍按鼠标上下跟。
			   只在内容切换（进入另一个色段）时才走 onHover 重设位置；这里改完不触发渲染。 */
			const onHoverMove = react.useCallback((event) => {
				if (event === null || event === undefined) return;
				if (typeof event.clientX !== "number" || typeof event.clientY !== "number") return;
				const node = hoverRef.current;
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
				/* 测试替身没有 style（不是真实 DOM）：直接跳过，几何本身由其它用例覆盖 */
				if (node.style === undefined || node.style === null) return;
				const size = node.getBoundingClientRect();
				if (hoverPlain !== null) {
					/* 纯文字提示：水平夹在「标题右边界 ~ 色条右边界」之间（放不放得下已在定位 effect
					   判过，能走到这里就说明放得下，不做任何缩放）。宽度用 offsetWidth（不含 transform）。 */
					const layoutWidth = typeof node.offsetWidth === "number" && node.offsetWidth > 0
						? node.offsetWidth
						: size.width;
					const left = clampPlainLeft(event.clientX - layoutWidth / 2, layoutWidth, hoverPlainBoundsRef.current, window.innerWidth);
					node.style.left = left + "px";
					/* 上下固定：沿用 title 行居中算出的 top */
					if (hoverPlainTopRef.current !== null) node.style.top = hoverPlainTopRef.current + "px";
				} else {
					const left = Math.max(8, Math.min(event.clientX - size.width / 2, window.innerWidth - size.width - 8));
					node.style.left = left + "px";
					node.style.top = Math.max(8, event.clientY - size.height - 12) + "px";
					node.style.transform = "";
					node.style.transformOrigin = "";
				}
				/* 直径写宽度会把「贴段居中」的旧宽档带过来，鼠标跟随时让提示按内容自适应 */
				node.style.width = "";
			}, [hoverPlain]);
			react.useEffect(() => () => {
				if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
			}, []);
			/* 气泡只由点击展开（圆环或各字段），再点一次或点别处收起 */
			const rootRef = react.useRef(null);
			/* 气泡定位：触发项位置 + 面板节点（用来量宽度）。水平位置一律以触发项自身居中，
			   左右再夹到底栏范围内，所以不需要记对齐方式。 */
			const anchorRef = react.useRef(null);
			const tipRef = react.useRef(null);
			/* 上一次回传给 host 的定位诊断串：只在坐标真变了时才回传，别把日志刷满 */
			const tipDiagRef = react.useRef(null);
			/* 窗口缩放时 +1：定位 effect 没有依赖数组（每次渲染都重算），
			   但 resize 本身不会引起渲染，得靠它推一次 */
			const [, setTipTick] = react.useState(0);

			/* 本轮费用兜底：官方全量 tokenUsage 差分 */
			const turnBaseRef = react.useRef(null);
			const turnLastRef = react.useRef(null);
			const [, bumpTurn] = react.useState(0);
			const usageSnapshot = usage === undefined || usage === null ? null : {
				input: usage.uncachedInputTokens || 0,
				cacheRead: usage.cacheReadTokens || 0,
				cacheWrite: usage.cacheWriteTokens || 0,
				output: usage.outputTokens || 0
			};
			react.useEffect(() => {
				if (usageSnapshot === null) return;
				if (running === true) {
					if (turnBaseRef.current === null) turnBaseRef.current = usageSnapshot;
					return;
				}
				if (turnBaseRef.current !== null) {
					turnLastRef.current = diffUsage(usageSnapshot, turnBaseRef.current);
					turnBaseRef.current = usageSnapshot;
					bumpTurn((n) => n + 1);
				}
			}, [running, usage]);

			/* 计时：只要时间投影里有活跃基线就跑时钟。
			 * 不能把 running 当唯一开关 —— 它在 step/turn 边界会短暂转 false，
			 * 那样时钟会在每轮中途停摆，要等下一个事件才跳一次。 */
			/* 需要“现在几点”的段：总用时（时长累加）与峰谷判断（时段文字） */
			const needsNow = isSegmentOn(cfg, "sessionTime") || isSegmentOn(cfg, "status");
			const timeRangeNow = timeRange === undefined || timeRange === null ? null : timeRange;
			const clockActive = timeRangeNow !== null
				&& ((timeRangeNow.since !== null && timeRangeNow.since !== undefined)
					|| (timeRangeNow.stepSince !== null && timeRangeNow.stepSince !== undefined));
			/* 队友还在跑 ⇒ 时钟必须继续跳（哪怕主对话已经结束）。
			   为什么需要它：主对话一结束 `running` 与 `clockActive` 都会转 false，旧行为是
			   睡到下一个峰谷边界（可能几小时），于是「总计」里的队友金额与队友数据都不再
			   每秒更新 —— 用户观察到的「必须点开总计气泡才刷新」就是它。
			   `subagentRunning` 由 host 响应的 `running` 维护，队友全部结束就回 0，
			   时钟随即退回原来的省电行为（不会永久每秒跳）。 */
			const subagentBusy = subagentRunning > 0;
			react.useEffect(() => {
				/* 队友在跑时**必须**有钟：即使「总用时 / 峰谷」两段都被关掉，`now` 每秒一跳
				   才能驱动队友用量的重拉（那条 effect 依赖 now，节流靠 SUBAGENT_REFRESH_MS），
				   否则「总计」又退回到"不点气泡就不更新"。
				   **开发模式开着时也必须有钟**：底栏的时间类字段（本轮金额的粘性下限、
				   总用时累加）都按 now 走，没有钟它们就冻在上一拍。
				   （这里以前还写着「作为每 N 秒核对组件还在不在的驱动源」——那段组件探测
				   逻辑已经整体删掉了，注释一并移除，免得后来人去找一个不存在的定时核对。） */
				if (needsNow !== true && subagentBusy !== true && devActive !== true) return undefined;
				if (running === true || clockActive || subagentBusy === true || devActive === true) {
					/* 1 秒一档：主对话在跑、或队友在跑 —— 这两件事都需要"实时"；
					   开发模式也走 1 秒档（演示数据要跟着气泡点击立即反映到时间类字段上）；
					   只有 clockActive（正在计时但没人在产出）才降到 10 秒省电。 */
					const fast = running === true || subagentBusy === true || devActive === true;
					const timer = window.setInterval(() => setNow(Date.now()), fast === true ? 1000 : 10000);
					return () => window.clearInterval(timer);
				}
				/* 空闲：睡到下一个峰谷边界再刷新，不轮询 */
				let timer = 0;
				const tick = () => {
					setNow(Date.now());
					timer = window.setTimeout(tick, msToNextPeakBoundary(Date.now()) + 1000);
				};
				timer = window.setTimeout(tick, msToNextPeakBoundary(Date.now()) + 1000);
				return () => window.clearTimeout(timer);
			}, [needsNow, running, clockActive, subagentBusy, devActive]);

			/* 价格库缺省或全 0 时自动补上官方参考价（不用用户手动填）。
			   开发模式跳过：它内部会发一次真实 fetch（verify-dev-mode ⑦ 要求开发模式 0 次请求）。 */
			react.useEffect(() => {
				if (devActive === true) return;
				void ensurePrices();
			}, [devActive]);

			const wantsBalance = isSegmentOn(cfg, "balance");
			/* 当前会话用的 provider / model：host 按它决定查哪个平台的余额。
			   这两个值变了要重新查，所以下面 effect 的依赖里带着它们。 */
			const balanceProvider = sessionModel !== undefined && sessionModel !== null ? sessionModel.provider : null;
			const balanceModel = sessionModel !== undefined && sessionModel !== null ? sessionModel.model : null;
			const balanceQuery = "?provider=" + encodeURIComponent(String(balanceProvider === undefined || balanceProvider === null ? "" : balanceProvider))
				+ "&model=" + encodeURIComponent(String(balanceModel === undefined || balanceModel === null ? "" : balanceModel));
			/* 点开余额气泡时先强制重查一次：host 端余额不缓存，带上 force 就不用等
			   下一次轮询（最多 60 秒），气泡里直接是此刻的数字。轮询本身不带 force。 */
			const balanceReloadRef = react.useRef(null);
			react.useEffect(() => {
				/* 开发模式：一次请求都不发，直接吃假余额（6 种轮换见 devFixture）。 */
				if (devData !== null) {
					setBalance(devData.balance);
					balanceReloadRef.current = () => setBalance(devData.balance);
					return () => { balanceReloadRef.current = null; };
				}
				if (!wantsBalance) return undefined;
				/* 换了 provider / 换了 model 时**先清空**再查：不清的话，新平台的第一次查询
				   回来之前（或它一直查不到时），界面会把上一个平台的数字当成当前平台的余额显示，
				   那比横杠更误导（用户拍板：宁可先显示横杠）。 */
				setBalance(null);
				let alive = true;
				const load = (force) => {
					const url = BALANCE_URL + balanceQuery + (force === true ? "&force=1" : "");
					window.fetch(url, { cache: "no-store" })
						.then((response) => response.json())
						.then((data) => {
							/* **只有真的拿到余额才覆盖**：某一轮失败（平台临时 5xx / 超时 / 该平台没配 key）
							   不能把上一次成功的数字换成空，否则底栏会在 ¥12.34 与 ¥- 之间来回跳，
							   用户每次抬眼看到的都是"查不到"。 */
							if (alive && data !== null && data !== undefined && data.ok === true) setBalance(data);
						})
						.catch(() => { /* 网络异常同样保留上一次成功值（首次就一直保持 null = 横杠） */ });
				};
				balanceReloadRef.current = () => load(true);
				load(false);
				const timer = window.setInterval(() => load(false), BALANCE_POLL_MS);
				return () => {
					alive = false;
					balanceReloadRef.current = null;
					window.clearInterval(timer);
				};
			/* 依赖里**必须带 devBalanceCount**：开发模式下余额来自 devFixture，而这个 effect 负责
			   把它 setBalance 进去。只依赖 round 的话，点余额气泡时 round 不变 ⇒ effect 不重跑
			   ⇒ setBalance 压根不执行 ⇒ 余额数字冻住（用户实测的"余额点开不变"就是这个）。 */
			}, [wantsBalance, balanceProvider, balanceModel, devActive, devState.round, devBalanceCount]);

			/* 活跃总览（峰谷段的气泡）：不轮询。挂载时取一次（走 host 缓存），
			   之后每次点开气泡都带 force=1 —— force 只绕过 host 那 30 秒缓存；
			   没变动的日志文件按 mtime+size 跳过，历史数字也不会被重算，
			   跨天、跨月靠"关掉再点开"自然跟上。 */
			const wantsWeekly = isSegmentOn(cfg, "status");
			const dailyReloadRef = react.useRef(null);
			react.useEffect(() => {
				/* 开发模式：直接吃假数据（近 7 天 + 当月日历 + 12 个月都齐），一次请求都不发 */
				if (devData !== null) {
					setDaily(devData.daily);
					dailyReloadRef.current = () => setDaily(devData.daily);
					return () => { dailyReloadRef.current = null; };
				}
				if (!wantsWeekly) return undefined;
				/* 与余额同一条规矩：退出开发模式后先清空，别让真实的活跃总览还没回来时
				   继续显示开发模式那套假数据。 */
				setDaily(null);
				let alive = true;
				const load = (force) => {
					const url = DAILY_URL + (force === true ? "?force=1" : "");
					window.fetch(url, { cache: "no-store" })
						.then((response) => response.json())
						.then((data) => { if (alive) setDaily(data); })
						.catch(() => { if (alive) setDaily({ ok: false, reason: "fetch-failed" }); });
				};
				dailyReloadRef.current = () => load(true);
				load(false);
				return () => {
					alive = false;
					dailyReloadRef.current = null;
				};
			/* 依赖里**必须带 devStatusCount**：与余额那条完全同一个道理 —— 活跃总览的假数据来自
			   devFixture，而这个 effect 负责把它 setDaily 进去。只依赖 round 的话，点「峰谷」
			   气泡时 round 不变 ⇒ effect 不重跑 ⇒ setDaily 不执行 ⇒ 柱状图/月历一直冻在旧值
			   （用户实测的"柱状图一直同高、月份一直 10 月"里，一半原因就是这个）。 */
			}, [wantsWeekly, devActive, devState.round, devStatusCount]);

			/* 队友用量（「总计」「本轮」都要算上它）：换会话、对话新增了节点、本轮换了、
			   或距上次超过 3 秒（活跃时）才重拉；点开气泡再强制拉一次。
			   失败 / 超时一律静默：拿不到就退回"只算本会话"，界面不该因为队友数据出问题而报错或卡住。
			   分三个 effect：一个算本轮起点、一个决定"该不该拉"（跟着每秒的 now 数那 3 秒）、
			   一个只负责拉（只在真的决定要拉时才换 query）。合成一个的话，时钟每跳一下
			   就会把在途请求的 alive 清掉，结果永远落不了地。 */
			const foldedTurnNow = foldTurnUsage(chatNodes);
			/* 本轮起点 = 当前轮第一条记录的时间；节点不带时间戳、或折叠还停在上轮时为 null。
			   为 null 时本轮那一问**照发**（不带 since），由 host 读父会话日志代推（host 那边还会
			   按父会话日志再收敛一道）；两边都拿不到就返回全 0 ⇒ 本轮只显示本会话值（只能小不能大）。 */
			const foldedTurnNum = foldedTurnNow !== null ? foldedTurnNow.turn : null;
			/* host 投影说的当前轮号（与下面 lastCost 用的是同一个来源）。折叠出来的轮号跟它对不上，
			   说明新一轮已经开跑、而对话节点还没跟上 —— 这时折叠出的起点是**上一轮的**，
			   拿它当 since 会把上一轮的队友花费算进本轮（偏大），所以直接当拿不到起点。 */
			const hostTurn = sessionUsage !== undefined && sessionUsage !== null && typeof sessionUsage.turn === "number"
				? sessionUsage.turn
				: null;
			const turnIsCurrent = foldedTurnNum === null || hostTurn === null || foldedTurnNum === hostTurn;
			/* 「同一轮」的轮标识（给队友状态机与"本轮只增不减"用）。两个来源都只会在真的换轮时前进：
			   host 投影的 turn 随用量事件走，节点折叠的轮号随助手节点走。取**较大者**是为了尽早认定
			   "换轮了"——两者谁先看到新一轮，就从那一刻起归零重算；认不出轮次（两个都拿不到）时为 null，
			   此时既不沿用旧值也不做粘性，避免把两轮的数字混在一起。
			   **必须定义在下面 turnStartMs 之前**：host 起点兜底要拿它判定"这份值属于哪一轮"。 */
			const subagentTurnKey = hostTurn !== null && foldedTurnNum !== null
				? Math.max(hostTurn, foldedTurnNum)
				: (hostTurn !== null ? hostTurn : foldedTurnNum);
			/* 客户端自己折叠出来的起点。**这是主路径**，算得出来就用它，不碰 host 那个兜底值。 */
			const foldedStartMs = turnIsCurrent === true && foldedTurnNow !== null && typeof foldedTurnNow.at === "number"
				? foldedTurnNow.at
				: null;
			/* host 推出来的那一个起点（上一次响应里存下的）。**只在主路径拿不到时才用**：
			   典型场景是客户端折叠出的是上一轮起点（新一轮已开、主助手还没输出），
			   host 通常能收紧到真正的本轮起点；而 host 自己读不出父会话日志时会返回 null，
			   那就还是 null（宁少不多，本轮不并队友）。
			   归属必须同时对上**会话 + 轮**才认，否则就是上一个会话/上一轮留下的旧值 ——
			   与 nextSubagentState 的判定思路一致（归属对不上就作废，不沿用）。 */
			const hostStart = hostTurnStartRef.current;
			const hostStartUsable = hostStart !== null && hostStart !== undefined
				&& hostStart.sessionId === sessionId
				&& subagentTurnKey !== null && hostStart.turnKey === subagentTurnKey
				&& typeof hostStart.value === "number" && Number.isFinite(hostStart.value) && hostStart.value > 0;
			const turnStartMs = foldedStartMs !== null
				? foldedStartMs
				: (hostStartUsable === true ? hostStart.value : null);
			const chatNodeCount = Array.isArray(chatNodes) ? chatNodes.length : -1;
			const subagentReqRef = react.useRef({ sessionId: null, nodes: -1, since: null, at: 0 });
			const subagentForceRef = react.useRef(false);
			const subagentReloadRef = react.useRef(null);
			/* 一次"要拉取"的凭据：nonce 变一次就拉一次（sessionId / since 跟着它一起走，读的时候不会串会话） */
			const [subagentQuery, setSubagentQuery] = react.useState(null);
			react.useEffect(() => {
				/* 开发模式：点开「总计」气泡时不该真去拉队友用量（0 请求要求）。 */
				subagentReloadRef.current = devActive === true
					? null
					: () => {
						subagentForceRef.current = true;
						setSubagentTick((n) => n + 1);
					};
				return () => { subagentReloadRef.current = null; };
			}, [devActive]);
			react.useEffect(() => {
				/* 开发模式：「总计 / 本轮」的队友那一段直接取假值（见 devFixture 的 subagent），
				   不发请求，也不让上一条真实请求的残留值混进来。
				   `running` 一并归零：假数据里没有"还在跑的队友"这回事，留着旧值会让
				   时钟一直按每秒一档空转（假数据根本不刷新）。
				   host 起点同理清掉，免得退出开发模式后拿假轮次的旧起点去算本轮。 */
				if (devData !== null) {
					setSubagentState(SUBAGENT_STATE_EMPTY);
					setSubagentTiers(SUBAGENT_TIERS_EMPTY);
					hostTurnStartRef.current = { sessionId: null, turnKey: null, value: null };
					return undefined;
				}
				if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				const last = subagentReqRef.current;
				const switched = last.sessionId !== sessionId;
				const forced = subagentForceRef.current;
				subagentForceRef.current = false;
				/* `since`（本轮起点）**不**参与这里的判定：它是从对话节点时间戳折叠出来的，
				   每秒都在毫秒级漂移；拿它当"有变化"的信号会让每次重渲染都判成 due，
				   把 SUBAGENT_REFRESH_MS 的节流整个绕过去，实际每秒打好几次请求、白烧 CPU。
				   本轮起点变了这类变化，由下面 `subagentRunning > 0`（队友还在跑就每秒一次）
				   和 `last.at` 的节流兜住；它依旧写进 subagentReqRef，别处读它当请求参数。 */
				const due = switched === true
					|| last.nodes !== chatNodeCount
					|| subagentRunning > 0
					|| Date.now() - last.at >= SUBAGENT_REFRESH_MS;
				if (forced !== true && due !== true) return undefined;
				subagentReqRef.current = { sessionId: sessionId, nodes: chatNodeCount, since: turnStartMs, at: Date.now() };
				/* 换了会话：上一个会话的队友数字不属于这里，先清掉，新的回来再填 */
				if (switched === true) setSubagentState(SUBAGENT_STATE_EMPTY);
				setSubagentQuery((prev) => ({
					sessionId: sessionId,
					since: turnStartMs,
					turnKey: subagentTurnKey,
					nonce: prev === null ? 1 : prev.nonce + 1
				}));
				return undefined;
			}, [sessionId, chatNodeCount, turnStartMs, now, subagentTick, subagentTurnKey]);
			react.useEffect(() => {
				/* 开发模式：队友那两段是假值，一个请求都不发（含"进开发模式前已经在途的那次"）。 */
				if (devActive === true) return undefined;
				if (subagentQuery === null) return undefined;
				if (typeof window === "undefined" || typeof window.fetch !== "function") return undefined;
				let alive = true;
				/* 超时自己兜：后端卡住时不能把「总计」一直吊着。用 AbortSignal.timeout 而不是
				   自己挂 setTimeout —— 底栏本该只有"时钟"那一个定时器（已有测试盯着），
				   多一个窗口定时器会打乱它的计数；环境不支持就算了，失败照样被 catch 静默。 */
				const timeoutSignal = typeof AbortSignal === "object" && AbortSignal !== null
					&& typeof AbortSignal.timeout === "function"
					? AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)
					: undefined;
				/* 两条请求：整会话那一份显式带 `since=0`（表示"从最开始"，即总计口径），
				   本轮那一份优先用客户端自己的起点；**自己拿不到起点也照发**（不带 since），
				   让 host 读父会话日志代推 —— host 推不出来时它会返回 sinceSource='none'
				   与全 0，本轮因此只显示本会话值（只能小不能大）。 */
				const load = (since) => {
					const url = SUBAGENT_URL + "?sessionId=" + encodeURIComponent(subagentQuery.sessionId)
						+ (since === null ? "" : "&since=" + encodeURIComponent(String(since)));
					return window.fetch(url, { cache: "no-store", signal: timeoutSignal })
						.then((response) => response.json())
						.then((data) => (data !== null && typeof data === "object" && data.ok === true ? data : null))
						.catch(() => null);
				};
				Promise.all([
					load(0),
					subagentQuery.since === null ? load(null) : load(subagentQuery.since)
				]).then((both) => {
					if (alive !== true) return;
					/* 两段各自过一遍状态机（`nextSubagentState`，规则见那里的注释）：
					   这一次没拿到（网络失败 / 非 200 / HTTP 200 但 ok:false / 形状异常 —— 上面 `load`
					   已经把后三种统一折算成 null）时，**同轮内沿用上一次成功的值**；从没成功过就保持
					   空（界面按"仅本会话"显示）；轮次变了则以 action 里的 turnKey 为准整体清空重算。 */
					const action = (slice, value) => ({
						sessionId: subagentQuery.sessionId,
						turnKey: subagentQuery.turnKey,
						slice: slice,
						ok: value !== null && value !== undefined,
						value: value
					});
					setSubagentState((prev) => nextSubagentState(
						nextSubagentState(prev, action("session", both[0])),
						action("turn", both[1])
					));
					/* 队友还在跑的分层情况（个数 + 两级占用百分比）：两段响应里任一段带这些字段就用它
					   （host 两问都会带上同一份数）。
					   **两问都没结论时整份保留旧值**（nextSubagentTiers 里的 stale-while-revalidate，
					   内部沿用 nextSubagentRunning 的判定），与旁边 hostTurnStartRef 是同一条规矩。
					   为什么不能当成 0：`all` 决定"时钟继续每秒跳"还是"睡到下一个峰谷边界"，
					   一次网络抖动把 0 写进去，时钟就会一路睡到几小时后，队友数据与「总计」里
					   队友那笔金额跟着冻结 —— 正是用户报过的那个缺陷原样复现。
					   反过来"两问都成功且都是 0"必须能落下去（队友真的全部结束，时钟要回到省电档），
					   所以不能写成"新值 > 0 才更新"。
					   五个数一次 setState：拆开会让同一份响应触发多次重渲染，而底栏每秒都在重渲染。 */
					setSubagentTiers((prev) => nextSubagentTiers(prev, both[1], both[0]));
					/* host 推出来的本轮起点：存进 ref，附上它属于哪个会话 / 哪一轮。
					   只在**「本轮窗口」那一问**的响应里读 —— `load(0)`（整会话那一问）返回的起点
					   语义是"最早的那次"，拿它当本轮起点会把整个会话的队友花费算进本轮。
					   归属（sessionId + turnKey）必须一起存：换会话换轮时自动失配作废，
					   与 nextSubagentState 的判定思路一致（归属对不上就不沿用）。
					   **同一归属下这一次没拿到就保留旧值**（和两段取值的 stale-while-revalidate 同理）：
					   起点偶尔读不出来时，不该让本轮立刻退回"不并队友"。 */
					const prevStart = hostTurnStartRef.current;
					const sameOwner = prevStart !== null && prevStart !== undefined
						&& prevStart.sessionId === subagentQuery.sessionId
						&& prevStart.turnKey === subagentQuery.turnKey;
					const turnStart = readTurnStartMs(both[1]);
					hostTurnStartRef.current = {
						sessionId: subagentQuery.sessionId,
						turnKey: subagentQuery.turnKey,
						value: turnStart !== null ? turnStart : (sameOwner === true ? prevStart.value : null)
					};
				});
				return () => { alive = false; };
			}, [subagentQuery, devActive]);

			/* 只在"点别处"时收起。这里刻意不监听 scroll：底栏固定在视口底部，对话区滚动
			   不会移动触发项，但每来一次工具调用/新一轮，对话区都会自动滚到底 ——
			   跟着 scroll 收起的话，气泡会在这些时刻莫名其妙消失。 */
			react.useEffect(() => {
				if (tipId === null) return undefined;
				const close = () => { setTipId(null); setTipPos(null); setTipSub(null); setCreditSub(null); };
				/**
				 * 点面板外部就收起。
				 *
				 * **气泡已经 Portal 到 body，不在 rootRef 里了**（见 tipPanelInner 上方那段说明），
				 * 所以这里必须同时检查气泡自身 —— 否则点气泡会被当成"点在外面"、立刻把它关掉，
				 * 表现为"气泡一出现就消失 / 点里面没反应"。
				 * `tipRef.current` 是气泡节点自己的 ref（五个面板构造函数都收了它），
				 * Portal 之后它指向的仍是那个真实 DOM，contains 判定照旧有效。
				 * 两个 ref 都可能还是 null（首次渲染 / 气泡没开）：逐个判空，不要直接 .contains。
				 */
				const onDocClick = (event) => {
					const target = event === null || event === undefined ? null : event.target;
					const root = rootRef === null || rootRef === undefined ? null : rootRef.current;
					if (root !== null && root !== undefined && root.contains(target)) return;
					const panel = tipRef === null || tipRef === undefined ? null : tipRef.current;
					if (panel !== null && panel !== undefined && typeof panel.contains === "function" && panel.contains(target)) return;
					close();
				};
				/* 窗口尺寸变了只是位置要重算，不必把气泡收掉 */
				const reflow = () => setTipTick((n) => n + 1);
				document.addEventListener("click", onDocClick);
				window.addEventListener("resize", reflow);
				return () => {
					document.removeEventListener("click", onDocClick);
					window.removeEventListener("resize", reflow);
				};
			}, [tipId]);

			/* 气泡坐标：宽度由内容决定（CSS 里 width:max-content），所以只能等面板挂上再量。
			   **不设依赖数组**：下钻换子视图、数字位数变化都会改宽度，坐标必须跟着重算 ——
			   只在 tipId 变时算的话，换子视图后会沿用上一个宽度，气泡就偏到一边去。
			   每次都重新量，算出来的值没变就返回同一个对象，React 会跳过这次更新，不会转圈。
			   水平位置：一律以触发项自身居中，再夹在「上下文占用圆圈灰底的左边」与视口右边之间。
			   用 layout effect 是为了在浏览器绘制前就落位，不会先闪一下再跳。 */
			useTipLayout(() => {
				if (tipId === null) return;
				const target = anchorRef.current;
				const anchor = target !== null && target !== undefined && typeof target.getBoundingClientRect === "function"
					? target.getBoundingClientRect()
					: null;
				if (anchor === null) {
					setTipPos(null);
					return;
				}
				const node = tipRef.current;
				const width = node !== null && node !== undefined && typeof node.getBoundingClientRect === "function"
					? node.getBoundingClientRect().width
					: 0;
				/* **支持加行的子视图**（工具调用 / 技能注入 / 上下文压缩三个，判据是列表对象上的
				   `growable: true`，不是 `tight`）：默认每列 3 行，一排放不下就逐档加行
				   （3 → 4 → 5 …，上限 LIST_ROWS_PER_COLUMN_MAX）。只有这一套行数 ——
				   不再有「中文/英文整行块」两套结构（见 rowsPanel 的注释）。
				   用户原话：「技能注入也和工具调用同理呀，如果超过每列 3 个依然排不下，
				   就是加每列的个数啊，而不是直接可滚动啊，上下文压缩也同理啊」——
				   所以三个列表走的是同一条路，都不直接横向滚动。
				   列网格是 nowrap（绝不折行），所以"放不下"用横向溢出判（见 toolColumnsOverflow）；
				   每加一行列数就少一档，直到一排放得下。行数一加气泡就变窄 —— 这就是用户要的
				   "宽度 = 加完行数之后刚好不折的那个宽度"（理解 B），不会停在加行前的旧宽度上。
				   只升不降（回退会让行数在两档之间来回跳）；换字段 / 开子视图 / 返回时都重置回 3。
				   到 12 行仍放不下就停在 12，横向滚动兜底（不再折行）。
				   量的是 DOM 几何，测试替身里拿不到就一律当放得下（量测函数自己兜住）。 */
				const overflow = toolColumnsOverflow(node);
				const nextRows = nextToolRows(toolRows, overflow);
				if (nextRows !== toolRows) setToolRows(nextRows);
				/* 逐档加行之后**必须重算一次右缘渐隐**。
				   用户实机报的现象：4 行 × 5 列、内容明明能完整显示，右侧却挂着一道淡出。
				   成因链：打开时按 3 行排 → 6 列放不下 → 挂遮罩 → 这里把行数加到 4 → 列数降到 5、
				   气泡变宽、已经不用滚了，但节点被 React 复用（key 没变、ref 是模块级常量），
				   ref 不会再触发 ⇒ 遮罩一直留着。
				   为什么放在这里、并且**不加条件**：
				     · 这个 useTipLayout 本来就**没有依赖数组**（每次渲染都跑），而它上面几行已经
				       调过 `getBoundingClientRect()` —— 布局早就被强制刷新过了，这里再读一次
				       scrollWidth/clientWidth 的边际成本≈0（同一帧内的第二次读不再触发重排）。
				       所以「每帧多一次强制布局」这个担心在本位置不成立。
				     · 不加 `nextRows !== toolRows` 条件：加行是「这一帧测到溢出、下一帧才换行数」，
				       真正需要重算的是**换完行之后那一帧**（那时 nextRows 已经等于 toolRows 了）。
				       无条件调用才能在换行后的第一次渲染就纠正；applyColsFade 内部有记忆，
				       几何没变时连 classList / style 都不碰，不会造成每帧栅格化。
				     · 不用 rAF 延后一帧：那样中间会有一帧"遮罩还在"的可见闪烁，而这里根本没有
				       时序问题（下一帧渲染时 DOM 已是新行数，量到的就是新几何）。 */
				refreshColsFade(node);
				const centered = anchor.left + anchor.width / 2 - width / 2;
				/* 左右两条硬约束，任何气泡都适用，而且是**对齐**不是仅仅不越界：
				   左 —— 可见左边缘压在上下文占用那个**圆圈灰底**的左边。灰底是圆环按钮自己画的
				        （`.dsb-ring-btn[aria-expanded=true]`，padding 3px + border-radius 50%），
				        所以基准要取**按钮的盒子**，不能取里面的 `.dsb-ring` SVG —— SVG 的盒子比灰底
				        窄 3px，拿它对齐气泡会压在灰圈里面（2026-10-05 量用户截图差约 2px）。
				        也不能取状态栏本体的左边缘（含圆环按钮的外边距，更靠左）。
				   右 —— 可见右边缘压在底栏最右那一项灰底的右边（末尾项的气泡因此自然右对齐到自己身上）。
				   两侧再各补 TIP_OUTLINE_PX：气泡自己有一圈 0.5px 描边（`.dsb-tip` 的 box-shadow
				   spread），可见边缘比 border-box 再往外 0.5px。 */
				const root = rootRef.current;
				const ring = root !== null && root !== undefined && typeof root.querySelector === "function"
					? root.querySelector(".dsb-ring-btn")
					: null;
				const ringBox = ring !== null && ring !== undefined && typeof ring.getBoundingClientRect === "function"
					? ring.getBoundingClientRect()
					: null;
				const barLeft = (ringBox === null ? anchor.left : ringBox.left) + TIP_OUTLINE_PX;
				const segs = root !== null && root !== undefined && typeof root.querySelectorAll === "function"
					? root.querySelectorAll(".dsb-seg")
					: null;
				const lastSeg = segs === null || segs.length === 0 ? null : segs[segs.length - 1];
				const barRight = lastSeg !== null && lastSeg !== undefined && typeof lastSeg.getBoundingClientRect === "function"
					? lastSeg.getBoundingClientRect().right
					: anchor.right;
				const barRightIn = barRight - TIP_OUTLINE_PX;
				/* 气泡比底栏还宽时（工具调用那种多列面板），先把宽度压到底栏跨度以内 ——
				   否则右边界怎么挪都会顶出去。
				   **注意：多出来的列不是折到下一排**（`flex-wrap` 已是 nowrap，用户明确要求永不折行），
				   而是由内层 `.dsb-meter-cols` 横向滚动（`overflow-x:auto`）接住；
				   行数在 12 行以内时优先加行把列数压下来，列少了气泡自然变窄（这就是"自适应宽度"）。 */
				const span = barRightIn - barLeft;
				const maxWidth = span > 0 ? Math.min(span, window.innerWidth - 24) : null;
				const maxLeft = Math.min(barRightIn - width, window.innerWidth - width - 8);
				const left = Math.max(barLeft, Math.min(centered, maxLeft));
				const bottom = Math.max(8, window.innerHeight - anchor.top + 6);
				/* 诊断串：只用于下面回传给 host 落盘（不写进 DOM，浏览器也不显示） */
				const align = "center left=" + left.toFixed(1) + " ring=" + barLeft.toFixed(1)
					+ " bar=" + barRight.toFixed(1) + " anchor=" + Math.round(anchor.left) + " w=" + Math.round(width);
				setTipPos((prev) => (prev !== null && prev.left === left && prev.bottom === bottom
					&& prev.maxWidth === maxWidth
					? prev
					: { left: left, bottom: bottom, maxWidth: maxWidth }));
				/* 诊断回传：本机打不开控制台也能核对，host 会落到 <DSH_HOME>/dsh-status-bar/tip-diag.log。
				   只在坐标真的变了时才回传，不然每次渲染都发一遍会把日志刷满。 */
				if (tipDiagRef.current !== align) {
					tipDiagRef.current = align;
					reportTipDiag({
						tip: tipId,
						mode: "center",
						left: left,
						ring: barLeft,
						ringFound: ring !== null && ring !== undefined,
						/* 宿主日志里有 bar 这一列，之前一直没发过去，那列永远是 null */
						bar: barRight,
						anchor: anchor.left,
						width: width,
						viewport: window.innerWidth
					});
				}
			});

			/* 悬停定位：两种情形。
			   ① 工具调用彩条的纯文字提示（hoverPlain）—— **垂直方向固定**：与气泡标题文字居中对齐，
			      不随鼠标上下移动；只有 left 跟着鼠标水平居中（用户拍板：只左右移动、不上下移动）。
			      水平位置用 hoverMouse 记下的鼠标坐标（onHover 时写入）。
			   ② 活跃总览的柱 / 方块 / 底板 —— 固定贴在气泡正上方、左右同宽。
			   hoverMouse 由 onHover 记录；离开后由 closeHoverSoon 清空。 */
			useTipLayout(() => {
				if (hoverCard === null && hoverPlain === null) return;
				const node = hoverRef.current;
				const panel = tipRef.current;
				if (node === null || node === undefined || panel === null || panel === undefined) return;
				if (typeof node.getBoundingClientRect !== "function" || typeof panel.getBoundingClientRect !== "function") return;
				const size = node.getBoundingClientRect();
				if (hoverPlain !== null) {
					const one = hoverMouse;
					if (one === null || one === undefined) return;
					/* 标题行（.dsb-meter-head）的垂直中心：文字提示与它居中对齐 */
					const head = typeof panel.querySelector === "function" ? panel.querySelector(".dsb-meter-head") : null;
					const headBox = head !== null && head !== undefined && typeof head.getBoundingClientRect === "function"
						? head.getBoundingClientRect()
						: null;
					const fixedTop = headBox === null || headBox.height <= 0
						? Math.max(8, node.getBoundingClientRect().top)
						: headBox.top + headBox.height / 2 - size.height / 2;
					hoverPlainTopRef.current = fixedTop;
					/* 水平范围：左 = 标题右边界 + 1ch；右 = **色条本身**的右边界（不是气泡右边界） */
					const title = typeof panel.querySelector === "function" ? panel.querySelector(".dsb-meter-headline") : null;
					const titleBox = title !== null && title !== undefined && typeof title.getBoundingClientRect === "function"
						? title.getBoundingClientRect()
						: null;
					const bar = typeof panel.querySelector === "function" ? panel.querySelector(".dsb-bar") : null;
					const barBox = bar !== null && bar !== undefined && typeof bar.getBoundingClientRect === "function"
						? bar.getBoundingClientRect()
						: panel.getBoundingClientRect();
					const bounds = plainBoundsOf(titleBox, barBox, window.innerWidth);
					hoverPlainBoundsRef.current = bounds;
					/* 提示文字的自然宽度。用 offsetWidth（布局宽度）而不是
					   getBoundingClientRect().width：后者含 transform，而这条 effect 的依赖里有
					   hoverMouse（鼠标一动就重跑），量到缩放后的宽会越缩越小。 */
					const layoutWidth = typeof node.offsetWidth === "number" && node.offsetWidth > 0
						? node.offsetWidth
						: size.width;
					/* 放不下就**整组不显示**（用户拍板）：工具名很长、气泡不够长时，
					   这行小字会压到别的内容上或被裁掉。以前是等比缩小硬塞进去，
					   现在改成关掉 —— 缩到 5.5px 本来就读不清，不如不显示。
					   一旦这个气泡放不下，**所有**工具名的悬停提示都关（不是只关超长那个），
					   否则只有一部分能弹，看起来更像故障。 */
					if (plainFits(layoutWidth, bounds, window.innerWidth) !== true) {
						if (hoverPlainOff !== true) setHoverPlainOff(true);
						/* 内容也当场清掉：不留半行字孤零零挂在屏幕上 */
						setHoverPlain(null);
						setHoverPos(null);
						return;
					}
					if (hoverPlainOff === true) setHoverPlainOff(false);
					setHoverPos({
						left: clampPlainLeft(one.x - layoutWidth / 2, layoutWidth, bounds, window.innerWidth),
						top: Math.max(8, fixedTop)
					});
					return;
				}
				const box = panel.getBoundingClientRect();
				/* 悬停浮层与主气泡之间只留 3px（原为 6px）：用户看实机后觉得"两个气泡中间的缝太大"。
				   两个都是圆角 16px 的毛玻璃块，叠在一起时 6px 会被圆角吃出明显的空隙感，
				   收到 3px 既能看出是两层、又不会像断开的两块。 */
				setHoverPos({
					left: Math.max(8, box.left),
					top: Math.max(8, box.top - size.height - 3),
					width: box.width
				});
			}, [hoverCard, hoverPlain, hoverMouse]);

			/* 主气泡收起时顺手把悬停浮层也收掉，避免它孤零零留在屏幕上。
			   `hoverPlainOff` 也必须在这里复位：它是「本气泡放不下所以整组不显示」的一次性结论，
			   换气泡 / 关气泡后必须重新评估 —— 不复位的话，用户碰到一次长工具名之后，
			   此后所有气泡的工具名悬停都会永久失效（2026-10 实测发现）。 */
			react.useEffect(() => {
				if (tipId === null) {
					setHoverCard(null);
					setHoverPos(null);
					setHoverPlainOff(false);
				}
			}, [tipId]);

			/* 开关状态同步到 <html>：CSS 里那两条"藏官方底栏"的规则挂在 html.dsb-on 上。 */
			react.useEffect(() => {
				if (typeof document === "undefined" || document === null) return undefined;
				const root = document.documentElement;
				if (root === null || root === undefined || root.classList === undefined) return undefined;
				root.classList.add("dsb-on");
				return () => { root.classList.remove("dsb-on"); };
			}, []);

			/* 本轮费用：优先节点折叠（与官方同源），节点缺失才用差分兜底。
			   这份在上面算队友的「本轮」窗口时已经折过一次（foldedTurnNow），这里直接复用。 */
			const foldedTurn = foldedTurnNow;
			const turnUsage = foldedTurn !== null ? foldedTurn.parts : turnLastRef.current;
			/* 这份用量属于哪一轮（节点折叠才有；差分兜底没有轮号） */
			const turnUsageTurn = foldedTurn !== null ? foldedTurn.turn : null;
			/* host 投影说的当前轮号：用来判断上面那份用量是不是本轮正在进行中的 */
			const currentTurn = sessionUsage !== undefined && sessionUsage !== null && typeof sessionUsage.turn === "number"
				? sessionUsage.turn
				: null;
			/* 段的入参形状照旧：{ session, turn } 各自可能是 null（null = 这段没有可用的值 → 当 0）。
			   `session` 由状态机管着"失败沿用上一次成功的值"（整会话与轮无关，跨轮也留着）；
			   `turn` 必须**确认这份窗口属于当前这一轮**才用：换轮那一拍新数据还没回来时，
			   状态里还是上一轮的值，直接拿来加会把上一轮的队友钱算进本轮（实测会让本轮虚高
			   并被粘性下限锁住）。轮次认不出来（turnKey 为 null）时同样不用它 —— 宁少不多。 */
			const turnSliceUsable = subagentTurnKey !== null && subagentState.turnKey === subagentTurnKey;
			const subagent = devData !== null
				/* 开发模式：两段都直接用假值（都带 ok:true、cost>0、tokens 三段、stats），
				   所以「总计」「本轮」都看得出队友已经并进来了。 */
				? { session: devData.subagent.session, turn: devData.subagent.turn }
				: {
					session: subagentState.sessionPayload,
					turn: turnSliceUsable === true ? subagentState.turnPayload : null
				};
			/* 底栏币种：主模型那个条目的币种（消耗最多的模型），认不出主模型才退回默认币种。
			   段里的「总计 / 本轮 / 余额」都读这一个值。 */
			const mainModel = mainModelOf(sessionUsage);
			const displayCurrency = displayCurrencyOf(config.models, config.currency, sessionUsage);

			const debugSrc = {
				stats: stats, usage: usage,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRangeNow,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: displayCurrency,
				models: config.models, defaultCurrency: config.currency,
				timing: timing, turnUsageTurn: turnUsageTurn, currentTurn: currentTurn,
				progress: progress, subagent: subagent
			};
			window.__dsbDebug = {
				now: now, running: running, clockActive: clockActive, timeRange: timeRangeNow,
				steps: stats === undefined || stats === null ? undefined : stats.steps,
				sessionModel: sessionModel === undefined ? null : sessionModel,
				priceBook: config.models,
				peakNow: isPeakTime(now),
				/* 币种相关：底栏符号的实际来源（测试成员照这三个字段取） */
				displayCurrency: displayCurrency,
				defaultCurrency: config.currency,
				mainModel: mainModel,
				referenceRate: REFERENCE_RATE,
				calls: sessionUsage !== undefined && sessionUsage !== null && Array.isArray(sessionUsage.calls) ? sessionUsage.calls.length : 0,
				lastCalls: sessionUsage !== undefined && sessionUsage !== null && Array.isArray(sessionUsage.calls) ? sessionUsage.calls.slice(-3) : [],
				modelsAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.models,
				currentAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.current,
				lastAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.last,
				turnUsage: turnUsage,
				turnUsageTurn: turnUsageTurn,
				currentTurn: currentTurn,
				timing: timing,
				costText: segmentText("cost", segmentView("cost", debugSrc, t), t, displayCurrency),
				lastCostText: segmentText("lastCost", segmentView("lastCost", debugSrc, t), t, displayCurrency),
				sessionTime: segmentText("sessionTime", segmentView("sessionTime", debugSrc, t), t, displayCurrency)
			};

			/* 开发模式在 src 层的覆盖（**只在这一个对象里生效**，组件 state 与时钟一行不动）。
			   来源是 fixture 的 `devSrc` 那一格（它刻意不叫 now/timeline 这些投影名，
			   就是为了让人一眼看出"这不是投影、是 state 替代值"）。四项各自的理由：
			   · now        —— status 的峰谷与 sessionTime 的 elapsed 都读它；真实 now 每秒跳，
			                   「高峰」那一支在开发模式里几乎点不到。
			   · timeline   —— 开发模式没有真实会话节点可折，给 null，用时横杠才走得通。
			   · running 等 —— 只服务「本轮正在跑但还没调用」那一格；其余格一律空闲。
			   · 本轮用量三件套 —— 给确定值，本轮费用那几格形态才可复现；换格即换轮，
			                   粘性下限随之作废。
			   退出开发模式时 devData 为 null，全部退回真实值 —— 机制与原来完全一致。 */
			const devSrc = devData !== null && devData.devSrc !== undefined && devData.devSrc !== null
				? devData.devSrc
				: null;
			const srcNow = devSrc !== null && typeof devSrc.now === "number" ? devSrc.now : now;
			const srcTimeline = devSrc !== null ? devSrc.timeline : timeline;
			const srcRunning = devSrc !== null && typeof devSrc.running === "boolean" ? devSrc.running : running;
			const srcPartial = devSrc !== null ? devSrc.partial : partial;
			const srcRunningCalls = devSrc !== null && Array.isArray(devSrc.runningCalls) ? devSrc.runningCalls : runningCalls;
			const srcTurnUsage = devSrc !== null && devSrc.turnUsage !== undefined ? devSrc.turnUsage : turnUsage;
			const srcTurnUsageTurn = devSrc !== null && devSrc.turnUsageTurn !== undefined ? devSrc.turnUsageTurn : turnUsageTurn;
			const srcLastCostTurn = devSrc !== null && typeof devSrc.turnKey === "string" ? devSrc.turnKey : subagentTurnKey;

			const src = {
				stats: stats, usage: usage,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRange,
				running: srcRunning, partial: srcPartial, runningCalls: srcRunningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: srcTimeline,
				now: srcNow, balance: balance, turnUsage: srcTurnUsage, currency: displayCurrency,
				models: config.models, defaultCurrency: config.currency,
				pressure: pressure, breakdown: breakdown, timing: timing,
				daily: daily,
				turnUsageTurn: srcTurnUsageTurn, currentTurn: currentTurn,
				progress: progress, subagent: subagent,
				/* 「本轮」同轮粘性下限的载体：sessionId/turnKey 说明"这份下限属于谁"，
				   lastCostHold 是个可变盒子（ref 里那个对象），段里渲染时按需更新它 —— 见 applyTurnFloor。 */
				sessionId: sessionId, lastCostTurn: srcLastCostTurn, lastCostHold: lastCostHoldRef.current,
				/* 「总计」增量式账本的载体（见 applyTotalFloor 的注释） */
				totalHold: totalHoldRef.current
			};

			const views = [];
			cfg.segments.filter((id) => isSegmentOn(cfg, id)).forEach((id) => {
				const view = segmentView(id, src, t);
				/* 保留 view 上的 state（状态点靠它上色），只把缺数据的段换成占位文本。
				   **占位段也必须可点**：`segmentView` 返回 null 时若只给 { id, text }，
				   渲染处「tip !== null 才挂 onClick」会让它变成死块 —— 用户点不开气泡，
				   也就没法推进场景，**直接被锁死在空态里出不来**（用户实测踩到）。
				   所以空态补一个极简气泡（标题 = 段名，一行说明 + 一行横杠），
				   点开后 toggleTip 照常把该字段计数 +1，下一格就不是空态了。 */
				views.push(view !== null && view !== undefined
					? view
					: {
						id: id,
						text: segmentText(id, view, t, displayCurrency),
						tip: emptySegmentTip(id, view, t, displayCurrency)
					});
			});

			/* 运行状态：只用来给上下文占用圆环上色（空闲灰 / 运行绿 / 错误红 / 待审批黄） */
			const agentRunning = src.running === true
				|| (src.partial !== undefined && src.partial !== null)
				|| (Array.isArray(src.runningCalls) && src.runningCalls.length > 0);
			const approvals = src.pendingApprovals;
			const approvalWaiting = approvals !== undefined && approvals !== null
				&& (Array.isArray(approvals) ? approvals.length > 0 : true);
			const agentFailed = !agentRunning && src.lastAgentError !== undefined && src.lastAgentError !== null;
			/* 队友分层在跑：成员一级 / 更深一级。只影响"Lead 没在跑时圆环该显示哪个颜色"，
			   不参与上面 running / error / approval 的判定（那三档现有顺序一个字不动）。 */
			const memberBusy = subagentTiers.team > 0;
			const deepBusy = subagentTiers.deep > 0;
			/* 开发模式下 6 种状态色必须都能点到：真实那几样（running / pendingApprovals /
			   lastAgentError / 分层在跑）在开发模式里不会被假数据覆盖，光靠真实判定圆环
			   永远只有一种颜色。所以只在这一处**前置**一个判断：fixture 给了 agentState 就用它，
			   没给就走下面原封不动的真实判定。真实路径字号没改 —— 退出开发模式立刻回到真实状态。
			   `teamRunning` / `deepRunning` 两档插在 `idle` 之前（用户明确要求的优先级）：
			   三级同时在工作时显示 **Lead 优先（绿）**，Lead 不工作了才蓝，成员也不工作了才紫。
			   注意它们排在 approval **之后** —— 「等你点确认」比"队友在跑"更需要人看，
			   而且这条既有顺序用户没有要求改，保持 `running > error > approval > …` 现状。 */
			const agentState = devData !== null && typeof devData.agentState === "string"
				? devData.agentState
				: (agentRunning ? "running"
					: (agentFailed ? "error"
						: (approvalWaiting ? "approval"
							: (memberBusy ? "teamRunning" : (deepBusy ? "deepRunning" : "idle")))));
			/* 上下文占用是独立开关：固定在栏首、不参与排序。
			   拿不到占用数据时给**空环 + 横杠**，绝不整块消失 —— 会话刚发出就被中断时
			   provider 还没报过压力，一整块没掉，底栏就少一项，看着像插件坏了（实测 2026-10-09）。 */
			const contextMeter = cfg.contextMeter === true
				? (meterView(pressure, breakdown, capacity, t) || dashMeter())
				: null;
			/* 打开时保存触发项的位置并收起上一次的气泡；真正的坐标等面板挂上、量到宽度后再算 */
			const toggleTip = (id, event) => {
				/* 换字段（含收起）一律回到根视图，别把上一个字段的下钻层带过来 */
				setTipSub(null);
				setCreditSub(null);
				/* 工具调用子视图的行数也回到默认 3：换字段 / 重开都重新量 */
				setToolRows(LIST_ROWS_PER_COLUMN);
				/* 悬停整组开关也必须复位（用户拍板的那条「放不下就全不显示」）。
				   换字段时 tipId 是**直接切换**（"counts" → "cost"）、不经过 null，
				   只靠 tipId === null 那条 effect 复位不到 —— 结果是：碰到一次长工具名后，
				   点任何一个字段都会让本次会话的工具名悬停永久失效（2026-10 实测确认的死锁）。 */
				setHoverPlainOff(false);
				if (tipId === id) {
					setTipId(null);
					setTipPos(null);
					return;
				}
				/* 开发模式：**只推进被点开的那一个字段的计数**（关闭 / 换字段到这里之前就 return 了，
				   所以只有"从关到开"这一下推进）。
				   用户原话：「点一个，应该只变那一个啊」—— 所以这里传 `id`，只让 `devFieldScenes[id]`
				   +1，其余字段一动不动。点余额只换余额、点总计只换总计。
				   注意推进发生在 setTipId 之前：这一次渲染拿到的 devData 就是新数据，气泡一开就是新值。 */
				advanceDevBubbleScene(id);
				/* 点开余额 / 峰谷用量：顺手重查一次（收起那一下不查），数据回来气泡自己更新 */
				if (id === "balance" && balanceReloadRef.current !== null) balanceReloadRef.current();
				if (id === "status" && dailyReloadRef.current !== null) dailyReloadRef.current();
				/* 总计：队友的数字也要重取一次 —— 节流靠的是那条每秒时钟（SUBAGENT_REFRESH_MS），
			   而会话完全空闲时
				   它不跳（睡到下一个峰谷边界），光靠它会让数字停在旧值 */
				if (id === "cost" && subagentReloadRef.current !== null) subagentReloadRef.current();
				const target = event !== undefined && event !== null ? event.currentTarget : null;
				/* 存节点而不是当次的矩形：窗口缩放后要重新量 */
				anchorRef.current = target !== null && typeof target.getBoundingClientRect === "function" ? target : null;
				setTipId(id);
				setTipPos(null);
			};
			/* 面板挂在触发项自己身上（当子元素），这样气泡正好出现在该项正上方 */
			/**
			 * 气泡面板节点。**构造逻辑一行不动**，只在最后统一用 Portal 挂到 body。
			 *
			 * 为什么必须 Portal（2026-10 实机才发现，光调 z-index 治不了）：
			 * 本插件的底栏是通过 `conversation.composer.dock` 注入的，也就是挂在官方的
			 * `.an3WzG_composerSeat` **内部**，而官方给那个容器设了
			 * `z-index:7; position:sticky` —— 于是气泡的 `z-index:105` 只能在这个
			 * z-index:7 的层叠上下文**内部**比大小，跟外面的官方浮动控件
			 * （「回到底部」那个圆形按钮在 `.V4vHZW_toBottomSlot` 里）根本不在同一层比较，
			 * 数值给到 105 也压不住它（用户实测：改完按钮依旧在上面）。
			 * 挂到 `document.body` 之后气泡成为 body 的直接子节点，105 才真正参与
			 * 与官方 100/101 那一档的比较。
			 * 附带好处：那个 `position:sticky` + `overflow:hidden` 的祖先不再裁剪气泡。
			 * 取不到 createPortal 时退回就地渲染（与设置页拖拽卡片同一套兜底）：
			 * 功能照旧，只是层级问题依旧存在。
			 */
			const tipPanelInner = (tip) => {
				if (tip === undefined || tip === null) return null;
				if (tip.kind === "tokens") return tokenPanel(tip.panel, tip.title, tipPos, tipRef);
				if (tip.kind === "credits") {
					return creditsPanel(tip.panel, tip.title, tipPos, tipRef, {
						id: creditSub,
						/* 点聚合行进入明细子视图；点标题返回套餐列表 */
						open: (index) => setCreditSub(index),
						back: () => setCreditSub(null)
					});
				}
				if (tip.kind === "meter") return meterPanel(tip.meter, t, tipPos, tipRef);
				if (tip.kind === "bars") return weekBarsPanel(tip, t, tipPos, tipRef, onHover, { week: hoverWeek, bar: hoverBar });
				return rowsPanel(tip, tipPos, tipRef, {
					id: tipSub,
					/* 打开 / 返回都把行数重置回 3：另一个子视图不该沿用上一条量出来的行数。
					   `hoverPlainOff` 同理必须复位：在工具子视图里碰到长工具名被关掉之后，
					   点标题返回再进别的子视图，如果不复位，新视图的色条段也一律不挂悬停。 */
					open: (index) => {
						setToolRows(LIST_ROWS_PER_COLUMN);
						setHoverPlainOff(false);
						setTipSub(index);
					},
					back: () => {
						setToolRows(LIST_ROWS_PER_COLUMN);
						setHoverPlainOff(false);
						setTipSub(null);
					},
					rowsPerColumn: toolRows,
					/* 工具名悬停提示整组开关：这个气泡放不下那行小字时一律不挂（用户拍板） */
					hoverSuppressed: hoverPlainOff,
					/* 工具调用彩条每段的悬停浮层（工具名 + 占比）走同一套 onHover，与柱状图互不干扰；
					   onHoverMove 只更新鼠标坐标，让浮层在同一个色段里跟着鼠标走而不闪断。 */
					hover: onHover,
					hoverMove: onHoverMove
				});
			};
			/** 气泡的最终节点：就地构造，再套一层 Portal（拿不到 createPortal 时原样返回）。 */
			const tipPanelOf = (tip) => {
				const node = tipPanelInner(tip);
				if (node === null) return null;
				if (canPortal !== true) return node;
				if (typeof document === "undefined" || document === null) return node;
				if (document.body === undefined || document.body === null) return node;
				return reactDom.createPortal(node, document.body);
			};
			/* 圆环的弧长：**跟着"谁在跑"换数据源**，颜色与弧长是两件独立的事。
			   用户原话：「那个条还是有上下文占用的百分比的，要增长的。所以如果有多个成员
			   同时在运行，那么这个圆圈应该显示为同一级内上下文占用最多的那一个。成员下派的
			   子智能体那一级别（也就是该显示紫色的那一部分），上下文占用要显示最少的那个。」
			   即：
			     · Lead 在跑（绿）/ error / approval / idle ⇒ 用 Lead 自己的占用 contextMeter.percent
			     · 只有成员在跑（蓝）⇒ 用 host 算好的**成员级最大** teamContextPercent
			     · 只有更深层在跑（紫）⇒ 用 host 算好的**深层最小** deepContextPercent
			   「最大 / 最小」由 host 在那一级内部先算好（它才看得到每个子会话的占用），
			   客户端只负责"切数据源"，不在前端重新聚合。
			   分层百分比为 null（老 host / 算不出）⇒ **退回 contextMeter.percent**：
			   不能显示 0，否则圆环会突然空掉，看着像坏了。
			   开发模式下用 fixture 自带的分层值（`devData.devSrc.agentTiers`）：真实 host 在开发模式里
			   一次请求都不发，`subagentTiers` 永远是空对象，蓝紫两格的弧长就只能靠它。 */
			const ringTiers = devData !== null && devData.devSrc !== undefined && devData.devSrc !== null
				&& devData.devSrc.agentTiers !== undefined && devData.devSrc.agentTiers !== null
				? devData.devSrc.agentTiers
				: subagentTiers;
			const ringPercent = ringPercentOf(contextMeter, agentState, ringTiers);
			/* 圆环自己就是触发项：点开上下文占用面板；峰谷那两个字不带气泡 */
			const contextTip = contextMeter === null ? null : { kind: "meter", meter: contextMeter };
			const children = [];
			if (contextTip !== null) {
				children.push(h("button", {
					type: "button",
					className: "dsb-ring-btn",
					key: "__ringbtn",
					"aria-expanded": tipId === "context" ? "true" : "false",
					onClick: (event) => toggleTip("context", event)
				}, [
					contextRing(ringPercent, agentState, contextMeter.compact),
					tipId === "context" ? tipPanelOf(contextTip) : null
				]));
			}
			let lastShown = null;
			views.forEach((view) => {
				if (view.text === "") return;
				if (lastShown !== null) {
					children.push(h("span", { className: "dsb-sep", key: "__sep" + view.id }, "|"));
				}
				lastShown = view;
				const tip = view.tip === undefined ? null : view.tip;
				children.push(h("span", {
					className: tip !== null ? "dsb-seg dsb-seg-click" : "dsb-seg",
					key: "__seg" + view.id,
					"aria-expanded": tip !== null ? (tipId === view.id ? "true" : "false") : undefined,
					onClick: tip !== null ? (event) => toggleTip(view.id, event) : undefined
				}, tip !== null
					? [h("span", { key: "__txt" }, view.text), tipId === view.id ? tipPanelOf(tip) : null]
					: view.text));
			});
			/* 工具彩条悬停：**不要气泡**，只渲染一行文字（工具名 + 占比），贴在鼠标上方。
			   字号 11px（比悬停浮层的 10px 大、比标题 12px 小），无背景/圆角/描边。
			   放不下时整组不显示（见 plainFits），**不做缩放**，所以这里只给 left/top。 */
			if (hoverPlain !== null) {
				const hoverStyle = hoverPos === null
					? undefined
					: { left: hoverPos.left + "px", top: hoverPos.top + "px" };
				children.push(h("span", {
					className: "dsb-hover-plain",
					key: "__hoverplain",
					ref: hoverRef,
					style: hoverStyle
				}, hoverPlain));
			}
			/* 悬停浮层：与主气泡同一套质感，fixed 定位在触发元素上方。
			   必须先挂上节点（此时 pos 还是 null、不给 left/bottom），
			   layout effect 才量得到宽度并把坐标算出来 —— 否则会永远卡在"没有坐标"而不显示。 */
			if (hoverCard !== null) {
				children.push(h("span", {
					className: "dsb-tip dsb-meter dsb-hovercard",
					key: "__hovercard",
					ref: hoverRef,
					style: hoverPos === null ? undefined : { left: hoverPos.left + "px", top: hoverPos.top + "px", width: hoverPos.width + "px" },
					onClick: stopTipClick,
					onMouseDown: stopTipClick
				}, hoverCard));
			}
			return h("span", {
				ref: rootRef,
				className: "dsb-root",
				"data-dsb": "bar"
			}, children);
		}

		/* -------------------------------------------------------------- 设置页 */

		/* 编辑浮层滚进视野时底部留的余量（像素）：贴着容器底边太紧，看着像还被裁着 */
		const REVEAL_MARGIN = 12;

		/**
		 * 找一个元素"最近的可滚动祖先"：沿 parent 链往上，第一个 overflow-y 为
		 * auto/scroll 且内容确实比自身高（scrollHeight > clientHeight）的元素。
		 * 找不到就退回 `document.scrollingElement`（整页滚动的情况）；再没有就返回 null。
		 *
		 * 为什么要这么找：设置面板不一定由 window 在滚 —— 面板内部可能就是个可滚容器，
		 * 那样 window.scrollY 一动不动，把浮层底部带进来的唯一办法是改那个容器的 scrollTop。
		 */
		function scrollParentOf(node) {
			let one = node === null || node === undefined ? null : node.parentElement;
			while (one !== null && one !== undefined) {
				const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(one) : null;
				const overflowY = style === null || style === undefined ? "" : String(style.overflowY);
				if ((overflowY === "auto" || overflowY === "scroll")
					&& typeof one.scrollHeight === "number" && typeof one.clientHeight === "number"
					&& one.scrollHeight > one.clientHeight) return one;
				one = one.parentElement;
			}
			if (document !== undefined && document !== null && document.scrollingElement !== undefined) {
				return document.scrollingElement;
			}
			return null;
		}

		/** 把 node 的**底边**带进滚动容器的可视区：只补"被裁掉的那一段 + 余量"，没被裁就不动。 */
		function revealBottom(node) {
			if (node === null || node === undefined || typeof node.getBoundingClientRect !== "function") return;
			const box = node.getBoundingClientRect();
			if (box.height <= 0) return;
			const scroller = scrollParentOf(node);
			if (scroller === null || scroller === undefined) return;
			const rect = typeof scroller.getBoundingClientRect === "function" ? scroller.getBoundingClientRect() : null;
			const limit = rect === null || rect.bottom <= 0
				? (typeof scroller.clientHeight === "number" ? scroller.clientHeight : 0)
				: rect.bottom;
			const overflow = box.bottom + REVEAL_MARGIN - limit;
			if (overflow <= 0) return;   /* 本来就在视野里：一动不动（旧版 block:"end" 会平白上滚） */
			scroller.scrollTop = (typeof scroller.scrollTop === "number" ? scroller.scrollTop : 0) + overflow;
		}

		function SettingsSection(props) {
			const t = props.t;
			const cfg = useConfig();
			const update = useUpdateState();
			/* 开发模式的状态**只读模块级那一份**（useDevState 订阅 publishDev）。
			   以前这里是组件本地的 `devOn` useState，那是"开发模式只影响设置页"时代的做法；
			   现在开发模式还接管了**底栏**的假数据（底栏在对话页），本地 state 会带来两个毛病：
			     ① 关掉设置页再打开，胶囊消失而底栏仍是假数据（两边不同步）；
			     ② 从设置页以外的入口进出开发模式时，这里读不到。
			   改用模块级快照后组件不再持有副本，也就不存在"两边不一致"这回事。
			   **不给它可见开关**：入口仍是页脚版本号的「连点 5 次」（见 onVersionClick），
			   进入后标题右侧挂一枚「开发模式」胶囊 —— 那是唯一的可见迹象。 */
			const devState = useDevState();
			const devOn = devState.on === true;

			/* 版本号被点击：累计连点次数，够 5 次就切换开发模式。
			   计数与时间窗都在模块级（onVersionClick）；
			   切换成功后 setDevMode 里的 publishDev 会通知订阅者，本组件因此自然重渲染 ——
			   这里**不需要**再自己 setState。 */
			const onVersionClicked = () => onVersionClick();
			/* 这里**刻意不再有**「卸载时把开发模式关掉」的复位 effect。
			   那条复位是旧设计的残留：那时开发模式只影响设置页那颗更新按钮，卸载后不复位会留下
			   "按钮显示演示版本号、胶囊却没了"的状态。现在开发模式接管了**底栏的假数据**，
			   而底栏在对话页 —— 关掉设置页就把开发模式一起关掉，等于把对话页的假数据也带没了。
			   用户已确认：**开发模式跨页面一直存在是预期行为**，要退出就连点版本号，不是关页面。
			   卸载时仍然要清的只有「更新中」那一步的演示定时器（见 setDevMode 里那段），
			   它由 setDevMode 自己管着，且模块级定时器不随组件卸载泄漏。 */

			/* 自绘拖拽：全程用 pointer 事件自己跟手。不用原生 HTML5 拖拽 ——
			   原生拖拽会话期间浏览器不给页面 wheel 事件（滚轮失灵），而且只有松手才换位。 */
			const [drag, setDrag] = react.useState(null);   /* { id, from, to, dy, startY, height, rects } */
			const [newModel, setNewModel] = react.useState("");
			const [hostModel, setHostModel] = react.useState(null);
			const [editing, setEditing] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [holidayBusy, setHolidayBusy] = react.useState(false);
			const [holidayNote, setHolidayNote] = react.useState(null);
			const [currencyOpen, setCurrencyOpen] = react.useState(false);
			const currencyRef = react.useRef(null);
			const editPopRef = react.useRef(null);
			/* 币种下拉的**菜单节点**（不是那个按钮）：展开后要把它滚进视野 */
			const currencyMenuRef = react.useRef(null);

			/* 设置页里会"向下展开"的浮层，统一走这一个钩子把底边带进视野。
			   旧实现用浏览器自带的"滚进视野"接口（block:nearest），而 ① 浮层自身比可视区高时
			   它只保证顶部对齐、底部永远进不来；② 设置面板外层是个可滚容器，滚 window 没用。
			   所以改成：找最近的可滚祖先 → 按"底边 + 12px 余量 − 容器可视底边"的差值加 scrollTop
			   （没被裁就一动不动）。CSS/字体度量可能让高度到下一帧才稳定，所以再用一帧复测补滚
			   一次（rAF，不是定时器 —— 底栏的定时器数量有断言盯着）。
			   参数：`ref` 指向浮层节点本身；`active` 为 true 才起作用；`extraKey` 是"会让这个
			   浮层高度变化"的附加信号（例如勾上峰谷计价会多出一档）。 */
			const useRevealBottom = (ref, active, extraKey) => {
				react.useEffect(() => {
					if (active !== true) return undefined;
					const retry = () => revealBottom(ref.current);
					retry();
					let frame = 0;
					if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
						frame = window.requestAnimationFrame(retry);
					}
					return () => {
						if (frame !== 0 && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
							window.cancelAnimationFrame(frame);
						}
					};
				}, [active, extraKey]);
			};

			/* 编辑浮层打开后把它的**底边**带进视野（不是顶部对齐，也不是平白上滚）。
			   **实测根因**（本轮修的）：旧实现用浏览器自带的"滚进视野"接口（block:nearest），
			   而 ① 浮层自身比可视区高时它只保证顶部对齐，底部永远进不来；② 设置面板外层
			   是个可滚容器，滚窗口没用。所以勾上「峰谷计价」多出一档、浮层变高之后，
			   底部就落在可视区外，用户还得手动往下滚一下（截图箭头处）。
			   现在：找最近的可滚祖先 → 按"底边 + 12px 余量 − 容器可视底边"的差值加 scrollTop。
			   **依赖里带 draft.tiered**：勾选会撑高浮层，必须重算一次。
			   CSS/字体度量可能让高度到下一帧才稳定，所以再用一帧复测补滚一次
			   （rAF，不是定时器 —— 底栏的定时器数量有断言盯着）。 */
			/* 价格编辑浮层：打开时、以及勾上「峰谷计价」把它撑高之后各滚一次 */
			useRevealBottom(editPopRef, editing !== null, draft === null ? null : draft.tiered);
			/* 币种下拉菜单（CNY/USD）：展开后同样按底部溢出量滚进视野。
			   用户实测反馈"还要手动滚一下"的就是它 —— 上一轮只接到了价格编辑浮层。 */
			useRevealBottom(currencyMenuRef, currencyOpen === true, null);
			/**
			 * 币种下拉控件（**只在条目的编辑浮层里用一处**：与三个价格框同一处、无文字标签）。
			 *
			 * 切换时只改**这一条**：`setModelCurrency` 按"官方内置 → 官方另一套定死值 /
			 * 其它 → 数值不动只换标记"处理。草稿分两种接法：
			 *   · 官方内置且没被改过 → 按新币种的官方数字**重建草稿**（框里要显示新币种那一套）；
			 *   · 其余（自建条目、或用户已改过价）→ 数值一个字没动，**只换草稿的币种标记**，
			 *     用户已经填好、还没点保存的输入必须原样留在框里
			 *     （实测反馈：切一下币种，刚填的价格就被清空了）。
			 */
			const currencySelect = (key, draftNow, open, setOpen, menuRef, boxRef) => {
				const value = normalizeCurrency(draftNow === null || draftNow === undefined ? cfg.currency : draftNow.currency);
				const pick = (code) => {
					setOpen(false);
					if (editing === null || draftNow === null || draftNow === undefined) return;
					const changed = setModelCurrency(editing, code, draftNow);
					if (changed === null) return;
					if (changed.replaced === true) {
						startEdit(editing, changed.entry);
						return;
					}
					/* 整份重建会连用户没保存的输入一起丢掉 —— 这里只换币种标记，三个价格框的值保持不变 */
					setDraft({
						tiered: draftNow.tiered,
						currency: normalizeCurrency(code),
						peak: draftNow.peak,
						offPeak: draftNow.offPeak
					});
				};
				return h("div", { className: "dsb-select", key: key, ref: boxRef }, [
					h("button", {
						type: "button",
						className: "dsb-select-btn",
						"aria-haspopup": "listbox",
						"aria-expanded": open === true ? "true" : "false",
						onClick: () => setOpen(open !== true)
					}, value),
					open === true
						? h("div", { className: "dsb-select-menu", role: "listbox", ref: menuRef },
							["CNY", "USD"].map((code) => h("button", {
								type: "button",
								key: code,
								role: "option",
								"aria-selected": value === code ? "true" : "false",
								className: value === code ? "dsb-select-item dsb-select-item-on" : "dsb-select-item",
								onClick: () => pick(code)
							}, code)))
						: null
				]);
			};

			/* 编辑浮层：点别处收起并丢弃草稿。判断"里面"上三重保险 —— 浮层节点、价格卡节点，
			   以及鼠标坐标是否落在卡片或币种下拉的矩形内。切币种时点在卡片内的控件上，
			   无论 DOM 结构怎么变都不该把编辑区收掉。 */
			react.useEffect(() => {
				if (editing === null) return undefined;
				const inside = (event) => {
					const target = event.target;
					if (target !== null && target !== undefined && typeof target.closest === "function"
						&& target.closest(".dsb-model") !== null) return true;
					const node = editPopRef.current;
					if (node !== null && node !== undefined && typeof node.contains === "function" && node.contains(target)) return true;
					const x = event.clientX;
					const y = event.clientY;
					if (typeof x !== "number" || typeof y !== "number") return false;
					return [node, currencyRef.current].some((one) => {
						if (one === null || one === undefined || typeof one.getBoundingClientRect !== "function") return false;
						const box = one.getBoundingClientRect();
						return box.width > 0 && box.height > 0
							&& x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
					});
				};
				const onDocClick = (event) => {
					if (inside(event)) return;
					cancelEdit();
				};
				document.addEventListener("click", onDocClick);
				return () => document.removeEventListener("click", onDocClick);
			}, [editing]);

			/* 币种下拉：点外部收起（和底栏气泡同一套规矩，不跟着滚动关） */
			react.useEffect(() => {
				if (currencyOpen !== true) return undefined;
				const onDocClick = (event) => {
					if (currencyRef.current !== null && currencyRef.current.contains(event.target)) return;
					setCurrencyOpen(false);
				};
				document.addEventListener("click", onDocClick);
				return () => document.removeEventListener("click", onDocClick);
			}, [currencyOpen]);

			/* 当前会话模型：底栏在模型一变时就 POST 给 host（那个 effect 依赖 sessionModel），
			   所以 host 的投影始终最新；设置页进来读一次就够，不需要轮询。
			   **开发模式开着时一次真实请求都不发**（项目硬约束）：这时底栏吃的是假数据，
			   设置页显示的"当前会话使用"也是假的，再去问真实 host 既没意义、又破坏
			   「开发模式纯本地」这个前提。依赖里必须带 devOn：退出开发模式后要真去取一次，
			   否则设置页会一直停在「未识别」。 */
			react.useEffect(() => {
				if (devOn === true) return undefined;
				let alive = true;
				window.fetch(ACTIVE_MODEL_URL, { cache: "no-store" })
					.then((response) => response.json())
					.then((data) => {
						if (alive !== true) return;
						const model = data !== null && data !== undefined && typeof data.model === "string" && data.model.length > 0 ? data.model : null;
						setHostModel(model);
					})
					.catch(() => { /* 拿不到就保持未识别 */ });
				return () => { alive = false; };
			}, [devOn]);

			/* ---- 价格库操作：先改草稿，点保存才写入配置 ---- */
			/* 顺序来自 modelOrder：新加的模型追加在末尾 */
			const modelOrder = Array.isArray(cfg.modelOrder) ? cfg.modelOrder : [];
			const modelNames = modelOrder.filter((name) => cfg.models[name] !== undefined)
				.concat(Object.keys(cfg.models).filter((name) => modelOrder.indexOf(name) === -1));
			function addModel() {
				const name = newModel.trim();
				if (name.length === 0 || cfg.models[name] !== undefined) return;
				const next = Object.assign({}, cfg.models);
				/* 新增条目的币种一律 **CNY**：界面上已经没有全局币种选择器了（用户要求去掉），
				   所以"新增时用哪种币"这件事不再由界面决定。`config.currency` 只留作**内部默认值**
				   （老配置迁移时给条目落初值、以及认不出主模型时底栏的后备显示币种），界面不暴露它；
				   用户要按美元记某个模型，就在该条目的编辑浮层里把币种选成 USD。 */
				next[name] = {
					tiered: false,
					currency: "CNY",
					peak: Object.assign({}, EMPTY_TIER),
					offPeak: Object.assign({}, EMPTY_TIER)
				};
				setNewModel("");
				setConfig({
					models: next,
					modelOrder: (Array.isArray(cfg.modelOrder) ? cfg.modelOrder : Object.keys(cfg.models)).concat([name])
				});
				startEdit(name, next[name], true);   /* 新加的模型直接展开待填：框留空，不预填 0 */
			}
			function removeModel(name) {
				const next = Object.assign({}, cfg.models);
				delete next[name];
				setConfig({
					models: next,
					modelOrder: (Array.isArray(cfg.modelOrder) ? cfg.modelOrder : Object.keys(cfg.models)).filter((x) => x !== name)
				});
				if (editing === name) cancelEdit();
			}
			/**
			 * 打开编辑：把价格抄进草稿，**没填的格子留空**（连 0 都不显示），别拿 0 冒充"已经有价"。
			 * 判定逐格做：值是 `null` 就是没填过 → 空框；数字（含用户明确填的 0）→ 照实显示。
			 * 只有两种情况让整栏都空：① 刚新增还没保存（blank=true）；
			 * ② 旧版本遗留的"全 0 条目"—— 那时没有 null，只能整体按没填过处理。
			 */
			function startEdit(name, preset, blank) {
				const stored = preset === undefined ? cfg.models[name] : preset;
				const entry = normalizePrice(stored);
				const untouched = blank === true || isLegacyZeroEntry(stored);
				const asText = (tier) => ({
					input: untouched === true || tier.input === null || tier.input === undefined ? "" : String(tier.input),
					cacheRead: untouched === true || tier.cacheRead === null || tier.cacheRead === undefined ? "" : String(tier.cacheRead),
					cacheWrite: untouched === true || tier.cacheWrite === null || tier.cacheWrite === undefined ? "" : String(tier.cacheWrite),
					output: untouched === true || tier.output === null || tier.output === undefined ? "" : String(tier.output)
				});
				setDraft({
					tiered: isTiered(stored),
					/* 条目的币种也进草稿：它在浮层里与三个价格框并排可改（改哪条只动哪条） */
					currency: stored !== null && stored !== undefined && stored.currency !== undefined && stored.currency !== null
						? normalizeCurrency(stored.currency)
						: normalizeCurrency(cfg.currency),
					peak: asText(entry === null ? EMPTY_TIER : entry.peak),
					offPeak: asText(entry === null ? EMPTY_TIER : entry.offPeak)
				});
				setEditing(name);
			}
			/** 收起并丢弃草稿。 */
			function cancelEdit() {
				setEditing(null);
				setDraft(null);
			}
			function setDraftValue(tierKey, field, value) {
				setDraft((prev) => {
					if (prev === null) return prev;
					const next = { tiered: prev.tiered, currency: prev.currency, peak: Object.assign({}, prev.peak), offPeak: Object.assign({}, prev.offPeak) };
					next[tierKey][field] = value;
					/* 勾了「峰谷计价」就按官方比例联动：填高峰 → 空闲 ÷2；填空闲 → 高峰 ×2，
					   用户只需要填一档。没勾（全天同价）时两档没有关系，另一档不动。 */
					if (prev.tiered === true) {
						const other = tierKey === "peak" ? "offPeak" : "peak";
						next[other][field] = linkedTierValue(value, tierKey === "peak");
					}
					return next;
				});
			}
			function setDraftTiered(on) {
				setDraft((prev) => {
					if (prev === null) return prev;
					if (prev.tiered === on) return prev;
					/* **只在勾上时清空**（用户要求："勾选后全部留空、等重新填"）。
					   为什么取消勾选不清：单档显示与计价用的就是 `peak` 那一行 —— 取消勾选是
					   `peak → peak`，同一行、不存在串档；会串档的只有"单档 → 高峰行"这一次，
					   而勾上时清空已经把它挡住了。双向清空会把用户**没动过**的数据静默抹掉
					   （实测：`peak.cacheWrite` 从 0 变 null、`peak.output` 从 8 变空），
					   那是用户可见的数据丢失，代价远大于"切换模式要重填"的收益。
					   `cacheWrite` 连勾上时也不清：界面从来不渲染这一格（历史遗留字段），
					   清掉等于改用户看不到的数据。 */
					const cleared = (tier) => (on === true
						? { input: "", cacheRead: "", output: "", cacheWrite: tier.cacheWrite }
						: tier);
					return { tiered: on, currency: prev.currency, peak: cleared(prev.peak), offPeak: cleared(prev.offPeak) };
				});
			}
			function saveDraft() {
				if (editing === null || draft === null) return;
				/* 逐格转换：空字符串（没填）保留成 `null`，填了的值按数字存 —— 用户明确填的 0 就是 0。
				   这样"只填一格"保存后，其余格子仍然是空的，不会再被写成 0。 */
				/* 空字符串 = 没填 → null；非法输入（粘贴进字母）也当没填，不要压成 0 ——
				   压成 0 会被当成"用户明确把价定成了 0"，第二轮匹配就会拿它算钱 */
				const asValue = (raw) => {
					if (raw === "") return null;
					const n = Number(raw);
					return Number.isFinite(n) === true ? n : null;
				};
				const asTier = (tier) => ({
					input: asValue(tier.input),
					cacheRead: asValue(tier.cacheRead),
					cacheWrite: asValue(tier.cacheWrite),
					output: asValue(tier.output)
				});
				const peak = asTier(draft.peak);
				const offPeak = asTier(draft.offPeak);
				/* 一个数都没填也**照常写入**（用户实测反馈：新建的自定义模型价格先空着，
				   点「保存」不该把整条删掉）。空条目不会把费用静默算成 0 —— 计价匹配层
				   `hasAnyPriceValue` 已把八格全空的条目挡在两轮之外（见那里的注释）。
				   真要取消添加，用卡片上的「删除」。 */
				const hasValue = (tier) => tier.input !== null || tier.cacheRead !== null
					|| tier.cacheWrite !== null || tier.output !== null;
				const next = Object.assign({}, cfg.models);
				next[editing] = {
					tiered: draft.tiered === true,
					/* 条目自己的币种：界面上的换法见 currencySelect 那处（换完按新币种重建草稿） */
					currency: normalizeCurrency(draft.currency),
					peak: peak,
					/* 两档都照实存：计价用哪一档看 tiered，取消勾选不该把空闲价抹掉 */
					offPeak: offPeak
				};
				/* 只有真填了数字才算"配置过价格"：一条全空的条目不该把"请填写价格"的提示顶掉 */
				if (hasValue(peak) === true || hasValue(offPeak) === true) {
					setConfig({ models: next, priceConfigured: true });
				} else {
					setConfig({ models: next });
				}
				setEditing(null);
				setDraft(null);
			}

			const sections = [];

			sections.push(h("div", { className: "dsb-head", key: "__head" }, [
				/* 标题那一行：开发模式开着时，标题文字右上角跟一枚胶囊 —— 像 x² 的上标那样
				   紧贴着标题，而不是甩到面板最右边（那样看不出是「这个标题的」标记）。
				   关着时这一行与原来**完全一样** —— 不多任何元素。 */
				h("div", { className: "dsb-titlerow", key: "__titlerow" },
					h("h2", { className: "dsb-pagetitle" }, t("sectionTitle")),
					devOn === true
						? h("span", { className: "dsb-nav-pill dsb-dev-pill", key: "__devpill", title: t("devModeHint") }, t("devModeBadge"))
						: null
				),
				h("p", { className: "dsb-intro" }, t("intro"))
			]));

			/* 统计段：段序对整份列表生效，勾选只控制显示，取消勾选不移位。
			   上下文占用是固定项：单独一行、没有拖拽把手，永远排在栏首。 */
			const byId = {};
			SEGMENTS.forEach((segment) => { byId[segment.id] = segment; });
			const orderedSegments = cfg.segments
				.map((id) => byId[id])
				.filter((segment) => segment !== undefined && segment !== null);

			/* 行节点 + 拖前位置：前者用来量落点，后者给 FLIP 补位移动画 */
			const rowNodes = react.useRef(new Map());
			const rowTops = react.useRef(null);
			/* 拖动是否还活着：pointerup 会被行和 window 各收到一次，靠它兜住重复落盘 */
			const draggingRef = react.useRef(false);
			const captureTops = () => {
				const tops = new Map();
				rowNodes.current.forEach((node, id) => {
					if (node !== null && node !== undefined && typeof node.getBoundingClientRect === "function") {
						tops.set(id, node.getBoundingClientRect().top);
					}
				});
				rowTops.current = tops;
			};

			const measure = (segmentId) => {
				const node = rowNodes.current.get(segmentId);
				return node !== null && node !== undefined && typeof node.getBoundingClientRect === "function"
					? node.getBoundingClientRect()
					: null;
			};

			const startDrag = (id, index, event) => {
				const at = measure(id);
				const anchor = measure("__context");
				draggingRef.current = true;
				setDrag({
					id: id, from: index, to: index, at: at,
					/* 指针在行内的抓取位置：浮层位置和落点都由它推出来，不依赖按下时的绝对坐标 */
					grab: at === null || at === undefined ? 0 : event.clientY - at.top,
					cardTop: at === null || at === undefined ? event.clientY : at.top,
					pointerY: event.clientY,
					/* 各槽位按下那一刻的真实矩形；滚动多少由锚点差值补回来 */
					slots: orderedSegments.map((one) => measure(one.id)),
					anchorTop: anchor === null || anchor === undefined ? 0 : anchor.top,
					/* base 是按下那一刻的顺序：每次换位都从它重算，不会累积误差 */
					base: cfg.segments.slice(),
					order: cfg.segments.slice()
				});
			};

			/* 按给定指针位置重算落点。单独抽出来是因为滚轮滚动不产生 pointermove，
			   滚动时得靠 scroll 事件带着"上一次的指针位置"再算一遍，影子才不会落在后面。 */
			const applyDrop = (current, pointerY) => {
				const cardTop = pointerY - current.grab;
				const height = current.at === null || current.at === undefined ? 0 : current.at.height;
				/* 锚点每次实时量：中途滚了滚轮，按下时的坐标早就失效了 */
				const anchor = measure("__context");
				const shift = anchor === null || anchor === undefined ? 0 : anchor.top - current.anchorTop;
				const to = dropIndexAt(current.slots, shift, current.from, cardTop, cardTop + height);
				/* 落点和指针都没动就别重渲染：滚动事件很密，大多数帧其实什么都没变 */
				if (to === current.to && cardTop === current.cardTop) return;
				if (to !== current.to) captureTops();   /* 顺序要变了，先记下当前位置 */
				setDrag({
					id: current.id, from: current.from, to: to, cardTop: cardTop, pointerY: pointerY,
					grab: current.grab, at: current.at, slots: current.slots, anchorTop: current.anchorTop,
					base: current.base,
					order: moveItem(current.base, current.from, to)
				});
			};

			const moveDrag = (event) => {
				if (drag === null) return;
				/* 指针已经松开（截屏工具之类把 pointerup 吃掉了）：按取消处理，回原位 */
				if (event.buttons === 0) {
					cancelDrag();
					return;
				}
				applyDrop(drag, event.clientY);
			};

			/* 松手才落盘：拖动全程只在内存里重排，config 一动不动 */
			const endDrag = () => {
				if (draggingRef.current !== true || drag === null) return;
				draggingRef.current = false;
				if (drag.to !== drag.from) setConfig({ segments: drag.order });
				setDrag(null);
			};

			/* 拖动被系统打断（截屏、切窗口、指针事件丢失）：回原位，什么账都不记 */
			const cancelDrag = () => {
				if (draggingRef.current !== true) return;
				draggingRef.current = false;
				setDrag(null);
			};

			/* 拖动中的重排没有过渡可言：DOM 顺序一变，行就是瞬移。
			   这里把移动补回来 —— 变之前记下位置，变之后先反推回原处，再过渡回去。 */
			useTipLayout(() => {
				const before = rowTops.current;
				if (before === null) return;
				rowTops.current = null;
				rowNodes.current.forEach((node, id) => {
					if (node === null || node === undefined || node.style === undefined) return;
					const was = before.get(id);
					if (was === undefined) return;
					const delta = was - node.getBoundingClientRect().top;
					if (delta === 0) return;
					node.style.transition = "none";
					node.style.transform = "translateY(" + delta + "px)";
					void node.offsetHeight;   /* 强制回流，否则紧接着的过渡不会触发 */
					node.style.transition = "transform .18s ease";
					node.style.transform = "";
				});
			}, [drag === null ? "" : drag.order.join(",")]);

			/* 指针事件再挂一份到 window 兜底：被拖的那一行在拖动中会重排，指针捕获一旦丢了，
			   pointerup 就永远收不到，浮层会一直粘着鼠标。挂在 window 上不受重排影响。
			   顺带在拖动期间禁掉文本选中 —— 长按拖动会把整页文字刷成蓝底。 */
			const dragMoveRef = react.useRef(null);
			const dragEndRef = react.useRef(null);
			const dragCancelRef = react.useRef(null);
			const dragRef = react.useRef(null);
			const dragDropRef = react.useRef(null);
			dragMoveRef.current = moveDrag;
			dragEndRef.current = endDrag;
			dragCancelRef.current = cancelDrag;
			dragRef.current = drag;
			dragDropRef.current = applyDrop;
			react.useEffect(() => {
				if (drag === null) return undefined;
				const onMove = (event) => { if (dragMoveRef.current !== null) dragMoveRef.current(event); };
				const onUp = () => { if (dragEndRef.current !== null) dragEndRef.current(); };
				/* 打断 = 取消（回原位），绝不能当成落点：截屏工具常把 pointerup 整个吃掉 */
				const onCancel = () => { if (dragCancelRef.current !== null) dragCancelRef.current(); };
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
				window.addEventListener("pointercancel", onCancel);
				window.addEventListener("blur", onCancel);
				/* 滚轮滚动不产生 pointermove：不补这一手，影子会落在后面，要再动一下鼠标才跟上 */
				const onScroll = () => {
					const current = dragRef.current;
					if (current !== null && dragDropRef.current !== null) dragDropRef.current(current, current.pointerY);
				};
				window.addEventListener("scroll", onScroll, true);
				const body = document === undefined || document === null ? undefined : document.body;
				const style = body === undefined || body === null ? undefined : body.style;
				/* 禁选：长按拖动会把整页文字刷成蓝底；抓手：光标统一，不再忽抓忽指 */
				const hadSelect = style === undefined ? null : style.userSelect;
				const hadCursor = style === undefined ? null : style.cursor;
				if (hadSelect !== null) style.userSelect = "none";
				if (hadCursor !== null) style.cursor = "grabbing";
				return () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					window.removeEventListener("pointercancel", onCancel);
					window.removeEventListener("blur", onCancel);
					window.removeEventListener("scroll", onScroll, true);
					if (hadSelect !== null) style.userSelect = hadSelect;
					if (hadCursor !== null) style.cursor = hadCursor;
				};
			}, [drag === null]);

			const contextRow = h("div", {
				className: "dsb-row",
				key: "__context",
				/* 落点靠它算槽位几何：它在栏首、不参与排序、也没有过渡动画，位置最稳 */
				ref: (node) => {
					if (node === null || node === undefined) rowNodes.current.delete("__context");
					else rowNodes.current.set("__context", node);
				}
			},
				h("label", { className: "dsb-check" },
					h("input", {
						type: "checkbox",
						checked: cfg.contextMeter === true,
						onChange: (event) => setConfig({ contextMeter: event.target.checked })
					}),
					h("span", { className: "dsb-labels" },
						h("span", { className: "dsb-name" }, t("segContext")),
						h("span", { className: "dsb-desc" }, t("segContextHint"))
					)
				)
			);

			/* 行内容抽出来：列表里的行和跟手的浮层共用同一份 */
			const rowParts = (segment, on) => [
				h("label", { className: "dsb-check", key: "__check" },
					h("input", {
						type: "checkbox",
						checked: on,
						onChange: (event) => toggleSegment(segment.id, event.target.checked)
					}),
					h("span", { className: "dsb-labels" },
						h("span", { className: "dsb-name" }, t(segment.label)),
						h("span", { className: "dsb-desc" }, t(segment.hint))
					)
				),
				h("span", {
					className: on === true ? "dsb-handle" : "dsb-handle dsb-handle-off",
					title: on === true ? t("dragHint") : "",
					key: "__handle"
				})
			];

			/* 拖动中就地按落点排好：列表里被拖那一格留淡影，跟手的是上面的浮层 */
			const visibleOrder = drag === null ? cfg.segments : drag.order;
			const visibleSegments = visibleOrder
				.map((id) => byId[id])
				.filter((segment) => segment !== undefined && segment !== null);

			const segmentRows = visibleSegments.map((segment, index) => {
				const on = isSegmentOn(cfg, segment.id);
				const dragged = drag !== null && drag.id === segment.id;
				return h("div", {
					className: dragged === true ? "dsb-row dsb-dragging" : "dsb-row",
					key: segment.id,
					ref: (node) => {
						if (node === null || node === undefined) rowNodes.current.delete(segment.id);
						else rowNodes.current.set(segment.id, node);
					},
					onPointerDown: (event) => {
						if (event.button !== 0) return;
						/* 只有右侧那六个点能抓：整行可抓会跟勾选、选中文字打架 */
						const target = event.target;
						if (target === null || target === undefined) return;
						if (String(target.className === undefined ? "" : target.className).indexOf("dsb-handle") === -1) return;
						startDrag(segment.id, index, event);
					},
					onPointerMove: dragged === true ? moveDrag : undefined,
					onPointerUp: dragged === true ? endDrag : undefined,
					onPointerCancel: dragged === true ? cancelDrag : undefined
				}, rowParts(segment, on));
			});

			/* 跟着鼠标的那张卡：位置锁在按下那一行的矩形上，纵向随 dy 走。
			 *
			 * **必须 portal 到 body**（2026-10-07 实测）：壁纸引擎给设置面板挂了
			 * `backdrop-filter`（body[data-we-glass-window] [role="dialog"]:has([data-slot="settings.section"])），
			 * 而非 none 的 backdrop-filter 会让该元素成为 position:fixed 后代的**包含块**，
			 * 于是这张本该相对视口定位的卡改成相对设置面板定位 —— 实测偏移 dx=220/dy=80；
			 * 设置面板又自带 overflow:hidden（.wCInkW_panel），浮层随即被裁掉一截。
			 * 挂到 body 下就没有这个祖先了，fixed 恢复视口锚定，也不受面板裁剪。
			 * 取不到 createPortal 时退回就地渲染：功能照旧，只是那层玻璃在场时会偏。 */
			const dragCardNode = drag === null || drag.at === null || drag.at === undefined ? null : h("div", {
				className: "dsb-drag-card",
				key: "__dragcard",
				style: {
					left: drag.at.left + "px",
					top: drag.cardTop + "px",
					width: drag.at.width + "px",
					height: drag.at.height + "px"
				}
			}, rowParts(byId[drag.id], isSegmentOn(cfg, drag.id)));
			const dragCard = dragCardNode === null
				? null
				: (canPortal === true && typeof document !== "undefined" && document !== null && document.body !== undefined && document.body !== null
					? reactDom.createPortal(dragCardNode, document.body)
					: dragCardNode);

			sections.push(h("div", { className: "dsb-section", key: "__segments" },
				h("div", { className: "dsb-sectitle" }, t("secSegments")),
				h("p", { className: "dsb-hint" }, t("secSegmentsHint")),
				contextRow,
				segmentRows,
				dragCard
			));

			/* 自定义模型价格 */
			const priceCards = [];
			priceCards.push(h("div", { className: "dsb-hint", key: "__pricehint" }, t("secPricesHint")));
			/* 价格区顶部**没有**全局币种选择器（用户明确要求去掉那个残留）：
			   币种只在每个条目的编辑浮层里选，改哪条只动哪条。 */
			/* 「更新节假峰谷」+ 它的状态提示：按钮右边只在点过之后出现状态 ——
			   搜索中 / 已写入概况，平时不占位。抓取失败的原因挪到按钮的悬停提示里 */
			const holidayStatus = holidaySummary(Date.now());
			/* 抓取「下一年」的安排有两种收场：
			   ① 官方还没发布（not-found / parse-empty）—— 不算出错，照常显示已写入的本年数量；
			   ② 真出问题（后台旧版没这个路由、或 HTTP 报错）—— 把原因显示出来，别让人以为写成功了。 */
			const holidayQuiet = holidayNote !== null && holidayNote.ok !== true
				&& (holidayNote.reason === "not-found" || holidayNote.reason === "parse-empty");
			const holidayFailure = holidayNote === null || holidayNote.ok === true || holidayQuiet
				? null
				: (holidayNote.reason === "no-route"
					? t("holidayUpdateNoRoute")
					: t("holidayUpdateFail", { reason: holidayNote.reason }));
			/* 状态提示排在按钮**前面**：它出现或变长时按钮的右边界不动（按钮钉在卡右端）。
			   按钮不挂 title —— 悬停不弹气泡，失败原因直接写进左边那句状态里。 */
			const holidayActions = [];
			if (holidayBusy === true || holidayNote !== null) {
				holidayActions.push(h("span", { className: "dsb-hint", key: "__holidaystatus" },
					holidayBusy === true
						? t("holidayUpdateBusy")
						: (holidayFailure === null
							? t("holidayUpdateOk", { year: holidayStatus.year, count: holidayStatus.count })
							: holidayFailure)));
			}
			holidayActions.push(h("button", {
				type: "button",
				className: "dsb-action",
				key: "__holiday",
				disabled: holidayBusy === true,
				onClick: () => {
					const year = nextHolidayYear(Date.now());
					setHolidayBusy(true);
					setHolidayNote(null);
					updateHolidays(year).then((result) => {
						setHolidayBusy(false);
						setHolidayNote(result);
					});
				}
			}, t("holidayUpdate")));
			/* "当前会话使用"提示：设置页是否能拿到投影由宿主决定，拿不到就显示占位 */
			const settingsModel = typeof props.useProjection === "function" ? props.useProjection("desktopStatusbarModel") : undefined;
			const currentModelName = settingsModel !== null && settingsModel !== undefined && typeof settingsModel.model === "string"
				? settingsModel.model
				: null;
			const shownModel = currentModelName !== null ? currentModelName : hostModel;
			priceCards.push(h("div", { className: "dsb-current", key: "__current" }, [
				h("span", { key: "__currentname" }, [
					t("priceCurrent") + " ",
					h("b", null, shownModel === null ? t("modelUnknown") : displayModelName(shownModel))
				]),
				/* 「更新节假峰谷」贴这一行的右端（与下面的添加/修改按钮同一条右边界）；
				   状态提示排在按钮左边，免得把按钮从右边界挤开 */
				h("span", { className: "dsb-current-act", key: "__currentact" }, holidayActions)
			]));
			if (cfg.priceConfigured !== true) {
				priceCards.push(h("div", { className: "dsb-hint", key: "__pricesuggest" }, t("priceSuggestedHint")));
			}
			/* 新增模型：夹在说明与模型列表之间 */
			priceCards.push(h("div", { className: "dsb-addrow", key: "__add" },
				h("input", {
					type: "text",
					placeholder: t("priceNewModel"),
					value: newModel,
					onChange: (event) => setNewModel(event.target.value),
					onKeyDown: (event) => { if (event.key === "Enter") addModel(); }
				}),
				h("button", { type: "button", className: "dsb-action", onClick: addModel }, t("priceAdd"))
			));
			if (modelNames.length === 0) {
				priceCards.push(h("div", { className: "dsb-hint", key: "__empty" }, t("priceEmpty")));
			}
			const modelRows = [];
			modelNames.forEach((name) => {
				const open = editing === name && draft !== null;
				const priceField = (tierKey, label, field) => h("label", { className: "dsb-field", key: tierKey + field },
					h("span", null, label),
					h("input", {
						type: "number",
						step: "0.01",
						min: "0",
						value: draft[tierKey][field],
						onChange: (event) => setDraftValue(tierKey, field, event.target.value)
					})
				);
				const tierRow = (tierKey, label) => h("div", { className: "dsb-tier", key: tierKey },
					label === null ? null : h("span", { className: "dsb-tier-name" }, label),
					h("div", { className: "dsb-fields" },
						priceField(tierKey, t("priceCacheRead"), "cacheRead"),
						priceField(tierKey, t("priceInput"), "input"),
						priceField(tierKey, t("priceOutput"), "output")
					)
				);
				/* 头部按钮自带行为：拦一下冒泡，别被"点别处收起编辑区"顺手收掉 */
				const action = (label, key, onClick) => h("button", {
					type: "button",
					key: key,
					className: "dsb-action dsb-action-sm",
					onClick: (event) => {
						if (event !== undefined && event !== null && typeof event.stopPropagation === "function") event.stopPropagation();
						onClick();
					}
				}, label);
				const head = h("div", { className: "dsb-model-head", key: "__head" },
					h("span", { className: "dsb-model-name" }, displayModelName(name)),
					h("div", { className: "dsb-model-actions" },
						open === true ? action(t("priceSave"), "__save", saveDraft) : action(t("priceEdit"), "__edit", () => startEdit(name)),
						action(t("priceRemove"), "__remove", () => removeModel(name))
					)
				);
				/* 编辑区做成毛玻璃浮层（与底栏气泡、计价单位下拉同一套材质），从卡片头部下方展开 */
				const body = open === true
					? h("div", { className: "dsb-edit-pop", key: "__edit", ref: editPopRef }, [
						/* 这一行左边是「峰谷计价」勾选，右边挂**本条目的**币种下拉：
						   改哪条只动哪条（换算也只换算这一条的数值），与三个价格框同一处。 */
						h("div", { className: "dsb-tier-head", key: "__tiered" },
							h("label", { className: "dsb-inline-check" },
								h("input", {
									type: "checkbox",
									checked: draft.tiered === true,
									onChange: (event) => setDraftTiered(event.target.checked)
								}),
								h("span", null, t("priceTiered"))
							),
							h("div", { className: "dsb-currency-pick", key: "__curpick" },
								currencySelect("__entrycur", draft, currencyOpen, setCurrencyOpen, currencyMenuRef, currencyRef)
							)
						),
						/* 未勾选时那行也有档位名（「全时段」），与勾选后的高峰/空闲两行结构一致，
						   布局自然一致 —— 取代原先靠 CSS 做的双边对齐 */
						draft.tiered === true ? tierRow("offPeak", t("priceTierOffPeak")) : tierRow("peak", t("priceTierAllDay")),
						draft.tiered === true ? tierRow("peak", t("priceTierPeak")) : null
					])
					: null;
				modelRows.push(h("div", { className: "dsb-model", key: name }, head, body));
			});
			if (modelRows.length > 0) {
				priceCards.push(h("div", { className: "dsb-models", key: "__models" }, modelRows));
			}
			sections.push(h("div", { className: "dsb-section", key: "__prices" },
				h("div", { className: "dsb-sectitle" }, t("secPrices")),
				h("div", { className: "dsb-card" }, priceCards)
			));

			/* 收尾：GitHub 支持 + 恢复默认；版本标记贴右。
			   「更新节假峰谷」已挪到上面价格卡那一行的右端。 */
			sections.push(h("div", { className: "dsb-foot", key: "__foot" }, [
				/* 外层只负责定位：悬停提示的毛玻璃沿用主气泡那套 .dsb-tip 材质 */
				h("span", { className: "dsb-star-wrap", key: "__starbox" }, [
					h("span", { className: "dsb-tip dsb-star-tip", key: "__startip" }, t("starTip")),
					h("button", {
						type: "button",
						className: "dsb-action",
						key: "__star",
						/* 点完**主动松开焦点**再跳转。气泡的显示条件是 `:hover` 或 `:focus-within`；
						   点击会让按钮获得 DOM 焦点，而跳去浏览器只让**窗口**失焦、DOM 焦点还留在按钮上 ——
						   于是 `:focus-within` 一直为真，用户关掉浏览器回来时气泡就卡住常显（实测缺陷）。
						   blur 掉之后气泡回到只跟鼠标悬停走，行为才符合预期。
						   window.open 会被主窗口的 setWindowOpenHandler 接住，转 shell.openExternal → 默认浏览器；
						   noopener 只是不给新窗口留 window.opener（这里窗口本来就被拒了） */
						onClick: (event) => {
							const button = event === null || event === undefined ? null : event.currentTarget;
							if (button !== null && button !== undefined && typeof button.blur === "function") button.blur();
							window.open(REPO_URL, "_blank", "noopener");
						}
					}, t("starRepo"))
				]),
				h("button", {
					type: "button",
					className: "dsb-action",
					key: "__reset",
					/* 「恢复默认设置」= 界面配置回出厂 + 价格库**分两类**重置：
					   · **官方内置条目**（键命中 `DEFAULT_PRICES`）→ 恢复成官方默认值（逐字段等于
					     官方表，`tiered` 与两档一起、连官方写的 0/null 也照抄），币种回到 **CNY**；
					     被删掉的官方条目会**加回来**；顺序按官方表顺序排在**前面**。
					     **取舍**：用户改过某个官方模型的价格，恢复默认会把它覆盖回官方价 ——
					     这正是"恢复默认"的语义（想留住自定义价就别用官方键）。
					   · **用户自建条目**（键不在官方表里）→ **原样保留**（数值/档位/`currency`
					     一个字节都不动），顺序跟在官方条目后面。
					   其余键（`priceVersion` / `priceConfigured` / `holidayDays` 等）靠 `setConfig`
					   的**合并**语义原样留着。台账与历史数字一概不动（这里只写配置）。 */
					onClick: () => {
						const reset = resetPriceBook();
						setConfig({
							contextMeter: true,
							segments: DEFAULT_SEGMENTS.slice(),
							hidden: [],
							/* 内部默认币种（界面已不暴露它，只用于老配置迁移与底栏后备显示） */
							currency: "CNY",
							models: reset.models,
							modelOrder: reset.modelOrder
						});
					}
				}, t("reset")),
				/* 有新版才出现：与导航胶囊同一个来源（updateState）。
				   点它由本插件自己的 host 端执行更新（不依赖插件管理器，也不吃 pnpm 的
				   24 小时发布年龄限制）。三种状态都写在按钮自己身上：空闲报版本号、
				   更新中带动效点、失败就说「更新失败」。

				   **失败态仍然可点**：点一下只是退回「更新到 X.X.X 版本」，让用户看清
				   自己点过了、可以再点一次真重试（见 dismissUpdateFailure 的说明）。
				   唯一 disabled 的是「更新中」——那时候不能重复发起。

				   **装完必须重启 DSH，刷新页面没有用** —— 这不是保守说法，是 DSH 的设计：
				     · `@deepseek-ai/dsh-hmr` 的已知限制原文：「通过插件管理器替换已安装包版本
				       仍需要重启。浏览器 Client 模块图保留独立的浏览器侧加载机制。」
				     · `dsh-client-modules` 的包元数据（含 client.js 的 revision）
				       「缓存至重启」，所以刷新只会重新拉同一份旧 bundle。
				     · 官方插件管理器的文案也是同一口径：「已安装，下次启动后加载。」
				   桌面宿主只提供退出能力、没有自我重启能力（`app.relaunch()` 只在开发模式
				   的菜单里），所以这里只如实提示，不假装能替用户重启。 */
				update.hasUpdate === true
					? h("button", {
						type: "button",
						className: "dsb-action",
						key: "__update",
						disabled: update.busy === true,
						onClick: onUpdateClick
					}, update.busy === true
						? [t("updateRunning"), h("span", { className: "dsb-dots", key: "__dots" }, [
							h("span", { key: "__d1" }, "."),
							h("span", { key: "__d2" }, "."),
							h("span", { key: "__d3" }, ".")
						])]
						: (update.note === "done"
							? t("updateDone")
							: (update.note === "failed"
								? t("updateFailed")
								: t("updateTo", { version: update.latest === null ? "" : update.latest }))))
					: null,
				/* 版本标记贴右、与行内底边对齐：这行字让「现在跑的是哪一版」一眼可见 ——
				   注意**光刷新页面看不出差别**：插件包元数据缓存至重启，刷新拿到的还是旧 bundle；
				   要换版本必须重启 DSH，重启后这行字才会变成新号。

				   它同时是**开发模式的隐藏入口**：连点 5 次进入 / 退出（见 onVersionClick）。
				   挂在版本号上的原因：这个入口面向作者调试，普通用户的界面里不该多出
				   任何可见元素；连点是常见手势，记得住又不会被误触。
				   进入后的可见迹象是标题右侧那枚「开发模式」胶囊，不在这一行。 */
				h("span", {
					className: "dsb-version",
					key: "__version",
					onClick: onVersionClicked
				}, "dsh-desktop-statusbar " + VERSION)
			]));

			return h("div", { className: "dsb-settings" }, sections);
		}

		/* --------------------------------------------------------------- apply */

		/* 各测试用 replace(marker) 注入自己的 __test 表（插在文件末尾 exports.apply 赋值那行之前），本文件不自带表。 */

		function apply(ctx) {
			/* 注意：这里**不保存 ctx**。更新走本插件自己的 host 路由
			   （见 startPluginUpdate 的说明），界面其余部分也不需要宿主上下文 ——
			   曾经存过一份 `pluginCtx` 只写不读，已删除。 */
			ctx.effect(installStyles, "dsh-desktop-statusbar: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "dsh-desktop-statusbar: locale");
			ctx.effect(() => installNavIcon(
				() => ctx.locale.bind(NS)("nav"),
				() => ctx.locale.bind(NS)("updatePill")
			), "dsh-desktop-statusbar: nav icon");

			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "mini-bar",
				order: 0,
				locale: NS
			}, StatusBar));

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-desktop-statusbar",
				order: 40,
				label: () => ctx.locale.bind(NS)("nav"),
				locale: NS
			}, SettingsSection));
		}

		const inject = ["slots", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
