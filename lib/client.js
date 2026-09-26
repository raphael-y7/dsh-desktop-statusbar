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

		const NS = "dsh-desktop-statusbar";
		const STYLE_TAG_ID = "dsh-desktop-statusbar/styles";
		const STORAGE_KEY = "dsh.desktopStatusBar.v1";
		/** 改名前用的旧键：读到就迁移过来，保留是为了能回退到旧版本。 */
		const LEGACY_STORAGE_KEY = "dsh.miniStatusBar.v1";
		const BALANCE_URL = "/dsh-desktop-statusbar/api/balance";
		const ACTIVE_MODEL_URL = "/dsh-desktop-statusbar/api/active-model";
		/* 余额轮询：host 端不再缓存，所以这个间隔就是底栏的更新粒度（1 分钟一次） */
		const BALANCE_POLL_MS = 60000;
		const PRICES_URL = "/dsh-desktop-statusbar/api/prices";
		const HOLIDAYS_URL = "/dsh-desktop-statusbar/api/holidays";
		/**
		 * 配置结构版本。
		 * v6 起：`segments` 存全部段的有序列表（顺序对整份列表生效），`hidden` 存未勾选的段。
		 */
		const CONFIG_VERSION = 6;
		/** 官方参考价的版本：官方调价时改这个数字，老价格库会自动并入新参考价。 */
		const PRICE_VERSION = 2;

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

		const EMPTY_TIER = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

		/** 把一条价格规范化成 { peak, offPeak }；旧的平铺结构视为两档同价。 */
		/** 两档数值是否逐项相同：用来识别被写坏的「空闲价 = 高峰价」。 */
		function sameTier(left, right) {
			if (left === null || left === undefined || right === null || right === undefined) return false;
			return left.input === right.input && left.cacheRead === right.cacheRead
				&& left.cacheWrite === right.cacheWrite && left.output === right.output;
		}

		function normalizePrice(entry) {
			if (entry === null || entry === undefined || typeof entry !== "object") return null;
			const flatten = (value) => ({
				input: Number(value.input) || 0,
				cacheRead: Number(value.cacheRead) || 0,
				cacheWrite: Number(value.cacheWrite) || 0,
				output: Number(value.output) || 0
			});
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

		/** 按当前价格库查模型单价（规范化成峰谷两档）；精确名优先，其次子串匹配；找不到返回 null。 */
		function priceOf(model) {
			if (typeof model !== "string") return null;
			const book = config.models === undefined || config.models === null ? {} : config.models;
			if (book[model] !== undefined) return normalizePrice(book[model]);
			const lower = model.toLowerCase();
			const keys = Object.keys(book);
			for (let i = 0; i < keys.length; i += 1) {
				if (lower.indexOf(keys[i].toLowerCase()) !== -1) return normalizePrice(book[keys[i]]);
			}
			return null;
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

		/** 价格库是否为空或全是 0（用户可能加过一个没填价的条目）。 */
		function pricesMissing(book) {
			if (book === null || book === undefined || typeof book !== "object") return true;
			const names = Object.keys(book);
			if (names.length === 0) return true;
			for (let i = 0; i < names.length; i += 1) {
				const price = normalizePrice(book[names[i]]);
				if (price === null) continue;
				const total = price.peak.input + price.peak.cacheRead + price.peak.cacheWrite + price.peak.output
					+ price.offPeak.input + price.offPeak.cacheRead + price.offPeak.cacheWrite + price.offPeak.output;
				if (total > 0) return false;
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
		 * 按价格库算一段用量的费用（按给定时刻定峰谷），返回**未舍入的数值**。
		 * 不要在这里舍入：总计是逐条调用累加出来的，单条先砍到分会让几百次调用的误差累积成几毛钱
		 * （实测 171.8M token 的会话里少算了 0.75 元）。显示统一走 costText。
		 */
		function costOf(bucket, model, at) {
			const price = priceOf(model);
			if (price === null || bucket === undefined || bucket === null) return null;
			const tier = isPeakTime(at) ? price.peak : price.offPeak;
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
			return amount.toFixed(2);
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
				input: Number(entry.input) || 0,
				cacheRead: Number(entry.cacheRead) || 0,
				cacheWrite: Number(entry.cacheWrite) || 0,
				output: Number(entry.output) || 0
			};
		}
		function normalizeModels(rawModels) {
			const out = {};
			if (rawModels === null || rawModels === undefined || typeof rawModels !== "object") return out;
			const names = Object.keys(rawModels);
			for (let i = 0; i < names.length; i += 1) {
				const price = normalizePrice(rawModels[names[i]]);
				if (price === null) continue;
				out[names[i]] = {
					tiered: isTiered(rawModels[names[i]]),
					peak: normalizeTier(price.peak),
					offPeak: normalizeTier(price.offPeak)
				};
			}
			return out;
		}

		/**
		 * 把会话节点里**最后一轮**的用量折出来（节点带 turn 号与这条调用的 usage）。
		 * 返回 `{ turn, parts }`，没有可用节点时返回 null —— 轮号一起返回是为了让调用方
		 * 判断这份数据属于当前进行中的那一轮，还是上一轮（不能靠"往后跳一轮"猜，
		 * 当前轮还没产出节点时那样会错位到上上轮）。
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
			return found ? { turn: target, parts: acc } : null;
		}

		/* ---------------------------------------------------------------- i18n */
		const zh = {
			nav: "状态栏",
			sectionTitle: "状态栏设置",
			intro: "接管对话区底部的统计行。勾选要显示的字段、拖动调整顺序或配置模型费用单价。",
			segContext: "会话状态",
			segContextHint: "当前会话的运行状态与上下文占用。",
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
			tipToolTime: "工具调用",
			tipTtftFast: "最快首字延迟",
			tipTtftSlow: "最慢首字延迟",
			tipTpsFast: "最快输出速度",
			tipTpsSlow: "最慢输出速度",
			tipTopUp: "充值余额",
			tipGranted: "赠金余额",
			tipHitHigh: "最高缓存命中率",
			tipHitLow: "最低缓存命中率",
			contextAria: "上下文已用 {percent}",
			contextSystem: "系统提示词",
			contextTools: "工具定义",
			contextMessages: "对话消息",
			f_speed: "输出速度 {throughput}t/s",
			f_sessionTime: "总用时 {duration}",
			f_cost: "总计 {symbol}{cost}",
			priceTierPeak: "高峰时段",
			priceTierOffPeak: "空闲时段",
			f_balanceDash: "余额 -",
			f_lastCost: "本轮 {symbol}{cost}",
			f_balance: "余额 {symbol}{amount}",
			f_balanceSubCent: "余额 <{symbol}0.01",
			dragHint: "拖动排序",
			secSegments: "统计字段",
			secSegmentsHint: "勾选显示；按住拖动调整顺序。",
			secPrices: "自定义模型价格",
			secPricesHint: "填写你使用的模型单价（每百万 tokens / {currency}）。",
			segStatusHint: "自动判断当前的峰谷时段。",
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
			holidayUpdateBusy: "正在搜索节假安排...",
			holidayUpdateOk: "已写入 {year} 年 {count} 个节假日",
			holidayUpdateMissing: "国务院还没发布 {year} 年放假安排，过几天再试",
			holidayUpdateFail: "抓取失败（{reason}），检查网络后重试",
			holidayUpdateNoRoute: "状态栏后台还是旧版：完全退出并重启 DSH 后再点"
		};
		const en = {
			nav: "Status Bar",
			sectionTitle: "Status Bar Settings",
			intro: "Replaces the stats line under the message input. Select the fields to show, drag to reorder, or set model prices.",
			segContext: "Session status",
			segContextHint: "Run state and context occupancy of the current session.",
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
			tipToolTime: "Tool calls",
			tipTtftFast: "Fastest TTFT",
			tipTtftSlow: "Slowest TTFT",
			tipTpsFast: "Fastest TPS",
			tipTpsSlow: "Slowest TPS",
			tipTopUp: "Top-up balance",
			tipGranted: "Granted balance",
			tipHitHigh: "Highest cache hit rate",
			tipHitLow: "Lowest cache hit rate",
			contextAria: "{percent} of context used",
			contextSystem: "System prompt",
			contextTools: "Tool definitions",
			contextMessages: "Messages",
			f_speed: "TPS {throughput}t/s",
			f_sessionTime: "Time {duration}",
			f_cost: "Total {symbol}{cost}",
			priceTierPeak: "Peak",
			priceTierOffPeak: "Off-peak",
			f_lastCost: "This turn {symbol}{cost}",
			f_balance: "Balance {symbol}{amount}",
			f_balanceSubCent: "Balance <{symbol}0.01",
			dragHint: "Drag to reorder",
			secSegments: "Stats fields",
			secSegmentsHint: "Select to show; drag to reorder.",
			secPrices: "Custom model prices",
			secPricesHint: "Prices per million tokens, in {currency}.",
			segStatusHint: "Automatically determines the current peak / off-peak window.",
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
			unitSpeed: "t/s",
			priceSuggestedHint: "The price book uses the DeepSeek reference prices.",
			f_balanceDash: "Balance -",
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
			holidayUpdateBusy: "Searching the holiday schedule...",
			holidayUpdateOk: "Wrote {count} holidays for {year}",
			holidayUpdateMissing: "The {year} schedule is not published yet — try again in a few days",
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
			{ id: "ttft", label: "segTtft", hint: "segTtftHint", def: true, short: { zh: "首字平均", en: "TTFT" } },
			{ id: "tps", label: "segTps", hint: "segTpsHint", def: true, short: { zh: "输出速度", en: "TPS" } },
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
				models: Object.assign({}, DEFAULT_PRICES),
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
				/* 计价单位：只认 CNY / USD，其它值一律当人民币 */
				const currency = parsed.currency === "USD" ? "USD" : "CNY";
				const reference = referencePrices(currency);
				/* 价格库落后于参考价版本时并入官方价；用户自己改过的条目不覆盖 */
				/* 价格库为空或全 0 时直接用内嵌官方价（自愈，无需手动填） */
				if (pricesMissing(normalizeModels(parsed.models))) parsed.models = Object.assign({}, reference);
				const priceVersion = typeof parsed.priceVersion === "number" ? parsed.priceVersion : 0;
				const models = priceVersion < PRICE_VERSION
					? normalizeModels(Object.assign({}, parsed.models, reference))
					: normalizeModels(parsed.models);
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
			priceConfigured: parsed.priceConfigured === true,
					contextMeter: parsed.contextMeter !== false,
					segments: stored,
					hidden: hidden,
					currency: currency,
					priceVersion: PRICE_VERSION,
					priceConfigured: priceConfigured,
					models: Object.keys(models).length > 0 ? models : normalizeModels(reference),
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
		 * 换计价单位：内置参考价模型整体换到另一种币种的那套官方价，
		 * 只动"还没被改过"的条目 —— 手改过的价格保留，别覆盖用户的输入。
		 */
		function switchCurrency(code) {
			const next = code === "USD" ? "USD" : "CNY";
			if (next === config.currency) return null;
			const from = referencePrices(config.currency);
			const to = referencePrices(next);
			const models = Object.assign({}, config.models);
			Object.keys(to).forEach((name) => {
				const current = models[name];
				const before = from[name];
				if (current === undefined || current === null || before === undefined) return;
				if (!sameTier(current.peak, before.peak) || !sameTier(current.offPeak, before.offPeak)) return;
				models[name] = {
					tiered: current.tiered !== false,
					peak: Object.assign({}, to[name].peak),
					offPeak: Object.assign({}, to[name].offPeak)
				};
			});
			setConfig({ currency: next, models: models });
			/* 把换完的价格回给调用方：正在编辑的草稿要拿它重建，否则框里还是旧币种的数字 */
			return { currency: next, models: models };
		}
		/** 该段是否勾选显示：在段序里且不在 hidden 里。 */
		function isSegmentOn(cfg, id) {
			if (Array.isArray(cfg.segments) && cfg.segments.indexOf(id) === -1) return false;
			return !(Array.isArray(cfg.hidden) && cfg.hidden.indexOf(id) !== -1);
		}
		/**
		 * 把 fromId 插到 toId 的前面（after=false）或后面（after=true）。
		 * 先摘出被拖项再按目标定位，避免向下拖时索引差一位。
		 */
		function reorderSegments(fromId, toId, after) {
			if (fromId === null || fromId === undefined || toId === null || toId === undefined) return;
			if (fromId === toId) return;
			const next = config.segments.slice();
			if (next.indexOf(fromId) === -1 || next.indexOf(toId) === -1) return;
			next.splice(next.indexOf(fromId), 1);
			const at = next.indexOf(toId) + (after === true ? 1 : 0);
			next.splice(at, 0, fromId);
			setConfig({ segments: next });
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
		/** 秒级时长，保留一位小数（首字延迟这类不会超过一分钟的指标用）。 */
		/* ------------------------------------------------ 上下文占用（对齐官方口径） */
		/** 圆环几何：与官方 ContextMeter 一致（14px viewBox、2px 描边、半径 5.5） */
		const METER_RADIUS = 5.5;
		const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS;
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
		 * 圆环与分项面板要的数据；缺用量或缺窗口时返回 null（官方这时候也不显示）。
		 * 数字一律用千分位精确值（不缩写、不带约等于号），跟令牌面板保持同一套读法。
		 * @returns {{percent:number, used:string, window:string, rows:Array, segments:Array}|null}
		 */
		function meterView(pressure, breakdown, t) {
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
				window: formatTokensExact(occupancy.contextWindow),
				rows: rows,
				segments: segments
			};
		}

		/** 官方那种分段小条（分项面板里那条）。 */
		function meterBar(meter) {
			return h("span", { className: "dsb-bar" },
				meter.segments.map((segment, index) => h("span", {
					className: "dsb-bar-seg",
					key: "__bar" + index,
					style: { width: segment.width + "%", background: segment.color }
				})));
		}

		/** 状态位上的圆环：起点与官方一致在 12 点方向，进度是占用比例，颜色跟随运行状态。 */
		function contextRing(percent, state) {
			const stateClass = state === "running" ? " dsb-ring-running"
				: (state === "error" ? " dsb-ring-error" : (state === "approval" ? " dsb-ring-approval" : ""));
			const offset = METER_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, percent)) / 100);
			return h("svg", {
				className: "dsb-ring" + stateClass, key: "__ring", viewBox: "0 0 14 14", width: 14, height: 14
			},
				h("circle", { className: "dsb-ring-track", cx: 7, cy: 7, r: METER_RADIUS }),
				h("circle", {
					className: "dsb-ring-fill", cx: 7, cy: 7, r: METER_RADIUS,
					/* SVG 的弧默认从 3 点方向起，整体转 -90° 才是官方那种"12 点起、顺时针长" */
					transform: "rotate(-90 7 7)",
					strokeDasharray: METER_CIRCUMFERENCE, strokeDashoffset: offset
				}));
		}

		/** 气泡的 fixed 内联位置：JS 已按视口夹住；pos 为空时不写。宽度交给内容（CSS width:max-content）。 */
		function panelStyle(pos) {
			if (pos === null || pos === undefined) return undefined;
			return { left: pos.left + "px", bottom: pos.bottom + "px" };
		}

		/** 悬停气泡里的分项面板：标题 + 分段条 + 三行构成（复刻官方 ContextMeter）。 */
		function meterPanel(meter, t, pos, ref) {
			const [headBefore = "", headAfter = ""] = t("contextAria", { percent: READING_SLOT })
				.split(READING_SLOT).map((part) => part.trim());
			const head = [];
			if (headBefore.length > 0) head.push(h("span", { className: "dsb-meter-headline", key: "__hb" }, headBefore));
			head.push(h("span", { className: "dsb-meter-percent", key: "__hp" }, meter.percent + "%"));
			if (headAfter.length > 0) head.push(h("span", { className: "dsb-meter-headline", key: "__ha" }, headAfter));
			head.push(h("span", { className: "dsb-meter-figures", key: "__hf" }, meter.used + " / " + meter.window));
			const rows = meter.rows.map((row, index) => h("span", { className: "dsb-meter-row", key: "__mr" + index }, [
				h("span", { className: "dsb-meter-swatch", key: "__ms", style: { background: row.color } }),
				h("span", { className: "dsb-meter-name", key: "__mn" }, row.label),
				h("span", { className: "dsb-meter-value", key: "__mv" }, row.value)
			]));
			return h("span", { className: "dsb-tip dsb-meter", key: "__tip", ref: ref, style: panelStyle(pos) }, [
				h("span", { className: "dsb-meter-head", key: "__mh" }, head),
				meterBar(meter),
				rows.length > 0 ? h("span", { className: "dsb-meter-rows", key: "__mrows" }, rows) : null
			]);
		}

		/**
		 * 令牌面板数据：第一行是总用量，第二行三段占比（顶满 100%），下面三行明细。
		 * 数字一律千分位精确值，不带单位（面板标题已经说明是 token 用量）。
		 */
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
			return h("span", { className: "dsb-tip dsb-meter", key: "__tip", ref: ref, style: panelStyle(pos) }, [
				h("span", { className: "dsb-meter-head", key: "__th" }, [
					h("span", { className: "dsb-meter-headline", key: "__tl" }, title),
					h("span", { className: "dsb-meter-figures", key: "__tt" }, panel.totalText)
				]),
				meterBar({ segments: panel.segments }),
				h("span", { className: "dsb-meter-rows", key: "__trows" }, rows)
			]);
		}

		/** 简单两列面板：标题 + 主数值，下面若干「名称 / 数值」行（用时、极值、命中率、余额这类段用）。 */
		function rowsPanel(tip, t, pos, ref) {
			const rows = (tip.rows === undefined ? [] : tip.rows).map((row, index) => h("span", {
				className: "dsb-meter-row", key: "__xr" + index
			}, [
				h("span", { className: "dsb-meter-name", key: "__xn" }, row.label),
				h("span", { className: "dsb-meter-value", key: "__xv" }, row.value)
			]));
			return h("span", { className: "dsb-tip dsb-meter", key: "__tip", ref: ref, style: panelStyle(pos) }, [
				h("span", { className: "dsb-meter-head", key: "__xh" }, [
					h("span", { className: "dsb-meter-headline", key: "__xt" }, tip.title),
					tip.head === undefined || tip.head === null
						? null
						: h("span", { className: "dsb-meter-figures", key: "__xhf" }, tip.head)
				]),
				h("span", { className: "dsb-meter-divider", key: "__xdiv" }),
				rows.length > 0 ? h("span", { className: "dsb-meter-rows dsb-meter-rows-fit", key: "__xrows" }, rows) : null
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

		/** 令牌面板的 tip；三段全 0 时不给面板（省得弹一个空泡泡）。 */
		function tokensTip(parts, title, t) {
			const panel = parts === null ? null : tokenPanelView(parts.cached, parts.missInput, parts.output, t);
			return panel === null ? null : { kind: "tokens", title: title, panel: panel };
		}

		/** 毫秒 → 面板里的时长文本；0 或缺数据给横杠。 */
		function tipDuration(ms) {
			const text = formatDuration(ms);
			return text === null ? "-" : text;
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
		function segmentView(id, src, t) {
			const stats = src.stats;
			const usage = src.usage;
			const symbol = currencySymbol(src.currency);

						if (id === "status") {
				/* 拆分后这一段只出峰谷两个字：上下文占用圆环是独立开关，固定挂在栏首 */
				const period = src.now === undefined || src.now === null ? "" : (isPeakTime(src.now) ? t("f_peak") : t("f_valley"));
				return { id: id, text: period };
			}

			if (id === "counts") {
				if (stats === undefined || stats === null || !(stats.steps > 0)) return null;
				return { id: id, text: t("f_counts", { turns: stats.turns || 0, steps: stats.steps || 0 }) };
			}

			if (id === "ttft") {
				if (stats === undefined || stats === null || !(stats.ttftSteps > 0) || !(stats.ttftMs > 0)) return null;
				const duration = formatSeconds(stats.ttftMs / stats.ttftSteps);
				if (duration === null) return null;
				const timing = src.timing === undefined || src.timing === null ? null : src.timing;
				return {
					id: id,
					text: t("f_ttft", { duration: duration + "s" }),
					tip: {
						kind: "rows",
						title: t("segTtft"),
						rows: [
							{ label: t("tipTtftFast"), value: tipSeconds(timing === null ? null : timing.fastestTtft) },
							{ label: t("tipTtftSlow"), value: tipSeconds(timing === null ? null : timing.slowestTtft) }
						]
					}
				};
			}

			if (id === "cacheHit") {
				if (usage === undefined || usage === null) return null;
				const denominator = billedInputTokens(usage);
				if (denominator <= 0) return null;
				const percent = Math.min(99.99, ((usage.cacheReadTokens || 0) / denominator) * 100).toFixed(2);
				const extremes = cacheHitExtremes(src.sessionUsage);
				return {
					id: id,
					text: t("f_cacheHit", { percent: percent }),
					/* 点开看单次调用的最高/最低命中率（底栏那个是整会话的累计值） */
					tip: {
						kind: "rows",
						title: t("segCacheHit"),
						rows: [
							{ label: t("tipHitHigh"), value: extremes === null ? "-" : extremes.high },
							{ label: t("tipHitLow"), value: extremes === null ? "-" : extremes.low }
						]
					}
				};
			}

			if (id === "tps") {
				if (stats === undefined || stats === null || !(stats.decodeMs > 0) || !(stats.decodeTokens > 0)) return null;
				const throughput = formatThroughput(stats.decodeTokens / (stats.decodeMs / 1000));
				const timing = src.timing === undefined || src.timing === null ? null : src.timing;
				return {
					id: id,
					text: t("f_speed", { throughput: throughput }),
					tip: {
						kind: "rows",
						title: t("segTps"),
						rows: [
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
				return {
					id: id,
					text: t("f_sessionTime", { duration: duration }),
					/* 模型用时与工具调用用时都来自官方 sessionStats：同一步里并行调用各算各的，
					   两者之和会大于上面那个墙钟总用时（口径不同，不互相比较） */
					tip: {
						kind: "rows",
						title: t("segSessionTime"),
						rows: [
							{ label: t("tipModelTime"), value: tipDuration(stats === undefined || stats === null ? 0 : stats.llmMs) },
							{ label: t("tipToolTime"), value: tipDuration(stats === undefined || stats === null ? 0 : stats.toolMs) }
						]
					}
				};
			}

			if (id === "cost") {
				const sessionUsage = src.sessionUsage;
				if (sessionUsage === undefined || sessionUsage === null) return null;
				const calls = Array.isArray(sessionUsage.calls) ? sessionUsage.calls : null;
				if (calls === null || calls.length === 0) return null;
				/* 每条调用按自己发生的那一刻、自己的模型定峰谷：跨时段、跨模型都不会串价。
				   累加的是未舍入金额，最后一次性舍入 —— 逐条舍入会累积出几毛钱的误差。 */
				const fallbackModel = src.sessionModel !== undefined && src.sessionModel !== null ? src.sessionModel.model : null;
				let total = 0;
				let priced = false;
				for (let i = 0; i < calls.length; i += 1) {
					const callModel = typeof calls[i].model === "string" ? calls[i].model : fallbackModel;
					const one = costOf(calls[i], callModel, calls[i].at);
					if (one === null) continue;
					priced = true;
					total += one;
				}
				if (!priced) return null;
				return {
					id: id,
					text: t("f_cost", { symbol: symbol, cost: costText(total) }),
					/* token 计数并进总计：点这一段看会话的 token 明细 */
					tip: tokensTip(sessionTokenParts(src.usage), t("f_tokensTotal"), t)
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
				if (turnCalls !== null && turnCalls.length > 0) {
					let turnTotal = 0;
					let turnPriced = false;
					const turnParts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
					for (let i = 0; i < turnCalls.length; i += 1) {
						const callModel = typeof turnCalls[i].model === "string" ? turnCalls[i].model : fallbackModel;
						const one = costOf(turnCalls[i], callModel, turnCalls[i].at);
						turnParts.input += turnCalls[i].input || 0;
						turnParts.cacheRead += turnCalls[i].cacheRead || 0;
						turnParts.cacheWrite += turnCalls[i].cacheWrite || 0;
						turnParts.output += turnCalls[i].output || 0;
						if (one === null) continue;
						turnPriced = true;
						turnTotal += Number(one);
					}
					if (turnPriced) {
						return {
							id: id,
							text: t("f_lastCost", { symbol: symbol, cost: costText(turnTotal) }),
							/* 本轮点开的是本轮 token 明细，读法与总计那个面板同一套 */
							tip: tokensTip(billableParts(turnParts), t("f_tokensTurn"), t)
						};
					}
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
						return { id: id, text: t("f_lastCost", { symbol: symbol, cost: costText(runningCost) }), tip: null };
					}
				}
				/* 新一轮已经开跑、但还没有属于它的调用：本轮就是 0。
				   这里必须拦住 —— 否则会退回上一轮（节点折叠还错位过一轮，显示成上上轮）的金额，
				   发完消息底栏挂着一个旧数字，看着像没重置。 */
				if (active === true) {
					return { id: id, text: t("f_lastCost", { symbol: symbol, cost: costText(0) }), tip: null };
				}
				/* 空闲：显示最近完成的一轮（节点折叠 → 官方差分兜底），同样只出金额 */
				if (bucket === null) return null;
				const cost = costOf(bucket, fallbackModel, src.now);
				if (cost === null) return null;
				return { id: id, text: t("f_lastCost", { symbol: symbol, cost: costText(cost) }), tip: null };
			}

						if (id === "balance") {
				const balance = src.balance;
				if (balance === null || balance === undefined) return null;
				if (balance.ok !== true) return null;
				if (typeof balance.total !== "string") return null;
				/* 余额用接口自己报的币种：账户里是人民币就显示 ¥，不跟着上面的计价单位走 */
				const balSymbol = currencySymbol(balance.currency !== undefined && balance.currency !== null ? balance.currency : src.currency);
				/* 点开看构成：total = 充值余额 + 赠金余额；没有赠金时接口不给这个字段，按 0.00 显示 */
				const tip = {
					kind: "rows",
					title: t("segBalance"),
					rows: [
						{ label: t("tipTopUp"), value: balSymbol + balanceAmount(balance.toppedUp) },
						{ label: t("tipGranted"), value: balSymbol + balanceAmount(balance.granted) }
					]
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
		function segmentText(id, view, t) {
			if (view !== null && view !== undefined) return view.text;
			const segment = SEGMENTS.filter((s) => s.id === id)[0];
			if (segment === undefined || segment.short === undefined) return "";
			const locale = detectLocale(t);
			const label = segment.short[locale] !== undefined ? segment.short[locale] : segment.short.zh;
			const dash = "-";
			if (id === "counts") return dash + t("unitCountTurns") + " " + dash + t("unitCountSteps");
			if (id === "cacheHit") return label + " " + dash + " %";
			if (id === "ttft") return label + " " + dash + " s";
			/* 速度占位不带单位：英文那边标签已经是 TPS，再跟 t/s 就重复了 */
			if (id === "tps") return label + " " + dash;
			if (id === "sessionTime") return label + " " + dash + "m " + dash + "s";
			if (id === "cost" || id === "lastCost") return label + " " + dash + " " + currencySymbol(config.currency);
			if (id === "balance") return t("f_balanceDash");
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
			".dsb-ring-running .dsb-ring-fill{stroke:#22c55e}",
			".dsb-ring-error .dsb-ring-fill{stroke:#ef4444}",
			".dsb-ring-approval .dsb-ring-fill{stroke:#f59e0b}",
			".dsb-bar{display:flex;gap:1px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.15));overflow:hidden;margin:6px 0 2px}",
			".dsb-bar-seg{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--dsw-alias-label-tertiary)}",
			/* 宽度按内容自适应：width:max-content 让气泡收到"最长那一行"的宽度，
			 * 行内标签与数值之间至少留 6ch（下面的 padding-left），所以不会出现大片留白；
			 * 内容超过 max-width 时退回换行（white-space:normal）。 */
			".dsb-tip.dsb-meter{width:max-content;max-width:min(560px,100vw - 24px);white-space:normal;font-size:12px;line-height:18px}",
			".dsb-meter-head{display:flex;align-items:center;gap:6px}",
			".dsb-meter-headline{color:var(--dsw-alias-label-primary)}",
			".dsb-meter-percent{color:var(--dsw-alias-label-primary);font-weight:500}",
			/* 标签与数值之间至少留 6ch：配合上面的 width:max-content，气泡宽度就是
			 * "最长那一行的标签 + 六个空格 + 数值"，其余行在这个宽度里右对齐（间隙更大）。 */
			".dsb-meter-figures{margin-left:auto;padding-left:6ch;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}",
			/* 复刻官方「会话统计」面板：标题下面那条细线（有进度条的面板不加，条本身就分隔了） */
			".dsb-meter-divider{display:block;height:1px;margin:5px 0 0;background:var(--dsw-alias-separator-primary,rgba(127,127,127,.3))}",
			".dsb-meter-rows{display:flex;flex-direction:column;margin-top:4px}",
			/* 两列气泡（标题下带分隔线的那几个）线到第一行再收 3px */
			".dsb-meter-rows-fit{margin-top:1px}",
			".dsb-meter-row{display:flex;align-items:center;gap:6px;padding:2px 0}",
			".dsb-meter-swatch{flex:none;width:8px;height:8px;border-radius:2px}",
			".dsb-meter-name{color:var(--dsw-alias-label-secondary)}",
			".dsb-meter-value{margin-left:auto;padding-left:6ch;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
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
			".dsb-tip{position:fixed;box-sizing:border-box;padding:6px 10px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f));background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3));white-space:nowrap;z-index:40;pointer-events:none}",
			".dsb-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			/* 设置页 */
			".dsb-settings{display:flex;flex-direction:column;gap:18px;font-size:14px}",
			/* 页头：与官方 Agent 预设设置页同款（18px/600，标题与说明间距 12px） */
			".dsb-settings .dsb-head{display:flex;flex-direction:column;gap:12px}",
			".dsb-settings .dsb-pagetitle{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dsb-settings .dsb-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}",
			".dsb-settings .dsb-section{display:flex;flex-direction:column;gap:8px}",
			".dsb-settings .dsb-sectitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;letter-spacing:.02em}",
			".dsb-settings .dsb-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}",
			".dsb-settings .dsb-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".dsb-settings .dsb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}",
			".dsb-settings .dsb-check{display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;min-width:0}",
			".dsb-settings .dsb-check input{flex:none;margin:2px 0 0}",
			".dsb-settings input[type=checkbox]{accent-color:var(--dsw-alias-label-primary,#202020)}",
			".dsb-settings .dsb-labels{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dsb-settings .dsb-name{color:var(--dsw-alias-label-primary)}",
			".dsb-settings .dsb-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}",
			".dsb-settings .dsb-row.dsb-dragging{opacity:.35}",
			".dsb-settings .dsb-row.dsb-over-before{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}",
			".dsb-settings .dsb-row.dsb-over-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#4d6bfe)}",
			".dsb-settings .dsb-handle{position:relative;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);cursor:grab}",
			'.dsb-settings .dsb-handle::before{content:"";position:absolute;left:4px;top:1.5px;width:3px;height:3px;border-radius:50%;background:currentColor;box-shadow:5px 0 0 currentColor,0 5px 0 currentColor,5px 5px 0 currentColor,0 10px 0 currentColor,5px 10px 0 currentColor}',
			".dsb-settings .dsb-handle:active{cursor:grabbing}",
			".dsb-settings .dsb-handle-off{opacity:.25;cursor:default}",
			/* 价格库 */
			".dsb-settings .dsb-card{border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.25));border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
			".dsb-settings .dsb-current{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}",
			".dsb-settings .dsb-current b{color:var(--dsw-alias-label-primary);font-weight:600}",
			".dsb-settings .dsb-models{display:flex;flex-direction:column}",
			".dsb-settings .dsb-model{position:relative;display:flex;flex-direction:column;gap:8px;padding:6px 0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.18))}",
			/* 编辑区：毛玻璃浮层，从卡片头部下方展开，盖在下面的内容上 */
			".dsb-settings .dsb-edit-pop{position:absolute;top:calc(100% - 2px);left:0;right:0;z-index:55;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-lg,16px);background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3))}",
			".dsb-settings .dsb-tier{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsb-settings .dsb-tier-name{flex:none;width:48px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsb-settings .dsb-model:first-child{border-top:0;padding-top:0}",
			".dsb-settings .dsb-model:last-child{padding-bottom:0}",
			".dsb-settings .dsb-model-name{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}",
			".dsb-settings .dsb-model-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}",
			".dsb-settings .dsb-model-actions{display:flex;gap:6px;flex:none}",
			/* 峰谷计价那个勾选只占"勾选框 + 四个字"的宽度，不然整行都能点 */
			".dsb-settings .dsb-inline-check{display:flex;align-self:flex-start;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			/* 勾选在左、计价单位在右 */
			".dsb-settings .dsb-tier-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".dsb-settings .dsb-select{position:relative}",
			/* 就一个窄框，字号跟旁边的「峰谷计价」一致，不带下拉箭头 */
			".dsb-settings .dsb-select-btn{display:inline-flex;align-items:center;height:22px;padding:0 8px;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));border-radius:6px;cursor:pointer}",
			/* 下拉复刻底栏气泡那套材质：半透明菜单底 + 毛玻璃 + 大圆角 + .5px 描边柔光 */
			".dsb-settings .dsb-select-menu{position:absolute;top:calc(100% + 4px);right:0;min-width:92px;padding:4px;border-radius:var(--dsw-radius-lg,16px);background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#1f1f1f)) r g b / .382);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));box-shadow:0 0 0 .5px var(--dsw-alias-border-l1,rgba(127,127,127,.3));z-index:60}",
			".dsb-settings .dsb-select-item{display:block;width:100%;padding:6px 10px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}",
			".dsb-settings .dsb-select-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
			".dsb-settings .dsb-select-item-on{color:var(--dsw-alias-brand-primary,#4d6bfe)}",
			/* 三组字段整体贴右边缘：左边留给时段名，右边一列对齐 */
			".dsb-settings .dsb-fields{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}",
			".dsb-settings .dsb-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			/* 够放 xx.xx 就行，输入框不再拉一大条 */
			".dsb-settings .dsb-field input{width:56px;text-align:right}",
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
			".dsb-settings .dsb-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
			".dsb-settings .dsb-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}"
		].join("");

		/* 导航图标使用外部传入的 gauge（24x24 lucide，stroke=currentColor，随主题变色） */
		const NAV_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-gauge"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';

		/**
		 * 把设置导航里本插件那一项的前导图标换成 gauge。
		 * 定位方式是按导航文案匹配（DSH 没给导航项留 id 属性），匹配不到就什么都不做。
		 */
		function installNavIcon(getLabel) {
			const apply = () => {
				const label = getLabel();
				if (typeof label !== "string" || label.length === 0) return;
				const cells = document.querySelectorAll("nav button");
				for (let i = 0; i < cells.length; i += 1) {
					const cell = cells[i];
					if (String(cell.textContent).trim() !== label) continue;
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
			return () => observer.disconnect();
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

			const running = pick(useSession, (s) => s.running, undefined);
			const partial = pick(useSession, (s) => s.partial, undefined);
			const runningCalls = pick(useSession, (s) => s.runningCalls, undefined);
			const lastAgentError = pick(useSession, (s) => s.lastAgentError, undefined);
			const pendingApprovals = pick(useSession, (s) => s.pendingApprovals, undefined);
			const timeline = pick(props.useChat, (s) => s.timeline, undefined);
			const chatNodes = pick(props.useChat, (s) => (s.legacy === undefined || s.legacy === null ? undefined : s.legacy.nodes), undefined);

			const [now, setNow] = react.useState(() => Date.now());
			const [balance, setBalance] = react.useState(null);
			const [tipId, setTipId] = react.useState(null);
			const [tipPos, setTipPos] = react.useState(null);
			/* 气泡只由点击展开（圆环或各字段），再点一次或点别处收起 */
			const rootRef = react.useRef(null);
			/* 气泡定位：触发项位置 + 对齐方式（left / center / right）+ 面板节点（用来量宽度） */
			const anchorRef = react.useRef(null);
			const tipModeRef = react.useRef("center");
			const tipRef = react.useRef(null);
			/* 窗口缩放时 +1，只为让定位 effect 重新量一次位置 */
			const [tipTick, setTipTick] = react.useState(0);

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
			react.useEffect(() => {
				if (!wantsBalance) return undefined;
				let alive = true;
				const load = () => {
					window.fetch(BALANCE_URL, { cache: "no-store" })
						.then((response) => response.json())
						.then((data) => { if (alive) setBalance(data); })
						.catch(() => { if (alive) setBalance({ ok: false, reason: "fetch-failed" }); });
				};
				load();
				const timer = window.setInterval(load, BALANCE_POLL_MS);
				return () => { alive = false; window.clearInterval(timer); };
			}, [wantsBalance]);

			/* 只在"点别处"时收起。这里刻意不监听 scroll：底栏固定在视口底部，对话区滚动
			   不会移动触发项，但每来一次工具调用/新一轮，对话区都会自动滚到底 ——
			   跟着 scroll 收起的话，气泡会在这些时刻莫名其妙消失。 */
			react.useEffect(() => {
				if (tipId === null) return undefined;
				const close = () => { setTipId(null); setTipPos(null); };
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
				const mode = tipModeRef.current;
				const centered = anchor.left + anchor.width / 2 - width / 2;
				const wanted = mode === "left" ? anchor.left : (mode === "right" ? anchor.right - width : centered);
				setTipPos({
					left: Math.max(8, Math.min(wanted, window.innerWidth - width - 8)),
					bottom: Math.max(8, window.innerHeight - anchor.top + 6)
				});
			}, [tipId, tipTick]);

			/* 开关状态同步到 <html>：CSS 里那两条"藏官方底栏"的规则挂在 html.dsb-on 上。 */
			/* 开关状态同步到 <html>：CSS 里那两条"藏官方底栏"的规则挂在 html.dsb-on 上。 */
			react.useEffect(() => {
				if (typeof document === "undefined" || document === null) return undefined;
				const root = document.documentElement;
				if (root === null || root === undefined || root.classList === undefined) return undefined;
				root.classList.add("dsb-on");
				return () => { root.classList.remove("dsb-on"); };
			}, []);

			/* 本轮费用：优先节点折叠（与官方同源），节点缺失才用差分兜底 */
			/* 本轮费用：优先节点折叠（与官方同源），节点缺失才用差分兜底 */
			const foldedTurn = foldTurnUsage(chatNodes);
			const turnUsage = foldedTurn !== null ? foldedTurn.parts : turnLastRef.current;
			/* 这份用量属于哪一轮（节点折叠才有；差分兜底没有轮号） */
			const turnUsageTurn = foldedTurn !== null ? foldedTurn.turn : null;
			/* host 投影说的当前轮号：用来判断上面那份用量是不是本轮正在进行中的 */
			const currentTurn = sessionUsage !== undefined && sessionUsage !== null && typeof sessionUsage.turn === "number"
				? sessionUsage.turn
				: null;

			const debugSrc = {
				stats: stats, usage: usage,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRangeNow,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: cfg.currency,
				timing: timing, turnUsageTurn: turnUsageTurn, currentTurn: currentTurn
			};
			window.__dsbDebug = {
				now: now, running: running, clockActive: clockActive, timeRange: timeRangeNow,
				steps: stats === undefined || stats === null ? undefined : stats.steps,
				sessionModel: sessionModel === undefined ? null : sessionModel,
				priceBook: config.models,
				peakNow: isPeakTime(now),
				calls: sessionUsage !== undefined && sessionUsage !== null && Array.isArray(sessionUsage.calls) ? sessionUsage.calls.length : 0,
				lastCalls: sessionUsage !== undefined && sessionUsage !== null && Array.isArray(sessionUsage.calls) ? sessionUsage.calls.slice(-3) : [],
				modelsAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.models,
				currentAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.current,
				lastAgg: sessionUsage === undefined || sessionUsage === null ? null : sessionUsage.last,
				turnUsage: turnUsage,
				turnUsageTurn: turnUsageTurn,
				currentTurn: currentTurn,
				timing: timing,
				costText: segmentText("cost", segmentView("cost", debugSrc, t), t),
				lastCostText: segmentText("lastCost", segmentView("lastCost", debugSrc, t), t),
				sessionTime: segmentText("sessionTime", segmentView("sessionTime", debugSrc, t), t)
			};

			const src = {
				stats: stats, usage: usage,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRange,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: cfg.currency,
				pressure: pressure, breakdown: breakdown, timing: timing,
				turnUsageTurn: turnUsageTurn, currentTurn: currentTurn
			};

			const views = [];
			cfg.segments.filter((id) => isSegmentOn(cfg, id)).forEach((id) => {
				const view = segmentView(id, src, t);
				/* 保留 view 上的 state（状态点靠它上色），只把缺数据的段换成占位文本 */
				views.push(view !== null && view !== undefined
					? view
					: { id: id, text: segmentText(id, view, t) });
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
			/* 会话状态是独立开关：固定在栏首、不参与排序；没有占用数据时整块不出现（不再退化成小圆点） */
			const contextMeter = cfg.contextMeter === true ? meterView(pressure, breakdown, t) : null;
			/* 可点项的顺序（含最前面的圆环）：最左、最右那两个气泡贴边对齐，其余跟字段居中 */
			const tipKeys = [];
			if (contextMeter !== null) tipKeys.push("context");
			views.forEach((view) => {
				if (view.text === "") return;
				const one = view.tip === undefined ? null : view.tip;
				if (one !== null) tipKeys.push(view.id);
			});
			const modeOf = (key) => {
				const at = tipKeys.indexOf(key);
				if (at < 0) return "center";
				if (at === 0) return "left";
				return at === tipKeys.length - 1 ? "right" : "center";
			};
			/* 打开时保存触发项的位置并收起上一次的气泡；真正的坐标等面板挂上、量到宽度后再算 */
			const toggleTip = (id, event, mode) => {
				if (tipId === id) {
					setTipId(null);
					setTipPos(null);
					return;
				}
				const target = event !== undefined && event !== null ? event.currentTarget : null;
				/* 存节点而不是当次的矩形：窗口缩放后要重新量 */
				anchorRef.current = target !== null && typeof target.getBoundingClientRect === "function" ? target : null;
				tipModeRef.current = mode === undefined || mode === null ? "center" : mode;
				setTipId(id);
				setTipPos(null);
			};
			/* 面板挂在触发项自己身上（当子元素），这样气泡正好出现在该项正上方 */
			const tipPanelOf = (tip) => {
				if (tip === undefined || tip === null) return null;
				if (tip.kind === "tokens") return tokenPanel(tip.panel, tip.title, tipPos, tipRef);
				if (tip.kind === "meter") return meterPanel(tip.meter, t, tipPos, tipRef);
				return rowsPanel(tip, t, tipPos, tipRef);
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
					onClick: (event) => toggleTip("context", event, modeOf("context"))
				}, [
					contextRing(contextMeter.percent, agentState),
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
					onClick: tip !== null ? (event) => toggleTip(view.id, event, modeOf(view.id)) : undefined
				}, tip !== null
					? [h("span", { key: "__txt" }, view.text), tipId === view.id ? tipPanelOf(tip) : null]
					: view.text));
			});
			return h("span", {
				ref: rootRef,
				className: "dsb-root",
				"data-dsb": "bar"
			}, children);
		}

		/* -------------------------------------------------------------- 设置页 */
		function SettingsSection(props) {
			const t = props.t;
			const cfg = useConfig();

			const [dragId, setDragId] = react.useState(null);
			const [overId, setOverId] = react.useState(null);
			const [overAfter, setOverAfter] = react.useState(false);   /* 落点画在目标行的下半区 */
			const [newModel, setNewModel] = react.useState("");
			const [hostModel, setHostModel] = react.useState(null);
			const [editing, setEditing] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [holidayBusy, setHolidayBusy] = react.useState(false);
			const [holidayNote, setHolidayNote] = react.useState(null);
			const [currencyOpen, setCurrencyOpen] = react.useState(false);
			const currencyRef = react.useRef(null);
			const editPopRef = react.useRef(null);

			/* 编辑浮层比卡片本身高，会被设置页的滚动容器裁掉下半截 —— 打开后滚一下，
			   把它的底边对齐到可视区底部，整块就都看得见了。 */
			react.useEffect(() => {
				if (editing === null) return;
				const node = editPopRef.current;
				if (node === null || node === undefined || typeof node.scrollIntoView !== "function") return;
				node.scrollIntoView({ block: "end", behavior: "smooth" });
			}, [editing]);

			/* 编辑浮层：点别处就收起，草稿一律丢弃 —— 改了一半的数字、新模型里填的空值都不留下 */
			react.useEffect(() => {
				if (editing === null) return undefined;
				const onDocClick = (event) => {
					const node = editPopRef.current;
					if (node !== null && node !== undefined && typeof node.contains === "function" && node.contains(event.target)) return;
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

			/* 当前会话模型：底栏会上报给 host，这里读取（设置页自己拿不到会话投影） */
			react.useEffect(() => {
				let alive = true;
				const pull = () => {
					window.fetch(ACTIVE_MODEL_URL, { cache: "no-store" })
						.then((response) => response.json())
						.then((data) => {
							if (alive !== true) return;
							const model = data !== null && data !== undefined && typeof data.model === "string" && data.model.length > 0 ? data.model : null;
							setHostModel(model);
						})
						.catch(() => { /* 拿不到就保持未识别 */ });
				};
				pull();
				const timer = window.setInterval(pull, 10000);
				return () => { alive = false; window.clearInterval(timer); };
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
				next[name] = { tiered: false, peak: Object.assign({}, EMPTY_TIER), offPeak: Object.assign({}, EMPTY_TIER) };
				setNewModel("");
				setConfig({
					models: next,
					modelOrder: (Array.isArray(cfg.modelOrder) ? cfg.modelOrder : Object.keys(cfg.models)).concat([name])
				});
				startEdit(name, next[name]);   /* 新加的模型直接展开待填（默认单档） */
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
			/** 打开编辑：价格抄进草稿，数字转字符串，输入过程中不会被清零。 */
			function startEdit(name, preset) {
				const stored = preset === undefined ? cfg.models[name] : preset;
				const entry = normalizePrice(stored);
				const asText = (tier) => ({
					input: String(tier.input),
					cacheRead: String(tier.cacheRead),
					cacheWrite: String(tier.cacheWrite),
					output: String(tier.output)
				});
				setDraft({
					tiered: isTiered(stored),
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
					/* 只改被编辑的那一格；另一档原样留着（切换计价方式不该丢数值） */
					const next = { tiered: prev.tiered, peak: Object.assign({}, prev.peak), offPeak: Object.assign({}, prev.offPeak) };
					next[tierKey][field] = value;
					return next;
				});
			}
			function setDraftTiered(on) {
				setDraft((prev) => {
					if (prev === null) return prev;
					/* 用哪一档由 tiered 决定，两档数值都保留：取消勾选再勾回来，空闲价还在 */
					return {
						tiered: on,
						peak: Object.assign({}, prev.peak),
						offPeak: Object.assign({}, prev.offPeak)
					};
				});
			}
			function saveDraft() {
				if (editing === null || draft === null) return;
				const num = (value) => Number(value) || 0;
				const asNumber = (tier) => ({ input: num(tier.input), cacheRead: num(tier.cacheRead), cacheWrite: num(tier.cacheWrite), output: num(tier.output) });
				const next = Object.assign({}, cfg.models);
				next[editing] = {
					tiered: draft.tiered === true,
					peak: asNumber(draft.peak),
					/* 两档都照实存：计价用哪一档看 tiered，取消勾选不该把空闲价抹掉 */
					offPeak: asNumber(draft.offPeak)
				};
				setConfig({ models: next, priceConfigured: true });
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

			const contextRow = h("div", { className: "dsb-row", key: "__context" },
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

			const segmentRows = orderedSegments.map((segment) => {
				const on = isSegmentOn(cfg, segment.id);
				const classes = ["dsb-row"];
				if (dragId === segment.id) classes.push("dsb-dragging");
				if (overId === segment.id && dragId !== segment.id) {
					classes.push(overAfter === true ? "dsb-over-after" : "dsb-over-before");
				}
				return h("div", {
					className: classes.join(" "),
					key: segment.id,
					draggable: true,   /* 未勾选的段也能调位置 */
					onDragStart: (event) => {
						setDragId(segment.id);
						try {
							event.dataTransfer.effectAllowed = "move";
							event.dataTransfer.setData("text/plain", segment.id);
						} catch (error) { /* 某些环境 dataTransfer 受限 */ }
					},
					onDragOver: (event) => {
						if (dragId === null || dragId === segment.id) return;
						event.preventDefault();
						try { event.dataTransfer.dropEffect = "move"; } catch (error) { /* ignore */ }
						/* 以目标行中线分前后；中线附近 4px 内保持原状态，避免来回闪 */
						const rect = event.currentTarget.getBoundingClientRect();
						const middle = rect.top + rect.height / 2;
						if (Math.abs(event.clientY - middle) < 4) return;
						const after = event.clientY > middle;
						if (overId !== segment.id || overAfter !== after) {
							setOverId(segment.id);
							setOverAfter(after);
						}
					},
					onDragLeave: () => {
						if (overId === segment.id) {
							setOverId(null);
							setOverAfter(false);
						}
					},
					onDrop: (event) => {
						event.preventDefault();
						reorderSegments(dragId, segment.id, overId === segment.id && overAfter === true);
						setDragId(null);
						setOverId(null);
						setOverAfter(false);
					},
					onDragEnd: () => { setDragId(null); setOverId(null); setOverAfter(false); }
				},
					h("label", { className: "dsb-check" },
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
						title: on === true ? t("dragHint") : ""
					})
				);
			});
			sections.push(h("div", { className: "dsb-section", key: "__segments" },
				h("div", { className: "dsb-sectitle" }, t("secSegments")),
				h("p", { className: "dsb-hint" }, t("secSegmentsHint")),
				contextRow,
				segmentRows
			));

			/* 自定义模型价格 */
			const priceCards = [];
			priceCards.push(h("div", { className: "dsb-hint", key: "__pricehint" }, t("secPricesHint", { currency: cfg.currency })));
			/* "当前会话使用"提示：设置页是否能拿到投影由宿主决定，拿不到就显示占位 */
			const settingsModel = typeof props.useProjection === "function" ? props.useProjection("desktopStatusbarModel") : undefined;
			const currentModelName = settingsModel !== null && settingsModel !== undefined && typeof settingsModel.model === "string"
				? settingsModel.model
				: null;
			const shownModel = currentModelName !== null ? currentModelName : hostModel;
			priceCards.push(h("div", { className: "dsb-current", key: "__current" },
				t("priceCurrent") + " ",
				h("b", null, shownModel === null ? t("modelUnknown") : displayModelName(shownModel))
			));			if (cfg.priceConfigured !== true) {
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
						/* 这一行左边是「峰谷计价」勾选，右边挂计价单位下拉（没有标题，就一个框） */
						h("div", { className: "dsb-tier-head", key: "__tiered" },
							h("label", { className: "dsb-inline-check" },
								h("input", {
									type: "checkbox",
									checked: draft.tiered === true,
									onChange: (event) => setDraftTiered(event.target.checked)
								}),
								h("span", null, t("priceTiered"))
							),
							h("div", { className: "dsb-select", ref: currencyRef },
								h("button", {
									type: "button",
									className: "dsb-select-btn",
									"aria-haspopup": "listbox",
									"aria-expanded": currencyOpen === true ? "true" : "false",
									onClick: () => setCurrencyOpen(currencyOpen !== true)
								}, cfg.currency),
								currencyOpen === true
									? h("div", { className: "dsb-select-menu", role: "listbox" },
										["CNY", "USD"].map((code) => h("button", {
											type: "button",
											key: code,
											role: "option",
											"aria-selected": cfg.currency === code ? "true" : "false",
											className: cfg.currency === code ? "dsb-select-item dsb-select-item-on" : "dsb-select-item",
											onClick: () => {
												const switched = switchCurrency(code);
												setCurrencyOpen(false);
												/* 草稿跟着换成新币种的价格：不然框里还留着旧币种的数字 */
												if (switched !== null && editing !== null) startEdit(editing, switched.models[editing]);
											}
										}, code)))
									: null
							)
						),
						draft.tiered === true ? tierRow("offPeak", t("priceTierOffPeak")) : tierRow("peak", null),
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

			/* 收尾：恢复默认 + 常驻的「更新节假峰谷」；按钮右边只在点过之后出现状态 ——
			   搜索中 / 已写入概况，平时不占位。抓取失败的原因挪到按钮的悬停提示里 */
			const holidayStatus = holidaySummary(Date.now());
			const holidayFailure = holidayNote === null || holidayNote.ok === true
				? null
				: (holidayNote.reason === "no-route"
					? t("holidayUpdateNoRoute")
					: (holidayNote.reason === "not-found" || holidayNote.reason === "parse-empty"
						? t("holidayUpdateMissing", { year: holidayNote.year })
						: t("holidayUpdateFail", { reason: holidayNote.reason })));
			const holidayActions = [
				h("button", {
					type: "button",
					className: "dsb-action",
					key: "__holiday",
					disabled: holidayBusy === true,
					title: holidayFailure === null ? undefined : holidayFailure,
					onClick: () => {
						const year = nextHolidayYear(Date.now());
						setHolidayBusy(true);
						setHolidayNote(null);
						updateHolidays(year).then((result) => {
							setHolidayBusy(false);
							setHolidayNote(result);
						});
					}
				}, t("holidayUpdate"))
			];
			if (holidayBusy === true || holidayNote !== null) {
				holidayActions.push(h("span", { className: "dsb-hint", key: "__holidaystatus" },
					holidayBusy === true
						? t("holidayUpdateBusy")
						: t("holidayUpdateOk", { year: holidayStatus.year, count: holidayStatus.count })));
			}
			sections.push(h("div", { className: "dsb-foot", key: "__foot" }, [
				h("button", {
					type: "button",
					className: "dsb-action",
					key: "__reset",
					onClick: () => setConfig({
						contextMeter: true,
						segments: DEFAULT_SEGMENTS.slice(),
						hidden: [],
						currency: "CNY",
						models: Object.assign({}, DEFAULT_PRICES),
						modelOrder: Object.keys(DEFAULT_PRICES)
					})
				}, t("reset")),
				h("div", { className: "dsb-actions", key: "__actions" }, holidayActions)
			]));

			return h("div", { className: "dsb-settings" }, sections);
		}

		/* --------------------------------------------------------------- apply */
		function apply(ctx) {
			ctx.effect(installStyles, "dsh-desktop-statusbar: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "dsh-desktop-statusbar: locale");
			ctx.effect(() => installNavIcon(() => ctx.locale.bind(NS)("nav")), "dsh-desktop-statusbar: nav icon");

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
