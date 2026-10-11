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
		/* 子智能体（Agent Teams 的队友）用量的聚合端点：队友是**独立会话**，它的消耗不在本会话
		   的投影里，只能由 host 按 parentSession 找出来，「总计」「本轮」才真的把队友算进去。
		   带 since（毫秒）= 只要那个时刻之后的用量，客户端拿它取「本轮」这一段。 */
		const SUBAGENT_URL = "/dsh-desktop-statusbar/api/subagent-usage";
		/** 队友用量多久重拉一次：底栏本来就有一个**每秒**跳的 now 时钟（活跃时），
		    所以这里取 1 秒 —— 用户要的「实时跳动」；也不必为它新增定时器。
		    没有变化时后台只比对文件的 mtime/size（实测几毫秒），每秒重拉的开销可以忽略。 */
		const SUBAGENT_REFRESH_MS = 1000;
		/** 聚合请求自己的超时：接口卡住时不能把「总计」一直吊着，超时就退回只算本会话。 */
		const SUBAGENT_TIMEOUT_MS = 8000;
		/**
		 * 配置结构版本。
		 * v6 起：`segments` 存全部段的有序列表（顺序对整份列表生效），`hidden` 存未勾选的段。
		 */
		const CONFIG_VERSION = 6;
		/** 插件版本：显示在设置页底部，用来确认页面加载的是哪一版客户端代码。 */
		const VERSION = "2.1.1";
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

		/* ------------------------------------------- 「本轮」稳定性（同轮不跳、换轮归零） */
		/* 底栏每秒问两个窗口（整会话 / 本轮窗口），任一问失败时旧实现会把队友那段当 0，
		   于是「本轮」在同轮内跳小、下一次成功又跳大（用户实测）。下面两件纯函数负责把它稳住：
		   `nextSubagentState` 管"这次失败要不要沿用上一次成功的值"，`applyTurnFloor` 管
		   "同一轮内显示值只增不减"。两者都以**轮标识**（turnKey）为界：换了轮一律从头来。 */

		/** 空状态：没有会话、没有轮、两段都没有值。 */
		const SUBAGENT_STATE_EMPTY = { sessionId: null, turnKey: null, sessionPayload: null, turnPayload: null };

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

		/** 本会话的令牌三段 + 队友的三段：同一个数字直接相加，不新增行。 */
		function mergeTokenParts(parts, sub) {
			const base = parts === null || parts === undefined ? { cached: 0, missInput: 0, output: 0 } : parts;
			return {
				cached: base.cached + sub.cached,
				missInput: base.missInput + sub.missInput,
				output: base.output + sub.output
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
			tipSpent: "累计消费",
			tipHitTurn: "本轮命中率",
			tipHitHigh: "最高命中率",
			tipHitLow: "最低命中率",
			tipCountsTitle: "会话数据",
			tipCountsSkills: "技能注入",
			tipCountsCompactAt: "上下文压缩",
			tipCountsToolCalls: "工具调用",
			/* 压缩明细逐条列时的两段：序号用中文序数（第一次 / 第二次），落点用「第X轮Y步」 */
			tipCompactItem: "第{index}次压缩",
			tipCompactWhere: "第{turn}轮{step}步",
			tipCompactTurnOnly: "第{turn}轮",
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
			segLastCostHint: "当前或最近一轮交流的估算消耗费用。",
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
			tipSpent: "Total spent",
			tipHitTurn: "Hit rate this turn",
			tipHitHigh: "Highest hit rate",
			tipHitLow: "Lowest hit rate",
			tipCountsTitle: "Session data",
			tipCountsSkills: "Skills injected",
			tipCountsCompactAt: "Context compactions",
			tipCountsToolCalls: "Tool calls",
			/* 压缩明细逐条列时的两段：英文直接用阿拉伯数字，落点「Turn X·Step Y」 */
			tipCompactItem: "Compaction {index}",
			tipCompactWhere: "Turn {turn}·Step {step}",
			tipCompactTurnOnly: "Turn {turn}",
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
			segLastCostHint: "Estimated cost of the current or most recent turn.",
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

		/** 官方那种分段小条（分项面板里那条）。 */
		function meterBar(meter) {
			return h("span", { className: "dsb-bar", style: barTrackStyle(meter.compact) },
				meter.segments.map((segment, index) => h("span", {
					className: "dsb-bar-seg",
					key: "__bar" + index,
					style: { width: segment.width + "%", background: segment.color }
				})));
		}

		/**
		 * 状态位上的圆环：起点与官方一致在 12 点方向，进度是占用比例，颜色跟随运行状态。
		 * 轨道在压缩点处挖一个圆头缺口；算不出压缩点时轨道保持整圈。
		 */
		function contextRing(percent, state, compact) {
			const stateClass = state === "running" ? " dsb-ring-running"
				: (state === "error" ? " dsb-ring-error" : (state === "approval" ? " dsb-ring-approval" : ""));
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
		 */
		function reportTipDiag(payload) {
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

		function tokenPanelView(cached, missInput, output, t) {
			const total = cached + missInput + output;
			if (total <= 0) return null;
			const parts = [
				{ label: t("f_tokensHit"), color: "var(--dsw-static-neutral-bluish-400)", value: cached },
				{ label: t("f_tokensMiss"), color: "#a78bfa", value: missInput },
				{ label: t("f_tokensOut"), color: "var(--dsw-static-blue-450)", value: output }
			];
			return {
				totalText: formatTokensExact(total),
				segments: parts
					.map((one) => ({ color: one.color, width: (one.value / total) * 100 }))
					.filter((one) => one.width > 0),
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

		/* ------------------------------------------------------ 活跃总览柱状图 */
		/** 柱状图用的三色：与令牌面板的三段同色（命中缓存=灰 / 未命中=紫 / 输出=蓝）。 */
		const WEEK_COLORS = {
			hit: "var(--dsw-static-neutral-bluish-400)",
			miss: "#a78bfa",
			out: "var(--dsw-static-blue-450)"
		};

		/* 余额构成的两色：充值取灰（同「系统提示词」图例）、赠金取紫（同「工具定义」图例）。
		   百分比配额（GLM 那种）只有「剩余」那段上色，取蓝（原赠金那一档）。 */
		const BALANCE_COLORS = {
			topUp: "var(--dsw-static-neutral-bluish-400)",
			granted: "#a78bfa",
			left: "var(--dsw-static-blue-450)"
		};

		/* 运行用时面板的三色：等待用时取灰（同「系统提示词」图例）、模型用时(解码)取紫、工具调用取蓝 */
		const DURATION_COLORS = {
			wait: "var(--dsw-static-neutral-bluish-400)",
			model: "#a78bfa",
			tool: "var(--dsw-static-blue-450)"
		};

		/** 本地日期键，用来认「今天」那根柱子。 */
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

		/**
		 * 悬停浮层的内容：日期（或周区间）+ 三项总计 → 命中/未命中/输出三行 → API 请求次数 → 消费金额。
		 * 六行全部走「名称左、数值右」的双边对齐；数量精确到个位并带千分位，不做缩写。
		 */
		function hoverPanelRows(label, bucket, calls, cost, t) {
			const hit = Number(bucket.cacheRead) || 0;
			const miss = (Number(bucket.input) || 0) + (Number(bucket.cacheWrite) || 0);
			const out = Number(bucket.output) || 0;
			return h("span", { className: "dsb-meter-rows dsb-meter-rows-fit", key: "__hrows" }, [
				hoverRow("__h0", label, formatTokensExact(hit + miss + out)),
				hoverRow("__h1", t("f_tokensHit"), formatTokensExact(hit)),
				hoverRow("__h2", t("f_tokensMiss"), formatTokensExact(miss)),
				hoverRow("__h3", t("f_tokensOut"), formatTokensExact(out)),
				hoverRow("__h4", t("hoverCalls"), formatTokensExact(calls)),
				hoverRow("__h5", t("hoverCost"), currencySymbol("CNY") + (Number(cost) || 0).toFixed(2))
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

		/** 把若干天并成一个桶（周条用）。 */
		function sumDays(days) {
			const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let calls = 0;
			let cost = 0;
			for (const day of days) {
				if (day === null || day === undefined) continue;
				const one = bucketOf(day);
				total.input += one.input;
				total.cacheRead += one.cacheRead;
				total.cacheWrite += one.cacheWrite;
				total.output += one.output;
				calls += Number(day.calls) || 0;
				cost += Number(day.cost) || 0;
			}
			return { bucket: total, calls: calls, cost: cost };
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
						? { rows: hoverPanelRows(label, weekSum.bucket, weekSum.calls, weekSum.cost, t), week: wi }
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
							? (event) => onHover(event, { rows: hoverPanelRows(day.date.slice(5), bucketOf(day), Number(day.calls) || 0, Number(day.cost) || 0, t) })
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
						? (event) => onHover(event, { rows: hoverPanelRows(label, bucketOf(one), Number(one.calls) || 0, Number(one.cost) || 0, t) })
						: undefined,
					onMouseLeave: total > 0 ? () => onHover(null) : undefined
				});
			});
			/* 全年合计：各月相加，挂在中间那段无色方块上 */
			const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let calls = 0;
			let cost = 0;
			for (const one of year.months) {
				totals.input += Number(one.input) || 0;
				totals.cacheRead += Number(one.cacheRead) || 0;
				totals.cacheWrite += Number(one.cacheWrite) || 0;
				totals.output += Number(one.output) || 0;
				calls += Number(one.calls) || 0;
				cost += Number(one.cost) || 0;
			}
			const hasYear = totals.input + totals.cacheRead + totals.cacheWrite + totals.output > 0;
			const allCell = h("span", {
				className: "dsb-year-cell dsb-year-all",
				key: "__yall",
				onMouseEnter: hasYear
					? (event) => onHover(event, { rows: hoverPanelRows(String(year.year) + " " + t("hoverYearAll"), totals, calls, cost, t) })
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
						+ (day.date === tip.today ? " dsb-day-today" : "")
						+ (activeBar === index ? " dsb-day-active" : ""),
					key: "__wd" + index,
					/* 悬停整列都让判定区变灰 —— 没有用量的天也一样；浮层只在有用量时弹 */
					onMouseEnter: (event) => onHover(event, total > 0
						? {
							rows: hoverPanelRows(day.date.slice(5), bucketOf(day), Number(day.calls) || 0, Number(day.cost) || 0, t),
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
				onMouseDown: stopTipClick,
				/* 诊断：定位回调把「模式 + 基准 + 结果」写在这里（不可见），同时会回传给 host 落盘 */
				"data-dsb-align": pos === null || pos === undefined || pos.align === undefined ? undefined : pos.align
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
		 * 长列表分列：**每一竖列最多三行**，超过就多开一竖列（列数不设上限，
		 * 放不下时由 CSS 折到下一排，整体高度另有屏幕半高的兜底上限）。
		 */
		const LIST_ROWS_PER_COLUMN = 3;
		function listColumns(rows) {
			const size = LIST_ROWS_PER_COLUMN;
			const out = [];
			for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
			return out;
		}

		/**
		 * 两列面板：标题 + 主数值，下面若干「名称 / 数值」行（用时、极值、命中率、余额、会话数据这类段用）。
		 * 行上带 sub 的（会话数据那三行）点一下就把整个气泡换成子视图：标题变成子视图名、内容换成列表，
		 * 子视图沿用主气泡的字号字色（不是二次气泡），点标题回到上一层。
		 * 子视图的列表每列最多三行、超了往右加列；只有名字的行（技能注入）不占数值那一格。
		 */
		function rowsPanel(tip, pos, ref, sub) {
			const rows = tip.rows === undefined ? [] : tip.rows;
			const openedAt = sub === undefined || sub === null || typeof sub.id !== "number" ? null : sub.id;
			const opened = openedAt === null || rows[openedAt] === undefined || rows[openedAt].sub === undefined
				? null
				: rows[openedAt].sub;
			/* 一行里的三块：色块（可选，与上面那条色条一一对应）+ 名称 + 数值。
			   没有数值的行（技能注入的子视图）只出名字，不占右边那一格，气泡宽度就是最长那个名字。
			   可点行与普通行共用这一份，别各写一遍。 */
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
				const columns = listColumns(opened.rows);
				wide = columns.length > 1;
				/* 一列时不套外层（与其它面板的行结构完全一致），分列才多一层；
				   子视图带 tight 的（工具调用）另挂一个类，把名字与数值的间隙收紧 */
				const cls = "dsb-meter-rows dsb-meter-rows-fit"
					+ (columns.length > 1 ? " dsb-meter-cols" : "")
					+ (opened.tight === true ? " dsb-meter-tight" : "");
				body = columns.length > 1
					? h("span", { className: cls, key: "__xrows" },
						columns.map((column, at) => h("span", { className: "dsb-meter-col", key: "__col" + at },
							column.map((row, index) => cell(row, "__c" + at + "r" + index)))))
					: h("span", { className: cls, key: "__xrows" },
						(columns[0] === undefined ? [] : columns[0]).map((row, index) => cell(row, "__r" + index)));
			}
			const segments = Array.isArray(tip.segments) ? tip.segments : [];
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
				/* 有分段数据就画色条（与令牌面板同一条），否则还是那条普通分隔线 */
				segments.length > 0
					? h("span", { className: "dsb-bar", key: "__xbar" }, segments.map((one, index) => h("span", {
						className: "dsb-bar-seg", key: "__xseg" + index,
						style: { width: one.width + "%", background: one.color }
					})))
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

		/** 令牌面板的 tip。没有数据也给面板（三行横杠）—— 气泡必须任何情况下都点得开。 */
		function tokensTip(parts, title, t) {
			const panel = parts === null ? null : tokenPanelView(parts.cached, parts.missInput, parts.output, t);
			return { kind: "tokens", title: title, panel: panel === null ? dashTokenPanel(t) : panel };
		}

		/** 毫秒 → 面板里的时长文本（精确到秒）；0 或缺数据给横杠。 */
		function tipDuration(ms) {
			const text = formatDurationFine(ms);
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

		/** 时长精确到秒：1h23m45s / 23m45s / 45s。底栏那条用 formatDuration（省掉秒，宽度有限）。 */
		function formatDurationFine(ms) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			const whole = Math.round(n / 1000);
			if (whole < 60) return whole + "s";
			const minutes = Math.floor(whole / 60);
			if (minutes < 60) return minutes + "m" + (whole % 60) + "s";
			return Math.floor(minutes / 60) + "h" + (minutes % 60) + "m" + (whole % 60) + "s";
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

		/** 子视图没有内容时给一行横杠：气泡任何情况下都要打得开，也不能是一片空白。 */
		function emptyList(title) {
			return { title: title, rows: [{ label: title, value: "-" }] };
		}

		/** 技能注入子视图：只列名字，不跟数值（次数在上面那一行已经给了）。
		    全局提示词（AGENTS.md 这类）排在最前，它也是「注入」的一种；
		    其余技能按首次注入的先后，重复注入聚合成一行；气泡宽度就是最长那个名字。 */
		function skillList(skills, globalInstruction, t) {
			const title = t("tipCountsSkills");
			const names = [];
			if (typeof globalInstruction === "string" && globalInstruction.length > 0) names.push(globalInstruction);
			if (skills !== null) {
				skills.forEach((name) => {
					const key = String(name);
					if (names.indexOf(key) < 0) names.push(key);
				});
			}
			if (names.length === 0) return emptyList(title);
			return { title: title, rows: names.map((name) => ({ label: name })) };
		}

		/**
		 * 工具名的中文显示名。工具名本身是会话日志里的键（英文标识），这里换成读者看得懂的词；
		 * **没列到的工具照原样显示** —— 插件工具、MCP 工具随时可能出现，不能因为查不到就留白。
		 * 只在中文界面用；英文界面直接用原名。
		 */
		const TOOL_LABELS_ZH = {
			pwsh: "命令行",
			bash: "命令行",
			read: "读取文件",
			write: "写入文件",
			edit: "修改文件",
			glob: "查找文件",
			grep: "搜索内容",
			todo_write: "待办清单",
			skill: "技能",
			subagent: "子智能体",
			subagent_fork: "子智能体（继承）",
			ask_user_question: "询问用户",
			create_goal: "新建目标",
			update_goal: "更新目标",
			get_goal: "查看目标",
			present: "展示文件",
			web_search: "联网搜索",
			web_fetch: "抓取网页",
			job_list: "后台任务列表",
			job_output: "后台任务输出",
			job_kill: "取消后台任务",
			spawn_teammate: "新增队友",
			send_message: "发送消息",
			wait_agent: "等待队友",
			interrupt_agent: "中断队友",
			list_agents: "队友列表",
			team_task_create: "新建任务",
			team_task_list: "任务列表",
			team_task_get: "查看任务",
			team_task_update: "更新任务",
			exit_plan_mode: "退出计划模式",
			load_workspace_dependencies: "加载工作区依赖",
			find_dsh_plugin: "查找插件",
			workflow: "工作流"
		};

		/** 工具名 → 显示名：中文界面查表（查不到给原名），英文界面直接用原名。 */
		function toolLabel(name, t) {
			if (detectLocale(t) !== "zh") return name;
			const label = TOOL_LABELS_ZH[name];
			return label === undefined ? name : label;
		}

		/** 「工具调用」子视图：**先按显示名长短（短的在前），同名长短再按调用次数降序**。
		    名字短、列多，标 tight 让名字与次数之间的间隙收到 1ch。 */
		function toolList(counts, t) {
			const title = t("tipCountsToolCalls");
			if (counts === null || typeof counts !== "object") return Object.assign(emptyList(title), { tight: true });
			const rows = Object.keys(counts)
				.map((name) => ({ label: toolLabel(name, t), count: Number(counts[name]) || 0 }))
				.filter((one) => one.count > 0)
				.sort((a, b) => a.label.length - b.label.length
					|| b.count - a.count
					|| (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0)))
				.map((one) => ({ label: one.label, value: formatTokensExact(one.count) + t("unitCountCalls") }));
			if (rows.length === 0) return Object.assign(emptyList(title), { tight: true });
			return { title: title, rows: rows, tight: true };
		}

		/** 「上下文压缩」子视图：逐条列出每次压缩落在第几轮第几步（顺序就是发生的顺序）。 */
		function compactList(compacts, t) {
			const title = t("tipCountsCompactAt");
			if (compacts === null || compacts.length === 0) return emptyList(title);
			const ordinal = detectLocale(t) === "zh";
			const rows = compacts.map((one, at) => {
				const index = at + 1;
				const word = ordinal === true ? chineseNumber(index) : null;
				const mark = one === null || one === undefined ? {} : one;
				const turn = typeof mark.turn === "number" ? mark.turn : null;
				const step = typeof mark.step === "number" ? mark.step : null;
				return {
					label: t("tipCompactItem", { index: word === null ? String(index) : word }),
					value: turn === null
						? "-"
						: (step === null ? t("tipCompactTurnOnly", { turn: turn }) : t("tipCompactWhere", { turn: turn, step: step }))
				};
			});
			return { title: title, rows: rows };
		}

		/** 余额接口给的金额字符串；没有这个字段时按 0.00 显示。 */
		function balanceAmount(value) {
			return typeof value === "string" && value.length > 0 ? value : "0.00";
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
		/** 时长按最小单位给：>=1h 用 h/m，>=1m 用 m/s，不足一分钟只给整数秒；分钟与秒之间不加空格。 */
		function formatDuration(ms) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			const seconds = n / 1000;
			const whole = Math.round(seconds);
			if (whole < 60) return whole + "s";
			const minutes = Math.floor(whole / 60);
			if (minutes < 60) return minutes + "m" + (whole % 60) + "s";
			return Math.floor(minutes / 60) + "h" + (minutes % 60) + "m";
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
				/* 每条调用按自己发生的那一刻、自己的模型定峰谷：跨时段、跨模型都不会串价。
				   累加的是未舍入金额，最后一次性舍入 —— 逐条舍入会累积出几毛钱的误差。
				   **每条还要按它自己条目的币种折到显示币种**：会话里 A 是人民币、B 是美元时，
				   底栏给的是一个数字（折到主模型那种币），不是两种货币相加。 */
				const fallbackModel = src.sessionModel !== undefined && src.sessionModel !== null ? src.sessionModel.model : null;
				let total = 0;
				let priced = false;
				for (let i = 0; i < calls.length; i += 1) {
					const callModel = typeof calls[i].model === "string" ? calls[i].model : fallbackModel;
					const one = costOf(calls[i], callModel, calls[i].at);
					if (one === null) continue;
					priced = true;
					total += toDisplayCurrency(one, src.models, callModel, symbolCurrency, src.defaultCurrency);
				}
				/* 队友（子智能体）是**独立会话**，它的用量不在上面这份本会话调用表里，
				   host 按 parentSession 算好单独给回来；这里直接把数字并进「总计」，
				   不另开一行也不加任何提示字 —— 用户报的正是"总计没算队友"。
				   两段数据（整会话 / 本轮窗口）各自拿到才用，没拿到的那段当 0。 */
				const sub = subagentOf(src.subagent, "session");
				const subCost = subagentCostOf(src.subagent, "session", symbolCurrency);
				const grand = total + subCost;
				return {
					id: id,
					/* 算不出价（本会话与队友都没价）时给横杠：与"这笔真的是 0"区分开 */
					text: t("f_cost", { symbol: symbol, cost: priced === true || subCost > 0 ? costText(grand) : "-" }),
					/* token 计数并进总计：本会话的 + 队友的，同一个数字相加，不新增行 */
					tip: tokensTip(mergeTokenParts(sessionTokenParts(src.usage), sub), t("f_tokensTotal"), t)
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
				const turnTip = tokensTip(mergeTokenParts(billableParts(turnParts), subTurn), t("f_tokensTurn"), t);
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
				/* 积分口径：只有一个总积分，没有「充值 / 赠金」构成可展开 ⇒ 不给 tip。
				   段没有 tip 就不会被渲染成可点击项（渲染处按 tip !== null 决定 className
				   与 onClick），所以气泡点不开、悬停也不弹 —— 这正是要的：
				   弹一个只有标题、没有任何内容的空气泡只会让人以为还能点。 */
				if (isCredits === true) {
					return { id: id, text: t("f_balance", { symbol: balSymbol, amount: balance.total }) };
				}
				/* 分隔线换成色条，两种情况各一套：
				   金额余额（DeepSeek 等）= 充值 : 赠金，按金额占比分两段（紫 / 蓝）；
				   百分比配额（GLM 等）= 已用 : 剩余，未用那段用「系统提示词」的同款灰。
				   余额为负或拿不到数字时算不出占比，就不给 segments，面板退回普通分隔线。 */
				const isQuota = balance.isPercent === true;
				const topUp = Number(balance.toppedUp) || 0;
				const granted = Number(balance.granted) || 0;
				const balanceSum = Math.max(0, topUp) + Math.max(0, granted);
				const quotaUsed = isQuota ? Math.max(0, Math.min(100, Number(String(balance.total).replace("%", "")) || 0)) : 0;
				const quotaLeft = isQuota ? Math.max(0, 100 - quotaUsed) : 0;
				/* 百分比配额（GLM 等）：只有「未用」那段有颜色，且它**从最左边开始**画；
				   右边已用的位置由一个透明段顶着（露出轨道底色）。
				   为什么不用单段 + 右侧留空：气泡是 width:max-content，条又是 flex 容器，
				   单个百分比段在"容器宽度由谁决定"上循环，实际渲染出来比例会偏；
				   两段显式百分比之和为 100%，宽度就由浏览器按比例切，不会漂。
				   行只列「剩余配额」一行并带同款灰图例；已用那边不列行。 */
				const balanceSegments = isQuota
					? [
						{ color: BALANCE_COLORS.left, width: quotaLeft },
						{ color: "transparent", width: quotaUsed }
					].filter((one) => one.width > 0)
					: balanceSum > 0
						? [
							{ color: BALANCE_COLORS.topUp, width: (Math.max(0, topUp) / balanceSum) * 100 },
							{ color: BALANCE_COLORS.granted, width: (Math.max(0, granted) / balanceSum) * 100 }
						].filter((one) => one.width > 0)
						: [];
				const balanceRows = isQuota
					? [{ label: t("tipQuotaLeft"), value: quotaLeft.toFixed(2) + "%", color: BALANCE_COLORS.left }]
					: [
						{ label: t("tipTopUp"), value: balSymbol + balanceAmount(balance.toppedUp), color: BALANCE_COLORS.topUp },
						{ label: t("tipGranted"), value: balSymbol + balanceAmount(balance.granted), color: BALANCE_COLORS.granted }
					];
				const tip = {
					kind: "rows",
					title: t("segBalance"),
					segments: balanceSegments,
					rows: balanceRows.concat([
					/* 累计消费只有部分平台能给（智谱有，DeepSeek 的接口没有），没有就不显示这一行 */
					balance.spent === undefined || balance.spent === null
						? null
						: { label: t("tipSpent"), value: balSymbol + balanceAmount(balance.spent) }
					].filter((one) => one !== null))
				};
				/* 不足一分钱时官方显示 <¥0.01，这里跟着来 */
				if (balance.subCent === true) return { id: id, text: t("f_balanceSubCent", { symbol: balSymbol }), tip: tip };
				return { id: id, text: t("f_balance", { symbol: balSymbol, amount: balance.total }), tip: tip };
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
		/* ---------------------------------------------------------------- css */
		const CSS = [
			/* 接管输入框下方的统计行：dock 里凡“不是本插件那一项”的都藏掉（也就是官方 StatsPills）。
			 * 两条不依赖官方构建 hash 的要点：
			 *   1. 用 .dsb-root 认自己，而不是官方组件的类名（hash 会随 DSH 更新变，2.0.10 踩过）；
			 *   2. 自己带标记与“后代里带标记”都要判 —— :has() 只看后代，漏掉前者会把自己的行也藏掉。
			 * 整条规则挂在 html.dsb-on 上：设置页取消勾选「启用状态栏」后这个类会被摘掉，
			 * 官方原本的统计行与上下文按钮随即恢复（不然关掉插件只剩一片空白）。 */
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
			"@media (prefers-reduced-motion: reduce){.dsb-ring-running .dsb-ring-fill{animation:none}}",
			".dsb-ring-error .dsb-ring-fill{stroke:#ef4444}",
			".dsb-ring-approval .dsb-ring-fill{stroke:#f59e0b}",
			".dsb-bar{display:flex;gap:1px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));overflow:hidden;margin:6px 0 2px}",
			".dsb-bar-seg{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--dsw-alias-label-tertiary)}",
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
			/* 工具调用子视图：名字短、列多，5ch 太占宽度，收到 1ch */
			".dsb-meter-tight .dsb-meter-value{padding-left:1ch}",
			/* 可点行（会话数据那几行）：光标 + 悬停底色，跟设置页那些可点项同一套反馈。
			   底色两端做成半圆（胶囊），行尾不加箭头 —— 只靠底色与光标表示可点。
			   上下内边距跟 .dsb-meter-row 保持一致（1/3），可点与不可点的行文字才不会错位。 */
			".dsb-meter-row-click{cursor:pointer;margin:0 -4px;padding:1px 4px 3px;border-radius:999px}",
			".dsb-meter-row-click:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
			/* 子视图标题就是返回入口：不加返回箭头，悬停变亮 */
			".dsb-meter-back{cursor:pointer}",
			".dsb-meter-back:hover{color:var(--dsw-alias-label-secondary)}",
			/* 子视图列表分列：每列最多三行（由 listColumns 决定），每列自己两列对齐。
			   列多到一排放不下就折到下一排；兜底再压一道高度上限，不越过屏幕可用高度的一半。 */
			".dsb-meter-cols{flex-direction:row;flex-wrap:wrap;align-content:flex-start;align-items:flex-start;gap:6px 16px;max-height:calc(50vh - 46px);overflow-y:auto;overscroll-behavior:contain}",
			".dsb-meter-col{display:flex;flex-direction:column}",
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
			/* 柱的悬停：::before 只负责把热区左右各撑 2px（透明、看不见），
			   ::after 才是变灰反馈，left/right 都是 0 —— 严格不超出柱身那 5px。
			   同样由 JS 状态驱动，用 :hover 的话划过柱间缝隙会一闪一闪。 */
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
			".dsb-tip{position:fixed;box-sizing:border-box;padding:6px 10px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f));background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3));white-space:nowrap;z-index:40;pointer-events:auto}",
			".dsb-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			/* 设置页 */
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
			".dsb-settings input[type=number]{text-align:right}",
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
		].join("");

		/* 导航图标使用外部传入的 gauge（24x24 lucide，stroke=currentColor，随主题变色） */
		const NAV_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';

		/**
		 * 把设置导航里本插件那一项的前导图标换成 gauge。
		 * 定位方式是按导航文案匹配（DSH 没给导航项留 id 属性），匹配不到就什么都不做。
		 */
		/* 导航项里挂「发现新版本」胶囊用：标记本插件那一项，避免胶囊文字混进文案后匹配不上。 */
		const NAV_MARK = "data-dsb-nav";

		/* 宿主上下文（apply 时存下来）：一键更新要用它的 remote 命名空间。 */
		let pluginCtx = null;

		/**
		 * 版本自检结果 —— 导航胶囊和设置页那颗「更新」按钮共用这一份，两边同进同出。
		 * 默认什么都没有：只有 registry 上确实更新才显示，查不到就安静地不显示。
		 * note 是更新动作的结果：null / "done" / "failed" / "no-manager"。
		 */
		let updateState = { hasUpdate: false, latest: null, busy: false, note: null, reason: null };
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
			if (has !== null) { has.textContent = text; return; }
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

		/** 从安装结果里抠出失败原因；拿不到就给空串。 */
		function reasonOf(result) {
			const raw = result === null || result === undefined ? null : result.reason;
			return typeof raw === "string" && raw.length > 0 ? raw : "";
		}

		/**
		 * 一键更新：调 DSH 官方的插件安装接口（和插件管理页同一条路，内部跑 pnpm）。
		 * 装完由 DSH 自己接管生效；客户端这半边是旧代码，得刷新页面才是新的。
		 */
		function startPluginUpdate() {
			const remote = pluginCtx === null || pluginCtx === undefined ? null : pluginCtx.remote;
			const manager = remote === null || remote === undefined ? null : remote.pluginManager;
			/* 官方桌面端一定带插件管理器；真取不到就按失败处理，不另开一个用户看不懂的分支 */
			if (manager === null || manager === undefined || typeof manager.installBundle !== "function") {
				setUpdateState({ busy: false, note: "failed", reason: null });
				return;
			}
			if (updateState.latest === null || updateState.busy === true) return;
			const target = updateState.latest;
			setUpdateState({ busy: true, note: null, reason: null });
			Promise.resolve(manager.installBundle(
				"dsh-desktop-statusbar@" + target,
				{ requestId: "dsh-desktop-statusbar-" + String(Date.now()) }
			)).then((result) => {
				const ok = result !== null && result !== undefined && result.ok === true;
				setUpdateState({ busy: false, note: ok ? "done" : "failed", reason: ok ? null : reasonOf(result) });
			}).catch(() => {
				setUpdateState({ busy: false, note: "failed", reason: null });
			});
		}

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
			/* 启动自检一次。卸载之后结果才到的话直接丢弃，别再往 DOM 里塞东西。 */
			let alive = true;
			loadUpdateFlag().then((result) => {
				if (alive !== true || result === null) return;
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
			const useSessions = props.useSessions;
			const sessionId = props.sessionId;
			const cfg = useConfig();

			const stats = useProjection("sessionStats");
			const usage = useProjection("tokenUsage");
			const sessionModel = useProjection("desktopStatusbarModel");
			const sessionUsage = useProjection("desktopStatusbarUsage");
			const timeRange = useProjection("desktopStatusbarActiveTime");
			/* 逐次调用的首字/速度极值（host 侧折出来的，官方 sessionStats 只有累计值） */
			const timing = useProjection("desktopStatusbarTiming");
			/* 上下文占用直接读 DSH 自带的两个投影，跟官方那一行同源同口径 */
			const pressure = useProjection("contextPressure");
			const breakdown = useProjection("contextBreakdown");
			/* 压缩点的两个入参（窗口 + 本次请求输出上限）由本插件从请求事件里折出来 */
			const capacity = useProjection("desktopStatusbarCapacity");
			/* 轮次项气泡那三行（上下文压缩 / 技能注入 / 工具调用）同样由本插件折 */
			const progress = useProjection("desktopStatusbarProgress");
			/* 设置页拿不到会话投影，把当前模型上报给 host，供设置页读取 */
			const reportedModel = sessionModel !== null && sessionModel !== undefined && typeof sessionModel.model === "string" && sessionModel.model.length > 0
				? sessionModel.model
				: null;
			const reportedProvider = sessionModel !== null && sessionModel !== undefined && typeof sessionModel.provider === "string" ? sessionModel.provider : null;
			react.useEffect(() => {
				if (reportedModel === null) return;
				window.fetch(ACTIVE_MODEL_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: reportedProvider, model: reportedModel })
				}).catch(() => { /* 上报失败不影响底栏 */ });
			}, [reportedModel, reportedProvider]);

			/* 价格库上报给 host：活跃总览的 cost 是 host 记账时算的，
			   它拿不到 localStorage，必须由这里把当前价格库送过去，
			   否则用户在设置页加/改的单价只对底栏生效（实测 2026-10-07）。
			   models 一变就重报；host 侧比对指纹后只结算"欠账"——
			   即当时没有单价、还没算钱的那部分用量，已经算好的历史费用不动。 */
			const reportedPrices = react.useMemo(() => JSON.stringify(cfg.models === undefined || cfg.models === null ? {} : cfg.models), [cfg.models]);
			react.useEffect(() => {
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
				}).catch(() => { /* 上报失败不影响底栏 */ });
			}, [reportedPrices]);

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
			/* 「本轮」显示值的粘性下限盒子（同轮内只增不减，换轮作废）：一个可变盒子，
			   由 lastCost 段在渲染时更新，跨渲染靠这个 ref 留住（见 applyTurnFloor）。 */
			const lastCostHoldRef = react.useRef({ sessionId: null, turnKey: null, value: 0 });
			/* 点开「总计」气泡时 +1：强制重拉一次队友用量（别的触发条件都带 3 秒节流） */
			const [subagentTick, setSubagentTick] = react.useState(0);
			const [tipId, setTipId] = react.useState(null);
			const [tipPos, setTipPos] = react.useState(null);
			/* 气泡里的下钻层：null = 根视图，数字 = 点开了第几行（会话数据那三行的子视图）。
			   换字段、收起气泡都要清掉，否则下次打开会停在上次的子视图上。 */
			const [tipSub, setTipSub] = react.useState(null);
			/* 柱 / 方块 / 每周底条的悬停浮层：内容 + 触发元素的位置（自己算 fixed 坐标） */
			const [hoverCard, setHoverCard] = react.useState(null);
			const [hoverPos, setHoverPos] = react.useState(null);
			/* 当前悬停的是哪一周（用来给那条底板加深）；悬停方块/柱子时为 null */
			const [hoverWeek, setHoverWeek] = react.useState(null);
			/* 当前悬停的是哪一根柱（那一列的判定区变灰）；不在柱上时为 null */
			const [hoverBar, setHoverBar] = react.useState(null);
			const hoverRef = react.useRef(null);
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
				}, 110);
			}, []);
			/* payload 为对象：rows 有值时弹浮层，week 有值时那条底板加深，bar 有值时那根柱的判定区变灰。
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
				setHoverCard(payload.rows === undefined ? null : payload.rows);
				setHoverWeek(typeof payload.week === "number" ? payload.week : null);
				setHoverBar(typeof payload.bar === "number" ? payload.bar : null);
			}, [closeHoverSoon]);
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
			react.useEffect(() => {
				if (needsNow !== true) return undefined;
				if (running === true || clockActive) {
					const timer = window.setInterval(() => setNow(Date.now()), running === true ? 1000 : 10000);
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
			}, [needsNow, running, clockActive]);

			/* 价格库缺省或全 0 时自动补上官方参考价（不用用户手动填） */
			react.useEffect(() => {
				void ensurePrices();
			}, []);

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
				if (!wantsBalance) return undefined;
				let alive = true;
				const load = (force) => {
					const url = BALANCE_URL + balanceQuery + (force === true ? "&force=1" : "");
					window.fetch(url, { cache: "no-store" })
						.then((response) => response.json())
						.then((data) => { if (alive) setBalance(data); })
						.catch(() => { if (alive) setBalance({ ok: false, reason: "fetch-failed" }); });
				};
				balanceReloadRef.current = () => load(true);
				load(false);
				const timer = window.setInterval(() => load(false), BALANCE_POLL_MS);
				return () => {
					alive = false;
					balanceReloadRef.current = null;
					window.clearInterval(timer);
				};
			}, [wantsBalance, balanceProvider, balanceModel]);

			/* 活跃总览（峰谷段的气泡）：不轮询。挂载时取一次（走 host 缓存），
			   之后每次点开气泡都带 force=1 —— force 只绕过 host 那 30 秒缓存；
			   没变动的日志文件按 mtime+size 跳过，历史数字也不会被重算，
			   跨天、跨月靠"关掉再点开"自然跟上。 */
			const wantsWeekly = isSegmentOn(cfg, "status");
			const dailyReloadRef = react.useRef(null);
			react.useEffect(() => {
				if (!wantsWeekly) return undefined;
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
			}, [wantsWeekly]);

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
			const turnStartMs = turnIsCurrent === true && foldedTurnNow !== null && typeof foldedTurnNow.at === "number"
				? foldedTurnNow.at
				: null;
			/* 「同一轮」的轮标识（给队友状态机与"本轮只增不减"用）。两个来源都只会在真的换轮时前进：
			   host 投影的 turn 随用量事件走，节点折叠的轮号随助手节点走。取**较大者**是为了尽早认定
			   "换轮了"——两者谁先看到新一轮，就从那一刻起归零重算；认不出轮次（两个都拿不到）时为 null，
			   此时既不沿用旧值也不做粘性，避免把两轮的数字混在一起。 */
			const subagentTurnKey = hostTurn !== null && foldedTurnNum !== null
				? Math.max(hostTurn, foldedTurnNum)
				: (hostTurn !== null ? hostTurn : foldedTurnNum);
			const chatNodeCount = Array.isArray(chatNodes) ? chatNodes.length : -1;
			const subagentReqRef = react.useRef({ sessionId: null, nodes: -1, since: null, at: 0 });
			const subagentForceRef = react.useRef(false);
			const subagentReloadRef = react.useRef(null);
			/* 一次"要拉取"的凭据：nonce 变一次就拉一次（sessionId / since 跟着它一起走，读的时候不会串会话） */
			const [subagentQuery, setSubagentQuery] = react.useState(null);
			react.useEffect(() => {
				subagentReloadRef.current = () => {
					subagentForceRef.current = true;
					setSubagentTick((n) => n + 1);
				};
				return () => { subagentReloadRef.current = null; };
			}, []);
			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
				const last = subagentReqRef.current;
				const switched = last.sessionId !== sessionId;
				const forced = subagentForceRef.current;
				subagentForceRef.current = false;
				const due = switched === true || last.nodes !== chatNodeCount || last.since !== turnStartMs
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
				});
				return () => { alive = false; };
			}, [subagentQuery]);

			/* 只在"点别处"时收起。这里刻意不监听 scroll：底栏固定在视口底部，对话区滚动
			   不会移动触发项，但每来一次工具调用/新一轮，对话区都会自动滚到底 ——
			   跟着 scroll 收起的话，气泡会在这些时刻莫名其妙消失。 */
			react.useEffect(() => {
				if (tipId === null) return undefined;
				const close = () => { setTipId(null); setTipPos(null); setTipSub(null); };
				const onDocClick = (event) => {
					if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
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
			   最左、最右那两项贴边对齐，其余跟该字段居中对齐，最后按视口左右夹住。
			   用 layout effect 是为了在浏览器绘制前就落位，不会先闪一下再跳。
			   anchorRef 存的是触发项节点本身，每次都重新量 —— 窗口缩放后位置才是对的。 */
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
				/* 气泡比底栏还宽时（工具调用那种多列面板），先把宽度压到底栏跨度以内，
				   多出来的列由 flex-wrap 折到下一排 —— 否则右边界怎么挪都会顶出去。 */
				const span = barRightIn - barLeft;
				const maxWidth = span > 0 ? Math.min(span, window.innerWidth - 24) : null;
				const maxLeft = Math.min(barRightIn - width, window.innerWidth - width - 8);
				const left = Math.max(barLeft, Math.min(centered, maxLeft));
				const bottom = Math.max(8, window.innerHeight - anchor.top + 6);
				/* 诊断：这几个数会写到气泡的 data-dsb-align 上（也作为悬停提示） */
				const align = "center left=" + left.toFixed(1) + " ring=" + barLeft.toFixed(1)
					+ " bar=" + barRight.toFixed(1) + " anchor=" + Math.round(anchor.left) + " w=" + Math.round(width);
				setTipPos((prev) => (prev !== null && prev.left === left && prev.bottom === bottom
					&& prev.maxWidth === maxWidth && prev.align === align
					? prev
					: { left: left, bottom: bottom, maxWidth: maxWidth, align: align }));
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

			/* 悬停浮层定位：固定贴在活跃总览气泡的正上方，且左右边界与它对齐（同宽），不遮挡它 */
			useTipLayout(() => {
				if (hoverCard === null) return;
				const node = hoverRef.current;
				const panel = tipRef.current;
				if (node === null || node === undefined || panel === null || panel === undefined) return;
				if (typeof node.getBoundingClientRect !== "function" || typeof panel.getBoundingClientRect !== "function") return;
				const size = node.getBoundingClientRect();
				const box = panel.getBoundingClientRect();
				setHoverPos({
					left: Math.max(8, box.left),
					top: Math.max(8, box.top - size.height - 6),
					width: box.width
				});
			}, [hoverCard]);

			/* 主气泡收起时顺手把悬停浮层也收掉，避免它孤零零留在屏幕上 */
			react.useEffect(() => {
				if (tipId === null) {
					setHoverCard(null);
					setHoverPos(null);
				}
			}, [tipId]);

			/* 开关状态同步到 <html>：CSS 里那两条"藏官方底栏"的规则挂在 html.dsb-on 上。 */
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
			const subagent = {
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

			const src = {
				stats: stats, usage: usage,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRange,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: displayCurrency,
				models: config.models, defaultCurrency: config.currency,
				pressure: pressure, breakdown: breakdown, timing: timing,
				daily: daily,
				turnUsageTurn: turnUsageTurn, currentTurn: currentTurn,
				progress: progress, subagent: subagent,
				/* 「本轮」同轮粘性下限的载体：sessionId/turnKey 说明"这份下限属于谁"，
				   lastCostHold 是个可变盒子（ref 里那个对象），段里渲染时按需更新它 —— 见 applyTurnFloor。 */
				sessionId: sessionId, lastCostTurn: subagentTurnKey, lastCostHold: lastCostHoldRef.current
			};

			const views = [];
			cfg.segments.filter((id) => isSegmentOn(cfg, id)).forEach((id) => {
				const view = segmentView(id, src, t);
				/* 保留 view 上的 state（状态点靠它上色），只把缺数据的段换成占位文本 */
				views.push(view !== null && view !== undefined
					? view
					: { id: id, text: segmentText(id, view, t, displayCurrency) });
			});

			/* 运行状态：只用来给上下文占用圆环上色（空闲灰 / 运行绿 / 错误红 / 待审批黄） */
			const agentRunning = src.running === true
				|| (src.partial !== undefined && src.partial !== null)
				|| (Array.isArray(src.runningCalls) && src.runningCalls.length > 0);
			const approvals = src.pendingApprovals;
			const approvalWaiting = approvals !== undefined && approvals !== null
				&& (Array.isArray(approvals) ? approvals.length > 0 : true);
			const agentFailed = !agentRunning && src.lastAgentError !== undefined && src.lastAgentError !== null;
			const agentState = agentRunning ? "running" : (agentFailed ? "error" : (approvalWaiting ? "approval" : "idle"));
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
				if (tipId === id) {
					setTipId(null);
					setTipPos(null);
					return;
				}
				/* 点开余额 / 峰谷用量：顺手重查一次（收起那一下不查），数据回来气泡自己更新 */
				if (id === "balance" && balanceReloadRef.current !== null) balanceReloadRef.current();
				if (id === "status" && dailyReloadRef.current !== null) dailyReloadRef.current();
				/* 总计：队友的数字也要重取一次 —— 3 秒节流靠的是那条每秒时钟，而会话完全空闲时
				   它不跳（睡到下一个峰谷边界），光靠它会让数字停在旧值 */
				if (id === "cost" && subagentReloadRef.current !== null) subagentReloadRef.current();
				const target = event !== undefined && event !== null ? event.currentTarget : null;
				/* 存节点而不是当次的矩形：窗口缩放后要重新量 */
				anchorRef.current = target !== null && typeof target.getBoundingClientRect === "function" ? target : null;
				setTipId(id);
				setTipPos(null);
			};
			/* 面板挂在触发项自己身上（当子元素），这样气泡正好出现在该项正上方 */
			const tipPanelOf = (tip) => {
				if (tip === undefined || tip === null) return null;
				if (tip.kind === "tokens") return tokenPanel(tip.panel, tip.title, tipPos, tipRef);
				if (tip.kind === "meter") return meterPanel(tip.meter, t, tipPos, tipRef);
				if (tip.kind === "bars") return weekBarsPanel(tip, t, tipPos, tipRef, onHover, { week: hoverWeek, bar: hoverBar });
				return rowsPanel(tip, tipPos, tipRef, { id: tipSub, open: setTipSub, back: () => setTipSub(null) });
			};
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
					contextRing(contextMeter.percent, agentState, contextMeter.compact),
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
			   所以 host 的投影始终最新；设置页进来读一次就够，不需要轮询。 */
			react.useEffect(() => {
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
			}, []);

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
				h("h2", { className: "dsb-pagetitle" }, t("sectionTitle")),
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
						/* window.open 会被主窗口的 setWindowOpenHandler 接住，转 shell.openExternal → 默认浏览器；
						   noopener 只是不给新窗口留 window.opener（这里窗口本来就被拒了） */
						onClick: () => window.open(REPO_URL, "_blank", "noopener")
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
				/* 有新版才出现：与导航胶囊同一个来源（updateState），点它走 DSH 官方的插件安装接口。
				   三种状态都写在按钮自己身上：空闲报版本号、更新中带动效点、失败就说「更新失败」；
				   装完直接撤掉 —— 末尾的版本号尾标会变成新版本，不必再多一句提示。 */
				update.hasUpdate === true && update.note !== "done"
					? h("button", {
						type: "button",
						className: "dsb-action",
						key: "__update",
						disabled: update.busy === true,
						onClick: startPluginUpdate
					}, update.busy === true
						? [t("updateRunning"), h("span", { className: "dsb-dots", key: "__dots" }, [
							h("span", { key: "__d1" }, "."),
							h("span", { key: "__d2" }, "."),
							h("span", { key: "__d3" }, ".")
						])]
						: (update.note === "failed"
							? t("updateFailed")
							: t("updateTo", { version: update.latest === null ? "" : update.latest })))
					: null,
				/* 版本标记贴右、与行内底边对齐：改了客户端代码要刷新页面才生效，这行字让"跑的是哪版"一眼可见 */
				h("span", { className: "dsb-version", key: "__version" }, "dsh-desktop-statusbar " + VERSION)
			]));

			return h("div", { className: "dsb-settings" }, sections);
		}

		/* --------------------------------------------------------------- apply */

		/* 自测/测试成员可直接拿到的纯函数（跨请求场景要靠它们驱动，见 tests/ 里的 harness）。
		   注意：测试 harness 习惯在 `exports.apply = apply;` 那一行**前**插一份自己的
		   `exports.__test = {...}`，位置在下面这行之后 ⇒ 它们那份会覆盖这一份（这是有意的，
		   免得两份列表互相打架）；要测这里的东西，把它们加进 harness 自己那份列表即可。 */
		exports.__test = {
			nextSubagentState: nextSubagentState,
			applyTurnFloor: applyTurnFloor,
			SUBAGENT_STATE_EMPTY: SUBAGENT_STATE_EMPTY
		};

		function apply(ctx) {
			/* 存下来给「更新」按钮用：它要调 ctx.remote.pluginManager */
			pluginCtx = ctx;
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
