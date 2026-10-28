// Read-only discovery, not semantic span selection. Overview samples landmarks
// across the entire closed surface; every omitted row remains reachable in detail.
import type { SurfaceNode } from './optimizer.js'
import type { Cuts, Meter } from './preflight.js'
import { activeCallPosition, messageText } from './preflight.js'
import { blocksText, nodeContent, nodeFlatText } from './surface-text.js'

export interface DiscoveryOptions {
  mode?: 'overview' | 'search' | 'detail'
  /** Number of overview groups or detail/search rows, bounded to 1..24. */
  limit?: number
  /** Literal, case-insensitive text search. Never searches arguments/reasoning. */
  query?: string
  /** Inclusive focus endpoints are surface identities, not numeric seq ranges. */
  startSeq?: number
  endSeq?: number
  /** Search/detail pagination, following surface order rather than seq order. */
  afterSeq?: number
}

interface Row { n: SurfaceNode; i: number; kind: 'user' | 'assistant-text' | 'tool-result'; prose: string }
const NOTE = 'Structural boundary flags do not establish semantic completion. Overview ranges are navigation bounds, NOT selected compaction spans. Inspect focused detail/search for omitted messages; select ONE substantial fully concluded task yourself, preserve requirements/corrections and live work, then prepare explicit startSeq/endSeq. Never select the current tool-call or its active tail.'

function rowsOf(nodes: SurfaceNode[], start: number, end: number): Row[] {
  const rows: Row[] = []
  for (let i = start; i <= end; i++) {
    const n = nodes[i]
    if (n.type === 'tool/result') { rows.push({ n, i, kind: 'tool-result', prose: '' }); continue }
    if (n.type !== 'user/message' && n.type !== 'assistant/message') continue
    const prose = messageText(n)
    if (!prose.trim()) continue
    // Mixed prose+call nodes stay available in detail, but are not receipt-like
    // overview landmarks. Their cut flags still come from the official engine.
    rows.push({ n, i, kind: n.type === 'user/message' ? 'user' : 'assistant-text', prose })
  }
  return rows
}
function landmark(r: Row): boolean {
  return r.kind !== 'tool-result' && !(nodeContent(r.n) as any[] | null)?.some(b => b?.type === 'tool-call')
}
function limitOf(n: number | undefined): number {
  return typeof n === 'number' && Number.isSafeInteger(n) ? Math.min(24, Math.max(1, n)) : 12
}
function validSeq(n: unknown): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 }

/** Discovery never changes nodes, guesses IDs or pairs rows into completed tasks. */
export function discoverSurface(nodes: SurfaceNode[], cuts: Cuts, meter: Meter, session: unknown,
  callId?: string, options: DiscoveryOptions = {}) {
  const mode = options.mode ?? (options.query !== undefined ? 'search' : options.startSeq !== undefined || options.endSeq !== undefined ? 'detail' : 'overview')
  if (!['overview', 'search', 'detail'].includes(mode)) throw new Error('Unknown discovery mode; use overview, search or detail.')
  // Unlike a historical helper with no active identity, discovery must fail closed:
  // a default inspect must never accidentally reveal the current call as a cut.
  const active = callId ? activeCallPosition(nodes, callId) : 0
  const closed = nodes.slice(0, active)
  const allRows = rowsOf(nodes, 0, active - 1)
  const semanticRows = allRows.filter(landmark)
  const limit = limitOf(options.limit)
  const prices = new Map(meter.measure(session).nodes.map(n => [n.seq, n.tokens]))
  const surface = { nodeCount: closed.length, candidateCount: allRows.length, semanticCount: semanticRows.length,
    toolResultCount: allRows.filter(r => r.kind === 'tool-result').length,
    firstSeq: closed[0]?.seq ?? null, lastSeq: closed.at(-1)?.seq ?? null, excludedActiveTail: nodes.length - active }
  const candidate = (r: Row, query?: string) => {
    const raw = r.kind === 'tool-result'
      ? query ? nodeFlatText(r.n, { skipReasoning: true, dropImages: true }) : blocksText(nodeContent(r.n), 0, { skipReasoning: true, dropImages: true }, 241).text.trimEnd()
      : r.prose
    const hit = query ? raw.toLowerCase().indexOf(query.toLowerCase()) : -1
    const offset = hit > 80 ? hit - 80 : 0
    return { seq: r.n.seq, type: String(r.n.type), kind: r.kind,
      preview: raw.slice(offset, offset + 240), previewOffset: offset,
      previewTruncated: offset > 0 || raw.length > offset + 240,
      tokens: prices.get(r.n.seq) ?? null, canStart: cuts.before(r.n.seq), canEnd: cuts.after(r.n.seq) }
  }
  if (mode === 'overview') {
    // Split by landmark positions rather than tool-result volume, so a long tool
    // operation cannot consume every overview slot. The partitions still cover
    // every closed node (including unshown tool noise) exactly once.
    const anchors = semanticRows.length ? semanticRows : allRows
    const count = Math.min(limit, anchors.length)
    const groups = Array.from({ length: count }, (_, k) => {
      const from = Math.floor(k * anchors.length / count)
      const to = Math.floor((k + 1) * anchors.length / count)
      const start = k === 0 ? 0 : anchors[from].i
      const end = k + 1 === count ? active - 1 : anchors[to].i - 1
      const rows = allRows.filter(r => r.i >= start && r.i <= end)
      const semantic = rows.filter(landmark)
      const first = semantic.find(r => r.kind === 'user') ?? semantic[0] ?? rows[0]
      const last = semantic.filter(r => r.kind === 'assistant-text').at(-1) ?? semantic.at(-1) ?? rows.at(-1)
      const picked = [first, last].filter((r, i, list): r is Row => !!r && list.indexOf(r) === i).sort((a, b) => a.i - b.i)
      return { rangeStartSeq: nodes[start].seq, rangeEndSeq: nodes[end].seq,
        nodeCount: end - start + 1, candidateCount: rows.length, semanticCount: semantic.length,
        toolResultCount: rows.filter(r => r.kind === 'tool-result').length,
        omittedCandidates: rows.length - picked.length, candidates: picked.map(r => candidate(r)) }
    })
    const returned = groups.reduce((n, g) => n + g.candidates.length, 0)
    return { mode, surface, groups, candidates: [], nextAfterSeq: null,
      coverage: { scannedNodes: active, matchingCandidates: allRows.length, returnedCandidates: returned,
        omittedCandidates: allRows.length - returned, complete: returned === allRows.length }, note: NOTE }
  }
  let start = 0, end = active - 1
  if (options.startSeq !== undefined || options.endSeq !== undefined) {
    if (!validSeq(options.startSeq) || !validSeq(options.endSeq)) throw new Error('Focused discovery requires both explicit startSeq and endSeq IDs.')
    start = nodes.findIndex(n => n.seq === options.startSeq)
    end = nodes.findIndex(n => n.seq === options.endSeq)
    if (start < 0 || end < 0) throw new Error('Discovery range was replaced or is missing; inspect overview again. Never guess replacement IDs.')
    if (start > end) throw new Error('Discovery start is after end in surface order.')
    if (end >= active) throw new Error('Discovery range includes the current tool-call or active tail; choose closed surface IDs.')
  }
  let cursor = start - 1
  if (options.afterSeq !== undefined && options.afterSeq !== -1) {
    if (!validSeq(options.afterSeq)) throw new Error('Discovery cursor must be an explicit non-negative integer seq ID.')
    cursor = nodes.findIndex(n => n.seq === options.afterSeq)
    if (cursor < start || cursor > end) throw new Error('Discovery cursor was replaced, missing or outside the focused range; inspect again without afterSeq.')
  }
  if (mode === 'search' && (typeof options.query !== 'string' || !options.query.trim())) throw new Error('Search requires a non-empty literal query.')
  const query = mode === 'search' ? options.query! : undefined
  const rows = allRows.filter(r => r.i >= start && r.i <= end && (!query ||
    (r.kind === 'tool-result' ? nodeFlatText(r.n, { skipReasoning: true, dropImages: true }) : r.prose).toLowerCase().includes(query.toLowerCase())))
  const remaining = rows.filter(r => r.i > cursor)
  const picked = remaining.slice(0, limit)
  return { mode, surface, groups: [], candidates: picked.map(r => candidate(r, query)),
    nextAfterSeq: remaining.length > picked.length ? picked.at(-1)!.n.seq : null,
    coverage: { scannedNodes: Math.max(0, end - start + 1), matchingCandidates: rows.length,
      returnedCandidates: picked.length, omittedCandidates: rows.length - picked.length,
      remainingCandidates: remaining.length - picked.length, complete: rows.length === picked.length }, note: NOTE }
}
