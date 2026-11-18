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
  magpieModelProvider, magpieModelPrefix, magpieBalanceOf,
  magpieAccountFromRoute, magpieParseMoney, magpieQuotaEntries,
} from '../lib/balance-api.js'
import {
  queryBalanceForTest,
  providerConfigFromSettings,
  parseGenericRelayBalance,
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
