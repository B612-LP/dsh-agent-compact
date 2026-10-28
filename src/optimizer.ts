// 手动检查点只属于一次异步 compactRegion 操作；官方自动压缩不读 ticket。
import { AsyncLocalStorage } from 'node:async_hooks'

export interface SurfaceNode {
  seq: number
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  surface?: { nodes?: readonly number[] }
  events?: readonly unknown[]
  deriveEventMessage?: (event: any) => unknown
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: { provider?: string; model?: string }
  ctx?: unknown
}

type Summarize = (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>
type CompactRegion = (start: number, end: number, agent: unknown, signal?: AbortSignal) => unknown
type Dependencies = { summarize: Summarize; [key: string]: unknown }

export interface OptimizedEngineLike {
  /** @deprecated sid 缓存永不用于注入，旧补丁 fallback 前也会清空。 */
  _externalSummary?: Record<string, string>
  summarize?: Summarize
  compactRegion?: CompactRegion
  regionDependencies?: () => Dependencies
  __ctxcOptimized?: number
}

/** 传入范围可排除 callback 内同 engine/agent 的其他范围；推荐所有调用者提供。 */
export interface ExternalSummarySpan {
  start: number
  end: number
}

export const PATCH_VERSION = 5
const ENGINE_STATE = Symbol.for('@mimichunterz/agent-compact/optimizer/v5')
const LEGACY_STATE = Symbol.for('@mimichunterz/agent-compact/optimizer/v4')
const ORIGINAL = Symbol.for('cordis.original')
const HOOK_ORIGINAL = Symbol.for('@mimichunterz/agent-compact/optimizer/original')

interface SummaryTicket {
  summary: string
  agent: object
  span?: ExternalSummarySpan
  active: boolean
  consumed: boolean
  operation?: object
}
interface OperationContext {
  ticket: SummaryTicket
  operation?: object
  input?: unknown
  inputBound?: boolean
}
interface EngineState {
  engine: OptimizedEngineLike
  tickets: WeakMap<object, SummaryTicket>
  scope: AsyncLocalStorage<OperationContext>
  summarize: Summarize
  compactRegion?: CompactRegion
  regionDependencies?: () => Dependencies
}
type StatefulEngine = OptimizedEngineLike & { [ENGINE_STATE]?: EngineState; [LEGACY_STATE]?: unknown }

function isIdentity(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Cordis 每次读取生成新 proxy；symbol.original 同时穿透 service 与 shadow receiver。 */
function identity<T>(value: T): T {
  const seen = new Set<unknown>()
  while (isIdentity(value)) {
    if (seen.has(value)) throw new TypeError('cyclic Cordis object identity')
    seen.add(value)
    const original = (value as Record<symbol, unknown>)[ORIGINAL]
    if (!isIdentity(original) || original === value) break
    value = original as T
  }
  return value
}

function unwrapHook<T extends Function>(hook: T): T {
  const seen = new Set<Function>()
  while (Object.hasOwn(hook, HOOK_ORIGINAL)) {
    if (seen.has(hook)) throw new TypeError('cyclic optimizer hook')
    seen.add(hook)
    hook = (hook as T & { [HOOK_ORIGINAL]: T })[HOOK_ORIGINAL]
  }
  return hook
}

function markHook<T extends Function>(hook: T, original: T): T {
  Object.defineProperty(hook, HOOK_ORIGINAL, { value: original })
  return hook
}

/** v4 没保存原函数且已可能叠数千层；绝不能再调用这个闭包链。 */
function recoverV4(target: StatefulEngine): Summarize | undefined {
  if (!Object.hasOwn(target, LEGACY_STATE)) return undefined
  let proto = Object.getPrototypeOf(target)
  while (proto) {
    const hook = Object.getOwnPropertyDescriptor(proto, 'summarize')?.value
    if (typeof hook === 'function') return unwrapHook(hook)
    proto = Object.getPrototypeOf(proto)
  }
  throw new Error('cannot safely recover legacy v4 compaction hook without a prototype summarize implementation')
}

export function patchEngine(engine: OptimizedEngineLike): boolean {
  if (!isIdentity(engine)) return false
  const target = identity(engine) as StatefulEngine
  if (typeof target.summarize !== 'function') return false
  target._externalSummary = undefined
  const cached = Object.hasOwn(target, ENGINE_STATE) ? target[ENGINE_STATE] : undefined
  if (cached?.engine === target && target.summarize === cached.summarize
    && target.compactRegion === cached.compactRegion && target.regionDependencies === cached.regionDependencies) {
    target.__ctxcOptimized = PATCH_VERSION
    return true
  }
  const originalSummarize = unwrapHook(cached && target.summarize === cached.summarize
    ? cached.summarize : recoverV4(target) ?? target.summarize)
  const originalCompact = target.compactRegion && unwrapHook(target.compactRegion)
  const originalDependencies = target.regionDependencies && unwrapHook(target.regionDependencies)
  const state: EngineState = {
    engine: target,
    tickets: cached?.tickets ?? new WeakMap(),
    scope: cached?.scope ?? new AsyncLocalStorage(),
    summarize: undefined!,
  }
  const summarize: Summarize = async function (this: OptimizedEngineLike, input, agent, signal) {
    target._externalSummary = undefined
    const context = state.scope.getStore()
    const ticket = context?.ticket
    if (context && identity(this) === target && ticket?.active && !ticket.consumed
      && identity(agent) === ticket.agent && context.operation === ticket.operation
      && context.operation !== undefined
      && (!originalDependencies || (context.inputBound === true && context.input === input))) {
      signal?.throwIfAborted()
      ticket.consumed = true
      return {
        summary: [{ type: 'text', text: ticket.summary }],
        rawOutput: [],
        llmStreamCall: false,
        provider: 'agent',
        model: 'agent',
        maxTokens: 0,
      }
    }
    return originalSummarize.call(this, input, agent, signal)
  }
  state.summarize = markHook(summarize, originalSummarize)
  if (originalCompact) {
    state.compactRegion = markHook(function (this: OptimizedEngineLike, start, end, agent, signal) {
      const context = state.scope.getStore()
      const ticket = context?.ticket
      if (identity(this) !== target || !ticket?.active || ticket.consumed || ticket.operation
        || identity(agent) !== ticket.agent
        || (ticket.span && (ticket.span.start !== start || ticket.span.end !== end))) {
        // 不匹配的嵌套/旁路操作不能继承外层输入的注入资格。
        return state.scope.exit(() => originalCompact.call(this, start, end, agent, signal))
      }
      signal?.throwIfAborted()
      const operation = {}
      ticket.operation = operation
      return state.scope.run({ ticket, operation }, () => originalCompact.call(this, start, end, agent, signal))
    } satisfies CompactRegion, originalCompact)
  }
  if (originalDependencies) {
    state.regionDependencies = markHook(function (this: OptimizedEngineLike) {
      const dependencies = originalDependencies.call(this)
      const context = state.scope.getStore()
      if (identity(this) !== target || !context?.operation) return dependencies
      return {
        ...dependencies,
        summarize: (input: unknown, agent: unknown, signal?: AbortSignal) =>
          state.scope.run({ ...context, input, inputBound: true },
            () => dependencies.summarize(input, agent, signal)),
      }
    }, originalDependencies)
  }
  target.summarize = state.summarize
  if (state.compactRegion) target.compactRegion = state.compactRegion
  if (state.regionDependencies) target.regionDependencies = state.regionDependencies
  Object.defineProperty(target, ENGINE_STATE, { value: state, configurable: true })
  // 恢复完成后不再将未来第三方方法替换误判为仍待恢复的 v4 链。
  if (Object.hasOwn(target, LEGACY_STATE)) delete target[LEGACY_STATE]
  target.__ctxcOptimized = PATCH_VERSION
  return true
}

/**
 * 同 API，支持 async callback；ALS 隔离 callback 的异步后代，而非放大同步窗口。
 * 仅该 callback 中匹配 engine + agent + 可选 span 的一次 compactRegion 可消费。
 * 直接 summarize 不消费。真实 Basic 的 regionDependencies 还绑定实际 replay input。
 * 未提供 span 时兼容旧调用，选择首个匹配的 compactRegion；不能在其前调用同一
 * engine/agent 的其他 compactRegion。建议传第5参数 { start, end } 消除这一歧义。
 * finally 撤销 ticket：未消费、异常、取消、Promise settle 后的 detached 工作均安全。
 */
export async function runWithExternalSummary<T>(
  engine: OptimizedEngineLike,
  agent: AgentLike,
  summary: string,
  run: () => T | PromiseLike<T>,
  span?: ExternalSummarySpan,
): Promise<T> {
  const owner = identity(agent)
  if (!isIdentity(owner)) throw new TypeError('external summary requires an agent object identity')
  if (typeof summary !== 'string') throw new TypeError('external summary must be a string')
  if (typeof run !== 'function') throw new TypeError('external summary requires a callback')
  if (span && (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < 0)) {
    throw new TypeError('external summary requires a valid inclusive span')
  }
  if (!patchEngine(engine)) throw new Error('compaction engine summarize is unavailable')
  const state = (identity(engine) as StatefulEngine)[ENGINE_STATE]!
  if (state.tickets.has(owner)) throw new Error('external summary already active for this engine and agent')
  const ticket: SummaryTicket = {
    summary, agent: owner, span: span && { start: span.start, end: span.end }, active: true, consumed: false,
  }
  state.tickets.set(owner, ticket)
  try {
    return await state.scope.run({ ticket }, run)
  } finally {
    ticket.active = false
    if (state.tickets.get(owner) === ticket) state.tickets.delete(owner)
  }
}
