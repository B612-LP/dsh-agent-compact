// @mimichunterz/agent-compact: 上下文压缩工具（bundle 插件）。
// 注册模型可见的 context_compact 工具，并在首次使用时修补压缩引擎，
// 使其 summarize() 尊重 agent 自行编写的检查点（参见 ./optimizer.js）。

import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
// `JsonValue` 由 dsh-util-values 提供（不在 dsh-tools / dsh-session）。
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createShadowUserMessage } from './shadow-message.js'
import { patchEngine } from './optimizer.js'
import { normText } from './normalize.js'
import { CtxSurfaceService } from './ctx-surface.js'
import { resolveBoundaries, soleToolCall, spanText } from './boundary.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode } from './optimizer.js'

export const name = 'tool-context-compression'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  autoArchive: boolean
  volumeNudgeTokens: number
}

export const Config: Schema<Config> = Schema.object({
  autoArchive: Schema.boolean().default(true).description('context_compact 压缩前先把被压原文完整存一份到 spill 留底文件。'),
  volumeNudgeTokens: Schema.number().default(50000).description('自上次压缩起，累计增长的 token 每跨过这个数的整数倍，就提醒模型考虑用 context_compact 压缩。设为 0 关闭提醒。'),
})

export function apply(ctx: Context, config: Config) {
  // 注意：sessionQuery 与 agentPresets 必须在每次调用时解析——它们在 apply
  // 时可能尚未挂载，此时捕获会让 context_compact 工具失效。
  const tools = ctx.get('tools')
  if (!tools) throw new Error('@mimichunterz/agent-compact: tools service unavailable')

  // 为浏览器「上下文」面板注册 ctxSurface 服务（`ctxSurface/read`）。
  new CtxSurfaceService(ctx)

  interface AgentWithSession extends AgentLike {
    session: SessionLike
  }

  interface SpillSaveArgs {
    owner: { sessionId: string }
    source: { toolName: string; callId: unknown; label: string }
    suggestedName: string
    content: string
  }

  interface SpillStoreLike {
    saveText(args: SpillSaveArgs): Promise<{ locator: JsonValue; bytes: JsonValue; retrievalHint: JsonValue }>
  }

  interface SessionQueryLike {
    readSurface(sessionId: string): Promise<{ events?: unknown } | null>
  }

  // 使用类型别名（而非 interface），使其携带隐式索引签名，
  // 嵌入工具结果时仍可赋值给 JsonValue。
  type SurfaceArchive = {
    locator: JsonValue
    bytes: JsonValue
    retrievalHint: JsonValue
    chars: number
    archivedSeqs: number[]
  }
  interface CompactionResultLike {
    compactionId: JsonValue
    shadowedRange?: { start: number; end: number } | null
    shadowedSeqs?: JsonValue[] | null
    shadowedTokenCount?: JsonValue | null
    summary?: JsonValue
  }

  interface CompactionLike {
    compactRegion(start: number, end: number, agent: AgentWithSession, signal?: AbortSignal): Promise<CompactionResultLike>
  }

  interface SessionEventLike {
    type?: string
    seq?: number
    data?: unknown
    sourceEventSeqs?: unknown
  }

  // 用会话占用量的增长量作为提醒信号：自上次压缩以来增长每跨过
  // config.volumeNudgeTokens 的一个整数倍，就提示模型考虑压缩。
  // 度量指标按优先级：
  //  1. sessionProjections 的 contextPressure.projectedTokens（provider 真实
  //     usage 的投影，每次 LLM 调用都会重新同步到真实值）；
  //  2. tokenMeter 的 surfaceTokens（chars/4 启发式），仅当 (1) 不可用时使用。
  // 两者均按会话增量累积，服务缺席时整个特性降级为 no-op。
  const volumeBaseline = new WeakMap<SessionLike, number>()

  interface TokenMeterLike {
    measure(session: SessionLike): { surfaceTokens?: number } | null | undefined
  }

  interface SessionProjectionsLike {
    snapshot(session: SessionLike): { values?: Record<string, unknown> } | null | undefined
  }

  function surfaceTokensOf(session: SessionLike): number | null {
    const meter = ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (!meter || typeof meter.measure !== 'function') return null
    try {
      const m = meter.measure(session)
      const tokens = m && typeof m.surfaceTokens === 'number' ? m.surfaceTokens : null
      return tokens
    } catch (e) {
      return null
    }
  }

  function contextPressureProjectedTokensOf(session: SessionLike): number | null {
    const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    if (!projections || typeof projections.snapshot !== 'function') return null
    try {
      const snap = projections.snapshot(session)
      const values = snap && snap.values
      const contextPressure = values ? (values as { contextPressure?: { projectedTokens?: unknown } }).contextPressure : undefined
      const projected = contextPressure && typeof contextPressure.projectedTokens === 'number' ? contextPressure.projectedTokens : null
      return projected
    } catch (e) {
      return null
    }
  }

  function occupancyTokensOf(session: SessionLike): number | null {
    const projected = contextPressureProjectedTokensOf(session)
    if (projected !== null) return projected
    return surfaceTokensOf(session)
  }

  function resolveService(agent: AgentLike, serviceName: string): unknown {
    const direct = ctx.get(serviceName)
    if (direct) return direct
    // agentPresets 按每次调用解析（apply 时注册表可能尚未挂载）。
    const agentPresets = ctx.get('agentPresets')
    const presets = agentPresets as { serviceFor?: (agent: { ctx: unknown }, name: string) => unknown } | undefined
    if (presets && typeof presets.serviceFor === 'function' && agent && agent.ctx) {
      try {
        const viaPreset = presets.serviceFor({ ctx: agent.ctx }, serviceName)
        if (viaPreset) return viaPreset
      } catch (e) {
        /* 忽略错误，继续向下 */
      }
    }
    return undefined
  }

  function agentOf(exec: { agent?: unknown }): AgentWithSession | null {
    const agent = exec.agent as AgentLike | undefined
    if (!agent || !agent.session) return null
    return agent as AgentWithSession
  }

  async function readSurfaceNodes(agent: AgentWithSession): Promise<SurfaceNode[] | null> {
    const sessionQuery = resolveService(agent, 'sessionQuery') as SessionQueryLike | undefined
    if (!sessionQuery) return null
    const snap = await sessionQuery.readSurface(agent.session.id)
    return snap && Array.isArray(snap.events) ? (snap.events as SurfaceNode[]) : []
  }

  // 按会话顺序编号的归档：从会话 spill 目录已有的最大数字后缀推导下一个编号；
  // 无 `root` 字段的后端降级为内存计数器。
  const archiveCounters = new Map<string, number>()

  function spillRootOf(spillStore: SpillStoreLike): string | null {
    const s = spillStore as unknown as { root?: unknown } | null
    return s && typeof s.root === 'string' && s.root ? s.root : null
  }

  function sessionSpillDir(root: string, sessionId: string): string {
    return join(root, 'session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 12))
  }

  // 会话 spill 目录中已存在的最大数字后缀，不存在则为 0。
  async function maxArchiveNumber(root: string, sessionId: string): Promise<number> {
    try {
      const entries = await readdir(sessionSpillDir(root, sessionId))
      let max = 0
      for (const name of entries) {
        const m = /-(\d+)\.txt$/.exec(name)
        if (m) max = Math.max(max, Number(m[1]))
      }
      return max
    } catch (e) {
      return 0 // 目录缺失或不可读：回退到内存计数器
    }
  }

  async function archiveSpan(agent: AgentWithSession, spillStore: SpillStoreLike, nodes: SurfaceNode[], si: number, ei: number): Promise<SurfaceArchive | null> {
    if (!spillStore) return null
    const content = spanText(nodes, si, ei)
    const sid = agent.session.id
    const root = spillRootOf(spillStore)
    const scanned = root ? await maxArchiveNumber(root, sid) : 0
    const n = Math.max(scanned, archiveCounters.get(sid) ?? 0) + 1
    archiveCounters.set(sid, n)
    const ref = await spillStore.saveText({
      owner: { sessionId: sid },
      source: { toolName: 'context_compact', callId: null, label: 'auto-archive' },
      suggestedName: String(n).padStart(6, '0') + '.txt',
      content,
    })
    return {
      locator: ref.locator,
      bytes: ref.bytes,
      retrievalHint: ref.retrievalHint,
      chars: content.length,
      archivedSeqs: nodes.slice(si, ei + 1).map((n) => n.seq),
    }
  }

  // 从持久的 compaction/summary 事件中读取摘要用量。
  function findSummaryUsage(session: SessionLike, compactionId: unknown): JsonValue | null {
    try {
      const events = session.events
      if (!events) return null
      const keys = Object.keys(events)
      for (let i = keys.length - 1; i >= 0; i--) {
        const ev = (events as unknown as Record<string, unknown>)[keys[i]] as { type?: string; data?: { compactionId?: unknown; usage?: JsonValue } } | undefined
        if (ev && ev.type === 'compaction/summary' && ev.data && ev.data.compactionId === compactionId) {
          return ev.data.usage ?? null
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    return null
  }

  const disposers: (() => void)[] = []

  // `context_compact` 的主机级 system-prompt 指引（order 118，全局提示层）。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    disposers.push(systemPrompt.section({
      name: 'tool:context_compact',
      order: 118,
      text: '使用 context_compact 工具主动外置已完成使命的对话段落——像聪明的人类记忆那样留存要事、放下其余，这是常规记忆整理而非最后手段。只压缩「其信息能被摘要完整覆盖后续对话」的段落；若逐字细节后续可能还要用，就留着。工具只替换你选定的段落：按子任务/模块分段压缩——某个子任务占用大量上下文并已收尾时，先把该模块的段落分块压缩掉再继续，绝不把多个失效段落攒成一次巨型压缩。大体积输出（日志查询、大文件读取）一经读毕消化就尽快压缩。段落何时算「用完」要随时评估，不要只等话题边界；开头、进行中的任务、当前指令永不压缩；检查点里保留确切的路径、命令、ID 和用户要求。',
    }))
  }

  // 会话发生压缩（含自动引擎）时重置增长基线。
  disposers.push(ctx.on('session/event', (session: SessionLike | undefined, event: SessionEventLike) => {
    try {
      if (!session || event.type !== 'compaction/summary') return
      const tokens = occupancyTokensOf(session)
      volumeBaseline.set(session, tokens ?? 0)
    } catch (e) {
      /* 忽略 */
    }
  }))

  // 通过 systemPrompt.context() 注入尾部实时提示：仅在增长跨过整数倍的那几步
  // 写入 KV 缓存（文本不变时是完全的 no-op），独立于自动引擎的压力阈值。
  if (systemPrompt) {
    disposers.push(systemPrompt.context({
      name: 'agent-compact:volume-nudge',
      order: 50,
      text: () => {
        try {
          const threshold = config.volumeNudgeTokens
          if (!(threshold > 0)) return ''
          const agentsService = ctx.get('agents')
          const current = agentsService && typeof (agentsService as { currentInitiator?: unknown }).currentInitiator === 'function'
            ? (agentsService as { currentInitiator: () => unknown }).currentInitiator()
            : undefined
          const agent = current as { session?: SessionLike } | undefined
          if (!agent || !agent.session) return ''
          const now = occupancyTokensOf(agent.session)
          if (now === null) return ''
          const baseline = volumeBaseline.get(agent.session) ?? 0
          const grown = now - baseline
          if (grown <= 0) return ''
          const bucket = Math.floor(grown / threshold)
          if (bucket <= 0) return ''
          const approxK = Math.round((bucket * threshold) / 1000)
          return '`context_compact` 提醒：自上次压缩以来，本会话上下文已增长约 ' + approxK + 'k+ token（工具结果和你自己的推理/输出都算）。按子任务模块分段压缩，不要一次全压：当某个子任务的段落（其工具结果＋你的推理/输出）占了大量上下文且该子任务已收尾时，现在就用 `context_compact` 分块压缩该模块——不要等用户开口。'
        } catch (e) {
          return ''
        }
      },
    }))
  }

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: '把过去一段对话压缩成一份由你撰写的 Markdown 检查点；被压缩的原文归档为 spill 留底文件，并记录这次压缩。锚点匹配：锚点匹配消息正文的开头文本（仅限 user/assistant 消息；工具调用块、工具结果等转录结构除外）。空白、工具调用标记、全角/半角标点差异均被忽略；每个锚点必须恰好匹配一条 user 或 assistant 消息。何时压缩：① 进展——每个完成的步骤在其话题边界压缩，保持活动指令和剩余步骤在线；② 纠偏——把失败的段落压缩成检查点，记录错在哪、修正后的方向，而不是把噪音继续背着走；③ 重定基——开头要求已过时：连开头一起压缩，重申当前意图与仍然有效的决定。检查点写法：Markdown、精炼要点、## 分节；保留确切路径/命令/ID 与用户的要求和方向。分场景结构——进展：主要请求与意图 / 关键技术概念 / 文件与代码 / 错误与修复 / 当前工作 / 下一步；纠偏：错在哪 / 根因 / 修复 / 下一步；重定基：当前意图 / 仍然有效的决定 / 后续计划。约束：同一时刻只允许一个压缩进行；检查点必须小于被压缩的段落；边界自动对齐到成对的工具调用/结果处。',
    parameters: {
      startAnchor: { type: 'string', description: '段落第一条消息正文的逐字开头。压缩中间段落时必填；省略则从对话第一条消息开始——开头的要求与方向会被丢弃，仅用于把全部历史压到 endAnchor，或重定基。' },
      endAnchor: { type: 'string', description: '段落最后一条消息的逐字开头；必填。该节点本身会被替换——想保留它，就传它前一条消息的开头。' },
      summary: { type: 'string', description: '必填。替换该段落的完整 Markdown 检查点，由你根据对话撰写；禁止逐字照抄。分场景结构见工具描述；必须小于被压缩的内容。' },
    },
    output: {
      // 显式声明真实字段（而非开放的 additionalProperties:true 空对象），
      // 使 Code Mode 的 ToolOutputMap 能推导出这个工具的真实返回类型。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: '调用成功时恒为 true（失败会直接抛错而不是返回 false）。' },
          archived: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  locator: { type: 'json', required: true, description: '归档原文的 spill 留底库定位符（不透明字符串）。' },
                  retrievalHint: { type: 'json', required: true, description: '后端相关的留底取回提示。' },
                },
              },
            ],
            description: '原文已留底时为归档记录，未留底时为 null。',
          },
          archiveError: { type: 'string', description: '仅当请求了自动留底但留底失败时出现；此时压缩本身仍然成功。' },
        },
      },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      if (typeof args.summary !== 'string' || !args.summary.trim()) {
        throw new Error('summary is REQUIRED: write the Markdown checkpoint yourself (this tool makes no LLM summarizer call)')
      }
      const engine = resolveService(agent, 'compaction') as CompactionLike | undefined
      if (!engine) throw new Error('compaction service is not available in this runtime (tried host plane and preset realm)')
      patchEngine(engine as unknown as OptimizedEngineLike)
      const nodes = await readSurfaceNodes(agent)
      if (nodes === null) throw new Error('sessionQuery service is not available in this runtime')
      const b = resolveBoundaries(nodes, args)
      const startSeq = b.startSeq
      const endSeq = b.endSeq
      // 把 agent 编写的检查点交给引擎；被修补的 summarizer 消费它（一次性）
      // 并完全跳过 LLM 调用。
      {
        const ext = ((engine as unknown as { _externalSummary?: Record<string, string> })._externalSummary ??= {})
        ext[agent.session.id] = args.summary
      }

      const spillStore = resolveService(agent, 'spillStore') as SpillStoreLike | undefined
      let archived: SurfaceArchive | null = null
      let archiveError: JsonValue | null = null
      if (config.autoArchive && spillStore) {
        try {
          archived = await archiveSpan(agent, spillStore, nodes, b.si, b.ei)
        } catch (err) {
          archiveError = err && (err as Error).message ? (err as Error).message : String(err)
        }
      } else if (config.autoArchive) {
        archiveError = 'spillStore unavailable; raw copy not saved (compaction still proceeds)'
      }

      let result: CompactionResultLike
      try {
        result = await engine.compactRegion(startSeq, endSeq, agent, exec.signal)
      } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err)
        throw new Error('compaction rejected range [' + startSeq + ',' + endSeq + ']: ' + msg)
      }
      const usage = findSummaryUsage(agent.session, result.compactionId)
      // 成对清理：检查点是单独注入的，为避免检查点文本在 surface 出现两次，
      // 将该 tool-call 的 assistant/message 与其 tool/result 各 shadow 为一个
      // 占位符（仅当该消息恰好只含这一个 tool-call 时才安全）。
      const callId = (exec as { callId?: unknown }).callId
      if (typeof callId === 'string' && callId) {
        const holder = nodes.filter((n) => soleToolCall(n, callId)).pop()
        const assistantSeq = holder ? holder.seq : undefined
        if (assistantSeq !== undefined && assistantSeq > endSeq) {
          const sid = agent.session.id
          let done = false
          const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
            if (done) return
            if (!s || s.id !== sid) return
            if (ev.type !== 'tool/result') return
            const d = ev.data as { message?: { source?: { callId?: unknown } } } | null | undefined
            const src = d && d.message && d.message.source ? d.message.source.callId : undefined
            if (src !== callId) return
            done = true
            try {
              off()
            } catch (e) {
              /* 忽略 */
            }
            try {
              const session = agent.session as unknown as { append: (type: string, data: unknown, opts: unknown) => unknown }
              if (!session || typeof session.append !== 'function') return
              // 监听器在框架的 tool/result 发布流程内同步执行（appending 仍为
              // true），同步 append 会触发重入保护；延迟到微任务队列。
              const resultSeq = ev.seq
              const run = () => {
                try {
                  // 把归档定位符写进完成消息（承载它的 tool/result 随后被 shadow）。
                  const locText = archived && archived.locator ? String(archived.locator) : ''
                  const freedText = result.shadowedTokenCount !== undefined && result.shadowedTokenCount !== null
                    ? '；释放约 ' + String(result.shadowedTokenCount) + ' token'
                    : ''
                  const doneText = '`context_compact` 完成：检查点已写入上方' + freedText + (locText
                    ? '；原文留底：' + locText + '。'
                    : '；原文未留底。')
                  session.append('user/message', createShadowUserMessage(doneText), {
                    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq },
                    sourceEventSeqs: [assistantSeq],
                  })
                  // 复用该占位槽位作为自我触发的习惯提醒：每次成功调用都给
                  // 下一次留下提示，引导模型自主管理上下文。
                  session.append('user/message', createShadowUserMessage('`context_compact` 的结果已并入上方检查点。继续保持自主管理上下文：下一个子任务收尾、一个错误被解决、或某条大工具结果被消化完毕时，就及时压缩对应段落——不必等用户再提。'), {
                    surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
                    sourceEventSeqs: [resultSeq],
                  })
                  ctx.logger.info('[context_compact] %s paired cleanup: shadowed assistant/message %d + tool/result %d', sid, assistantSeq, resultSeq)
                } catch (e) {
                  ctx.logger.warn('[context_compact] %s paired cleanup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
                }
              }
              if (typeof queueMicrotask === 'function') queueMicrotask(run)
              else setTimeout(run, 0)
            } catch (e) {
              ctx.logger.warn('[context_compact] %s paired cleanup setup failed: %s', sid, e && (e as Error).message ? (e as Error).message : String(e))
            }
          })
        }
      }
      // 调试指标只进日志，不进入模型可见的工具结果。
      ctx.logger.info('[context_compact] %s span %d..%d (%s), shadowed %d nodes / %s tokens, surface %d -> after, usage=%o', agent.session.id, startSeq, endSeq, b.method, Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0, String(result.shadowedTokenCount ?? '?'), nodes.length, usage)
      const out: {
        ok: boolean
        archived: { locator: JsonValue; retrievalHint: JsonValue } | null
        archiveError?: string
      } = {
        ok: true,
        archived: archived ? {
          locator: archived.locator,
          retrievalHint: archived.retrievalHint,
        } : null,
      }
      if (archiveError) out.archiveError = typeof archiveError === 'string' ? archiveError : String(archiveError)
      return out
    },
  })))

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

