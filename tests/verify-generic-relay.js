/**
 * 通用中转站余额解析 + 空地址端点自适应回归测试。
 *
 * 覆盖：
 *   ① 纯解析 parseGenericRelayBalance：字段别名、quota/remain_quota 的 500000 积分换算、
 *      credit-grants / credits 口径，以及 null / 布尔 / 对象绝不被当成 0；
 *   ② 空地址平台首次查询：7 个候选并发探测，只有 /api/user/self 能解析出余额时选中它，
 *      并把 endpoint 写回 relay-balance.json；平台 token / userId / 自定义 header 全部带上；
 *   ③ 第二次查询只请求缓存下来的那个 endpoint（1 次，不再探测 7 个）；
 *   ④ 探测全部失败：返回 relay-endpoint-empty，token/userId/平台记录原样保留，
 *      且同一轮刷新周期内不反复重试 7 个候选。
 *
 * 用法：node tests/verify-generic-relay.js   （成功退出 0）
 */
'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createHash } = require('node:crypto')
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

/** fetch 的 headers 可能是普通对象（探测）或 Headers（queryRelayBalance），两种都按大小写不敏感读取。 */
function headerOf(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(name)
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
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

  /* ==================================================================
     ⑩ 空地址平台：首次 7 候选并发探测 → 写回 endpoint；第二次只打 1 次
     ================================================================== */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-generic-relay-'))
  const savedHome = process.env.DSH_HOME
  const realSetInterval = globalThis.setInterval
  process.env.DSH_HOME = home
  globalThis.setInterval = () => 0
  try {
    const relayDir = path.join(home, 'dsh-status-bar')
    fs.mkdirSync(relayDir, { recursive: true })
    const configPath = path.join(relayDir, 'relay-balance.json')
    const relayRef = (key) => 'DSH_DESKTOP_STATUSBAR_RELAY_' + createHash('sha256').update(key).digest('hex')
    const envelope = (token, userId, headers) => JSON.stringify({ token: token, userId: userId, headers: headers || {} })
    const channel = (channelKey) => ({
      channelKey: channelKey,
      endpoint: '',
      tokenHeader: 'authorization',
      userIdHeader: 'New-Api-User',
      tokenPrefix: 'Bearer ',
      balancePath: 'data.quota',
      currency: 'CNY',
      feeMultiplier: 1,
      balanceDivisor: 500000,
      headerNames: [],
    })
    const secrets = new Map([
      [relayRef('relay-auto'), envelope('platform-token', 'platform-user', { 'x-platform-header': 'platform-header-value' })],
      [relayRef('relay-fail'), envelope('fail-token', 'fail-user', {})],
    ])
    fs.writeFileSync(configPath, JSON.stringify({
      version: 2,
      channels: [channel('relay-auto'), channel('relay-fail')],
    }), 'utf8')

    const secretWrites = []
    const credentials = {
      resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: 'provider-managed' } : null),
      set: async (ref, value) => { secretWrites.push([ref, value]); secrets.set(ref, value) },
      unset: async (ref) => { secretWrites.push([ref, null]); secrets.delete(ref) },
    }
    const settingsService = {
      describe: () => [{
        ns: 'include:llm-pi-ai',
        value: { providers: {
          'relay-auto': { baseURL: 'https://relay.example/v1' },
          'relay-fail': { baseURL: 'https://fail.example/v1' },
        } },
      }],
    }
    const ctx = {
      logger: { info: () => {} },
      credentials: credentials,
      get: (name) => {
        if (name === 'credentials') return credentials
        if (name === 'settings') return settingsService
        return undefined
      },
    }

    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), headers: options === undefined ? undefined : options.headers })
      if (String(url) === 'https://relay.example/api/user/self') {
        return new Response(JSON.stringify({ data: { quota: 5000000 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'not-found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    try {
      /* ---- 首次查询：并发 7 个候选，只有 /api/user/self 有效 ---- */
      const first = await mod.queryBalanceForTest(ctx, false, 'relay-auto', 'any-model', null, null)
      assert.equal(first.ok, true, '首次查询应解析出余额: ' + JSON.stringify(first))
      assert.equal(first.total, '10.00', 'quota 5000000 / 500000 = 10.00')
      assert.equal(first.provider, 'relay-auto', '余额 provider 是平台名')
      assert.equal(calls.length, 7, '首次查询应恰好并发探测 7 个候选，实际 ' + calls.length + ' 次')
      const called = calls.map((one) => one.url).sort()
      assert.deepEqual(called, [
        'https://relay.example/api/usage',
        'https://relay.example/api/user/self',
        'https://relay.example/api/v1/user/self',
        'https://relay.example/v1/credits',
        'https://relay.example/v1/dashboard/billing/credit_grants',
        'https://relay.example/v1/usage',
        'https://relay.example/v1/user/self',
      ], '7 个候选端点各请求一次')
      const winnerCalls = calls.filter((one) => one.url === 'https://relay.example/api/user/self')
      assert.equal(winnerCalls.length, 1, '只有 /api/user/self 返回有效余额')
      for (const call of calls) {
        assert.equal(headerOf(call.headers, 'authorization'), 'Bearer platform-token', '每个探测都带平台 token（Bearer）')
        assert.equal(headerOf(call.headers, 'New-Api-User'), 'platform-user', '每个探测都带平台 userId')
        assert.equal(headerOf(call.headers, 'x-platform-header'), 'platform-header-value', '平台自定义 header 也带上')
      }

      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const savedChannel = written.channels.find((one) => one.channelKey === 'relay-auto')
      assert.ok(savedChannel !== undefined, '平台档案仍在')
      assert.equal(savedChannel.endpoint, 'https://relay.example/api/user/self', '命中 endpoint 写回 relay-balance.json')
      assert.deepEqual(secretWrites, [], '写回 endpoint 不触碰凭据服务（token/userId 原样保留）')

      /* ---- 第二次查询：直接用缓存 endpoint，只发 1 次 ---- */
      calls.length = 0
      const second = await mod.queryBalanceForTest(ctx, false, 'relay-auto', 'any-model', null, null)
      assert.equal(second.ok, true, '第二次查询仍然成功: ' + JSON.stringify(second))
      assert.equal(second.total, '10.00', '第二次查询余额一致')
      assert.equal(calls.length, 1, '第二次查询只请求缓存的 endpoint，实际 ' + calls.length + ' 次')
      assert.equal(calls[0].url, 'https://relay.example/api/user/self', '只打缓存下来的那个 endpoint')
      assert.equal(headerOf(calls[0].headers, 'authorization'), 'Bearer platform-token', '缓存查询同样带平台 token')
      assert.equal(headerOf(calls[0].headers, 'New-Api-User'), 'platform-user', '缓存查询同样带平台 userId')

      /* ---- 失败路径：7 个都失败 → relay-endpoint-empty，secrets 与记录不丢 ---- */
      calls.length = 0
      const failed = await mod.queryBalanceForTest(ctx, false, 'relay-fail', 'any-model', null, null)
      assert.equal(failed.ok, false, '全部候选失败时 ok=false')
      assert.equal(failed.reason, 'relay-endpoint-empty', '失败原因明确为 relay-endpoint-empty')
      assert.equal(failed.provider, 'relay-fail', '失败态标明平台名')
      assert.equal(calls.length, 7, '失败时也只探测 7 个候选一次')
      const afterFail = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const failChannel = afterFail.channels.find((one) => one.channelKey === 'relay-fail')
      assert.ok(failChannel !== undefined, '探测失败不清空平台记录')
      assert.equal(failChannel.endpoint, '', '探测失败 endpoint 保持空')
      const failSecrets = JSON.parse(secrets.get(relayRef('relay-fail')))
      assert.equal(failSecrets.token, 'fail-token', '探测失败不清空平台 token')
      assert.equal(failSecrets.userId, 'fail-user', '探测失败不清空平台 userId')
      assert.deepEqual(secretWrites, [], '探测失败不写/删凭据服务')

      /* ---- 同一刷新周期内不每轮重试 7 个 ---- */
      const beforeRetry = calls.length
      const again = await mod.queryBalanceForTest(ctx, false, 'relay-fail', 'any-model', null, null)
      assert.equal(again.ok, false, '冷却期内仍然 ok=false')
      assert.equal(again.reason, 'relay-endpoint-empty', '冷却期内原因不变')
      assert.equal(calls.length, beforeRetry, '冷却期内不重复发 7 个候选，实际增加 ' + (calls.length - beforeRetry) + ' 次')
      console.log('GENERIC RELAY DISCOVERY CHECKS PASSED')
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    globalThis.setInterval = realSetInterval
    fs.rmSync(home, { recursive: true, force: true })
  }

  /* ==================================================================
     ⑪ 回归：默认 balancePath 探测后第二次查询 / 外域与重定向不泄露 /
        同长度不同凭据不共享冷却 / 冷却表容量上限
     ================================================================== */
  {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-generic-relay-2-'))
    const savedHome2 = process.env.DSH_HOME
    const realSetInterval2 = globalThis.setInterval
    process.env.DSH_HOME = home2
    globalThis.setInterval = () => 0
    try {
      const relayDir = path.join(home2, 'dsh-status-bar')
      fs.mkdirSync(relayDir, { recursive: true })
      const configPath = path.join(relayDir, 'relay-balance.json')
      const relayRef = (key) => 'DSH_DESKTOP_STATUSBAR_RELAY_' + createHash('sha256').update(key).digest('hex')
      const envelope = (token, userId) => JSON.stringify({ token: token, userId: userId, headers: {} })
      const refOf = (key) => relayRef(key)
      /* 平台档案只写最小字段：让 readRelayConfig 按默认补齐 balancePath=$.balance / divisor=1，
         这正是“用户没配余额字段、靠首次探测”的真实场景，能暴露“只写 endpoint 不写解析字段”的旧 bug。 */
      const bareChannel = (channelKey) => ({ channelKey: channelKey, endpoint: '', headerNames: [] })
      const makeConfig = () => ({
        version: 2,
        channels: [bareChannel('relay-default'), bareChannel('relay-nobase'), bareChannel('relay-redirect'), bareChannel('relay-cool'), bareChannel('relay-credits')],
      })
      fs.writeFileSync(configPath, JSON.stringify(makeConfig()), 'utf8')

      const secrets = new Map([
        [refOf('relay-default'), envelope('default-token', 'default-user')],
        [refOf('relay-nobase'), envelope('nobase-token', 'nobase-user')],
        [refOf('relay-redirect'), envelope('redir-token', 'redir-user')],
        [refOf('relay-cool'), envelope('aaaa', 'cool-user')],
        [refOf('relay-credits'), envelope('credits-token', 'credits-user')],
      ])
      const credentials = {
        resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: 'provider-managed' } : null),
        set: async (ref, value) => { secrets.set(ref, value) },
        unset: async (ref) => { secrets.delete(ref) },
      }
      /* relay-nobase 故意没有自己的 baseURL；other-provider 有 baseURL。
         旧逻辑会把 other-provider 的域名借给 relay-nobase 的 token → 跨域泄露。 */
      const settingsService = {
        describe: () => [{
          ns: 'include:llm-pi-ai',
          value: { providers: {
            'relay-default': { baseURL: 'https://default.example/v1' },
            'relay-redirect': { baseURL: 'https://redir.example/v1' },
            'relay-cool': { baseURL: 'https://cool.example/v1' },
            'other-provider': { baseURL: 'https://other.example/v1' },
            'relay-credits': { baseURL: 'https://credits.example/v1' },
          } },
        }],
      }
      const ctx = {
        logger: { info: () => {} },
        credentials: credentials,
        get: (name) => {
          if (name === 'credentials') return credentials
          if (name === 'settings') return settingsService
          return undefined
        },
      }

      const calls = []
      const realFetch = globalThis.fetch
      const jsonOk = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      const jsonNo = () => new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      globalThis.fetch = async (url, options) => {
        const u = String(url)
        calls.push({ url: u, redirect: options === undefined ? undefined : options.redirect, headers: options === undefined ? undefined : options.headers })
        if (u === 'https://default.example/api/user/self') return jsonOk({ data: { quota: 5000000 } })
        /* credits 口径：余额 = total_credits - total_usage，无法用单个 balancePath 表达 */
        if (u === 'https://credits.example/v1/credits') return jsonOk({ data: { total_credits: 10, total_usage: 3 } })
        if (u.indexOf('https://redir.example/') === 0) {
          /* 302 指向另一个域：redirect='manual' 时不会被跟随，token 不会被带过去 */
          return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
        }
        return jsonNo()
      }
      try {
        /* ---- ① 默认 balancePath 场景：首次探测命中 data.quota → 第二次查询仍能解析 ---- */
        const first = await mod.queryBalanceForTest(ctx, false, 'relay-default', 'any-model', null, null)
        assert.equal(first.ok, true, '默认 balancePath 首次探测应成功: ' + JSON.stringify(first))
        assert.equal(first.total, '10.00', 'quota 5000000 / 500000 = 10.00')
        assert.equal(calls.length, 7, '首次并发探测 7 个候选，实际 ' + calls.length)
        const savedDefault = JSON.parse(fs.readFileSync(configPath, 'utf8')).channels.find((one) => one.channelKey === 'relay-default')
        assert.equal(savedDefault.endpoint, 'https://default.example/api/user/self', '命中 endpoint 写回')
        assert.equal(savedDefault.balancePath, 'data.quota', '解析字段 balancePath 一并写回（旧 bug：不写，第二次按 $.balance 失败）')
        assert.equal(savedDefault.balanceDivisor, 500000, '解析除数 balanceDivisor 一并写回')
        calls.length = 0
        const second = await mod.queryBalanceForTest(ctx, false, 'relay-default', 'any-model', null, null)
        assert.equal(second.ok, true, '第二次查询必须仍然成功: ' + JSON.stringify(second))
        assert.equal(second.total, '10.00', '第二次查询余额与首次一致（按写回的 balancePath 解析）')
        assert.equal(calls.length, 1, '第二次查询只请求缓存 endpoint，实际 ' + calls.length)
        assert.equal(calls[0].url, 'https://default.example/api/user/self', '只打缓存 endpoint')
        console.log('GENERIC RELAY DEFAULT-BALANCEPATH REGRESSION PASSED')

        /* ---- ①-b credits（total-usage 减法）：首次探测命中后第二次查询仍返回正确余额 ---- */
        calls.length = 0
        const cred1 = await mod.queryBalanceForTest(ctx, false, 'relay-credits', 'any-model', null, null)
        assert.equal(cred1.ok, true, 'credits 首次探测应成功: ' + JSON.stringify(cred1))
        assert.equal(cred1.total, '7.00', 'credits = total_credits 10 - total_usage 3 = 7.00')
        assert.equal(calls.length, 7, '首次并发探测 7 个候选，实际 ' + calls.length)
        const savedCredits = JSON.parse(fs.readFileSync(configPath, 'utf8')).channels.find((one) => one.channelKey === 'relay-credits')
        assert.equal(savedCredits.endpoint, 'https://credits.example/v1/credits', 'credits 命中 endpoint 写回')
        assert.equal(savedCredits.balanceKind, 'credits', 'credits 持久化解析 kind（减法无法用 balancePath 表达）')
        assert.equal(savedCredits.balancePath, '$.balance', 'credits 不改默认 balancePath')
        calls.length = 0
        const cred2 = await mod.queryBalanceForTest(ctx, false, 'relay-credits', 'any-model', null, null)
        assert.equal(cred2.ok, true, 'credits 第二次查询必须成功（旧 bug：按 $.balance 解析 invalid-balance）: ' + JSON.stringify(cred2))
        assert.equal(cred2.total, '7.00', 'credits 第二次查询余额仍正确（total-used 减法）')
        assert.equal(calls.length, 1, '第二次查询只请求缓存 endpoint，实际 ' + calls.length)
        assert.equal(calls[0].url, 'https://credits.example/v1/credits', '只打缓存 credits endpoint')
        console.log('GENERIC RELAY CREDITS SECOND-QUERY PASSED')

        /* ---- ② 外域不泄露：平台无自身 baseURL 时绝不借用别的 provider 域名 ---- */
        calls.length = 0
        const noBase = await mod.queryBalanceForTest(ctx, false, 'other-provider', 'any-model', 'relay-nobase', null)
        assert.equal(noBase.ok, false, '无自身 baseURL 时 ok=false')
        assert.equal(noBase.reason, 'relay-endpoint-empty', '报 relay-endpoint-empty')
        assert.equal(calls.length, 0, '绝不向 other-provider 的域名发探测请求，实际 ' + calls.length)
        assert.equal(calls.some((one) => one.url.indexOf('other.example') !== -1), false, 'other.example 一次都没被请求')
        console.log('GENERIC RELAY FOREIGN-DOMAIN NO-LEAK PASSED')

        /* ---- ③ 重定向不跟随：3xx 直接失败，token 不带到 location 域 ---- */
        calls.length = 0
        const redirected = await mod.queryBalanceForTest(ctx, false, 'relay-redirect', 'any-model', null, null)
        assert.equal(redirected.ok, false, '全部 3xx 时 ok=false')
        assert.equal(redirected.reason, 'relay-endpoint-empty', '3xx 不解析出余额 ⇒ relay-endpoint-empty')
        assert.equal(calls.length, 7, '探测 7 个候选各一次，实际 ' + calls.length)
        assert.equal(calls.every((one) => one.redirect === 'manual'), true, '每个探测请求都必须 redirect=manual')
        assert.equal(calls.some((one) => one.url.indexOf('evil.example') !== -1), false, '绝不跟随 302 到 evil.example')
        console.log('GENERIC RELAY REDIRECT NO-LEAK PASSED')

        /* ---- ④ 同长度不同凭据不共享冷却：换 token（同长度）应重新探测 ---- */
        calls.length = 0
        const cool1 = await mod.queryBalanceForTest(ctx, false, 'relay-cool', 'any-model', null, null)
        assert.equal(cool1.ok, false, '第一次探测失败')
        assert.equal(calls.length, 7, '第一次失败探测 7 个候选，实际 ' + calls.length)
        calls.length = 0
        const cool2 = await mod.queryBalanceForTest(ctx, false, 'relay-cool', 'any-model', null, null)
        assert.equal(cool2.ok, false, '冷却期内仍失败')
        assert.equal(calls.length, 0, '同凭据冷却期内不重复探测，实际 ' + calls.length)
        /* 换成同长度（4 字符）但不同值的 token */
        secrets.set(refOf('relay-cool'), envelope('bbbb', 'cool-user'))
        calls.length = 0
        const cool3 = await mod.queryBalanceForTest(ctx, false, 'relay-cool', 'any-model', null, null)
        assert.equal(cool3.ok, false, '换凭据后仍失败')
        assert.equal(calls.length, 7, '同长度不同凭据必须重新探测（旧指纹只看长度会误共享冷却），实际 ' + calls.length)
        console.log('GENERIC RELAY CREDENTIAL-FINGERPRINT PASSED')

        /* ---- ⑤ 指纹本身：稳定、非明文、同长度不同值不同 ---- */
        const fp1 = mod.discoveryFingerprint('https://x', 'secret-token-abc', 'user-1')
        const fp2 = mod.discoveryFingerprint('https://x', 'secret-token-xyz', 'user-1')
        assert.match(fp1, /^[0-9a-f]{64}$/, '指纹是 64 位十六进制 sha256')
        assert.equal(fp1.indexOf('secret-token-abc'), -1, '指纹不含明文 token')
        assert.notEqual(fp1, fp2, '同长度不同 token 得到不同指纹')

        /* ---- ⑥ 冷却表容量上限：超过上限按插入顺序淘汰最旧的 ---- */
        const map = mod.relayDiscoveryFailuresForTest
        const max = mod.RELAY_DISCOVERY_FAILURES_MAX
        assert.ok(Number.isInteger(max) && max > 0, '冷却表上限是正整数: ' + max)
        map.clear()
        for (let i = 0; i < max + 20; i += 1) mod.recordRelayDiscoveryFailure('cap-' + String(i), 'fp-' + String(i), Date.now())
        assert.equal(map.size, max, '冷却表容量被限制在上限内，实际 ' + map.size)
        assert.equal(map.has('cap-0'), false, '最旧的条目被淘汰')
        assert.equal(map.has('cap-' + String(max + 19)), true, '最新条目保留')
        map.clear()
        console.log('GENERIC RELAY COOLDOWN-CAPACITY PASSED')
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      if (savedHome2 === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome2
      globalThis.setInterval = realSetInterval2
      fs.rmSync(home2, { recursive: true, force: true })
    }
  }


  /* ==================================================================
     ⑫ 用户真正改 endpoint/balancePath/balanceDivisor 时清除旧 balanceKind；
        无关局部更新（token/倍率/请求头等）保留
     ================================================================== */
  {
    const settings = mod.relaySettingsForTest
    assert.equal(typeof settings, 'function', 'relaySettings 需导出用于测试')
    const prev = {
      channelKey: 'relay-credits',
      endpoint: 'https://credits.example/v1/credits',
      tokenHeader: 'authorization',
      userIdHeader: 'x-user-id',
      tokenPrefix: 'Bearer ',
      balancePath: '$.balance',
      currency: 'CNY',
      feeMultiplier: 1,
      balanceDivisor: 1,
      balanceKind: 'credits',
      headerNames: [],
    }
    const body = (extra) => Object.assign({ channelKey: 'relay-credits' }, extra)
    const keep = (label, extra) => {
      const out = settings(body(extra), prev, [])
      assert.notEqual(out, null, label + '：应合并成功')
      assert.equal(out.balanceKind, 'credits', label + '：应保留 balanceKind')
    }
    const clear = (label, extra) => {
      const out = settings(body(extra), prev, [])
      assert.notEqual(out, null, label + '：应合并成功')
      assert.equal(out.balanceKind, undefined, label + '：应清除 balanceKind')
    }
    /* 无关字段更新：保留 */
    keep('只改费用倍率', { feeMultiplier: 2 })
    keep('只改 userIdHeader', { userIdHeader: 'New-Api-User' })
    keep('原样重存 endpoint/balancePath/balanceDivisor', { endpoint: prev.endpoint, balancePath: prev.balancePath, balanceDivisor: prev.balanceDivisor })
    /* 真正改变地址/解析字段：清除 */
    clear('改 endpoint', { endpoint: 'https://other.example/v1/credits' })
    clear('清空 endpoint', { endpoint: '' })
    clear('改 balancePath', { balancePath: 'data.quota' })
    clear('改 balanceDivisor', { balanceDivisor: 500000 })
    /* 显式指定 balanceKind：以显式值为准，不被自动清除逻辑覆盖 */
    const explicit = settings(body({ balanceKind: 'usage' }), prev, [])
    assert.notEqual(explicit, null, '显式 balanceKind 合并成功')
    assert.equal(explicit.balanceKind, 'usage', '显式 balanceKind 优先')
    /* 读取既有档案（previous=null）必须保留，不能因“和空 prior 比都算变化”而清掉 */
    const reread = settings(prev, null, prev.headerNames)
    assert.notEqual(reread, null, '读取既有档案成功')
    assert.equal(reread.balanceKind, 'credits', '读取既有档案时保留 balanceKind')
    console.log('GENERIC RELAY BALANCEKIND-MERGE PASSED')
  }

})().catch((error) => {
  console.error('GENERIC RELAY CHECKS FAILED: ' + (error !== null && error !== undefined && error.message ? error.message : error))
  process.exitCode = 1
})
