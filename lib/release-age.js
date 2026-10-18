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
 * 本插件在豁免列表里**最多保留几个版本**。
 *
 * 为什么要裁：早先的实现是只追加不清理，每更新一次就往同一条规则里多塞一个版本，
 * 于是磁盘上长成 `2.0.0 || 2.0.1 || 2.1.0 || 2.1.1 || 2.1.2 || …`。它不会让安装失败
 * （pnpm 认 `||` 并集），但有两个实际坏处：
 *   · 规则无限变长，用户看不懂这一行在干什么；
 *   · 更要紧的是当时还只保留**最早那条**，一旦某次真的写成两条同名规则，
 *     pnpm 只认第一条 —— 新版本会被 24 小时发布年龄挡下。
 *
 * 保留 2 个（本次目标 + 上一次）而不是只留 1 个：用户升级后发现新版有问题，
 * 想退回上一版时，上一版仍在豁免里，回滚不会被发布年龄策略拦。
 * 更老的版本没有再回滚的现实意义（跨大版本回滚本就要手工处理配置/台账）。
 */
export const MAX_EXEMPT_VERSIONS = 2;

/**
 * 从一堆版本号里挑出该保留的：**目标版本必留**，再按出现顺序留最近的若干个。
 *
 * 不假设输入是升序（`||` 里的顺序是历史写入顺序，早期实现还可能乱序），
 * 所以这里按**语义版本**排序后取最大的几个 —— 对于「最近」这个语义，
 * 版本号大小比写入顺序更可靠。
 *
 * @param {string[]} versions 已有的版本号（可能乱序、可能重复）
 * @param {string} target 本次要放行的版本
 * @param {number} [keep] 最多保留几个
 * @returns {string[]} 要保留的版本；目标版本排在最后（书写顺序：旧 → 新）
 */
export function keepRecentVersions(versions, target, keep = MAX_EXEMPT_VERSIONS) {
  const all = []
  const push = (one) => {
    const text = String(one).trim()
    if (text.length > 0 && all.includes(text) !== true) all.push(text)
  }
  versions.forEach(push)
  push(target)
  const limit = keep > 0 ? keep : 1
  if (all.length <= limit) return all
  /* 语义版本比较：把 x.y.z(-pre) 拆成数字段；解析不出数字的（理论上不会有，
     ensureReleaseAgeExclude 已校验过版本形态）当作 0 处理，排在最后 */
  const keyOf = (one) => String(one).split('-')[0].split('.').map((part) => Number(part) || 0)
  const sorted = all.slice().sort((a, b) => {
    const ka = keyOf(a)
    const kb = keyOf(b)
    for (let i = 0; i < 3; i += 1) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i]
    }
    return 0
  })
  /* 从最大的往下取 limit 个，再按升序写回去（读起来自然是旧 → 新） */
  const picked = sorted.slice(Math.max(0, sorted.length - limit))
  /* 目标版本必须在里面 —— 极端情况下（目标版本号小于已保留的那些）也要保住它 */
  if (picked.includes(target) !== true) {
    picked.sort((a, b) => {
      const ka = keyOf(a)
      const kb = keyOf(b)
      for (let i = 0; i < 3; i += 1) {
        if (ka[i] !== kb[i]) return ka[i] - kb[i]
      }
      return 0
    })
    picked.shift()
    picked.push(target)
  }
  return picked.filter((one) => one.length > 0)
}

/** 去掉包裹标量的引号（成对才剥，与 parseExcludeBlock 同规则）。 */
function unquoteScalar(value) {
  const text = String(value).trim()
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) return text.slice(1, -1).replace(/''/g, "'")
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) return text.slice(1, -1)
  return text
}

/** 找 flow 数组的闭合 `]`（考虑多行与嵌套）。找不到返回 -1。 */
function findCloseBracket(text) {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '[') depth += 1
    else if (text[i] === ']') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 一行里 `[` 与 `]` 的数量差（用于判断 flow 数组是否还没闭合）。 */
function bracketDepth(text) {
  let depth = 0
  for (const ch of String(text)) {
    if (ch === '[') depth += 1
    else if (ch === ']') depth -= 1
  }
  return depth
}

/**
 * 解析 `minimumReleaseAgeExclude:` **写在同行**的值（可能跨多行）。
 *
 * 这个键不只有「独占一行、下面挂列表」一种写法，pnpm 生态里同样常见：
 *   · flow 风格：`minimumReleaseAgeExclude: ["a@1.0.0"]`
 *   · 行尾注释：`minimumReleaseAgeExclude:  # 豁免表`
 *   · 空数组：  `minimumReleaseAgeExclude: []`
 *   · 跨行 flow：`minimumReleaseAgeExclude: [` / `  "a@1.0.0"` / `]`
 *   · 带引号的标量：`minimumReleaseAgeExclude: 'a@1.0.0'`
 * 任何一种没认出来，都会被当成「文件里没有这个键」而**追加出第二个同名键** ——
 * YAML 直接 `duplicated mapping key`、pnpm 拒绝启动，受害的是整个 profile。
 *
 * @param {string} raw 冒号之后到该键结束（含跨行）的原始文本
 * @returns {Array<object>} 与 parseExcludeBlock 同形状的条目
 */
function parseInlineValue(raw) {
  const text = String(raw)
  const firstLine = text.split(/\r?\n/)[0].trim()
  if (firstLine.length === 0) return []
  /* 整个值是注释：保留成注释条目，重排时统一放到块首 */
  if (firstLine.startsWith('#')) return [{ kind: 'comment', line: '  ' + firstLine }]

  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    /* 先定位闭合括号再取内部 —— 这样 `["a"] # 说明` 的注释、以及值里带 `#` 的
       字符串（如 `["a # b"]`）都不会被误当成行尾注释切掉。 */
    const close = findCloseBracket(trimmed)
    const inner = (close === -1 ? trimmed.slice(1) : trimmed.slice(1, close)).trim()
    if (inner.length === 0) return []
    const out = []
    for (const one of inner.split(',')) {
      const selector = unquoteScalar(one)
      if (selector.length > 0) out.push({ kind: 'entry', line: '  - ' + selector, selector })
    }
    return out
  }

  /* 标量：同样要剥引号。不剥的话 `'dsh-desktop-statusbar@2.1.1'` 会被当成
     包名带前引号的另一条规则 —— 归并失效、我们这条被追加成第二条，且不幂等。 */
  const selector = unquoteScalar(trimmed)
  if (selector.length === 0) return []
  return [{ kind: 'entry', line: '  - ' + selector, selector }]
}

/**
 * 定位 `minimumReleaseAgeExclude:` 这个键，返回它的同行值、下方块正文与整段在原文里的位置。
 *
 * 为什么要手写扫描而不是一条正则：这个键的写法太多，正则很难同时覆盖
 *   · 键独占一行、下面挂列表（块风格）
 *   · 键与值同行：flow 数组 `["a@1.0.0"]`、空数组 `[]`、行尾注释 `# 表`
 *   · **跨行 flow**：`[` 之后换行、几行之后才是 `]`
 *   · 标量写成带引号 `'a@1.0.0'`
 * 而且还有两个容易漏的输入形态（都实测写出过重复键）：
 *   · **文件末行没有换行符** —— 原先的正则要求键行后必须跟 `\n`，匹配失败就被
 *     当成「文件里没有这个键」，于是追加出第二个同名键 → YAML `duplicated mapping key`
 *     → pnpm 拒绝加载整个 profile。找出原因很难，因为同一个输入加个尾换行就正常。
 *   · **首字节是 BOM** —— `^` 在 m 模式下不跨过 BOM，键在首行时同样匹配失败。
 *     Windows 编辑器给 YAML 加 BOM 很常见。
 * 手写扫描对这两种天然免疫，也更好读。
 *
 * @param {string} source 文件全文
 * @returns {{inline: string, block: string, start: number, end: number}|null}
 */
function locateExcludeBlock(source) {
  const KEY = 'minimumReleaseAgeExclude:'
  /* 逐行定位键。行首允许 BOM（只在第一行可能），也允许前导空白（YAML 里顶层键通常顶格，
     但缩进写法不该因此漏掉）。 */
  let cursor = 0
  let lineStart = 0
  while (lineStart <= source.length) {
    const nl = source.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? source.length : nl
    const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, '')
    const line = lineStart === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine
    if (line.trimStart().startsWith(KEY)) {
      const afterKey = line.trimStart().slice(KEY.length)
      let inline = afterKey
      let scanFrom = nl === -1 ? source.length : nl + 1
      /* 同行值是未闭合的 flow 数组：继续吃后续行，直到括号配平 */
      if (inline.trim().startsWith('[') && bracketDepth(inline) > 0) {
        while (scanFrom < source.length && bracketDepth(inline) > 0) {
          const nextNl = source.indexOf('\n', scanFrom)
          const nextEnd = nextNl === -1 ? source.length : nextNl
          inline += '\n' + source.slice(scanFrom, nextEnd).replace(/\r$/, '')
          scanFrom = nextNl === -1 ? source.length : nextNl + 1
        }
      }
      /* 下方块：连续的「- 条目」或注释行；遇到别的键或空行结束。
         条目允许零缩进（`- a@1.0.0` 顶格在 YAML 里是合法的）。 */
      let blockEnd = scanFrom
      for (;;) {
        if (blockEnd >= source.length) break
        const bNl = source.indexOf('\n', blockEnd)
        const bEnd = bNl === -1 ? source.length : bNl
        const bLine = source.slice(blockEnd, bEnd).replace(/\r$/, '')
        const trimmed = bLine.trim()
        if (trimmed.length === 0) break
        if (/^[ \t]*-/.test(bLine) || /^[ \t]*#/.test(bLine)) {
          blockEnd = bNl === -1 ? source.length : bNl + 1
          continue
        }
        break
      }
      return {
        inline,
        block: source.slice(scanFrom, blockEnd),
        start: lineStart,
        end: blockEnd,
      }
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return null
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
  /* ------------------------------------------------------------------ 安全阀
     这个函数改的是**共享文件** `pnpm-workspace.yaml`：写坏了不只是本插件装不上，
     整个 profile 里所有插件都起不来（YAML `duplicated mapping key` → pnpm 拒绝解析）。

     最坏的一种输入：文件里**已经有两个** `minimumReleaseAgeExclude:` 键
     （历史遗留，或两个插件各自追加过）。`locateExcludeBlock` 只定位第一个块，
     替换后第二个原样留着 —— 输出仍是两个同名键，照样把 profile 写坏。

     这种状态下唯一安全的动作是**什么都不做**：返回 ok:false，调用方
     （ensureReleaseAgeExclude）会把它转成结构化失败，安装流程继续走 ——
     profile 没显式设这个策略时 pnpm 自己会豁免精确版本，安装本来就能成。
     宁可这次豁免没生效，也绝不能把一个本来还能用的 profile 写坏。 */
  const keyCount = (source.match(/^[ \t]*minimumReleaseAgeExclude:/gm) || []).length
  if (keyCount > 1) {
    return { ok: false, text: source, changed: false, reason: 'duplicate-key' }
  }
  const found = locateExcludeBlock(source)

  if (found === null) {
    /* 文件里还没有这个键：追加一个块。缩进用两个空格，与 pnpm 自己写出来的样式一致。 */
    const trimmed = source.replace(/\s+$/, '')
    const block = 'minimumReleaseAgeExclude:' + eol + '  - ' + name + '@' + version + eol
    return { ok: true, text: trimmed.length === 0 ? block : trimmed + eol + eol + block, changed: true, reason: null }
  }

  const items = parseInlineValue(found.inline).concat(parseExcludeBlock(found.block))
  const byName = new Map()
  const order = []
  /* 每个包名对应的一组「原始行」：块风格解析出来的条目带着逐字节原样的 `line`，
     flow 风格的条目没有（它本来就要从 flow 重写成块），记 null。
     别人的规则能用原始行时**必须原样写回** —— 早先每个条目都重新生成一遍，
     结果 `dshmarket@1.66.22 || 1.66.32` 被加上引号变成 `'dshmarket@1.66.22 || 1.66.32'`。
     语义虽然等价，但那是**别人的配置**，我们没有任何理由去改写它（用户的 diff 会脏）。 */
  const rawLines = new Map()
  for (const item of items) {
    if (item.kind !== 'entry') continue
    const groupName = nameOfSelector(item.selector)
    if (byName.has(groupName) !== true) {
      byName.set(groupName, [])
      rawLines.set(groupName, [])
      order.push(groupName)
    }
    byName.get(groupName).push(item.selector)
    rawLines.get(groupName).push(typeof item.line === 'string' ? item.line : null)
  }

  const mine = byName.get(name) ?? []
  const versions = mine.flatMap((selector) => versionOfSelector(selector).split('||').map((one) => one.trim())).filter((one) => one.length > 0)
  /* 裸包名（`- dsh-desktop-statusbar`，无 @版本）在 pnpm 里的语义是**放行该包所有版本**。
     这种情况什么都不用做：它已经比我们要的更宽，收窄成 `名字@目标版本` 反而是倒退 ——
     会把用户原本"整包放行"的意图静默改成"只放行这一个版本"。原样返回。
     （实测缺陷：早先无条件重排，用户写的裸名被改成 `名字@2.1.2`。） */
  if (mine.length === 1 && versionOfSelector(mine[0]) === '') {
    return { ok: true, text: source, changed: false, reason: null }
  }
  /* 本插件的规则要**裁剪**：只留目标版本 + 最近一个（见 MAX_EXEMPT_VERSIONS）。
     早先只追加不清理，历史版本会永久累积成一条越来越长的 `||` 列表。 */
  const keptVersions = keepRecentVersions(versions, version)
  const keptSelector = name + '@' + keptVersions.join(' || ')
  if (mine.length === 1) {
    const already = versionOfSelector(mine[0]).split('||').map((one) => one.trim()).filter((one) => one.length > 0)
    /* 目标版本已在、且集合没变（不需要裁剪）→ 一个字节都不动，保持幂等 */
    if (already.length === keptVersions.length && keptVersions.every((one) => already.includes(one))) {
      return { ok: true, text: source, changed: false, reason: null }
    }
  }
  /* 用裁剪后的版本集合替换该包名的条目（不是追加） */
  byName.set(name, [keptSelector])
  /* 我们这条要**重新生成**（没有可原样复用的原始行），所以原始行记 null */
  rawLines.set(name, [null])
  if (order.indexOf(name) === -1) order.push(name)

  /* 重排这个块：每个包名一条，位置取它首次出现的地方；注释原样保留在最前。 */
  const comments = items.filter((item) => item.kind === 'comment')
  const lines = []
  for (const item of comments) lines.push(item.line)
  for (const groupName of order) {
    const selectors = byName.get(groupName) ?? []
    const raws = rawLines.get(groupName) ?? []
    /* 我们自己的那条：用裁剪后的版本集合重新生成 */
    if (groupName === name) {
      const merged = versionOfSelector(keptSelector)
      const selector = merged.length === 0 ? groupName : groupName + '@' + merged
      lines.push('  - ' + (selector.startsWith('@') || selector.includes(' || ') ? "'" + selector.replace(/'/g, "''") + "'" : selector))
      continue
    }
    /* 别人的规则：只要它还是**一条且原始行可用**，就原样写回。
       唯一例外是缩进 —— 重排后整个块统一用两空格缩进，零缩进的旧条目必须跟着对齐，
       否则同一个序列里混着两种缩进，YAML 直接解析失败（实测过）。
       所以这里只动**前导空白**，`-` 之后的正文（含引号、`||`、大小写）一个字节都不改。 */
    if (raws.length === 1 && typeof raws[0] === 'string' && raws[0].length > 0) {
      const body = raws[0].replace(/^[ \t]*/, '')
      lines.push('  ' + body)
      continue
    }
    const merged = unionSelectors(selectors)
    /* pnpm 把同名的多条并成一条；只有一个版本时保持 `name@version` 的朴素写法 */
    const selector = merged.length === 0 ? groupName : groupName + '@' + merged
    /* 以 @ 开头的标量在 YAML 里非法，作用域包要加引号 —— pnpm 自己也是这么写的 */
    lines.push('  - ' + (selector.startsWith('@') || selector.includes(' || ') ? "'" + selector.replace(/'/g, "''") + "'" : selector))
  }

  /* 用定位到的起止下标替换整段 —— 不用正则 replace，避免正则再次因为写法差异漏配。 */
  const blockText = 'minimumReleaseAgeExclude:' + eol + lines.join(eol) + eol
  const rewritten = source.slice(0, found.start) + blockText + source.slice(found.end)
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
