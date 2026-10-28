// Read-only planning and value checks. A plan identifies a span, NEVER whether
// that span is semantically finished: the agent must still make that decision.
import { createHash, randomUUID } from 'node:crypto'
import { nodeContent, nodeFlatText } from './surface-text.js'
import type { SurfaceNode } from './optimizer.js'

export const MIN_SOURCE_TOKENS = 4096
export const MIN_NET_SAVINGS_TOKENS = 2048
export const CLEANUP_RESERVE_TOKENS = 512
// Mirrors rc.3 Basic's private frameSummary; tested against the installed engine.
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
export function checkpointMessage(summary: string) {
  return { role: 'user', content: [
    { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>' },
    { type: 'text', text: summary },
    { type: 'text', text: '</compacted-summary>' },
  ] }
}
export interface Meter {
  measure(session: any): { nodes: readonly { seq: number; tokens: number }[] }
  estimateMessage(message: any): number
}
export interface Cuts {
  before(seq: number): boolean
  after(seq: number): boolean
}
export interface Region { si: number; ei: number; startSeq: number; endSeq: number }
function integer(n: unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 }
function validPrice(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n) && n >= 0 }
function content(n: SurfaceNode): any[] { const c = nodeContent(n); return Array.isArray(c) ? c : [] }
export function messageText(n: SurfaceNode): string {
  // In contrast to archival text, anchors/previews NEVER include tool arguments or reasoning.
  return content(n).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}
export function pureCompactionCall(n: SurfaceNode): boolean {
  const blocks = content(n)
  return n.type === 'assistant/message' && blocks.length === 1 && blocks[0]?.type === 'tool-call' && blocks[0].name === 'context_compact'
}
function messageNode(n: SurfaceNode) {
  return n.type === 'tool/result' || ((n.type === 'user/message' || n.type === 'assistant/message') && !!messageText(n).trim())
}
export function activeCallPosition(nodes: SurfaceNode[], callId?: string): number {
  if (!callId) return nodes.length
  const i = nodes.findIndex(n => content(n).some(b => b?.type === 'tool-call' && b.id === callId))
  // No reliable active-call boundary => fail closed for explicit sequence plans.
  return i < 0 ? 0 : i
}
export function inspectSurface(nodes: SurfaceNode[], cuts: Cuts, meter: Meter, session: unknown, callId?: string, afterSeq = -1, limit = 16) {
  const prices = new Map(meter.measure(session).nodes.map(n => [n.seq, n.tokens]))
  const active = activeCallPosition(nodes, callId)
  // Replacements carry new seq IDs at old surface positions: sequence values are
  // identities, NOT monotonic positions. Continue after the actual cursor node.
  const cursor = afterSeq < 0 ? -1 : nodes.findIndex(n => n.seq === afterSeq)
  if (afterSeq >= 0 && cursor < 0) return { candidates: [], nextAfterSeq: null,
    note: 'Inspection cursor was replaced or is missing. Inspect again without afterSeq; never guess a new position.' }
  const rows = nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => i > cursor && i < active && messageNode(n))
  const picked = rows.slice(0, Math.min(24, Math.max(1, limit)))
  return {
    candidates: picked.map(({ n }) => ({ seq: n.seq, type: String(n.type),
      preview: (n.type === 'tool/result' ? nodeFlatText(n, { skipReasoning: true, dropImages: true }) : messageText(n)).slice(0, 240), tokens: prices.get(n.seq) ?? null,
      canStart: cuts.before(n.seq), canEnd: cuts.after(n.seq) })),
    nextAfterSeq: rows.length > picked.length ? picked.at(-1)!.n.seq : null,
    note: 'These are boundary candidates, not automatically safe sub-tasks. Select one substantial, fully concluded task; preserve necessary detail and active work. Use explicit startSeq/endSeq with action=prepare; do not guess anchors or select the current tool-call message.',
  }
}
export function seqRegion(nodes: SurfaceNode[], start: unknown, end: unknown, cuts: Cuts, callId?: string): Region {
  if (!integer(start) || !integer(end)) throw new Error('Both startSeq and endSeq must be explicit non-negative integer message IDs from inspect.')
  const si = nodes.findIndex(n => n.seq === start), ei = nodes.findIndex(n => n.seq === end)
  if (si < 0 || ei < 0) throw new Error('Selected boundary no longer exists; inspect the current surface again.')
  if (si > ei) throw new Error('Selected start is after end; choose the intended ordered range.')
  if (ei >= activeCallPosition(nodes, callId)) throw new Error('The current tool-call message or its active tail cannot be compressed. Select an earlier closed message.')
  if (!messageNode(nodes[si]) || !messageNode(nodes[ei])) throw new Error('Explicit boundaries must be text messages or closed tool results from inspect, not tool arguments or reasoning.')
  if (!cuts.before(start) || !cuts.after(end)) throw new Error('Selected boundaries split an open tool-call/result step. Inspect canStart/canEnd and select a closed boundary; do not auto-widen the span.')
  return { si, ei, startSeq: start, endSeq: end }
}
export function fingerprint(nodes: SurfaceNode[], r: Region): string {
  return createHash('sha256').update(JSON.stringify(nodes.slice(r.si, r.ei + 1).map(n => [n.seq, n.type, n.data]))).digest('hex')
}
export function selectionPrices(nodes: SurfaceNode[], r: Region, meter: Meter, session: unknown) {
  const measured = meter.measure(session).nodes
  const si = measured.findIndex(n => n.seq === r.startSeq)
  const selection = measured.slice(si, si + r.ei - r.si + 1)
  if (si < 0 || selection.length !== r.ei - r.si + 1 || selection.some((n, i) => n.seq !== nodes[r.si + i].seq || !validPrice(n.tokens))) {
    throw new Error('Token measurement and selected surface disagree; inspect again before compacting.')
  }
  return selection.map(n => ({ seq: n.seq, tokens: n.tokens }))
}
export function sourcePrice(nodes: SurfaceNode[], r: Region, meter: Meter, session: unknown): number {
  return selectionPrices(nodes, r, meter, session).reduce((sum, n) => sum + n.tokens, 0)
}
export function benefit(sourceTokens: number, summary: string | undefined, meter: Meter,
  minSource = MIN_SOURCE_TOKENS, minNet = MIN_NET_SAVINGS_TOKENS, extraOverhead = 0) {
  const checkpointTokens = summary === undefined ? null : meter.estimateMessage(checkpointMessage(summary))
  if (checkpointTokens !== null && !validPrice(checkpointTokens)) throw new Error('Invalid checkpoint token estimate; refusing mutation.')
  const overheadTokens = CLEANUP_RESERVE_TOKENS + extraOverhead
  const estimatedNetSavings = checkpointTokens === null ? null : sourceTokens - checkpointTokens - overheadTokens
  const useful = sourceTokens >= minSource && (estimatedNetSavings === null || estimatedNetSavings >= minNet)
  return { useful, sourceTokens, checkpointTokens, overheadTokens, estimatedNetSavings,
    maxCheckpointTokens: Math.max(0, Math.floor(sourceTokens - overheadTokens - minNet)),
    minSourceTokens: minSource, minNetSavingsTokens: minNet,
    accounting: 'Route-priced estimates, not exact future provider usage. Checkpoint framing and cleanup reserve included; read/prepare traffic is not claimed as savings.',
    reason: useful ? 'Substantial span; preserve all required details in the checkpoint.' : 'Low-value range: leave this small span intact. Choose another substantial completed task; do not trim required information or combine unrelated/live work merely to pass the minimum.' }
}
interface Plan extends Region { hash: string; until: number; route: string; prices: string }
export class CompactionPlans {
  private readonly sessions = new WeakMap<object, Map<string, Plan>>()
  constructor(private readonly clock = Date.now) {}
  issue(session: object, nodes: SurfaceNode[], r: Region, route: string, prices: unknown): string {
    let plans = this.sessions.get(session)
    if (!plans) { plans = new Map(); this.sessions.set(session, plans) }
    for (const [id, p] of plans) if (p.until <= this.clock()) plans.delete(id)
    while (plans.size >= 4) plans.delete(plans.keys().next().value!)
    const id = randomUUID()
    plans.set(id, { ...r, hash: fingerprint(nodes, r), route, prices: JSON.stringify(prices), until: this.clock() + 10 * 60 * 1000 })
    return id
  }
  resolve(session: object, id: string, nodes: SurfaceNode[], route: string, cuts: Cuts, pricesOf: (r: Region) => unknown, callId?: string): Region {
    const p = this.sessions.get(session)?.get(id)
    if (!p || p.until <= this.clock() || p.route !== route) throw new Error('Missing, expired or route-changed plan; inspect/prepare again.')
    const r = seqRegion(nodes, p.startSeq, p.endSeq, cuts, callId)
    if (fingerprint(nodes, r) !== p.hash || JSON.stringify(pricesOf(r)) !== p.prices) throw new Error('Prepared span content or pricing changed, or was compressed already; inspect/prepare again.')
    return r
  }
  consume(session: object, id: string) { this.sessions.get(session)?.delete(id) }
}
