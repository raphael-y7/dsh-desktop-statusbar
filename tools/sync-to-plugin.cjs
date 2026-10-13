/**
 * 把项目 lib/ 的源码同步到已安装的插件目录（改完项目跑一次，再重启 DSH）。
 * 用法：node tools/sync-to-plugin.cjs
 *
 * **文件清单自动扫描**，不写死。原先写死 `['client.js','index.js','holiday.js','balance-api.js']`，
 * 新增模块（self-update.js / release-age.js）不会被同步过去 —— 而 index.js 会 import 它们，
 * 结果是插件直接加载失败，报错还发生在 DSH 启动阶段，很难联想到"同步脚本漏了一个文件"。
 * 现在按 `lib/*.js` 逐个覆盖，项目里有什么就同步什么。
 *
 * 插件目录由 tools/plugin-dir.cjs 自动定位（换机器/换用户名都不必改代码）：
 * 可用环境变量 DSH_STATUS_BAR_PLUGIN_DIR 显式指定。
 */
const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..', 'lib');
const pluginRoot = require('./plugin-dir.cjs').pluginDir();
if (pluginRoot === null) {
  console.log('× 找不到已安装的插件目录：请设置 DSH_STATUS_BAR_PLUGIN_DIR 指向它，');
  console.log('  或把 tools/ 放在插件目录里运行。');
  process.exit(1);
}
const PLUGIN = path.join(pluginRoot, 'lib');

let failed = 0;

function writeToPlugin(name, text) {
  const target = path.join(PLUGIN, name);
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (before === text) {
    console.log('= ' + name + '（一致）');
    return;
  }
  /* 写入前先解除硬链接。
     已安装目录里的文件通常是 pnpm store 的**硬链接**（同一个 inode 有两个路径）。
     直接 writeFileSync 是"透过链接写"，会同时改到 store 里那一份 —— store 是跨
     profile、跨项目共享的，等于把别处也改了。
     做法：先删掉这个链接（store 的数据仍在，只是少一个引用），再写新文件
     （新文件是独立 inode，与 store 无关）。 */
  const wasLinked = fs.existsSync(target) && fs.statSync(target).nlink > 1;
  if (wasLinked) {
    fs.unlinkSync(target);
    console.log('  （' + name + ' 原本是 store 硬链接，已先解除）');
  }
  fs.writeFileSync(target, text, 'utf8');
  /* 复核：新文件必须不再与 store 共享 */
  if (fs.statSync(target).nlink > 1) {
    throw new Error(name + ' 写入后仍有多个硬链接（nlink=' + String(fs.statSync(target).nlink) + '），可能污染 pnpm store');
  }
  console.log('→ ' + name + ' 已更新' + (before === null ? '（插件目录原先没有）' : ''));
}

/* 自动列出项目里的全部源文件，而不是写死一份清单 */
const sources = fs.readdirSync(PROJECT).filter((name) => name.endsWith('.js')).sort();

sources.forEach((name) => {
  try {
    writeToPlugin(name, fs.readFileSync(path.join(PROJECT, name), 'utf8'));
  } catch (error) {
    failed += 1;
    console.log('× ' + name + '：' + (error !== null && error !== undefined && error.message ? error.message : error));
  }
});

console.log('');
if (failed === 0) {
  console.log('插件目录已同步（' + sources.length + ' 个源文件 → ' + PLUGIN + '）；重启 DSH 生效');
} else {
  console.log('有文件没同步成功，见上面的 ×');
}
process.exitCode = failed === 0 ? 0 : 1;
