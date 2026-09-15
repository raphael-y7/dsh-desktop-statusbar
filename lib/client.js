/**
 * dsh-desktop-statusbar — client 侧。
 *
 * 接管对话区底部的统计行，全部走官方 contract，不改动任何官方文件：
 *   1. 往 `conversation.composer.dock`（list 槽）追加自己的 cell（id 'mini-bar'）。
 *   2. 注入 CSS 藏掉官方 StatsPills（按本插件自己的 data-dsb 标记区分，不依赖官方类名）。
 *   3. 往 `settings.section` 注册设置页：基础开关 / 数据字段（拖拽排序）/ 自定义模型价格。
 *
 * 数据来源：
 *   - 官方投影 sessionStats / tokenUsage / contextPressure
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
		const BALANCE_POLL_MS = 60000;
		const PRICES_URL = "/dsh-desktop-statusbar/api/prices";
		/**
		 * 配置结构版本。
		 * v6 起：`segments` 存全部段的有序列表（顺序对整份列表生效），`hidden` 存未勾选的段。
		 */
		const CONFIG_VERSION = 6;
		/** 官方参考价的版本：官方调价时改这个数字，老价格库会自动并入新参考价。 */
		const PRICE_VERSION = 2;

		/* ------------------------------------------------------------ 价格库 */

		/** DeepSeek 参考价（CNY / 1M tokens）。高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，空闲价为高峰价的一半。 */
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

		const EMPTY_TIER = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

		/** 把一条价格规范化成 { peak, offPeak }；旧的平铺结构视为两档同价。 */
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
		 * 官方口径是"其余为空闲时段"，所以周末整天空闲价。
		 */
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		function isPeakTime(ms) {
			const at = typeof ms === "number" && ms > 0 ? ms : Date.now();
			const beijing = new Date(at + 8 * 3600 * 1000);
			const day = beijing.getUTCDay();
			if (day === 0 || day === 6) return false;
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
		 * 拿不到就用内嵌的 DEFAULT_PRICES。用户填过的非 0 价格不会被覆盖。
		 */
		function ensurePrices() {
			if (!pricesMissing(config.models)) return Promise.resolve(false);
			const fallback = () => {
				setConfig({ models: normalizeModels(DEFAULT_PRICES), priceVersion: PRICE_VERSION, priceConfigured: true });
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


		/** 按价格库算一段用量的费用（按给定时刻定峰谷），返回不带符号的两位小数字符串。 */
		function costOf(bucket, model, at) {
			const price = priceOf(model);
			if (price === null || bucket === undefined || bucket === null) return null;
			const tier = isPeakTime(at) ? price.peak : price.offPeak;
			const amount = ((bucket.input || 0) * tier.input
		+ (bucket.cacheRead || 0) * tier.cacheRead
		+ (bucket.cacheWrite || 0) * tier.cacheWrite
		+ (bucket.output || 0) * tier.output) / 1e6;
	/* 大缓存会话单条调用可能不到一分钱，退到 4 位小数，避免一律显示 0.00 */
	return amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2);
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

		function foldTurnUsage(nodes, skip) {
			if (!Array.isArray(nodes)) return null;
			const turns = [];
			for (const node of nodes) {
				if (node === null || node === undefined) continue;
				if (node.kind !== "assistant") continue;
				if (typeof node.turn !== "number") continue;
				if (turns.indexOf(node.turn) === -1) turns.push(node.turn);
			}
			if (turns.length <= skip) return null;
			turns.sort((a, b) => a - b);
			const target = turns[turns.length - 1 - skip];
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
			return found ? acc : null;
		}

		/* ---------------------------------------------------------------- i18n */
		const zh = {
			nav: "状态栏",
			intro: "接管对话区底部的统计行。勾选要显示的字段、拖动调整顺序或配置模型费用单价。",
			enabled: "启用状态栏",
			enabledHint: "关闭后底栏整体隐藏。",
			wrap: "允许换行",
			wrapHint: "开启后统计段自动折行；关闭时单行省略。",
			segStatus: "会话状态",
			segCounts: "轮次＆步数",
			segTtft: "首字延迟",
			segCacheHit: "缓存命中率",
			segTokens: "Token计数",
			segTps: "输出速度",
			segSessionTime: "运行用时",
			segCost: "会话费用",
			segLastCost: "本次费用",
			segBalance: "余额",
			f_peak: "高峰",
			f_valley: "低谷",
			f_counts: "{turns} 轮 {steps} 步",
			f_llm: "模型 {duration}",
			f_tool: "工具 {duration}",
			f_ttft: "首字平均 {duration}",
			f_cacheHit: "缓存命中 {percent}%",
			f_tokens: "{total} tokens",
			f_tokensHit: "输入(命中缓存)",
			f_tokensMiss: "输入(未命中缓存)",
			f_tokensOut: "输出",
			f_context: "上下文 {percent}%",
			f_speed: "输出速度 {throughput}t/s",
			f_sessionTime: "总用时 {duration}",
			f_cost: "总计 {symbol}{cost}",
			priceTierPeak: "高峰时段",
			priceTierOffPeak: "空闲时段",
			f_balanceDash: "余额 -",
			f_lastCost: "本轮 {symbol}{cost}",
			f_balance: "余额 {symbol}{amount}",
			dragHint: "拖动排序",
			secBasic: "基础",
			secSegments: "数据字段",
			secSegmentsHint: "勾选显示；按住拖动可调整顺序。",
			secPrices: "自定义模型价格",
			secPricesHint: "填写你使用的模型单价（每百万tokens/元）。",
			segStatusHint: "当前会话的运行状态及峰谷时段。",
			segCountsHint: "当前会话的总轮次与执行步数。",
			segTtftHint: "首字的平均延迟。",
			segCacheHitHint: "当前会话的平均缓存命中率。",
			segTokensHint: "当前会话累计消耗的模型token（鼠标悬停查看明细）。",
			segTpsHint: "token的每秒平均输出速度。",
			segSessionTimeHint: "当前会话的总计运行时间。",
			segCostHint: "当前会话估算消耗费用，包含主模型、子代理和辅助调用。",
			segLastCostHint: "当前或最近一轮交流的估算消耗费用。",
			segBalanceHint: "账户余额，每分钟刷新。",
			priceCurrent: "当前会话使用：",
			modelUnknown: "未识别",
			unitCountTurns: " 轮",
			unitCountSteps: " 步",
			unitCost: "",
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
			reset: "恢复默认设置"
		};
		const en = {
			nav: "Status Bar",
			intro: "Takes over the stats line under the composer. Tick the fields to show, drag to reorder, or set model prices.",
			enabled: "Enable status bar",
			enabledHint: "Hides the whole bar when off.",
			wrap: "Allow wrapping",
			wrapHint: "Segments wrap onto multiple lines; when off, a single elided line.",
			segStatus: "Session status",
			segCounts: "Turns & steps",
			segTtft: "First-token delay",
			segCacheHit: "Cache hit rate",
			segTokens: "Session tokens",
			segTps: "Output speed",
			segSessionTime: "Run time",
			segCost: "Session cost",
			segLastCost: "This turn cost",
			segBalance: "Balance",
			f_peak: "peak",
			f_valley: "off-peak",
			f_counts: "{turns} turns · {steps} steps",
			f_llm: "model {duration}",
			f_tool: "tool {duration}",
			f_ttft: "avg first token {duration}",
			f_cacheHit: "cache hit {percent}%",
			f_tokens: "{total} tokens",
			f_tokensHit: "input (cache hit)",
			f_tokensMiss: "input (cache miss)",
			f_tokensOut: "output",
			f_context: "context {percent}%",
			f_speed: "output {throughput}t/s",
			f_sessionTime: "total {duration}",
			f_cost: "total {symbol}{cost}",
			priceTierPeak: "Peak",
			priceTierOffPeak: "Off-peak",
			f_lastCost: "this turn {symbol}{cost}",
			f_balance: "balance {symbol}{amount}",
			dragHint: "Drag to reorder",
			secBasic: "Basics",
			secSegments: "Data fields",
			secSegmentsHint: "Tick to show; drag to reorder.",
			secPrices: "Custom model prices",
			secPricesHint: "Prices per million tokens (CNY).",
			segStatusHint: "Run state and peak/off-peak period of the current session.",
			segCountsHint: "Total turns and executed steps of the current session.",
			segTtftHint: "Average delay of the first token.",
			segCacheHitHint: "Average cache hit rate of the current session.",
			segTokensHint: "Model tokens consumed by the current session (hover for the breakdown).",
			segTpsHint: "Average output speed in tokens per second.",
			segSessionTimeHint: "Total run time of the current session.",
			segCostHint: "Estimated cost of the current session, including the main model, subagents, and helper calls.",
			segLastCostHint: "Estimated cost of the current or most recent turn.",
			segBalanceHint: "Account balance, refreshed every minute.",
			priceCurrent: "Current session:",
			modelUnknown: "unknown",
			unitCountTurns: " turns",
			unitCountSteps: " steps",
			unitCost: " $",
			unitSpeed: "t/s",
			priceSuggestedHint: "The price book uses the DeepSeek reference prices.",
			f_balanceDash: "balance -",
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
			reset: "Reset settings"
		};

		/* --------------------------------------------------------------- 段定义
		 * array 顺序即底栏渲染顺序，也是出厂默认顺序；全部段默认勾选。
		 * 「恢复默认设置」按此重排并全选，与设置页截图一致。 */
		const SEGMENTS = [
			{ id: "status", label: "segStatus", hint: "segStatusHint", def: true, short: { zh: "峰谷", en: "period" } },
			{ id: "counts", label: "segCounts", hint: "segCountsHint", def: true, short: { zh: "轮次/步数", en: "turns/steps" } },
			{ id: "cacheHit", label: "segCacheHit", hint: "segCacheHitHint", def: true, short: { zh: "缓存命中", en: "cache hit" } },
			{ id: "ttft", label: "segTtft", hint: "segTtftHint", def: true, short: { zh: "首字平均", en: "avg first token" } },
			{ id: "tps", label: "segTps", hint: "segTpsHint", def: true, short: { zh: "输出速度", en: "output speed" } },
			{ id: "sessionTime", label: "segSessionTime", hint: "segSessionTimeHint", def: true, short: { zh: "总用时", en: "total time" } },
			{ id: "lastCost", label: "segLastCost", hint: "segLastCostHint", def: true, short: { zh: "本轮", en: "this turn" } },
			{ id: "cost", label: "segCost", hint: "segCostHint", def: true, short: { zh: "总计", en: "total" } },
			{ id: "balance", label: "segBalance", hint: "segBalanceHint", def: true, short: { zh: "余额", en: "balance" } },
			{ id: "tokens", label: "segTokens", hint: "segTokensHint", def: true, short: { zh: "输入/输出", en: "in/out tokens" } }
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
				enabled: true,
				wrap: true,
				segments: DEFAULT_SEGMENTS.slice(),
				hidden: [],
				currency: "CNY",
				models: Object.assign({}, DEFAULT_PRICES),
				modelOrder: Object.keys(DEFAULT_PRICES)
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
				/* 价格库落后于参考价版本时并入官方价；用户自己改过的条目不覆盖 */
				/* 价格库为空或全 0 时直接用内嵌官方价（自愈，无需手动填） */
				if (pricesMissing(normalizeModels(parsed.models))) parsed.models = Object.assign({}, DEFAULT_PRICES);
				const priceVersion = typeof parsed.priceVersion === "number" ? parsed.priceVersion : 0;
				const models = priceVersion < PRICE_VERSION
					? normalizeModels(Object.assign({}, parsed.models, DEFAULT_PRICES))
					: normalizeModels(parsed.models);
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
					enabled: parsed.enabled !== false,
					wrap: parsed.wrap !== false,
					segments: stored,
					hidden: hidden,
					currency: "CNY",   /* 币种选择已移除：固定人民币 */
					priceVersion: PRICE_VERSION,
					priceConfigured: priceConfigured,
					models: Object.keys(models).length > 0 ? models : normalizeModels(DEFAULT_PRICES),
					modelOrder: modelOrder.length > 0 ? modelOrder : Object.keys(DEFAULT_PRICES)
				};
			} catch (error) {
				return fallback;
			}
		}

		let config = loadConfig();
		const listeners = new Set();
		function subscribe(fn) {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		}
		function snapshot() { return config; }
		function setConfig(patch) {
			config = Object.assign({ version: CONFIG_VERSION }, config, patch);
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
		/** token 精确到个位数，每三位一个逗号。 */
		function formatTokens(value) {
			const n = Math.round(Number(value) || 0);
			const sign = n < 0 ? "-" : "";
			const digits = String(Math.abs(n));
			let out = "";
			for (let i = 0; i < digits.length; i += 1) {
				if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
				out += digits[i];
			}
			return sign + out;
		}
		/** 秒级时长，保留一位小数（首字延迟这类不会超过一分钟的指标用）。 */
		function formatSeconds(ms) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			return String(Math.round(n / 100) / 10);
		}
		/** 时长按最小单位给：>=1h 用 h/m，>=1m 用 m/s，不足一分钟只给秒；分钟与秒之间不加空格。 */
		function formatDuration(ms) {
			const n = Number(ms) || 0;
			if (n <= 0) return null;
			const seconds = n / 1000;
			const whole = Math.round(seconds);
			if (whole < 60) return (Math.round(seconds * 10) / 10) + "s";
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
			const pressure = src.pressure;
			const symbol = currencySymbol(src.currency);

						if (id === "status") {
				const running = src.running === true
					|| (src.partial !== undefined && src.partial !== null)
					|| (Array.isArray(src.runningCalls) && src.runningCalls.length > 0);
				const approvals = src.pendingApprovals;
				const waiting = approvals !== undefined && approvals !== null
					&& (Array.isArray(approvals) ? approvals.length > 0 : true);
				const failed = !running && (src.lastAgentError !== undefined && src.lastAgentError !== null);
				return {
					id: id,
					/* 只靠状态点表达，文字交给后面的段 */
					state: running ? "running" : (failed ? "error" : (waiting ? "approval" : "idle")),
					/* 文字给峰谷判断：同一段既表示会话状态（点）又表示峰谷（文字） */
					text: src.now === undefined || src.now === null ? "" : (isPeakTime(src.now) ? t("f_peak") : t("f_valley"))
				};
			}

			if (id === "counts") {
				if (stats === undefined || stats === null || !(stats.steps > 0)) return null;
				return { id: id, text: t("f_counts", { turns: stats.turns || 0, steps: stats.steps || 0 }) };
			}

			if (id === "durations") {
				if (stats === undefined || stats === null) return null;
				const parts = [];
				const llm = formatDuration(stats.llmMs);
				const tool = formatDuration(stats.toolMs);
				if (llm !== null) parts.push(t("f_llm", { duration: llm }));
				if (tool !== null) parts.push(t("f_tool", { duration: tool }));
				if (parts.length === 0) return null;
				return { id: id, text: parts.join(" · ") };
			}

			if (id === "ttft") {
				if (stats === undefined || stats === null || !(stats.ttftSteps > 0) || !(stats.ttftMs > 0)) return null;
				const duration = formatSeconds(stats.ttftMs / stats.ttftSteps);
				if (duration === null) return null;
				return { id: id, text: t("f_ttft", { duration: duration + "s" }) };
			}

			if (id === "cacheHit") {
				if (usage === undefined || usage === null) return null;
				const denominator = billedInputTokens(usage);
				if (denominator <= 0) return null;
				const percent = Math.min(99.99, ((usage.cacheReadTokens || 0) / denominator) * 100).toFixed(2);
				return { id: id, text: t("f_cacheHit", { percent: percent }) };
			}

			if (id === "tokens") {
				if (usage === undefined || usage === null) return null;
				const cached = usage.cacheReadTokens || 0;
				const missInput = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
				const output = usage.outputTokens || 0;
				const total = cached + missInput + output;
				if (total <= 0) return null;
				const rows = [
					{ label: t("f_tokensHit"), value: formatTokens(cached) },
					{ label: t("f_tokensMiss"), value: formatTokens(missInput) },
					{ label: t("f_tokensOut"), value: formatTokens(output) },
				];
				return {
					id: id,
					/* 只显示三者之和（命中缓存 + 未命中缓存 + 输出），不带段名 */
					text: t("f_tokens", { total: formatTokens(total) }),
					rows: rows,
				};
			}

			if (id === "context") {
				if (pressure === undefined || pressure === null) return null;
				const used = pressure.projectedTokens !== undefined && pressure.projectedTokens !== null
					? pressure.projectedTokens
					: pressure.pressureTokens;
				if (used === undefined || used === null || !(pressure.contextWindow > 0)) return null;
				return { id: id, text: t("f_context", { percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)) }) };
			}

			if (id === "tps") {
				if (stats === undefined || stats === null || !(stats.decodeMs > 0) || !(stats.decodeTokens > 0)) return null;
				return { id: id, text: t("f_speed", { throughput: formatThroughput(stats.decodeTokens / (stats.decodeMs / 1000)) }) };
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
				return { id: id, text: t("f_sessionTime", { duration: duration }) };
			}

			if (id === "cost") {
				const sessionUsage = src.sessionUsage;
				if (sessionUsage === undefined || sessionUsage === null) return null;
				const calls = Array.isArray(sessionUsage.calls) ? sessionUsage.calls : null;
				if (calls === null || calls.length === 0) return null;
				/* 每条调用按自己发生的那一刻、自己的模型定峰谷：跨时段、跨模型都不会串价 */
				const fallbackModel = src.sessionModel !== undefined && src.sessionModel !== null ? src.sessionModel.model : null;
				let total = 0;
				let priced = false;
				for (let i = 0; i < calls.length; i += 1) {
					const callModel = typeof calls[i].model === "string" ? calls[i].model : fallbackModel;
					const one = costOf(calls[i], callModel, calls[i].at);
					if (one === null) continue;
					priced = true;
					total += Number(one);
				}
				if (!priced) return null;
				return { id: id, text: t("f_cost", { symbol: symbol, cost: total.toFixed(2) }) };
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
					for (let i = 0; i < turnCalls.length; i += 1) {
						const callModel = typeof turnCalls[i].model === "string" ? turnCalls[i].model : fallbackModel;
						const one = costOf(turnCalls[i], callModel, turnCalls[i].at);
						if (one === null) continue;
						turnPriced = true;
						turnTotal += Number(one);
					}
					if (turnPriced) return { id: id, text: t("f_lastCost", { symbol: symbol, cost: turnTotal.toFixed(2) }) };
				}
				/* 兜底：官方 tokenUsage 差分，按当下时段计价 */
				const bucket = src.turnUsage !== null && src.turnUsage !== undefined ? src.turnUsage : null;
				if (bucket === null) return null;
				const cost = costOf(bucket, fallbackModel, src.now);
				if (cost === null) return null;
				return { id: id, text: t("f_lastCost", { symbol: symbol, cost: cost }) };
			}

						if (id === "balance") {
				const balance = src.balance;
				if (balance === null || balance === undefined) return null;
				if (balance.ok !== true) return null;
				if (typeof balance.total !== "string") return null;
				/* 余额段不带悬停气泡 */
				return { id: id, text: t("f_balance", { symbol: symbol, amount: balance.total }) };
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
			if (id === "tps") return label + " " + dash + t("unitSpeed");
			if (id === "sessionTime" || id === "durations") return label + " " + dash + "m " + dash + "s";
			if (id === "cost" || id === "lastCost") return label + " " + dash + t("unitCost");
			if (id === "balance") return t("f_balanceDash");
			if (id === "tokens") return dash + " tokens";
			return dash;
		}
		/* ---------------------------------------------------------------- css */
		const CSS = [
			/* 接管输入框下方的统计行：dock 里凡“不是本插件那一项”的都藏掉（也就是官方 StatsPills）。
			 * 两条不依赖官方构建 hash 的要点：
			 *   1. 用 .dsb-root 认自己，而不是官方组件的类名（hash 会随 DSH 更新变，2.0.10 踩过）；
			 *   2. 自己带标记与“后代里带标记”都要判 —— :has() 只看后代，漏掉前者会把自己的行也藏掉。 */
			'[data-slot="conversation.composer.dock"] > *:not(.dsb-root):not(:has(.dsb-root)){display:none !important}',
			".dsb-root{display:flex;align-items:center;justify-content:center;gap:2px;width:100%;max-width:var(--dsh-chat-content-width);box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;margin:0 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dsb-wrap{flex-wrap:wrap}",
			".dsb-dot{flex:none;width:7px;height:7px;border-radius:50%;margin-right:7px;background:#9ca3af}",
			".dsb-dot-running{background:#22c55e;box-shadow:0 0 0 2px color-mix(in srgb,#22c55e 15%,transparent)}",
			".dsb-dot-error{background:#ef4444;box-shadow:0 0 0 2px color-mix(in srgb,#ef4444 15%,transparent)}",
			".dsb-dot-approval{background:#f59e0b;box-shadow:0 0 0 2px color-mix(in srgb,#f59e0b 15%,transparent)}",
			".dsb-seg{white-space:nowrap}",
			/* 气泡相对状态栏定位 */
			".dsb-root{position:relative}",
			".dsb-tip{position:absolute;bottom:100%;left:0;margin-bottom:6px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1f1f1f);border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.3));box-shadow:0 6px 18px rgba(0,0,0,.18);white-space:nowrap;z-index:40;pointer-events:none}",
			".dsb-tip-grid{display:grid;grid-template-columns:auto auto;gap:2px 16px;font-variant-numeric:tabular-nums}",
			".dsb-tip-label{text-align:left;color:var(--dsw-alias-label-secondary)}",
			".dsb-tip-value{text-align:right;color:var(--dsw-alias-label-primary)}",
			".dsb-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			/* 设置页 */
			".dsb-settings{display:flex;flex-direction:column;gap:18px;font-size:14px}",
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
			".dsb-settings .dsb-model{display:flex;flex-direction:column;gap:8px;padding:6px 0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.18))}",
			".dsb-settings .dsb-tier{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".dsb-settings .dsb-tier-name{flex:none;width:48px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dsb-settings .dsb-model:first-child{border-top:0;padding-top:0}",
			".dsb-settings .dsb-model:last-child{padding-bottom:0}",
			".dsb-settings .dsb-model-name{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}",
			".dsb-settings .dsb-model-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}",
			".dsb-settings .dsb-model-actions{display:flex;gap:6px;flex:none}",
			".dsb-settings .dsb-inline-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsb-settings .dsb-fields{display:flex;flex-wrap:wrap;gap:8px}",
			".dsb-settings .dsb-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			".dsb-settings .dsb-field input{width:74px;text-align:right}",
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
			".dsb-settings .dsb-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}"
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
			const pressure = useProjection("contextPressure");
			const sessionModel = useProjection("desktopStatusbarModel");
			const sessionUsage = useProjection("desktopStatusbarUsage");
			const timeRange = useProjection("desktopStatusbarActiveTime");
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
			const needsNow = cfg.enabled === true && (isSegmentOn(cfg, "sessionTime") || isSegmentOn(cfg, "status"));
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

			const wantsBalance = cfg.enabled === true && isSegmentOn(cfg, "balance");
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

			if (cfg.enabled !== true) return null;

			/* 本轮费用：优先节点折叠（与官方同源），节点缺失才用差分兜底 */
			const nodeTurnUsage = foldTurnUsage(chatNodes, running === true ? 1 : 0);
			const turnUsage = nodeTurnUsage !== null ? nodeTurnUsage : turnLastRef.current;

			const debugSrc = {
				stats: stats, usage: usage, pressure: pressure,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRangeNow,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: cfg.currency
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
				costText: segmentText("cost", segmentView("cost", debugSrc, t), t),
				lastCostText: segmentText("lastCost", segmentView("lastCost", debugSrc, t), t),
				sessionTime: segmentText("sessionTime", segmentView("sessionTime", debugSrc, t), t)
			};

			const src = {
				stats: stats, usage: usage, pressure: pressure,
				sessionModel: sessionModel, sessionUsage: sessionUsage, timeRange: timeRange,
				running: running, partial: partial, runningCalls: runningCalls,
				lastAgentError: lastAgentError, pendingApprovals: pendingApprovals, timeline: timeline,
				now: now, balance: balance, turnUsage: turnUsage, currency: cfg.currency
			};

			const views = [];
			cfg.segments.filter((id) => isSegmentOn(cfg, id)).forEach((id) => {
				const view = segmentView(id, src, t);
				/* 保留 view 上的 state（状态点靠它上色），只把缺数据的段换成占位文本 */
				views.push(view !== null && view !== undefined
					? view
					: { id: id, text: segmentText(id, view, t) });
			});

			const statusView = views.filter((v) => v.id === "status")[0];
			const dotClass = "dsb-dot"
				+ (statusView !== undefined && statusView.state === "running" ? " dsb-dot-running" : "")
				+ (statusView !== undefined && statusView.state === "error" ? " dsb-dot-error" : "")
				+ (statusView !== undefined && statusView.state === "approval" ? " dsb-dot-approval" : "");

			const children = [h("span", { className: dotClass, key: "__dot" })];
			let lastShown = null;
			views.forEach((view) => {
				if (view.text === "") return;
				if (lastShown !== null) {
					children.push(h("span", { className: "dsb-sep", key: "__sep" + view.id }, "|"));
				}
				lastShown = view;
				children.push(h("span", {
					className: "dsb-seg", key: "__seg" + view.id,
					onMouseEnter: view.rows !== undefined && view.rows !== null ? () => setTipId(view.id) : undefined,
					onMouseLeave: view.rows !== undefined && view.rows !== null ? () => setTipId(null) : undefined
				}, view.text));
			});

			/* 自绘悬停气泡：两列 grid，标签左对齐、数值右对齐 */
			if (tipId !== null) {
				const tipView = views.filter((v) => v.id === tipId)[0];
				if (tipView !== undefined && Array.isArray(tipView.rows) && tipView.rows.length > 0) {
					const cells = [];
					tipView.rows.forEach((row, index) => {
						cells.push(h("span", { className: "dsb-tip-label", key: "__tl" + index }, row.label));
						cells.push(h("span", { className: "dsb-tip-value", key: "__tv" + index }, row.value));
					});
					children.push(h("span", { className: "dsb-tip", key: "__tip" },
						h("span", { className: "dsb-tip-grid" }, cells)));
				}
			}
			return h("span", {
				className: cfg.wrap === true ? "dsb-root dsb-wrap" : "dsb-root",
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
					const next = { tiered: prev.tiered, peak: Object.assign({}, prev.peak), offPeak: Object.assign({}, prev.offPeak) };
					next[tierKey][field] = value;
					if (prev.tiered !== true) next.offPeak = Object.assign({}, next.peak);   /* 全天同价：两档始终一致 */
					return next;
				});
			}
			function setDraftTiered(on) {
				setDraft((prev) => {
					if (prev === null) return prev;
					return {
						tiered: on,
						peak: Object.assign({}, prev.peak),
						offPeak: on === true ? Object.assign({}, prev.offPeak) : Object.assign({}, prev.peak)
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
					offPeak: draft.tiered === true ? asNumber(draft.offPeak) : asNumber(draft.peak)
				};
				setConfig({ models: next, priceConfigured: true });
				setEditing(null);
				setDraft(null);
			}

			const sections = [];

			sections.push(h("p", { className: "dsb-intro", key: "__intro" }, t("intro")));

			/* 基础 */
			const basicRows = [];
			basicRows.push(h("div", { className: "dsb-row", key: "__enabled" },
				h("label", { className: "dsb-check" },
					h("input", {
						type: "checkbox",
						checked: cfg.enabled === true,
						onChange: (event) => setConfig({ enabled: event.target.checked })
					}),
					h("span", { className: "dsb-labels" },
						h("span", { className: "dsb-name" }, t("enabled")),
						h("span", { className: "dsb-desc" }, t("enabledHint"))
					)
				)
			));
			basicRows.push(h("div", { className: "dsb-row", key: "__wrap" },
				h("label", { className: "dsb-check" },
					h("input", {
						type: "checkbox",
						checked: cfg.wrap === true,
						onChange: (event) => setConfig({ wrap: event.target.checked })
					}),
					h("span", { className: "dsb-labels" },
						h("span", { className: "dsb-name" }, t("wrap")),
						h("span", { className: "dsb-desc" }, t("wrapHint"))
					)
				)
			));
			sections.push(h("div", { className: "dsb-section", key: "__basic" },
				h("div", { className: "dsb-sectitle" }, t("secBasic")),
				basicRows
			));

			/* 统计段：段序对整份列表生效，勾选只控制显示，取消勾选不移位 */
			const byId = {};
			SEGMENTS.forEach((segment) => { byId[segment.id] = segment; });
			const orderedSegments = cfg.segments
				.map((id) => byId[id])
				.filter((segment) => segment !== undefined && segment !== null);

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
				segmentRows
			));

			/* 自定义模型价格 */
			const priceCards = [];
			priceCards.push(h("div", { className: "dsb-hint", key: "__pricehint" }, t("secPricesHint")));
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
				const action = (label, key, onClick) => h("button", { type: "button", key: key, className: "dsb-action dsb-action-sm", onClick: onClick }, label);
				const head = h("div", { className: "dsb-model-head", key: "__head" },
					h("span", { className: "dsb-model-name" }, displayModelName(name)),
					h("div", { className: "dsb-model-actions" },
						open === true ? action(t("priceSave"), "__save", saveDraft) : action(t("priceEdit"), "__edit", () => startEdit(name)),
						action(t("priceRemove"), "__remove", () => removeModel(name))
					)
				);
				const body = open === true
					? [
						h("label", { className: "dsb-inline-check", key: "__tiered" },
							h("input", {
								type: "checkbox",
								checked: draft.tiered === true,
								onChange: (event) => setDraftTiered(event.target.checked)
							}),
							h("span", null, t("priceTiered"))
						),
						draft.tiered === true ? tierRow("offPeak", t("priceTierOffPeak")) : tierRow("peak", null),
						draft.tiered === true ? tierRow("peak", t("priceTierPeak")) : null
					]
					: [];
				modelRows.push(h("div", { className: "dsb-model", key: name }, head, body));
			});
			if (modelRows.length > 0) {
				priceCards.push(h("div", { className: "dsb-models", key: "__models" }, modelRows));
			}
			sections.push(h("div", { className: "dsb-section", key: "__prices" },
				h("div", { className: "dsb-sectitle" }, t("secPrices")),
				h("div", { className: "dsb-card" }, priceCards)
			));

			/* 收尾 */
			sections.push(h("div", { className: "dsb-foot", key: "__foot" },
				h("button", {
					type: "button",
					className: "dsb-action",
					onClick: () => setConfig({
						enabled: true,
						wrap: true,
						segments: DEFAULT_SEGMENTS.slice(),
						hidden: [],
						currency: "CNY",
						models: Object.assign({}, DEFAULT_PRICES),
						modelOrder: Object.keys(DEFAULT_PRICES)
					})
				}, t("reset"))
			));

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
