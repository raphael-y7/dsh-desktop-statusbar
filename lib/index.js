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
 *      来源是一份本地台账（`<DSH_HOME>/dsh-status-bar/usage-ledger.json`）：启动时把会话日志里
 *      新产生的用量并进去，以后只在打开活跃总览面板时（带 force=1）现扫一次，30 秒内复用缓存。
 *      台账只增不减：删掉会话或整个工作区，已记下的数字都不缩水；当时没有单价的用量记成
 *      "欠账"，补上单价后只结算欠账，不重算已经算好的费用。只取 token 数字，不读正文。
 *   7. `/dsh-desktop-statusbar/api/holidays` — 抓国务院的放假通知，解析出放假日。
 *      （客户端跨域抓不到 gov.cn，只能由 host 代抓；正文解析在 lib/holiday.js。）
 *   8. `/dsh-desktop-statusbar/api/subagent-usage` — 按 `parentSession` 聚合子智能体
 *      （Agent Teams 的队友）的用量。子智能体是**独立会话**，它的消耗不在本会话的投影里，
 *      底栏「总计」「本轮」要算上就只能由 host 读会话日志补出来。可选参数 `since`（毫秒）
 *      只统计该时刻之后的用量：客户端传了就按它（`sinceSource='client'`），没传（或非法：
 *      非有限数 / 负数 / 未来时刻）则由 host 读**父会话日志**推起点（`sinceSource='host'`），
 *      连父会话都没有就本轮不并队友（`sinceSource='none'`）；要整会话显式传 `since=0`。
 *      返回里 `total.stats` 是后代**整会话**的首字/解码累计（与窗口无关），给底栏
 *      「首字平均 / 综合速度」并进会话级数值用。只读，绝不写台账。
 *
 * 凭据来源：DeepSeek 走 `ctx.credentials`（模型页写入的权威来源），退回环境变量
 * DEEPSEEK_API_KEY 与 `<DSH_HOME>/.credentials.yaml`；其它平台按适配器的 refs 逐个解析。
 * key 只在本进程内存中用于调用对应平台的余额接口，不落盘、不转发、不写日志。
 *
 * @module dsh-desktop-statusbar
 */
import { z } from 'zod'
import { adapterFor, adaptersFor, pluginRoutesIn } from './balance-api.js'
import { holidayHtmlToText, parseHolidayNotice } from './holiday.js'
import { isUpdating, lastUpdateResult, resolveSelfDir, selfUpdateOnce } from './self-update.js'
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
    const source = event.data === undefined || event.data === null || event.data.message === undefined || event.data.message === null
      ? null
      : event.data.message.source
    if (source === null || source === undefined || source.kind !== 'model') return state
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
 * 技能还有一条斜杠命令注入的路：/i-have-adhd 这类不产生 skill 工具调用，
 * 只补一条 user/message，source 形如 { kind: 'skill-invocation', name: 'i-have-adhd', form: 'instructions' }。
 * skill-catalog（可用技能清单，每次会话都注入）不是「这次注入的技能」，必须排除。
 */
function skillInvocationOf(data) {
  if (data === null || data === undefined) return null
  const source = data.source
  if (source === null || source === undefined || source.kind !== 'skill-invocation') return null
  return typeof source.name === 'string' && source.name.length > 0 ? source.name : null
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
 *   user/message     → 全局提示词（agent-instructions 注入的那种）的文件名；
 *                      斜杠命令注入的技能（skill-invocation）也补进 skills
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
      const skill = skillInvocationOf(event.data)
      if (skill !== null) return { ...state, skills: state.skills.concat([skill]) }
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
        /* 技能有两种注入来源：调 skill 工具（这里）与斜杠命令（user/message 分支）；
           名字按注入顺序排，重复注入也照记（数量 = 数组长度） */
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
  // 字段变了（加 globalInstruction、技能多一条斜杠命令来源），提升版本重建旧状态
  stateVersion: 6,
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
      const data = event.data === undefined || event.data === null ? {} : event.data
      if (typeof data.turn !== 'number') return state
      /* 换轮就把本轮累计清零：气泡里的"本轮平均…"只算当前这一轮 */
      const turn = data.turn
      const sameTurn = state.turn === turn
      return {
        ...state,
        turn: turn,
        turnTtftMs: sameTurn ? state.turnTtftMs : 0,
        turnTtftSamples: sameTurn ? state.turnTtftSamples : 0,
        turnDecodeMs: sameTurn ? state.turnDecodeMs : 0,
        turnDecodeTokens: sameTurn ? state.turnDecodeTokens : 0,
        openStep: {
          turn: data.turn, step: data.step, startTime: event.time,
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

/* 请求体上限。原先统一 4KB，但**价格库会随模型数增长**：实测一条模型约 186 字节，
   24 个模型就超过 4096 → 请求被直接断开，客户端 fetch 抛错又被 `.catch(() => {})` 吞掉，
   于是「设置页改的单价只对底栏生效、活跃总览恒用旧价」而且毫无提示（实测缺陷）。
   这里的接口只服务本机、只收本插件自己的小 JSON，放宽到 256KB 足够且没有实际风险。 */
const JSON_BODY_LIMIT = 256 * 1024

/**
 * 读一小段 JSON 请求体。
 * @returns {Promise<object|null>} 解析失败或超限返回 null
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let settled = false
    let overLimit = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (overLimit === true) return
      raw += chunk
      if (raw.length > JSON_BODY_LIMIT) {
        overLimit = true
        /* 先记下超限，再断开。**不要**在 destroy 之后写响应（socket 已销毁，写不进去）。 */
        raw = ''
        req.destroy()
        finish(null)
      }
    })
    req.on('end', () => {
      if (overLimit === true) return
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

/**
 * 本机路由取余额的适配器（当前只有 WorkBuddy 积分）。
 *
 * 为什么不直接调上游：WorkBuddy 的凭据由 connect 类插件解密持有，
 * 上游的鉴权头、计费接口与响应解析也都在它那边。它把这些结论挂在本机 Web 路由上，
 * 这里只读那条路由 —— 本插件既不碰凭据，也不用把上游协议再实现一遍。
 *
 * 连的是 loopback，Host 头是 127.0.0.1:port，不带 Origin，正好过对方路由的 loopback 校验。
 */

/** 从 webServer 服务上取本机端口；取不到返回 null。 */
function localWebPort(ctx) {
  /* inject 里声明过 webServer，所以 ctx.webServer 与 ctx.get('webServer') 是同一个对象；
     两条都试，取第一个真带端口号的，免得宿主哪天改注册方式、或某个入口没挂服务时就取不到。 */
  const candidates = []
  if (ctx !== null && ctx !== undefined) {
    if (ctx.webServer !== undefined && ctx.webServer !== null) candidates.push(ctx.webServer)
    if (typeof ctx.get === 'function') {
      try {
        const viaGet = ctx.get('webServer')
        if (viaGet !== undefined && viaGet !== null) candidates.push(viaGet)
      } catch (error) {
        /* 服务没注册时 get 可能抛错，忽略 */
      }
    }
  }
  const withPort = candidates.filter((one) => typeof one.port === 'number' && one.port > 0)[0]
  const port = withPort !== undefined ? withPort.port : Number(process.env.DSH_WEB_PORT)
  return Number.isFinite(port) && port > 0 ? port : null
}

/**
 * 探测一条本机路由：返回 `{ reachable, data }`。
 *
 * `reachable` 的判据来自可行性调研的实测（这一步很关键，否则会误判）：
 *   · 200 + JSON                → 可达，`data` 是解析好的文档
 *   · 405 / 403 / 400 + JSON    → **路由存在**（只是方法/来源/参数不对）⇒ 可达但不可读
 *   · 404 **且**无 Content-Type **且**空体 → 宿主兜底「这条路由没注册」⇒ 不可达
 *   · 其它（网络、超时、5xx）    → 环境问题 ⇒ 不可达，且调用方**不该**据此换下一条路径
 * 为什么 404 要连 Content-Type 与空体一起判：插件自己的 handler 也会返回 404+JSON
 * （本插件的 `/api` 就是），只看状态码会把「插件在、但没这条数据」当成「插件不在」。
 */
async function probeLocalRoute(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    const type = response.headers === undefined || typeof response.headers.get !== 'function'
      ? null
      : response.headers.get('content-type')
    if (response.status === 404 && (type === null || type.indexOf('json') < 0)) {
      return { reachable: false, data: null, reason: 'http-404' }
    }
    if (!response.ok) {
      return { reachable: true, data: null, reason: 'http-' + String(response.status) }
    }
    let data = null
    try {
      data = await response.json()
    } catch (error) {
      data = null
    }
    return { reachable: true, data: data, reason: null }
  } catch (error) {
    return { reachable: false, data: null, reason: 'network' }
  }
}

/**
 * 候选路径：适配器自己声明的（新旧插件各一条）+ **通用发现**到的（同族插件）。
 *
 * 通用发现读的是宿主 webServer 的 `exact` / `prefixes` 两张路由表。它们是**未公开内部字段**
 * （全宿主没有任何消费方枚举过），所以整段必须 try/catch：拿不到就当"发现不可用"，
 * 静默回退到声明表 —— 宿主哪天改名，这里只是少发现几个插件，不会让余额整块崩掉。
 */
function localCandidatePaths(ctx, adapter, provider) {
  const declared = typeof adapter.pathsOf === 'function'
    ? adapter.pathsOf(provider)
    : [adapter.request(null, null, provider).path]
  const out = declared.slice()
  if (typeof pluginRoutesIn !== 'function') return out
  let found = []
  try {
    const server = ctx === null || ctx === undefined ? null : ctx.webServer
    const tables = server === null || server === undefined ? [] : [server.exact, server.prefixes]
    for (let i = 0; i < tables.length; i += 1) {
      found = found.concat(pluginRoutesIn(tables[i]))
    }
  } catch (error) {
    /* 未公开内部字段：拿不到就只用声明表（正常路径，不是错误） */
    return out
  }
  /* 通用发现只补**同族**（connect 类）的只读路由，且不重复声明过的。
     只认插件 id 里含本适配器 keys 的那些（workbuddy / codebuddy）：
     这样换插件作者、换包名（dsh-workbuddy-connect → dsh-connect-workbuddy）时能自动跟上，
     而不会把无关插件的 /usage 也拉进来盲探 —— 那既慢（实测单次 0.5-0.7s，含上游读取），
     又可能碰到别人的私有路由。 */
  const keys = Array.isArray(adapter.keys) ? adapter.keys : []
  for (let i = 0; i < found.length; i += 1) {
    const one = found[i]
    if (out.indexOf(one.path) >= 0) continue
    const idText = String(one.pluginId).toLowerCase()
    const related = keys.some((key) => idText.indexOf(String(key).toLowerCase()) >= 0)
    if (related !== true) continue
    out.push(one.path)
  }
  return out
}

async function queryLocalAdapter(ctx, adapter, now, provider) {
  const port = localWebPort(ctx)
  if (port === null) {
    logHost(ctx, 'balance(' + adapter.id + '): 拿不到本机 Web 端口')
    return { ok: false, at: now, reason: 'no-local-port', provider: adapter.id }
  }
  const paths = localCandidatePaths(ctx, adapter, provider)
  let last = null
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i]
    const url = 'http://127.0.0.1:' + String(port) + path
    const probed = await probeLocalRoute(url)
    /* 环境类失败（网络/超时）不换下一条：换路径不会变好，反而多发请求、
       还可能把真实的网络问题掩盖成"两个插件都没有"。 */
    if (probed.reachable !== true && probed.reason !== 'http-404') {
      logHost(ctx, 'balance(' + adapter.id + '): 本机路由请求失败 ' + String(probed.reason))
      return { ok: false, at: now, reason: probed.reason, provider: adapter.id }
    }
    if (probed.reachable !== true) {
      /* 这条路径没注册（裸 404）：试下一条候选 */
      last = { ok: false, at: now, reason: 'http-404', provider: adapter.id }
      continue
    }
    if (probed.reason !== null) {
      /* 路由存在但当前读不了（405/403/400）：记下来继续试下一条，最后如实报出 */
      logHost(ctx, 'balance(' + adapter.id + '): 本机路由 ' + path + ' 返回 ' + String(probed.reason))
      last = { ok: false, at: now, reason: probed.reason, provider: adapter.id }
      continue
    }
    const data = probed.data
    /* 未登录时对方给的是 status: 'signed-out'，没有 credits 字段，解析自然落到失败分支 */
    if (data !== null && data !== undefined && data.creditsError !== undefined && data.creditsError !== null) {
      logHost(ctx, 'balance(' + adapter.id + '): 上游积分查询失败 ' + String(data.creditsError).slice(0, 120))
      last = { ok: false, at: now, reason: 'credits-error', provider: adapter.id }
      continue
    }
    const parsed = adapter.parse(data)
    if (parsed === null) {
      logHost(ctx, 'balance(' + adapter.id + '): 本机路由里没有积分（未登录或上游未返回）')
      last = { ok: false, at: now, reason: 'no-credits', provider: adapter.id }
      continue
    }
    logHost(ctx, 'balance(' + adapter.id + '): 积分 ' + String(parsed.total) + '（来自 ' + path + '）')
    return {
      ok: true,
      at: now,
      source: 'local-route',
      provider: adapter.id,
      currency: parsed.currency,
      total: parsed.total,
      isCredits: parsed.isCredits === true,
      isPercent: parsed.isPercent === true,
      parts: parsed.parts,
      toppedUp: partAmount(parsed.parts, 'toppedUp'),
      granted: partAmount(parsed.parts, 'granted'),
      spent: partAmount(parsed.parts, 'spent'),
    }
  }
  return last !== null ? last : { ok: false, at: now, reason: 'no-credits', provider: adapter.id }
}

/* force 目前不改变行为（余额不缓存，每次请求都现查），但客户端点开气泡时会带 force=1
   表达"强制刷新"，保留该形参以维持 HTTP 契约，避免为省一个参数去动客户端回调。 */
async function queryBalance(ctx, force, provider, model) {
  const now = Date.now()

  /* 当前会话用的是第三方平台就交给适配器：每个平台有自己的端点、鉴权与字段。
     走**适配器链**：智谱的"现金余额"与"coding plan 配额"是两条独立的路、keys 完全重叠，
     单选的 adapterFor 只会命中前者，于是 coding plan 用户永远拿不到配额（实测症状：
     底栏余额恒为 ¥-）。链上按顺序逐个请求，**第一个解析出结果的胜出** —— 判定交给
     各家自己的 parse（那是已核实上游协议的唯一权威），这里不另立规则。
     非智谱平台链长恒为 1，行为与旧版逐字节一致。 */
  const chain = adaptersFor(provider, model)
  const adapter = chain.length > 0 ? chain[0] : null
  if (adapter !== null && adapter.local === true) {
    const local = await queryLocalAdapter(ctx, adapter, now, provider)
    /* 这个平台的计量单位是积分，失败态也要带上：客户端据此决定不拼货币符号 */
    const value = local.ok === true ? local : Object.assign({}, local, { isCredits: true })
    return value
  }
  if (adapter !== null && adapter.id !== 'deepseek') {
    let last = null
    for (let i = 0; i < chain.length; i += 1) {
      const one = chain[i]
      /* 本地路由型适配器（积分）不走这条：它没有外部端点，且上面已经单独处理过 */
      if (one.local === true) continue
      const attempt = await queryWithAdapter(ctx, one, now)
      if (attempt.ok === true) {
        if (i > 0) {
          logHost(ctx, 'balance(' + one.id + '): 主适配器 ' + adapter.id + ' 没给出余额，回退到这条命中')
        }
        return attempt
      }
      last = attempt
      /* 只有"端点答了、但响应结构不是这一路"（no-balance-info）才值得换下一条：
         按量计费账号在配额接口上拿不到 limits，coding plan 在余额接口上拿不到 code=200
         —— 这两种正是要靠回退解决的。HTTP / 网络 / 缺凭据是**环境**问题，换端点不会
         变好，反而多发一次请求、还可能把真实的鉴权失败掩盖成"配额也没有"。 */
      if (attempt.reason !== 'no-balance-info') return attempt
    }
    return last !== null ? last : { ok: false, at: now, reason: 'unknown-platform' }
  }

  /* 会话明确在用别的平台、但这个平台认不出来时不硬凑：硬凑会把 DeepSeek 的余额
     当成对方的余额显示（比不显示更误导）。provider 还没上报（空）时才按 DeepSeek 处理。 */
  const hasProvider = typeof provider === 'string' && provider.trim().length > 0
  if (adapter === null && hasProvider) {
    const unknown = { ok: false, at: now, reason: 'unknown-platform' }
    logHost(ctx, 'balance: 认不出 ' + provider + ' 属于哪个平台，不显示余额')
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
      return fromAccount
    }
    const noAccount = { ok: false, at: now, reason: 'account-unavailable' }
    logHost(ctx, 'balance: 账号通道（' + provider + '）但账号服务不可用')
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
      return fromAccount
    }
    const missing = { ok: false, at: now, reason: 'no-credential' }
    logHost(ctx, 'balance: 环境变量 / credentials.yaml / credentials 服务都没取到 key，账号服务也不可用')
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
      return failed
    }
    const data = await response.json()
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const picked = infos.filter((info) => info.currency === 'CNY')[0] ?? infos[0]
    if (picked === undefined) {
      const empty = { ok: false, at: now, reason: 'no-balance-info', source: found.source }
      logHost(ctx, 'balance: 响应里没有 balance_infos')
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
    return value
  } catch (error) {
    const detail = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : 'request-failed'
    const failed = { ok: false, at: now, reason: 'request-failed', detail, source: found.source }
    logHost(ctx, 'balance: 请求异常 ' + detail)
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
 * 重复计数，删掉会话也不会让已记下的数字缩水；窗口是**滚动的「近 7 天」**
 * （见 recentStartMs：今天往前推 6 天，不再对齐自然周）。
 * 全程只读 token 数字，不读正文，台账里也只有数字、没有对话内容。
 */

/**
 * 柱状窗口的起点：**本机时区**今天 00:00 往前推 6 天，也就是「近 7 天」。
 * 这里用的是滚动窗口，不再对齐自然周 —— 用户看到的是最近七天，而不是本周一到现在。
 *
 * 日期一律按**装机者所在时区**算（见 localDateKey 的说明），不再固定 UTC+8。
 */
function recentStartMs(now) {
  const d = new Date(now)
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return todayStart - 6 * 24 * 3600 * 1000
}

/** 本月 1 号 00:00（本机时区）的毫秒时间戳。 */
function monthStartMs(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const padTwo = (value) => (value < 10 ? '0' + String(value) : String(value))

/** 当年 1 月 1 日 00:00（本机时区）的毫秒时间戳 —— 12 个月的统计要从这里扫起。 */
function yearStartMs(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), 0, 1).getTime()
}

/**
 * 日期键 'YYYY-MM-DD' —— 按**装机者所在时区**取，与客户端同一口径。
 *
 * 曾经固定用北京时间（UTC+8）：那是 DeepSeek 峰谷计价与账单的口径，但**日期归属**
 * 不该跟着它走 —— 使用者看的是自己日历上的「今天/昨天」，UTC+8 装机时两地一致，
 * 非 UTC+8 的机器上活跃总览会整体错一天（今天那格高亮成昨天、未来/过去的灰阶也偏）。
 *
 * 注意区分两件事，别把这里改回去：
 *   · **日期归属**（这条函数）＝ 装机者时区，纯粹是给人看的日历。
 *   · **峰谷计价**（isPeakTime）＝ 北京时间，那是 DeepSeek 的官方计费规则，与装机位置无关。
 */
function localDateKey(ms) {
  const date = new Date(ms)
  return date.getFullYear() + '-' + padTwo(date.getMonth() + 1) + '-' + padTwo(date.getDate())
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

/**
 * 客户端上报的价格库（localStorage 里那份，用户可增删改）。
 *
 * 为什么 host 要收下它：活跃总览的 cost 是 host 扫会话日志时**当场算好写进台账**的，
 * 以前只认上面那张硬编码表 —— 用户在设置页加的模型（如 WorkBuddy 的
 * `Deepseek-V4.1-Flash`）在底栏能算，在活跃总览却恒为 0（实测 2026-10-07）。
 * 客户端启动/改价时 POST 过来，两边就用同一份价格。
 *
 * 形状：{ 模型名: { peak: {...}, offPeak: {...} } }，与客户端 normalizePrice 之后一致。
 * 为 null 表示还没收到，此时回退到 TOKEN_PRICES。
 */
let clientPrices = null

/* 当前**真正生效**的那份价格库的指纹：只在 queueLedgerJob 里读写。
   价格上报靠它判断"这次上报是不是真的改了价" —— 快照若取在队列外，
   两个并排上报会各拿一份旧快照、双双报"已变更"（实测残留，只影响返回值与日志）。 */
let activePriceFingerprint = null

/* ---------------------------------------- 模型名匹配（与客户端 lib/client.js 同规则） */

/**
 * 模型名切成词元：忽略大小写，分隔符（- . _ 空格等）都当边界。
 * `DeepSeek-V4.1-Flash-SG` → ['deepseek','v4','1','flash','sg']
 */
function modelNameTokens(name) {
  return typeof name === 'string'
    ? name.toLowerCase().split(/[^a-z0-9]+/).filter((one) => one.length > 0)
    : []
}

/** 词元是否对得上：**完全相等**（大小写已经在切词时归一）。 */
function tokenMatches(needle, hay) {
  return needle === hay
}

/** 一条价格是不是"什么都没填"：两档四项加起来是 0。用来把未定价的条目挡在匹配之外。 */
function priceIsBlank(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return true
  const tier = (one) => (one === null || one === undefined ? 0
    : numOrZero(one.input) + numOrZero(one.cacheRead) + numOrZero(one.cacheWrite) + numOrZero(one.output))
  return tier(entry.peak) + tier(entry.offPeak) === 0
}

/**
 * 这条价格里**有没有任何一格是数字**（= 用户真的填过）。八格全是 null（只在设置页点过
 * 「添加」还没填价就收起了）的条目**两轮匹配都不该算数**，否则第二轮兜底会把它当成
 * "明确设 0"，该模型的费用被静默算成 ¥0。要区分 null 与 0，`sanitizePriceBook`
 * 必须把 null 原样带进来（不能压成 0）。
 */
function hasAnyPriceValue(entry) {
  if (entry === null || entry === undefined || typeof entry !== 'object') return false
  const tiers = [entry.peak, entry.offPeak]
  for (let i = 0; i < tiers.length; i += 1) {
    const one = tiers[i]
    if (one === null || one === undefined || typeof one !== 'object') continue
    if (typeof one.input === 'number' || typeof one.cacheRead === 'number'
      || typeof one.cacheWrite === 'number' || typeof one.output === 'number') return true
  }
  return false
}

/**
 * 一轮匹配：① 同名单独先行；②③（子串命中与词元全含命中）**合并评选**，
 * 按 weight = 词元数 * 1000 + 键名长度 取最具体的那个 —— 不能分档跑，
 * 否则模型名里含一个短键（如 flash）就会把更具体的长键挤掉。
 * 含数字的键只允许子串命中，不走词元档。
 * skipBlank=true 时跳过"还没定价"（整条全 0）的条目。
 */
function matchPriceKeyOnce(book, model, skipBlank) {
  const keys = Object.keys(book)
  const lower = model.toLowerCase()
  /* 空键不参选；八格全 null 的条目两轮都不参选；skipBlank 那轮再跳过"有数字但总和 0"的条目 */
  const usable = (key) => key.length > 0
    && hasAnyPriceValue(book[key]) === true
    && (skipBlank !== true || priceIsBlank(book[key]) !== true)
  /* ① 同名：单独先行，最高优先 */
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === lower && usable(keys[i])) return keys[i]
  }
  /* ②③ 一次评选：子串命中的键与词元全含命中的键放在一起比 weight，取最具体的那个。
     不能按"先全部子串、再全部词元"两轮跑 —— 那样模型名里只要含一个短键（如 flash），
     就会把更具体的 deepseek-flash（只能靠词元档命中）挤掉。
     含数字的键（如 deepseek-v4-pro）只允许子串命中，不走词元档。 */
  const tokens = modelNameTokens(model)
  const weightOf = (key) => modelNameTokens(key).length * 1000 + key.length
  let best = null
  let bestWeight = -1
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (usable(key) !== true) continue
    let hit = lower.indexOf(key.toLowerCase()) !== -1
    if (hit !== true && /[0-9]/.test(key) !== true) {
      const want = modelNameTokens(key)
      if (want.length > 0) {
        hit = true
        for (let k = 0; k < want.length; k += 1) {
          let found = false
          for (let m = 0; m < tokens.length; m += 1) {
            if (tokenMatches(want[k], tokens[m]) === true) { found = true; break }
          }
          if (found !== true) { hit = false; break }
        }
      }
    }
    if (hit !== true) continue
    const weight = weightOf(key)
    if (weight > bestWeight) { bestWeight = weight; best = key }
  }
  return best
}

/**
 * 价格键 → 模型名：① 同名最优先；② 子串命中与③ 词元全含命中**合并评选**，取最具体的那个；
 * 名字里含数字的键（如 `deepseek-v4-pro`）只认子串，不做词元匹配 ——
 * 版本号不同的 pro 是另一个模型、另一个价，不该被旧版号吃掉。
 *
 * 为什么必须有词元档：默认键叫 `deepseek-flash`，而会话日志里记的是
 * `deepseek-v4.1-flash-sg` / `deepseek-v41-flash` —— 版本号插在中间，子串匹配命不中，
 * 那笔用量就会被当成"没有单价"（记欠账），默认价等于白配。
 *
 * **分两轮**：第一轮跳过"还没填价"（整条全 0）的条目 —— 用户加了条目但没填价，
 * 不该把该模型的费用算成 0；第一轮一无所获时才放开，让"明确把某模型定为 0 价"仍算得出来。
 * **必须与客户端 lib/client.js 的 pickPriceKey 逐条同规则**，否则底栏与活跃总览会算出两个价。
 */
function pickPriceKey(book, model) {
  if (book === null || book === undefined || typeof book !== 'object') return null
  if (typeof model !== 'string' || model.length === 0) return null
  const keys = Object.keys(book)
  if (keys.length === 0) return null
  const strict = matchPriceKeyOnce(book, model, true)
  if (strict !== null) return strict
  return matchPriceKeyOnce(book, model, false)
}

/**
 * 在一份价格库里按模型名查单价（匹配规则见 pickPriceKey）。
 *
 * 收 book 而不是直接读全局：迁移回扫要用**台账指纹还原出来的旧价目表**判断
 * "当时这个模型有没有价"，与"现在有没有价"是两回事。
 * 只从 Object.keys 里取键，模型名撞上 'constructor' / 'toString' 这类原型属性也拿不到东西。
 */
function priceEntryIn(book, model) {
  const key = pickPriceKey(book, model)
  return key === null ? null : book[key]
}

/**
 * 回扫描专用：按**当时那套规则**判断"这个模型当时有没有价"。
 *
 * v1/v2 的计价只认精确键名（内置表 `TOKEN_PRICES.peak[model]`、客户端价格库 `book[model]`），
 * 到本次改造之前只多了一步子串匹配；词元匹配与"最具体评选"都是这次才加的。
 * 用新规则回扫，会把"当年因名字对不上而记 0"的用量误判成"当时有价"直接跳过 ——
 * 那批钱就永远补不回来，而它们恰恰是这次加词元匹配要救的那类模型（实测缺陷）。
 */
function legacyPriceEntryIn(book, model) {
  if (book === null || book === undefined || typeof book !== 'object') return null
  if (typeof model !== 'string' || model.length === 0) return null
  if (Object.prototype.hasOwnProperty.call(book, model) === true) return book[model]
  const lower = model.toLowerCase()
  const keys = Object.keys(book)
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].length > 0 && lower.indexOf(keys[i].toLowerCase()) !== -1) return book[keys[i]]
  }
  return null
}

/** 当前生效价格库里的单价（记账与补算都走它）。 */
function priceEntryFor(model) {
  return priceEntryIn(activePriceBook(), model)
}

/* 2026 年法定节假日（国务院通知，与 /api/holidays 抓到的是同一份）：这些天全天按空闲价 */
const CN_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，法定节假日与周末全天按空闲价。 */
const PEAK_WINDOWS = [[9, 12], [14, 18]]

/* 抓到的法定节假日会落到 <DSH_HOME>/dsh-status-bar/holidays.json。
   host 的时段判定必须与客户端用同一份假期表：内置表只覆盖 2026，客户端却能把新一年的
   假期存进配置 —— 两边不一致时，2027 年起同一天底栏按空闲价、活跃总览按高峰价，差一倍
   （实测缺陷，用户点「更新节假峰谷」也修不了 host）。 */
function holidaysPath() {
  return join(dshHome(), 'dsh-status-bar', 'holidays.json')
}

let extraHolidays = null

/** 落盘过的法定节假日（带缓存）；文件不存在或读不动就当没有这回事。 */
function extraHolidayDays() {
  if (extraHolidays !== null) return extraHolidays
  const parsed = readJsonObjectFile(holidaysPath())
  extraHolidays = parsed !== null && Array.isArray(parsed.days)
    ? parsed.days.filter((one) => typeof one === 'string')
    : []
  return extraHolidays
}

/** 把抓到/同步来的节假日并进落盘文件（按日期去重排序），下次启动仍然生效。 */
function saveHolidayDays(days) {
  const merged = extraHolidayDays().slice()
  for (let i = 0; i < days.length; i += 1) {
    if (typeof days[i] === 'string' && merged.indexOf(days[i]) === -1) merged.push(days[i])
  }
  merged.sort()
  try {
    const dir = join(dshHome(), 'dsh-status-bar')
    const target = holidaysPath()
    const temp = target + '.tmp'
    mkdirSync(dir, { recursive: true })
    /* 原子写：直接覆盖时进程被中断会留下截断文件，下次启动读出空表，
       再保存就把原有假期永久丢掉（writeLedger 用的是同一套 temp+rename）。 */
    writeFileSync(temp, JSON.stringify({ updatedAt: Date.now(), days: merged }), 'utf8')
    renameSync(temp, target)
  } catch (error) {
    /* 写不进去不影响本次使用：内存里已经记下了 */
  }
  extraHolidays = merged
  return merged
}

/** 这一天是不是法定节假日：内置 2026 表 ∪ 抓取落盘的表。 */
function isLegalHoliday(key) {
  if (CN_HOLIDAYS_2026.indexOf(key) >= 0) return true
  return extraHolidayDays().indexOf(key) >= 0
}

function isPeakTime(ms) {
  const date = new Date(ms + 8 * 3600 * 1000)
  const key = date.getUTCFullYear() + '-' + padTwo(date.getUTCMonth() + 1) + '-' + padTwo(date.getUTCDate())
  if (isLegalHoliday(key) === true) return false
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  for (let i = 0; i < PEAK_WINDOWS.length; i += 1) {
    if (hour >= PEAK_WINDOWS[i][0] && hour < PEAK_WINDOWS[i][1]) return true
  }
  return false
}

/**
 * 内置参考价 → 价格库的形状（{模型: {peak, offPeak}}）。
 *
 * TOKEN_PRICES 是两张按档分开的表（`peak[模型]` / `offPeak[模型]`），而价格库是
 * 一条模型一份两档。两者混用会让查价静默失败 —— 内置模型也算不出钱、回扫时把
 * 已经计过价的用量当成"当时缺价"再补一遍（费用翻倍）。所以内置表必须先转一次。
 */
let builtinBookCache = null

function builtinPriceBook() {
  if (builtinBookCache !== null) return builtinBookCache
  const out = {}
  const names = Object.keys(TOKEN_PRICES.peak)
  for (let i = 0; i < names.length; i += 1) {
    const peak = TOKEN_PRICES.peak[names[i]]
    const offPeak = TOKEN_PRICES.offPeak[names[i]]
    if (peak === undefined && offPeak === undefined) continue
    out[names[i]] = {
      peak: peak !== undefined ? peak : offPeak,
      offPeak: offPeak !== undefined ? offPeak : peak,
    }
  }
  builtinBookCache = out
  return out
}

/** 当前生效的价格库：收到过客户端上报就用它，否则回退到内置参考价（同一形状）。 */
function activePriceBook() {
  return clientPrices !== null ? clientPrices : builtinPriceBook()
}

/** 把任意来源的金额压成有限数；给不出数就当 0。 */
function numOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 从客户端价格库里认出一份干净的 {模型: {peak, offPeak}}。
 * 客户端来的东西一律当不可信输入：只收形状对的条目，非数一律压成 0，别的字段丢掉。
 * 空库返回 null（视为"没有信息"，不用它覆盖已有价格）。
 */
function sanitizePriceBook(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  /* 空字符串 / null / undefined 一律保留成 null —— "没填"必须与"明确填 0"区分开，
     压成 0 的话匹配与回扫都会把空条目当成"用户把价定成了 0"。 */
  const keep = (value) => (value === null || value === undefined || value === '' ? null : numOrZero(value))
  const tier = (value) => (value !== null && value !== undefined && typeof value === 'object'
    ? {
      input: keep(value.input),
      cacheRead: keep(value.cacheRead),
      cacheWrite: keep(value.cacheWrite),
      output: keep(value.output),
    }
    : null)
  const out = {}
  const names = Object.keys(raw)
  for (let i = 0; i < names.length; i += 1) {
    /* 空键会命中一切模型名（子串判定里空串人人都"包含"），直接丢掉 */
    if (names[i].length === 0) continue
    const entry = raw[names[i]]
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const peak = tier(entry.peak)
    const offPeak = tier(entry.offPeak)
    if (peak === null && offPeak === null) continue
    /* 保留「是否峰谷计价」：没勾的条目是**全天一个价**，计价时两档都要取 peak，
       否则空闲时段会挑到那个没填的档、把费用算成 0（实测缺陷）。缺省按两档。 */
    const code = entry.currency === 'USD' ? 'USD' : (entry.currency === 'CNY' ? 'CNY' : null)
    out[names[i]] = {
      peak: peak !== null ? peak : offPeak,
      offPeak: offPeak !== null ? offPeak : peak,
      tiered: entry.tiered !== false,
      /* 条目币种：**带了就原样保留**（`CNY` / `USD`），没带就**不补**——
         host 算钱只认数值、不看币种（台账与历史都不受影响），币种是客户端用来
         决定"这条按哪种货币填的"；缺省由客户端按它自己的默认币种解释，
         host 不替它决定（否则往返一次多出一个字段，深比较基准会被悄悄改掉）。
         注意：必须保留，不保留就等于清洗时把币种丢了。 */
      ...(code === null ? {} : { currency: code }),
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 价格库指纹：把一份价格库压成一行文本。两个用途 ——
 *   ① 判断"价格有没有变"（变了才去结算欠账）；
 *   ② 迁移回扫时把**当时那份价目表**还原出来（判断某个模型当时有没有价）。
 *
 * 它以前的作用是"不一致就把台账整本丢丢掉重扫"，那会连已经算好的费用一起改掉，
 * 会话日志一旦被删，历史数字就再也算不回来。现在它只读不写、只用来触发补算。
 */
function fingerprintOf(book) {
  const names = Object.keys(book === null || book === undefined ? {} : book).sort()
  const parts = []
  for (let i = 0; i < names.length; i += 1) {
    const one = book[names[i]]
    const pick = (t) => (t === null || t === undefined ? 'x' : [numOrZero(t.input), numOrZero(t.cacheRead), numOrZero(t.cacheWrite), numOrZero(t.output)].join(','))
    parts.push(names[i] + ':' + pick(one.peak) + ':' + pick(one.offPeak))
  }
  return parts.join('|')
}

function priceFingerprint() {
  return fingerprintOf(activePriceBook())
}

/**
 * 指纹 → 价格库（fingerprintOf 的逆运算），迁移回扫用它还原"当时的价格库"。
 * 单条形状对不上（段数不是 3、数字不合法）就跳过那一条；整体为空的返回 null。
 */
function parseFingerprint(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const out = {}
  const segments = text.split('|')
  const tier = (raw) => {
    if (raw === 'x') return null
    const nums = raw.split(',')
    if (nums.length !== 4) return null
    const one = {
      input: Number(nums[0]),
      cacheRead: Number(nums[1]),
      cacheWrite: Number(nums[2]),
      output: Number(nums[3]),
    }
    if (Number.isFinite(one.input) !== true || Number.isFinite(one.cacheRead) !== true
      || Number.isFinite(one.cacheWrite) !== true || Number.isFinite(one.output) !== true) return null
    return one
  }
  for (let i = 0; i < segments.length; i += 1) {
    const fields = segments[i].split(':')
    if (fields.length !== 3) continue
    const peak = tier(fields[1])
    const offPeak = tier(fields[2])
    if (peak === null && offPeak === null) continue
    out[fields[0]] = { peak: peak !== null ? peak : offPeak, offPeak: offPeak !== null ? offPeak : peak }
  }
  return Object.keys(out).length === 0 ? null : out
}

/** 一笔用量按单价折成人民币；模型没有价格表就返回 0（不计入花费）。 */
function tokenCost(model, at, parts) {
  const entry = priceEntryFor(model)
  if (entry === null) return 0
  /* 没勾「峰谷计价」= 全天一个价：两档都取 peak，否则空闲时段会挑到没填的那档、算成 0 */
  const price = entry.tiered === false ? entry.peak : (isPeakTime(at) ? entry.peak : entry.offPeak)
  const use = price !== null && price !== undefined ? price : entry.peak
  if (use === null || use === undefined) return 0
  return (parts.input * numOrZero(use.input) + parts.cacheRead * numOrZero(use.cacheRead)
    + parts.cacheWrite * numOrZero(use.cacheWrite) + parts.output * numOrZero(use.output)) / 1e6
}

/**
 * 这个模型的条目是按哪种货币填的（`CNY` / `USD`，缺省 `CNY`）。
 *
 * 只服务于"按币种分桶汇总"：**算钱本身不看币种**（台账、历史数字都不受影响），
 * 客户端拿到分桶后按参考价比例折成底栏显示币种，混币时才能给出一个数字。
 */
function tokenCostCurrency(model) {
  const entry = priceEntryFor(model)
  return entry !== null && entry.currency === 'USD' ? 'USD' : 'CNY'
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

/* ------------------------------------------------- 会话头部（认父子关系用） */

/**
 * 只解压**第一帧**。会话日志是多帧拼接，头部事件一定落在第一帧里；
 * 而一个会话的日志可能几 MB —— 为了读一行 header 把整份解压一遍太贵。
 * 解不出来（帧被截断、运行时没有 zstd）返回 null，调用方退回全量解压。
 */
function firstFrameText(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const start = buf.indexOf(ZSTD_MAGIC)
  if (start < 0) return null
  const next = buf.indexOf(ZSTD_MAGIC, start + 4)
  try {
    return zlib.zstdDecompressSync(buf.subarray(start, next < 0 ? buf.length : next)).toString('utf8')
  } catch (error) {
    return null
  }
}

/**
 * 会话日志第一行的身份：`{ id, parentSession }`。
 * `parentSession` 只在**子智能体**的会话里出现（主会话没有这个字段），
 * 所以它就是"谁是谁的队友"的唯一线索。第一行不是头部事件、或 JSON 解不出来时返回 null。
 */
function sessionHeaderOf(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const end = text.indexOf('\n')
  const line = end < 0 ? text : text.slice(0, end)
  /* 先按子串筛一道：整行 JSON.parse 比 indexOf 贵得多，而绝大多数行都不是头部事件 */
  if (line.indexOf('"session"') < 0) return null
  let event
  try {
    event = JSON.parse(line)
  } catch (error) {
    return null
  }
  if (event === null || typeof event !== 'object' || event.type !== 'session') return null
  if (typeof event.id !== 'string' || event.id.length === 0) return null
  return {
    id: event.id,
    parentSession: typeof event.parentSession === 'string' && event.parentSession.length > 0
      ? event.parentSession
      : null,
  }
}

/* 读头部时先只看文件最前面这么多字节：第一帧几乎总在这一段里，
   而真实会话日志单个能到几 MB —— 为了读一行 header 把整份读进内存太浪费。 */
const HEADER_HEAD_BYTES = 64 * 1024

/** 读文件开头的一小段（拿不到就返回 null，交给调用方退回全文读）。 */
function readFileHead(file, bytes) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return read > 0 ? buf.subarray(0, read) : null
  } catch (error) {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (error) {
        /* 关不上不影响已经读到的内容 */
      }
    }
  }
}

/** 读一个会话日志文件的头部。读不出 / 解不出 / 没有头部一律返回 null，绝不抛。 */
function sessionHeaderOfFile(file) {
  /* 快路径：只读前 64 KB。首帧完整落在这一段里时就直接拿到头部；否则退回全文读一遍。 */
  const head = readFileHead(file, HEADER_HEAD_BYTES)
  if (head !== null) {
    const fast = firstFrameText(head)
    const parsed = sessionHeaderOf(fast === null ? '' : fast)
    if (parsed !== null) return parsed
  }
  let buf
  try {
    buf = readFileSync(file)
  } catch (error) {
    return null
  }
  const text = zstdText(buf)
  return text === null ? null : sessionHeaderOf(text)
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
      /* 模型名的两个来源：assistant/message 在 message.source.model，
         而 compaction/summary（压缩摘要本身是一次真实模型调用）把模型放在顶层 data.model ——
         只认前者会让整笔摘要用量落进「(未知模型)」欠账，永远结算不出来。 */
      const model = source !== null && typeof source.model === 'string'
        ? source.model
        : (typeof data.model === 'string' && data.model.length > 0 ? data.model : null)
      picked.set(key, {
        seq: typeof event.seq === 'number' ? event.seq : Math.round(event.time),
        time: event.time,
        parts: parts,
        isMessage: isMessage,
        /* 计价要用模型名（不同模型单价不同） */
        model: model,
      })
    }
  }
  return picked
}

/* ------------------------------------------- 子智能体用量（「总计」要算上队友） */

/* 后代上限：**不是产品限制**，只用来防畸形数据（例如被污染成上千个会话目录的 sessions 树）
   把后台拖死 —— 用户明确要求"所有队友的对话都要算"，所以这个值取得远大于任何真实
   Agent Teams 树（真实场景是几十个会话），正常情况永远不触发；真触发了才带 truncated: true。 */
const SUBAGENT_MAX_DESCENDANTS = 2000

/* file → `{ mtimeMs, size, header }`（header 为 null = 这个文件读不出头部）。
   **失败也缓存**：坏文件、非日志文件、正在写的文件不该每次请求都重读两遍（64KB 快路径 + 全文退回）。
   靠 mtime+size 判断"还是那一份"：文件一变（正常写入都会让 size/mtime 变）就自动重试 ——
   刚建好、header 还没落盘的文件下一次请求就能认出来，而真正的坏文件不会一直被反复读。
   头部里的 id / parentSession 是会话创建时写死的，所以读成功的那份不会失效，只有 stat 变了才重读。
   上限 SUBAGENT_HEADER_CACHE_MAX 条，超出丢最久没被重新写入的（Map 的插入顺序）。 */
const SUBAGENT_HEADER_CACHE_MAX = 512
const subagentHeaders = new Map()

/** 两份同名会话文件谁更新：先比 mtime，一样再比 size（更大的一般更完整）。 */
function headerEntryNewer(candidate, current) {
  if (candidate.mtimeMs !== current.mtimeMs) return candidate.mtimeMs > current.mtimeMs
  return candidate.size > current.size
}

/**
 * 会话文件 → `parentSession → [子会话]` 邻接表（外加 `duplicates` 计数，只用来打日志）。
 *
 * 为什么要拆成"先建索引、再算用量"：索引只需要读每个文件的**第一帧**（很便宜），
 * 而用量要把后代日志整份解压（很贵）。索引按 `文件 + mtimeMs + size` 增量维护（失败也缓存），
 * 用量那份按 `(父会话, 参与文件 mtime+size, 窗口, 价格指纹)` 缓存，两层各管一层失效。
 */
async function subagentIndexSnapshot(files) {
  const live = new Set(files)
  for (const file of Array.from(subagentHeaders.keys())) {
    if (live.has(file) !== true) subagentHeaders.delete(file)
  }
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    let stat = null
    try {
      stat = statSync(file)
    } catch (error) {
      stat = null
    }
    if (stat === null) {
      /* 文件在遍历中消失：连同缓存一起丢掉，下次它再出现就是新的一份 */
      subagentHeaders.delete(file)
      continue
    }
    const cached = subagentHeaders.get(file)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue
    /* 读失败（含"没有头部"）也记下来：同一个 mtime/size 的下一问直接跳过，不再重读 */
    const header = sessionHeaderOfFile(file)
    subagentHeaders.delete(file)
    subagentHeaders.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, header })
    while (subagentHeaders.size > SUBAGENT_HEADER_CACHE_MAX) {
      const oldest = subagentHeaders.keys().next()
      if (oldest.done === true) break
      subagentHeaders.delete(oldest.value)
    }
    /* 首次请求要把所有会话都读一遍头部：每 8 个让出一次事件循环，别把 host 卡住 */
    if (i % 8 === 7) await new Promise((resolve) => setImmediate(resolve))
  }
  /* 一个会话 id 可能出现在两个文件里：① 日志格式升级时同目录留下旧版本文件；
     ② 手工复制会话目录；③ 异常产生的重复目录。只认**最新的那一份**参与聚合
     （mtime 相同则取更大的那份）：既防同一批用量算两遍，也不让旧文件里的过期数字
     盖掉新文件。完全相同（mtime 与 size 都一样）时保留先读到的那份，保证结果稳定。 */
  const picked = new Map()
  subagentHeaders.forEach((entry, file) => {
    if (entry.header === null) return
    const one = {
      id: entry.header.id, file: file, parentSession: entry.header.parentSession,
      mtimeMs: entry.mtimeMs, size: entry.size,
    }
    const prev = picked.get(one.id)
    if (prev === undefined || headerEntryNewer(one, prev) === true) picked.set(one.id, one)
  })
  const children = new Map()
  picked.forEach((one) => {
    if (one.parentSession === null) return
    const list = children.get(one.parentSession) ?? []
    /* 把 stat 一起带上：后面算用量时就不必再对同一批文件 stat 一遍
       （队友多时这一遍是实打实的开销），mtime/size 也就是缓存键要用的那两个值 */
    list.push({ id: one.id, file: one.file, parentSession: one.parentSession, mtimeMs: one.mtimeMs, size: one.size })
    children.set(one.parentSession, list)
  })
  let withHeader = 0
  subagentHeaders.forEach((entry) => { if (entry.header !== null) withHeader += 1 })
  return { children, duplicates: withHeader - picked.size, byId: picked }
}

/**
 * 一段父会话日志里的"本轮起点"：最后一条 `turn/start` 的时间 —— 但**和最后一条
 * `user/message` 取较大的那个**。都找不到就返回 null（调用方据此判 sinceSource='none'）。
 *
 * 为什么不是"有 turn/start 就优先用它"：用户消息比最后一条 turn/start 还新，说明
 * **新一轮已经开始、而它的 `turn/start` 还没落盘**；此时沿用旧的 turn/start 会把
 * **上一轮**的队友用量算进"本轮"，方向正是用户不允许的"偏大"。取较新的那个时间
 * 只会把窗口往回收（宁少不多），符合"本轮只能小不能大"。
 * 取**最大值**而不是"文件里最后一行"：正常日志是追加写的，两者一致；万一有乱序行，
 * 取最大值更稳。
 */
function lastTurnStartOfText(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let at = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.indexOf('"turn/start"') < 0 && line.indexOf('"user/message"') < 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event === null || typeof event !== 'object' || typeof event.time !== 'number') continue
    if (event.type !== 'turn/start' && event.type !== 'user/message') continue
    if (at === null || event.time > at) at = event.time
  }
  return at
}

/**
 * 一段父会话日志里**最后一条用量事件**的时间（`assistant/message` 或 `compaction/summary`
 * 且带非空 usage）。只服务于一个问题："这个窗口起点之后，父会话自己到底产出过没有？"
 *
 * 只留**最大值**（一个数字）而不是把整串事件时间攒下来：要回答的是存在性
 * （"有没有 time >= fromMs 的用量事件" ⟺ "最大用量时间 >= fromMs"），
 * 而父会话日志是整棵树里最大的那一份，不该为一道布尔判断在内存里留一串时间戳。
 * 全 0 的 usage（被中断的尝试）不算产出 —— 与 pickUsageEvents 的口径一致。
 */
function lastUsageEventTimeOfText(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let at = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* 两道便宜的字符串筛（与 pickUsageEvents / foldSessionTiming 同一套省法）：
       绝大多数行既没有 usage 也不是这两类事件，逐行 JSON.parse 太贵 */
    if (line.indexOf('"usage"') < 0) continue
    if (line.indexOf('"assistant/message"') < 0 && line.indexOf('"compaction/summary"') < 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event === null || typeof event !== 'object' || typeof event.time !== 'number') continue
    if (event.type !== 'assistant/message' && event.type !== 'compaction/summary') continue
    const usage = usageOfEvent(event)
    if (usage === null) continue
    const parts = usageParts(usage)
    if (parts.input === 0 && parts.cacheRead === 0 && parts.cacheWrite === 0 && parts.output === 0) continue
    if (at === null || event.time > at) at = event.time
  }
  return at
}

/* 父会话日志 → 它自己的"本轮事实"：①本轮起点 ②窗口内有没有它自己的用量事件。
   这个文件每次对话都在写，但只是解压一份日志、折两个标量，代价很低；照样按
   `文件 + mtime + size` 记忆化（内容一变就重折）—— 两件事**共用同一次解压**，
   免得每秒的请求为了校验起点再把这棵树上最大的日志解第二遍。
   上限 SUBAGENT_SINCE_CACHE_MAX 条，超出丢最久没被重新写入的。 */
const SUBAGENT_SINCE_CACHE_MAX = 32
const subagentSinceCache = new Map()

function parentLogFactsOf(one) {
  const key = one.file + '|' + String(one.mtimeMs) + '|' + String(one.size)
  const hit = subagentSinceCache.get(key)
  if (hit !== undefined) return hit
  let text = null
  try {
    text = zstdText(readFileSync(one.file))
  } catch (error) {
    text = null
  }
  const value = text === null
    ? { since: null, lastUsageAt: null }
    : { since: lastTurnStartOfText(text), lastUsageAt: lastUsageEventTimeOfText(text) }
  subagentSinceCache.set(key, value)
  while (subagentSinceCache.size > SUBAGENT_SINCE_CACHE_MAX) {
    const oldest = subagentSinceCache.keys().next()
    if (oldest.done === true) break
    subagentSinceCache.delete(oldest.value)
  }
  return value
}

/** 父会话日志 → 它自己的"本轮起点"（推不出来给 null）。薄壳，只为既有调用点读起来更直白。 */
function parentTurnStartOf(one) {
  return parentLogFactsOf(one).since
}

/* 每个父会话一份结果：`sessionId → { key, value }`，key 见 collectSubagentUsage。
   底栏可能同时开着好几个会话，单槽缓存会被别的会话的请求挤掉 —— 那就等于没有缓存。
   最多留 8 份，超出丢最久没用的（Map 的插入顺序）。 */
const SUBAGENT_CACHE_MAX = 8
const subagentUsageCache = new Map()

/** 会话日志里的一笔用量折成钱（6 位小数，与台账的金额口径一致）。 */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6
}

/** 四项 token 的空桶。 */
function zeroTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/**
 * 给返回值补上 `sinceClamped`：**本次请求**的起点是否被 host 收敛过。
 *
 * 为什么不在缓存里存：收敛后的窗口与"客户端本来就给对了"的窗口是同一个值，
 * 两条请求共用同一条缓存（这是有意的，避免同一窗口算两遍），所以"是否收敛"
 * 是**每次请求自己的事实**，不能烘进缓存对象里 —— 否则先来的那次收敛会把标记
 * 传染给后面给对了起点的请求。不收敛时原样返回（走缓存的那条零拷贝路径）。
 */
function withClampFlag(value, clamped) {
  if (clamped !== true) return value
  return Object.assign({}, value, { sinceClamped: true })
}

/**
 * 一条会话日志的「首字 / 解码」累计：给底栏那三项（首字平均、综合速度、缓存命中）里
 * 属于子智能体的那一份用。
 *
 * 子会话借不到官方 `sessionStats`（那是 **per-session** 的），只能照 `sessionTimingProjection`
 * 那套逐次折法自己再来一遍，规则必须与它**逐条一致**，否则底栏那个"会话级"数字
 * 与气泡里的极值会是两套口径：
 *   · `step/start` 记下 startTime；
 *   · 首个 token 时间来自 `assistant/attempt` / `assistant/message` 的 stream（工具调用分片也算）；
 *   · `ttft = 首个 token 时间 − startTime`，每个组装出 message 的 step 记一次；
 *   · `decode = message 时间 − 首个 token 时间`，`output` 取 `data.usage.outputTokens`；
 *     只把「非纯工具调用、decode > 0、有 output」的 step 计入速度分子分母（纯工具调用的分片
 *     时间戳挤在同一刻，算出来是假值 —— 首字照旧统计）。
 * 与投影一样只在有对应 `step/start` 的前提下计数，重试的第二条 message 不会重复计入。
 * 返回 `{ ttftMs, ttftSteps, decodeMs, decodeTokens }`；坏行/坏 JSON 一律跳过。
 */
function foldSessionTiming(text) {
  const out = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  if (typeof text !== 'string' || text.length === 0) return out
  const lines = text.split('\n')
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* 先按类型子串筛一道：整份日志里绝大多数行既不是 step/start 也不是 assistant/*，
       逐行 JSON.parse 太贵 */
    if (line.indexOf('"step/start"') < 0 && line.indexOf('"assistant/') < 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data : null
    if (event.type === 'step/start') {
      open = data === null || typeof event.time !== 'number'
        ? null
        : { turn: data.turn, step: data.step, startTime: event.time, firstTokenTime: null, firstTokenTool: false }
      continue
    }
    if (open === null || data === null) continue
    /* 与投影一样：只认当前这个 step 的事件（跨轮/跨步的事件不参与） */
    if (data.turn !== open.turn || data.step !== open.step) continue
    if (event.type === 'assistant/attempt') {
      if (open.firstTokenTime !== null) continue
      const first = firstStreamToken(data.stream)
      if (first === undefined || typeof first.time !== 'number') continue
      open.firstTokenTime = first.time
      open.firstTokenTool = first.tool === true
      continue
    }
    if (event.type !== 'assistant/message') continue
    const started = open.startTime
    const first = open.firstTokenTime !== null
      ? { time: open.firstTokenTime, tool: open.firstTokenTool === true }
      : firstStreamToken(data.stream)
    open = null
    if (first === undefined || typeof first.time !== 'number' || typeof event.time !== 'number') continue
    out.ttftMs += Math.max(0, first.time - started)
    out.ttftSteps += 1
    const output = stepOutputTokens(data.usage)
    const decode = Math.max(0, event.time - first.time)
    if (output !== null && decode > 0 && first.tool !== true) {
      out.decodeMs += decode
      out.decodeTokens += output
    }
  }
  return out
}

/* 单个后代文件在"某个 mtime/size + 某个窗口起点 + 某个价格指纹"下的汇总。
   队友一边写、底栏一边每秒一问：一次变化只该重解压**变了的那一份**，
   其余文件直接复用上次的结果 —— 否则每问一次就要把所有队友的日志重解一遍。
   键里带 mtime/size（文件一变就换键）与价格指纹（改价后必须按新价重算，
   否则「总计」里本会话用新价、队友用旧价，一个数字混两套价）。
   上限必须 ≥「后代数 × 窗口数」：客户端固定问两个窗口（整会话 + 本轮），
   所以 64 这种小上限在几十个队友时就会互相驱逐，**每次有文件变化都退化成全量解压**
   （实测 120 个队友改 1 个文件：上限 64 时读 121 份 / 75ms）。取 4096 = 后代上限 2000 × 2，
   正常永远不淘汰；每个条目只有几个数字，就算填满也就几十万个数字量级的内存。 */
const SUBAGENT_FILE_CACHE_MAX = 4096
const subagentFileCache = new Map()

/** 一个后代文件的用量汇总（带记忆化，键 = 文件 + mtime + size + 窗口起点 + 价格指纹）。
    返回里带 `stats`（首字/解码累计，与窗口和价格都无关，只是搭同一次读一起折出来）。 */
function subagentFileUsage(one, fromMs, fingerprint) {
  const aggKey = one.file + '|' + String(one.mtimeMs) + '|' + String(one.size) + '|' + String(fromMs)
    + '|' + fingerprint
  const hit = subagentFileCache.get(aggKey)
  if (hit !== undefined) return hit
  const agg = { cost: 0, byCurrency: {}, tokens: zeroTokens(), calls: 0, stats: { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 } }
  let text = null
  try {
    text = zstdText(readFileSync(one.file))
  } catch (error) {
    /* 解不动 / 文件没了：这一份当 0，其余后代照算 */
    text = null
  }
  if (text !== null) {
    /* fromMs = 客户端要的窗口起点（本轮起点）；pickUsageEvents 就按 event.time 过滤 */
    const picked = pickUsageEvents(text, fromMs)
    picked.forEach((event) => {
      const parts = event.parts
      agg.tokens.input += parts.input
      agg.tokens.cacheRead += parts.cacheRead
      agg.tokens.cacheWrite += parts.cacheWrite
      agg.tokens.output += parts.output
      /* 一次 usage 事件 = 一次调用（pickUsageEvents 已按 turn/step 去过重、全 0 的不算） */
      agg.calls += 1
      const amount = tokenCost(event.model, event.time, parts)
      agg.cost += amount
      /* 同一笔同时按"模型条目的币种"分桶：客户端混币时要折成一个数字（见 tokenCostCurrency） */
      const code = tokenCostCurrency(event.model)
      agg.byCurrency[code] = (agg.byCurrency[code] ?? 0) + amount
    })
    agg.stats = foldSessionTiming(text)
  }
  subagentFileCache.set(aggKey, agg)
  while (subagentFileCache.size > SUBAGENT_FILE_CACHE_MAX) {
    const oldest = subagentFileCache.keys().next()
    if (oldest.done === true) break
    subagentFileCache.delete(oldest.value)
  }
  return agg
}

/**
 * 从 `sessionId` 出发，把它**全部后代**（多层：队友再开队友）的用量汇总起来。
 *
 * 只统计后代，不统计父会话自己 —— 本会话的费用客户端已经算在「总计」里了。
 * 计价走当前价格库（`tokenCost` → `priceEntryFor`），与底栏、台账同一套单价。
 *
 * 窗口起点（`sinceMs`，毫秒）的三种来源，见 `sinceSource`：
 *   · `client`：客户端传了（它精确知道自己那一轮）→ 只看 `event.time >= sinceMs`；
 *     **但客户端的起点可能过期**（新一轮已写 `turn/start`、客户端节点还没跟上，
 *     它会把上一轮的起点送上来），所以再用父会话日志推的起点**按 max 收敛一道**
 *     （只收紧、不放大；`since=0` 是显式整会话，不收敛）；真收敛了会带
 *     `sinceClamped: true`（`sinceSource` 仍是 `client`）；
 *   · `host`：没传 → host 读**父会话自己**的日志推一个起点（最后一条 `turn/start`，
 *     但和最后一条 `user/message` 取较新的那个 —— 后者更新说明新一轮已开始、其
 *     `turn/start` 还没落盘，沿用旧起点会把上一轮算进来）；而且**推出来的起点之后
 *     必须真的有用量事件**，否则说明起点无从验证，同样当 `none`（宁少不多）；
 *   · `none`：父会话日志缺失/读不出，或推出来的起点事后没有事件 → 本轮**什么都不并**
 *     （整条返回零值），绝不退回整会话 —— 用户规则：本轮只能小不能大；
 *     要整会话（「总计」那一项）就显式传 `since=0`。
 * 全程只读会话日志，不碰台账、不写任何文件。
 *
 * **排进台账队列**（不是怕写冲突，是怕混价）：价格库的换入换出发生在 `queueLedgerJob` 里，
 * 排在同一条队列上就不会"扫到一半换了价"（否则同一个数字里前几笔按旧价、后几笔按新价）。
 * 顺带还解决了并发去重：客户端一次到期会并发问两个窗口，串行执行时后一个必然命中
 * 前一个刚写好的缓存，同一批日志不会被重复冷解压。
 */
function collectSubagentUsage(sessionId, sinceMs) {
  return queueLedgerJob(() => collectSubagentUsageNow(sessionId, sinceMs))
}

async function collectSubagentUsageNow(sessionId, sinceMs) {
  /* 价格指纹：并进两个缓存键。改价后必须按新价重算 —— 否则队友那段会一直挂着旧价，
     同一个「总计」里本会话用新价、队友用旧价（实测缺陷）。 */
  const fingerprint = priceFingerprint()
  const clientSince = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : null
  const files = collectSessionFiles(sessionsRoot(), [])
  const index = await subagentIndexSnapshot(files)
  /* BFS 收全部后代：环形日志（A→B→A）靠 visited 兜住，不会转不出来 */
  const found = []
  const visited = new Set([sessionId])
  const queue = [sessionId]
  let truncated = false
  while (queue.length > 0) {
    const parent = queue.shift()
    const kids = index.children.get(parent)
    if (kids === undefined) continue
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i]
      if (visited.has(child.id) === true) continue
      visited.add(child.id)
      if (found.length >= SUBAGENT_MAX_DESCENDANTS) {
        truncated = true
        break
      }
      found.push(child)
      queue.push(child.id)
    }
    if (truncated === true) break
  }

  /* 窗口起点从哪来：① 客户端给了（它精确知道自己那一轮）→ `client`；
     ② 没给就问 host 自己 —— 读**父会话自己**的日志取最后一条 turn/start（或更新的
     user/message，见 lastTurnStartOfText）→ `host`；③ 两者都没有（父会话文件缺失/读不出）
     → `none`：**本轮什么都不并**（用户规则：本轮只能小不能大，绝不能拿整会话的量顶上）。
     另外 host 推的起点还要过一道"事后有事件"的验证（见下面聚合之后的那段）。 */
  const parentEntry = index.byId.get(sessionId)
  let sinceSource = 'none'
  let fromMs = null
  let clamped = false
  if (clientSince !== null) {
    sinceSource = 'client'
    fromMs = clientSince
    /* 客户端给的起点**可能已经过期**：它折叠的是对话节点，而新一轮从父会话写
       `turn/start` 到"本轮第一个 assistant 节点出现"之间有延迟（首字延迟量级，
       长思考/失败时更久），这期间客户端还会把**上一轮的起点**当 since 送上来，
       于是上一轮的队友用量被算进"本轮"（偏大）。这里用父会话日志推出来的起点
       兜一道：**只在收紧方向**生效（取较新的那个），绝不把窗口放大。
       `since=0` 是客户端显式要的整会话（「总计」那一问），不参与收敛。 */
    if (clientSince > 0 && parentEntry !== undefined) {
      const hostSince = parentTurnStartOf(parentEntry)
      if (hostSince !== null && hostSince > fromMs) {
        fromMs = hostSince
        clamped = true
      }
    }
  } else if (parentEntry !== undefined) {
    const hostSince = parentTurnStartOf(parentEntry)
    if (hostSince !== null) {
      sinceSource = 'host'
      fromMs = hostSince
    }
  }
  let hasWindow = fromMs !== null

  /* 每个后代文件的 mtime+size 直接用索引里刚 stat 到的那一份：它既是"要不要重算"的缓存键，
     也顺手滤掉了已经消失的文件（索引阶段已经 stat 过一遍，这里不再重复 statSync ——
     队友上百个时那一遍是实打实的开销）。索引与这里只差几微秒，真在这中间被写入的话，
     下一次请求（每秒一回）就会重新 stat 到。 */
  const parts = []
  const reading = []
  for (let i = 0; i < found.length; i += 1) {
    reading.push({ id: found[i].id, file: found[i].file, mtimeMs: found[i].mtimeMs, size: found[i].size })
    parts.push(found[i].id + ':' + String(found[i].mtimeMs) + ':' + String(found[i].size))
  }
  /* 新出现的子会话会改变文件集合（索引重建后出现在 found 里），键自然就变了；
     价格指纹也在键里：改价后这一段必须按新价重算，否则队友那段会一直挂着旧价。
     例外：窗口是 **host 推的**（含推不出来）时，父会话日志也必须进键 ——
     否则"新一轮开始了"改变不了键，缓存会一直沿用旧窗口（或一直沿用推不出来的空结果）。 */
  const parentTag = parentEntry === undefined
    ? 'parent:none'
    : 'parent:' + String(parentEntry.mtimeMs) + ':' + String(parentEntry.size)
  const cacheKey = sessionId + '@' + (hasWindow ? String(fromMs) : 'none') + '#' + fingerprint
  const keyParts = sinceSource === 'client' ? parts : parts.concat([parentTag])
  const key = cacheKey + '|' + keyParts.join('|')
  const cached = subagentUsageCache.get(cacheKey)
  if (cached !== undefined && cached.key === key) return withClampFlag(cached.value, clamped)

  const total = { cost: 0, byCurrency: {}, tokens: zeroTokens(), calls: 0, stats: { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 } }
  const children = []
  for (let i = 0; i < reading.length; i += 1) {
    if (hasWindow !== true) {
      /* 没有窗口（sinceSource='none'）：一个字节都不读 —— 本轮为空，但队友仍然列出来（都是 0），
         与"窗口里没有事件"保持同一种形状。total.stats 也随之为 0（它只服务于会话级那三项，
         客户端只从**整会话**那一份里读它）。 */
      children.push({ id: reading[i].id, cost: 0, tokens: zeroTokens(), calls: 0 })
      continue
    }
    const agg = subagentFileUsage(reading[i], fromMs, fingerprint)
    children.push({ id: reading[i].id, cost: roundCost(agg.cost), tokens: agg.tokens, calls: agg.calls })
    total.cost += agg.cost
    /* 分币种累计：客户端按参考价比例折成底栏显示币种后再相加（混币时一个数字） */
    for (const code of Object.keys(agg.byCurrency)) {
      total.byCurrency[code] = (total.byCurrency[code] ?? 0) + agg.byCurrency[code]
    }
    total.tokens.input += agg.tokens.input
    total.tokens.cacheRead += agg.tokens.cacheRead
    total.tokens.cacheWrite += agg.tokens.cacheWrite
    total.tokens.output += agg.tokens.output
    total.calls += agg.calls
    /* 首字 / 解码的累计：这三项客户端只用在"会话级"那三个数上，
       所以它是**整会话**口径、与 since 窗口无关（窗口那边客户端不看它）。 */
    total.stats.ttftMs += agg.stats.ttftMs
    total.stats.ttftSteps += agg.stats.ttftSteps
    total.stats.decodeMs += agg.stats.decodeMs
    total.stats.decodeTokens += agg.stats.decodeTokens
    if (i % 4 === 3) await new Promise((resolve) => setImmediate(resolve))
  }
  /* host 推出来的起点必须有"事后证据"才算有效。**证据有两条，任一条成立即可**：
     ① 父会话**自己**在窗口内有用量事件（fromMs 之后有 assistant/message 或
        compaction/summary 且带非空 usage）；
     ② 队友在窗口内有用量事件（`total.calls`，就是上面聚合出来的事件数）。
     为什么必须补上 ①：`total` 只累加**队友**，不含父会话自己。于是"新一轮已起、
     父会话主模型已产出、队友还没产出"这几秒里 `total.calls === 0`，旧实现把起点
     判成无效（sinceSource 从 host 掉成 none）—— 实测复现的缺陷。父会话自己那条
     assistant/message 就是"这个 turn/start 是活的"的直接证据。
     为什么保留 ②：**不许因此丢掉真实存在的队友用量**。队友在窗口内已经花了钱，
     说明这个起点确实是本轮起点（否则那笔钱会被静默抹掉，方向正是"少算"）。
     实测约束（2026-10-08，本机 41 份会话日志）：父会话最后一条 turn/start 之后
     "队友有、父会话自己没有用量事件"的窗口 0 个，但用例夹具 p-1 就是这一形态，
     且它钉住的契约是"host 代推 = 客户端传同一起点"—— 保留 ② 才能两边都不破。
     两条都不成立时才按用户的"宁少不多"当没有窗口 —— 本轮不含队友。
     判断只用已经折好的标量（父会话日志的最大用量时间、同一个窗口的聚合结果），
     没有再解压一遍。 */
  const parentFacts = sinceSource === 'host' && parentEntry !== undefined ? parentLogFactsOf(parentEntry) : null
  const parentProduced = parentFacts !== null && parentFacts.lastUsageAt !== null
    && fromMs !== null && parentFacts.lastUsageAt >= fromMs
  if (sinceSource === 'host' && parentProduced !== true && total.calls === 0) {
    sinceSource = 'none'
    hasWindow = false
    fromMs = null
    children.length = 0
    for (let i = 0; i < reading.length; i += 1) {
      children.push({ id: reading[i].id, cost: 0, tokens: zeroTokens(), calls: 0 })
    }
    total.cost = 0
    total.byCurrency = {}
    total.tokens = zeroTokens()
    total.calls = 0
    total.stats = { ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  }
  /* 分币种那几笔一起舍入（与 total.cost 同一口径）：客户端据此折算 */
  const costByCurrency = {}
  for (const code of Object.keys(total.byCurrency)) costByCurrency[code] = roundCost(total.byCurrency[code])
  const value = {
    ok: true,
    sessionId,
    /* 窗口起点来自哪里：client（客户端传的）/ host（host 按父会话日志推的）/
       none（都没有，或 host 推出来的起点事后没有任何用量事件 → 本轮不并队友）。
       `sinceSource` 说不出"客户端给的起点被 host 收紧了"，那个事实用 `sinceClamped` 表达
       （只在真收敛时才出现，风格与 truncated 一致）。既有字段形状不变。 */
    sinceSource,
    children,
    /* `costByCurrency` 是这次新增的可选字段：按每个队友模型**自己条目的币种**分桶。
       客户端混币时用它折成底栏显示币种；老客户端不看它，`total.cost` 语义不变。 */
    total: {
      cost: roundCost(total.cost),
      tokens: total.tokens,
      calls: total.calls,
      stats: total.stats,
      costByCurrency: costByCurrency,
    },
  }
  if (truncated === true) value.truncated = true
  /* 只在这条路径上打一行：命中缓存时不说话。队友在干活时它出现的频率就是"重算"的频率，
     排查"总计怎么没变"时看这一行就知道 host 是算了还是直接用缓存给了旧结果。
     只写会话 id 与数字，不碰日志正文。 */
  logHost(ctxRef, 'subagent-usage: 会话 ' + sessionId + ' 的队友 ' + String(children.length)
    + ' 个，重算 ¥' + String(value.total.cost)
    + '（窗口来源 ' + sinceSource + (hasWindow ? ' @' + String(fromMs) : '')
    + (clamped === true ? '，sinceClamped（客户端起点被 host 收紧到父会话日志推的起点）' : '') + '）'
    + (index.duplicates > 0 ? '（同 id 重复文件 ' + String(index.duplicates) + ' 份，已取最新）' : '')
    + (truncated === true ? '（超过上限已截断）' : ''))
  /* delete + set：让这条键变成 Map 里最新的一个（Map 按插入顺序淘汰）。
     键含窗口起点：同一个会话的"整会话"与"本轮"各占一条，互不挤掉。 */
  subagentUsageCache.delete(cacheKey)
  subagentUsageCache.set(cacheKey, { key, value })
  if (subagentUsageCache.size > SUBAGENT_CACHE_MAX) {
    const oldest = subagentUsageCache.keys().next()
    if (oldest.done !== true) subagentUsageCache.delete(oldest.value)
  }
  return withClampFlag(value, clamped)
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
 *            days[日期].cost     已结算的费用（人民币）；一旦记下就不再改动，
 *                                改价也不重算（重算历史曾经把用户的数据弄丢过）
 *            days[日期].unpriced 当时没有单价、还没算钱的用量，按模型名与峰谷分档攒着；
 *                                用户补上价后结算成 cost，条目随即移除
 *   seen     每个会话已计入的 seq，用来防重复
 *   sessions 每个会话最后一条用量事件的时间，用来淘汰老会话的去重记录
 *   files    每个日志文件上次处理时的 mtime+size，没变就跳过解压
 *   priceFingerprint  上一次结算用的价格库指纹：判断价格有没有变，也给回扫还原旧价目表
 *   unpricedBackfill  'pending' = 还需要一次性回扫，把历史缺价明细补全；'done' = 已补完
 */
const LEDGER_VERSION = 3

function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    updatedAt: 0,
    priceFingerprint: '',
    unpricedBackfill: '',
    days: {},
    seen: {},
    sessions: {},
    files: {},
  }
}

/**
 * 读一个 JSON 对象文件；不存在、读不出或不是合法 JSON 对象时返回 null。
 *
 * 名字**刻意不叫** readLedgerFile：它不只读台账，`holidays.json` 也走这里
 * （两者都是「一个 JSON 对象，坏了就当没有」的语义）。用台账专属的名字会让人
 * 以为改动只该影响台账。
 */
function readJsonObjectFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

/**
 * 老版本台账 → 当前版本：**只补字段、不动 days 里的任何数字**。
 * 版本比当前新（用户装过更新的版本又回退）时也照样收下能用的部分，宁可少字段也不丢数据。
 */
function migrateLedger(parsed) {
  const pick = (value) => (value !== null && value !== undefined && typeof value === 'object' ? value : {})
  const ledger = {
    version: LEDGER_VERSION,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    priceFingerprint: typeof parsed.priceFingerprint === 'string' ? parsed.priceFingerprint : '',
    unpricedBackfill: typeof parsed.unpricedBackfill === 'string' ? parsed.unpricedBackfill : '',
    days: pick(parsed.days),
    seen: pick(parsed.seen),
    sessions: pick(parsed.sessions),
    files: pick(parsed.files),
  }
  /* v1/v2 台账没记过"哪些 token 当时没有单价"，那部分钱因此永远补不上。
     标记待办，下次扫描时回扫一遍会话日志把欠账明细补出来 —— 回扫只写 unpriced，
     不改历史 token 与 cost（见 backfillUnpriced）。 */
  if (typeof parsed.version !== 'number' || parsed.version < LEDGER_VERSION) {
    if (ledger.unpricedBackfill !== 'done') ledger.unpricedBackfill = 'pending'
  }
  return ledger
}

/**
 * 读台账。**任何情况下都不清空 days** —— 台账一旦记账就是历史，
 * 改价格、删对话、删工作区都不许把它抹掉（重算历史曾经把用户两天的数据弄丢过一次）。
 *   · 主文件读不出来（不存在 / JSON 坏了）→ 退回上一次自动留的 .bak
 *   · 老版本 → migrateLedger 原样收下
 */
/** 读台账时手边没有 ctx，宿主日志函数用不了，就直接写一行 stderr（失败也不影响功能）。 */
function logLedgerNote(message) {
  try {
    if (typeof process !== 'undefined' && process.stderr !== undefined && typeof process.stderr.write === 'function') {
      process.stderr.write('[dsh-desktop-statusbar] ' + message + '\n')
    }
  } catch (error) {
    /* 日志失败不影响记账 */
  }
}

function readLedger() {
  const parsed = readJsonObjectFile(ledgerPath())
  if (parsed !== null) return migrateLedger(parsed)
  const backup = readJsonObjectFile(ledgerPath() + '.bak')
  if (backup !== null) {
    logLedgerNote('usage-ledger: 主文件读不出来，已回退到自动备份')
    const recovered = migrateLedger(backup)
    /* 顺手把好数据写回主文件：否则它会一直保持损坏态，每次读都回退备份并打一行日志。
       writeLedger 只在"上一份能解析"时才覆盖 .bak，所以这份好备份不会被写坏。 */
    writeLedger(recovered)
    return recovered
  }
  return emptyLedger()
}

/**
 * 先写临时文件再改名，避免读到写了一半的 JSON；改名之前把上一份留成 .bak。
 * 台账是会话日志被删之后**唯一**留得住历史的地方，所以这层备份不省。
 */
function writeLedger(ledger) {
  const target = ledgerPath()
  const temp = target + '.tmp'
  try {
    mkdirSync(join(dshHome(), 'dsh-status-bar'), { recursive: true })
    let kept = false
    /* 只有"上一份是能解析的好数据"才留成备份：主文件损坏时我们刚回退过 .bak，
       若这时把损坏内容复制成新 .bak，备份就只能救命一次（实测缺陷）。 */
    if (readJsonObjectFile(target) !== null) {
      try {
        copyFileSync(target, target + '.bak')
        kept = true
      } catch (error) {
        /* 复制失败不影响本次落盘 */
      }
    }
    writeFileSync(temp, JSON.stringify(ledger), 'utf8')
    renameSync(temp, target)
    /* 首次写入没有"上一份"可留，就补一份同内容的备份 —— 保护不该从第二次才开始生效 */
    if (kept !== true) {
      try {
        copyFileSync(target, target + '.bak')
      } catch (error) {
        /* 备份失败不影响本次落盘 */
      }
    }
  } catch (error) {
    /* 落盘失败不影响本次读数 */
  }
}

/* ------------------------------------------------ 缺价用量（欠账）与补算 */

/** 日桶里"欠账"那一格：{ 模型名: { peak: 四项, offPeak: 四项 } }。 */
function addUnpriced(day, model, parts, peakTime) {
  const name = typeof model === 'string' && model.length > 0 ? model : '(未知模型)'
  const bucket = day.unpriced ?? {}
  const one = bucket[name] ?? {
    peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    offPeak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  }
  const tier = peakTime ? one.peak : one.offPeak
  tier.input += parts.input
  tier.cacheRead += parts.cacheRead
  tier.cacheWrite += parts.cacheWrite
  tier.output += parts.output
  bucket[name] = one
  day.unpriced = bucket
}

/** 一档用量按一档单价折成人民币（用量或单价缺失按 0 算）。 */
function costOfTier(parts, price) {
  if (parts === null || parts === undefined) return 0
  if (price === null || price === undefined) return 0
  return (numOrZero(parts.input) * numOrZero(price.input) + numOrZero(parts.cacheRead) * numOrZero(price.cacheRead)
    + numOrZero(parts.cacheWrite) * numOrZero(price.cacheWrite) + numOrZero(parts.output) * numOrZero(price.output)) / 1e6
}

/**
 * 结算欠账：把 days[].unpriced 里**现在能算出价**的用量按当前价格库折成人民币，
 * 加到当天的 cost 上，条目随即从欠账里移除；仍缺价的条目原样留着等下次补价。
 *
 * 只碰欠账，绝不重算已经算过的费用 —— 这是与上一版"整本作废重扫"的关键区别：
 * 用户补一次价，不该把过去按旧价算好的钱全部改写。
 */
function settleUnpriced(ledger) {
  let entries = 0
  let amount = 0
  const dates = Object.keys(ledger.days)
  for (let i = 0; i < dates.length; i += 1) {
    const day = ledger.days[dates[i]]
    if (day === null || day === undefined || typeof day !== 'object') continue
    const bucket = day.unpriced
    if (bucket === null || bucket === undefined || typeof bucket !== 'object') continue
    const names = Object.keys(bucket)
    for (let k = 0; k < names.length; k += 1) {
      const entry = priceEntryFor(names[k])
      if (entry === null) continue
      const one = bucket[names[k]]
      /* 单档条目（没勾「峰谷计价」）：两个桶都按 peak 价结算，否则空闲桶会被算成 0 */
      const peakPrice = entry.peak !== null && entry.peak !== undefined ? entry.peak : entry.offPeak
      const offPeakPrice = entry.tiered === false
        ? peakPrice
        : (entry.offPeak !== null && entry.offPeak !== undefined ? entry.offPeak : entry.peak)
      const cost = costOfTier(one.peak, peakPrice) + costOfTier(one.offPeak, offPeakPrice)
      day.cost = (typeof day.cost === 'number' && Number.isFinite(day.cost) ? day.cost : 0) + cost
      amount += cost
      entries += 1
      delete bucket[names[k]]
    }
    if (Object.keys(bucket).length === 0) delete day.unpriced
    else day.unpriced = bucket
  }
  return { entries, amount: Math.round(amount * 1e6) / 1e6 }
}

/**
 * 一次性回扫（升级后只做一次）：v1/v2 台账没记过"哪些 token 当时没有单价"，
 * 只有会话日志里找得到。回扫只补这一件事：
 *   ① 用**台账指纹还原出来的旧价目表**判断每个事件当时有没有价；
 *   ② 当时没价的，交给 settleUnpriced 用**现在的价格库**结算 —— 能算就把钱补进当天 cost，
 *      仍缺价的进 unpriced 等以后再补。
 *
 * 两条安全线：
 *   · 只处理 `seen` 里记过账的事件（没入过账的归正常扫描路径），避免重复计价；
 *   · 当时就有价的一律跳过，历史 cost 一分不动。
 * 每个文件补完打 unpricedAt 标记，中断了下次接着做，不会重复补算。
 */
async function backfillUnpriced(ledger) {
  const parsedBook = parseFingerprint(ledger.priceFingerprint)
  /* 老台账没有指纹字段（更早的版本用的就是那张内置参考价）→ 按内置表还原"当时的价格库" */
  const historyBook = parsedBook !== null ? parsedBook : builtinPriceBook()
  const files = collectSessionFiles(sessionsRoot(), [])
  const keepFrom = Date.now() - 400 * 24 * 3600 * 1000
  let scanned = 0
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    const mark = ledger.files[file]
    let stat = null
    try {
      stat = statSync(file)
    } catch (error) {
      continue
    }
    /* 很久没动过、也从没扫过：它的内容在保留期之外，正常扫描也不看它 */
    if (mark === undefined && stat.mtimeMs < keepFrom) continue
    if (mark !== undefined && mark.unpricedAt === LEDGER_VERSION) continue
    let text = null
    try {
      text = zstdText(readFileSync(file))
    } catch (error) {
      text = null
    }
    if (text === null) continue
    scanned += 1
    const sessionId = basename(dirname(file))
    const seen = new Set(Array.isArray(ledger.seen[sessionId]) ? ledger.seen[sessionId] : [])
    const picked = pickUsageEvents(text, keepFrom)
    const keys = []
    picked.forEach((one, key) => keys.push(key))
    for (let k = 0; k < keys.length; k += 1) {
      const one = picked.get(keys[k])
      if (seen.has(one.seq) !== true) continue
      /* 必须用**当年那套规则**判"当时有没有价"：新规则（词元匹配）会把这些事件
         误判成"当时有价"直接跳过，历史欠账就永远补不出来了（实测缺陷） */
      if (legacyPriceEntryIn(historyBook, one.model) !== null) continue
      const day = ledger.days[localDateKey(one.time)]
      if (day === null || day === undefined || typeof day !== 'object') continue
      addUnpriced(day, one.model, one.parts, isPeakTime(one.time))
    }
    const next = mark !== undefined && mark !== null && typeof mark === 'object'
      ? mark
      : { mtimeMs: 0, size: 0, fromMs: 0 }
    next.unpricedAt = LEDGER_VERSION
    ledger.files[file] = next
    if (i % 4 === 3) await new Promise((resolve) => setImmediate(resolve))
  }
  return { files: files.length, scanned }
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
    /* 连同这次的窗口起点一起记：下次只有当窗口不晚于它时才允许整文件跳过。
       顺手保住 unpricedAt —— 那是"这个文件的欠账明细已经回扫过"的标记，
       丢了会让下次启动再回扫一遍，同一批用量被记两次欠账。 */
    const nextMark = { mtimeMs: stat.mtimeMs, size: stat.size, fromMs }
    if (mark !== undefined && mark !== null && typeof mark.unpricedAt === 'number') nextMark.unpricedAt = mark.unpricedAt
    ledger.files[file] = nextMark
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
      const peakTime = isPeakTime(one.time)
      if (peakTime) {
        const peak = day.peak ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        peak.input += one.parts.input
        peak.cacheRead += one.parts.cacheRead
        peak.cacheWrite += one.parts.cacheWrite
        peak.output += one.parts.output
        day.peak = peak
      }
      /* 有单价就当场折成人民币；**还没有单价的用量单独记成"欠账"**，
         等用户在设置页把价补上再结算（补价只结算欠账，不动已经算好的费用）。 */
      if (priceEntryFor(one.model) === null) addUnpriced(day, one.model, one.parts, peakTime)
      else day.cost = (day.cost || 0) + tokenCost(one.model, one.time, one.parts)
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
  const days = []
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0, cost: 0 }
  /* 逐日按**日历**推进，不用 rangeStart + i*24h：后者在夏令时切换日会重复/跳天
     （同 monthUsagePayload 的说明）。rangeStart 本身已是本地 00:00。 */
  const startDate = new Date(rangeStart)
  for (let i = 0; i < 7; i += 1) {
    const at = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i).getTime()
    const key = localDateKey(at)
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
  /* 一律按本机时区读年月日，与 localDateKey 同口径（别在这里加 8 小时偏移） */
  const first = new Date(monthStart)
  const year = first.getFullYear()
  const month = first.getMonth() + 1
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstWeekday = (first.getDay() + 6) % 7 /* 周一=0 */
  const monthEnd = new Date(year, month - 1, daysInMonth).getTime()
  const lastWeekday = (new Date(year, month - 1, daysInMonth).getDay() + 6) % 7
  const gridDays = daysInMonth + firstWeekday + (6 - lastWeekday)
  /* 网格起点：当月 1 号往前退 firstWeekday 天。
     用**日历逐日构造**而不是 `起点 + i * 24h` —— 后者在有夏令时的时区会错：
     切换日本地时间整体挪 1 小时，+24h 可能落回同一天（出现两格同一天、另一天缺失），
     实测纽约 / 伦敦 / 悉尼 / 圣地亚哥都会中（UTC+8 的机器上永远看不到）。
     逐日构造让每格都稳稳落在本地 00:00。 */
  const gridStartDate = new Date(year, month - 1, 1 - firstWeekday)
  const dayAt = (i) => new Date(
    gridStartDate.getFullYear(),
    gridStartDate.getMonth(),
    gridStartDate.getDate() + i
  ).getTime()
  const days = []
  let max = 0
  let maxDate = null
  for (let i = 0; i < gridDays; i += 1) {
    const at = dayAt(i)
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
  return { year, month, max, maxDate, days }
}

/**
 * 当年的 12 个月聚合：每月的三段 token、调用次数与花费。
 * 客户端拿它画「活跃总览」标题下面那 12 个方块（配色规则与右侧月历一致）。
 */
function yearUsagePayload(ledger, now) {
  /* 一律按本机时区读年月日，与 localDateKey 同口径 */
  const year = new Date(now).getFullYear()
  const months = []
  let max = 0
  let maxMonth = null
  for (let m = 1; m <= 12; m += 1) {
    const daysInMonth = new Date(year, m, 0).getDate()
    let input = 0
    let cacheRead = 0
    let cacheWrite = 0
    let output = 0
    let calls = 0
    let cost = 0
    for (let d = 1; d <= daysInMonth; d += 1) {
      const bucket = ledger.days[localDateKey(new Date(year, m - 1, d).getTime())]
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

/* 台账是"读进来 → 改 → 写回去"。扫描与补算（价格上报）可能同时发生，
   串成一条队列逐个跑，免得两边各读到同一份旧内容、后写的把先写的盖掉。 */
let ledgerQueue = Promise.resolve()

function queueLedgerJob(job) {
  const run = ledgerQueue.then(job, job)
  ledgerQueue = run.then(() => undefined, () => undefined)
  return run
}

async function refreshWeekUsage(force, ctx) {
  const now = Date.now()
  const rangeStart = recentStartMs(now)
  const monthStart = monthStartMs(now)
  const yearStart = yearStartMs(now)
  /* 扫描与保留窗口取「近 7 天起点」「本月 1 号」「当年 1 月 1 日」里最早的那个：
     柱要看近 7 天、活跃度要整月、12 个月统计要整年。
     台账一旦记过就留着（保留期已放宽），所以全量解压只在首次或很久没开时发生。 */
  const windowStart = Math.min(rangeStart, monthStart, yearStart)
  const note = (message) => { if (ctx !== undefined && ctx !== null) logHost(ctx, message) }
  if (force !== true && weekUsageCache.value !== null && now - weekUsageCache.at < WEEK_USAGE_CACHE_MS) {
    return weekUsageCache.value
  }
  if (weekUsageScan === null) {
    const run = queueLedgerJob(async () => {
      const ledger = readLedger()
      /* 升级后第一次扫描：回扫一遍日志，把"当时缺价、没算钱"的用量找出来。
         只补欠账清单，历史 token 与 cost 一个都不动。 */
      let backfilled = null
      if (ledger.unpricedBackfill === 'pending') {
        backfilled = await backfillUnpriced(ledger)
        ledger.unpricedBackfill = 'done'
        note('usage-ledger: 回扫补全缺价明细，处理了 ' + String(backfilled.scanned) + ' 个日志文件')
      }
      /* 价格补上来了就把欠账结算掉（只碰欠账，不重算已经算好的费用） */
      const settled = settleUnpriced(ledger)
      if (settled.entries > 0) {
        note('usage-ledger: 结算欠账 ' + String(settled.entries) + ' 项，补记 ¥' + String(settled.amount))
      }
      ledger.priceFingerprint = priceFingerprint()
      const stats = await collectIntoLedger(ledger, windowStart)
      pruneLedger(ledger)
      if (stats.added > 0 || stats.scannedFiles > 0 || ledger.updatedAt === 0
        || settled.entries > 0 || backfilled !== null) {
        ledger.updatedAt = Date.now()
        writeLedger(ledger)
      }
      return { ledger, stats }
    })
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
    void refreshWeekUsage(false, ctx).catch(() => {})
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
        /* POST = 客户端把它的价格库（localStorage 那份，用户可增删改）报上来。
           活跃总览的 cost 由 host 记账时算出，必须用同一份价格，否则用户在设置页
           加/改的单价只对底栏生效、活跃总览恒为旧值（实测 2026-10-07）。 */
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const book = body === null ? null : sanitizePriceBook(body.models)
          if (book === null) {
            sendJson(res, 400, { ok: false, reason: 'bad-models' })
            return
          }
          /* 判断"价格是否变了"用的快照在队列里取（见下）：并排上报不会双双报"已变更" */
          /* **在队列里换价格库**：换库必须与"读台账→结算→写盘"是同一段原子操作，
             否则在途扫描会一半用旧价、一半用新价，同一天的数字混两套价（实测缺陷）。 */
          let settled = { entries: 0, amount: 0 }
          let changed = false
          const swapped = await queueLedgerJob(async () => {
            const before = activePriceFingerprint
            clientPrices = book
            const nowFingerprint = priceFingerprint()
            activePriceFingerprint = nowFingerprint
            const nowChanged = before !== nowFingerprint
            /* 价格变了只做一件事：把"当时没有单价、还没算钱"的欠账按新价结算掉。
               已经算好的费用一律不动，台账也不重建 —— 所以会话日志被删也不影响已有数字。 */
            if (nowChanged !== true) return { changed: false, settled: { entries: 0, amount: 0 } }
            const ledger = readLedger()
            const done = settleUnpriced(ledger)
            /* 两种情况才落盘：真结算了欠账；或者盘上还是老版本，顺手把迁移结果固化一次
               （免得每次都重迁一遍）。没有台账时不在这里创建。
               **绝不改写 priceFingerprint** —— 那个字段记的是"上次记账用的那份价目表"，
               是回扫判断"当时有没有价"的唯一依据；价格上报抢先改写它，历史缺价明细就永远补不出来。 */
            const onDisk = readJsonObjectFile(ledgerPath())
            const stale = onDisk !== null && onDisk.version !== LEDGER_VERSION
            if (done.entries > 0 || stale) {
              ledger.updatedAt = Date.now()
              writeLedger(ledger)
            }
            return { changed: true, settled: done }
          })
          changed = swapped.changed
          settled = swapped.settled
          if (changed) {
            /* 面板的数字要重新取一次（payload 缓存在上面） */
            weekUsageCache = { at: 0, value: null }
            weekUsageScan = null
          }
          logHost(ctx, 'prices: 收到客户端价格库 ' + String(Object.keys(book).length) + ' 条'
            + (changed
              ? '（已变更，结算欠账 ' + String(settled.entries) + ' 项 ¥' + String(settled.amount) + '）'
              : '（与当前一致）'))
          sendJson(res, 200, { ok: true, changed: changed, count: Object.keys(book).length, settled: settled })
          return
        }
        /* GET = 官方参考价（价格库为空时客户端拿它自愈），与用户价格库无关 */
        sendJson(res, 200, {
          models: {
            'deepseek-flash': TOKEN_PRICES.peak['deepseek-flash'] === undefined ? null : {
              peak: TOKEN_PRICES.peak['deepseek-flash'],
              offPeak: TOKEN_PRICES.offPeak['deepseek-flash'],
            },
            'deepseek-v4-pro': {
              peak: TOKEN_PRICES.peak['deepseek-v4-pro'],
              offPeak: TOKEN_PRICES.offPeak['deepseek-v4-pro'],
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
          if (result.ok === true) {
            /* 落盘：host 自己也要用这份假期表判峰谷，否则 2027 年起底栏与活跃总览口径不一致 */
            const merged = saveHolidayDays(result.days)
            logHost(ctxRef, 'holidays: ' + String(year) + ' 年 ' + String(result.days.length)
              + ' 天（累计 ' + String(merged.length) + ' 天，已落盘）')
          }
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
      if (url.pathname === '/dsh-desktop-statusbar/api/self-update') {
        /* 一键更新：由本插件自己完成，不依赖「插件管理器」这个别的插件，也不走
           pnpm 的 24 小时发布年龄策略（做法见 self-update.js 顶部说明）。
           GET = 问当前状态（界面挂在更新中途刷新时能接上）；POST = 发起一次更新。 */
        if (req.method !== 'POST') {
          const last = lastUpdateResult()
          sendJson(res, 200, {
            ok: true,
            busy: isUpdating(),
            last: last === null ? null : {
              ok: last.ok === true,
              reason: last.reason === undefined ? null : last.reason,
              from: last.from === undefined ? null : last.from,
              to: last.to === undefined ? null : last.to,
            },
          })
          return
        }
        const body = await readJsonBody(req)
        const raw = body === null || typeof body.version !== 'string' ? '' : body.version.trim()
        /* 目标版本必须是明确的三段式版本号：不接受 latest/tag/范围，避免装到别的东西。
           空则不传 —— host 会自己问 registry 的最新版。 */
        if (raw.length > 0 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw) !== true) {
          sendJson(res, 400, { ok: false, reason: 'bad-version' })
          return
        }
        if (isUpdating() === true) {
          sendJson(res, 409, { ok: false, reason: 'busy' })
          return
        }
        let target = raw
        if (target.length === 0) {
          /* 客户端没带版本就自己查一次最新的 */
          const checked = await checkLatestVersion()
          latestVersion = checked
          if (checked.latest === null) {
            sendJson(res, 200, { ok: false, reason: checked.error === null ? 'no-version' : checked.error })
            return
          }
          target = checked.latest
        }
        const selfDir = resolveSelfDir()
        logHost(ctxRef, 'update: 收到更新请求 → ' + target + '（当前目录 ' + selfDir + '）')
        const value = await selfUpdateOnce({
          selfDir,
          version: target,
          logger: (message) => logHost(ctxRef, message),
        })
        logHost(ctxRef, 'update: 结果 ' + JSON.stringify(value))
        sendJson(res, 200, value)
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
      if (url.pathname === '/dsh-desktop-statusbar/api/subagent-usage') {
        /* 底栏「总计」和「本轮」的队友部分：子智能体是独立会话，它的用量只能这样按 parentSession
           找回来。`since` 是可选的窗口起点（毫秒）：客户端拿"本轮起点"传进来，「本轮」就只算
           本轮里队友花了多少；不传就是整会话（「总计」用）。
           参数不对（客户端拿不到会话 id / 传了别的东西）给 400；会话没有队友、或队友日志
           全都解不出来时给零值而不是 404 —— 客户端按"加上 0"处理，界面不该因此报错。 */
        const raw = url.searchParams.get('sessionId')
        const sessionId = raw === null ? '' : raw.trim()
        if (sessionId.length === 0 || sessionId.length > 200) {
          sendJson(res, 400, { ok: false, reason: 'bad-session' })
          return
        }
        /* 非法/缺失的 since 一律当"没传"：空串、非有限数、负数、以及**未来时刻**。
           本轮起点必然在过去，未来时刻只可能是客户端传了坏值；真按它过滤会把队友的
           数字静默清零（少算钱），所以宁可忽略。留 5 分钟余量容忍时钟抖动。
           "当没传"的新语义（task-18 起）：由 host 读父会话日志代推起点；连父会话都没有
           就本轮为空（`sinceSource='none'`），**不**退回整会话 —— 要整会话就显式传 `since=0`。 */
        const rawSince = url.searchParams.get('since')
        const sinceText = rawSince === null ? '' : rawSince.trim()
        const parsedSince = sinceText.length === 0 ? NaN : Number(sinceText)
        const usableSince = Number.isFinite(parsedSince) === true && parsedSince >= 0
          && parsedSince <= Date.now() + 5 * 60 * 1000
         /* 这个接口会排队（collectSubagentUsage 内部走 queueLedgerJob）——
            别按「只读、不排队」去理解它的时序。此处原先的注释与实现矛盾，已改正。 */
        let value
        try {
          value = await collectSubagentUsage(sessionId, usableSince === true ? parsedSince : undefined)
        } catch (error) {
          logHost(ctx, 'subagent-usage: 汇总失败 ' + probeDetail(error))
          value = { ok: false, reason: 'scan-failed' }
        }
        sendJson(res, 200, value)
        return
      }
      if (url.pathname === '/dsh-desktop-statusbar/api/daily-usage') {
        let value
        try {
          value = await refreshWeekUsage(url.searchParams.get('force') === '1', ctx)
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
