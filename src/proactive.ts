// Pressure-driven proactive compaction. The official engine remains the last-resort
// safety net; this module gives the model substantial room to write its own checkpoints.
import { patchEngine } from './optimizer.js'
import type { AgentLike, SessionLike } from './optimizer.js'
import { occupancyFromMeasurement, pressureRowFieldsOf, projectedPressureFromRow } from './occupancy.js'

export interface ProactiveConfig {
  volumeNudgeTokens: number
  autoSafetyMarginTokens: number
}

type RecordLike = Record<string, unknown>
function record(value: unknown): RecordLike {
  return value !== null && typeof value === 'object' ? value as RecordLike : {}
}
function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function positive(value: unknown): number | undefined {
  const n = nonnegative(value)
  return n !== undefined && n > 0 ? n : undefined
}
function ratio(value: unknown, fallback: number): number {
  const n = positive(value)
  return n !== undefined && n <= 1 ? n : fallback
}

export interface AutomaticBudget {
  threshold: number
  urgent: number
  safetyTarget: number
}

// Match BasicCompactionEngine's ratio AND output/headroom cap, including exact-route
// overrides. Without matching adapter metadata and a Basic config, return unknown
// instead of combining stale UI pressure/capacity or fabricating a safe limit.
export function automaticBudget(
  engineConfig: unknown, requestConfig: unknown, modelInfo: unknown,
  config: ProactiveConfig,
): AutomaticBudget | null {
  const base = record(engineConfig)
  const request = record(requestConfig)
  const info = record(modelInfo)
  const window = positive(record(info.context).contextWindow)
  if (window === undefined || !Number.isInteger(window) || !request.provider || !request.model
    || positive(base.thresholdRatio) === undefined || nonnegative(base.headroomTokens) === undefined) return null
  const policies = Array.isArray(base.modelPolicies) ? base.modelPolicies : []
  const override = record(policies.find(p => {
    const policy = record(p)
    return policy.provider === request.provider && policy.model === request.model
  }))
  const thresholdRatio = ratio(override.thresholdRatio ?? base.thresholdRatio, 0.8)
  const headroom = nonnegative(override.headroomTokens ?? base.headroomTokens) ?? 65536
  const completion = nonnegative(request.maxTokens) ?? nonnegative(info.defaultMaxTokens) ?? 0
  if (!Number.isInteger(completion) || !Number.isInteger(headroom)) return null
  const threshold = Math.floor(Math.min(window * thresholdRatio, window - completion - headroom))
  if (threshold <= 0) return null
  // Secondary overflow guard ONLY. Cap an absolute margin for very small models;
  // this does not scale the primary 300k context-quality threshold with capacity.
  const margin = Math.min(nonnegative(config.autoSafetyMarginTokens) ?? 65536, Math.floor(threshold / 4))
  return { threshold, urgent: threshold - margin, safetyTarget: threshold - Math.ceil(margin * 1.5) }
}

export interface NudgeState {
  pressureActive: boolean
  safetyActive: boolean
}
export function evaluateNudge(now: number, budget: AutomaticBudget | null, state: NudgeState, threshold: number) {
  // Quality maintenance has ONE absolute threshold. Below it, do not distract
  // the agent with an earlier notice or latch a previous cycle down to 250k.
  state.pressureActive = threshold > 0 && now >= threshold
  // Missing metadata cannot mark a previously unsafe SAME-route budget healthy.
  if (budget) {
    if (now < budget.safetyTarget) state.safetyActive = false
    else if (now >= budget.urgent) state.safetyActive = true
  }
  if (state.safetyActive) return 'urgent'
  if (state.pressureActive) return 'pressure'
  return 'quiet'
}

export const COMPACTION_GUIDANCE = 'Keep context healthy with agent-written context_compact checkpoints instead of waiting for automatic full-history summarization. Manage current absolute token occupancy, not percentage of a 500k/1M window or growth since the last compaction: quality maintenance starts ONLY at the configured absolute threshold (default 300k). Below that threshold, focus on the current task: do not inspect, prepare or compact solely for quality maintenance. There is no earlier 250k notice or quality-maintenance latch below the threshold; older historical reminders do not override this policy. The independent official overflow guard may still require earlier action on small routes. At or above the threshold, proactively compact substantial, fully concluded sub-task spans at safe topic boundaries; a current pressure reminder means prioritize this before optional new work. Each checkpoint must preserve current requirements and user corrections verbatim, exact paths/commands/IDs, decisions and rationale, verified results, unresolved risks, and the next steps needed to continue. Keep the opening requirements, active instruction, recent working context, and in-flight deployment/migration/job spans live. An unrelated background task is NOT a reason to leave other fully concluded spans uncompressed. Compact one concluded sub-task per call, then re-check pressure and continue with other eligible spans until healthy; one small compaction is not enough if pressure remains high. Use context_compact action=inspect once for a whole-surface semantic overview. Groups are navigation bounds, not safe spans: use query search or focused mode=detail for omitted boundaries instead of scanning every tool-result page. If the concluded task and full checkpoint are already known, action=compact with observed startSeq/endSeq plus summary avoids a prepare round trip. Otherwise action=prepare with explicit IDs and NO summary returns a conservative two-copy budget, then compact with planId+summary. A successful-plan retry returns already_compacted without mutation: move on, never recompact that plan. Never pick the current tool-call message or guess stale checkpoint prefixes. Tiny/low-net-benefit spans are intentionally skipped: leave them intact and select another substantial concluded task; never delete necessary detail or merge unrelated/in-flight work merely to meet a minimum. After a stale plan or legacy anchor error inspect the surviving surface before retrying. Never compress for token savings at the cost of necessary detail; when no safe useful span exists, retain it, say why, and avoid optional bulk output. The official engine remains an emergency fallback, not the normal context-management strategy.'

interface Host {
  get(name: string): any
  on(name: string, listener: (...args: any[]) => any): () => void
  logger: { info(...args: any[]): void; warn(...args: any[]): void }
}
export function registerProactiveCompaction(ctx: Host, config: ProactiveConfig): () => void {
  const states = new WeakMap<SessionLike, NudgeState & { routeKey?: string; llm?: unknown }>()
  const modes = new WeakMap<SessionLike, string>()
  const modelInfos = new WeakMap<object, Map<string, { info: unknown; until: number }>>()
  function cacheFor(llm: unknown) {
    if ((typeof llm !== 'object' || llm === null) && typeof llm !== 'function') return undefined
    const owner = llm as object
    let cache = modelInfos.get(owner)
    if (!cache) { cache = new Map(); modelInfos.set(owner, cache) }
    return cache
  }
  const disposers: (() => void)[] = []
  function service(agent: AgentLike, name: string): any {
    try {
      const scoped = agent.ctx && ctx.get('agentPresets')?.serviceFor?.({ ctx: agent.ctx }, name)
      if (scoped) return scoped
    } catch { /* try host service */ }
    return ctx.get(name)
  }
  function requestOf(agent: AgentLike): RecordLike {
    return record(agent.session?.requestHeader?.()?.config)
  }
  function modelKey(request: RecordLike): string {
    return JSON.stringify([request.provider, request.model])
  }
  // Context providers run BEFORE the assemble waterfall and before pre-step.
  // Resolve metadata in the async assembly hook, then re-render this one context
  // in that SAME assembly. The synchronous provider remains for admission refresh.
  async function prepareMetadata(agent: AgentLike, signal?: AbortSignal) {
    try {
      const request = requestOf(agent)
      const key = modelKey(request)
      const llm = service(agent, 'llm')
      const cache = cacheFor(llm)
      const cached = cache?.get(key)
      if (!signal?.aborted && request.provider && request.model && cache
        && (!cached || cached.until < Date.now())) {
        if (typeof llm?.resolveModelInfo === 'function') {
          const info = await llm.resolveModelInfo(request.provider, request.model, signal)
          if (!signal?.aborted) {
            if (cache.size >= 64) cache.delete(cache.keys().next().value!)
            cache.set(key, { info, until: Date.now() + 60000 })
          }
        }
      }
    } catch (error) {
      ctx.logger.warn('[context_compact] model budget lookup unavailable: %s', String(error))
    }
  }
  // No compaction/summary reset: thresholds describe CURRENT absolute occupancy,
  // not growth since the previous checkpoint. Small reductions must stay visible.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    disposers.push(systemPrompt.section({ name: 'tool:context_compact', order: 118, text: COMPACTION_GUIDANCE }))
    const renderNudge = () => {
        try {
          const agent = ctx.get('agents')?.currentInitiator?.() as AgentLike | undefined
          const session = agent?.session
          if (!agent || !session) return ''
          // Upgrade stale v3 sid caches before official pre-step can summarize,
          // even if this session never calls the new compaction tool.
          const engine = service(agent, 'compaction')
          if (engine) patchEngine(engine)
          const meter = service(agent, 'tokenMeter')
          let measurement: any
          try { measurement = meter?.measure?.(session) } catch { /* use projection fallback */ }
          let now = occupancyFromMeasurement(measurement)
          if (now === null) {
            try {
              const projection = ctx.get('sessionProjections')?.snapshot?.(session)?.values?.contextPressure
              now = projectedPressureFromRow(pressureRowFieldsOf(projection))
            } catch { /* optional fallback must not hide a healthy meter */ }
          }
          if (now === null) return ''
          const state: NudgeState & { routeKey?: string; llm?: unknown } = states.get(session)
            ?? { pressureActive: false, safetyActive: false }
          const request = requestOf(agent)
          const key = modelKey(request)
          const llm = service(agent, 'llm')
          if (state.routeKey !== key || state.llm !== llm) state.safetyActive = false
          state.routeKey = key
          state.llm = llm
          // Keep last known SAME-service/SAME-route metadata during an outage.
          // Refresh in the assembly hook; never borrow metadata from another scope.
          const info = cacheFor(llm)?.get(key)?.info
          const budget = automaticBudget(engine?.config, request, info, config)
          const mode = evaluateNudge(now, budget, state, config.volumeNudgeTokens)
          states.set(session, state)
          if (modes.get(session) !== mode) {
            ctx.logger.info('[context_compact] proactive v0.2.7 session=%s mode=%s pressure=%d limit=%s qualityThreshold=%d',
              session.id, mode, Math.round(now), budget?.threshold ?? 'unknown', config.volumeNudgeTokens)
            modes.set(session, mode)
          }
          if (mode === 'quiet') return ''
          const bands = ` Current request pressure ~${Math.ceil(now / 1000)}k tokens. Absolute context-quality maintenance at ${Math.floor(config.volumeNudgeTokens / 1000)}k; start only at this threshold and stop below it. No earlier quality reminder. This threshold does not increase for a larger context window.`
          const safety = budget ? ` Official fallback limit ~${Math.floor(budget.threshold / 1000)}k (secondary overflow protection only).` : ' Official fallback budget unavailable; the absolute quality threshold above still applies.'
          return '`context_compact` proactive maintenance [v0.2.7/' + mode + '].' + bands + safety
            + (budget && now >= budget.threshold ? ' The official fallback line has been reached; the host may already invoke emergency summarization. Do not assume another model step is guaranteed.'
              : mode === 'urgent' ? ' URGENT: create a safe checkpoint before optional new tools or large outputs; automatic full-history summarization is approaching.'
              : ' At the next safe boundary, prioritize checkpointing already-concluded sub-tasks before starting optional new work.')
            + ' This reminder persists until pressure is healthy; a partial compaction does not clear high-pressure maintenance. Compact eligible spans one sub-task at a time and re-check. Preserve exact requirements/corrections, paths/IDs, decisions, verified evidence, risks and next steps. Keep active/in-flight spans intact; unrelated running jobs do not block compressing other finished spans. If no safe useful span exists, keep it, explain the blocker, and avoid optional bulk reads. Never sacrifice required details just to reach the target.'
        } catch (error) {
          ctx.logger.warn('[context_compact] proactive measurement failed: %s', String(error))
          return ''
        }
    }
    disposers.push(systemPrompt.context({
      name: 'agent-compact:volume-nudge', order: 50, required: true, text: renderNudge,
    }))
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const agent = ctx.get('agents')?.currentInitiator?.() as AgentLike | undefined
      if (agent?.session) await prepareMetadata(agent, context?.signal)
      const assembly = await next()
      const text = renderNudge()
      const name = 'agent-compact:volume-nudge'
      // Only replace our own registered required context; keep other contributions.
      const contexts = assembly.contexts.filter((entry: { name: string }) => entry.name !== name)
      const originalIndex = assembly.contexts.findIndex((entry: { name: string }) => entry.name === name)
      contexts.splice(originalIndex < 0 ? 0 : originalIndex, 0, { name, text })
      return { ...assembly, contexts }
    }))
  }
  return () => { for (const dispose of disposers) dispose() }
}
