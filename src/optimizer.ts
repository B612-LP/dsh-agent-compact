// @mimichunterz/agent-compact: 共享的优化器核心（零依赖）。
// 仅 runWithExternalSummary() 的同步 callback 调用栈可以消费一次性检查点；
// 其余 summarize() 始终转发官方实现，不改变自动压缩策略。

export interface SurfaceNode {
  seq: number
  [key: string]: unknown
}

export interface SessionLike {
  id: string
  surface?: { nodes?: readonly number[] }
  events?: readonly unknown[]
  // `SessionEvent` 没有被这些包导出；`any` 让结构形状可以赋值给真实的
  // `(event: SessionEvent) => Message | null`。
  deriveEventMessage?: (event: any) => unknown
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: { provider?: string; model?: string }
  ctx?: unknown
}

/** 修补所依赖的引擎表面（结构化且防御性；真实引擎是 BasicCompactionEngine，
 * 携带这些成员）。 */
export interface OptimizedEngineLike {
  /** @deprecated 仅保留类型兼容；v4 不读取此 sid 缓存，并在调用旧补丁前清空它。 */
  _externalSummary?: Record<string, string>
  summarize?: (input: unknown, agent: unknown, signal?: AbortSignal) => Promise<unknown>
  /** 补丁版本；修补行为变化时递增（见下文）。 */
  __ctxcOptimized?: number
}

export const PATCH_VERSION = 4

interface SummaryTicket {
  summary: string
  armed: boolean
  consumed: boolean
}

interface EngineState {
  engine: OptimizedEngineLike
  // ticket 在 run() 返回后立即 disarm，但直到异步操作 settle 才释放互斥。
  tickets: WeakMap<object, SummaryTicket>
  summarize: NonNullable<OptimizedEngineLike['summarize']>
}

// 引擎为 HMR 后仍存活的主机单例。共享 state 同时保留跨模块重载的互斥和
// wrapper identity，不能仅凭可遗留/伪造的 __ctxcOptimized 数字跳过修补。
const ENGINE_STATE = Symbol.for('@mimichunterz/agent-compact/optimizer/v4')
type StatefulEngine = OptimizedEngineLike & { [ENGINE_STATE]?: EngineState }

function isIdentity(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

export function patchEngine(engine: OptimizedEngineLike): boolean {
  if (!engine || typeof engine.summarize !== 'function') return false
  const target = engine as StatefulEngine
  // v3 的原函数只存在其闭包里，无法直接解包。其读取缓存发生在首次 await
  // 之前，因此先永久丢弃旧缓存，再同步调用旧 wrapper 即可保留官方 fallback。
  // 每次调用也清空，避免尚未迁移的调用者重新写入 sid 缓存造成污染。
  target._externalSummary = undefined
  const cached = target[ENGINE_STATE]
  const previous = cached?.engine === target ? cached : undefined
  if (previous && target.summarize === previous.summarize) {
    target.__ctxcOptimized = PATCH_VERSION
    return true
  }
  const originalSummarize = target.summarize!
  const tickets = previous?.tickets ?? new WeakMap<object, SummaryTicket>()
  const summarize = async function (this: OptimizedEngineLike, input: unknown, agent: unknown, signal?: AbortSignal) {
    target._externalSummary = undefined
    const ticket = this === target && isIdentity(agent) ? tickets.get(agent) : undefined
    if (ticket?.armed && !ticket.consumed) {
      signal?.throwIfAborted()
      ticket.consumed = true
      ticket.armed = false
      // 与原版 summarizer 返回的运行时形状相同；frameSummary 与大小检查不变。
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
  target.summarize = summarize
  target[ENGINE_STATE] = { engine: target, tickets, summarize }
  target.__ctxcOptimized = PATCH_VERSION
  return true
}

/**
 * 在该 engine + agent 对象 identity 上独占安装单次检查点，finally 仅回收自己的
 * ticket。即使已消费，在 run 的 Promise settle 前同一 agent 的第二次调用也拒绝。
 *
 * run 必须直接同步发起一次 compactRegion，例如：
 *   () => engine.compactRegion(start, end, agent, signal)
 * 不要在调用 compactRegion 前 await（归档、查边界等须先完成）。Basic 引擎会在
 * 首次 await 前同步进入 summarize；run 一返回就撤销注入资格，迟到的官方压缩
 * 或异步 callback 均只能走官方路径。不要在 callback 内先调用其他 summarize。
 *
 * 此最小接口不伪造 input/span 绑定：input 由 Basic 引擎在内部创建，helper 没有
 * start/end 参数。隔离边界为 engine + agent identity + 同步调用窗口 + 单次消费；
 * 如未来引擎在 summarize 前增加 await，应显式传递调用 token，而非扩大此窗口。
 */
export async function runWithExternalSummary<T>(
  engine: OptimizedEngineLike,
  agent: AgentLike,
  summary: string,
  run: () => T | PromiseLike<T>,
): Promise<T> {
  if (!isIdentity(agent)) throw new TypeError('external summary requires an agent object identity')
  if (typeof summary !== 'string') throw new TypeError('external summary must be a string')
  if (typeof run !== 'function') throw new TypeError('external summary requires a synchronous callback')
  if (!patchEngine(engine)) throw new Error('compaction engine summarize is unavailable')
  const { tickets } = (engine as StatefulEngine)[ENGINE_STATE]!
  if (tickets.has(agent)) throw new Error('external summary already active for this engine and agent')
  const ticket: SummaryTicket = { summary, armed: true, consumed: false }
  tickets.set(agent, ticket)
  try {
    let result: T | PromiseLike<T>
    try {
      // 不先 await：安装和消费必须在同一同步调用栈里，禁止暴露给其他任务。
      result = run()
    } finally {
      ticket.armed = false
    }
    return await result
  } finally {
    if (tickets.get(agent) === ticket) tickets.delete(agent)
  }
}
