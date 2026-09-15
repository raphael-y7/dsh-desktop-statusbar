/**
 * dsh-desktop-statusbar — host 侧。
 *
 * 提供客户端拿不到的东西：
 *   1. `sessionModel` 投影 — 最近一条 assistant 消息实际使用的 provider/model。
 *   2. `sessionUsage` 投影 — 按模型聚合的 token 用量（总费用），外加 `last`
 *      （最近一条 assistant 消息的模型与用量，"本次费用"段用）。
 *   3. `sessionTimeRange` 投影 — 活跃时长：累加每个 step 的墙钟区间。
 *      （sessionStats 的 llmMs/toolMs 是各次调用耗时之和，同一 step 内并行调用会
 *      重复计入，因此可能大于墙钟时间；两者口径不同，不该相互比较。）
 *   4. `/dsh-desktop-statusbar/api/balance` — DeepSeek 账户余额。
 *
 * 凭据来源按可靠性依次尝试：环境变量 DEEPSEEK_API_KEY → `<DSH_HOME>/.credentials.yaml`
 * → `ctx.credentials`（本部署里 records 只有 client-connection 记录，故常为空）。
 * key 只在本进程内存中用于调用官方余额接口，不落盘、不转发、不写日志。
 *
 * @module dsh-desktop-statusbar
 */
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-desktop-statusbar'

export const inject = ['sessionProjections', 'webServer', 'credentials']

/** 投影 apply 拿不到 ctx，这里留一份引用给日志用（apply 时赋值）。 */
let ctxRef = null
let wireLogAt = -1

/* ------------------------------------------------------------------ 日志 */

function logHost(ctx, message) {
  try {
    if (ctx.logger !== undefined && ctx.logger !== null && typeof ctx.logger.info === 'function') {
      ctx.logger.info('[dsh-desktop-statusbar] ' + message)
      return
    }
    if (typeof ctx.logger === 'function') {
      const scoped = ctx.logger('dsh-desktop-statusbar')
      if (scoped !== undefined && scoped !== null && typeof scoped.info === 'function') {
        scoped.info(message)
        return
      }
    }
    if (typeof process !== 'undefined' && process.stderr !== undefined && typeof process.stderr.write === 'function') {
      process.stderr.write('[dsh-desktop-statusbar] ' + message + '\n')
    }
  } catch (error) {
    /* 日志失败不影响功能 */
  }
}

/* ------------------------------------------------------------ sessionModel */

const sessionModelSchema = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  updatedAt: z.number().nullable(),
}).strict()

const sessionModelProjection = {
  key: 'desktopStatusbarModel',
  stateSchema: sessionModelSchema,
  init: () => ({ provider: null, model: null, updatedAt: null }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state
    const source = event.data.message.source
    if (source.kind !== 'model') return state
    const { provider, model } = source
    if (provider === state.provider && model === state.model) return state
    return { provider, model, updatedAt: event.time }
  },
  wire: { viewSchema: sessionModelSchema, view: (state) => state },
  stateVersion: 1,
}

/* ------------------------------------------------------------ sessionUsage */

const usageBucket = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
}).strict()

/**
 * 从一条 assistant 事件里取 usage —— 与官方 usageSampleOf 同口径：
 * data.usage 只是兜底，stream 里 type==='usage' 的 chunk 才是权威值（后者会覆盖前者）。
 */
function findUsageInStream(stream) {
  if (stream === null || stream === undefined) return undefined
  let found
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object') return
    if (node.chunk !== null && node.chunk !== undefined && typeof node.chunk === 'object') {
      if (node.chunk.type === 'usage' && node.chunk.usage !== undefined) found = node.chunk.usage
      return
    }
    if (node.type === 'usage' && node.usage !== undefined) found = node.usage
  }
  visit(stream)
  return found
}

function usageOf(event) {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const data = event.data === null || event.data === undefined ? {} : event.data
  let usage = event.type === 'assistant/message' ? data.usage : undefined
  const fromStream = findUsageInStream(data.stream)
  if (fromStream !== undefined) usage = fromStream
  return usage
}

/** 取数值字段，兼容几种命名；取不到返回 0。 */
const numOf = (source, names) => {
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

/**
 * 把内核给的 TokenUsage 归一成计价分量。
 * inputTokens 是含缓存的总输入，未缓存部分要减掉 cacheRead / cacheWrite（与官方 tokenUsage 投影同口径）。
 */
function usageParts(usage) {
  const cacheRead = numOf(usage, ['cacheReadTokens', 'cachedReadTokens', 'cacheRead', 'cachedTokens'])
  const cacheWrite = numOf(usage, ['cacheWriteTokens', 'cacheWrite', 'cacheCreationTokens'])
  const totalInput = numOf(usage, ['inputTokens', 'promptTokens', 'input'])
  const output = numOf(usage, ['outputTokens', 'completionTokens', 'output'])
  return { input: Math.max(0, totalInput - cacheRead - cacheWrite), cacheRead, cacheWrite, output }
}

/** 一次模型调用的分量与发生时间，峰谷计价按它逐条判定。 */
const usageCall = z.object({
  at: z.number(),
  model: z.string(),
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
}).strict()

const lastUsage = z.object({
  provider: z.string(),
  model: z.string(),
  time: z.number(),
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
  calls: z.array(usageCall),
}).strict()

const MAX_CALLS = 4000
const appendCalls = (calls, more) =>
  calls.length + more.length <= MAX_CALLS ? calls.concat(more) : calls.slice(calls.length + more.length - MAX_CALLS).concat(more)

const sessionUsageSchema = z.object({
  models: z.record(z.string(), usageBucket),
  calls: z.array(usageCall),
    turn: z.number().nullable(),
  current: lastUsage.nullable(),
  last: lastUsage.nullable(),
}).strict()

const sessionUsageProjection = {
  key: 'desktopStatusbarUsage',
  stateSchema: sessionUsageSchema,
  init: () => ({ models: {}, calls: [], current: null, last: null, turn: null }),
  apply: (state, event) => {
    const calls = Array.isArray(state.calls) ? state.calls : []
    const turnOf = (event) => {
      const value = event.data === null || event.data === undefined ? undefined : event.data.turn
      return typeof value === 'number' ? value : null
    }
    const stateTurn = typeof state.turn === 'number' ? state.turn : null
    // 新一轮：上一轮结算进 last，本轮清空（不依赖 turn/start 事件）
    if (event.type === 'turn/start') {
      const started = turnOf(event)
      if (state.current === null) return { ...state, turn: started }
      return { ...state, calls, current: null, last: state.current, turn: started }
    }
    const usage = usageOf(event)
    if (usage === undefined || usage === null) return state
    const source = event.data.message.source
    if (source.kind !== 'model') return state
    const model = source.model
    const currentModel = state.models[model]
    const parts = usageParts(usage)
    const bucket = {
      input: (currentModel === undefined ? 0 : currentModel.input) + parts.input,
      cacheRead: (currentModel === undefined ? 0 : currentModel.cacheRead) + parts.cacheRead,
      cacheWrite: (currentModel === undefined ? 0 : currentModel.cacheWrite) + parts.cacheWrite,
      output: (currentModel === undefined ? 0 : currentModel.output) + parts.output,
    }
    const one = {
      at: event.time,
      model,
      input: parts.input,
      cacheRead: parts.cacheRead,
      cacheWrite: parts.cacheWrite,
      output: parts.output,
    }
    const turn = turnOf(event)
    if (calls.length < 5) {
      logHost(ctxRef, 'usage sample: turn=' + String(turn) + ' model=' + String(model)
        + ' parts=' + JSON.stringify(parts)
        + ' keys=' + (usage !== null && typeof usage === 'object' ? Object.keys(usage).join('|') : typeof usage))
    }
    // 轮次变化就重开本轮汇总：不能假设一定有 turn/start
    const sameTurn = state.current !== null && Array.isArray(state.current.calls)
      && (turn === null || stateTurn === null || turn === stateTurn)
    const prev = sameTurn ? state.current : null
    const callsForTurn = prev === null ? [] : prev.calls
    const summary = {
      provider: source.provider,
      model,
      time: event.time,
      input: (prev === null ? 0 : prev.input) + one.input,
      cacheRead: (prev === null ? 0 : prev.cacheRead) + one.cacheRead,
      cacheWrite: (prev === null ? 0 : prev.cacheWrite) + one.cacheWrite,
      output: (prev === null ? 0 : prev.output) + one.output,
    }
    const current = { ...summary, calls: callsForTurn.concat([one]) }
    return {
      ...state,
      turn: turn === null ? stateTurn : turn,
      calls: appendCalls(calls, [one]),
      current,
      // 轮次变化时把上一轮结算进 last
      last: prev === null && state.current !== null ? state.current : state.last,
      models: { ...state.models, [model]: bucket },
    }
  },
  wire: {
    viewSchema: sessionUsageSchema,
    view: (state) => {
      if (state !== null && state !== undefined) {
        const calls = Array.isArray(state.calls) ? state.calls : []
        // 只在条数变化时打一行，避免每次推送都刷日志
        if (calls.length !== wireLogAt) {
          wireLogAt = calls.length
          const last = calls.length === 0 ? null : calls[calls.length - 1]
          logHost(ctxRef, 'wire view: calls=' + String(calls.length)
            + ' modelsAgg=' + JSON.stringify(state.models)
            + ' lastCall=' + JSON.stringify(last)
            + ' currentCalls=' + String(state.current === null || state.current === undefined || !Array.isArray(state.current.calls) ? 0 : state.current.calls.length))
        }
      }
      return state
    },
  },
  // schema 加了 current（本轮累计），提升版本以重建旧状态。
  stateVersion: 3,
}

/* -------------------------------------------------------- sessionTimeRange */

const sessionTimeRangeSchema = z.object({
  turns: z.number(),
  since: z.number().nullable(),
  steps: z.number(),
  stepSince: z.number().nullable(),
}).strict()

/**
 * 总用时 = 各轮墙钟时长之和，与官方"本轮总用时"同一口径。
 * 一轮 = turn/start → turn/end，包含轮内各 step 之间的间隙（工具调用、排队等），
 * 所以它必然大于等于各 step 时长之和。
 * 另外单独累加一份 step 之和作兜底，以防某个内核不发 turn 事件。
 */
const sessionTimeRangeProjection = {
  key: 'desktopStatusbarActiveTime',
  stateSchema: sessionTimeRangeSchema,
  init: () => ({ turns: 0, since: null, steps: 0, stepSince: null }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      if (state.since !== null) return state
      return { turns: state.turns, since: event.time, steps: state.steps, stepSince: state.stepSince }
    }
    if (event.type === 'turn/end') {
      if (state.since === null) return state
      return {
        turns: state.turns + Math.max(0, event.time - state.since),
        since: null,
        steps: state.steps,
        stepSince: state.stepSince,
      }
    }
    if (event.type === 'step/start') {
      if (state.stepSince !== null) return state
      return { turns: state.turns, since: state.since, steps: state.steps, stepSince: event.time }
    }
    if (event.type === 'step/end') {
      if (state.stepSince === null) return state
      return {
        turns: state.turns,
        since: state.since,
        steps: state.steps + Math.max(0, event.time - state.stepSince),
        stepSince: null,
      }
    }
    return state
  },
  wire: { viewSchema: sessionTimeRangeSchema, view: (state) => state },
  // 字段变了（active → turns + steps），提升版本重建旧状态
  stateVersion: 2,
}

/* ---------------------------------------------------------------- 余额查询 */

const BALANCE_TTL_MS = 60 * 1000
let balanceCache = { at: 0, value: null }

/** 最近一次由底栏上报的会话模型（设置页是全局槽，读不到会话投影，只能这么拿）。 */
let activeModel = { provider: null, model: null, at: 0 }

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(text)
}

/** 读一小段 JSON 请求体（只用于本插件自己的上报接口，超过 4KB 直接断开）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4096) {
        req.destroy()
        finish(null)
      }
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw)
        finish(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch (error) {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

/** 环境变量是最高优先级的来源。 */
function keyFromEnv() {
  const value = process.env.DEEPSEEK_API_KEY
  return typeof value === 'string' && value.length > 10 ? value : null
}

/**
 * `<DSH_HOME>/.credentials.yaml`。该文件的 records 在本部署里只有
 * client-connection 记录，真正的 key 由 refs 段的 DEEPSEEK_API_KEY 引用，
 * 因此直接按名字匹配取值，必要时退回 records 里的 secret。
 */
function keyFromCredentialsFile() {
  try {
    const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const patterns = [
      /DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s#]+)["']?/,
      /SECRET\s*:\s*["']?([^"'\s#]+)["']?/i,
      /secret\s*:\s*["']?([^"'\s#]+)["']?/,
    ]
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (match !== null && typeof match[1] === 'string' && match[1].length > 10) return match[1]
    }
  } catch (error) {
    /* 文件缺失或不可读 */
  }
  return null
}

function keyFromCredentialStore(ctx) {
  const store = ctx.credentials
  if (store === undefined || store === null) return null
  const ids = []
  try {
    for (const id of Object.keys(store)) ids.push(id)
  } catch (error) {
    /* ignore */
  }
  if (ids.length === 0) ids.push('deepseek-official', 'deepseek')
  for (const id of ids) {
    let credential
    try {
      credential = typeof store.get === 'function' ? store.get(id) : undefined
      if (credential === undefined && typeof store.read === 'function') credential = store.read(id)
    } catch (error) {
      continue
    }
    if (credential === undefined || credential === null) continue
    const payload = credential.payload !== undefined && credential.payload !== null ? credential.payload : credential
    const found = payload.secret ?? payload.apiKey ?? payload.api_key ?? payload.key ?? payload.token
    if (typeof found === 'string' && found.length > 10) return found
  }
  return null
}

function findApiKey(ctx) {
  const fromEnv = keyFromEnv()
  if (fromEnv !== null) return { key: fromEnv, source: 'env' }
  const fromFile = keyFromCredentialsFile()
  if (fromFile !== null) return { key: fromFile, source: 'credentials.yaml' }
  const fromStore = keyFromCredentialStore(ctx)
  if (fromStore !== null) return { key: fromStore, source: 'credentials-service' }
  return { key: null, source: null }
}

async function queryBalance(ctx, force) {
  const now = Date.now()
  if (force !== true && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.value
  }

  const found = findApiKey(ctx)
  if (found.key === null) {
    const missing = { ok: false, at: now, reason: 'no-credential' }
    logHost(ctx, 'balance: 环境变量 / credentials.yaml / credentials 服务都没取到 key')
    balanceCache = { at: now, value: missing }
    return missing
  }

  logHost(ctx, 'balance: 使用来源 ' + String(found.source) + ' 的 key 查询余额')

  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + found.key, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      const failed = { ok: false, at: now, reason: 'http-' + String(response.status), source: found.source }
      logHost(ctx, 'balance: HTTP ' + String(response.status))
      balanceCache = { at: now, value: failed }
      return failed
    }
    const data = await response.json()
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const picked = infos.filter((info) => info.currency === 'CNY')[0] ?? infos[0]
    if (picked === undefined) {
      const empty = { ok: false, at: now, reason: 'no-balance-info', source: found.source }
      logHost(ctx, 'balance: 响应里没有 balance_infos')
      balanceCache = { at: now, value: empty }
      return empty
    }
    const value = {
      ok: true,
    at: now,
    at: now,
      source: found.source,
      currency: picked.currency ?? 'CNY',
      total: picked.total_balance ?? null,
      granted: picked.granted_balance ?? null,
      toppedUp: picked.topped_up_balance ?? null,
      available: data.is_available === true,
    }
    logHost(ctx, 'balance: OK ' + String(value.total) + ' ' + String(value.currency))
    balanceCache = { at: now, value }
    return value
  } catch (error) {
    const detail = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : 'request-failed'
    const failed = { ok: false, at: now, reason: 'request-failed', detail, source: found.source }
    logHost(ctx, 'balance: 请求异常 ' + detail)
    balanceCache = { at: now, value: failed }
    return failed
  }
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx) {
  ctxRef = ctx
  ctx.effect(
    () => ctx.sessionProjections.register(sessionModelProjection),
    'dsh-desktop-statusbar: sessionModel projection',
  )
  ctx.effect(
    () => ctx.sessionProjections.register(sessionUsageProjection),
    'dsh-desktop-statusbar: sessionUsage projection',
  )
  ctx.effect(
    () => ctx.sessionProjections.register(sessionTimeRangeProjection),
    'dsh-desktop-statusbar: sessionTimeRange projection',
  )

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-desktop-statusbar/api',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/dsh-desktop-statusbar/api/prices') {
        sendJson(res, 200, {
          models: {
            'deepseek-flash': {
              peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
              offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
            },
            'deepseek-v4-pro': {
              peak: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
              offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
            },
          },
          note: 'CNY per 1M tokens, 高峰=北京时间周一至周五 9-12、14-18',
        })
        return
      }
      if (url.pathname === '/dsh-desktop-statusbar/api/active-model') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const model = body !== null && typeof body.model === 'string' ? body.model.trim() : ''
          if (model.length === 0) {
            sendJson(res, 400, { ok: false, reason: 'model-required' })
            return
          }
          activeModel = {
            provider: typeof body.provider === 'string' && body.provider.length > 0 ? body.provider : null,
            model: model,
            at: Date.now(),
          }
          sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 200, {
          ok: true,
          provider: activeModel.provider,
          model: activeModel.model,
          at: activeModel.at,
        })
        return
      }
      if (url.pathname !== '/dsh-desktop-statusbar/api/balance') {
        sendJson(res, 404, { ok: false, reason: 'not-found' })
        return
      }
      const force = url.searchParams.get('force') === '1'
      const value = await queryBalance(ctx, force)
      sendJson(res, 200, value)
    },
  }), 'dsh-desktop-statusbar: balance api')
}
