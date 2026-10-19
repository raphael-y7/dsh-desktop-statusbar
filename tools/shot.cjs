/**
 * 生成 README 截图。
 *
 * 做法：用插件自己的组件代码（SettingsSection / StatusBar）在 vm 里渲染出虚拟树，
 * 序列化成 HTML，配上插件自己的 CSS 与 DSH 主题变量，再用无头 Edge/Chrome 截图。
 * 好处是截图内容永远跟着代码走 —— 改了文案或布局，重跑一次就同步，
 * 不需要手工开应用摆状态、也不怕忘记更新。
 *
 * 用法：
 *   node tools/shot.cjs            生成全部（中英 × 底栏 / 设置页 / 价格区）
 *   node tools/shot.cjs zh status  只生成某一张
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'lib', 'client.js');
const OUT = path.join(ROOT, 'docs');
const CONFIG_KEY = 'dsh.desktopStatusBar.v1';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

/* DSH 主题变量（浅色）。取自主题包里的值，就列插件用到的那一批。 */
const THEME = [
  ':root{',
  '--dsw-alias-bg-layer-1:#ffffff;',
  '--dsw-alias-label-primary:#0f1115;',
  '--dsw-alias-label-secondary:#4b5563;',
  '--dsw-alias-label-tertiary:#6b7280;',
  '--dsw-alias-separator-primary:rgba(20,24,32,.16);',
  '--dsw-alias-border-l1:rgba(20,24,32,.14);',
  '--dsw-alias-border-l3:rgba(20,24,32,.2);',
  '--dsw-alias-border-l4:rgba(20,24,32,.12);',
  '--dsw-alias-interactive-bg-hover:rgba(38,49,72,.06);',
  '--dsw-alias-brand-primary:#4d6bfe;',
  '--dsw-specific-menu:#f8f9fa94;',
  '--dsw-menu-backdrop-filter:blur(40px) saturate(150%);',
  '--dsw-radius-sm:8px;--dsw-radius-md:12px;--dsw-radius-lg:16px;',
  '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
  '--dsw-elevation-stroke:0 0 0 .5px var(--dsw-elevation-stroke-color);',
  '--dsw-elevation-prominent:var(--dsw-elevation-stroke),0 3px 8px 0 #0000000a,0 0 20px 0 #0000000d;',
  '--dsh-chat-content-width:760px;',
  '--dsh-content-font-size-secondary:13px;',
  '--dsh-content-font-delta-secondary:0px;',
  '--dsh-composer-side-clearance:0px;',
  '}'
].join('');

/* 示例会话数据：截图里显示的就是这些数字 */
const SAMPLE = {
  turns: 12, steps: 268,
  ttftMs: 22800, decodeMs: 96000, decodeTokens: 26400, ttftSteps: 12,
  llmMs: 1512000, toolMs: 402000,
  pressureTokens: 486000, contextWindow: 1000000,
  breakdown: { systemTokens: 1900, toolsTokens: 7300, messageTokens: 181000 },
  usage: { uncachedInputTokens: 29631, cacheReadTokens: 1900000, cacheWriteTokens: 0, outputTokens: 41007 },
  calls: [
    { at: 1, model: 'deepseek-v4-pro', input: 9638, cacheRead: 1536, cacheWrite: 0, output: 197 },
    { at: 2, model: 'deepseek-v4-pro', input: 5966, cacheRead: 11264, cacheWrite: 0, output: 500 },
    { at: 3, model: 'deepseek-v4-pro', input: 901, cacheRead: 17664, cacheWrite: 0, output: 324 },
    { at: 4, model: 'deepseek-v4-pro', input: 1473, cacheRead: 18816, cacheWrite: 0, output: 476 },
    { at: 5, model: 'deepseek-v4-pro', input: 1553, cacheRead: 20736, cacheWrite: 0, output: 1475 },
    { at: 6, model: 'deepseek-v4-pro', input: 152, cacheRead: 23680, cacheWrite: 0, output: 115 }
  ],
  timing: { samples: 12, fastestTtft: 412, slowestTtft: 4458, fastestTps: 394, slowestTps: 167 }
};

function browser() {
  for (const one of BROWSERS) {
    if (fs.existsSync(one)) return one;
  }
  throw new Error('没找到 Chrome / Edge，无法截图');
}

/** 用给定语言与配置加载 client.js，拿回组件与词典；presets 按 useState 调用序号注入初始状态 */
function loadPlugin(locale, config, presets) {
  let code = fs.readFileSync(PLUGIN, 'utf8');
  code = code.replace('\t\texports.apply = apply;',
    '\t\texports.__shot = { zh: zh, en: en, CSS: CSS, SettingsSection: SettingsSection, StatusBar: StatusBar };\n'
    + '\t\texports.apply = apply;');

  const store = new Map([[CONFIG_KEY, JSON.stringify(config)]]);
  const fakeWindow = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); }
    },
    innerWidth: 1200, innerHeight: 900,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) })
  };
  let captured = null;
  fakeWindow.__ModuleLoader__ = { load: (entry) => { captured = entry; } };

  let stateIndex = 0;
  const reactStub = {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    }),
    useState: (init) => {
      const at = stateIndex;
      stateIndex += 1;
      /* 截图要的是"某个状态下的样子"：需要展开的卡片靠预设值摆出来，省得模拟点击 */
      if (presets !== undefined && presets[at] !== undefined) return [presets[at], () => {}];
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, snapshot) => snapshot(),
    Fragment: Symbol('Fragment')
  };

  const sandbox = {
    window: fakeWindow,
    document: {
      documentElement: { classList: { add() {}, remove() {} } },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
      head: { appendChild() {} },
      addEventListener: () => {}, removeEventListener: () => {}
    },
    react: reactStub,
    console, Promise, Date, Math, JSON, Object, Array, Number, String, Boolean, Symbol, Set, Map, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  if (captured === null || captured.factory === undefined) throw new Error('插件工厂没被捕获');
  const api = captured.factory((name) => (name === 'react' ? reactStub : undefined));
  return { api: api, shot: api.__shot };
}

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 虚拟树 → HTML */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true || node === '') return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node.type === 'symbol') return (node.children || []).map(toHtml).join('');
  const props = node.props || {};
  let attrs = '';
  Object.keys(props).forEach((key) => {
    if (key === 'children' || key === 'ref' || key === 'key' || key.indexOf('on') === 0) return;
    const value = props[key];
    if (value === undefined || value === null || value === false || typeof value === 'function') return;
    const name = key === 'className' ? 'class' : key;
    attrs += ' ' + name + '="' + esc(value === true ? '' : value) + '"';
  });
  const cls = props.className === undefined ? '' : String(props.className);
  const style = props.style === undefined ? '' : ' style="' + Object.keys(props.style).map((k) => k + ':' + props.style[k]).join(';') + '"';
  const open = '<' + node.type + attrs + (style !== '' && String(attrs).indexOf(' style=') === -1 ? style : '') + '>';
  if (node.type === 'input' || node.type === 'br' || node.type === 'img') return open;
  return open + (node.children || []).map(toHtml).join('') + '</' + node.type + '>';
}

function page(body, extraCss, pluginCss) {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>'
    + THEME
    + '*{box-sizing:border-box}body{margin:0;padding:0;background:#fff;color:var(--dsw-alias-label-primary);'
    + 'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.5}'
    + '.shot-wrap{width:100%;padding:26px 30px}'
    + pluginCss
    + extraCss
    + '</style></head><body>' + body + '</body></html>';
}

/** 语言替身：与插件里的 t() 同语义 */
function translator(dict, locale) {
  return (key, params) => {
    const table = locale === 'en' ? dict.en : dict.zh;
    let out = table[key] !== undefined ? table[key] : key;
    if (params !== undefined && params !== null) {
      out = out.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    }
    return out;
  };
}

const SETTINGS_CONFIG = {
  version: 7, contextMeter: true, currency: 'CNY', priceConfigured: true,
  /* 按 SEGMENTS 的声明顺序写（= 出厂默认顺序）：tps 在 ttft 前面 */
  segments: ['status', 'counts', 'cacheHit', 'tps', 'ttft', 'sessionTime', 'lastCost', 'cost', 'balance'],
  hidden: [], modelOrder: ['deepseek-flash', 'deepseek-v4-pro'],
  models: {
    'deepseek-flash': { tiered: true, peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 } },
    'deepseek-v4-pro': { tiered: true, peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 }, offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 } }
  }
};

/* 英文截图配美元价：币种是可配的，英文场景展示 USD 更贴切 */
const SETTINGS_USD = Object.assign({}, SETTINGS_CONFIG, {
  currency: 'USD',
  models: {
    'deepseek-flash': { tiered: true, peak: { input: 0.3, cacheRead: 0.006, cacheWrite: 0, output: 1.2 }, offPeak: { input: 0.15, cacheRead: 0.003, cacheWrite: 0, output: 0.6 } },
    'deepseek-v4-pro': { tiered: true, peak: { input: 1.32, cacheRead: 0.044, cacheWrite: 0, output: 3.96 }, offPeak: { input: 0.66, cacheRead: 0.022, cacheWrite: 0, output: 1.98 } }
  }
});

/** 设置页整页 */
function settingsShot(locale) {
  const loaded = loadPlugin(locale, locale === 'en' ? SETTINGS_USD : SETTINGS_CONFIG);
  const t = translator(loaded.shot, locale);
  const tree = loaded.shot.SettingsSection({
    t: t,
    useProjection: (name) => (name === 'desktopStatusbarModel' ? { model: 'deepseek-v4-pro' } : undefined)
  });
  return page('<div class="shot-wrap">' + toHtml(tree) + '</div>', '', loaded.shot.CSS);
}

/** 只要价格区：前两块隐藏、展开第一张卡，并把币种下拉收起（展开会压住右边那列输入框） */
function pricingShot(locale) {
  /* SettingsSection 里 useState 的顺序（组件加了 hook 就要回来重数一遍）：
     0 devOn / 1 drag / 2 newModel / 3 hostModel / 4 editing / 5 draft /
     6 holidayBusy / 7 holidayNote / 8 currencyOpen。
     2026-10-05 之前按下标写的是旧顺序（把 editing 当第 5 个、holidayNote 当第 6 个），
     结果第一张卡展不开、还把草稿对象塞进了 holidayNote，卡片里冒出一句「抓取失败（undefined）」。
     2026-10-13 又踩了一次同类的坑：新增 devOn（开发模式胶囊）插在最前面，
     后面整体后移一位，于是 presets[3] 从 editing 变成 hostModel、
     presets[4] 从 draft 变成 editing、presets[7] 从 currencyOpen 变成 holidayNote。
     教训：**下标是脆的**，加 hook 必须回来重数，并用 `node tools/shot.cjs` 实际生成一次确认。 */
  const presets = [];
  presets[4] = 'deepseek-flash';
  /* 浮层里的数字也要跟着币种走：预设草稿按语言挑人民币或美元那套。
     **`currency` 必须一起写**：下拉按钮显示的正是 `draft.currency`（不是 config.currency），
     漏了它英文截图就会退回默认的 CNY —— 与整页英文界面自相矛盾（2026-10 实际踩过）。 */
  presets[5] = locale === 'en'
    ? {
      tiered: true,
      currency: 'USD',
      peak: { input: '0.3', cacheRead: '0.006', cacheWrite: '0', output: '1.2' },
      offPeak: { input: '0.15', cacheRead: '0.003', cacheWrite: '0', output: '0.6' }
    }
    : {
      tiered: true,
      currency: 'CNY',
      peak: { input: '2', cacheRead: '0.04', cacheWrite: '0', output: '8' },
      offPeak: { input: '1', cacheRead: '0.02', cacheWrite: '0', output: '4' }
    };
  presets[8] = false;   /* 币种下拉收起：展开会压住右边那列输入框 */
  const loaded = loadPlugin(locale, locale === 'en' ? SETTINGS_USD : SETTINGS_CONFIG, presets);
  const t = translator(loaded.shot, locale);
  const tree = loaded.shot.SettingsSection({
    t: t,
    useProjection: (name) => (name === 'desktopStatusbarModel' ? { model: 'deepseek-v4-pro' } : undefined)
  });
  /* 只留第三块（价格区）：head 与统计字段在前两块，按钮区在后 */
  const extra = '.dsb-settings > *:nth-child(-n+2){display:none}'
    + '.dsb-settings > *:nth-child(n+4){display:none}';
  return page('<div class="shot-wrap">' + toHtml(tree) + '</div>', extra, loaded.shot.CSS);
}

/** 底栏：垫一层假的对话区背景，让毛玻璃看得出来 */
function statusbarShot(locale) {
  /* StatusBar 里 useState 的顺序：now → balance → tipId → tipPos → tipTick。
     余额平时靠 effect 轮询拿，静态渲染要直接喂进去。 */
  const presets = [];
  presets[1] = { ok: true, total: '10.32', toppedUp: '8.00', granted: '2.32', currency: 'CNY', at: Date.now() };
  const loaded = loadPlugin(locale, SETTINGS_CONFIG, presets);
  const t = translator(loaded.shot, locale);
  const calls = SAMPLE.calls;
  const tree = loaded.shot.StatusBar({
    t: t,
    sessionId: 'shot',
    useProjection: (name) => {
      if (name === 'sessionStats') return SAMPLE;
      if (name === 'tokenUsage') return SAMPLE.usage;
      if (name === 'contextPressure') return { pressureTokens: SAMPLE.pressureTokens, contextWindow: SAMPLE.contextWindow };
      if (name === 'contextBreakdown') return SAMPLE.breakdown;
      if (name === 'desktopStatusbarUsage') {
        return { models: { 'deepseek-v4-pro': { input: 19683, cacheRead: 93696, cacheWrite: 0, output: 3087 } }, calls: calls, current: { calls: calls, input: 19683, cacheRead: 93696, cacheWrite: 0, output: 3087 }, last: null, turn: 12 };
      }
      if (name === 'desktopStatusbarTiming') return SAMPLE.timing;
      if (name === 'desktopStatusbarActiveTime') return { turns: 12, steps: 268, since: Date.now() - 3152000, stepSince: null };
      if (name === 'desktopStatusbarBalance') return { ok: true, total: '10.32', toppedUp: '8.00', granted: '2.32', currency: 'CNY', at: Date.now() };
      if (name === 'desktopStatusbarModel') return { provider: 'deepseek', model: 'deepseek-v4-pro', at: Date.now() };
      return undefined;
    },
    useSession: (selector) => (selector === undefined ? undefined : selector({ running: false, partial: null, runningCalls: [], lastAgentError: null, pendingApprovals: null })),
    useSessions: () => undefined,
    useChat: () => undefined
  });
  const extra = '.shot-wrap{padding:0}'
    + '.shot-chat{height:190px;padding:18px 24px;background:linear-gradient(180deg,#fff 0%,#f2f4f8 100%);'
    + 'color:#9aa3b2;font-size:13px;line-height:2}'
    + '.shot-bar{background:#eef1f6;padding:0 0 10px}';
  const chat = '<div class="shot-chat">'
    + '<div>把底栏那几项做成可点的气泡，气泡风格跟官方一致。</div>'
    + '<div>顺带把峰谷规则挪到可配置的价格表里。</div>'
    + '<div>写完跑一下测试，确认占位和极值都没问题。</div>'
    + '</div>';
  return page(chat + '<div class="shot-bar">' + toHtml(tree) + '</div>', extra, loaded.shot.CSS);
}

/* status 场景生成的底栏是**合成**的（自己摆的示例数据 + 假对话区背景）。
   2026-10-05 起 README 里的 docs/statusbar*.png 换成了真机截图（用户自己在 DSH 里截的），
   所以**跑全量会把它覆盖掉** —— 只想更新设置页/价格区就单跑那两张：
     node tools/shot.cjs zh settings && node tools/shot.cjs zh pricing（en 同理）。 */
const SCENES = { settings: settingsShot, pricing: pricingShot, status: statusbarShot };
/* 窗口高度按内容量出来的（上下留白对齐到页面自己的 30px 内边距）：
   settings 内容底 1050、pricing 内容底 315.5。改了场景内容要重量一遍再调这里。 */
const SIZES = { settings: '940,1082', pricing: '940,346', status: '1180,230' };

function shoot(locale, scene) {
  const html = SCENES[scene](locale);
  const name = scene === 'settings' ? 'settings' : (scene === 'pricing' ? 'pricing' : 'statusbar');
  const file = path.join(OUT, locale === 'en' ? name + '.en.png' : name + '.png');
  /* SHOT_HTML_ONLY=1：只把页面写到系统临时目录、不碰浏览器 ——
     给「当前环境起不了子进程（AI 沙箱、缺浏览器）」时用：拿这些页面自己调 chrome 截图。 */
  if (process.env.SHOT_HTML_ONLY === '1') {
    const out = path.join(require('os').tmpdir(), 'shot-' + locale + '-' + scene + '.html');
    fs.writeFileSync(out, html, 'utf8');
    console.log('HTML  ' + out + '  → ' + file);
    return;
  }
  const tmp = path.join(OUT, '_shot-' + locale + '-' + scene + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  const chrome = browser();
  /* 让浏览器写到临时文件，成功了再改名顶上：
     目标文件不能在截图前删 —— 浏览器起不来（沙箱拦子进程、缺浏览器）时会把已有截图弄丢，
     2026-10-05 真丢过一次 docs/statusbar.png。临时名每次都是新的，也就不会有"拒绝覆盖"的问题。 */
  const staged = file + '.tmp.png';
  if (fs.existsSync(staged)) fs.unlinkSync(staged);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    '--default-background-color=00000000',
    '--window-size=' + SIZES[scene],
    '--screenshot=' + staged,
    /* 路径里有空格（AI Project），file:// 后面必须编码，否则浏览器打不开页面、静默截不出图 */
    'file:///' + encodeURI(tmp.replace(/\\/g, '/'))
  ];
  const run = require('child_process').spawnSync(chrome, args, { encoding: 'utf8' });
  if (fs.existsSync(staged) !== true) {
    /* 调试用的页面写到系统临时目录：docs/ 是 npm 会打包的目录，失败时不能往里丢东西 */
    const debug = path.join(require('os').tmpdir(), path.basename(tmp) + '.html');
    fs.writeFileSync(debug, html, 'utf8');
    fs.unlinkSync(tmp);
    console.error('浏览器输出:', String(run.stderr).slice(0, 600));
    console.error('保留页面: ' + debug);
    console.error('（已有截图没被动过：' + (fs.existsSync(file) ? '仍在' : '本来就没有') + '）');
    throw new Error('浏览器没有写出 ' + file + '（检查无头截图是否可用）');
  }
  fs.renameSync(staged, file);
  fs.unlinkSync(tmp);
  const size = fs.statSync(file).size;
  console.log('→ ' + path.relative(ROOT, file) + '  ' + Math.round(size / 1024) + ' KB');
}

const onlyLocale = process.argv[2];
const onlyScene = process.argv[3];
const locales = onlyLocale === undefined ? ['zh', 'en'] : [onlyLocale];
const scenes = onlyScene === undefined ? ['status', 'settings', 'pricing'] : [onlyScene];
locales.forEach((locale) => scenes.forEach((scene) => shoot(locale, scene)));
console.log('截图完成');
