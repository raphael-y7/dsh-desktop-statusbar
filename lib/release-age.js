/**
 * 让 pnpm 放行「刚发布、还没到发布年龄门槛」的新版本。
 *
 * 背景：pnpm 11 自带一条供应链策略 `minimumReleaseAge`（默认 1440 分钟 = 24 小时）：
 * 发布时间不满 24 小时的版本会被跳过或直接拒绝。这是 pnpm 自己写死的默认值，
 * DSH 没有设置它，profile 里也不会出现这个键。
 *
 * 三种表现（已在 pnpm 11.7.0 上实测）：
 *   - 按包名装 `pkg` / `pkg@latest`：**静默装成旧的成熟版**，退出码 0，什么都不提示。
 *   - 精确版本 `pkg@2.2.0`：报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，什么都没装。
 *   - 精确版本 + 该版本出现在 `minimumReleaseAgeExclude` 里：**正常装上**。
 *
 * 所以绕过方式就是在安装前把这个精确版本写进 profile 的 `minimumReleaseAgeExclude`。
 * 这是 pnpm 自己支持的豁免机制（pnpm 在没有显式设置该键时也是靠自动往这里追加来放行），
 * 不是绕过校验的后门：写入的是「包名@精确版本」，只对一个版本生效。
 *
 * 两个必须处理的坑：
 *   1. pnpm 对同一个包名**只认第一条** `minimumReleaseAgeExclude` 规则，后面的会被忽略
 *      （dshmarket 记录的 #732）。所以同一个名字的多条规则必须合并成一条，
 *      否则我们追加的那条会因为是第二条而失效。
 *   2. 这条规则要写在 profile 的 `pnpm-workspace.yaml` 里；文件不存在时，
 *      安装走 pnpm 自己的自动豁免，也不会失败，所以这里按「尽力而为」处理。
 *
 * @module dsh-desktop-statusbar/release-age
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 本插件的包名。 */
export const SELF_NAME = 'dsh-desktop-statusbar'

/** 允许写入的版本号形态：正式版或带预发布后缀。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 从一个 `包名@版本` 选择器里拆出包名。
 * 作用域包（`@scope/name@1.0.0`）前面还有一个 `@`，所以从下标 1 开始找。
 * @param {string} selector
 * @returns {string}
 */
export function nameOfSelector(selector) {
  const text = String(selector).trim()
  const at = text.indexOf('@', 1)
  return at === -1 ? text : text.slice(0, at)
}

/**
 * 从一个选择器里拆出版本部分（可能形如 `1.0.0 || 2.0.0`）。
 * @param {string} selector
 * @returns {string}
 */
export function versionOfSelector(selector) {
  const text = String(selector).trim()
  const at = text.indexOf('@', 1)
  return at === -1 ? '' : text.slice(at + 1).trim()
}

/**
 * 解析 `minimumReleaseAgeExclude` 块里的每一行。
 *
 * 返回项保留原始行文本，便于把「不需要动的行」原样写回去 —— 用户写的注释、
 * 引号写法、缩进都不该被我们顺手改掉。
 *
 * @param {string} block 块的正文（不含 `minimumReleaseAgeExclude:` 那一行）
 * @returns {Array<{kind: 'entry', line: string, selector: string}|{kind: 'comment', line: string}|{kind: 'other', line: string}>}
 */
export function parseExcludeBlock(block) {
  const items = []
  for (const raw of String(block).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().length === 0) continue
    const match = /^([ \t]*)-[ \t]*(.*)$/.exec(line)
    if (match === null) {
      items.push({ kind: /^[ \t]*#/.test(line) ? 'comment' : 'other', line })
      continue
    }
    /* 去掉行尾注释：只在值不是引号包裹时才剥，避免把 '#1.2.3' 里的 # 当成注释 */
    let value = match[2].trim()
    if (value.startsWith("'") !== true && value.startsWith('"') !== true) {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length > 1) value = value.slice(1, -1).replace(/''/g, "'")
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1)
    items.push({ kind: 'entry', line, selector: value })
  }
  return items
}

/**
 * 把多个同一包名的选择器合成一条规则。
 *
 * 版本之间用 ` || ` 连接（pnpm 的版本选择器语法）；全部对齐去重，顺序按首次出现。
 * 一个包名写成一条，绕开 pnpm「只认第一条」的行为。
 *
 * @param {string[]} selectors
 * @returns {string}
 */
export function unionSelectors(selectors) {
  const versions = []
  for (const selector of selectors) {
    const parts = versionOfSelector(selector).split('||')
    for (const one of parts) {
      const trimmed = one.trim()
      if (trimmed.length > 0 && versions.includes(trimmed) !== true) versions.push(trimmed)
    }
  }
  return versions.join(' || ')
}

/**
 * 解析 `minimumReleaseAgeExclude:` **写在同行**的值。
 *
 * 这个键不只有「独占一行、下面挂列表」一种写法，pnpm 生态里同样常见：
 *   · flow 风格：`minimumReleaseAgeExclude: ["a@1.0.0"]`
 *   · 行尾注释：`minimumReleaseAgeExclude:  # 豁免表`
 *   · 空数组：  `minimumReleaseAgeExclude: []`
 * 不解析它们就会当成「文件里没有这个键」而追加出重复键，见 mergeExcludeIntoYaml 的说明。
 *
 * @param {string} inline 冒号之后、换行之前的那一段
 * @returns {Array<object>} 与 parseExcludeBlock 同形状的条目
 */
function parseInlineValue(inline) {
  const value = String(inline).trim()
  if (value.length === 0) return []
  /* 行尾注释：保留成注释条目，重排时会统一放到块首 */
  if (value.startsWith('#')) return [{ kind: 'comment', line: '  ' + value }]
  /* flow 数组：逐个拆出，引号处理与块里的标量一致 */
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner.length === 0) return []
    const out = []
    for (const one of inner.split(',')) {
      let item = one.trim()
      if (item.startsWith("'") && item.endsWith("'") && item.length > 1) item = item.slice(1, -1).replace(/''/g, "'")
      else if (item.startsWith('"') && item.endsWith('"') && item.length > 1) item = item.slice(1, -1)
      if (item.length > 0) out.push({ kind: 'entry', line: '  - ' + item, selector: item })
    }
    return out
  }
  /* 认不出的标量：当作一条规则收下来，重排成块风格时不会丢值 */
  return [{ kind: 'entry', line: '  - ' + value, selector: value }]
}

/**
 * 在 `pnpm-workspace.yaml` 的正文里确保本插件的目标版本被豁免。
 *
 * 纯函数：只做字符串进出，方便直接测。
 *
 * @param {string} text 文件全文
 * @param {string} name 包名
 * @param {string} version 要放行的精确版本
 * @param {string} eol 换行符（保持文件原有风格）
 * @returns {{ok: boolean, text: string, changed: boolean, reason: string|null}}
 */
export function mergeExcludeIntoYaml(text, name, version, eol = '\n') {
  const source = String(text)
  /* 键这一行之后可能是换行（块风格），也可能是**同行值**（flow 数组 / 行尾注释 / 空数组）。
     两种都必须认：早先只认块风格，遇到同行写法会误判成「没有这个键」而追加出
     第二个同名键 —— YAML 直接 `duplicated mapping key`，pnpm 拒绝启动，
     受害的是整个 profile 而不只是本插件。 */
  const blockRe = /^minimumReleaseAgeExclude:[ \t]*([^\r\n]*)\r?\n((?:(?:[ \t]+-[^\r\n]*|[ \t]*#[^\r\n]*)[ \t]*\r?\n?)*)/m
  const found = blockRe.exec(source)

  if (found === null) {
    /* 文件里还没有这个键：追加一个块。缩进用两个空格，与 pnpm 自己写出来的样式一致。 */
    const trimmed = source.replace(/\s+$/, '')
    const block = 'minimumReleaseAgeExclude:' + eol + '  - ' + name + '@' + version + eol
    return { ok: true, text: trimmed.length === 0 ? block : trimmed + eol + eol + block, changed: true, reason: null }
  }

  const items = parseInlineValue(found[1]).concat(parseExcludeBlock(found[2]))
  const byName = new Map()
  const order = []
  for (const item of items) {
    if (item.kind !== 'entry') continue
    const groupName = nameOfSelector(item.selector)
    if (byName.has(groupName) !== true) { byName.set(groupName, []); order.push(groupName) }
    byName.get(groupName).push(item.selector)
  }

  const mine = byName.get(name) ?? []
  const versions = mine.flatMap((selector) => versionOfSelector(selector).split('||').map((one) => one.trim())).filter((one) => one.length > 0)
  if (versions.includes(version)) {
    /* 已经有这个版本：若只有一条规则，什么都不用改 */
    if (mine.length === 1) return { ok: true, text: source, changed: false, reason: null }
    /* 有多条我们的规则：合并成一条，避免 pnpm 只认第一条导致我们这条被忽略 */
  }
  if (byName.has(name) !== true) order.push(name)
  if (byName.has(name) !== true) byName.set(name, [])
  byName.get(name).push(name + '@' + version)

  /* 重排这个块：每个包名一条，位置取它首次出现的地方；注释原样保留在最前。 */
  const comments = items.filter((item) => item.kind === 'comment')
  const lines = []
  for (const item of comments) lines.push(item.line)
  for (const groupName of order) {
    const selectors = byName.get(groupName) ?? []
    const merged = unionSelectors(selectors)
    /* pnpm 把同名的多条并成一条；只有一个版本时保持 `name@version` 的朴素写法 */
    const selector = merged.length === 0 ? groupName : groupName + '@' + merged
    /* 以 @ 开头的标量在 YAML 里非法，作用域包要加引号 —— pnpm 自己也是这么写的 */
    lines.push('  - ' + (selector.startsWith('@') || selector.includes(' || ') ? "'" + selector.replace(/'/g, "''") + "'" : selector))
  }

  const blockText = 'minimumReleaseAgeExclude:' + eol + lines.join(eol) + eol
  const rewritten = source.replace(blockRe, () => blockText)
  return { ok: true, text: rewritten, changed: rewritten !== source || versions.includes(version) !== true, reason: null }
}

/**
 * 从插件目录往上找到 profile 目录（含 `pnpm-workspace.yaml` 的那一层）。
 *
 * 不猜固定层数：pnpm 的 hoisted 布局是 `<profile>/node_modules/<包名>`，
 * isolated 布局会经过 `.pnpm/<包名>@<版本>/node_modules/<包名>`，
 * 两种都能靠「向上找第一个带 pnpm-workspace.yaml 的目录」覆盖。
 *
 * @param {string} startDir 起点（一般是本插件的包根目录）
 * @param {number} [maxLevels] 最多往上找几层
 * @returns {string|null}
 */
export function findProfileDir(startDir, maxLevels = 6) {
  let current = resolve(startDir)
  for (let level = 0; level < maxLevels; level += 1) {
    try {
      if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    } catch (error) {
      return null
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return null
}

/**
 * 把本插件的目标版本写进 profile 的 `minimumReleaseAgeExclude`。
 *
 * 尽力而为：文件不存在、读不出来、写不进去都返回结构化失败，不抛异常。
 * 调用方即使在失败时也应当继续安装 —— profile 没显式设置该策略时，
 * pnpm 自己会自动豁免精确版本，安装本就能成。
 *
 * @param {string} profileDir
 * @param {string} version
 * @param {{name?: string}} [options]
 * @returns {{ok: boolean, changed: boolean, reason: string|null, path: string|null}}
 */
export function ensureReleaseAgeExclude(profileDir, version, options = {}) {
  const name = options.name === undefined ? SELF_NAME : options.name
  if (typeof profileDir !== 'string' || profileDir.length === 0) return { ok: false, changed: false, reason: 'no-profile-dir', path: null }
  if (VERSION_PATTERN.test(String(version)) !== true) return { ok: false, changed: false, reason: 'bad-version', path: null }

  const file = join(profileDir, 'pnpm-workspace.yaml')
  let original
  try {
    original = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, changed: false, reason: 'unreadable', path: file }
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const merged = mergeExcludeIntoYaml(original, name, String(version), eol)
  if (merged.ok !== true) return { ok: false, changed: false, reason: merged.reason, path: file }
  if (merged.changed !== true) return { ok: true, changed: false, reason: null, path: file }

  try {
    writeFileSync(file, merged.text, 'utf8')
  } catch (error) {
    return { ok: false, changed: false, reason: 'unwritable', path: file }
  }
  return { ok: true, changed: true, reason: null, path: file }
}
