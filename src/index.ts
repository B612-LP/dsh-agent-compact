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
import { runWithExternalSummary } from './optimizer.js'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { CompactionPlans, inspectSurface, seqRegion, fingerprint, selectionPrices, sourcePrice, compactionBenefit, checkpointMessage, pureCompactionCall, activeCallPosition, MIN_SOURCE_TOKENS, MIN_NET_SAVINGS_TOKENS } from './preflight.js'
import type { Region, Meter } from './preflight.js'
import { discoverSurface } from './discovery.js'
import type { DiscoveryOptions } from './discovery.js'
import { normText } from './normalize.js'
import { CtxSurfaceService } from './ctx-surface.js'
import { resolveBoundaries, soleToolCall, spanText } from './boundary.js'
import { registerProactiveCompaction } from './proactive.js'
import type { AgentLike, OptimizedEngineLike, SessionLike, SurfaceNode } from './optimizer.js'

export const name = 'tool-context-compression'

export const inject = ['tools', 'systemPrompt']

export interface Config {
  autoArchive: boolean
  volumeNudgeTokens: number
  autoSafetyMarginTokens: number
  minSourceTokens: number
  minNetSavingsTokens: number
}

export const Config: Schema<Config> = Schema.object({
  minSourceTokens: Schema.number().min(1).default(MIN_SOURCE_TOKENS).description('Minimum route-priced source span for compaction (default 4096). Smaller completed tasks stay intact; never discard detail or combine live/unrelated tasks to pass this guard.'),
  minNetSavingsTokens: Schema.number().min(1).default(MIN_NET_SAVINGS_TOKENS).description('Minimum estimated net reduction after checkpoint framing, current tool-call cost and result/cleanup reserves (default 2048). Estimates are not exact provider savings.'),
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  volumeNudgeTokens: Schema.number().min(0).default(300000).description('Absolute current-occupancy bands: notice from 5/6 of this amount (default 250k), continuous maintenance from this amount (300k). Once continuous, keep prompting until below the notice band. Not growth since compaction or a percentage of context capacity. 0 disables these quality bands.'),
  autoSafetyMarginTokens: Schema.number().min(0).default(65536).description('Secondary overflow guard: also warn this many tokens before the routed official auto-compaction threshold; capped for very small models. Does not scale or postpone the absolute 250k/300k quality bands.'),
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
  const plans = new CompactionPlans()
  const compacting = new Set<string>()
  const receipts = new WeakMap<object, Map<string, { until: number; value: any }>>()

  disposers.push(registerProactiveCompaction(ctx, config))

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Safely checkpoint ONE substantial fully concluded sub-task. Preserve exact requirements/corrections, paths/IDs, decisions, evidence, risks and next steps; keep active/live work intact. Efficient path: inspect once for an overview across the whole closed surface (groups are navigation bounds, NOT semantic recommendations); query searches literal prose, mode=detail with startSeq/endSeq focuses omitted rows. Do not scan every tool-result page. When boundaries and full checkpoint are known, compact directly with startSeq/endSeq+summary (no prepare needed). Otherwise prepare explicit IDs WITHOUT summary for a planId and conservative budget reserving both checkpoint and submitted-summary copies; compact planId+summary. IDs must be current observed boundaries with canStart/canEnd; never the current call. Selection/task completion is your responsibility. Small ranges stay intact: never trim necessary detail or combine unrelated/live tasks to pass. A successful-plan receipt can be replayed with planId alone (no summary); returns already_compacted without a second compaction. Move on rather than retrying it. Legacy exact unique-prefix anchors remain supported. Raw spans are archived. Host may invoke its official summarizer; token estimates are not exact provider savings.',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'prepare', 'compact'], description: 'inspect is read-only; prepare selects explicit stable message IDs without writing a summary; compact commits a prepared checkpoint. Defaults to compact for legacy calls.' },
      mode: { type: 'string', enum: ['overview', 'search', 'detail', 'messages'], description: 'inspect defaults to whole-surface overview; search literal query; detail focused rows; messages legacy paginated stream. Overview groups are only navigation bounds.' },
      query: { type: 'string', description: 'inspect literal case-insensitive text search; searches prose and tool results, not arguments/reasoning. Implies search mode.' },
      afterSeq: { type: 'number', description: 'inspect search/detail/messages cursor; advances in surface order. Alone selects legacy messages mode.' },
      limit: { type: 'number', description: 'inspect group/row limit, 1..24; default 12.' },
      startSeq: { type: 'number', description: 'prepare or direct compact: explicit first observed ID with canStart=true. inspect detail/search: inclusive focus start.' },
      endSeq: { type: 'number', description: 'prepare or direct compact: explicit inclusive last observed ID with canEnd=true, never current call. inspect detail/search: focus end.' },
      planId: { type: 'string', description: 'compact only: planId from prepare; session-bound, single use, expires in 10 minutes; append-only activity outside the chosen span is allowed.' },
      startAnchor: { type: 'string', description: 'Verbatim opening of the span\'s first message. Required for a middle span; omitting starts at the conversation\'s first message, discarding opening requirements and direction — only for compressing all history up to endAnchor or rebaselining.' },
      endAnchor: { type: 'string', description: 'Verbatim opening of the span\'s last message; required. This node is replaced — pass its predecessor\'s opening to keep it.' },
      summary: { type: 'string', description: 'compact only: complete Markdown checkpoint; omit for receipt-only replay of a successful planId. Never send with inspect/prepare. Preserve all necessary information; if it cannot fit the prepared budget, leave the span intact or select another concluded task.' },
    },
    output: {
      // 显式声明真实字段（而非开放的 additionalProperties:true 空对象），
      // 使 Code Mode 的 ToolOutputMap 能推导出这个工具的真实返回类型。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'True for inspection/preparation or successful compaction; false for a non-mutating skip/reselection. Only status=compacted means history was replaced.' },
          status: { type: 'string', required: true, description: 'inspect, ready, skipped, needs_selection, stale_plan, busy, unavailable, compacted, or already_compacted (retry receipt; no new mutation).' },
          mode: { type: 'string', description: 'Inspection discovery mode.' },
          surface: { type: 'json', description: 'Closed surface counts and active-tail exclusion.' },
          groups: { type: 'json', description: 'Whole-surface navigation groups with bounded landmark previews; NOT automatically selected tasks.' },
          coverage: { type: 'json', description: 'Explicit returned/omitted counts; an overview is not a full transcript.' },
          reason: { type: 'string', description: 'Why no mutation occurred and the safe next step.' },
          planId: { type: 'string', description: 'Session-bound prepared range handle.' },
          candidates: { type: 'json', description: 'Bounded current message/closed-result boundary previews; not semantic compaction recommendations.' },
          nextAfterSeq: { type: 'json', description: 'Next inspection cursor or null.' },
          estimate: { type: 'json', description: 'Source, framed checkpoint, overhead and estimated reduction; not exact provider savings.' },
          note: { type: 'string', description: 'Selection and retention constraints.' },
          archived: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  locator: { type: 'json', required: true, description: 'Opaque spill-store locator for the archived raw span.' },
                  retrievalHint: { type: 'json', required: true, description: 'Backend-specific hint for retrieving the archived span.' },
                },
              },
            ],
            description: 'Archive record when the raw span was saved, or null when it was not.',
          },
          archiveError: { type: 'string', description: 'Present only when autoArchive was requested but archiving failed; compaction still succeeded.' },
        },
      },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const action = args.action ?? 'compact'
      const noChange = (status: string, reason: string) => ({ ok: false, status, reason, archived: null })
      if (!['inspect', 'prepare', 'compact'].includes(String(action))) return noChange('needs_selection', 'Use inspect, prepare or compact.')
      if (action !== 'compact' && args.summary !== undefined) return noChange('needs_selection', 'Do not write a summary during inspection/preparation; send it only once at compact.')
      if (action === 'compact') {
        const selectors = [args.planId !== undefined, args.startSeq !== undefined || args.endSeq !== undefined,
          args.startAnchor !== undefined || args.endAnchor !== undefined].filter(Boolean).length
        if (selectors > 1) return noChange('needs_selection', 'Do not mix planId, sequence IDs and legacy anchors. Choose exactly one selection method; no history changed.')
      }
      if (action === 'compact' && typeof args.planId === 'string') {
        const previous = receipts.get(agent.session)?.get(args.planId)
        if (previous && previous.until > Date.now()) {
          // Receipt-only retries need no summary. Exact transport retries may still
          // repeat it: remove only a pure direct replay call/result, never root prose.
          const replayCallId = (exec as { callId?: unknown }).callId
          const replayNodes = typeof replayCallId === 'string' ? await readSurfaceNodes(agent) : null
          const holder = replayNodes?.find(n => soleToolCall(n, replayCallId as string) && pureCompactionCall(n))
          if (holder) {
            const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
              if (s?.id !== agent.session.id || ev.type !== 'tool/result' ||
                (ev.data as any)?.message?.source?.callId !== replayCallId) return
              off()
              queueMicrotask(() => {
                try {
                  const session = agent.session as any
                  for (const seq of [holder.seq, ev.seq]) {
                    if (typeof seq !== 'number') continue
                    session.append('user/message', createShadowUserMessage('`context_compact` already_compacted: replay only; no second compaction. Original archive: ' + JSON.stringify(previous.value.archived)),
                      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
                  }
                } catch (error) { ctx.logger.warn('[context_compact] receipt replay cleanup failed: %s', String(error)) }
              })
            })
          }
          return { ...previous.value, status: 'already_compacted',
            note: 'This plan already succeeded; no second compaction performed. Receipt-only retries need planId, not summary. Re-check pressure and inspect a different concluded task if needed.' }
        }
      }
      if (action === 'compact' && (typeof args.summary !== 'string' || !args.summary.trim())) {
        return noChange('needs_selection', 'compact requires a complete Markdown summary unless replaying a successful plan receipt.')
      }
      // Acquire before the first await; no second plugin mutation can interleave.
      if (action === 'compact' && compacting.has(agent.session.id)) return noChange('busy', 'Another compaction is running in this session; wait and inspect again.')
      if (action === 'compact') compacting.add(agent.session.id)
      try {
      const nodes = await readSurfaceNodes(agent)
      if (nodes === null) return noChange('unavailable', 'sessionQuery unavailable; no history changed.')
      const meter = resolveService(agent, 'tokenMeter') as Meter | undefined
      if (!meter || typeof meter.measure !== 'function' || typeof meter.estimateMessage !== 'function') return noChange('unavailable', 'Authoritative token meter unavailable; no history changed.')
      const callId = typeof (exec as { callId?: unknown }).callId === 'string' ? (exec as { callId: string }).callId : undefined
      // Code Mode/PTC subcalls have synthetic IDs; only the root call is on the
      // durable surface. Use root identity for active-tail checks, NEVER cleanup.
      const rootCallId = (exec as { rootCallId?: unknown }).rootCallId
      const boundaryCallId = typeof rootCallId === 'string' && rootCallId ? rootCallId : callId
      if (!boundaryCallId) return noChange('unavailable', 'Active tool-call identity unavailable; refusing unsafe boundary selection.')
      const cuts = {
        before: (seq: number) => toolPairingBalancedBefore(agent.session as any, seq as any),
        after: (seq: number) => toolPairingBalancedAfter(agent.session as any, seq as any),
      }
      const route = () => JSON.stringify(agent.session.requestHeader?.()?.config ?? agent.options ?? {})
      const routeKey = route()
      const inspect = () => inspectSurface(nodes, cuts, meter, agent.session, boundaryCallId,
        typeof args.afterSeq === 'number' && Number.isSafeInteger(args.afterSeq) ? args.afterSeq : -1,
        typeof args.limit === 'number' && Number.isSafeInteger(args.limit) ? args.limit : 16)
      if (action === 'inspect') {
        if (args.mode === 'messages' || (!args.mode && !args.query && args.startSeq === undefined && args.afterSeq !== undefined)) {
          return { ok: true, status: 'inspect', archived: null, ...inspect() }
        }
        try {
          return { ok: true, status: 'inspect', archived: null, ...discoverSurface(nodes, cuts, meter, agent.session, boundaryCallId, {
            mode: args.mode as DiscoveryOptions['mode'], query: args.query as string | undefined,
            startSeq: args.startSeq as number | undefined, endSeq: args.endSeq as number | undefined,
            afterSeq: args.afterSeq as number | undefined, limit: args.limit as number | undefined,
          }) }
        } catch (error) { return noChange('needs_selection', String((error as Error).message)) }
      }
      let b: Region
      try {
        if (action === 'prepare' || (action === 'compact' && (args.startSeq !== undefined || args.endSeq !== undefined))) b = seqRegion(nodes, args.startSeq, args.endSeq, cuts, boundaryCallId)
        else if (typeof args.planId === 'string') b = plans.resolve(agent.session, args.planId, nodes, routeKey, cuts,
          r => selectionPrices(nodes, r, meter, agent.session), boundaryCallId)
        else {
          const legacy = resolveBoundaries(nodes, args)
          b = seqRegion(nodes, legacy.startSeq, legacy.endSeq, cuts, boundaryCallId)
        }
      } catch (error) {
        return { ...noChange(typeof args.planId === 'string' ? 'stale_plan' : 'needs_selection', String((error as Error).message)),
          ...discoverSurface(nodes, cuts, meter, agent.session, boundaryCallId) }
      }
      const estimateFor = (current: SurfaceNode[], r: Region, summary?: string) => {
        // Do not assume asynchronous cleanup will remove the submitted summary.
        // Charge the whole current call node plus a result/locator allowance.
        const measurement = meter.measure(agent.session)
        const holder = current[activeCallPosition(current, boundaryCallId)]
        const callCost = holder ? measurement.nodes.find(n => n.seq === holder.seq)?.tokens ?? 0 : 0
        return compactionBenefit(sourcePrice(current, r, meter, agent.session), summary, meter,
          config.minSourceTokens ?? MIN_SOURCE_TOKENS, config.minNetSavingsTokens ?? MIN_NET_SAVINGS_TOKENS,
          callCost)
      }
      let estimate = estimateFor(nodes, b, action === 'compact' ? args.summary as string : undefined)
      if (!estimate.useful) return { ...noChange('skipped', estimate.reason), estimate }
      if (action === 'prepare') return { ok: true, status: 'ready', archived: null, estimate,
        planId: plans.issue(agent.session, nodes, b, routeKey, selectionPrices(nodes, b, meter, agent.session)),
        note: 'Budget already reserves both checkpoint and submitted-summary copies. Write one complete checkpoint within maxCheckpointTokens; if necessary detail cannot fit, leave this span intact. A mixed/Code Mode call with unrelated payload can exceed the envelope: submit this compaction alone. Preparation does not infer task completion.' }
      const engine = resolveService(agent, 'compaction') as CompactionLike | undefined
      if (!engine) return noChange('unavailable', 'Compaction engine unavailable; no history changed.')
      const startSeq = b.startSeq, endSeq = b.endSeq
      const preparedHash = fingerprint(nodes, b)
      const preparedPrices = JSON.stringify(selectionPrices(nodes, b, meter, agent.session))
      if (typeof args.planId === 'string') plans.consume(agent.session, args.planId)
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

      // Archival awaits may admit other events. Never apply a stale checkpoint.
      const current = await readSurfaceNodes(agent)
      if (!current || route() !== routeKey) return noChange('stale_plan', 'Surface or route changed during archive; inspect/prepare again.')
      let checked: Region
      try {
        checked = seqRegion(current, startSeq, endSeq, cuts, boundaryCallId)
        if (fingerprint(current, checked) !== preparedHash || JSON.stringify(selectionPrices(current, checked, meter, agent.session)) !== preparedPrices) {
          return noChange('stale_plan', 'Selected span or token pricing changed during archive; no history replaced. Inspect/prepare again.')
        }
      } catch (error) { return noChange('stale_plan', String((error as Error).message)) }
      estimate = estimateFor(current, checked, args.summary as string)
      if (!estimate.useful) return { ...noChange('skipped', estimate.reason), estimate }
      exec.signal?.throwIfAborted()
      let result: CompactionResultLike
      try {
        result = await runWithExternalSummary(engine as unknown as OptimizedEngineLike, agent, args.summary as string,
          () => engine.compactRegion(startSeq, endSeq, agent, exec.signal))
      } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err)
        throw new Error('compaction rejected range [' + startSeq + ',' + endSeq + ']: ' + msg)
      }
      const usage = findSummaryUsage(agent.session, result.compactionId)
      // A host may use its own summarizer. Report the committed body, never claim
      // the submitted checkpoint estimate is the actual replacement size.
      let actualCheckpointTokens: number | undefined
      if (Array.isArray(result.summary)) {
        try {
          const frame = checkpointMessage('')
          const measured = meter.estimateMessage({ ...frame, content: [frame.content[0], ...result.summary, frame.content[2]] })
          if (Number.isFinite(measured) && measured >= 0) actualCheckpointTokens = measured
        } catch (error) { ctx.logger.warn('[context_compact] committed checkpoint estimate unavailable: %s', String(error)) }
      }
      const committedEstimate = { ...estimate,
        ...(actualCheckpointTokens === undefined ? {} : { actualCheckpointTokens,
          actualEstimatedNetSavings: estimate.sourceTokens - actualCheckpointTokens - estimate.overheadTokens }),
        basis: actualCheckpointTokens === undefined ? 'submitted checkpoint estimate only; actual replacement size unavailable' : 'committed checkpoint measured separately; submission overhead remains conservatively reserved',
      }
      // 成对清理：检查点是单独注入的，为避免检查点文本在 surface 出现两次，
      // 将该 tool-call 的 assistant/message 与其 tool/result 各 shadow 为一个
      // 占位符（仅当该消息恰好只含这一个 tool-call 时才安全）。
      if (typeof callId === 'string' && callId) {
        const holder = current.filter((n) => soleToolCall(n, callId) && pureCompactionCall(n)).pop()
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
                    ? '; replaced ~' + String(result.shadowedTokenCount) + ' source tokens (gross, not net savings)'
                    : ''
                  const doneText = '`context_compact` done: checkpoint above' + freedText + (locText
                    ? '; raw span archived at ' + locText + '.'
                    : '; raw span not archived.')
                  session.append('user/message', createShadowUserMessage(doneText), {
                    surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq },
                    sourceEventSeqs: [assistantSeq],
                  })
                  // 复用该占位槽位作为自我触发的习惯提醒：每次成功调用都给
                  // 下一次留下提示，引导模型自主管理上下文。
                  session.append('user/message', createShadowUserMessage('`context_compact` result shadowed. Re-check pressure: if proactive maintenance remains active, checkpoint another substantial, fully concluded sub-task; a small reduction is not enough while still high. Preserve exact requirements/corrections and necessary details. Keep in-flight spans intact; unrelated running jobs do not block other finished spans. If no safe useful span exists, retain it and explain why.'), {
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
      ctx.logger.info('[context_compact] %s span %d..%d (%s), shadowed %d nodes / %s tokens, surface %d -> after, usage=%o', agent.session.id, startSeq, endSeq, typeof args.planId === 'string' ? 'prepared-seq' : 'legacy-anchor', Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0, String(result.shadowedTokenCount ?? '?'), nodes.length, usage)
      const out: {
        ok: boolean
        status: string
        estimate: ReturnType<typeof compactionBenefit> & { actualCheckpointTokens?: number; actualEstimatedNetSavings?: number; basis?: string }
        archived: { locator: JsonValue; retrievalHint: JsonValue } | null
        archiveError?: string
      } = {
        ok: true,
        status: 'compacted',
        estimate: committedEstimate,
        archived: archived ? {
          locator: archived.locator,
          retrievalHint: archived.retrievalHint,
        } : null,
      }
      if (archiveError) out.archiveError = typeof archiveError === 'string' ? archiveError : String(archiveError)
      if (typeof args.planId === 'string') {
        let saved = receipts.get(agent.session)
        if (!saved) { saved = new Map(); receipts.set(agent.session, saved) }
        for (const [id, receipt] of saved) if (receipt.until <= Date.now()) saved.delete(id)
        while (saved.size >= 4) saved.delete(saved.keys().next().value!)
        saved.set(args.planId, { until: Date.now() + 10 * 60 * 1000, value: out })
      }
      return out
      } finally {
        if (action === 'compact') compacting.delete(agent.session.id)
      }
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

