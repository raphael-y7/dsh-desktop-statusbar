/**
 * Magpie 余额接入的回归测试。
 *
 * 覆盖两层：
 *   ① 纯解析（lib/balance-api.js 的 magpie* 函数）—— 用**生产同一份实现**跑，不另写旁路；
 *   ② 静态接线（lib/index.js / lib/client.js）—— 防止后续把 magpie 分支又改回横杠、或漏传 session；
 *   ③ 实时联调（本机 127.0.0.1:3425 可用时）—— 直接打网关，确认 group/deepseek-flash
 *      解析出的不再是"DEEPSEEK_API_KEY 的 ¥75.87"，而是 workbuddy 的剩余积分。
 *
 * 用法：node tests/verify-magpie-quota.js（退出码 0 = 通过；网关没开时实时段自动跳过）
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  adaptersFor,
  magpieModelProvider, magpieModelPrefix, magpieModelQuotaProvider, magpieBalanceOf,
  magpieAccountFromRoute, magpieParseMoney, magpieQuotaEntries,
} from '../lib/balance-api.js'
import {
  queryBalanceForTest,
  providerConfigFromSettings,
  parseGenericRelayBalance,
  parseGenericRelayBalanceAny,
  queryGenericRelayBalance,
} from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 隔离真实 ~/.dsh：否则本机 relay-balance.json 里遗留的同名平台档案会先于
   Magpie providerHint 命中，测试结果随环境漂移。这里故意放一条 orbi 平台档案，
   验证「没有明确平台通道（provider 未在模型页配置）时不能拦截 Magpie」。 */
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'dsb-magpie-quota-'))
process.env.DSH_HOME = TEMP_HOME
mkdirSync(join(TEMP_HOME, 'dsh-status-bar'), { recursive: true })
writeFileSync(join(TEMP_HOME, 'dsh-status-bar', 'relay-balance.json'), JSON.stringify({
  version: 2,
  channels: [{
    channelKey: 'orbi',
    endpoint: 'https://orbi.invalid/api/user/self',
    tokenHeader: 'authorization',
    userIdHeader: 'New-Api-User',
    tokenPrefix: 'Bearer ',
    balancePath: 'data.quota',
    currency: 'CNY',
    feeMultiplier: 1,
    balanceDivisor: 500000,
    headerNames: [],
  }],
}), 'utf8')
process.on('exit', () => { try { rmSync(TEMP_HOME, { recursive: true, force: true }) } catch (error) { /* best effort */ } })
let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

/* ---------------------------------------------------------------- ① 纯解析 */

/* 与真实上游同形的两个 workbuddy 账号：amount 是**已用**数量（实测语义）。 */
const QUOTAS = {
  data: [
    {
      provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free plan', user: 'X.Y.z',
      windows: [
        { name: 'Credits', used: 0, remaining: 100, limit: 500, unit: 'credits', display: '0 / 500' },
        { name: 'Total credits', used: 40.15853399643979, remaining: 59.84146600356021, amount: 1917.56999833, limit: 4775, unit: 'credits', display: '1917.57 / 4775' },
        { name: 'deepseek-v4.1-flash tokens (est.)', used: 47.6, remaining: 52.4, amount: 95286499, limit: 200000000 },
      ],
    },
    {
      provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', plan: 'Free plan', user: 'Ash.',
      windows: [
        { name: 'Total credits', used: 33.15124994325001, remaining: 66.84875005674999, amount: 1326.04999773, limit: 4000, unit: 'credits', display: '1326.05 / 4000' },
      ],
    },
    { provider: 'zcode', name: 'ZCode', kind: 'subscription', plan: 'ZCode 1024 Dev Day', user: 'ejfyr763', windows: [], error: 'this account has no GLM Coding Plan' },
    { provider: 'orbis', name: 'orbis', kind: 'balance', windows: [], balance: '¥0.03', lastServedAt: '2026-11-03T13:39:44Z' },
  ],
}

check('amount 是已用数量：剩余 = limit - amount（不是直接拿 amount）', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'workbuddy', account: 'X.Y.z' })
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'credits')
  assert.equal(value.isCredits, true)
  assert.equal(value.currency, '')
  /* 4775 - 1917.56999833 = 2857.43000167 → 2,857.43 */
  assert.equal(value.total, '2,857.43')
  assert.equal(value.account, 'X.Y.z')
})

check('按账号精确匹配：Ash. 的剩余独立计算', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'workbuddy', account: 'Ash.' })
  assert.equal(value.ok, true)
  assert.equal(value.total, '2,673.95') /* 4000 - 1326.04999773 */
})

check('账号匹配不到时按池汇总，不报错也不显示错数', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'workbuddy', account: '不存在的账号' })
  assert.equal(value.ok, true)
  assert.equal(value.total, '5,531.38') /* 2857.43 + 2673.95 */
})

check('金额型（orbis ¥0.03）：币种/金额从 balance 串识别', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'orbis' })
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'money')
  assert.equal(value.currency, 'CNY')
  assert.equal(value.total, '0.03')
  assert.equal(value.toppedUp, '0.03')
})

check('selen 金额型（$1.97）：provider 名不在 quotas 前缀也能解析', () => {
  const value = magpieBalanceOf(
    { data: [{ provider: 'selen', kind: 'balance', windows: [], balance: '$1.97' }] },
    { provider: 'selen' },
  )
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'money')
  assert.equal(value.currency, 'USD')
  assert.equal(value.total, '1.97')
})

check('订阅账号带 error（ZCode）：如实失败，不显示 0', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'zcode' })
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'magpie-upstream-error')
})

check('provider 不在 quotas：magpie-provider-not-found', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'deepseek' })
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'magpie-provider-not-found')
})

check('rewards 覆盖所有账号（气泡里能看具体账号的具体余额）', () => {
  const value = magpieBalanceOf(QUOTAS, { provider: 'workbuddy', account: 'X.Y.z' })
  assert.equal(Array.isArray(value.rewards), true)
  assert.equal(value.rewards.length, 2)
  assert.ok(value.rewards[0].name.indexOf('X.Y.z') === 0)
})

check('models 的 owned_by 与模型前缀兜底', () => {
  const models = {
    data: [
      { id: 'group/deepseek-flash', owned_by: 'workbuddy' },
      { id: 'orbis/x', owned_by: 'orbis' },
      { id: 'selen/gpt-5.5', owned_by: 'selen' },
      { id: 'selen/gpt-6-astra', owned_by: 'selen' },
      { id: 'orbis/gpt-6-astra', owned_by: 'orbis' },
    ],
  }
  assert.equal(magpieModelProvider(models, 'group/deepseek-flash'), 'workbuddy')
  assert.equal(magpieModelProvider(models, 'missing'), null)
  assert.equal(magpieModelProvider(models, 'gpt-5.5'), 'selen') /* 唯一后缀 */
  assert.equal(magpieModelProvider(models, 'gpt-6-astra'), null) /* 多个 owner：不猜 */
  assert.equal(magpieModelPrefix('group/deepseek-flash'), 'group')
  assert.equal(magpieModelPrefix('nope'), null)
})

/* 订阅型配额：used/remaining 是百分比窗口（没有 unit=credits），必须按 percent 解析，不能当积分。 */
check('work/codex 订阅百分比窗口（5h/7d）解析为 percent，不是 credits', () => {
  const quotas = {
    data: [{
      provider: 'work/codex', name: 'codex', kind: 'subscription', user: 'u1',
      windows: [
        { name: '5 hours', used: 19, remaining: 81 },
        { name: '7 days', used: 45, remaining: 55 },
      ],
    }],
  }
  const value = magpieBalanceOf(quotas, { provider: 'work/codex' })
  assert.equal(value.ok, true)
  assert.equal(value.mode, 'percent')
  assert.equal(value.isPercent, true)
  assert.equal(value.isCredits, undefined, 'percent 不能标成积分')
  /* primary 优先「五小时」窗口：total = 5 hours 的已用 19% */
  assert.equal(value.total, '19.00%')
  assert.equal(value.currency, '', '百分比不带货币')
  /* 完整 windows 透传（供客户端画五小时/七天进度条） */
  assert.ok(Array.isArray(value.windows), 'percent 应带 windows 数组')
  assert.equal(value.windows.length, 2)
  assert.equal(value.windows[0].name, '5 hours')
  assert.equal(value.windows[0].used, 19)
  assert.equal(value.windows[0].remaining, 81)
  assert.equal(value.windows[1].name, '7 days')
  assert.equal(value.windows[1].used, 45)
})

check('percent 无五小时窗口时 primary = 合并后 used 最大的一类', () => {
  const quotas = {
    data: [{
      provider: 'p3', kind: 'subscription', user: 'u',
      windows: [
        { name: 'monthly', used: 10, remaining: 90 },
        { name: 'weekly', used: 45, remaining: 55 },
      ],
    }],
  }
  const value = magpieBalanceOf(quotas, { provider: 'p3' })
  assert.equal(value.mode, 'percent')
  assert.equal(value.total, '45.00%', '无五小时 → 合并后 used 最大的一类（weekly 45%）')
  assert.equal(value.windows.length, 2)
})

check('percent 多账号：5h/7d 各账号合并为综合百分比（不取单账号）', () => {
  const quotas = {
    data: [
      { provider: 'p5', kind: 'subscription', user: 'a',
        windows: [{ name: '5 hours', used: 20, remaining: 80 }, { name: '7 days', used: 30, remaining: 70 }] },
      { provider: 'p5', kind: 'subscription', user: 'b',
        windows: [{ name: '5 hours', used: 60, remaining: 40 }, { name: '7 days', used: 50, remaining: 50 }] },
    ],
  }
  const value = magpieBalanceOf(quotas, { provider: 'p5' })
  assert.equal(value.mode, 'percent')
  assert.equal(value.windows.length, 2)
  /* 无 limit ⇒ 按账号数等权平均：5h remaining (80+40)/2=60%，used (20+60)/2=40%；
     7d remaining (70+50)/2=60%，used (30+50)/2=40%。total = fiveHour 合并 used = 40%。 */
  assert.equal(value.windows[0].name, '5 hours')
  assert.equal(value.windows[0].remaining, 60, '5h 综合剩余 60%（不是单取任一账号 80/40）')
  assert.equal(value.windows[0].used, 40)
  assert.equal(value.windows[1].name, '7 days')
  assert.equal(value.windows[1].remaining, 60, '7d 综合剩余 60%')
  assert.equal(value.total, '40.00%', 'total 取 fiveHour 合并后的 used 40%')
  /* 每个合并窗口带 items（逐账号明细）：5h 两条，分别是 a 剩余 80、b 剩余 40 */
  const fiveItems = value.windows[0].items
  assert.ok(Array.isArray(fiveItems) && fiveItems.length === 2, '5h 窗口带 2 条账号明细')
  assert.deepEqual(fiveItems.map((one) => one.name), ['a', 'b'], '5h 明细账号名')
  assert.equal(fiveItems[0].remaining, 80, 'a 的 5h 剩余 80')
  assert.equal(fiveItems[1].remaining, 40, 'b 的 5h 剩余 40')
  /* 合并窗口带通用 key（建议修-3）：fiveHour / sevenDay，供客户端本地化优先使用。 */
  assert.equal(value.windows[0].key, 'fiveHour', '5h 合并窗口 key=fiveHour')
  assert.equal(value.windows[1].key, 'sevenDay', '7d 合并窗口 key=sevenDay')
  const sevenItems = value.windows[1].items
  assert.ok(Array.isArray(sevenItems) && sevenItems.length === 2, '7d 窗口带 2 条账号明细')
  assert.equal(sevenItems[1].remaining, 50, 'b 的 7d 剩余 50')
})

check('percent 多账号带 limit：按 limit 加权平均', () => {
  const quotas = {
    data: [
      { provider: 'p6', kind: 'subscription', user: 'a',
        windows: [{ name: '5 hours', used: 0, remaining: 100, limit: 100 }] },
      { provider: 'p6', kind: 'subscription', user: 'b',
        windows: [{ name: '5 hours', used: 50, remaining: 50, limit: 300 }] },
    ],
  }
  const value = magpieBalanceOf(quotas, { provider: 'p6' })
  /* limit 加权：remaining = (100*100 + 50*300)/(100+300) = (10000+15000)/400 = 62.5 */
  const win = value.windows[0]
  assert.ok(Math.abs(win.remaining - 62.5) < 1e-9, 'remaining 按 limit 加权 = 62.5，实际 ' + win.remaining)
  assert.ok(Math.abs(win.used - 37.5) < 1e-9, 'used 按 limit 加权 = 37.5')
  assert.equal(value.total, '37.50%')
})

check('percent 指定 account 也只汇总全部账号（与 WorkBuddy 统一口径）', () => {
  const quotas = {
    data: [
      { provider: 'p7', kind: 'subscription', user: 'a',
        windows: [{ name: '5 hours', used: 20, remaining: 80 }] },
      { provider: 'p7', kind: 'subscription', user: 'b',
        windows: [{ name: '5 hours', used: 60, remaining: 40 }] },
    ],
  }
  /* options.account='a'（模拟 Magpie route 指定账号）：percent 仍须汇总 a+b。 */
  const value = magpieBalanceOf(quotas, { provider: 'p7', account: 'a' })
  assert.equal(value.mode, 'percent')
  assert.equal(value.windows[0].remaining, 60, '5h 综合剩余 (80+40)/2=60%，不受 account=a 影响')
  assert.equal(value.total, '40.00%', 'total 取合并 used 40%')
  assert.equal(value.windows[0].items.length, 2, 'items 仍包含 a 和 b 两个账号')
  assert.deepEqual(value.windows[0].items.map((one) => one.name), ['a', 'b'])
})

check('percent 窗口：忽略 image-only 与文本占位窗口', () => {
  const quotas = {
    data: [{
      provider: 'p1', kind: 'subscription', user: 'u',
      windows: [
        { name: 'image gen', used: 80, remaining: 20 },
        { name: '5 hours', used: 12, remaining: 88 },
        { name: 'bad', used: 'x', remaining: null },
      ],
    }],
  }
  const value = magpieBalanceOf(quotas, { provider: 'p1' })
  assert.equal(value.mode, 'percent')
  assert.equal(value.total, '12.00%', 'image-only 与坏数据被忽略，取真正的时间窗口')
})

check('credits 窗口优先于 percent 窗口（有 unit=credits 时不按百分比）', () => {
  const quotas = {
    data: [{
      provider: 'p2', kind: 'subscription', user: 'u',
      windows: [
        { name: 'Credits', used: 5, remaining: 95, limit: 100, amount: 5, unit: 'credits' },
        { name: '5 hours', used: 12, remaining: 88 },
      ],
    }],
  }
  const value = magpieBalanceOf(quotas, { provider: 'p2' })
  assert.equal(value.mode, 'credits')
  assert.equal(value.isCredits, true)
  assert.equal(value.isPercent, undefined)
})

check('模型 work/codex/gpt-6-luna → quotas provider work/codex（通用最长前缀匹配）', () => {
  const quotas = { data: [
    { provider: 'work/codex', kind: 'subscription', windows: [{ name: '5 hours', used: 19, remaining: 81 }] },
    { provider: 'work', kind: 'subscription', windows: [] },
    { provider: 'other', kind: 'subscription', windows: [] },
  ] }
  /* owned_by 是 work，前缀只取第一段也是 work，都不是 quotas 里的完整 provider；
     最长前缀匹配应命中 work/codex。 */
  assert.equal(magpieModelProvider({ data: [{ id: 'work/codex/gpt-6-luna', owned_by: 'work' }] }, 'work/codex/gpt-6-luna'), 'work')
  assert.equal(magpieModelQuotaProvider(quotas, 'work/codex/gpt-6-luna'), 'work/codex')
  assert.equal(magpieModelQuotaProvider(quotas, 'nope/x'), null)
  assert.equal(magpieModelQuotaProvider(quotas, 'work/codex/gpt-6-luna/extra'), 'work/codex')
})

check('orbi 别名：magpieQuotaEntries 能命中 quotas 里的 orbis', () => {
  const quotas = { data: [{ provider: 'orbis', name: 'orbis', kind: 'balance', windows: [], balance: '$1.97' }] }
  const entries = magpieQuotaEntries(quotas, 'orbi')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].provider, 'orbis')
})

check('route 多种形状都能取到账号；null 安全', () => {
  assert.equal(magpieAccountFromRoute({ route: 'X.Y.z' }), 'X.Y.z')
  assert.equal(magpieAccountFromRoute({ route: { providerAccount: 'Ash.' } }), 'Ash.')
  assert.equal(magpieAccountFromRoute({ route: null }), null)
  assert.equal(magpieAccountFromRoute(null), null)
})

check('金额串解析：¥/￥/CNY/$ 都能识别', () => {
  assert.deepEqual(magpieParseMoney('¥0.03'), { currency: 'CNY', amount: 0.03 })
  assert.deepEqual(magpieParseMoney('￥12.5'), { currency: 'CNY', amount: 12.5 })
  assert.deepEqual(magpieParseMoney('$3.17'), { currency: 'USD', amount: 3.17 })
  assert.equal(magpieParseMoney('no-number'), null)
})

/* --------------------------------------- 通用中转站（不依赖 Magpie） */

check('providerConfigFromSettings：从 settings.describe 的 providers 配置取 baseURL/apiKeyEnv', () => {
  const fakeCtx = {
    get: (key) => key === 'settings' ? {
      describe: () => [
        { ns: 'other', value: { unrelated: true } },
        {
          ns: 'include:llm-pi-ai',
          value: {
            providers: {
              selen: { apiKeyEnv: 'SELEN_API_KEY', baseURL: 'https://selenapi.com/v1', models: [] },
              orbis: { apiKeyEnv: 'ORBIS_API_KEY', baseURL: 'https://orbis.example/v1' },
            },
          },
        },
      ],
    } : null,
  }
  assert.deepEqual(providerConfigFromSettings(fakeCtx, 'selen'), {
    baseURL: 'https://selenapi.com/v1',
    apiKeyEnv: 'SELEN_API_KEY',
  })
  assert.deepEqual(providerConfigFromSettings(fakeCtx, 'orbis'), {
    baseURL: 'https://orbis.example/v1',
    apiKeyEnv: 'ORBIS_API_KEY',
  })
  assert.equal(providerConfigFromSettings(fakeCtx, 'missing'), null)
  assert.equal(providerConfigFromSettings(null, 'selen'), null)
  assert.equal(providerConfigFromSettings({ get: () => null }, 'selen'), null)
})

check('providerConfigFromSettings：兼容 id/name/provider 条目形态', () => {
  const fakeCtx = {
    get: () => ({
      describe: () => [
        { ns: 'x', value: { list: [{ id: 'foo', baseURL: 'https://foo.example/v1', apiKeyEnv: 'FOO_API_KEY' }] } },
        { ns: 'y', value: [{ name: 'bar', baseURL: 'https://bar.example/v1', apiKeyEnv: 'BAR_API_KEY' }] },
      ],
    }),
  }
  assert.deepEqual(providerConfigFromSettings(fakeCtx, 'foo'), { baseURL: 'https://foo.example/v1', apiKeyEnv: 'FOO_API_KEY' })
  assert.deepEqual(providerConfigFromSettings(fakeCtx, 'bar'), { baseURL: 'https://bar.example/v1', apiKeyEnv: 'BAR_API_KEY' })
})

check('parseGenericRelayBalance：usage / user-self / credits 三种响应', () => {
  const usage = parseGenericRelayBalance('usage', { balance: 1.967, billing: { unit: 'USD' } })
  assert.deepEqual(usage, { currency: 'USD', total: '1.97' })
  const usageBilling = parseGenericRelayBalance('usage', { billing: { balance: 2.5, unit: 'CNY' } })
  assert.deepEqual(usageBilling, { currency: 'CNY', total: '2.50' })
  const usageRemaining = parseGenericRelayBalance('usage', { remaining: 3, unit: 'USD' })
  assert.deepEqual(usageRemaining, { currency: 'USD', total: '3.00' })
  const userSelf = parseGenericRelayBalance('user-self', { data: { balance: 8.5 } })
  assert.deepEqual(userSelf, { currency: '', total: '8.50' })
  const userSelfQuota = parseGenericRelayBalance('user-self', { data: { quota: 1500000 } })
  assert.deepEqual(userSelfQuota, { currency: '', total: '3.00' })
  const credits = parseGenericRelayBalance('credits', { data: { total_credits: 10, total_usage: 2.5 } })
  assert.deepEqual(credits, { currency: '', total: '7.50' })
  assert.equal(parseGenericRelayBalance('usage', {}), null)
  assert.equal(parseGenericRelayBalance('credits', { data: null }), null)
})

check('parseGenericRelayBalance：usage 支持 data 包裹与 billing.unit 币种', () => {
  assert.deepEqual(
    parseGenericRelayBalance('usage', { data: { balance: 5 } }),
    { currency: '', total: '5.00' },
  )
  assert.deepEqual(
    parseGenericRelayBalance('usage', { data: { billing: { balance: 6.5, unit: 'USD' } } }),
    { currency: 'USD', total: '6.50' },
  )
})

check('parseGenericRelayBalance：user-self quota 负数为不限量、按 500000 换算', () => {
  assert.equal(parseGenericRelayBalance('user-self', { data: { quota: -1 } }), null)
  assert.deepEqual(
    parseGenericRelayBalance('user-self', { data: { quota: 500000 } }),
    { currency: '', total: '1.00' },
  )
  /* 阈值 100000 / 100001 都按同一个 500000 口径换算，不能出现 0.00 / 0.21 */
  assert.deepEqual(
    parseGenericRelayBalance('user-self', { data: { quota: 100000 } }),
    { currency: '', total: '0.20' },
  )
  assert.deepEqual(
    parseGenericRelayBalance('user-self', { data: { quota: 100001 } }),
    { currency: '', total: '0.20' },
  )
})

check('parseGenericRelayBalance：user-self balance 优先于 quota', () => {
  assert.deepEqual(
    parseGenericRelayBalance('user-self', { data: { balance: 5, quota: 500000 } }),
    { currency: '', total: '5.00' },
  )
})

check('parseGenericRelayBalance：没有 unit/currency 时币种为空串（不猜 CNY/USD）', () => {
  const usage = parseGenericRelayBalance('usage', { balance: 12.5 })
  assert.equal(usage.currency, '')
  assert.equal(usage.total, '12.50')
  const userSelf = parseGenericRelayBalance('user-self', { data: { balance: 5 } })
  assert.equal(userSelf.currency, '')
  assert.equal(userSelf.total, '5.00')
})

/* queryGenericRelayBalance 用本地 mock fetch：验证 baseURL 末尾 /v1 不重复、端点回退与全失败返回 null。 */
let genericUsage = null
{
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return reply({ balance: 5, unit: 'USD' })
  }
  try {
    genericUsage = await queryGenericRelayBalance({}, 123, 'selen', {
      baseURL: 'https://relay.example/v1/',
      key: 'test-key',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(urls[0], 'https://relay.example/v1/usage')
}
check('queryGenericRelayBalance：mock fetch 命中 /v1/usage，返回统一余额对象', () => {
  assert.equal(genericUsage.ok, true)
  assert.equal(genericUsage.at, 123)
  assert.equal(genericUsage.provider, 'selen')
  assert.equal(genericUsage.currency, 'USD')
  assert.equal(genericUsage.total, '5.00')
  assert.deepEqual(genericUsage.parts, [])
})

let genericFallback = null
let genericFailure = null
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.endsWith('/v1/usage')) return reply({ error: 'not found' }, 404)
    if (text.endsWith('/v1/user/self')) return reply({ data: { quota: 250000 } })
    return reply({}, 404)
  }
  try {
    genericFallback = await queryGenericRelayBalance({}, 1, 'foo', { baseURL: 'https://relay.example/v1', key: 'k' })
  } finally {
    globalThis.fetch = originalFetch
  }
  const originalFetchAgain = globalThis.fetch
  globalThis.fetch = async () => reply({}, 500)
  try {
    genericFailure = await queryGenericRelayBalance({}, 1, 'foo', { baseURL: 'https://relay.example/v1', key: 'k' })
  } finally {
    globalThis.fetch = originalFetchAgain
  }
}
check('queryGenericRelayBalance：usage 404 后回退 user/self，且全失败返回 null', () => {
  assert.equal(genericFallback.ok, true)
  assert.equal(genericFallback.currency, '')
  assert.equal(genericFallback.total, '0.50')
  assert.equal(genericFailure, null)
})

let genericDashboard = null
let genericCredits = null
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.endsWith('/v1/dashboard/billing/credit_grants')) return reply({ total_available: 6.25 })
    if (text.endsWith('/v1/dashboard/billing/subscription')) return reply({ hard_limit_usd: 20 })
    return reply({}, 404)
  }
  try {
    genericDashboard = await queryGenericRelayBalance({}, 2, 'foo', { baseURL: 'https://relay.example', key: 'k' })
  } finally {
    globalThis.fetch = originalFetch
  }
  const originalFetchAgain = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.endsWith('/v1/credits')) return reply({ data: { total_credits: 9, total_usage: 4 } })
    return reply({}, 404)
  }
  try {
    genericCredits = await queryGenericRelayBalance({}, 3, 'foo', { baseURL: 'https://relay.example', key: 'k' })
  } finally {
    globalThis.fetch = originalFetchAgain
  }
}
check('queryGenericRelayBalance：dashboard 与 /v1/credits 两条兜底端点', () => {
  assert.equal(genericDashboard.ok, true)
  assert.equal(genericDashboard.currency, '')
  assert.equal(genericDashboard.total, '6.25')
  assert.equal(genericCredits.ok, true)
  assert.equal(genericCredits.total, '5.00')
})

check('parseGenericRelayBalanceAny：{balance,unit} 无路径也能通用解析', () => {
  const parsed = parseGenericRelayBalanceAny({ balance: 34.5, unit: 'USD' })
  assert.equal(parsed.currency, 'USD')
  assert.equal(parsed.total, '34.50')
  assert.equal(parseGenericRelayBalanceAny({ nope: true }), null)
})

/* 配置了 endpoint、但 balancePath 解析不出来（默认 data.quota）→ 按同一响应通用回退为 34.50。
   走 queryBalanceForTest，用一个临时 relay-balance.json 平台档案 + credentials。 */
let relayFallback = null
{
  const relayFile = join(TEMP_HOME, 'dsh-status-bar', 'relay-balance.json')
  const previous = readFileSync(relayFile, 'utf8')
  writeFileSync(relayFile, JSON.stringify({
    version: 2,
    channels: [{
      channelKey: 'compat-relay',
      endpoint: 'https://compat.example/v1/balance',
      tokenHeader: 'authorization', userIdHeader: 'x-user-id', tokenPrefix: 'Bearer ',
      balancePath: 'data.quota', currency: 'CNY', feeMultiplier: 1, balanceDivisor: 1, headerNames: [],
    }],
  }), 'utf8')
  const creds = { resolve: async () => ({ value: JSON.stringify({ token: 'tk', userId: 'u', headers: {} }), source: 'test' }), set: async () => {}, unset: async () => {} }
  const relayCtx = { logger: { info: () => {} }, credentials: creds, get: (n) => (n === 'credentials' ? creds : null) }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('compat.example') >= 0) {
      /* queryRelayBalance 走 readLimitedRelayJson：需要 headers.get(content-length) 与 reader.releaseLock。 */
      const buf = Buffer.from(JSON.stringify({ balance: 34.5, unit: 'USD' }), 'utf8')
      return {
        ok: true, status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(buf.byteLength) : null) },
        body: {
          getReader() {
            let done = false
            return {
              async read() { if (done) return { done: true }; done = true; return { done: false, value: new Uint8Array(buf) } },
              async cancel() {},
              releaseLock() {},
            }
          },
        },
      }
    }
    throw new Error('unexpected url ' + text)
  }
  try {
    relayFallback = await queryBalanceForTest(relayCtx, false, 'compat-relay', 'm', 'compat-relay', '')
  } finally {
    globalThis.fetch = originalFetch
    writeFileSync(relayFile, previous, 'utf8')
  }
}
check('queryRelayBalance：balancePath=data.quota 解析失败 → 通用形状回退为 34.50', () => {
  assert.equal(relayFallback.ok, true)
  assert.equal(relayFallback.source, 'relay')
  assert.equal(relayFallback.total, '34.50')
  assert.equal(relayFallback.currency, 'USD')
})

/* queryBalance 接线：没有专用适配器的 provider 先走 settings + credentials + 通用探测，命中即返回。 */
let genericWired = null
{
  const settingsService = {
    describe: () => [{
      ns: 'include:llm-pi-ai',
      value: { providers: { foo: { baseURL: 'https://foo.example/v1', apiKeyEnv: 'FOO_API_KEY' } } },
    }],
  }
  const credentialsService = {
    resolve: async (ref) => (ref === 'FOO_API_KEY' ? { value: 'test-key', source: 'test' } : undefined),
  }
  const genericCtx = {
    logger: { info: () => {} },
    credentials: credentialsService,
    get: (name) => {
      if (name === 'settings') return settingsService
      if (name === 'credentials') return credentialsService
      return null
    },
  }
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return reply({ balance: 7, unit: 'USD' })
  }
  try {
    genericWired = await queryBalanceForTest(genericCtx, false, 'foo', 'm', null, '')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(urls[0], 'https://foo.example/v1/usage')
}
check('queryBalance：通用中转站命中时直接返回（不依赖 Magpie）', () => {
  assert.equal(genericWired.ok, true)
  assert.equal(genericWired.source, 'generic-relay')
  assert.equal(genericWired.provider, 'foo')
  assert.equal(genericWired.total, '7.00')
})

/* provider 配置缺失（settings 里没有该 provider）时，用 cordis.patch.yml 的 baseURL + 引用名 key 兜底探测。
   patch 文件在 DSH_HOME/dsh-status-bar/... 由 providerBaseUrls() 读取；这里写一份临时 patch 验证取到 baseURL。 */
let genericPatchFallback = null
{
  /* providerBaseUrls() 只在存在当前 profile 目录时读它的 cordis.patch.yml：
     用 DSH_PROFILE 指定一个临时 profile，把 patch 写进 <DSH_HOME>/profiles/<name>/。 */
  const profileName = 'testprofile'
  const patchDir = join(TEMP_HOME, 'profiles', profileName)
  mkdirSync(patchDir, { recursive: true })
  process.env.DSH_PROFILE = profileName
  writeFileSync(join(patchDir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      patchrelay:',
    '        baseURL: https://patchrelay.example/v1',
    '',
  ].join('\n'), 'utf8')
  const creds = {
    resolve: async (ref) => (ref === 'PATCHRELAY_API_KEY' ? { value: 'pk', source: 'test' } : undefined),
    set: async () => {}, unset: async () => {},
  }
  const patchCtx = { logger: { info: () => {} }, credentials: creds, get: (n) => (n === 'credentials' ? creds : null) }
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    if (String(url).indexOf('patchrelay.example') >= 0) return reply({ balance: 12, unit: 'USD' })
    throw new Error('unexpected url ' + String(url))
  }
  try {
    genericPatchFallback = await queryBalanceForTest(patchCtx, false, 'patchrelay', 'm', null, '')
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.DSH_PROFILE
  }
  assert.equal(urls[0], 'https://patchrelay.example/v1/usage', '走 patch baseURL 的通用探测')
}
check('queryBalance：provider 配置缺失时用 baseURL/key 兜底（不回归）', () => {
  assert.equal(genericPatchFallback.ok, true)
  assert.equal(genericPatchFallback.source, 'generic-relay')
  assert.equal(genericPatchFallback.total, '12.00')
})

/* Magpie 透传：直连失败、但 quotas 有该 provider（按 providerHint 命中），返回 magpie-quotas 余额。 */
let relayPassthrough = null
let relayNoMagpie = null
{
  const relayFile = join(TEMP_HOME, 'dsh-status-bar', 'relay-balance.json')
  const previous = readFileSync(relayFile, 'utf8')
  writeFileSync(relayFile, JSON.stringify({
    version: 2,
    channels: [{
      channelKey: 'relay-up', endpoint: 'https://rm.example/v1/balance',
      tokenHeader: 'authorization', userIdHeader: 'x-user-id', tokenPrefix: 'Bearer ',
      balancePath: 'data.quota', currency: 'CNY', feeMultiplier: 1, balanceDivisor: 1, headerNames: [],
    }],
  }), 'utf8')
  const creds = { resolve: async () => ({ value: JSON.stringify({ token: 'tk', userId: 'u', headers: {} }), source: 'test' }), set: async () => {}, unset: async () => {} }
  const rctx = { logger: { info: () => {} }, credentials: creds, get: (n) => (n === 'credentials' ? creds : null) }
  const QUOTA_PCT = { data: [{ provider: 'relay-up', kind: 'subscription', user: 'u', windows: [{ name: '5 hours', used: 30, remaining: 70 }, { name: '7 days', used: 60, remaining: 40 }] }] }
  const directFail = (url) => {
    const text = String(url)
    if (text.indexOf('rm.example') >= 0) return { ok: true, status: 200, headers: { get: () => null }, body: { getReader() { let d = false; const buf = Buffer.from(JSON.stringify({ nope: 1 })); return { async read() { if (d) return { done: true }; d = true; return { done: false, value: new Uint8Array(buf) } }, async cancel() {}, releaseLock() {} } } } }
    return null
  }
  const originalFetch = globalThis.fetch
  /* 1) 直连失败 + Magpie 有该 provider（providerHint=relay-magpie 命中 quotas） */
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('/v1/magpie/quotas') >= 0) return reply(QUOTA_PCT)
    if (text.indexOf('/v1/magpie/route') >= 0) return reply({ route: null })
    if (text.indexOf('/v1/models') >= 0) return reply({ data: [] })
    return directFail(url)
  }
  try {
    relayPassthrough = await queryBalanceForTest(rctx, false, 'relay-up', 'm', 'relay-up', '')
  } finally {
    /* 2) 直连失败 + Magpie 没有该 provider → 原 relay 失败 */
    globalThis.fetch = async (url) => {
      const text = String(url)
      if (text.indexOf('/v1/magpie/quotas') >= 0) return reply({ data: [] })
      if (text.indexOf('/v1/magpie/route') >= 0) return reply({ route: null })
      if (text.indexOf('/v1/models') >= 0) return reply({ data: [] })
      return directFail(url)
    }
    try {
      relayNoMagpie = await queryBalanceForTest(rctx, false, 'relay-up', 'm', 'relay-up', '')
    } finally {
      globalThis.fetch = originalFetch
      writeFileSync(relayFile, previous, 'utf8')
    }
  }
}
check('queryBalance：直连失败但 Magpie 有余额 → 透传 magpie-quotas（viaMagpie）', () => {
  assert.equal(relayPassthrough.ok, true)
  assert.equal(relayPassthrough.source, 'magpie-quotas')
  assert.equal(relayPassthrough.upstream, 'relay-up')
  assert.equal(relayPassthrough.isPercent, true)
  assert.equal(relayPassthrough.viaMagpie, true, '透传结果打 viaMagpie:true（source 仍 magpie-quotas）')
})
check('queryBalance：直连失败且 Magpie 无该 provider → 原 relay 失败（不伪造）', () => {
  assert.equal(relayNoMagpie.ok, false)
})

/* --------------------------------------- ② queryMagpieBalance 编排（替换 fetch） */

/* 只测编排：把 globalThis.fetch 临时换掉，按 URL 返回，跑完恢复原 fetch。 */
const ctx = { logger: { info: () => {} } }

function reply(body, status) {
  const code = status === undefined ? 200 : status
  return { ok: code >= 200 && code < 300, status: code, async json() { return body } }
}

async function callBalance(model, handler) {
  return await callBalanceAs('magpie', model, handler)
}

async function callBalanceAs(provider, model, handler) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  try {
    return await queryBalanceForTest(ctx, false, provider, model, null, '')
  } finally {
    globalThis.fetch = originalFetch
  }
}

const GOOD_QUOTAS = {
  data: [{
    provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: 'A',
    windows: [{ name: 'Total credits', used: 40, remaining: 60, amount: 40, limit: 100, unit: 'credits' }],
  }],
}

/* a. 正常：三个端点按 URL 返回，模型归属 workbuddy，剩余 = limit - amount = 60。 */
const okValue = await callBalance('group/x', async (url) => {
  const text = String(url)
  if (text.indexOf('/v1/magpie/quotas') >= 0) return reply(GOOD_QUOTAS)
  if (text.indexOf('/v1/magpie/route') >= 0) return reply({ route: null })
  if (text.indexOf('/v1/models') >= 0) return reply({ data: [{ id: 'group/x', owned_by: 'workbuddy' }] })
  throw new Error('unexpected url ' + text)
})
check('queryMagpieBalance 正常：ok / isCredits / upstream workbuddy / total 60', () => {
  assert.equal(okValue.ok, true)
  assert.equal(okValue.isCredits, true)
  assert.equal(okValue.upstream, 'workbuddy')
  assert.equal(okValue.total, '60')
})

/* d. providerHint 别名：DSH 侧 provider 叫 orbi，Magpie quotas 里实际叫 orbis。 */
const orbiValue = await callBalanceAs('orbi', 'orbi/unknown-model', async (url) => {
  const text = String(url)
  if (text.indexOf('/v1/magpie/quotas') >= 0) {
    return reply({ data: [{ provider: 'orbis', name: 'orbis', kind: 'balance', windows: [], balance: '$1.97' }] })
  }
  if (text.indexOf('/v1/magpie/route') >= 0) return reply({ route: null })
  if (text.indexOf('/v1/models') >= 0) return reply({ data: [] })
  throw new Error('unexpected url ' + text)
})
check('queryBalance：provider=orbi 经 providerHint 命中 quotas 里的 orbis', () => {
  assert.equal(orbiValue.ok, true)
  assert.equal(orbiValue.upstream, 'orbis')
  assert.equal(orbiValue.currency, 'USD')
  assert.equal(orbiValue.total, '1.97')
})

/* b. quotas 请求抛错 → magpie-unreachable。 */
const downValue = await callBalance('group/x', async (url) => {
  const text = String(url)
  if (text.indexOf('/v1/magpie/quotas') >= 0) throw new Error('boom')
  return reply({ data: [] })
})
check('queryMagpieBalance quotas 抛错：magpie-unreachable', () => {
  assert.equal(downValue.ok, false)
  assert.equal(downValue.reason, 'magpie-unreachable')
})

/* c. models 返回 500（route/quotas 正常、quotas 里没有 group）→ 模型 'foo' 无斜杠 → magpie-unknown-model。 */
const unknownValue = await callBalance('foo', async (url) => {
  const text = String(url)
  if (text.indexOf('/v1/magpie/quotas') >= 0) return reply(GOOD_QUOTAS)
  if (text.indexOf('/v1/magpie/route') >= 0) return reply({ route: null })
  if (text.indexOf('/v1/models') >= 0) return reply({ error: 'boom' }, 500)
  throw new Error('unexpected url ' + text)
})
check('queryMagpieBalance models 500 + 模型无前缀：magpie-unknown-model', () => {
  assert.equal(unknownValue.ok, false)
  assert.equal(unknownValue.reason, 'magpie-unknown-model')
})

/* ---------------------------------------------------------------- ③ 静态接线 */

const clientText = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')
const indexText = readFileSync(join(HERE, '..', 'lib', 'index.js'), 'utf8')

check('client 不再把 magpie 强制成横杠', () => {
  assert.equal(clientText.includes('balanceProvider.indexOf("magpie")'), false)
})

check('client 余额请求带 session 参数', () => {
  assert.ok(clientText.includes('&session='))
})

check('index 存在 magpie 专用分支并读取 quotas', () => {
  assert.ok(indexText.includes('queryMagpieBalance'))
  assert.ok(indexText.includes('/v1/magpie/quotas'))
  assert.ok(indexText.includes("source: 'magpie-quotas'"))
})

/* ---------------------------------------------------------------- ④ 实时联调 */

const BASE = (process.env.MAGPIE_URL || process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, '')
async function live() {
  let quotas, models
  try {
    const get = async (path) => {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error('http-' + res.status)
      return await res.json()
    }
    quotas = await get('/v1/magpie/quotas')
    models = await get('/v1/models')
  } catch (error) {
    console.log('  - 跳过实时联调：Magpie 网关不可达（' + BASE + '）')
    return
  }
  const model = 'group/deepseek-flash'
  const provider = magpieModelProvider(models, model) || magpieModelPrefix(model)
  /* 无会话 route 时多账号按池合计（稳定、不跳动）；气泡里再逐账号列出。 */
  const value = magpieBalanceOf(quotas, { provider: provider })
  assert.equal(provider, 'workbuddy')
  assert.equal(value.ok, true)
  assert.equal(value.isCredits, true)
  assert.equal(value.account, null)
  assert.ok(Array.isArray(value.rewards) && value.rewards.length >= 1, 'rewards 应逐账号列出')
  /* 绝不能还是 DEEPSEEK_API_KEY 的那个 ¥75.87 金额口径；且合计要等于各账号剩余之和 */
  assert.equal(typeof value.total, 'string')
  assert.ok(value.total.indexOf('75.87') < 0)
  const entries = (quotas.data || []).filter((one) => one.provider === provider)
  let expected = 0
  for (const entry of entries) {
    /* 与 lib/balance-api.js 的 magpiePrimaryCreditsWindow 同规则：
       credits 窗口（unit==='credits'）优先 Total credits → Credits → 第一个 */
    const creditWindows = (entry.windows || []).filter((w) => w !== null && w !== undefined && w.unit === 'credits')
    const win = creditWindows.filter((w) => w.name === 'Total credits')[0]
      || creditWindows.filter((w) => w.name === 'Credits')[0]
      || creditWindows[0]
    if (win === undefined) continue
    const limit = Number(win.limit)
    const amount = Number(win.amount)
    if (Number.isFinite(limit) && Number.isFinite(amount)) { expected += Math.max(0, limit - amount); continue }
    const remainPct = Number(win.remaining)
    if (Number.isFinite(limit) && Number.isFinite(remainPct)) expected += Math.max(0, (limit * remainPct) / 100)
  }
  const actual = Number(String(value.total).replace(/,/g, ''))
  assert.ok(Math.abs(actual - expected) < 0.05, '池合计应等于各账号剩余之和：' + actual + ' vs ' + expected)
  console.log('  ✓ 实时：' + model + ' → ' + provider + ' 池合计 = ' + value.total + ' credits（' + value.rewards.length + ' 个账号）')
  passed += 1
}

await live()
console.log('\nverify-magpie-quota: ' + passed + ' 项通过')
