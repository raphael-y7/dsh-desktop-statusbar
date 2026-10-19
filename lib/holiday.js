/**
 * 节假日日历：把国务院办公厅放假通知的正文解析成"哪些放假日落在周一至周五"。
 *
 * 只在 host 侧用：客户端拿不到跨域页面，由 host 抓取 + 解析后把日期数组交给客户端。
 *
 * 通知里的四种写法（2023-2026 四年原文都覆盖到了）：
 *   一、元旦：1月1日（周四）至3日（周六）放假调休，共3天。
 *   一、元旦：1月1日放假，与周末连休。
 *   二、春节：1月28日（农历除夕、周二）至2月4日（农历正月初七、周二）放假调休，共8天。
 *   一、元旦：2022年12月31日至2023年1月2日放假调休，共3天。
 *
 * 只返回周一至周五的放假日 —— 周末本来就整天空闲，调休上班的周末也一样空闲，列进来没用。
 */

/** 通知里的日期：年份与月份都可以省略，例 `2022年12月31日` / `1月2日` / `至6日` */
const NOTICE_DATE = /(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日/g
const DAY_MS = 86400000
/** 一段假期最长不会超过这个天数，防正则意外把超长区间展开 */
const MAX_RANGE_DAYS = 40
/** HTML 解析的体积上限（字符）：真实通知页 100~300KB，2MB 已经非常宽松。
 *  超过就只看前 2MB —— 宁可解析不全，也不能让 host 主线程卡住（见 holidayHtmlToText）。 */
const HOLIDAY_HTML_MAX = 2 * 1024 * 1024

/**
 * 线性切掉成对标签里的整段内容（`<script ...>...</script>` 这类）。
 * 用 indexOf 前进而不是懒惰量词：找不到闭合标签时直接放弃剩余部分，
 * 复杂度严格 O(n)；`/<script[\s\S]*?<\/script>/gi` 在缺闭合时会从每个 `<` 往后扫到文末，
 * 实测 40 万个未闭合 `<script>` 要 6 秒（卡死 host 事件循环）。
 */
function stripBlocks(text, tag) {
  const open = '<' + tag
  const close = '</' + tag
  const lower = text.toLowerCase()
  let out = ''
  let at = 0
  for (;;) {
    const start = lower.indexOf(open, at)
    if (start === -1) return out + text.slice(at)
    out += text.slice(at, start)
    const end = lower.indexOf(close, start)
    if (end === -1) return out   /* 没有闭合：整段丢弃，不再往后扫 */
    const gt = text.indexOf('>', end)
    if (gt === -1) return out
    at = gt + 1
  }
}

/** HTML → 纯文本：去脚本、样式与标签，解常见实体。
 *
 * 这段处理的是**外部网页**（国务院通知），内容不受我们控制，所以两处做了防御：
 *   ① 先按长度截断，避免超大文档把主线程占满；
 *   ② `<[^<>]+>` 而不是 `<[^>]+>` —— 后者不排除 `<`，大量孤立 `<` 时会反复跨越大段文本，
 *      实测 20 万字符要 12 秒。 */
export function holidayHtmlToText(html) {
  const raw = String(html === null || html === undefined ? '' : html).slice(0, HOLIDAY_HTML_MAX)
  return stripBlocks(stripBlocks(raw, 'script'), 'style')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^<>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

const pad = (n) => (n < 10 ? '0' + String(n) : String(n))

/**
 * 从通知正文里取出该年的放假日（只留周一至周五，升序）。
 * @param {string} text 通知正文，纯文本或 HTML 都行（HTML 会自动剥标签）
 * @param {number} year 通知对应的年份
 * @returns {string[]} `YYYY-MM-DD` 数组
 */
export function parseHolidayNotice(text, year) {
  const days = new Set()
  const flat = String(text === null || text === undefined ? '' : text)
    .slice(0, HOLIDAY_HTML_MAX)
    /* `[^<>]` 而不是 `[^>]`：理由同 holidayHtmlToText —— 大量孤立 `<` 时会退化 */
    .replace(/<[^<>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  /* 只认含"放假"的句子；含"上班"的句子是调休上班日，不能算进空闲 */
  flat.split(/[。；;\n]/).forEach((sentence) => {
    if (sentence.indexOf('放假') === -1 || sentence.indexOf('上班') !== -1) return
    NOTICE_DATE.lastIndex = 0
    const hits = []
    let hit = null
    while ((hit = NOTICE_DATE.exec(sentence)) !== null) {
      hits.push({
        year: hit[1] === undefined ? null : Number(hit[1]),
        month: hit[2] === undefined ? null : Number(hit[2]),
        day: Number(hit[3]),
      })
    }
    if (hits.length === 0) return
    /* 句子里有"至"就是一段区间（取前两个日期当起止）；否则每个日期各算一天 */
    const ranges = sentence.indexOf('至') !== -1 && hits.length >= 2
      ? [[hits[0], hits[1]]]
      : hits.map((one) => [one, one])
    ranges.forEach((pair) => {
      const from = pair[0]
      const to = pair[1]
      /* 区间终点常省略月份（"4月4日至6日"），用起点的月份补上；孤立的"6日"没法定位，跳过 */
      const startMonth = from.month
      if (startMonth === null) return
      const endMonth = to.month === null ? startMonth : to.month
      const startYear = from.year === null ? year : from.year
      let endYear = to.year === null ? startYear : to.year
      /* 终点月份比起点小 = 跨年，例：12月31日至1月2日 */
      if (to.year === null && endMonth < startMonth) endYear = startYear + 1
      const last = Date.UTC(endYear, endMonth - 1, to.day)
      let cursor = Date.UTC(startYear, startMonth - 1, from.day)
      for (let i = 0; cursor <= last && i < MAX_RANGE_DAYS; i += 1, cursor += DAY_MS) {
        const at = new Date(cursor)
        if (at.getUTCFullYear() !== year) continue
        const weekday = at.getUTCDay()
        if (weekday === 0 || weekday === 6) continue
        days.add(String(at.getUTCFullYear()) + '-' + pad(at.getUTCMonth() + 1) + '-' + pad(at.getUTCDate()))
      }
    })
  })
  return Array.from(days).sort()
}
