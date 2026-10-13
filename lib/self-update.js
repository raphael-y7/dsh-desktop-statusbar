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
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureReleaseAgeExclude, findProfileDir } from './release-age.js'

/** 本插件包名。 */
export const SELF_NAME = 'dsh-desktop-statusbar'

/** 一次安装的整体超时（毫秒）。pnpm 冷缓存下可能较慢。 */
const INSTALL_TIMEOUT_MS = 180000

/** 传给 pnpm 的输出上限，避免日志撑爆内存。 */
const OUTPUT_LIMIT = 64000

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
 * 定位 pnpm 可执行文件。
 *
 * 顺序：
 *   1. 环境变量 `DSH_DESKTOP_STATUSBAR_PNPM`：完整命令覆盖。可以是 JSON 数组
 *      （`["node","/path/pnpm.mjs"]`，用别的 node 跑打包的 pnpm 或包一层脚本时用），
 *      也可以是单个可执行文件路径。
 *   2. 宿主随包提供的 pnpm：从 `process.execPath` 推出 resources 目录。
 *      DSH 桌面端把 pnpm 放在 `resources/runtime/pnpm/bin/pnpm.mjs`，
 *      用 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动即可当 node 用
 *      （官方插件管理器走的也是这条路）。
 *   3. PATH 上的 `pnpm`（web 端 / CLI 运行时常走这条）。
 *
 * @returns {{command: string, args: string[], electron: boolean}|null}
 */
export function resolvePnpm() {
  const explicit = process.env.DSH_DESKTOP_STATUSBAR_PNPM
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const text = explicit.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed) === true && parsed.length > 0 && parsed.every((one) => typeof one === 'string')) {
          return { command: parsed[0], args: parsed.slice(1), electron: false }
        }
      } catch (error) {
        /* 不是合法数组就当单路径处理 */
      }
    }
    return { command: text, args: [], electron: false }
  }

  const execPath = process.execPath
  if (typeof execPath === 'string' && execPath.length > 0) {
    const resources = join(dirname(execPath), 'resources')
    const candidates = [
      join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
      join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    ]
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return { command: execPath, args: [candidate], electron: true }
      } catch (error) {
        /* 试下一个 */
      }
    }
  }

  return null
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
 *
 * 不加 `--no-frozen-lockfile`：pnpm 11.7.0 的 `add` 不认这个选项
 * （实测报 `Unknown option: 'frozen-lockfile'`）。`add` 本来就会更新锁文件，
 * 不需要它。
 *
 * @param {string[]} base pnpm 自身的参数（例如打包 pnpm 的 .mjs 路径）
 * @param {string} target 安装目标 `包名@版本`
 * @returns {string[]}
 */
export function updateArgs(base, target) {
  return [...base, 'add', '--save-exact', RELEASE_AGE_OVERRIDE, target]
}

/**
 * 执行一次自更新。全程不抛异常，失败以结构化结果返回。
 *
 * @param {{selfDir: string, version: string, logger?: Function, timeoutMs?: number}} options
 * @returns {Promise<object>}
 */
export async function runSelfUpdate(options) {
  const selfDir = options.selfDir
  const log = typeof options.logger === 'function' ? options.logger : () => {}
  const from = installedVersion(selfDir)
  /* restartRequired 一律为 true：在 DSH 里替换已安装插件的版本**必然**需要重启，
     刷新页面不算数 —— 插件包元数据（含 client.js 的 revision）在启动时缓存、直到重启才更新
     （见 @deepseek-ai/dsh-hmr 的已知限制与 dsh-client-modules 的说明）。
     不用「要不要重启」去猜，直接如实告诉界面。 */
  const result = { ok: false, from, to: options.version, reason: null, detail: null, profileDir: null, changedExclude: false, restartRequired: true }

  const pnpm = resolvePnpm()
  if (pnpm === null) {
    result.reason = 'pnpm-not-found'
    return result
  }

  const profileDir = findProfileDir(selfDir)
  result.profileDir = profileDir
  if (profileDir === null) {
    result.reason = 'profile-not-found'
    return result
  }

  /* 先把目标版本写进豁免表：这是 pnpm 自己的豁免机制，写进去后目标版本无论多新
     都算「已放行」。写不成也继续 —— 下面那次运行还带着一次性归零开关兜底。 */
  const ensured = ensureReleaseAgeExclude(profileDir, options.version)
  result.changedExclude = ensured.changed === true
  if (ensured.ok !== true) {
    log('release-age: 豁免写入未成功（' + String(ensured.reason) + '），继续尝试安装')
  } else if (ensured.changed === true) {
    log('release-age: 已放行 ' + SELF_NAME + '@' + options.version)
  }

  /* 精确版本，不用 @latest：后者在发布年龄策略下会静默装成旧的成熟版 */
  const target = SELF_NAME + '@' + options.version
  const env = { ...process.env }
  if (pnpm.electron === true) env.ELECTRON_RUN_AS_NODE = '1'
  /* CI=true：pnpm 在非交互环境下不会弹提示卡住（与官方插件管理器同一做法） */
  env.CI = 'true'
  const args = updateArgs(pnpm.args, target)

  log('update: 开始安装 ' + target)
  const run = await runCommand(pnpm.command, args, {
    cwd: profileDir,
    env,
    timeoutMs: options.timeoutMs,
  })
  const output = (run.stdout + '\n' + run.stderr).trim()

  if (run.timedOut === true) {
    result.reason = 'timeout'
    result.detail = output.slice(-600)
    return result
  }
  if (run.exitCode !== 0) {
    result.reason = isReleaseAgeBlocked(output) ? 'release-age' : 'install-failed'
    result.detail = output.slice(-600)
    return result
  }

  /* 不能只看退出码：发布年龄策略下 pnpm 可能「成功」地装了旧版。
     必须回读盘上的实际版本，这是唯一可信的成功判据。 */
  const now = installedVersion(selfDir)
  if (now === null) {
    result.reason = 'verify-failed'
    return result
  }
  if (now !== options.version) {
    result.reason = 'version-mismatch'
    result.detail = '期望 ' + options.version + '，实际 ' + now
    return result
  }

  result.ok = true
  log('update: 已更新到 ' + now)
  return result
}

/**
 * 带并发保护地执行自更新：同一时刻只跑一个。
 * @param {{selfDir: string, version: string, logger?: Function, timeoutMs?: number}} options
 * @returns {Promise<object>}
 */
export async function selfUpdateOnce(options) {
  if (running !== null) return { ok: false, reason: 'busy', busy: true }
  const task = (async () => {
    try {
      const value = await runSelfUpdate(options)
      lastResult = value
      return value
    } catch (error) {
      const failure = {
        ok: false,
        from: null,
        to: options.version,
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
