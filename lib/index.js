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
 *   5. `/dsh-desktop-statusbar/api/balance` — 当前会话实际计费通道的账户余额。
 *      DeepSeek 有两条通道：`deepseek-account`（登录账号额度）与 `deepseek-official`
 *      （模型页那把 API key 的账户），按会话实际用的 provider 选，互不顶替；
 *      其它平台（GLM、Kimi、OpenRouter 等）按其适配器的端点与字段查。
 *   6. `/dsh-desktop-statusbar/api/daily-usage` — 本周（周一 00:00 起）每天的 token 用量。
 *      来源是一份本地台账：每分钟把会话日志里新产生的用量并进去，会话被删除后已记下的
 *      数字仍然保留。只取 token 数字，不读正文。
 *   7. `/dsh-desktop-statusbar/api/holidays` — 抓国务院的放假通知，解析出放假日。
 *      （客户端跨域抓不到 gov.cn，只能由 host 代抓；正文解析在 lib/holiday.js。）
 *
 * 凭据来源：DeepSeek 走 `ctx.credentials`（模型页写入的权威来源），退回环境变量
 * DEEPSEEK_API_KEY 与 `<DSH_HOME>/.credentials.yaml`；其它平台按适配器的 refs 逐个解析。
 * key 只在本进程内存中用于调用对应平台的余额接口，不落盘、不转发、不写日志。
 *
 * @module dsh-desktop-statusbar
 */
import { z } from 'zod'
import { adapterFor } from './balance-api.js'
import { holidayHtmlToText, parseHolidayNotice } from './holiday.js'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import * as zlib from 'node:zlib'

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

/* ------------------------------------------------------------ sessionCapacity */

const sessionCapacitySchema = z.object({
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  updatedAt: z.number().nullable(),
}).strict()

/**
 * 上下文压缩的触发点要两个入参，它们只出现在请求事件里：
 *   request/header   → data.header.config.maxTokens（本次请求的输出上限，随推理档位浮动）
 *   request/context  → data.contextWindow（只在 provider/model/窗口变化时才记，比 header 稀疏得多）
 * 两者都得折：少一个客户端就算不出压缩点，圆环上就不开缺口。
 */
const sessionCapacityProjection = {
  key: 'desktopStatusbarCapacity',
  stateSchema: sessionCapacitySchema,
  init: () => ({ contextWindow: null, maxOutputTokens: null, updatedAt: null }),
  apply: (state, event) => {
    const data = event.data === undefined || event.data === null ? {} : event.data
    let contextWindow = state.contextWindow
    let maxOutputTokens = state.maxOutputTokens
    if (event.type === 'request/context') {
      if (typeof data.contextWindow !== 'number') return state
      contextWindow = data.contextWindow
    } else if (event.type === 'request/header') {
      const config = data.header === undefined || data.header === null ? null : data.header.config
      if (config === null || typeof config.maxTokens !== 'number') return state
      maxOutputTokens = config.maxTokens
    } else {
      return state
    }
    if (contextWindow === state.contextWindow && maxOutputTokens === state.maxOutputTokens) return state
    return { contextWindow, maxOutputTokens, updatedAt: event.time }
  },
  wire: { viewSchema: sessionCapacitySchema, view: (state) => state },
  stateVersion: 1,
}

/* -------------------------------------------------------- sessionProgress */

/** 一次压缩落在哪一轮哪一步（压缩事件只带轮号，步号取压缩前最后一步；取不到给 null）。 */
const compactMark = z.object({
  turn: z.number(),
  step: z.number().nullable(),
}).strict()

const sessionProgressSchema = z.object({
  turn: z.number(),
  turnSteps: z.number(),
  toolCalls: z.number(),
  /* 工具名 → 调用次数：气泡里「工具调用」那一行点开要逐个列出来 */
  toolCounts: z.record(z.string(), z.number()),
  skills: z.array(z.string()),
  /* 注入进会话的全局提示词文件名（~/.dsh/AGENTS.md → 'AGENTS.md'）；没注入给 null */
  globalInstruction: z.string().nullable(),
  compactCount: z.number(),
  compactTurn: z.number().nullable(),
  compactStep: z.number().nullable(),
  /* 每一次压缩的落点，按发生顺序排：气泡里「上下文压缩」那一行点开逐条列 */
  compacts: z.array(compactMark),
}).strict()

/** 从 skill 工具的参数里取技能名；参数是 JSON 字符串，坏掉就当没这个名字。 */
function skillNameOf(data) {
  let args = data.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch (error) {
      return null
    }
  }
  if (args === null || args === undefined || typeof args !== 'object') return null
  return typeof args.name === 'string' && args.name.length > 0 ? args.name : null
}

/**
 * 全局提示词是靠 agent-instructions 注入的一条 user/message 进来的，source 形如：
 *   { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set',
 *     scope: 'user-global\u0000AGENTS.md', path: '~/.dsh/AGENTS.md', digest: '…' }] }
 * 只认 user-global 作用域（项目的 AGENTS.md 不算「全局提示词」），名字取路径的文件名。
 */
function globalInstructionOf(data) {
  if (data === null || data === undefined) return null
  const source = data.source
  if (source === null || source === undefined || source.kind !== 'agent-instructions') return null
  const changes = Array.isArray(source.changes) ? source.changes : []
  for (const change of changes) {
    if (change === null || change === undefined) continue
    const scope = typeof change.scope === 'string' ? change.scope : ''
    /* 作用域是「作用域\u0000文件名」，只认 user-global 那一段 */
    if (scope.split('\u0000')[0] !== 'user-global') continue
    const path = typeof change.path === 'string' ? change.path : ''
    const name = path.split(/[\\/]/).pop()
    if (typeof name === 'string' && name.length > 0) return name
  }
  return null
}

/**
 * 轮次项气泡要的几个数官方 sessionStats 一个都没有（它只有 turns / steps 与各类耗时），
 * 所以在 host 侧按事件折一份：
 *   step/start       → 本轮走到第几步（轮号一变就归零，step 是轮内序号不是会话累计）
 *   tool/call        → 整个会话的工具调用次数 + 每个工具名各自的次数；
 *                      工具名是 skill 的那种再把技能名按注入顺序记进 skills
 *   user/message     → 全局提示词（agent-instructions 注入的那种）的文件名
 *   compaction/start → 压缩次数 + 这一次的落点；压缩事件只带轮号，
 *                      压缩发生在哪一步取压缩前最后一条同轮 step/start
 * 这几种事件在真实日志里都齐（75 个会话：11208 次工具调用、22 个压缩事件）。
 */
const sessionProgressProjection = {
  key: 'desktopStatusbarProgress',
  stateSchema: sessionProgressSchema,
  init: () => ({
    turn: 0,
    turnSteps: 0,
    toolCalls: 0,
    toolCounts: {},
    skills: [],
    globalInstruction: null,
    compactCount: 0,
    compactTurn: null,
    compactStep: null,
    compacts: [],
  }),
  apply: (state, event) => {
    if (event.type === 'step/start') {
      const data = event.data === undefined || event.data === null ? {} : event.data
      if (typeof data.step !== 'number') return state
      const turn = typeof data.turn === 'number' ? data.turn : state.turn
      const turnSteps = turn === state.turn ? Math.max(state.turnSteps, data.step) : data.step
      if (turn === state.turn && turnSteps === state.turnSteps) return state
      return { ...state, turn: turn, turnSteps: turnSteps }
    }
    if (event.type === 'user/message') {
      const name = globalInstructionOf(event.data)
      if (name === null || state.globalInstruction === name) return state
      return { ...state, globalInstruction: name }
    }
    if (event.type === 'tool/call') {
      const data = event.data === undefined || event.data === null ? {} : event.data
      const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : null
      const skill = name === 'skill' ? skillNameOf(data) : null
      const counts = name === null ? state.toolCounts : {
        ...state.toolCounts,
        [name]: (state.toolCounts[name] === undefined ? 0 : state.toolCounts[name]) + 1,
      }
      return {
        ...state,
        toolCalls: state.toolCalls + 1,
        toolCounts: counts,
        /* 技能是靠调用 skill 工具注入的；名字按注入顺序排，重复注入也照记（数量 = 数组长度） */
        skills: skill === null ? state.skills : state.skills.concat([skill]),
      }
    }
    if (event.type === 'compaction/start') {
      const data = event.data === undefined || event.data === null ? {} : event.data
      const turn = typeof data.turn === 'number' ? data.turn : state.turn
      /* 压缩前没有同轮的步（压缩落在轮首）时给 null，客户端那一格显示横杠 */
      const step = turn === state.turn && state.turnSteps > 0 ? state.turnSteps : null
      return {
        ...state,
        compactCount: state.compactCount + 1,
        compactTurn: turn,
        compactStep: step,
        compacts: state.compacts.concat([{ turn: turn, step: step }]),
      }
    }
    return state
  },
  wire: { viewSchema: sessionProgressSchema, view: (state) => state },
  // 字段变了（加 globalInstruction），提升版本重建旧状态
  stateVersion: 5,
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

/**
 * 这两类事件带着"这次请求用的是哪个模型"：`session/title-llm-request` 的 route、
 * `model/selection` 的 model。assistant/attempt 只有 stream、没有 message，取不到型号，
 * 靠投影里记下的最近一次请求补上 —— 否则那条事件会让整条投影抛错并永久停摆。
 */
function routedModelOf(event) {
  const data = event.data === null || event.data === undefined ? null : event.data
  if (data === null || typeof data !== 'object') return null
  if (event.type === 'session/title-llm-request') {
    const route = data.route
    if (route === null || route === undefined || typeof route !== 'object') return null
    if (typeof route.model !== 'string' || route.model.length === 0) return null
    return { model: route.model, provider: typeof route.provider === 'string' ? route.provider : '' }
  }
  if (event.type === 'model/selection') {
    if (typeof data.model !== 'string' || data.model.length === 0) return null
    return { model: data.model, provider: typeof data.provider === 'string' ? data.provider : '' }
  }
  return null
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
  /* 最近一次请求用的模型（见 routedModelOf）：不带 message 的 assistant/attempt 靠它补型号。
     可空且可选 —— 万一某条路径没带上这两个键，也不至于让整个 state 过不了校验。 */
  routeModel: z.string().nullable().optional(),
  routeProvider: z.string().nullable().optional(),
}).strict()

const sessionUsageProjection = {
  key: 'desktopStatusbarUsage',
  stateSchema: sessionUsageSchema,
  init: () => ({ models: {}, calls: [], current: null, last: null, turn: null, routeModel: null, routeProvider: null }),
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
    // 先记下"这次请求用的是哪个模型"：没有 message 的事件（assistant/attempt）靠它补型号
    const routed = routedModelOf(event)
    const base = routed === null ? state : {
      ...state,
      routeModel: routed.model,
      routeProvider: routed.provider,
    }
    const usage = usageOf(event)
    if (usage === undefined || usage === null) return base
    // 型号两条路：常规事件从 message.source 取；没有 message 的用上面记下的最近一次请求
    const message = event.data === null || event.data === undefined ? null : event.data.message
    const source = message === null || message === undefined ? null : message.source
    const fromMessage = source !== null && source.kind === 'model' && typeof source.model === 'string'
    const model = fromMessage ? source.model : (typeof base.routeModel === 'string' ? base.routeModel : '')
    // 两条路都拿不到型号：放弃这一笔，好过抛错把整条投影（以及同一次驱动的其它投影）带停
    if (model.length === 0) return base
    const provider = fromMessage && typeof source.provider === 'string'
      ? source.provider
      : (typeof base.routeProvider === 'string' ? base.routeProvider : '')
    const currentModel = base.models[model]
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
    const sameTurn = base.current !== null && Array.isArray(base.current.calls)
      && (turn === null || stateTurn === null || turn === stateTurn)
    const prev = sameTurn ? base.current : null
    const callsForTurn = prev === null ? [] : prev.calls
    const summary = {
      provider,
      model,
      time: event.time,
      input: (prev === null ? 0 : prev.input) + one.input,
      cacheRead: (prev === null ? 0 : prev.cacheRead) + one.cacheRead,
      cacheWrite: (prev === null ? 0 : prev.cacheWrite) + one.cacheWrite,
      output: (prev === null ? 0 : prev.output) + one.output,
    }
    const current = { ...summary, calls: callsForTurn.concat([one]) }
    return {
      ...base,
      turn: turn === null ? stateTurn : turn,
      calls: appendCalls(calls, [one]),
      current,
      // 轮次变化时把上一轮结算进 last
      last: prev === null && base.current !== null ? base.current : base.last,
      models: { ...base.models, [model]: bucket },
    }
  },
  wire: {
    viewSchema: sessionUsageSchema,
    view: (state) => state,
  },
  // schema 加了 current（本轮累计），提升版本以重建旧状态。
  // 3 → 4：历史缓存里有按旧口径算出来的逐条/本轮用量（未缓存输入少掉一截），
  // 界面上的「本轮」因此与「总计」对不上，提升版本强制从事件日志重放。
  // 4 → 5：旧缓存里缺「会话起标题」那几笔 —— attempt 事件没有 message，取不到型号时
  // 整条投影抛错、该会话的账从此停摆。提升版本强制重放，把这些笔补回账本。
  stateVersion: 5,
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

/** 环境变量是最高优先级的来源；refName 为空时按 DeepSeek 的引用名。 */
function keyFromEnv(refName) {
  const name = typeof refName === 'string' && refName.length > 0 ? refName : 'DEEPSEEK_API_KEY'
  const value = process.env[name]
  return typeof value === 'string' && value.length > 10 ? value : null
}

/**
 * `<DSH_HOME>/.credentials.yaml` 的 refs 段按引用名取值（模型页写入的 key 就落在那里）。
 * 只认引用名本身：records 里的 `secret` 是 client-connection 的授权口令，不是任何平台的
 * API key —— 先前拿它兜底，会让没配 key 的平台把这个口令发给对方接口（实测换回 401）。
 */
function keyFromCredentialsFile(refName) {
  const name = typeof refName === 'string' && refName.length > 0 ? refName : 'DEEPSEEK_API_KEY'
  try {
    const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp('(?:^|[\\s{,])["\']?' + quoted + '["\']?\\s*:\\s*["\']?([^"\'\\s#}]+)')
    const match = text.match(pattern)
    if (match !== null && typeof match[1] === 'string' && match[1].length > 10) return match[1]
  } catch (error) {
    /* 文件缺失或不可读 */
  }
  return null
}

function keyFromCredentialStore(ctx, refName) {
  const store = ctx.credentials
  if (store === undefined || store === null) return null
  /* 只按引用名取；没有引用名时才回落到 DeepSeek 的历史 id。
     逐个遍历 store 的键会串到别的凭据上，第三方平台拿到的就不是自己的 key。 */
  const ids = typeof refName === 'string' && refName.length > 0
    ? [refName]
    : ['deepseek-official', 'deepseek']
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

/**
 * 按适配器的凭据引用名逐个解析 key。用 credentials 服务的 resolve()（子代理核实：
 * describe() 只回答"配了没"，resolve() 才给出真实值 { value, source }）。
 * ref 在运行时就是普通字符串 —— credentialRef() 只做编译期品牌标记，所以不必 import 它。
 */
async function resolveAdapterKey(ctx, adapter) {
  const credentials = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('credentials') : null
  if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
    for (let i = 0; i < adapter.refs.length; i += 1) {
      try {
        const hit = await credentials.resolve(adapter.refs[i])
        if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value.length > 0) {
          return { key: hit.value, source: adapter.refs[i] }
        }
      } catch (error) {
        /* 换下一个引用名 */
      }
    }
  }
  /* 没挂凭据服务时的旧路径：环境变量 / .credentials.yaml（都按该适配器的引用名取） */
  const fallback = findApiKey(ctx, adapter.refs[0])
  return { key: fallback.key, source: fallback.source }
}

/** 用适配器查第三方平台的余额，返回与 DeepSeek 那条路一致的形状。 */
/** 从适配器返回的 parts 里按 label 取金额；没有这个 label 就返回 undefined（气泡少一行）。 */
function partAmount(parts, label) {
  const list = Array.isArray(parts) ? parts : []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] !== null && list[i] !== undefined && list[i].label === label) return list[i].amount
  }
  return undefined
}

async function queryWithAdapter(ctx, adapter, now) {
  const found = await resolveAdapterKey(ctx, adapter)
  if (found.key === null) {
    logHost(ctx, 'balance(' + adapter.id + '): 没取到 key，试过 ' + adapter.refs.join(' / '))
    return { ok: false, at: now, reason: 'no-credential', provider: adapter.id }
  }
  const spec = adapter.request(found.key)
  try {
    const response = await fetch(spec.url, {
      method: 'GET',
      headers: spec.headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      logHost(ctx, 'balance(' + adapter.id + '): HTTP ' + String(response.status))
      return { ok: false, at: now, reason: 'http-' + String(response.status), source: found.source, provider: adapter.id }
    }
    const parsed = adapter.parse(await response.json())
    if (parsed === null) {
      logHost(ctx, 'balance(' + adapter.id + '): 响应里解析不出余额')
      return { ok: false, at: now, reason: 'no-balance-info', source: found.source, provider: adapter.id }
    }
    return {
      ok: true,
      at: now,
      source: found.source,
      provider: adapter.id,
      currency: parsed.currency,
      total: parsed.total,
      isPercent: parsed.isPercent === true,
      parts: parsed.parts,
      /* 余额气泡那几行读的是顶层字段（与 DeepSeek 那条路保持同一形状），这里按 label 摊平 */
      toppedUp: partAmount(parsed.parts, 'toppedUp'),
      granted: partAmount(parsed.parts, 'granted'),
      spent: partAmount(parsed.parts, 'spent'),
    }
  } catch (error) {
    logHost(ctx, 'balance(' + adapter.id + '): ' + String(error === null || error === undefined ? 'unknown' : error.message))
    return { ok: false, at: now, reason: 'network', source: found.source, provider: adapter.id }
  }
}

function findApiKey(ctx, refName) {
  const fromEnv = keyFromEnv(refName)
  if (fromEnv !== null) return { key: fromEnv, source: 'env' }
  const fromFile = keyFromCredentialsFile(refName)
  if (fromFile !== null) return { key: fromFile, source: 'credentials.yaml' }
  const fromStore = keyFromCredentialStore(ctx, refName)
  if (fromStore !== null) return { key: fromStore, source: 'credentials-service' }
  return { key: null, source: null }
}

/**
 * 官方账号服务里的余额（设置页「账号与余额」用的就是它）：
 * getBalance 返回充值钱包 value[] 与赠金钱包 bonusWallets[]，两者相加正是底栏要的"充值 + 赠送"合计。
 * 只在会话没有 API key、纯账号登录模式时采用；取不到、账号未登录或调用抛错一律返回 null。
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

async function queryBalance(ctx, force, provider, model) {
  const now = Date.now()
  if (force !== true && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.value
  }

  /* 当前会话用的是第三方平台就交给适配器：每个平台有自己的端点、鉴权与字段。 */
  const adapter = adapterFor(provider, model)
  if (adapter !== null && adapter.id !== 'deepseek') {
    const third = await queryWithAdapter(ctx, adapter, now)
    balanceCache = { at: now, value: third, provider: adapter.id }
    return third
  }

  /* 会话明确在用别的平台、但这个平台认不出来时不硬凑：硬凑会把 DeepSeek 的余额
     当成对方的余额显示（比不显示更误导）。provider 还没上报（空）时才按 DeepSeek 处理。 */
  const hasProvider = typeof provider === 'string' && provider.trim().length > 0
  if (adapter === null && hasProvider) {
    const unknown = { ok: false, at: now, reason: 'unknown-platform' }
    logHost(ctx, 'balance: 认不出 ' + provider + ' 属于哪个平台，不显示余额')
    balanceCache = { at: now, value: unknown }
    return unknown
  }

  /* DeepSeek 在 DSH 里有两条计费通道，余额必须跟当前会话实际走的那条：
   *   deepseek-account  → 登录账号的额度（官方账号服务）
   *   deepseek-official → 模型页那把 API key 的账户（官方余额接口）
   * 判据只看 provider，与本机配没配 key 无关 —— 装了 key 的机器同样可能在跑账号模式的会话，
   * 反过来拿账号钱包顶替 API key 的账，就会出现「一直在花钱、余额却不动」。 */
  const usesAccountChannel = adapter !== null
    && typeof provider === 'string'
    && provider.toLowerCase().includes('account')
  if (usesAccountChannel) {
    const fromAccount = await queryAccountBalance(ctx)
    if (fromAccount !== null) {
      balanceCache = { at: now, value: fromAccount }
      return fromAccount
    }
    const noAccount = { ok: false, at: now, reason: 'account-unavailable' }
    logHost(ctx, 'balance: 账号通道（' + provider + '）但账号服务不可用')
    balanceCache = { at: now, value: noAccount }
    return noAccount
  }

  /* 其余 DeepSeek 会话按 API key 计费：余额取这把 key 的账户。
   * 模型页配了 key（credentials 服务 / 环境变量 / .credentials.yaml 任一处有值）就用它；
   * 确实没有 key 时才是"账号登录但 provider 名没带 account"的兜底，退回账号钱包。 */
  const deepseekAdapter = adapter === null ? adapterFor('deepseek', '') : adapter
  const found = await resolveAdapterKey(ctx, deepseekAdapter)

  if (found.key === null) {
    const fromAccount = await queryAccountBalance(ctx)
    if (fromAccount !== null) {
      balanceCache = { at: now, value: fromAccount }
      return fromAccount
    }
    const missing = { ok: false, at: now, reason: 'no-credential' }
    logHost(ctx, 'balance: 环境变量 / credentials.yaml / credentials 服务都没取到 key，账号服务也不可用')
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

/* ------------------------------------------------------------ 活跃总览 */

/**
 * 峰谷那个字段点开是「活跃总览」：左边看本周每天用了多少，右边看当月每天的活跃度，
 * 而 session 投影只覆盖当前会话，
 * 所以这里扫会话日志把用量收进一份本地台账（`<DSH_HOME>/dsh-status-bar/usage-ledger.json`）。
 *
 * 为什么必须落盘：会话一旦被删除，日志就没了，而周总计必须把已经发生的消耗留住。
 * 台账按「事件」去重（同一 turn/step 只算一次、assistant/message 优先），于是重复扫描不会
 * 重复计数，删掉会话也不会让已记下的数字缩水；窗口是自然周（周一 00:00 起）。
 * 全程只读 token 数字，不读正文，台账里也只有数字、没有对话内容。
 */

/**
 * 柱状窗口的起点：今天 00:00（北京时间）往前推 6 天，也就是「近 7 天」。
 * 这里用的是滚动窗口，不再对齐自然周 —— 用户看到的是最近七天，而不是本周一到现在。
 */
function recentStartMs(now) {
  const BEIJING = 8 * 3600 * 1000
  const shifted = new Date(now + BEIJING)
  const todayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - BEIJING
  return todayStart - 6 * 24 * 3600 * 1000
}

/** 本月 1 号 00:00（北京时间）的毫秒时间戳。 */
function monthStartMs(now) {
  const BEIJING = 8 * 3600 * 1000
  const shifted = new Date(now + BEIJING)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - BEIJING
}

const padTwo = (value) => (value < 10 ? '0' + String(value) : String(value))

/** 当年 1 月 1 日 00:00（北京时间）的毫秒时间戳 —— 12 个月的统计要从这里扫起。 */
function yearStartMs(now) {
  const BEIJING = 8 * 3600 * 1000
  const shifted = new Date(now + BEIJING)
  return Date.UTC(shifted.getUTCFullYear(), 0, 1) - BEIJING
}

/** 北京时间（UTC+8）的日期键 'YYYY-MM-DD' —— DeepSeek 的峰谷与账单都按北京时间。 */
function localDateKey(ms) {
  const date = new Date(ms + 8 * 3600 * 1000)
  return date.getUTCFullYear() + '-' + padTwo(date.getUTCMonth() + 1) + '-' + padTwo(date.getUTCDate())
}

/* 官方参考价（CNY / 每百万 tokens），与客户端价格表同源、与官方定价页一致。
   只列有明确价格的 DeepSeek 模型；其它 provider（智谱、小米等）没有可靠价格，不计入花费。 */
const TOKEN_PRICES = {
  peak: {
    'deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    'deepseek-v4-pro': { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
  },
  offPeak: {
    'deepseek-flash': { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
  },
}

/* 2026 年法定节假日（国务院通知，与 /api/holidays 抓到的是同一份）：这些天全天按空闲价 */
const CN_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，法定节假日与周末全天按空闲价。 */
const PEAK_WINDOWS = [[9, 12], [14, 18]]

function isPeakTime(ms) {
  const date = new Date(ms + 8 * 3600 * 1000)
  const key = date.getUTCFullYear() + '-' + padTwo(date.getUTCMonth() + 1) + '-' + padTwo(date.getUTCDate())
  if (CN_HOLIDAYS_2026.indexOf(key) >= 0) return false
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  for (let i = 0; i < PEAK_WINDOWS.length; i += 1) {
    if (hour >= PEAK_WINDOWS[i][0] && hour < PEAK_WINDOWS[i][1]) return true
  }
  return false
}

/** 一笔用量按官方单价折成人民币；模型没有价格表就返回 0（不计入花费）。 */
function tokenCost(model, at, parts) {
  const table = isPeakTime(at) ? TOKEN_PRICES.peak : TOKEN_PRICES.offPeak
  const price = table[model]
  if (price === undefined) return 0
  return (parts.input * price.input + parts.cacheRead * price.cacheRead
    + parts.cacheWrite * price.cacheWrite + parts.output * price.output) / 1e6
}

/** zstd 帧头（0x28 B5 2F FD）：会话日志是多帧拼接，按它切开逐帧解。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解出会话日志文本；运行时不带 zstd 时返回 null（客户端按空数据画）。 */
function zstdText(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const starts = []
  let at = 0
  while ((at = buf.indexOf(ZSTD_MAGIC, at)) >= 0) {
    starts.push(at)
    at += 4
  }
  if (starts.length === 0) return null
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)))
    } catch (error) {
      /* 坏帧跳过，其余帧照常 */
    }
  }
  return parts.length === 0 ? null : Buffer.concat(parts).toString('utf8')
}

/** `<DSH_HOME>/sessions` —— 会话日志根目录。 */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 递归收集会话日志文件（目录缺失时给空数组）。 */
function collectSessionFiles(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSessionFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}

/**
 * 一条事件里的 token 用量：`data.usage` 是兜底，stream 里的 usage chunk 才是权威值
 * （与 sessionUsage 投影同口径）。assistant/attempt 这类事件只有 stream 里带 usage。
 */
function usageOfEvent(event) {
  const data = event.data
  if (data === null || data === undefined || typeof data !== 'object') return null
  let usage = data.usage !== undefined ? data.usage : event.usage
  if (Array.isArray(data.stream)) {
    for (const node of data.stream) {
      if (node === null || node === undefined) continue
      if (node.chunk !== undefined && node.chunk !== null && node.chunk.type === 'usage' && node.chunk.usage !== undefined) {
        usage = node.chunk.usage
      }
      if (node.type === 'usage' && node.usage !== undefined) usage = node.usage
    }
  }
  if (usage === undefined || usage === null || typeof usage !== 'object') return null
  return usage
}

/**
 * 一笔消耗在日志里的身份：一次模型调用只该对应一个 key。
 * turn/step 是最自然的粒度（一个 step 一次模型调用）；压缩摘要是独立调用，按 compactionId；
 * 两者都没有时退回 seq。
 */
function usageEventKey(event) {
  const data = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'compaction/summary') {
    return 'compact:' + String(data.compactionId !== undefined && data.compactionId !== null ? data.compactionId : event.seq)
  }
  if (typeof data.turn === 'number' && typeof data.step === 'number') {
    return 'turn:' + String(data.turn) + ':' + String(data.step)
  }
  return 'seq:' + String(event.seq)
}

/**
 * 从一段日志文本里挑出窗口内的用量事件。
 * 同一个 key 只留一条，且 `assistant/message` 优先 —— 这样重试的 attempt 与最终消息
 * 不会被算两次，而「压缩摘要」这类独立消耗照常计入。
 */
function pickUsageEvents(text, fromMs) {
  const picked = new Map()
  for (const line of text.split('\n')) {
    if (line.indexOf('"usage"') < 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    if (typeof event.time !== 'number' || event.time < fromMs) continue
    const usage = usageOfEvent(event)
    if (usage === null) continue
    const parts = usageParts(usage)
    /* 被中断的尝试会留下一条全 0 的 usage：没花钱，也不该占一次调用 */
    if (parts.input === 0 && parts.cacheRead === 0 && parts.cacheWrite === 0 && parts.output === 0) continue
    const isMessage = event.type === 'assistant/message'
    const key = usageEventKey(event)
    const prev = picked.get(key)
    if (prev === undefined || (prev.isMessage !== true && isMessage)) {
      const data = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data : {}
      const source = data.message !== null && data.message !== undefined && typeof data.message === 'object'
        && data.message.source !== null && data.message.source !== undefined && typeof data.message.source === 'object'
        ? data.message.source
        : null
      picked.set(key, {
        seq: typeof event.seq === 'number' ? event.seq : Math.round(event.time),
        time: event.time,
        parts: parts,
        isMessage: isMessage,
        /* 计价要用模型名（不同模型单价不同） */
        model: source !== null && typeof source.model === 'string' ? source.model : null,
      })
    }
  }
  return picked
}

/** `<DSH_HOME>`。 */
function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** 台账文件：与状态栏其它数据同目录（`<DSH_HOME>/dsh-status-bar/`）。 */
function ledgerPath() {
  return join(dshHome(), 'dsh-status-bar', 'usage-ledger.json')
}

/**
 * 台账形状：
 *   days     每个本地日期的累计用量（只增不减 —— 会话被删掉也不会缩水）
 *   seen     每个会话已计入的 seq，用来防重复
 *   sessions 每个会话最后一条用量事件的时间，用来淘汰老会话的去重记录
 *   files    每个日志文件上次处理时的 mtime+size，没变就跳过解压
 */
const LEDGER_VERSION = 2

function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: 0, days: {}, seen: {}, sessions: {}, files: {} }
}

function readLedger() {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.version === LEDGER_VERSION) {
      const pick = (value) => (value !== null && value !== undefined && typeof value === 'object' ? value : {})
      return {
        version: LEDGER_VERSION,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        days: pick(parsed.days),
        seen: pick(parsed.seen),
        sessions: pick(parsed.sessions),
        files: pick(parsed.files),
      }
    }
    /* v1 台账没有 days[].peak（高峰时段用量）。seen 里已把事件全标成处理过，
       光靠重扫补不回来，所以把聚合结果整份丢掉重建一遍 —— 原始日志还在，无损。 */
    if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) {
      return emptyLedger()
    }
  } catch (error) {
    /* 首次运行还没有台账，或文件损坏：从空台账重建 */
  }
  return emptyLedger()
}

/** 先写临时文件再改名，避免读到写了一半的 JSON。 */
function writeLedger(ledger) {
  const target = ledgerPath()
  const temp = target + '.tmp'
  try {
    mkdirSync(join(dshHome(), 'dsh-status-bar'), { recursive: true })
    writeFileSync(temp, JSON.stringify(ledger), 'utf8')
    renameSync(temp, target)
  } catch (error) {
    /* 落盘失败不影响本次读数 */
  }
}

/**
 * 把会话日志里的用量并进台账。文件没变（mtime+size 相同）就直接跳过，空闲时几乎没有开销；
 * 每 4 个文件让出一次事件循环，别把 host 卡住。
 */
async function collectIntoLedger(ledger, fromMs) {
  const files = collectSessionFiles(sessionsRoot(), [])
  let scannedFiles = 0
  let skippedFiles = 0
  let added = 0
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    let stat
    try {
      stat = statSync(file)
    } catch (error) {
      delete ledger.files[file]
      continue
    }
    const mark = ledger.files[file]
    /* 跳过条件必须连"上次扫描用的窗口起点"一起比。
       窗口只覆盖最近几天时，文件里更早的事件会被 fromMs 过滤掉，但文件照样被标记成已扫；
       之后窗口放宽（柱改成近 7 天、活跃度要整月、12 个月要整年）如果不重扫，
       那些被过滤掉的数据就永远补不回来 —— 这正是 9/26 少掉 2.8 亿 token 的原因。
       mark.fromMs 缺失（老记录）时视为"不满足"，于是会自动重扫一遍把历史补齐。 */
    if (mark !== undefined && mark.mtimeMs === stat.mtimeMs && mark.size === stat.size
      && typeof mark.fromMs === 'number' && mark.fromMs <= fromMs) {
      skippedFiles += 1
      continue
    }
    /* 窗口起点之前就没再动过、也从没扫过：窗口外的内容与我们无关 */
    if (stat.mtimeMs < fromMs && mark === undefined) {
      skippedFiles += 1
      continue
    }
    let text = null
    try {
      text = zstdText(readFileSync(file))
    } catch (error) {
      text = null
    }
    /* 连同这次的窗口起点一起记：下次只有当窗口不晚于它时才允许整文件跳过 */
    ledger.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, fromMs }
    if (text === null) continue
    scannedFiles += 1
    const sessionId = basename(dirname(file))
    const picked = pickUsageEvents(text, fromMs)
    if (picked.size === 0) continue
    const seen = new Set(Array.isArray(ledger.seen[sessionId]) ? ledger.seen[sessionId] : [])
    const record = ledger.sessions[sessionId]
    let last = record !== undefined && typeof record.last === 'number' ? record.last : 0
    for (const one of picked.values()) {
      last = Math.max(last, one.time)
      if (seen.has(one.seq)) continue
      seen.add(one.seq)
      const key = localDateKey(one.time)
      const day = ledger.days[key] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, cost: 0, peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
      day.input += one.parts.input
      day.cacheRead += one.parts.cacheRead
      day.cacheWrite += one.parts.cacheWrite
      day.output += one.parts.output
      day.calls += 1
      /* 高峰时段（北京时间工作日 09-12 / 14-18，排除法定节假日）那一份单独记，
         柱状图会把它截出来放在柱子顶部 */
      if (isPeakTime(one.time)) {
        const peak = day.peak ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        peak.input += one.parts.input
        peak.cacheRead += one.parts.cacheRead
        peak.cacheWrite += one.parts.cacheWrite
        peak.output += one.parts.output
        day.peak = peak
      }
      /* 按该次调用当时的峰谷价与模型单价折成人民币（模型没有价格表就记 0） */
      day.cost = (day.cost || 0) + tokenCost(one.model, one.time, one.parts)
      ledger.days[key] = day
      added += 1
    }
    ledger.seen[sessionId] = Array.from(seen)
    ledger.sessions[sessionId] = { last }
    if (i % 4 === 3) await new Promise((resolve) => setImmediate(resolve))
  }
  return { files: files.length, scannedFiles, skippedFiles, added }
}

/** 丢掉太久以前的日桶与去重记录。保留期是滚动的「今天往前 400 天」，与统计窗口无关。 */
function pruneLedger(ledger) {
  const keepFrom = localDateKey(Date.now() - 400 * 24 * 3600 * 1000)
  for (const key of Object.keys(ledger.days)) {
    if (key < keepFrom) delete ledger.days[key]
  }
  for (const sessionId of Object.keys(ledger.sessions)) {
    const one = ledger.sessions[sessionId]
    if (one === undefined || typeof one.last !== 'number' || localDateKey(one.last) < keepFrom) {
      delete ledger.sessions[sessionId]
      delete ledger.seen[sessionId]
    }
  }
}

/** 把台账里的日桶铺成「近 7 天」固定 7 格（最早一天在最左、今天是最后一格），并算合计；另附当月与全年。 */
function weekUsagePayload(ledger, rangeStart, monthStart, meta) {
  const DAY = 24 * 3600 * 1000
  const days = []
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0, cost: 0 }
  for (let i = 0; i < 7; i += 1) {
    /* 按北京时间逐日推进，不受机器时区影响 */
    const key = localDateKey(rangeStart + i * DAY)
    const bucket = ledger.days[key] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, cost: 0, peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
    const total = bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.output
    const cost = typeof bucket.cost === 'number' && Number.isFinite(bucket.cost) ? bucket.cost : 0
    /* 高峰那一份：老台账没有 peak 字段时按 0 处理 */
    const pk = bucket.peak ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const peak = {
      input: Number(pk.input) || 0,
      cacheRead: Number(pk.cacheRead) || 0,
      cacheWrite: Number(pk.cacheWrite) || 0,
      output: Number(pk.output) || 0,
    }
    peak.total = peak.input + peak.cacheRead + peak.cacheWrite + peak.output
    days.push({
      date: key,
      /* 窗口内第几天（0 = 最早那天，6 = 今天）；不再是星期几 */
      offset: i,
      input: bucket.input,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      output: bucket.output,
      total,
      calls: bucket.calls,
      /* 高峰时段那一份（四项 + 合计），客户端把它截出来画在柱子顶部 */
      peak,
      /* 人民币，保留 4 位小数，客户端自己截到分 */
      cost: Math.round(cost * 10000) / 10000,
    })
    totals.input += bucket.input
    totals.cacheRead += bucket.cacheRead
    totals.cacheWrite += bucket.cacheWrite
    totals.output += bucket.output
    totals.calls += bucket.calls
    totals.total += total
    totals.cost += cost
  }
  totals.cost = Math.round(totals.cost * 10000) / 10000
  return Object.assign({
    ok: true,
    at: Date.now(),
    rangeStart,
    days,
    totals,
    month: monthUsagePayload(ledger, monthStart),
    year: yearUsagePayload(ledger, Date.now()),
  }, meta)
}

/**
 * 当月活跃度日历：从「1 号所在那一周的周一」排到「月末所在那一周的周日」。
 * 跨月的头尾几天照样带上（周底条要统计整周，不能只看当月），用 inMonth 标出归属；
 * 「月内最高的一天」（要标紫的那天）只在当月天里评，避免被上月的量抢走。
 */
function monthUsagePayload(ledger, monthStart) {
  const BEIJING = 8 * 3600 * 1000
  const DAY = 24 * 3600 * 1000
  const first = new Date(monthStart + BEIJING)
  const year = first.getUTCFullYear()
  const month = first.getUTCMonth() + 1
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const firstWeekday = (first.getUTCDay() + 6) % 7 /* 周一=0 */
  const gridStart = monthStart - firstWeekday * DAY
  const monthEnd = monthStart + (daysInMonth - 1) * DAY
  const lastWeekday = (new Date(monthEnd + BEIJING).getUTCDay() + 6) % 7
  const gridDays = daysInMonth + firstWeekday + (6 - lastWeekday)
  const days = []
  let max = 0
  let maxDate = null
  for (let i = 0; i < gridDays; i += 1) {
    const at = gridStart + i * DAY
    const key = localDateKey(at)
    const inMonth = at >= monthStart && at <= monthEnd
    const bucket = ledger.days[key]
    /* 三段明细一并带上：客户端悬停每天的方块时要显示命中 / 未命中 / 输出 */
    const input = bucket === undefined ? 0 : bucket.input || 0
    const cacheRead = bucket === undefined ? 0 : bucket.cacheRead || 0
    const cacheWrite = bucket === undefined ? 0 : bucket.cacheWrite || 0
    const output = bucket === undefined ? 0 : bucket.output || 0
    const total = input + cacheRead + cacheWrite + output
    const calls = bucket === undefined ? 0 : bucket.calls || 0
    const rawCost = bucket === undefined ? 0 : bucket.cost
    const cost = typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : 0
    days.push({
      date: key,
      inMonth,
      total,
      calls,
      cost: Math.round(cost * 10000) / 10000,
      input,
      cacheRead,
      cacheWrite,
      output,
    })
    if (inMonth && total > max) {
      max = total
      maxDate = key
    }
  }
  return { year, month, daysInMonth, firstWeekday, max, maxDate, days }
}

/**
 * 当年的 12 个月聚合：每月的三段 token、调用次数与花费。
 * 客户端拿它画「活跃总览」标题下面那 12 个方块（配色规则与右侧月历一致）。
 */
function yearUsagePayload(ledger, now) {
  const BEIJING = 8 * 3600 * 1000
  const year = new Date(now + BEIJING).getUTCFullYear()
  const months = []
  let max = 0
  let maxMonth = null
  for (let m = 1; m <= 12; m += 1) {
    const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate()
    let input = 0
    let cacheRead = 0
    let cacheWrite = 0
    let output = 0
    let calls = 0
    let cost = 0
    for (let d = 1; d <= daysInMonth; d += 1) {
      const bucket = ledger.days[localDateKey(Date.UTC(year, m - 1, d) - BEIJING)]
      if (bucket === undefined) continue
      input += bucket.input || 0
      cacheRead += bucket.cacheRead || 0
      cacheWrite += bucket.cacheWrite || 0
      output += bucket.output || 0
      calls += bucket.calls || 0
      const raw = bucket.cost
      cost += typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    }
    const total = input + cacheRead + cacheWrite + output
    months.push({
      month: m,
      total,
      calls,
      cost: Math.round(cost * 10000) / 10000,
      input,
      cacheRead,
      cacheWrite,
      output,
    })
    if (total > max) {
      max = total
      maxMonth = m
    }
  }
  return { year, max, maxMonth, months }
}

/**
 * 气泡定位诊断：客户端把「模式 / 基准 / 结果」回传到这里，落到
 * `<DSH_HOME>/dsh-status-bar/tip-diag.log`。用途是在没有控制台的环境下核对气泡为什么越界。
 * 只收几个数字与短字符串，不写任何会话内容；超过 64KB 就重开，避免无限增长。
 */
function appendTipDiag(body) {
  if (body === null || body === undefined || typeof body !== 'object') return
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null)
  const text = (value) => (typeof value === 'string' ? value.slice(0, 40) : null)
  const line = JSON.stringify({
    at: Date.now(),
    tip: text(body.tip),
    mode: text(body.mode),
    left: num(body.left),
    ring: num(body.ring),
    ringFound: body.ringFound === true,
    anchor: num(body.anchor),
    bar: num(body.bar),
    width: num(body.width),
    viewport: num(body.viewport),
  }) + '\n'
  try {
    const dir = join(dshHome(), 'dsh-status-bar')
    const file = join(dir, 'tip-diag.log')
    let size = 0
    try {
      size = statSync(file).size
    } catch (error) {
      size = 0
    }
    mkdirSync(dir, { recursive: true })
    if (size > 65536) writeFileSync(file, line, 'utf8')
    else appendFileSync(file, line, 'utf8')
  } catch (error) {
    /* 落盘失败不影响功能 */
  }
}

/* 台账只在「有新数据」时才重扫（文件 mtime+size 没变就跳过），因此这层只是省掉重复的 stat。
   不挂定时器：打开活跃总览面板时会带 force=1 现扫一次，数据只在被看的时候才需要最新。 */
const WEEK_USAGE_CACHE_MS = 30000
let weekUsageCache = { at: 0, value: null }
/* 扫描可能被并发触发：复用同一次进行中的扫描。 */
let weekUsageScan = null

async function refreshWeekUsage(force) {
  const now = Date.now()
  const rangeStart = recentStartMs(now)
  const monthStart = monthStartMs(now)
  const yearStart = yearStartMs(now)
  /* 扫描与保留窗口取「近 7 天起点」「本月 1 号」「当年 1 月 1 日」里最早的那个：
     柱要看近 7 天、活跃度要整月、12 个月统计要整年。
     台账一旦记过就留着（保留期已放宽），所以全量解压只在首次或很久没开时发生。 */
  const windowStart = Math.min(rangeStart, monthStart, yearStart)
  if (force !== true && weekUsageCache.value !== null && now - weekUsageCache.at < WEEK_USAGE_CACHE_MS) {
    return weekUsageCache.value
  }
  if (weekUsageScan === null) {
    const run = (async () => {
      const ledger = readLedger()
      const stats = await collectIntoLedger(ledger, windowStart)
      pruneLedger(ledger)
      if (stats.added > 0 || stats.scannedFiles > 0 || ledger.updatedAt === 0) {
        ledger.updatedAt = Date.now()
        writeLedger(ledger)
      }
      return { ledger, stats }
    })()
    weekUsageScan = run
    const clear = () => { if (weekUsageScan === run) weekUsageScan = null }
    void run.then(clear, clear)
  }
  const result = await weekUsageScan
  const value = weekUsagePayload(result.ledger, rangeStart, monthStart, {
    files: result.stats.files,
    scannedFiles: result.stats.scannedFiles,
    skippedFiles: result.stats.skippedFiles,
    added: result.stats.added,
    zstd: typeof zlib.zstdDecompressSync === 'function',
  })
  weekUsageCache = { at: Date.now(), value }
  return value
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

/* --------------------------------------------------------------- 版本自检 */

/** registry 的最新版条目地址：只读它的 version 字段，不下载包、不写任何文件。 */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/dsh-desktop-statusbar/latest'
const VERSION_CHECK_TIMEOUT_MS = 15000

/** a 比 b 新返回正数。按数字段比（2.10.0 > 2.9.0）；带预发布后缀的排在同号正式版之前。 */
function compareVersions(a, b) {
  const parts = (value) => String(value).split('-')[0].split('.').map((one) => Number(one) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < 3; i += 1) {
    const one = left[i] === undefined ? 0 : left[i]
    const other = right[i] === undefined ? 0 : right[i]
    if (one !== other) return one - other
  }
  const leftPre = String(a).indexOf('-') >= 0
  const rightPre = String(b).indexOf('-') >= 0
  if (leftPre === rightPre) return 0
  return leftPre ? -1 : 1
}

/* 启动自检一次的结果。查不到（离线、被墙、包没发过）时 latest 为 null，界面什么都不显示。 */
let latestVersion = { checkedAt: 0, latest: null, error: null }
let versionCheck = null

async function checkLatestVersion() {
  try {
    const response = await fetch(REGISTRY_LATEST_URL, {
      headers: { 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
    })
    if (response.ok !== true) {
      return { checkedAt: Date.now(), latest: null, error: 'http-' + String(response.status) }
    }
    const payload = await response.json()
    const latest = payload !== null && typeof payload === 'object' && typeof payload.version === 'string'
      ? payload.version
      : null
    return { checkedAt: Date.now(), latest, error: latest === null ? 'no-version' : null }
  } catch (error) {
    return { checkedAt: Date.now(), latest: null, error: 'fetch-failed' }
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
    () => ctx.sessionProjections.register(sessionCapacityProjection),
    'dsh-desktop-statusbar: sessionCapacity projection',
  )
  ctx.effect(
    () => ctx.sessionProjections.register(sessionProgressProjection),
    'dsh-desktop-statusbar: sessionProgress projection',
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

  /* 会话日志一旦被删就没了，台账是唯一留得住的地方：启动时先并一次作为预热，
     之后只在用户打开活跃总览面板时（带 force=1）现扫。 */
  ctx.effect(() => {
    void refreshWeekUsage(false).catch(() => {})
  }, 'dsh-desktop-statusbar: usage ledger')

  /* 启动自检一次：只问 registry 最新版号是多少（不下载包）。结果给 /api/version 用，
     决定导航项后面那颗「发现新版本」胶囊显不显示。查不到就安静地什么都不显示。 */
  ctx.effect(() => {
    versionCheck = checkLatestVersion().then((result) => {
      latestVersion = result
      logHost(ctxRef, result.latest === null
        ? 'version: 自检没拿到结果（' + String(result.error) + '）'
        : 'version: registry 最新版 ' + String(result.latest))
      return result
    })
  }, 'dsh-desktop-statusbar: version self-check')

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
      if (url.pathname === '/dsh-desktop-statusbar/api/version') {
        /* 启动自检可能还没回来：等这一次在途的查询，别让客户端误判成「没有新版」 */
        if (latestVersion.checkedAt === 0 && versionCheck !== null) {
          try {
            latestVersion = await versionCheck
          } catch (error) {
            /* 保持 latest 为 null，下面按「查不到」处理 */
          }
        }
        const raw = url.searchParams.get('current')
        const current = raw === null ? '' : raw.trim()
        sendJson(res, 200, {
          ok: latestVersion.latest !== null,
          current,
          latest: latestVersion.latest,
          /* 只有确实拿到版本号、且它比本地这个新，才算「有更新」 */
          hasUpdate: latestVersion.latest !== null && current.length > 0
            && compareVersions(latestVersion.latest, current) > 0,
          checkedAt: latestVersion.checkedAt,
          error: latestVersion.error,
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
      if (url.pathname === '/dsh-desktop-statusbar/api/daily-usage') {
        let value
        try {
          value = await refreshWeekUsage(url.searchParams.get('force') === '1')
        } catch (error) {
          logHost(ctx, 'usage: 台账刷新失败 ' + probeDetail(error))
          value = { ok: false, reason: 'ledger-failed' }
        }
        sendJson(res, 200, value)
        return
      }
      if (url.pathname === '/dsh-desktop-statusbar/api/tip-diag') {
        if (req.method === 'POST') appendTipDiag(await readJsonBody(req))
        sendJson(res, 200, { ok: true })
        return
      }
      if (url.pathname !== '/dsh-desktop-statusbar/api/balance') {
        sendJson(res, 404, { ok: false, reason: 'not-found' })
        return
      }
      const force = url.searchParams.get('force') === '1'
      const value = await queryBalance(ctx, force, url.searchParams.get('provider'), url.searchParams.get('model'))
      sendJson(res, 200, Object.assign({}, value, { probe: accountProbeNote }))
    },
  }), 'dsh-desktop-statusbar: balance api')
}
