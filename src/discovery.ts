// Read-only discovery, not semantic span selection. Batch exposes every primary
// semantic landmark up to an explicit cap; legacy overview remains navigation only.
import type { SurfaceNode } from './optimizer.js'
import type { Cuts, Meter } from './preflight.js'
import { activeCallPosition, messageText } from './preflight.js'
import { blocksText, nodeContent, nodeFlatText } from './surface-text.js'

export interface DiscoveryOptions {
  mode?: 'batch' | 'overview' | 'search' | 'detail'
  /** Batch semantic landmarks: 1..200 (default 200); legacy groups/rows: 1..24. */
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
const NOTE = 'Structural boundary flags do not establish semantic completion. Overview ranges are navigation bounds, NOT selected compaction spans. Preserve opening requirements/corrections and live work. Never select the current tool-call or its active tail.'
const BATCH_NOTE = 'Ranges are structurally closed navigation units, NOT automatically completed tasks. All primary semantic landmarks are listed in surface order unless coverage reports an explicit cap; no sampling or minimum source/net filter is applied. Choose only semantically concluded ranges (or combine disclosed start/end boundaries), preserve opening requirements and in-flight work, then submit the chosen ranges together with their individual summaries in one compact call using the scanId supplied by the caller. Tool-step boundaries are disclosed identities, never arithmetic guesses; automatic boundary hints do not authorize widening a selection. Auxiliary snapshots and unpreviewed tool results remain accessible through detail/search; their counts and omitted coverage are explicit.'

// Match only well-known generated envelopes, never a generic mention of memory,
// time or compaction in a real user task. Full content remains searchable.
function auxiliary(r: Row): boolean {
  const prose = r.prose.trimStart()
  return /^(?:Current runtime context\.|Time sampled while preparing turn\b|(?:#{1,6}\s*)?\[?MNEMON RUNTIME MEMORY SNAPSHOT\b|<mnemon-runtime-memory\b|<runtime-context\b|`context_compact` proactive maintenance \[v)/i.test(prose)
    || /^<system-reminder>\s*(?:Current runtime context\.|Time sampled while preparing turn\b|The following workspace instructions\b|A skill is a reusable\b|(?:MNEMON )?RUNTIME MEMORY SNAPSHOT\b|Context (?:pressure|maintenance)\b|`context_compact` proactive maintenance \[v)/i.test(prose)
}
function boundaryNode(n: SurfaceNode, start: boolean): boolean {
  if (n.type === 'tool/result') return true
  if (n.type !== 'user/message' && n.type !== 'assistant/message') return false
  return !!messageText(n).trim() || (start && n.type === 'assistant/message'
    && Array.isArray(nodeContent(n)) && (nodeContent(n) as any[]).some(b => b?.type === 'tool-call'))
}

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
  const mode = options.mode ?? (options.query !== undefined ? 'search' : options.startSeq !== undefined || options.endSeq !== undefined ? 'detail' : 'batch')
  if (!['batch', 'overview', 'search', 'detail'].includes(mode)) throw new Error('Unknown discovery mode; use batch, overview, search or detail.')
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
    // A focused tool-result hit must disclose its call-step identities as well:
    // seq values can be nonmonotonic, so callers must never guess `seq - 1`.
    let step: { startSeq: number | null; endSeq: number | null; boundaryExpanded: boolean } | undefined
    if (r.kind === 'tool-result' && (mode === 'search' || mode === 'detail')) {
      let s = r.i, e = r.i
      while (s >= 0 && !(boundaryNode(nodes[s], true) && cuts.before(nodes[s].seq))) s--
      while (e < active && !(boundaryNode(nodes[e], false) && cuts.after(nodes[e].seq))) e++
      step = { startSeq: s < 0 ? null : nodes[s].seq, endSeq: e >= active ? null : nodes[e].seq,
        boundaryExpanded: s !== r.i || e !== r.i }
    }
    return { seq: r.n.seq, type: String(r.n.type), kind: r.kind,
      preview: raw.slice(offset, offset + 240), previewOffset: offset,
      previewTruncated: offset > 0 || raw.length > offset + 240,
      tokens: prices.get(r.n.seq) ?? null, canStart: cuts.before(r.n.seq), canEnd: cuts.after(r.n.seq), ...step }
  }
  if (mode === 'batch') {
    if (options.startSeq !== undefined || options.endSeq !== undefined || options.afterSeq !== undefined) {
      throw new Error('Batch discovery scans the whole closed surface; use detail/search for focused navigation.')
    }
    const cap = typeof options.limit === 'number' && Number.isSafeInteger(options.limit)
      ? Math.max(1, Math.min(200, options.limit)) : 200
    const auxiliaryRows = allRows.filter(r => r.kind !== 'tool-result' && auxiliary(r))
    const primary = allRows.filter(r => r.kind !== 'tool-result' && !auxiliary(r))
    // Tool-only histories still expose receipts, rather than silently returning an
    // empty complete scan. Otherwise tools cannot crowd out later prose tasks.
    const semantic = primary.length ? primary : allRows.filter(r => r.kind === 'tool-result')
    const picked = semantic.slice(0, cap)
    const before = new Array<boolean>(active).fill(false), after = new Array<boolean>(active).fill(false)
    const startAt = new Array<number>(active).fill(-1), endAt = new Array<number>(active).fill(-1)
    const tokenPrefix = [0], missingPrefix = [0], toolPrefix = [0]
    let lastStart = -1
    // Official cut predicates are cached by the engine. Evaluate each closed
    // boundary once, never rescan the surface for each hidden tool-noise row.
    for (let i = 0; i < active; i++) {
      before[i] = boundaryNode(nodes[i], true) && cuts.before(nodes[i].seq)
      after[i] = boundaryNode(nodes[i], false) && cuts.after(nodes[i].seq)
      if (before[i]) lastStart = i
      startAt[i] = lastStart
      const price = prices.get(nodes[i].seq)
      const valid = typeof price === 'number' && Number.isFinite(price) && price >= 0
      tokenPrefix.push(tokenPrefix[i] + (valid ? price : 0))
      missingPrefix.push(missingPrefix[i] + (valid ? 0 : 1))
      toolPrefix.push(toolPrefix[i] + (nodes[i].type === 'tool/result' ? 1 : 0))
    }
    let nextEnd = -1
    for (let i = active - 1; i >= 0; i--) {
      if (after[i]) nextEnd = i
      endAt[i] = nextEnd
    }
    const tokens = (s: number, e: number) => missingPrefix[e + 1] === missingPrefix[s]
      ? tokenPrefix[e + 1] - tokenPrefix[s] : null
    const landmarks = picked.map(r => {
      const c = candidate(r), s = startAt[r.i], e = endAt[r.i]
      return { ...c, canStart: before[r.i], canEnd: after[r.i],
        tailPreview: r.prose.length > 240 ? r.prose.slice(-120) : null,
        startSeq: s < 0 ? null : nodes[s].seq, endSeq: e < 0 ? null : nodes[e].seq,
        sourceTokens: s < 0 || e < 0 ? null : tokens(s, e),
        boundaryExpanded: s !== r.i || e !== r.i }
    })
    // Adjacent semantic starts define navigable atomic units, not task decisions.
    // Use ALL semantic starts before capping output, so a hidden next topic never
    // gets silently swallowed into the last returned range.
    const starts = [...new Set(semantic.map(r => startAt[r.i]).filter(i => i >= 0))]
    const firstStart = before.findIndex(Boolean)
    if (firstStart >= 0 && (starts.length === 0 || firstStart < starts[0])) starts.unshift(firstStart)
    const lastEnds = new Array<number>(active).fill(-1)
    let lastEnd = -1
    for (let i = 0; i < active; i++) { if (after[i]) lastEnd = i; lastEnds[i] = lastEnd }
    const ranges: { startSeq: number; endSeq: number; sourceTokens: number | null; nodeCount: number;
      toolResultCount: number; landmarkSeqs: number[]; containsOpening: boolean }[] = []
    let rowIndex = 0, legalRangeCount = 0
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k], bound = (starts[k + 1] ?? active) - 1, e = lastEnds[bound]
      if (e < s) continue
      legalRangeCount++
      if (ranges.length >= cap) continue
      while (rowIndex < semantic.length && semantic[rowIndex].i < s) rowIndex++
      const seqs: number[] = []
      while (rowIndex < semantic.length && semantic[rowIndex].i <= e) {
        if (rowIndex < cap) seqs.push(semantic[rowIndex].n.seq)
        rowIndex++
      }
      ranges.push({ startSeq: nodes[s].seq, endSeq: nodes[e].seq, sourceTokens: tokens(s, e),
        nodeCount: e - s + 1, toolResultCount: toolPrefix[e + 1] - toolPrefix[s],
        landmarkSeqs: seqs, containsOpening: s === 0 })
    }
    const omitted = semantic.length - landmarks.length
    return { mode, surface: { ...surface, primarySemanticCount: semantic.length, auxiliaryCount: auxiliaryRows.length },
      groups: [], candidates: [], landmarks, ranges, nextAfterSeq: null,
      auxiliaryNavigation: auxiliaryRows.length ? { mode: 'detail', startSeq: auxiliaryRows[0].n.seq,
        endSeq: auxiliaryRows.at(-1)!.n.seq, count: auxiliaryRows.length } : null,
      coverage: { scannedNodes: active, matchingCandidates: allRows.length, returnedCandidates: landmarks.length,
        omittedCandidates: allRows.length - landmarks.length, semanticLandmarkLimit: cap,
        semanticLandmarks: semantic.length, returnedSemanticLandmarks: landmarks.length,
        omittedSemanticLandmarks: omitted, semanticComplete: omitted === 0,
        unclosedSemanticLandmarks: semantic.filter(r => startAt[r.i] < 0 || endAt[r.i] < 0).length,
        legalRangeCount, omittedRanges: legalRangeCount - ranges.length,
        omittedToolResults: surface.toolResultCount - landmarks.filter(r => r.kind === 'tool-result').length,
        omittedAuxiliary: auxiliaryRows.length,
        complete: omitted === 0 && allRows.length === landmarks.length && legalRangeCount === ranges.length,
        firstOmittedSeq: semantic[cap]?.n.seq ?? null,
        continuation: omitted ? { mode: 'detail', startSeq: semantic[cap].n.seq, endSeq: semantic.at(-1)!.n.seq } : null },
      note: BATCH_NOTE }
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
