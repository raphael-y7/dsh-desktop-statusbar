/**
 * 自更新：定位 pnpm → 放行发布年龄 → 装精确版本 → 核对结果。
 *
 * 为什么不用 DSH 官方的插件安装接口（`ctx.remote.pluginManager.installBundle`）：
 *   1. 那个服务由**另一个插件**（插件管理器）提供。没装它的 profile 上 `ctx.remote`
 *      根本取不到 —— DSH 的依赖注入对未声明的服务会同步抛错，异常从 onClick 冒出
 *      没人接，界面表现就是「点了完全没反应」。
 *   2. 它内部跑裸 `pnpm add pkg@latest`，在 pnpm 11 的 `minimumReleaseAge`
 *      （默认 1440 分钟 = 24 小时）下会**静默装成旧的成熟版**，而且退出码是 0。
 *
 * 本模块的修法：自己跑 pnpm，并在跑之前把目标版本写进 profile 的
 * `minimumReleaseAgeExclude`（见 release-age.js），再用**精确版本**安装。
 * 精确版本是关键 —— 同样的策略下 `@latest` 会静默降级，而 `pkg@x.y.z` 要么装上、
 * 要么明确报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，两种结果都能被程序分辨。
 *
 * 走 pnpm（而不是自己下载 tgz 替换文件）的另一个原因：`pnpm add` 会同时更新
 * profile 的 `package.json` 与锁文件，插件目录和清单保持一致；只换 node_modules
 * 里的文件会让下一次 `pnpm install` 把版本退回去。
 *
 * @module dsh-desktop-statusbar/self-update
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ensureReleaseAgeExclude, findProfileDir } from './release-age.js'

/** 本插件包名。 */
export const SELF_NAME = 'dsh-desktop-statusbar'

/** 一次安装的整体超时（毫秒）。pnpm 冷缓存下可能较慢。 */
const INSTALL_TIMEOUT_MS = 180000

/** 传给 pnpm 的输出上限，避免日志撑爆内存。 */
const OUTPUT_LIMIT = 64000

/** 交回给界面/HTTP 的 detail 上限（字符）。错误通常在尾部，截断时保留尾部。 */
const DETAIL_LIMIT = 8000

/** 回滚时要还原的三个文件（都在 profile 目录下），顺序无关。 */
const SNAPSHOT_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

/** 单次更新的进行态；同一时刻只允许一个。 */
let running = null

/** 最近一次更新的结果（给界面与 GET 状态用）。 */
let lastResult = null

/**
 * 读取某个插件目录里 package.json 声明的版本。
 * @param {string} selfDir
 * @returns {string|null}
 */
export function installedVersion(selfDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(selfDir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch (error) {
    return null
  }
}

/**
 * 解析本插件自己的**包根目录**（含 package.json 的那一层）。
 *
 * 用 `import.meta.url` 反推，再向上找到 name 匹配的那一层 —— 比猜固定层数可靠：
 * 插件可能装在任意 profile、任意 node_modules 布局（hoisted 直接放
 * `<profile>/node_modules/<包名>`，isolated 会经过 `.pnpm/<包名>@<版本>/node_modules/`）。
 *
 * @param {string} [moduleUrl] 覆盖用（测试注入）。
 * @returns {string}
 */
export function resolveSelfDir(moduleUrl) {
  const here = moduleUrl === undefined || moduleUrl === null ? import.meta.url : moduleUrl
  let path = String(here)
  if (path.startsWith('file://')) {
    path = path.slice('file://'.length)
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    try { path = decodeURIComponent(path) } catch (error) { /* 保持原样 */ }
  }
  let current = dirname(path)
  for (let level = 0; level < 4; level += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'))
      if (manifest !== null && typeof manifest === 'object' && manifest.name === SELF_NAME) return current
    } catch (error) {
      /* 这一层没有可读的 package.json，继续往上 */
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  /* 找不到就退回模块上一级；调用方读不到 package.json 会失败，不会误改别处 */
  return dirname(dirname(path))
}

/**
 * 取一个「可能是字符串」的注入值：类型不对时退回默认值。
 * 传 `null` / 数字 / 对象都按「显式给了一个不可用的值」处理，不回退。
 *
 * @param {unknown} value 注入值
 * @param {unknown} fallback 默认值
 * @returns {string}
 */
function asText(value, fallback) {
  if (value === undefined) return typeof fallback === 'string' ? fallback : ''
  return typeof value === 'string' ? value : ''
}

/**
 * 判断一段文本看起来是不是绝对路径。
 *
 * 不用 `node:path` 的 `isAbsolute()`：它按**当前进程**的平台判断，而这里允许测试
 * 注入 `options.platform`，两者可能对不上。两种平台的写法都认：
 * `C:\x`（盘符）、`\\server\share`（UNC）、`/x`（POSIX 根）。
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksAbsolutePath(text) {
  return /^[A-Za-z]:[\\/]/.test(text)
    || text.startsWith('\\\\')
    || text.startsWith('/')
}

/**
 * 去掉路径结尾的分隔符；盘符根（`C:\`）原样保留 —— 去掉会变成 `C:`。
 *
 * @param {string} text
 * @returns {string}
 */
function trimTrailingSeparators(text) {
  let out = text
  while (out.length > 1 && /[\\/]$/.test(out) === true) {
    if (/^[A-Za-z]:[\\/]$/.test(out) === true) break
    out = out.slice(0, -1)
  }
  return out
}

/**
 * 解析安装根下的 `resources` 目录。
 *
 * 优先级（与宿主自己的 `runtimeResources()` 取值顺序一致）：
 *   1. 显式注入的 `resourcesPath`（测试用，也可以是调用方认定的权威值）；
 *   2. `process.resourcesPath` —— Electron 打包版给的权威值，比推断更稳；
 *   3. 由 `execPath` 推断：`dirname(execPath)/resources`（非 Electron 环境兜底）。
 *
 * @param {string} resourcesPath 已处理过默认值（可能是空字符串）
 * @param {string} execPath 已处理过默认值（可能是空字符串）
 * @returns {string|null} 推断不出来时返回 null
 */
function resolveResourcesDir(resourcesPath, execPath) {
  if (resourcesPath.length > 0 && looksAbsolutePath(resourcesPath) === true) {
    return trimTrailingSeparators(resourcesPath)
  }
  if (execPath.length > 0) return trimTrailingSeparators(join(dirname(execPath), 'resources'))
  return null
}

/**
 * 定位 pnpm，返回**结构化结果**（永不抛异常），把「试过哪些候选」一并带回。
 *
 * 只做定位，不执行任何外部命令。
 *
 * 候选顺序（命中即返回，逐个记进 `tried`）：
 *   1. `DSH_DESKTOP_STATUSBAR_PNPM`：插件自己的覆盖口，优先级最高。可以是 JSON 数组
 *      （`["node","/path/pnpm.mjs"]`，用别的 node 跑打包的 pnpm 时用），也可以是
 *      单个可执行文件路径。**不检查文件是否存在** —— 用户显式指定的入口就该照办。
 *   2. `DSH_DESKTOP_PNPM_ENTRY`：宿主自己的口径（宿主 `runtimeResources()` 在开发
 *      模式下读它）。排在文件候选之前，宿主以后挪位置也不会失配。
 *   3. 宿主随包提供的 pnpm，按 `resources` 目录拼出来，三条候选依次尝试：
 *      - `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`：**当前宿主布局**。
 *        优先用同一套运行时里的 node（`runtime/primary-runtime/dependencies/node/bin/node.exe`）
 *        去跑它，不依赖 Electron 的 `ELECTRON_RUN_AS_NODE`；那套 node 不在时退回宿主可执行文件
 *        （此时才需要 `ELECTRON_RUN_AS_NODE=1`）。
 *      - `runtime/pnpm/bin/pnpm.mjs`：更旧的宿主布局，保留兼容。
 *      - `app.asar.unpacked/dsh/node_modules/pnpm/bin/pnpm.mjs`：再旧的打包布局，保留兼容。
 *
 * 找不到时**不做 PATH 搜索**：Windows 上 PATH 里多半是 `pnpm.cmd`，spawn 它需要
 * `shell: true`，等于把命令解释权交给 shell，风险面大于收益。真需要时请用户用
 * `DSH_DESKTOP_STATUSBAR_PNPM` 直接指定（issue 里的绕过写法就是这么用的）。
 *
 * @param {{
 *   env?: {[key: string]: string|undefined},
 *   execPath?: string,
 *   resourcesPath?: string,
 *   exists?: (path: string) => boolean,
 *   electron?: boolean,
 *   platform?: string,
 * }} [options] 全部可选；只有测试会传
 * @returns {{
 *   ok: boolean,
 *   runner: {command: string, args: string[], electron: boolean}|null,
 *   source: 'custom-env'|'host-env'|'primary-runtime'|'runtime-legacy'|'asar-unpacked'|null,
 *   tried: Array<{source: string, path: string|null, note: string}>,
 * }}
 */
export function resolvePnpmDetailed(options) {
  const opts = options === null || typeof options !== 'object' ? {} : options
  /** 环境变量来源；默认 process.env。 */
  const env = opts.env === undefined ? process.env : (opts.env === null ? {} : opts.env)
  /** 宿主可执行文件；空字符串表示「拿不到」。 */
  const execPath = asText(opts.execPath, process.execPath)
  /** 注入的 resources 目录；未传时才回落到 process.resourcesPath。 */
  const resourcesPath = asText(opts.resourcesPath, process.resourcesPath)
  /** 是否跑在 Electron 里 —— 只有退回宿主可执行文件当 node 用时才需要它。 */
  const electron = opts.electron === undefined
    ? (typeof process.versions === 'object'
      && process.versions !== null
      && typeof process.versions.electron === 'string'
      && process.versions.electron.length > 0)
    : opts.electron === true
  /** 平台；只用来决定同套运行时里的 node 叫 node.exe 还是 node。 */
  const platform = asText(opts.platform, process.platform)

  /** 每次尝试的记录：命中的也记，失败时一并带回给调用方写日志。 */
  const tried = []
  /** 记一条命中并直接返回成功结果。 */
  const hit = (source, runner, path) => {
    tried.push({ source, path: typeof path === 'string' ? path : null, note: '命中' })
    return { ok: true, runner, source, tried }
  }
  /** 记一条未命中，继续试下一个候选。 */
  const miss = (source, path, note) => {
    tried.push({ source, path: typeof path === 'string' ? path : null, note })
  }
  /** 全部落空。 */
  const fail = () => ({ ok: false, runner: null, source: null, tried })
  /** 文件存在性检查；注入的实现抛错也当成「不存在」，保证本函数永不抛。 */
  const exists = (target) => {
    if (typeof opts.exists === 'function') {
      try { return opts.exists(target) === true } catch (error) { return false }
    }
    try { return existsSync(target) === true } catch (error) { return false }
  }

  /* 1) 插件自己的覆盖口：完全不检查文件是否存在（用户显式指定的入口） */
  const custom = asText(env.DSH_DESKTOP_STATUSBAR_PNPM, '')
  if (custom.trim().length > 0) {
    const text = custom.trim()
    if (text.startsWith('[') === true) {
      let parsed = null
      try {
        const value = JSON.parse(text)
        if (Array.isArray(value) === true && value.length > 0 && value.every((one) => typeof one === 'string') === true) {
          parsed = value
        }
      } catch (error) {
        /* 不是合法数组，落到下面的单路径处理 */
      }
      if (parsed !== null) {
        return hit('custom-env', { command: parsed[0], args: parsed.slice(1), electron: false }, custom)
      }
      /* `'[]'` 也走这里：空数组不够当命令用，退化成单路径（保持旧行为） */
      miss('custom-env', custom, '不是合法 JSON 数组，按单路径处理')
    }
    return hit('custom-env', { command: text, args: [], electron: false }, custom)
  }

  /* 2) 宿主自己的口径：只存在于开发模式，但插件照样优先认它 */
  const hostEntry = asText(env.DSH_DESKTOP_PNPM_ENTRY, '')
  if (hostEntry.trim().length > 0) {
    const entry = hostEntry.trim()
    if (execPath.length === 0) {
      miss('host-env', hostEntry, '没有可用的宿主可执行文件')
    } else if (exists(entry) === true) {
      /* tried.path 记变量原值（契约口径），实际执行用去掉首尾空白的路径 */
      return hit('host-env', { command: execPath, args: [entry], electron }, hostEntry)
    } else {
      miss('host-env', hostEntry, '不存在')
    }
  }

  /* 3) 按 resources 目录拼出来的文件候选 */
  const resources = resolveResourcesDir(resourcesPath, execPath)
  if (resources === null) {
    miss('primary-runtime', null, '无法推断 resources 目录')
    return fail()
  }

  /* 3.1 当前宿主布局：优先用同一套运行时里的 node，不碰 ELECTRON_RUN_AS_NODE */
  const primaryPnpm = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  if (exists(primaryPnpm) === true) {
    const primaryNode = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node')
    if (exists(primaryNode) === true) {
      return hit('primary-runtime', { command: primaryNode, args: [primaryPnpm], electron: false }, primaryPnpm)
    }
    if (execPath.length > 0) {
      return hit('primary-runtime', { command: execPath, args: [primaryPnpm], electron }, primaryPnpm)
    }
    miss('primary-runtime', primaryPnpm, '找到 pnpm，但同套运行时里的 node 与宿主可执行文件都不可用')
  } else {
    miss('primary-runtime', primaryPnpm, '不存在')
  }

  /* 3.2 / 3.3 旧布局：向后兼容，用宿主可执行文件加 ELECTRON_RUN_AS_NODE 去跑 */
  const legacyCandidates = [
    { source: 'runtime-legacy', file: join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs') },
    { source: 'asar-unpacked', file: join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs') },
  ]
  for (const candidate of legacyCandidates) {
    if (exists(candidate.file) !== true) {
      miss(candidate.source, candidate.file, '不存在')
      continue
    }
    if (execPath.length === 0) {
      miss(candidate.source, candidate.file, '找到 pnpm，但没有可用的宿主可执行文件')
      continue
    }
    return hit(candidate.source, { command: execPath, args: [candidate.file], electron }, candidate.file)
  }

  return fail()
}

/**
 * 定位 pnpm 可执行文件（向后兼容的薄包装）。
 *
 * 内部走 `resolvePnpmDetailed()`，只关心「最终能不能跑」，不关心试过哪些候选。
 * 现有测试与 `verify-self-update.js --online` 用的都是这个签名。
 *
 * @param {object} [options] 透传给 resolvePnpmDetailed（测试注入用）
 * @returns {{command: string, args: string[], electron: boolean}|null}
 */
export function resolvePnpm(options) {
  const detail = resolvePnpmDetailed(options)
  return detail.ok === true ? detail.runner : null
}

/**
 * 跑一条命令并收集输出。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env?: object, timeoutMs?: number}} options
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runCommand(command, args, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: String(error && error.message), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timer = null
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    }
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch (error) { /* 可能已退出 */ }
      /* 被杀之后 close 未必触发，兜一个底 */
      setTimeout(() => finish(null), 5000)
    }, options.timeoutMs === undefined ? INSTALL_TIMEOUT_MS : options.timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += String(chunk)
    })
    child.on('error', (error) => {
      stderr += String(error && error.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * 判断 pnpm 的输出是不是「发布年龄」拦下的。
 *
 * pnpm 11 用 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`；老版本用
 * `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。两个都认，这样即使豁免没生效，
 * 也能给出准确的原因而不是笼统的「更新失败」。
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isReleaseAgeBlocked(output) {
  const text = String(output)
  return text.includes('NO_MATURE_MATCHING_VERSION') || text.includes('MINIMUM_RELEASE_AGE_VIOLATION')
}

/**
 * 把 pnpm 的输出归类成具体失败原因。
 *
 * **本轮只做框架，等真机错误码再校准**：用户机器上那次失败没留下日志，
 * 所以下面这些正则来自「已知的 pnpm 错误族」而非实测样本。
 * 命中不了就返回 'install-failed'（老值，语义不变）。
 *
 * 判定顺序由调用方保证（不许调换）：timedOut → 'timeout'；
 * isReleaseAgeBlocked → 'release-age'；否则才进这里。
 *
 * @param {string} output pnpm 的 stdout + stderr
 * @returns {'outdated-lockfile'|'store-error'|'postinstall-failed'|'symlink-failed'|'disk-full'|'install-failed'}
 */
function classifyPnpmFailure(output) {
  const text = String(output === null || output === undefined ? '' : output)
  if (text.includes('ERR_PNPM_OUTDATED_LOCKFILE')) return 'outdated-lockfile'
  if (/ERR_SQLITE_ERROR|store.*(open|lock)/i.test(text)) return 'store-error'
  if (/spawn (EPERM|EACCES)/i.test(text) || /ELIFECYCLE/.test(text)) return 'postinstall-failed'
  if (/\[EPERM\].*symlink|operation not permitted, symlink/i.test(text)) return 'symlink-failed'
  if (/ENOSPC|no space left/i.test(text)) return 'disk-full'
  return 'install-failed'
}

/**
 * 把一段输出裁成可以直接交出去的大小。
 *
 * 为什么不再 `.slice(-600)`：用户机器上那次 `install-failed`，pnpm 的真正原因
 * （哪一步、哪个包、什么错误码）全在 600 字符之外，界面上只剩「更新失败」。
 * 保留**尾部**是因为 pnpm 的失败结论总在最后几行。
 *
 * @param {string} text
 * @returns {string}
 */
function detailOf(text) {
  const value = String(text === null || text === undefined ? '' : text)
  if (value.length <= DETAIL_LIMIT) return value
  return '[已截断，仅保留最后 ' + DETAIL_LIMIT + ' 字符]\n' + value.slice(-DETAIL_LIMIT)
}

/**
 * 把 profile 里的一个文件读成逐字节快照。
 *
 * 为什么用 Buffer 而不是 parse：回滚必须**逐字节**还原（含原有换行风格、键顺序、
 * 末尾空行）。解析再序列化会改格式、产生无意义的 diff，用户看到一堆虚假改动更难排查。
 *
 * @param {string} file
 * @returns {{ok: true, buf: Buffer}|{ok: false, missing: true}}
 */
function snapshotFile(file) {
  try {
    return { ok: true, buf: readFileSync(file) }
  } catch (error) {
    /* 文件不存在是正常的（例如某些 profile 没有 pnpm-workspace.yaml）—— 记成"原本不存在"，
       回滚时如果它被创建了，就删掉。 */
    return { ok: false, missing: true }
  }
}

/**
 * 修复安装要装的版本号：读 profile 的 `package.json` 里本插件当前写的那个。
 *
 * 为什么读清单而不是读已装实物：修复的用途就是「声明与实物不一致」——
 * 清单是**声明**，实物才是要修的那一头。拿清单里的版本重装一遍，四处自然对齐。
 * 读不出来（文件没了 / 不是 JSON / 依赖段里没有本插件）就退回 `'latest'`：
 * 那种情况说明清单里本来就没有它，让 pnpm 按最新版补上是对的。
 *
 * @param {string} profileDir
 * @returns {string}
 */
function repairTargetVersion(profileDir) {
  try {
    const raw = readFileSync(join(profileDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const deps = parsed !== null && typeof parsed === 'object' && typeof parsed.dependencies === 'object'
      ? parsed.dependencies
      : null
    const value = deps === null ? null : deps[SELF_NAME]
    if (typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())) {
      return value.trim()
    }
  } catch (error) {
    /* 读不出来就走兜底 */
  }
  return 'latest'
}

/**
 * 给三个文件做逐字节快照，键是绝对路径。
 * @param {string} profileDir
 * @returns {Map<string, {ok: true, buf: Buffer}|{ok: false, missing: true}>}
 */
function snapshotProfile(profileDir) {
  const map = new Map()
  for (const name of SNAPSHOT_FILES) {
    const file = join(profileDir, name)
    map.set(file, snapshotFile(file))
  }
  return map
}

/**
 * 把快照还原到盘上，**只动真正变过的文件**。
 *
 * 为什么只动变过的：内容没变却重写一遍，会让 mtime 无意义地跳一下 ——
 * 用户/别的工具看到「刚刚改过」，排查时反而多一条假线索。
 *
 * @param {Map<string, {ok: true, buf: Buffer}|{ok: false, missing: true}>} snapshot
 * @returns {{ok: boolean, restored: string[], removed: string[], error: string|null}}
 */
function rollbackProfile(snapshot) {
  const restored = []
  const removed = []
  try {
    for (const [file, saved] of snapshot) {
      const current = snapshotFile(file)
      if (saved.ok === true) {
        if (current.ok === true && Buffer.compare(current.buf, saved.buf) === 0) continue
        writeFileSync(file, saved.buf)
        restored.push(file)
      } else if (current.ok === true) {
        /* 原本不存在、现在被创建了 —— 删掉，才算真的回到原样 */
        unlinkSync(file)
        removed.push(file)
      }
    }
    return { ok: true, restored, removed, error: null }
  } catch (error) {
    return {
      ok: false,
      restored,
      removed,
      error: String(error && error.message ? error.message : error),
    }
  }
}

/**
 * 回滚失败的说明文本：先把回滚的错摆在最前面，再把原本那次 pnpm 的输出附在后面。
 *
 * 两段都不能丢：只看回滚错误会不知道「用户本来在干什么」，
 * 只看 pnpm 输出会不知道「环境为什么还是脏的」。
 *
 * @param {string} rollbackError
 * @param {string} output pnpm 的原始输出
 * @returns {string}
 */
function rollbackFailureDetail(rollbackError, output) {
  const head = '[回滚失败] ' + rollbackError
  const tail = String(output === null || output === undefined ? '' : output)
  return detailOf(tail.length > 0 ? head + '\n\n--- pnpm 输出 ---\n' + tail : head)
}

/**
 * 单次命令用的「发布年龄归零」开关。
 *
 * 为什么需要它，而不是只靠 `minimumReleaseAgeExclude` 放行目标版本：
 * 被年龄策略拦下的不只是目标包本身，还有它的**依赖**。一旦插件新版本引入了
 * 一个刚发布不满 24 小时的依赖，只放行插件自己仍然装不上
 * （实测：门槛拉高时 `zod@4.4.0` 会连同插件一起被拒）。
 *
 * 写法用「烤肉串」形式而不是驼峰：pnpm 12.3.0 起（原生 CLI）会**静默忽略**
 * `--config.minimumReleaseAge=0`（不报未知选项，直接当没传），于是重试仍会失败；
 * `--config.minimum-release-age=0` 在 pnpm 10 / 11 / 12 上都被认。
 * 这是这个键特有的行为，不能推广到别的 `--config.*`。
 *
 * 作用域只有这一条命令：不写进任何配置文件，所以不会永久改变用户的策略。
 */
export const RELEASE_AGE_OVERRIDE = '--config.minimum-release-age=0'

/**
 * 一次 pnpm 调用的参数。
 *
 * 带上下面的开关：
 *   - `--save-exact`：清单里写死精确版本，避免 `^` 范围日后漂移。
 *   - 发布年龄归零：见 RELEASE_AGE_OVERRIDE。
 *   - `--ignore-scripts`：不跑依赖的生命周期脚本（取舍见下）。
 *   - `--reporter=append-only`：非交互输出（不刷进度条、不重绘行）。
 *   - `--config.confirmModulesPurge=false`：永不因清空 node_modules 停下来问人。
 *
 * 不加 `--no-frozen-lockfile`：pnpm 11 的 `add` 不认这个选项
 * （实测报 `Unknown option: 'frozen-lockfile'`；宿主当前自带 pnpm 11.28.5，同样如此）。
 * `add` 本来就会更新锁文件，不需要它。
 *
 * `--ignore-scripts` 的取舍：这个 add 命令会连带重装 profile 里的其它依赖，
 * 加上它会让 @dataiku/uv / @google/genai / protobufjs 等包的 postinstall 不跑。
 * 那些脚本与本插件无关，跳过它们**大概率是好事**（少一个失败点、少一份供应面）。
 * 代价：如果将来本插件自己需要 postinstall/preinstall/prepare，这里必须重新评估 ——
 * 本插件当前没有这三个钩子（已核对 package.json）。
 *
 * 修复模式（`mode === 'repair'`）与更新模式的差别，每一条都有理由：
 *   1. **同样是 `add`，不是 `install`**：用户原话「你更新都只更新你自己，你修复你还为什么
 *      还要管别人？」—— `pnpm install` 会把 profile 里**全部**依赖重装一遍（十几个包），
 *      任何一个包的 postinstall 失败都会让整条命令失败（实测 `@dataiku/uv` 就抛过
 *      `spawn EPERM`）。修复是兜底动作，不该因为别人的包而失败。
 *   2. **目标版本取「清单里当前写的那个」**：修复不装新版本，只是让 pnpm 按现有清单
 *      把**本插件**重新对齐。所以调用方要把 `package.json` 里现存的版本传进来；
 *      传空就退回 `@latest`（那种情况说明清单里本来就没有它）。
 *   3. **带 `--ignore-scripts`**：与更新模式一致。本插件没有 postinstall/preinstall/
 *      prepare（已核对 package.json），跳过脚本不会留下装不完整的自己，
 *      却能避开别人的生命周期脚本。
 *
 * @param {string[]} base pnpm 自身的参数（例如打包 pnpm 的 .mjs 路径）
 * @param {string} target 安装目标 `包名@版本`
 * @param {'update'|'repair'} [mode] 两种模式命令相同，只有 target 的来源不同
 * @returns {string[]}
 */
export function updateArgs(base, target, mode) {
  /* 修复与更新用的是同一条命令：都只 `add` 本插件，只差 target 从哪来。
     `mode` 保留在签名里是为了调用方读得懂意图，也方便将来真要分叉时有落点。 */
  void mode
  return [
    ...base,
    'add',
    '--save-exact',
    '--ignore-scripts',
    '--reporter=append-only',
    '--config.confirmModulesPurge=false',
    RELEASE_AGE_OVERRIDE,
    target,
  ]
}

/**
 * 执行一次自更新（或一次修复安装）。全程不抛异常，失败以结构化结果返回。
 *
 * `options.mode`：
 *   - `'update'`（默认）：装一个**精确版本**，装完回读版本号核对。
 *   - `'repair'`：不装新版本，让 pnpm 按现有清单把 node_modules 对齐。
 *     用途是「用户机器的 package.json / pnpm-lock.yaml / .modules.yaml / 实物
 *     四处状态互相矛盾」（升级失败后残留）。它与 update 的差别见 updateArgs 的注释；
 *     这里另外三处必须跟着变：
 *       1. 不调 ensureReleaseAgeExclude —— 没有新版本需要放行，写豁免只会污染用户配置；
 *       2. 跳过版本回读校验 —— repair 不改版本，拿 options.version 去比必然对不上；
 *       3. 成功判据 = 退出码 0 且未超时。
 *
 * `result.to` 在 repair 模式下是 **null**：这次操作没有"目标版本"，
 * 拿 `options.version` 填进去会让人误以为修复成功就是装成了那个版本。
 *
 * @param {{selfDir: string, version?: string, mode?: 'update'|'repair', logger?: Function, timeoutMs?: number}} options
 * @returns {Promise<object>}
 */
export async function runSelfUpdate(options) {
  const selfDir = options.selfDir
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  /** 更新还是修复；任何其它值一律按更新处理（保持旧行为）。 */
  const mode = options.mode === 'repair' ? 'repair' : 'update'
  const from = installedVersion(selfDir)
  /* restartRequired 一律为 true：在 DSH 里替换已安装插件的版本**必然**需要重启，
     刷新页面不算数 —— 插件包元数据（含 client.js 的 revision）在启动时缓存、直到重启才更新
     （见 @deepseek-ai/dsh-hmr 的已知限制与 dsh-client-modules 的说明）。
     不用「要不要重启」去猜，直接如实告诉界面。repair 重写的是 node_modules 里的实物，
     同样要重启才生效，所以两种模式都是 true。 */
  const result = { ok: false, mode, from, to: mode === 'repair' ? null : options.version, reason: null, detail: null, profileDir: null, changedExclude: false, rolledBack: false, restartRequired: true, tried: [] }

  /* 注意：必须在找 profile 之前就报 pnpm-not-found —— 找不到 pnpm 时 profile
     目录是否存在无关紧要，先告诉用户真正的卡点。 */
  const pnpm = resolvePnpmDetailed()
  if (pnpm.ok !== true) {
    result.reason = 'pnpm-not-found'
    /* 把试过的候选写进结果和日志：issue 里那次排查全靠手工逐条 Test-Path，
       以后用户/开发者看日志就能定位，不用再猜插件找的是哪条路径。 */
    result.tried = pnpm.tried
      .slice(0, 12)
      .map((one) => {
        const where = one.path === null ? '—' : one.path
        const line = one.source + ': ' + where + '（' + one.note + '）'
        return line.length > 300 ? line.slice(0, 300) + '…' : line
      })
    log('update: pnpm-not-found，尝试过：')
    for (const line of result.tried) log('  - ' + line)
    return result
  }

  const runner = pnpm.runner
  log('update: pnpm 来源 ' + pnpm.source + ' → ' + runner.command + ' ' + runner.args.join(' ') + (runner.electron === true ? '（ELECTRON_RUN_AS_NODE）' : ''))

  const profileDir = findProfileDir(selfDir)
  result.profileDir = profileDir
  if (profileDir === null) {
    result.reason = 'profile-not-found'
    return result
  }

  /* M1：快照必须在这里 —— **在 ensureReleaseAgeExclude 之前、调 pnpm 之前**。
     为什么必须在豁免写入之前：豁免表就是 ensureReleaseAgeExclude 改的，
     快照放在它之后，那次改动就落在快照「内侧」，回滚永远还原不掉它 ——
     实测会留下 `dsh-desktop-statusbar@9.9.9` 这行残留，正是用户抱怨的「状态矛盾」之一。
     放在它之前，回滚目标 = 「还没动过的用户原始状态」：pnpm 改的 package.json /
     pnpm-lock.yaml 被还原，本次新增的豁免被还原，而用户原有的豁免本就在快照里，一行不动。 */
  const snapshot = snapshotProfile(profileDir)

  /* repair 模式**不写豁免表**：那条豁免是为了"放行某个刚发布的新版本"，
     而修复安装压根不装新版本 —— 写进去只会在用户的 pnpm-workspace.yaml 里
     留下一条无意义的版本号，正是这个功能想清理的那种"状态矛盾"。 */
  if (mode !== 'repair') {
    /* 先把目标版本写进豁免表：这是 pnpm 自己的豁免机制，写进去后目标版本无论多新
       都算「已放行」。写不成也继续 —— 下面那次运行还带着一次性归零开关兜底。 */
    const ensured = ensureReleaseAgeExclude(profileDir, options.version)
    result.changedExclude = ensured.changed === true
    if (ensured.ok !== true) {
      log('release-age: 豁免写入未成功（' + String(ensured.reason) + '），继续尝试安装')
    } else if (ensured.changed === true) {
      log('release-age: 已放行 ' + SELF_NAME + '@' + options.version)
    }
  }

  /* 精确版本，不用 @latest：后者在发布年龄策略下会静默装成旧的成熟版。
     repair 模式的目标是「清单里当前写着的那个版本」—— 修复不装新版本，只把本插件
     重新对齐一次；清单里读不到（还没被 pnpm 写过）就退回 @latest 兜底。 */
  const target = mode === 'repair'
    ? SELF_NAME + '@' + repairTargetVersion(profileDir)
    : SELF_NAME + '@' + options.version
  const env = { ...process.env }
  if (runner.electron === true) env.ELECTRON_RUN_AS_NODE = '1'
  /* 这里**刻意不设 CI=true**：CI 模式下 pnpm 默认走 frozen-lockfile，
     而本场景恰恰是「先改清单、再让 pnpm 同步锁文件」，两者天然冲突 ——
     设了它，pnpm 会因为锁文件与清单不一致直接报错退出。
     非交互能力改由 updateArgs 里的 --reporter=append-only 与
     --config.confirmModulesPurge=false 显式提供，不靠 CI 环境变量。 */
  const args = updateArgs(runner.args, target, mode)

  log(mode === 'repair' ? 'update: 开始修复安装（只重装本插件，不碰其它依赖）：' + target : 'update: 开始安装 ' + target)
  const run = await runCommand(runner.command, args, {
    cwd: profileDir,
    env,
    timeoutMs: options.timeoutMs,
  })
  const output = (run.stdout + '\n' + run.stderr).trim()

  /* 判定顺序固定，不许调换：
       1. timedOut            → 'timeout'（输出不完整，按文本猜会误判）
       2. isReleaseAgeBlocked → 'release-age'（有准确语义，优先于泛化分类）
       3. 其余                → classifyPnpmFailure()，它内部兜底 'install-failed'
     老的 reason 值语义一个都没动，新分类只是把 'install-failed' 拆细。 */
  if (run.timedOut === true) {
    result.reason = 'timeout'
  } else if (run.exitCode !== 0) {
    result.reason = isReleaseAgeBlocked(output) ? 'release-age' : classifyPnpmFailure(output)
  }

  if (result.reason !== null) {
    result.detail = detailOf(output)
    return finishFailure(result, { snapshot, run, output, args, runner, profileDir, log })
  }

  /* repair 不改版本，没有"装没装上某个版本"可核对 —— 成功判据就是退出码 0 且未超时
     （上面两个分支已经把超时与非零退出拦掉了）。修复本来就可能什么都没改
     （四处状态已经一致），这时 pnpm 一样退出 0，也算成功。 */
  if (mode === 'repair') {
    result.ok = true
    log('update: 修复安装完成（退出码 0）')
    return result
  }

  /* 不能只看退出码：发布年龄策略下 pnpm 可能「成功」地装了旧版。
     必须回读盘上的实际版本，这是唯一可信的成功判据。 */
  const now = installedVersion(selfDir)
  if (now === null) {
    result.reason = 'verify-failed'
    return finishFailure(result, { snapshot, run, output, args, runner, profileDir, log })
  }
  if (now !== options.version) {
    result.reason = 'version-mismatch'
    result.detail = detailOf('期望 ' + options.version + '，实际 ' + now)
    return finishFailure(result, { snapshot, run, output, args, runner, profileDir, log })
  }

  result.ok = true
  log('update: 已更新到 ' + now)
  return result
}

/**
 * 失败收尾：回滚那三份文件，再把结构化失败信息挂到 result 上。
 *
 * 为什么单独抽一个函数：失败有四个出口（超时 / 非零退出 / verify-failed /
 * version-mismatch），回滚与 failureReport 必须在**每一个**出口都发生，
 * 抄四遍迟早漏一处。这里是唯一出口。
 *
 * 关于 failureReport 的分工：runSelfUpdate 是 lib 层、**不能发 HTTP**
 * （宿主那边负责路由与上报）。这里只把结构化信息放进 result，
 * 由宿主的 index.js 读取后去 POST。本函数里不许出现任何网络调用。
 *
 * @param {object} result
 * @param {{
 *   snapshot: Map<string, object>, run: object, output: string,
 *   args: string[], runner: object, profileDir: string, log: Function,
 * }} ctx
 * @returns {object} 同一个 result（原地改完返回，方便调用方直接 return）
 */
function finishFailure(result, ctx) {
  const rollback = rollbackProfile(ctx.snapshot)
  result.rolledBack = rollback.ok === true

  if (rollback.ok !== true) {
    /* 回滚自身抛错：reason 换成 rollback-failed，但原 pnpm 输出必须留在 detail 里，
       否则「环境为什么脏」和「本来在干什么」这两条线索会丢一条。 */
    result.reason = 'rollback-failed'
    result.detail = rollbackFailureDetail(rollback.error, ctx.output)
  } else if (rollback.restored.length > 0 || rollback.removed.length > 0) {
    ctx.log('update: 已回滚 ' + rollback.restored.map((one) => basename(one)).join(', ')
      + (rollback.removed.length > 0
        ? '；已删除 ' + rollback.removed.map((one) => basename(one)).join(', ')
        : ''))
  } else {
    ctx.log('update: 无需回滚（三份文件与快照逐字节一致）')
  }

  result.failureReport = {
    stage: 'host-install',
    /* mode 一并带出去：界面要在"更新失败"和"修复失败"之间区分文案，
       宿主的日志也要能分清这次到底跑的是哪条命令。 */
    mode: result.mode,
    reason: result.reason,
    from: result.from,
    to: result.to,
    exitCode: ctx.run.exitCode,
    timedOut: ctx.run.timedOut === true,
    command: ctx.runner.command,
    args: ctx.args,
    cwd: ctx.profileDir,
    stdout: ctx.run.stdout,
    stderr: ctx.run.stderr,
    rolledBack: result.rolledBack === true,
  }
  return result
}

/**
 * 带并发保护地执行自更新（或修复安装）：同一时刻只跑一个。
 *
 * `options.mode` 原样透传给 runSelfUpdate（见那里的说明）。
 *
 * @param {{selfDir: string, version?: string, mode?: 'update'|'repair', logger?: Function, timeoutMs?: number}} options
 * @returns {Promise<object>}
 */
export async function selfUpdateOnce(options) {
  const mode = options.mode === 'repair' ? 'repair' : 'update'
  if (running !== null) return { ok: false, mode, reason: 'busy', busy: true }
  const task = (async () => {
    try {
      const value = await runSelfUpdate(options)
      lastResult = value
      return value
    } catch (error) {
      const failure = {
        ok: false,
        mode,
        from: null,
        to: mode === 'repair' ? null : options.version,
        reason: 'unexpected',
        detail: String(error && error.message),
      }
      lastResult = failure
      return failure
    } finally {
      running = null
    }
  })()
  running = task
  return task
}

/** 更新是否正在进行。 */
export function isUpdating() {
  return running !== null
}

/** 最近一次更新的结果；没跑过就是 null。 */
export function lastUpdateResult() {
  return lastResult
}
