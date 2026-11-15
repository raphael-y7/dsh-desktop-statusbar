/**
 * 把项目源码同步到已安装的插件目录（改完项目跑一次，再重启 DSH）。
 * 用法：node tools/sync-to-plugin.cjs
 *
 * **文件清单自动扫描，不写死**。原先写死 `['client.js','index.js','holiday.js','balance-api.js']`，
 * 新增模块（self-update.js / release-age.js）不会被同步过去 —— 而 index.js 会 import 它们，
 * 结果是插件直接加载失败，报错还发生在 DSH 启动阶段，很难联想到"同步脚本漏了一个文件"。
 * 现在按 lib/ 下**全部文件**（含 vendor 子目录，逐文件比较）+ locale/*.json + package.json 同步：
 * 项目里有什么就同步什么，安装后的插件元数据与项目保持一致。
 *
 * 插件目录由 tools/plugin-dir.cjs 自动定位（换机器/换用户名都不必改代码）：
 * 可用环境变量 DSH_STATUS_BAR_PLUGIN_DIR 显式指定。
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROJECT = path.join(PROJECT_ROOT, 'lib');
const pluginRoot = require('./plugin-dir.cjs').pluginDir();
if (pluginRoot === null) {
  console.log('× 找不到已安装的插件目录：请设置 DSH_STATUS_BAR_PLUGIN_DIR 指向它，');
  console.log('  或把 tools/ 放在插件目录里运行。');
  process.exit(1);
}
const PLUGIN = path.join(pluginRoot, 'lib');

let failed = 0;

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

function writeToPlugin(target, label, text) {
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (before === text) {
    console.log('= ' + label + '（一致）');
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
    console.log('  （' + label + ' 原本是 store 硬链接，已先解除）');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  /* 复核：新文件必须不再与 store 共享 */
  if (fs.statSync(target).nlink > 1) {
    throw new Error(label + ' 写入后仍有多个硬链接（nlink=' + String(fs.statSync(target).nlink) + '），可能污染 pnpm store');
  }
  console.log('→ ' + label + ' 已更新' + (before === null ? '（插件目录原先没有）' : ''));
}

/* 自动列出项目 lib 下全部文件（含 vendor 子目录），再补上 locale 与 package.json */
const libFiles = listFiles(PROJECT, '');
const metaFiles = ['package.json'].concat(
  listFiles(path.join(PROJECT_ROOT, 'locale'), '').map((name) => 'locale/' + name)
);

const jobs = libFiles
  .map((rel) => ({ label: 'lib/' + rel, from: path.join(PROJECT, rel), to: path.join(PLUGIN, rel) }))
  .concat(metaFiles.map((rel) => ({ label: rel, from: path.join(PROJECT_ROOT, rel), to: path.join(pluginRoot, rel) })));

jobs.forEach((one) => {
  try {
    writeToPlugin(one.to, one.label, fs.readFileSync(one.from, 'utf8'));
  } catch (error) {
    failed += 1;
    console.log('× ' + one.label + '：' + (error !== null && error !== undefined && error.message ? error.message : error));
  }
});

console.log('');
if (failed === 0) {
  console.log('插件目录已同步（lib ' + libFiles.length + ' 个文件 + ' + metaFiles.length + ' 个元数据文件 → ' + pluginRoot + '）；重启 DSH 生效');
} else {
  console.log('有文件没同步成功，见上面的 ×');
}
process.exitCode = failed === 0 ? 0 : 1;
