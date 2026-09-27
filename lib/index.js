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
 *   4. `sessionTiming` 投影 — 逐次模型调用的首字延迟与输出速度极值（最快/最慢）。
 *      官方 sessionStats 只有累计值（ttftMs/ttftSteps、decodeMs/decodeTokens），
 *      单次极值推不出来，所以这里按同一套事件口径自己折一份。
 *   5. `/dsh-desktop-statusbar/api/balance` — DeepSeek 账户余额（含充值与赠金两项）。
 *   6. `/dsh-desktop-statusbar/api/holidays` — 抓国务院的放假通知，解析出放假日。
 *      （客户端跨域抓不到 gov.cn，只能由 host 代抓；正文解析在 lib/holiday.js。）
 *
 * 凭据来源按可靠性依次尝试：环境变量 DEEPSEEK_API_KEY → `<DSH_HOME>/.credentials.yaml`
 * → `ctx.credentials`（本部署里 records 只有 client-connection 记录，故常为空）。
 * key 只在本进程内存中用于调用官方余额接口，不落盘、不转发、不写日志。
 *
 * @module dsh-desktop-statusbar
 */
import { z } from 'zod'
import { holidayHtmlToText, parseHolidayNotice } from './holiday.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-desktop-statusbar'

export const inject = ['sessionProjections', 'webServer', 'credentials']

/** 投影 apply 拿不到 ctx，这里留一份引用给日志用（apply 时赋值）。 */
let ctxRef = null

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
 * inputTokens 本身就是"未命中缓存的输入"（缓存命中单列在 cacheReadTokens、缓存写入单列在 cacheWriteTokens，
 * 与官方 tokenUsage 投影的 uncachedInputTokens 同口径），所以这里不再去减缓存。
 * 早先按"含缓存的总输入"处理、减掉 cacheRead，结果未命中输入少了三成（1.22M vs 官方 1.80M），会话总计跟着少算。
 */
function usageParts(usage) {
  const cacheRead = numOf(usage, ['cacheReadTokens', 'cachedReadTokens', 'cacheRead', 'cachedTokens'])
  const cacheWrite = numOf(usage, ['cacheWriteTokens', 'cacheWrite', 'cacheCreationTokens'])
  const input = numOf(usage, ['inputTokens', 'promptTokens', 'input'])
  const output = numOf(usage, ['outputTokens', 'completionTokens', 'output'])
  return { input, cacheRead, cacheWrite, output }
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
    view: (state) => state,
  },
  // schema 加了 current（本轮累计），提升版本以重建旧状态。
  // 3 → 4：历史缓存里有按旧口径算出来的逐条/本轮用量（未缓存输入少掉一截），
  // 界面上的「本轮」因此与「总计」对不上，提升版本强制从事件日志重放。
  stateVersion: 4,
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

/* ---------------------------------------------------------- sessionTiming */

/**
 * 做「最快/最慢」需要的逐次调用计时。官方 `sessionStats` 只给累计值
 * （ttftMs/ttftSteps、decodeMs/decodeTokens），推不出单次极值，所以在 host 侧
 * 按同一套事件口径自己折一份：`step/start` → 首个 token 分片 → `assistant/message`。
 *
 * 首字极值与官方口径完全一致（工具调用的分片也算首 token）。
 * 速度极值额外排除「首 token 就是工具调用分片」的步骤：实测这类步骤的分片时间戳
 * 全挤在同一刻（一次 72 tokens 的调用，窗口只有 3ms），算出来的 tps 是几万这种假值；
 * 有思考或文字输出的步骤，窗口才反映真实生成时长。
 */
const timingMark = z.object({
  /* 首字极值单位是毫秒，速度极值单位是 tokens/秒，看字段名区分 */
  value: z.number(),
  at: z.number(),
  model: z.string(),
}).strict()

const timingStep = z.object({
  turn: z.number(),
  step: z.number(),
  startTime: z.number(),
  firstTokenTime: z.number().nullable(),
  /* 首 token 是不是工具调用分片（速度极值据此排除） */
  firstTokenTool: z.boolean(),
}).strict()

const timingViewSchema = z.object({
  samples: z.number().int().nonnegative(),
  fastestTtft: timingMark.nullable(),
  slowestTtft: timingMark.nullable(),
  fastestTps: timingMark.nullable(),
  slowestTps: timingMark.nullable(),
  /* 本轮累计：气泡里"本轮平均首字 / 本轮平均速度"要用（官方投影只有会话累计值） */
  turn: z.number().nullable(),
  turnTtftMs: z.number().nonnegative(),
  turnTtftSamples: z.number().int().nonnegative(),
  turnDecodeMs: z.number().nonnegative(),
  turnDecodeTokens: z.number().nonnegative(),
}).strict()

const sessionTimingSchema = timingViewSchema.extend({ openStep: timingStep.nullable() }).strict()

/**
 * 一个分片携带首 token 时属于哪一类：文本与思考增量算 `text`，工具调用参数算 `tool`。
 * 判定规则与 dsh-llm 的 isTokenDelta 相同，只是多返回一个类别。
 */
function tokenChunkKind(chunk) {
  if (chunk === null || chunk === undefined || typeof chunk !== 'object') return null
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return typeof chunk.text === 'string' && chunk.text.length > 0 ? 'text' : null
  }
  if (chunk.type === 'tool-call-delta') {
    const carries = (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.length > 0) || chunk.name !== undefined
    return carries ? 'tool' : null
  }
  return null
}

/** 打包 run（text-chunks / reasoning-chunks / tool-call-chunks）里第一个非空分片。 */
function packedRunToken(run) {
  const isTool = run.type === 'tool-call-chunks'
  const fragments = isTool ? run.args : run.texts
  if (Array.isArray(fragments) !== true || typeof run.time0 !== 'number') return undefined
  if (isTool && run.name !== undefined) return { time: run.time0, tool: true }
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) {
      const gap = Array.isArray(run.dt) && typeof run.dt[index - 1] === 'number' ? run.dt[index - 1] : 0
      time += gap
    }
    if (fragments[index] !== '') return { time: time, tool: isTool }
  }
  return undefined
}

/** 一次流式回答里首个 token 的时间与类别；紧凑记录与裸分片都认，读不出来返回 undefined。 */
function firstStreamToken(stream) {
  if (Array.isArray(stream) !== true) return undefined
  for (const record of stream) {
    if (record === null || record === undefined || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      const kind = tokenChunkKind(record.chunk)
      if (kind !== null && typeof record.time === 'number') return { time: record.time, tool: kind === 'tool' }
      continue
    }
    /* 实时事件里也可能直接给裸分片 */
    const bareKind = tokenChunkKind(record)
    if (bareKind !== null) {
      return typeof record.time === 'number' ? { time: record.time, tool: bareKind === 'tool' } : undefined
    }
    const packed = packedRunToken(record)
    if (packed !== undefined) return packed
  }
  return undefined
}

/** 该步上报的输出 token 数；缺字段或非法值返回 null（这一步就不参与速度极值）。 */
function stepOutputTokens(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const pickSmaller = (current, candidate) => (current === null || candidate.value < current.value ? candidate : current)
const pickLarger = (current, candidate) => (current === null || candidate.value > current.value ? candidate : current)

const sessionTimingProjection = {
  key: 'desktopStatusbarTiming',
  stateSchema: sessionTimingSchema,
  init: () => ({
    samples: 0,
    fastestTtft: null,
    slowestTtft: null,
    fastestTps: null,
    slowestTps: null,
    turn: null,
    turnTtftMs: 0,
    turnTtftSamples: 0,
    turnDecodeMs: 0,
    turnDecodeTokens: 0,
    openStep: null,
  }),
  apply: (state, event) => {
    if (event.type === 'step/start') {
      /* 换轮就把本轮累计清零：气泡里的"本轮平均…"只算当前这一轮 */
      const turn = event.data.turn
      const sameTurn = state.turn === turn
      return {
        ...state,
        turn: turn,
        turnTtftMs: sameTurn ? state.turnTtftMs : 0,
        turnTtftSamples: sameTurn ? state.turnTtftSamples : 0,
        turnDecodeMs: sameTurn ? state.turnDecodeMs : 0,
        turnDecodeTokens: sameTurn ? state.turnDecodeTokens : 0,
        openStep: {
          turn: event.data.turn, step: event.data.step, startTime: event.time,
          firstTokenTime: null, firstTokenTool: false,
        },
      }
    }
    if (event.type === 'assistant/attempt') {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
      const first = firstStreamToken(event.data.stream)
      if (open.firstTokenTime !== null || first === undefined) return state
      return { ...state, openStep: { ...open, firstTokenTime: first.time, firstTokenTool: first.tool === true } }
    }
    if (event.type === 'assistant/message') {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
      const fromStream = open.firstTokenTime === null ? firstStreamToken(event.data.stream) : undefined
      const first = open.firstTokenTime !== null
        ? { time: open.firstTokenTime, tool: open.firstTokenTool === true }
        : fromStream
      const next = { ...state, openStep: null }
      if (first === undefined) return next
      const source = event.data.message === null || event.data.message === undefined ? null : event.data.message.source
      const model = source !== null && source !== undefined && typeof source.model === 'string' ? source.model : ''
      const ttft = Math.max(0, first.time - open.startTime)
      next.samples = state.samples + 1
      next.fastestTtft = pickSmaller(state.fastestTtft, { value: ttft, at: event.time, model })
      next.slowestTtft = pickLarger(state.slowestTtft, { value: ttft, at: event.time, model })
      next.turnTtftMs = state.turnTtftMs + ttft
      next.turnTtftSamples = state.turnTtftSamples + 1
      const output = stepOutputTokens(event.data.usage)
      const decode = Math.max(0, event.time - first.time)
      /* 纯工具调用的步骤不进速度极值：分片时间戳挤在同一刻，算出来是假值（首字照旧统计） */
      if (output !== null && decode > 0 && first.tool !== true) {
        const speed = { value: output / (decode / 1000), at: event.time, model }
        next.fastestTps = pickLarger(state.fastestTps, speed)
        next.slowestTps = pickSmaller(state.slowestTps, speed)
        next.turnDecodeMs = state.turnDecodeMs + decode
        next.turnDecodeTokens = state.turnDecodeTokens + output
      }
      return next
    }
    if (event.type === 'step/end' || event.type === 'turn/end') {
      /* 取消或失败的步骤不会组装 message，边界要清掉，免得下一个 step 认错起点 */
      return state.openStep === null ? state : { ...state, openStep: null }
    }
    return state
  },
  wire: {
    viewSchema: timingViewSchema,
    view: (state) => ({
      samples: state.samples,
      fastestTtft: state.fastestTtft,
      slowestTtft: state.slowestTtft,
      fastestTps: state.fastestTps,
      slowestTps: state.slowestTps,
      turn: state.turn,
      turnTtftMs: state.turnTtftMs,
      turnTtftSamples: state.turnTtftSamples,
      turnDecodeMs: state.turnDecodeMs,
      turnDecodeTokens: state.turnDecodeTokens,
    }),
  },
  stateVersion: 3,
}

/* ---------------------------------------------------------------- 余额查询 */

/* 不缓存余额：每次请求都问一次官方账号服务，和设置页「账号与余额」打开时的取值节奏一致。
 * 之前这里是 60 秒缓存，叠上客户端 60 秒轮询，底栏最坏会落后近两分钟。 */
const BALANCE_TTL_MS = 0
let balanceCache = { at: 0, value: null }

/* 诊断：account 服务的探测结论，随 /api/balance 一起返回（客户端不读它，只用来查为什么回退）。 */
let accountProbeNote = '未探测'

/** 把异常压成一行可读文本。 */
function probeDetail(error) {
  if (error === null || error === undefined) return 'unknown'
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  return String(error)
}

/**
 * 余额数字对齐官方设置页的显示规则：向下截断到分（不是四舍五入），千分位分组。
 * 官方那套是 `value.round(2, Big.roundDown).toFixed(2)`，这里改用字符串截断，避免浮点误差。
 * 例：0.906619 → "0.90"、0.9984342400000000 → "0.99"、0 → "0.00"。
 */
function formatBalanceAmount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0.00'
  const text = Math.abs(n).toFixed(8)
  const dot = text.indexOf('.')
  const whole = dot < 0 ? text : text.slice(0, dot)
  const cents = dot < 0 ? '00' : text.slice(dot + 1, dot + 3)
  return (n < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + cents
}

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

/**
 * 官方账号服务里的余额（设置页「账号与余额」用的就是它）：
 * getBalance 返回充值钱包 value[] 与赠金钱包 bonusWallets[]，两者相加正是底栏要的"充值 + 赠送"合计。
 * 服务取不到、账号未登录或调用抛错，一律返回 null，交给下面 API key 的余额接口兜底。
 */
async function queryAccountBalance(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') {
    accountProbeNote = 'ctx.get 不可用'
    return null
  }
  let account = null
  try {
    account = ctx.get('deepseekAccount')
  } catch (error) {
    accountProbeNote = 'ctx.get("deepseekAccount") 抛错: ' + probeDetail(error)
    return null
  }
  if (account === null || account === undefined) {
    try {
      account = ctx.get('accountController')
    } catch (error) {
      account = null
    }
    if (account === null || account === undefined) {
      accountProbeNote = 'deepseekAccount 与 accountController 都取不到'
      return null
    }
    accountProbeNote = '只取到 accountController'
  } else {
    const proto = Object.getPrototypeOf(account)
    const names = proto === null || proto === undefined ? [] : Object.getOwnPropertyNames(proto)
    accountProbeNote = '取到 deepseekAccount，方法: ' + names.filter((one) => one !== 'constructor').slice(0, 12).join('/')
  }
  if (typeof account.getBalance !== 'function') {
    accountProbeNote += '（没有 getBalance）'
    return null
  }
  try {
    const result = await account.getBalance({ version: '1', locale: 'zh', timezoneOffsetSeconds: 8 * 3600 })
    if (result === null || result === undefined) {
      accountProbeNote += ' → getBalance 返回空'
      return null
    }
    if (result.status !== 'ready') {
      accountProbeNote += ' → status=' + String(result.status)
      return null
    }
    const wallets = Array.isArray(result.value) ? result.value : []
    const bonuses = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
    const pickCny = (list) => list.filter((one) => one !== null && typeof one === 'object' && one.currency === 'CNY')[0] ?? list[0]
    const main = pickCny(wallets)
    if (main === undefined || typeof main.balance !== 'string') {
      accountProbeNote += ' → 没有余额钱包'
      return null
    }
    const bonus = pickCny(bonuses)
    const total = (Number(main.balance) || 0) + (bonus === undefined ? 0 : (Number(bonus.balance) || 0))
    const value = {
      ok: true,
      at: Date.now(),
      source: 'account-service',
      currency: main.currency ?? 'CNY',
      /* 显示规则与设置页一致：截断到分；不足一分单独标出来（官方显示 <¥0.01） */
      total: formatBalanceAmount(total),
      subCent: total > 0 && total < 0.01,
      granted: bonus === undefined ? '0.00' : formatBalanceAmount(Number(bonus.balance) || 0),
      toppedUp: formatBalanceAmount(Number(main.balance) || 0),
      available: true,
    }
    accountProbeNote = 'account 服务可用'
    logHost(ctx, 'balance: account 服务 OK ' + value.total + ' ' + value.currency)
    return value
  } catch (error) {
    const detail = probeDetail(error)
    accountProbeNote += ' → 调用抛错: ' + detail
    logHost(ctx, 'balance: account 服务不可用，回退 API key：' + detail)
    return null
  }
}

async function queryBalance(ctx, force) {
  const now = Date.now()
  if (force !== true && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.value
  }

  /* 先问官方账号服务：与设置页同一份数据（充值 + 赠金），拿不到才走下面的 API key 查询 */
  const fromAccount = await queryAccountBalance(ctx)
  if (fromAccount !== null) {
    balanceCache = { at: now, value: fromAccount }
    return fromAccount
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
      source: found.source,
      currency: picked.currency ?? 'CNY',
      /* 与账号服务那条路同一套显示规则：截断到分，不足一分单独标出 */
      total: formatBalanceAmount(picked.total_balance),
      subCent: Number(picked.total_balance) > 0 && Number(picked.total_balance) < 0.01,
      granted: picked.granted_balance === undefined || picked.granted_balance === null ? '0.00' : formatBalanceAmount(picked.granted_balance),
      toppedUp: picked.topped_up_balance === undefined || picked.topped_up_balance === null ? '0.00' : formatBalanceAmount(picked.topped_up_balance),
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

/* ------------------------------------------------------------ 节假日抓取 */

const GOV_SEARCH_URL = 'https://sousuo.www.gov.cn/search-gov/data'
const GOV_TITLE_PREFIX = '国务院办公厅关于'
const HOLIDAY_FETCH_TIMEOUT_MS = 15000
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

/**
 * 抓「国务院办公厅关于<year>年部分节假日安排的通知」并解析出放假日。
 * 两步：先走政府网政策文件库的搜索接口拿通知页 URL，再取正文解析（解析在 lib/holiday.js）。
 * 未发布、HTTP 失败、解析为空都返回 { ok: false, reason }，交给客户端提示后重试。
 */
async function fetchHolidayDays(year) {
  const title = GOV_TITLE_PREFIX + String(year) + '年部分节假日安排的通知'
  const search = new URL(GOV_SEARCH_URL)
  search.searchParams.set('t', 'zhengcelibrary_gw')
  search.searchParams.set('q', title)
  search.searchParams.set('searchfield', 'title')
  search.searchParams.set('p', '1')
  search.searchParams.set('n', '5')
  search.searchParams.set('sort', 'score')
  search.searchParams.set('sortType', '1')
  const headers = { 'user-agent': BROWSER_UA }
  /* 每次请求各自设超时：AbortSignal 不能复用 */
  const timeout = () => AbortSignal.timeout(HOLIDAY_FETCH_TIMEOUT_MS)

  const found = await fetch(search.toString(), { headers, signal: timeout() })
  if (found.ok !== true) return { ok: false, reason: 'search-http-' + String(found.status) }
  const payload = await found.json()
  const list = payload !== null && payload !== undefined && payload.searchVO !== null && payload.searchVO !== undefined
    && Array.isArray(payload.searchVO.listVO)
    ? payload.searchVO.listVO
    : []
  /* 搜索是按相关度排的，标题里必须正好有这一年的年份，否则宁可当没搜到。
     标题可能带 <em> 高亮标签，比较前先剥掉。 */
  const wanted = String(year) + '年部分节假日安排'
  const plainTitle = (item) => String(item.title).replace(/<[^>]+>/g, '')
  const hit = list.filter((item) => item !== null && typeof item === 'object'
    && typeof item.title === 'string' && plainTitle(item).indexOf(wanted) !== -1
    && typeof item.url === 'string')[0]
  if (hit === undefined) return { ok: false, reason: 'not-found' }

  const page = await fetch(hit.url, { headers, signal: timeout() })
  if (page.ok !== true) return { ok: false, reason: 'page-http-' + String(page.status) }
  const days = parseHolidayNotice(holidayHtmlToText(await page.text()), year)
  if (days.length === 0) return { ok: false, reason: 'parse-empty' }
  return { ok: true, year, days, title: plainTitle(hit), source: hit.url }
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
  ctx.effect(
    () => ctx.sessionProjections.register(sessionTimingProjection),
    'dsh-desktop-statusbar: sessionTiming projection',
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
          note: 'CNY per 1M tokens, 高峰=北京时间周一至周五 9-12、14-18（法定节假日与周末全天按空闲价）',
        })
        return
      }
      if (url.pathname === '/dsh-desktop-statusbar/api/holidays') {
        const raw = url.searchParams.get('year')
        const year = raw === null ? NaN : Number(raw)
        if (Number.isInteger(year) !== true || year < 2020 || year > 2100) {
          sendJson(res, 400, { ok: false, reason: 'bad-year' })
          return
        }
        try {
          const result = await fetchHolidayDays(year)
          if (result.ok === true) logHost(ctxRef, 'holidays: ' + String(year) + ' 年 ' + String(result.days.length) + ' 天')
          sendJson(res, 200, result)
        } catch (error) {
          const detail = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : 'fetch-failed'
          logHost(ctxRef, 'holidays: 抓取失败 ' + detail)
          sendJson(res, 200, { ok: false, reason: 'fetch-failed' })
        }
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
      sendJson(res, 200, Object.assign({}, value, { probe: accountProbeNote }))
    },
  }), 'dsh-desktop-statusbar: balance api')
}
