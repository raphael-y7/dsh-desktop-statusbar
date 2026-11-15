/**
 * 宿主端来源校验纯函数的回归测试。
 *
 * relay-balance-config 的 GET 虽只读，却会返回明文 token/userId，属"秘密读取口"，
 * 只允许本机页面读取。lib/index.js 用三个纯函数把关（以宿主监听器权威 origin 为准）：
 *   - isLocalRequestHost(host, ctx, authority)  Host 头是否等于监听器 host（挡 DNS rebinding）
 *   - isLocalOriginHeader(origin, ctx)          带 Origin 的请求是否与监听器同源
 *   - isCrossSiteFetchSite(value)               浏览器标记的 sec-fetch-site 是否跨站
 *
 * 这里用假 ctx（只提供 webServer.getOrigin）直接驱动真实生产实现，防止后续把校验改松。
 *
 * 用法：node tests/verify-host-guards.js（退出码 0 = 通过）
 */
import assert from 'node:assert/strict'
import {
  isLocalRequestHostForTest as isLocalRequestHost,
  isLocalOriginHeaderForTest as isLocalOriginHeader,
  isCrossSiteFetchSiteForTest as isCrossSiteFetchSite,
  isLoopbackAddressForTest as isLoopbackAddress,
} from '../lib/index.js'

/* 假的宿主上下文：监听器权威 origin 固定为 http://127.0.0.1:1234 */
const ctx = { webServer: { getOrigin: () => 'http://127.0.0.1:1234' } }

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log('  ✓ ' + name)
}

check('Host 为 127.0.0.1:1234（与监听器一致）→ 允许', () => {
  assert.equal(isLocalRequestHost('127.0.0.1:1234', ctx), true)
})

check('Host 为 evil.example.com（不匹配监听器）→ 拒绝', () => {
  assert.equal(isLocalRequestHost('evil.example.com', ctx), false)
})

check('Host 为畸形 evil.com:80（带端口的非回环域名）→ 拒绝', () => {
  assert.equal(isLocalRequestHost('evil.com:80', ctx, ''), false)
})

check('Origin 为 http://127.0.0.1:1234（同源）→ 允许', () => {
  assert.equal(isLocalOriginHeader('http://127.0.0.1:1234', ctx), true)
})

check('Origin 为 https://evil.example.com（跨源）→ 拒绝', () => {
  assert.equal(isLocalOriginHeader('https://evil.example.com', ctx), false)
})

check('Host 为 localhost:1234（回环任意端口）→ 允许', () => {
  assert.equal(isLocalRequestHost('localhost:1234', ctx, ''), true)
})

check('Host 为 127.0.0.1:9999（SSH 端口转发任意端口）→ 允许', () => {
  assert.equal(isLocalRequestHost('127.0.0.1:9999', ctx, ''), true)
})

check('Host 为 [::1]:1234（IPv6 回环带方括号）→ 允许', () => {
  assert.equal(isLocalRequestHost('[::1]:1234', ctx, ''), true)
})

check('Host 缺失时回退 :authority（127.0.0.1:1234）→ 允许', () => {
  assert.equal(isLocalRequestHost('', ctx, '127.0.0.1:1234'), true)
})

check('Host 缺失时回退 :authority（[::1]:1234，IPv6 回环）→ 允许', () => {
  assert.equal(isLocalRequestHost('', ctx, '[::1]:1234'), true)
})

check('Host 为 10.0.0.7:4096（非回环 bind）→ 拒绝', () => {
  assert.equal(isLocalRequestHost('10.0.0.7:4096', ctx, ''), false)
})

check('Origin 为 http://localhost:9999（回环任意端口）→ 允许', () => {
  assert.equal(isLocalOriginHeader('http://localhost:9999', ctx), true)
})

check('isLoopbackAddress：127.0.0.1 是回环、10.0.0.7 不是', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.7'), false)
})

check('isLoopbackAddress：::ffff:127.0.0.1（IPv4-mapped IPv6）→ 是回环', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
})

check('sec-fetch-site 为 cross-site → 判定跨站', () => {
  assert.equal(isCrossSiteFetchSite('cross-site'), true)
})

check('sec-fetch-site 为 same-origin → 不跨站', () => {
  assert.equal(isCrossSiteFetchSite('same-origin'), false)
})

console.log('\nverify-host-guards: ' + passed + ' 项通过')
