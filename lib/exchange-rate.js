/**
 * 每日汇率：北京时间每天 9:00 之后拉一次「1 USD = ? CNY」，缓存到本地。
 *
 * 为什么需要它：余额色条要把两种货币的余额折成同一口径算比例，底栏「本轮 / 总计」
 * 也要一个合并数字。以前这个汇率是**从内置价格表反算出来的常量**（client.js 的
 * REFERENCE_RATE），它只反映写代码那天的行情，之后一直不变。
 *
 * 为什么不用银联：银联没有面向公众的免费 API，只有网页查询页，抓页面随时会坏。
 * 用户确认改用公开汇率源（open.er-api.com），它每天 UTC 00:00 左右更新一次，
 * 换算成北京时间约 08:00，正好在 9:00 之前落地。
 *
 * 为什么失败要静默：汇率是显示用的辅助数据，拉不到不该打扰用户。
 * 拉不到就用上次成功的那一份；从没成功过就返回 null，调用方退回内置常量。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 汇率接口：基准货币是 CNY，返回里 rates.USD 是「1 CNY = ? USD」。 */
const RATE_URL = 'https://open.er-api.com/v6/latest/CNY'
/** 缓存文件路径（与台账同目录，都在 dsh-status-bar 下）。 */
const CACHE_FILE_NAME = 'exchange-rate.json'
/** 拉取超时：汇率是锦上添花的东西，不该拖住任何主流程。 */
const FETCH_TIMEOUT_MS = 8000

/** 缓存目录：与 usage-ledger.json 同一个 dsh-status-bar 目录。 */
function cacheDir() {
  return join(homedir(), '.dsh', 'dsh-status-bar')
}

/** 缓存文件的绝对路径。 */
export function cacheFilePath() {
  return join(cacheDir(), CACHE_FILE_NAME)
}

/**
 * 读缓存的汇率。
 *
 * 返回 `{ rate, fetchedAt, source }`；文件不存在 / 坏数据 / rate 不合理都返回 null。
 * `rate` 的含义固定是「1 USD = rate CNY」，与 client.js 里 REFERENCE_RATE 同向，
 * 调用方可以直接替换，不需要再做方向换算。
 *
 * @returns {{rate: number, fetchedAt: number, source: string}|null}
 */
export function readCachedRate() {
  try {
    const file = cacheFilePath()
    if (existsSync(file) !== true) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const rate = Number(parsed.rate)
    if (Number.isFinite(rate) !== true || rate <= 0) return null
    /* 合理性下限：人民币兑美元历史上没到过 1:1 以下，超出这个范围说明数据坏了，
       宁可退回内置常量也不要拿一个荒谬的汇率去折算金额。 */
    if (rate < 3 || rate > 20) return null
    return {
      rate: rate,
      fetchedAt: Number.isFinite(Number(parsed.fetchedAt)) ? Number(parsed.fetchedAt) : 0,
      source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    }
  } catch (error) {
    return null
  }
}

/**
 * 把接口返回换算成「1 USD = ? CNY」。
 *
 * 接口给的是 `base_code: CNY` + `rates.USD`，即「1 CNY = X USD」，
 * 所以取倒数。字段缺失 / 非数字 / 不合理都返回 null。
 *
 * @param {unknown} payload
 * @returns {number|null}
 */
export function rateFromPayload(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const body = payload
  if (body.result !== undefined && body.result !== 'success') return null
  if (body.base_code !== undefined && body.base_code !== 'CNY') return null
  const rates = body.rates
  if (rates === null || typeof rates !== 'object') return null
  const usdPerCny = Number(rates.USD)
  if (Number.isFinite(usdPerCny) !== true || usdPerCny <= 0) return null
  const cnyPerUsd = 1 / usdPerCny
  if (cnyPerUsd < 3 || cnyPerUsd > 20) return null
  /* 保留 4 位：再多没有意义，还会让缓存文件里的数字看起来可疑。 */
  return Math.round(cnyPerUsd * 10000) / 10000
}

/**
 * 拉一次汇率并写缓存。**任何异常都静默**，只以结构化结果返回。
 *
 * @param {{logger?: Function, fetchImpl?: Function, now?: number}} [options]
 * @returns {Promise<{ok: boolean, rate: number|null, fetchedAt: number, reason: string|null}>}
 */
export async function fetchAndCacheRate(options) {
  const opts = options === null || typeof options !== 'object' ? {} : options
  const log = typeof opts.logger === 'function' ? opts.logger : () => {}
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch
  try {
    const response = await doFetch(RATE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (response === null || typeof response !== 'object' || response.ok !== true) {
      return { ok: false, rate: null, fetchedAt: now, reason: 'http-' + String(response === null || response === undefined ? 'unknown' : response.status) }
    }
    const payload = await response.json()
    const rate = rateFromPayload(payload)
    if (rate === null) {
      return { ok: false, rate: null, fetchedAt: now, reason: 'bad-payload' }
    }
    try {
      const dir = cacheDir()
      if (existsSync(dir) !== true) mkdirSync(dir, { recursive: true })
      writeFileSync(cacheFilePath(), JSON.stringify({
        rate: rate,
        fetchedAt: now,
        source: 'open.er-api.com',
      }), 'utf8')
    } catch (error) {
      /* 写不进缓存不算失败：这一拍拿到了汇率，调用方照样能用 */
      log('exchange-rate: 缓存写入失败 ' + String(error === null || error === undefined ? 'unknown' : error.message))
    }
    log('exchange-rate: 1 USD = ' + String(rate) + ' CNY')
    return { ok: true, rate: rate, fetchedAt: now, reason: null }
  } catch (error) {
    return {
      ok: false,
      rate: null,
      fetchedAt: now,
      reason: 'request-failed',
    }
  }
}

/**
 * 今天（本地时区）09:00 的时间戳。
 *
 * 用**本地时区**而不是硬编码 UTC+8：用户机器如果不在东八区，按本地 9 点拉也是对的
 * —— 它要的是「今天开始上班之后拿一份当天的汇率」，不是「北京时间 9 点整」。
 *
 * @param {number} now 毫秒时间戳
 * @returns {number}
 */
export function nineAmOf(now) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now())
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0, 0, 0).getTime()
}

/**
 * 此刻该不该去拉汇率。
 *
 * 判据：缓存为空，或者缓存的拉取时间早于**今天 9:00**。
 * 于是 9:00 之前一次都不拉，9:00 之后第一拍拉一次，当天再也不会重复。
 *
 * @param {{rate: number, fetchedAt: number}|null} cached
 * @param {number} now
 * @returns {boolean}
 */
export function shouldRefresh(cached, now) {
  if (cached === null || cached === undefined) return true
  const fetchedAt = Number(cached.fetchedAt)
  if (Number.isFinite(fetchedAt) !== true) return true
  return fetchedAt < nineAmOf(now)
}

/**
 * 当前该用的汇率（「1 USD = ? CNY」）。
 *
 * 有缓存用缓存，没缓存返回 null —— 调用方据此退回 client.js 的 REFERENCE_RATE。
 *
 * @returns {number|null}
 */
export function currentRate() {
  const cached = readCachedRate()
  return cached === null ? null : cached.rate
}
