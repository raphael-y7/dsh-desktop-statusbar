/**
 * 价格锚点回归测试（审查第 4 条）。
 *
 * 口径：官方 USD 价目在生成价格库条目时，**显示值**（peak/offPeak）按实时汇率折算成 CNY，
 * 但 **base 锚点**必须保留官方 USD 原始值（4 / 0.2 / 5 / 20 一字不动）——
 * 这样「CNY→USD→CNY」来回切币种时不会因两位小数舍入越切越偏。
 *
 * 覆盖两条路径：
 *   ① catalogPriceEntry（MODEL_PRESENTATION.price → 价格库条目）
 *   ② normalizeModels（原始价格库 → 规范化价格库）
 *
 * 用法：node tests/verify-client-price.js（退出码 0 = 通过）
 */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { loadPlugin } = require('../tools/shot.cjs')

/* 用插件自己的 client.js 加载客户端代码，取只读测试钩子 __testClient */
const loaded = loadPlugin('zh', {})
const { catalogPriceEntry, normalizeModels } = loaded.api.__testClient

/* 官方价目同形：单档、USD 计价、官方输入价 4 美元 / 百万 tokens */
const USD_PRICE = {
  tiered: false,
  currency: 'USD',
  peak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  offPeak: { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
}

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

check('catalogPriceEntry：显示值折算成 CNY，base 保留官方 USD 原值', () => {
  const entry = catalogPriceEntry(USD_PRICE)
  assert.equal(entry.currency, 'CNY')
  assert.notEqual(entry.peak.input, 4)      /* 已按汇率折算（4 USD × 汇率 ≠ 4） */
  assert.equal(entry.base.currency, 'USD')  /* 锚点保留官方 USD */
  assert.equal(entry.base.peak.input, 4)    /* 未折算的官方 USD 原值 */
})

check('normalizeModels：显示值折算成 CNY，base 保留官方 USD 原值', () => {
  const out = normalizeModels({ m: USD_PRICE }, 'CNY')
  assert.equal(out.m.currency, 'CNY')
  assert.equal(out.m.base.currency, 'USD')
  assert.equal(out.m.base.peak.input, 4)
})

/* 官方折算值统一由 catalogPriceEntry 算出（模块未导出 REFERENCE_RATE）：
   USD 4 按当前汇率折算成 CNY 显示值，同时给出官方 USD 锚点。 */
const OFFICIAL_CNY = catalogPriceEntry(USD_PRICE)

check('normalizeModels：官方模型无 base、数值等于官方折算值 → 重建 USD base', () => {
  /* claude-opus-5.5 的官方价目就是 USD 4 / 0.2 / 5 / 20。
     模拟老配置：只有按 REFERENCE_RATE 折算后的 CNY 峰值、没有 base；
     数值与官方 USD 折算值逐字段一致，应补回官方 USD 锚点。 */
  const input = {
    'claude-opus-5.5': {
      tiered: false,
      currency: 'CNY',
      peak: OFFICIAL_CNY.peak,
      offPeak: OFFICIAL_CNY.peak,
    },
  }
  const out = normalizeModels(input, 'CNY')
  /* 显示值未被二次折算：仍等于官方 USD × 汇率 */
  assert.equal(OFFICIAL_CNY.currency, 'CNY')
  assert.notEqual(OFFICIAL_CNY.peak.input, 4)
  assert.equal(out['claude-opus-5.5'].peak.input, OFFICIAL_CNY.peak.input)
  assert.equal(out['claude-opus-5.5'].offPeak.input, OFFICIAL_CNY.peak.input)
  assert.equal(out['claude-opus-5.5'].base.currency, 'USD')
  assert.equal(out['claude-opus-5.5'].base.peak.input, 4)
})

check('normalizeModels：官方模型缺 tiered、CNY 值等于官方折算 → 仍重建 USD base', () => {
  /* 老配置可能没有 tiered 字段（早期版本只存 currency/peak/offPeak）。
     claude-opus-5.5 官方是单档（tiered:false）；缺省 tiered 不能挡住官方 USD 锚点重建。 */
  const input = {
    'claude-opus-5.5': {
      currency: 'CNY',
      peak: OFFICIAL_CNY.peak,
      offPeak: OFFICIAL_CNY.peak,
    },
  }
  const out = normalizeModels(input, 'CNY')
  assert.equal(out['claude-opus-5.5'].base.currency, 'USD')
  assert.equal(out['claude-opus-5.5'].base.peak.input, 4)
})

check('normalizeModels：官方模型用户改过硬编码价且无 base → 不生成 base', () => {
  /* 用户把 input 改成 20（≠ 官方折算值）：官方兜底不得覆盖用户值，
     也不生成 base；用户 CNY 的 base 由迁移逻辑补。 */
  const input = {
    'claude-opus-5.5': {
      tiered: false,
      currency: 'CNY',
      peak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
      offPeak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
    },
  }
  const out = normalizeModels(input, 'CNY')
  assert.equal(out['claude-opus-5.5'].peak.input, 20)
  assert.equal(out['claude-opus-5.5'].base, undefined)
})

check('normalizeModels：用户改过价的官方模型不覆盖 base', () => {
  /* claude-opus-5.5 是官方 USD 模型（4 / 0.2 / 5 / 20）。
     用户把它改成 CNY 20 并自带 base —— 官方 USD 重建 base 的那条兜底分支必须跳过，
     不能把用户写的 base 覆盖回官方 4 USD。 */
  const input = {
    'claude-opus-5.5': {
      tiered: false,
      currency: 'CNY',
      peak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
      offPeak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
      base: {
        currency: 'CNY',
        peak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
        offPeak: { input: 20, cacheRead: 1, cacheWrite: 5, output: 30 },
      },
    },
  }
  const out = normalizeModels(input, 'CNY')
  assert.equal(out['claude-opus-5.5'].base.currency, 'CNY')  /* 未被官方 USD 覆盖 */
  assert.equal(out['claude-opus-5.5'].base.peak.input, 20)   /* 仍是用户写的 20，不是官方 4 */
})

console.log('\nverify-client-price: ' + passed + ' 项通过')
