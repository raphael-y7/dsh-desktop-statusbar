/**
 * 把已安装的插件源码同步进项目（改完插件跑一次，再跑 tests/）。
 * 用法：node tools/sync-from-plugin.cjs
 *
 * **文件清单自动扫描，不写死**。与 tools/sync-to-plugin.cjs 对称，覆盖：
 *   · lib/ 下全部文件（含 vendor 子目录）；
 *   · package.json 与 locale/*.json（版本、导出入口、界面文案等元数据）。
 * 插件目录里新增的模块（self-update.js / release-age.js）或 vendor 里的第三方包
 * 都会被搬回项目，避免"插件里改了、项目里没有"，下次推回去时又被覆盖。
 *
 * 安全阀：项目文件比插件文件新 ⇒ 跳过（很可能项目里刚改过、还没推回插件）；
 * 确认要以插件版为准时加 --force。
 * 插件目录由 tools/plugin-dir.cjs 自动定位（换机器/换用户名都不必改代码）：
 * 可用环境变量 DSH_STATUS_BAR_PLUGIN_DIR 显式指定。
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..');
const pluginRoot = require('./plugin-dir.cjs').pluginDir();
if (pluginRoot === null) {
  console.log('× 找不到已安装的插件目录：请设置 DSH_STATUS_BAR_PLUGIN_DIR 指向它，');
  console.log('  或把 tools/ 放在插件目录里运行。');
  process.exit(1);
}
const PLUGIN = pluginRoot;

/** 递归列出 root 下的全部文件（相对路径，统一用 / 分隔，顺序稳定）。 */
function listFiles(root, prefix) {
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** 参与同步的元数据文件：package.json + locale/*.json（与 sync-to-plugin.cjs 一致）。 */
function metaFiles(root) {
  const out = ['package.json'];
  const localeDir = path.join(root, 'locale');
  if (fs.existsSync(localeDir)) {
    listFiles(localeDir, '').forEach((name) => out.push('locale/' + name));
  }
  return out;
}

const libFiles = fs.existsSync(path.join(PLUGIN, 'lib'))
  ? listFiles(path.join(PLUGIN, 'lib'), '').map((rel) => 'lib/' + rel)
  : [];
const sources = libFiles
  .concat(metaFiles(PLUGIN))
  .filter((rel) => fs.existsSync(path.join(PLUGIN, rel)));

const FORCE = process.argv.includes('--force');
let changed = 0;
let skipped = 0;
sources.forEach((rel) => {
  const from = path.join(PLUGIN, rel);
  const to = path.join(PROJECT, rel);
  const before = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
  const now = fs.readFileSync(from, 'utf8');
  if (before === now) {
    console.log('= ' + rel + '（一致）');
    return;
  }
  /* 安全阀：项目文件比插件文件新 ⇒ 很可能项目里刚改过、还没推送到插件。
     绝不能用旧插件版本覆盖新项目文件（2026-11 实测踩过：一跑就吞掉未提交改动）。
     确认要以插件版为准时加 --force。 */
  if (FORCE !== true && before !== null && fs.statSync(to).mtimeMs > fs.statSync(from).mtimeMs + 1000) {
    skipped += 1;
    console.log('! ' + rel + '（项目较新，跳过；确认用插件版覆盖请加 --force）');
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, now, 'utf8');
  changed += 1;
  console.log('→ ' + rel + ' 已更新' + (before === null ? '（项目原先没有）' : ''));
});

console.log('');
if (skipped > 0) {
  console.log('跳过 ' + skipped + ' 个项目较新的文件（确认要以插件版为准请加 --force）');
}
console.log(changed === 0
  ? '项目已是最新（' + sources.length + ' 个文件）'
  : '同步了 ' + changed + ' / ' + sources.length + ' 个文件；接着跑：node tools/test.cjs');
