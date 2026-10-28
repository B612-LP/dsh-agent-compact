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
import { CompactionPlans, inspectSurface, seqRegion, fingerprint, selectionPrices, sourcePrice, compactionEstimate, checkpointMessage, pureCompactionCall, activeCallPosition } from './preflight.js'
import { BatchScans, batchFingerprint } from './batch.js'
import type { BatchSelection } from './batch.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
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
  minSourceTokens: Schema.number().min(0).default(0).description('Deprecated compatibility setting; no source-size gate is enforced. Small selected ranges can participate in a batch.'),
  minNetSavingsTokens: Schema.number().min(0).default(0).description('Deprecated compatibility setting; no net-savings gate is enforced. Estimates are informational only.'),
  autoArchive: Schema.boolean().default(true).description('context_compact saves the full raw span to a spill artifact before replacing it.'),
  volumeNudgeTokens: Schema.number().min(0).default(350000).description('Absolute current-occupancy quality threshold (default 350k). No earlier quality notice: maintenance starts at this amount and stops below it. Not growth since compaction or a percentage of context capacity. 0 disables quality maintenance; the independent overflow guard remains.'),
  autoSafetyMarginTokens: Schema.number().min(0).default(65536).description('Secondary overflow guard: also warn this many tokens before the routed official auto-compaction threshold; capped for very small models. Does not warn below the 350k quality threshold when the route can safely reach it; routes whose official fallback line arrives first retain earlier overflow protection.'),
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
  const scans = new BatchScans()
  const batchReceipts = new WeakMap<object, Map<string, { until: number; signature: string; value: any }>>()
  const compacting = new Set<string>()
  const receipts = new WeakMap<object, Map<string, { until: number; value: any }>>()

  disposers.push(registerProactiveCompaction(ctx, config))

  disposers.push(tools.register(defineTool({
    name: 'context_compact',
    description: 'Two-call maintenance: (1) inspect once for the complete closed-surface candidate index and scanId; (2) compact with scanId+ranges to checkpoint ALL selected completed content in one batch tool call. No mandatory prepare, minimum span size or net-savings gate: small members may participate. A range may cover multiple contiguous completed topics; disjoint ranges preserve their intervening live gaps. Preserve exact user requirements/corrections, necessary paths/IDs, decisions, evidence, risks and next steps; do not include unfinished work. Structural range candidates are not automatic semantic-completion judgments: choose using the conversation already in context. Inspect coverage reports omissions explicitly; focused reads are optional when genuinely needed, not a routine scanning chain. Each batch member has observed startSeq/endSeq and its complete Markdown summary. All members validate before mutation; host commits run serially under one lock. Partial failures return per-member receipts: never repeat already committed members. scanId alone replays the batch receipt. Legacy single-span/prepare calls remain supported, without size/savings rejection. Raw spans are archived; current call and open tool steps cannot be selected.',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'prepare', 'compact'], description: 'inspect is read-only and creates a batch scan; compact with scanId+ranges commits all selected members. prepare is optional legacy-only, not part of the normal two-call path. Defaults to compact for legacy calls.' },
      mode: { type: 'string', enum: ['batch', 'overview', 'search', 'detail', 'messages'], description: 'inspect defaults to one-pass batch discovery across the closed surface. Other modes are legacy/focused reads; use them only when genuinely necessary, not as a mandatory preparation chain.' },
      query: { type: 'string', description: 'inspect literal case-insensitive text search; searches prose and tool results, not arguments/reasoning. Implies search mode.' },
      afterSeq: { type: 'number', description: 'inspect search/detail/messages cursor; advances in surface order. Alone selects legacy messages mode.' },
      limit: { type: 'number', description: 'batch: semantic landmark cap, default/max 200. Legacy modes: group/row cap 1..24. Coverage explicitly discloses any omissions.' },
      startSeq: { type: 'number', description: 'prepare or direct compact: explicit first observed ID with canStart=true. inspect detail/search: inclusive focus start.' },
      endSeq: { type: 'number', description: 'prepare or direct compact: explicit inclusive last observed ID with canEnd=true, never current call. inspect detail/search: focus end.' },
      planId: { type: 'string', description: 'compact only: planId from prepare; session-bound, single use, expires in 10 minutes; append-only activity outside the chosen span is allowed.' },
      startAnchor: { type: 'string', description: 'Verbatim opening of the span\'s first message. Required for a middle span; omitting starts at the conversation\'s first message, discarding opening requirements and direction — only for compressing all history up to endAnchor or rebaselining.' },
      endAnchor: { type: 'string', description: 'Verbatim opening of the span\'s last message; required. This node is replaced — pass its predecessor\'s opening to keep it.' },
      summary: { type: 'string', description: 'Legacy single-span complete Markdown checkpoint. For batches put one complete summary in each ranges member. Never send with inspect.' },
      scanId: { type: 'string', description: 'From the first inspect; pass with all selected ranges in the second call. Session-bound, expires in 10 minutes. Alone replays a completed batch receipt without resubmitting summaries.' },
      ranges: { type: 'array', description: 'compact batch: all selected concluded ranges together, including small members. No prepare or source/net gate. Retained gaps are never widened or removed.', items: {
        type: 'object', additionalProperties: false, properties: {
          startSeq: { type: 'integer', required: true, description: 'Observed legal start ID, including disclosed balanced tool-step calls.' },
          endSeq: { type: 'integer', required: true, description: 'Observed inclusive closed end ID, before the current call.' },
          summary: { type: 'string', required: true, description: 'Complete replacement checkpoint for this member; preserve exact requirements, evidence, active dependencies and next steps.' },
        },
      } },
    },
    output: {
      // 显式声明真实字段（而非开放的 additionalProperties:true 空对象），
      // 使 Code Mode 的 ToolOutputMap 能推导出这个工具的真实返回类型。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'True for inspection/preparation or fully successful compaction. False does NOT imply unchanged history: partial/outcome_unknown may include committed members; inspect per-member receipts before retry.' },
          status: { type: 'string', required: true, description: 'inspect, ready, needs_selection, stale_plan, busy, unavailable, compacted, partial, failed, outcome_unknown, or already_compacted (receipt replay; no second compaction).' },
          mode: { type: 'string', description: 'Inspection discovery mode.' },
          surface: { type: 'json', description: 'Closed surface counts and active-tail exclusion.' },
          groups: { type: 'json', description: 'Whole-surface navigation groups with bounded landmark previews; NOT automatically selected tasks.' },
          coverage: { type: 'json', description: 'Explicit semantic and raw-row coverage; never claim an incomplete discovery is the whole transcript.' },
          auxiliaryNavigation: { type: 'json', description: 'Navigation for omitted runtime snapshots and non-primary auxiliary messages.' },
          reason: { type: 'string', description: 'Why no mutation occurred and the safe next step.' },
          planId: { type: 'string', description: 'Legacy session-bound prepared range handle.' },
          scanId: { type: 'string', description: 'Session-bound inspection snapshot; pass with selected ranges in the second call. Also replays a completed batch receipt without summaries.' },
          ranges: { type: 'json', description: 'All structurally closed navigation units from a batch inspection, not automatic semantic completion decisions.' },
          landmarks: { type: 'json', description: 'Complete bounded semantic landmark index with exact legal boundaries and explicit coverage.' },
          results: { type: 'json', description: 'Per-range batch outcomes and raw archive locations; completed ranges are never retried implicitly.' },
          compactionId: { type: 'json', description: 'Durable host compaction identity for a single committed span.' },
          commitWarning: { type: 'string', description: 'Host failed after a durable replacement; reconciled as committed, never blindly retry.' },
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
    execute: executeCompaction,
  })))

  function cleanupBatchCall(agent: AgentWithSession, nodes: SurfaceNode[], callId: string | undefined, receipt: any) {
    if (!callId) return
    const holder = nodes.find(n => soleToolCall(n, callId) && pureCompactionCall(n))
    if (!holder) return // Never discard mixed prose/reasoning or a Code Mode root.
    const off = ctx.on('session/event', (s: { id?: string } | undefined, ev: SessionEventLike) => {
      if (s?.id !== agent.session.id || ev.type !== 'tool/result' || (ev.data as any)?.message?.source?.callId !== callId) return
      off()
      queueMicrotask(() => {
        try {
          const session = agent.session as any
          const text = '`context_compact` batch receipt (raw spans archived; no need to repeat completed ranges): ' + JSON.stringify(receipt)
          for (const seq of [holder.seq, ev.seq]) if (typeof seq === 'number') session.append('user/message', createShadowUserMessage(seq === holder.seq ? text : '`context_compact` batch result shadowed; receipt above. Return to the task when pressure is below threshold.'), {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
          })
        } catch (error) { ctx.logger.warn('[context_compact] batch call cleanup failed: %s', String(error)) }
      })
    })
  }

  async function executeBatch(args: Record<string, any>, exec: ToolRunContext): Promise<any> {
    const agent = agentOf(exec)
    const fail = (status: string, reason: string) => ({ ok: false, status, reason, archived: null })
    if (!agent) return fail('unavailable', 'No agent session; no batch changed.')
    if (['planId', 'startSeq', 'endSeq', 'startAnchor', 'endAnchor', 'summary'].some(k => args[k] !== undefined)) {
      return fail('needs_selection', 'Use scanId+ranges only for a batch; do not mix legacy selectors or a top-level summary.')
    }
    if (typeof args.scanId !== 'string' || !args.scanId) return fail('needs_selection', 'Inspect once to obtain scanId, then submit all selected ranges together.')
    const prior = batchReceipts.get(agent.session)?.get(args.scanId)
    if (prior && prior.until > Date.now()) {
      if (args.ranges !== undefined && JSON.stringify(args.ranges) !== prior.signature) return fail('needs_selection', 'This scan already has a batch receipt for a different payload. Do not replay changed summaries against it; inspect a new scan.')
      const nodes = await readSurfaceNodes(agent)
      if (nodes) cleanupBatchCall(agent, nodes, typeof exec.callId === 'string' ? exec.callId : undefined, prior.value)
      return { ...prior.value, status: prior.value.ok ? 'already_compacted' : prior.value.status,
        note: 'Receipt replay only; completed ranges were not compressed again. A partial receipt lists any untouched members. Use a fresh scan only for work still needing compaction.' }
    }
    if (compacting.has(agent.session.id)) return fail('busy', 'A compaction is already running in this session; no second batch started.')
    compacting.add(agent.session.id)
    try {
      const nodes = await readSurfaceNodes(agent)
      const meter = resolveService(agent, 'tokenMeter') as Meter | undefined
      if (!nodes || !meter) return fail('unavailable', 'Current surface/token meter unavailable; no batch changed.')
      const callId = typeof exec.callId === 'string' ? exec.callId : undefined
      const root = (exec as { rootCallId?: unknown }).rootCallId
      const boundary = typeof root === 'string' && root ? root : callId
      if (!boundary) return fail('unavailable', 'Active call identity unavailable; no batch changed.')
      const route = JSON.stringify(agent.session.requestHeader?.()?.config ?? agent.options ?? {})
      const cuts = { before: (seq: number) => toolPairingBalancedBefore(agent.session as any, seq as any),
        after: (seq: number) => toolPairingBalancedAfter(agent.session as any, seq as any) }
      let selections: BatchSelection[]
      try { selections = scans.resolve(agent.session, args.scanId, nodes, route, cuts, meter, boundary, args.ranges) }
      catch (error) { return fail('needs_selection', String((error as Error).message)) }
      // All members validate BEFORE the first mutation. Internal engine operations
      // are serialized under one plugin lock and each revalidates its own snapshot.
      const results: any[] = []
      const holder = nodes[activeCallPosition(nodes, boundary)]
      const callTokens = meter.measure(agent.session).nodes.find(n => n.seq === holder?.seq)?.tokens ?? 0
      for (let i = 0; i < selections.length; i++) {
        const item = selections[i]
        let value: any
        try {
          exec.signal?.throwIfAborted()
          value = await executeCompaction({ action: 'compact', startSeq: item.startSeq, endSeq: item.endSeq, summary: item.summary }, exec, true, item, route)
        } catch (error) { value = fail('failed', String((error as Error).message)) }
        results.push({ startSeq: item.startSeq, endSeq: item.endSeq, ...value })
        if (value.status !== 'compacted') {
          for (const pending of selections.slice(i + 1)) results.push({ startSeq: pending.startSeq, endSeq: pending.endSeq, status: 'not_attempted', archived: null })
          break
        }
      }
      const committed = results.filter(r => r.status === 'compacted')
      const sourceTokens = committed.reduce((sum, r) => sum + r.estimate.sourceTokens, 0)
      const checkpointTokens = committed.reduce((sum, r) => sum + (r.estimate.actualCheckpointTokens ?? r.estimate.checkpointTokens ?? 0), 0)
      const overheadTokens = callTokens + 1536 + results.length * 256
      const ok = committed.length === selections.length
      const out = { ok, status: ok ? 'compacted' : committed.length ? 'partial' : results.some(r => r.status === 'outcome_unknown') ? 'outcome_unknown' : 'failed', scanId: args.scanId, archived: null, results,
        estimate: { advisoryOnly: true, committedRanges: committed.length, outcomeUnknownRanges: results.filter(r => r.status === 'outcome_unknown').length, requestedRanges: selections.length,
          sourceTokens, checkpointTokens, overheadTokens, estimatedNetSavings: sourceTokens - checkpointTokens - overheadTokens,
          accounting: 'Aggregate estimate for committed members; submitted batch call counted once. No per-range source-size or net-savings gate. Not exact provider usage.' },
        note: ok ? 'Selected ranges were checkpointed in one tool call; retained gaps and active tail remain live. Return to the task when pressure is below threshold.'
          : 'Batch stopped at an unsuccessful or uncertain member. Committed members remain committed; not_attempted members are untouched. An outcome_unknown member requires durable-evidence inspection before retry. This is not an all-or-nothing host transaction; never blindly repeat completed ranges.' }
      let saved = batchReceipts.get(agent.session)
      if (!saved) { saved = new Map(); batchReceipts.set(agent.session, saved) }
      for (const [id, record] of saved) if (record.until <= Date.now()) saved.delete(id)
      while (saved.size >= 4) saved.delete(saved.keys().next().value!)
      saved.set(args.scanId, { until: Date.now() + 10 * 60 * 1000, signature: JSON.stringify(args.ranges), value: out })
      cleanupBatchCall(agent, nodes, callId, out)
      return out
    } finally { compacting.delete(agent.session.id) }
  }

  async function executeCompaction(args: Record<string, any>, exec: ToolRunContext, nested = false, expected?: BatchSelection, expectedRoute?: string): Promise<any> {
      const agent = agentOf(exec)
      if (!agent) throw new Error('no agent session available for this call')
      const action = args.action ?? 'compact'
      const noChange = (status: string, reason: string) => ({ ok: false, status, reason, archived: null })
      if (!['inspect', 'prepare', 'compact'].includes(String(action))) return noChange('needs_selection', 'Use inspect or compact; prepare is legacy-only.')
      if (action === 'compact' && (args.ranges !== undefined || args.scanId !== undefined)) return executeBatch(args, exec)
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
      if (action === 'compact' && !nested && compacting.has(agent.session.id)) return noChange('busy', 'Another compaction is running in this session; wait and inspect again.')
      if (action === 'compact' && !nested) compacting.add(agent.session.id)
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
          const view = discoverSurface(nodes, cuts, meter, agent.session, boundaryCallId, {
            mode: args.mode as DiscoveryOptions['mode'], query: args.query as string | undefined,
            startSeq: args.startSeq as number | undefined, endSeq: args.endSeq as number | undefined,
            afterSeq: args.afterSeq as number | undefined, limit: args.limit as number | undefined,
          })
          return { ok: true, status: 'inspect', archived: null, ...view,
            ...(view.mode === 'batch' ? { scanId: scans.issue(agent.session, nodes, routeKey, meter, boundaryCallId) } : {}) }
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
        if (nested) return noChange('stale_plan', String((error as Error).message))
        return { ...noChange(typeof args.planId === 'string' ? 'stale_plan' : 'needs_selection', String((error as Error).message)),
          ...discoverSurface(nodes, cuts, meter, agent.session, boundaryCallId) }
      }
      const estimateFor = (current: SurfaceNode[], r: Region, summary?: string) => {
        // Do not assume asynchronous cleanup will remove the submitted summary.
        // Charge the whole current call node plus a result/locator allowance.
        const measurement = meter.measure(agent.session)
        const holder = current[activeCallPosition(current, boundaryCallId)]
        const callCost = holder ? measurement.nodes.find(n => n.seq === holder.seq)?.tokens ?? 0 : 0
        return compactionEstimate(sourcePrice(current, r, meter, agent.session), summary, meter, callCost)
      }
      if (expected && (routeKey !== expectedRoute || batchFingerprint(nodes, b) !== expected.digest)) {
        return noChange('stale_plan', 'Selected batch content, route or price changed before this member began; retained without mutation.')
      }
      let estimate = estimateFor(nodes, b, action === 'compact' ? args.summary as string : undefined)
      if (action === 'prepare') return { ok: true, status: 'ready', archived: null, estimate,
        planId: plans.issue(agent.session, nodes, b, routeKey, selectionPrices(nodes, b, meter, agent.session)),
        note: 'Legacy optional preparation. No source-size or net-savings gate; estimates are informational only. Prefer one inspect followed by one compact with scanId+ranges for all selected concluded content.' }
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
        if (fingerprint(current, checked) !== preparedHash || (!nested && JSON.stringify(selectionPrices(current, checked, meter, agent.session)) !== preparedPrices)) {
          return noChange('stale_plan', 'Selected span or token pricing changed during archive; no history replaced. Inspect/prepare again.')
        }
      } catch (error) { return noChange('stale_plan', String((error as Error).message)) }
      estimate = estimateFor(current, checked, args.summary as string)
      exec.signal?.throwIfAborted()
      let result: CompactionResultLike
      let commitWarning: string | undefined
      const selectedSeqs = current.slice(checked.si, checked.ei + 1).map(n => n.seq)
      const eventFloor = Object.values(agent.session.events ?? {}).reduce((max: number, ev: any) => Math.max(max, typeof ev?.seq === 'number' ? ev.seq : -1), -1)
      try {
        result = await runWithExternalSummary(engine as unknown as OptimizedEngineLike, agent, args.summary as string,
          () => engine.compactRegion(startSeq, endSeq, agent, exec.signal), { start: startSeq, end: endSeq })
      } catch (err) {
        const msg = err && (err as Error).message ? (err as Error).message : String(err)
        // A host can append its replacement and only then fail its end event.
        // Reconcile durable evidence; never report that a possibly committed span
        // was untouched, and never lose the raw archive on an error path.
        const events = Object.values(agent.session.events ?? {}) as any[]
        const summaryEvent = events.filter(ev => ev?.type === 'compaction/summary' && ev.seq > eventFloor &&
          ev.data?.shadowedRange?.start === startSeq && ev.data?.shadowedRange?.end === endSeq &&
          JSON.stringify(ev.data?.shadowedSeqs) === JSON.stringify(selectedSeqs)).at(-1)
        const replacement = summaryEvent && events.find(ev => ev?.type === 'user/message' && ev.seq > summaryEvent.seq &&
          Array.isArray(ev.sourceEventSeqs) && ev.sourceEventSeqs.includes(summaryEvent.seq) &&
          ev.surfaceOp?.op === 'replace' && ev.surfaceOp.startSeq === startSeq && ev.surfaceOp.endSeq === endSeq)
        if (summaryEvent && replacement) {
          result = { compactionId: summaryEvent.data.compactionId, summary: summaryEvent.data.summary,
            shadowedSeqs: selectedSeqs, shadowedTokenCount: summaryEvent.data.shadowedTokenCount }
          commitWarning = 'Host reported an error after durable checkpoint replacement; reconciled as committed: ' + msg
        } else {
          let unchanged = false
          try {
            const after = await readSurfaceNodes(agent)
            if (after) unchanged = fingerprint(after, seqRegion(after, startSeq, endSeq, cuts, boundaryCallId)) === preparedHash
          } catch { /* a missing or unreadable range is outcome-unknown, not untouched */ }
          return { ok: false, status: unchanged ? 'failed' : 'outcome_unknown',
            reason: 'Host compaction failed: ' + msg + (unchanged ? '; selected content is confirmed unchanged.' : '; commit outcome could not be proven. Inspect durable evidence before retrying this member.'),
            archived: archived ? { locator: archived.locator, retrievalHint: archived.retrievalHint } : null,
            ...(archiveError ? { archiveError: String(archiveError) } : {}), estimate }
        }
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
      if (!nested && typeof callId === 'string' && callId) {
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
        compactionId: JsonValue
        commitWarning?: string
        estimate: ReturnType<typeof compactionEstimate> & { actualCheckpointTokens?: number; actualEstimatedNetSavings?: number; basis?: string }
        archived: { locator: JsonValue; retrievalHint: JsonValue } | null
        archiveError?: string
      } = {
        ok: true,
        status: 'compacted',
        compactionId: result.compactionId,
        estimate: committedEstimate,
        archived: archived ? {
          locator: archived.locator,
          retrievalHint: archived.retrievalHint,
        } : null,
      }
      if (commitWarning) out.commitWarning = commitWarning
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
        if (action === 'compact' && !nested) compacting.delete(agent.session.id)
      }
  }

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

