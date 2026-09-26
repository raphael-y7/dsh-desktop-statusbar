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

/** HTML → 纯文本：去脚本、样式与标签，解常见实体。 */
export function holidayHtmlToText(html) {
  return String(html === null || html === undefined ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
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
    .replace(/<[^>]+>/g, ' ')
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
