/**
 * 通用中转站余额解析回归测试（B 方案：增强自适应匹配）。
 *
 * 只驱动纯函数 parseGenericRelayBalance，不发起任何网络请求。
 * 覆盖：字段别名（available / remaining_balance / balance_remaining / credit / credits）、
 *      quota / remain_quota 的 500000 积分换算、credit-grants / credits 口径、
 *      以及 null / 布尔 / 对象绝不被当成 0。
 *
 * 用法：node tests/verify-generic-relay.js   （成功退出 0）
 */
'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const INDEX = path.join(__dirname, '..', 'lib', 'index.js')

function expect(parse, kind, data, total, currency) {
  const got = parse(kind, data)
  assert.notEqual(got, null, kind + ' 应解析出结果: ' + JSON.stringify(data))
  assert.equal(got.total, total, kind + ' total 不符: ' + JSON.stringify(data))
  if (currency !== undefined) {
    assert.equal(got.currency, currency, kind + ' currency 不符: ' + JSON.stringify(data))
  }
  return got
}

function expectNull(parse, kind, data) {
  const got = parse(kind, data)
  assert.equal(got, null, kind + ' 应返回 null: ' + JSON.stringify(data))
}

;(async () => {
  const mod = await import(pathToFileURL(INDEX).href)
  const parse = mod.parseGenericRelayBalance
  assert.equal(typeof parse, 'function', 'parseGenericRelayBalance 需从 lib/index.js 导出')

  /* ① 既有 balance 字段 */
  expect(parse, 'usage', { balance: '1.23' }, '1.23', '')
  expect(parse, 'user-self', { balance: '1.23' }, '1.23', '')

  /* ② user-self 的 quota：500000 = 1.00，且只在 >0 时换算 */
  expect(parse, 'user-self', { data: { quota: 500000 } }, '1.00', '')
  expectNull(parse, 'user-self', { data: { quota: 0 } })
  expectNull(parse, 'user-self', { data: { quota: -1 } })

  /* ③ 既有 remaining 字段（两种 kind 都认） */
  expect(parse, 'usage', { data: { remaining: '2.5' } }, '2.50', '')
  expect(parse, 'user-self', { data: { remaining: '2.5' } }, '2.50', '')

  /* ④ 新增 available 字段 */
  expect(parse, 'usage', { data: { available: 3 } }, '3.00', '')
  expect(parse, 'user-self', { data: { available: 3 } }, '3.00', '')

  /* ⑤ 新增其它别名字段 */
  expect(parse, 'usage', { data: { remaining_balance: '1.5' } }, '1.50', '')
  expect(parse, 'usage', { data: { balance_remaining: '1.5' } }, '1.50', '')
  expect(parse, 'usage', { data: { credit: '1.5' } }, '1.50', '')
  expect(parse, 'usage', { data: { credits: '1.5' } }, '1.50', '')
  expect(parse, 'user-self', { data: { credits: 8 } }, '8.00', '')

  /* ⑥ user-self 顶层 remain_quota：500000 = 1.00，>0 才认 */
  expect(parse, 'user-self', { remain_quota: 1000000 }, '2.00', '')
  expectNull(parse, 'user-self', { remain_quota: 0 })

  /* ⑦ credit-grants：total_available 口径，无币种时 currency 为空串 */
  expect(parse, 'credit-grants', { total_available: '4.2' }, '4.20', '')
  expect(parse, 'credit-grants', { total_available: '4.2', currency: 'USD' }, '4.20', 'USD')

  /* ⑧ credits：total_credits - total_usage，无币种时 currency 为空串 */
  expect(parse, 'credits', { data: { total_credits: 10, total_usage: 3 } }, '7.00', '')

  /* ⑨ null / 布尔 / 对象绝不能当 0 */
  expectNull(parse, 'usage', { foo: 1 })
  expectNull(parse, 'user-self', { foo: 1 })
  expectNull(parse, 'usage', { data: { available: null } })
  expectNull(parse, 'usage', { data: { available: true } })
  expectNull(parse, 'usage', { data: { available: {} } })
  expectNull(parse, 'user-self', { data: { credit: false } })
  expectNull(parse, 'credit-grants', { total_available: 'abc' })
  expectNull(parse, 'credits', { data: { total_usage: 3 } })

  console.log('GENERIC RELAY PARSE CHECKS PASSED')
})().catch((error) => {
  console.error('GENERIC RELAY PARSE CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error))
  process.exitCode = 1
})
