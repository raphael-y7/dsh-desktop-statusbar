/**
 * 定位「DSH 实际加载的那份插件目录」。
 *
 * 为什么需要它：`tools/` 下几个脚本要把项目源码同步到插件目录（或反向比对），
 * 而插件目录原先写死成 `~/.dsh/local-plugins/dsh-desktop-statusbar` —— 换机器、
 * 换用户名、或改过安装位置就失效。这里改成三级回退，任何一级命中都行。
 *
 * 三级顺序（越靠前越权威）：
 *   1. 环境变量 `DSH_STATUS_BAR_PLUGIN_DIR` —— 显式指定，脚本/CI 用得上；
 *   2. 在 DSH 主目录下探测：`<dsh-home>/local-plugins/<包名>`（本机常规布局）；
 *   3. 由本文件位置推导：`tools/` 的上一级 —— 脚本就住在插件目录里时天然成立。
 *
 * DSH 主目录的取法与插件宿主代码一致：`DSH_HOME` 优先，否则 `~/.dsh`。
 * 这样测试里设了 `DSH_HOME` 也能带上，不会误指真实目录。
 *
 * 注意：**只做定位，不创建目录、不写任何东西**；找不到就返回 null，由调用方决定怎么报错。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 包名（与 package.json 的 name 一致）：决定 local-plugins 下的目录名。 */
const PACKAGE_NAME = 'dsh-desktop-statusbar';

/** DSH 主目录：`DSH_HOME` 优先，否则 `~/.dsh`。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/** 一个目录像不像插件目录：有 package.json 且 name 对得上。 */
function looksLikePlugin(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && parsed.name === PACKAGE_NAME;
  } catch (error) {
    return false;
  }
}

/**
 * 在 DSH 主目录下扫描几个已知的安装布局，返回第一个真像插件的目录。
 *
 * 为什么要扫而不只拼一条路径：插件的安装位置不止一种，实测至少这三种都真实存在：
 *   ① `<dsh-home>/local-plugins/<包名>`     —— 本地开发用的 junction/symlink
 *   ② `<dsh-home>/profiles/<profile>/node_modules/<包名>` —— 官方桌面端装出来的位置
 *      （2026-10 实测：DSH 桌面端就是这种，profile 名通常是 `desktop`）
 *   ③ `<dsh-home>/profiles/node_modules/<包名>` —— 共享回退目录
 * 只查 ① 会在桌面端上定位失败（本插件最初就栽在这），所以把 ②③ 也覆盖上。
 *
 * 只读目录名、只读那几个候选的 package.json，不做递归全盘扫描。
 *
 * @returns {string|null} 找到的第一个插件目录
 */
function scanKnownLayouts() {
  const home = dshHome();

  /* ① 本地开发位置 */
  const local = path.join(home, 'local-plugins', PACKAGE_NAME);
  if (looksLikePlugin(local)) return local;

  /* ③ 共享回退目录 */
  const shared = path.join(home, 'profiles', 'node_modules', PACKAGE_NAME);
  if (looksLikePlugin(shared)) return shared;

  /* ② 各 profile 自己的 node_modules。profile 名不写死：列出来一个个试。 */
  const profilesRoot = path.join(home, 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(profilesRoot);
  } catch (error) {
    return null;
  }
  const found = [];
  for (const name of names) {
    const candidate = path.join(profilesRoot, name, 'node_modules', PACKAGE_NAME);
    if (looksLikePlugin(candidate)) found.push(candidate);
  }
  /* 多个 profile 都装了：按名字排序取第一个，保证同一台机器上每次结果一致
     （不排序时 readdir 顺序依文件系统而异，会让"同步检查"时而通过时而失败）。 */
  return found.length === 0 ? null : found.sort()[0];
}

/** 依次尝试各类来源，返回第一个成立的绝对路径；都不成立返回 null。 */
function pluginDir() {
  /* 1) 环境变量显式指定：即使 package.json 认不出也接受（调用方可能有意指向别处） */
  const explicit = process.env.DSH_STATUS_BAR_PLUGIN_DIR;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const dir = path.resolve(explicit.trim());
    if (fs.existsSync(dir)) return dir;
  }

  /* 2) DSH 主目录下的已知安装布局 */
  const scanned = scanKnownLayouts();
  if (scanned !== null) return scanned;

  /* 3) 由本文件位置推导：tools/ 的上一级（脚本就住在插件目录里时天然成立） */
  const derived = path.join(__dirname, '..');
  if (looksLikePlugin(derived)) return derived;

  return null;
}

module.exports = {
  pluginDir: pluginDir,
  dshHome: dshHome,
  scanKnownLayouts: scanKnownLayouts,
  PACKAGE_NAME: PACKAGE_NAME,
  looksLikePlugin: looksLikePlugin,
};
