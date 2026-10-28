// Structural snapshot binding for one inspect -> one batch commit. Semantic
// completion is selected by the agent; no source-size or savings gate lives here.
import { createHash, randomUUID } from 'node:crypto'
import { activeCallPosition, seqRegion, selectionPrices } from './preflight.js'
import type { Cuts, Meter, Region } from './preflight.js'
import type { SurfaceNode } from './optimizer.js'

export interface BatchRange { startSeq: number; endSeq: number; summary: string }
export interface BatchSelection extends BatchRange { region: Region; digest: string; prices: string }
interface Scan { route: string; nodes: { seq: number; hash: string; tokens: number }[] }
function nodeHash(n: SurfaceNode) {
  return createHash('sha256').update(JSON.stringify([n.seq, n.type, n.data])).digest('hex')
}
function digest(hashes: string[]) { return createHash('sha256').update(hashes.join('\n')).digest('hex') }
export function batchFingerprint(nodes: SurfaceNode[], r: Region) {
  return digest(nodes.slice(r.si, r.ei + 1).map(nodeHash))
}
export class BatchScans {
  private readonly sessions = new WeakMap<object, Map<string, Scan>>()
  issue(session: object, nodes: SurfaceNode[], route: string, meter: Meter, callId: string) {
    let scans = this.sessions.get(session)
    if (!scans) { scans = new Map(); this.sessions.set(session, scans) }
    // Drafting a complete checkpoint may take arbitrarily long. Bound retained
    // snapshots by count, not elapsed time; resolve revalidates each selection.
    while (scans.size >= 2) scans.delete(scans.keys().next().value!)
    const prices = new Map(meter.measure(session).nodes.map(n => [n.seq, n.tokens]))
    const closed = nodes.slice(0, activeCallPosition(nodes, callId))
    const id = randomUUID()
    scans.set(id, { route,
      nodes: closed.map(n => ({ seq: n.seq, hash: nodeHash(n), tokens: prices.get(n.seq) ?? NaN })) })
    return id
  }
  resolve(session: object, id: string, nodes: SurfaceNode[], route: string, cuts: Cuts,
    meter: Meter, callId: string, ranges: unknown): BatchSelection[] {
    const scan = this.sessions.get(session)?.get(id)
    if (!scan || scan.route !== route) throw new Error('Scan missing, evicted or route changed; inspect once again before a new batch.')
    if (!Array.isArray(ranges) || !ranges.length || ranges.length > 200) throw new Error('Supply 1..200 selected ranges from the scan, each with a complete summary.')
    const positions = new Map(scan.nodes.map((n, i) => [n.seq, i]))
    const selections = ranges.map((value: unknown): BatchSelection => {
      if (!value || typeof value !== 'object') throw new Error('Each range needs startSeq, endSeq and summary.')
      const item = value as BatchRange
      if (typeof item.summary !== 'string' || !item.summary.trim()) throw new Error('Every selected range needs its complete Markdown summary; never omit required details.')
      const region = seqRegion(nodes, item.startSeq, item.endSeq, cuts, callId)
      const start = positions.get(item.startSeq), end = positions.get(item.endSeq)
      if (start === undefined || end === undefined || start > end) throw new Error('Selected boundary was not present in this scan; do not invent or guess IDs.')
      const original = scan.nodes.slice(start, end + 1)
      const prices = selectionPrices(nodes, region, meter, session)
      if (original.length !== prices.length || original.some((n, i) => n.seq !== prices[i].seq)) throw new Error('Selected scan range was replaced or is no longer contiguous; inspect again.')
      const hash = digest(original.map(n => n.hash))
      if (batchFingerprint(nodes, region) !== hash) throw new Error('Selected content changed since inspection; no batch mutation started.')
      return { startSeq: item.startSeq, endSeq: item.endSeq, summary: item.summary, region, digest: hash, prices: JSON.stringify(prices) }
    }).sort((a, b) => a.region.si - b.region.si)
    for (let i = 1; i < selections.length; i++) {
      if (selections[i].region.si <= selections[i - 1].region.ei) throw new Error('Batch ranges overlap or duplicate each other; choose disjoint ranges. Retained gaps are never auto-widened.')
    }
    return selections
  }
}
