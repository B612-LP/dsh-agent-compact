import test from 'node:test'
import assert from 'node:assert/strict'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import { discoverSurface } from '../lib/discovery.js'
import { inspectSurface, seqRegion } from '../lib/preflight.js'

const text = text => ({ type: 'text', text })
const user = (seq, prose) => ({ seq, type: 'user/message', data: { content: [text(prose)] } })
const assistant = (seq, blocks) => ({ seq, type: 'assistant/message', data: { message: { content: blocks } } })
const call = (seq, id = 'active') => assistant(seq, [{ type: 'tool-call', name: 'context_compact', id, arguments: 'private arguments' }])
const result = (seq, prose) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [text(prose)] }] } } })
function fixture(nodes) {
  const bySeq = new Map(nodes.map(n => [n.seq, n]))
  const session = { surface: { nodes: nodes.map(n => n.seq), replaceGeneration: 0 }, eventAt: seq => bySeq.get(seq) }
  const meter = { measure: () => ({ nodes: nodes.map(n => ({ seq: n.seq, tokens: 100 })) }) }
  const cuts = { before: seq => toolPairingBalancedBefore(session, seq), after: seq => toolPairingBalancedAfter(session, seq) }
  return { session, meter, cuts, discover: (options, callId = 'active') => discoverSurface(nodes, cuts, meter, session, callId, options) }
}

test('legacy overview reaches the entire closed surface despite thousands of tool-result previews', () => {
  const nodes = [user(1, 'opening requirements')]
  let seq = 2
  for (let topic = 0; topic < 30; topic++) {
    nodes.push(user(seq++, `topic ${topic}: exact user correction`))
    for (let t = 0; t < 80; t++) nodes.push(call(seq++, `tool-${topic}-${t}`), result(seq++, `tool noise ${topic}/${t}`))
    nodes.push(assistant(seq++, [text(`receipt ${topic}: evidence and remaining risk`)]))
  }
  nodes.push(call(seq++), user(seq++, 'later inbox must stay hidden'))
  const f = fixture(nodes), got = f.discover({ mode: 'overview' })
  assert.equal(got.mode, 'overview')
  assert.equal(got.groups.length, 12)
  assert.equal(got.groups[0].rangeStartSeq, 1)
  assert.equal(got.groups.at(-1).rangeEndSeq, nodes.at(-3).seq)
  assert.equal(got.surface.nodeCount, nodes.length - 2)
  assert.equal(got.surface.toolResultCount, 2400)
  assert.equal(got.surface.excludedActiveTail, 2)
  assert.equal(got.coverage.scannedNodes, nodes.length - 2)
  assert.equal(got.coverage.complete, false)
  assert.equal(got.groups.reduce((sum, g) => sum + g.nodeCount, 0), nodes.length - 2)
  const shown = got.groups.flatMap(g => g.candidates)
  assert.ok(shown.length <= 24)
  assert.ok(shown.every(c => c.type !== 'tool/result'))
  assert.ok(shown.some(c => c.preview.includes('receipt 29')))
  assert.ok(shown.every(c => typeof c.canStart === 'boolean' && typeof c.canEnd === 'boolean'))
  assert.match(got.note, /NOT selected compaction spans/)
  // Every partition is navigable; hidden rows are still present, in original order.
  for (const g of got.groups) {
    let afterSeq, found = []
    do {
      const page = f.discover({ mode: 'detail', startSeq: g.rangeStartSeq, endSeq: g.rangeEndSeq, afterSeq, limit: 24 })
      found.push(...page.candidates.map(c => c.seq)); afterSeq = page.nextAfterSeq
    } while (afterSeq !== null)
    assert.equal(found.length, g.candidateCount)
    assert.equal(new Set(found).size, found.length)
  }
})

test('overview bounds output and previews independently of history size and limit input', () => {
  const nodes = Array.from({ length: 100 }, (_, i) => user(i + 1, `topic ${i} ` + 'x'.repeat(1000)))
  nodes.push(call(101))
  const f = fixture(nodes)
  for (const limit of [0, 1, 7, 24, 900, NaN, Infinity, 1.5]) {
    const got = f.discover({ mode: 'overview', limit })
    assert.ok(got.groups.length <= 24 && got.groups.length >= 1)
    assert.ok(got.groups.every(g => g.candidates.length <= 2))
    assert.ok(got.groups.flatMap(g => g.candidates).every(c => c.preview.length <= 240 && c.previewTruncated))
  }
})

test('search uses full text and excerpts late matches, including omitted tool results', () => {
  const nodes = [user(90, 'retained replacement checkpoint'), call(1, 'prior'), result(2, 'x'.repeat(1000) + ' NeedLE exact evidence'),
    assistant(3, [{ type: 'reasoning', text: 'hiddenneedle' }, text('receipt'), { type: 'tool-call', id: 'a', arguments: 'hiddenneedle' }]),
    result(4, 'later NEEDLE'), call(91)]
  const f = fixture(nodes)
  const first = f.discover({ query: 'needle', limit: 1 })
  assert.equal(first.mode, 'search')
  assert.deepEqual(first.candidates.map(c => c.seq), [2])
  assert.equal(first.candidates[0].startSeq, 1)
  assert.equal(first.candidates[0].endSeq, 2)
  assert.equal(first.candidates[0].boundaryExpanded, true)
  assert.match(first.candidates[0].preview, /NeedLE/)
  assert.ok(first.candidates[0].previewOffset > 0)
  assert.equal(first.nextAfterSeq, 2)
  assert.deepEqual(f.discover({ mode: 'search', query: 'needle', afterSeq: 2 }).candidates.map(c => c.seq), [4])
  assert.deepEqual(f.discover({ query: 'hiddenneedle' }).candidates, [])
  assert.deepEqual(f.discover({ query: '.*' }).candidates, []) // literal, not regexp
})

test('focused detail follows nonmonotonic seq surface order and legacy pagination remains unchanged', () => {
  const nodes = [user(100, 'replacement'), user(20, 'old A'), call(19, 'prior'), result(21, 'tool B'), assistant(22, [text('receipt C')]), call(101)]
  const f = fixture(nodes)
  const page = f.discover({ mode: 'detail', startSeq: 100, endSeq: 22, limit: 1 })
  assert.deepEqual(page.candidates.map(c => c.seq), [100])
  assert.equal(page.nextAfterSeq, 100)
  assert.deepEqual(f.discover({ mode: 'detail', startSeq: 100, endSeq: 22, afterSeq: 100 }).candidates.map(c => c.seq), [20, 21, 22])
  assert.deepEqual(inspectSurface(nodes, f.cuts, f.meter, f.session, 'active', 100, 24).candidates.map(c => c.seq), [20, 21, 22])
  assert.throws(() => f.discover({ mode: 'detail', startSeq: 22, endSeq: 20 }), /after end/)
  assert.throws(() => f.discover({ mode: 'detail', startSeq: 100, endSeq: 999 }), /replaced or is missing/)
  assert.throws(() => f.discover({ mode: 'detail', startSeq: 100 }), /both explicit/)
  assert.throws(() => f.discover({ mode: 'detail', afterSeq: 999 }), /cursor.*missing/)
  assert.throws(() => f.discover({ mode: 'detail', startSeq: 20, endSeq: 22, afterSeq: 100 }), /outside/)
})

test('active identity is mandatory and no discovery mode includes active call or inbox tail', () => {
  const nodes = [user(1, 'closed'), call(2), user(3, 'inbox secret')]
  const f = fixture(nodes)
  for (const mode of ['batch', 'overview', 'detail', 'search']) {
    const got = f.discover({ mode, query: 'secret' })
    assert.equal(got.surface.nodeCount, 1)
    assert.ok(!JSON.stringify(got.groups).includes('secret'))
    assert.ok(!JSON.stringify(got.candidates).includes('secret'))
  }
  assert.equal(f.discover({}, 'missing').surface.nodeCount, 0)
  assert.equal(discoverSurface(nodes, f.cuts, f.meter, f.session).surface.nodeCount, 0)
  assert.throws(() => f.discover({ mode: 'detail', startSeq: 1, endSeq: 2 }), /current tool-call/)
  assert.throws(() => f.discover({ mode: 'search', query: '  ' }), /non-empty/)
})

test('overview cut flags come from official pairing; receipts do not certify concluded tasks', () => {
  const nodes = [user(1, 'topic'), assistant(2, [{ type: 'tool-call', id: 'a' }, { type: 'tool-call', id: 'b' }]),
    result(3, 'first result'), user(4, 'correction between pending results'), assistant(5, [text('not necessarily complete')]), call(6)]
  const f = fixture(nodes), got = f.discover({ mode: 'overview', limit: 1 })
  for (const c of got.groups.flatMap(g => g.candidates)) {
    assert.equal(c.canStart, f.cuts.before(c.seq)); assert.equal(c.canEnd, f.cuts.after(c.seq))
  }
  assert.throws(() => seqRegion(nodes, 1, 5, f.cuts, 'active'), /open tool-call/)
  assert.match(got.note, /do not establish semantic completion/)
})

test('tool-only and empty closed surfaces remain navigable without invented message IDs', () => {
  const nodes = [call(89, 'prior'), result(90, 'receipt from a closed tool'), call(1, 'other'), result(2, 'next result'), call(91)]
  const got = fixture(nodes).discover({ mode: 'overview', limit: 1 })
  assert.deepEqual(got.groups[0].candidates.map(c => c.seq), [90, 2])
  assert.equal(got.groups[0].rangeStartSeq, 89)
  assert.equal(got.groups[0].rangeEndSeq, 2)
  assert.deepEqual(fixture([call(1)]).discover().groups, [])
})

test('legacy overview evaluates cut predicates only for returned previews, not every hidden tool result', () => {
  const nodes = [user(1, 'topic'), ...Array.from({ length: 2000 }, (_, i) => result(i + 2, 'noise')), assistant(2002, [text('receipt')]), call(2003)]
  let reads = 0
  const cuts = { before: () => { reads++; return true }, after: () => { reads++; return true } }
  const meter = { measure: () => ({ nodes: [] }) }
  const got = discoverSurface(nodes, cuts, meter, {}, 'active', { mode: 'overview', limit: 1 })
  assert.equal(reads, got.groups[0].candidates.length * 2)
  assert.equal(reads, 4)
})

test('default batch reveals every middle task and receipt despite thousands of hidden tool rows', () => {
  const nodes = [user(1, 'opening requirements')]
  let seq = 2
  for (let topic = 0; topic < 30; topic++) {
    nodes.push(user(seq++, `topic ${topic}: exact user correction`))
    for (let t = 0; t < 80; t++) nodes.push(call(seq++, `noise-${topic}-${t}`), result(seq++, `noise ${topic}/${t}`))
    nodes.push(assistant(seq++, [text(`receipt ${topic}: verified evidence and remaining risk`)]))
  }
  nodes.push(call(seq++), user(seq++, 'inbox secret'))
  const got = fixture(nodes).discover()
  assert.equal(got.mode, 'batch')
  assert.equal(got.landmarks.length, 61)
  assert.equal(got.coverage.semanticComplete, true)
  assert.equal(got.coverage.omittedSemanticLandmarks, 0)
  assert.equal(got.coverage.omittedToolResults, 2400)
  assert.equal(got.coverage.complete, false) // Never claim omitted tool evidence was shown.
  for (let topic = 0; topic < 30; topic++) {
    assert.ok(got.landmarks.some(r => r.preview.startsWith(`topic ${topic}:`)))
    assert.ok(got.landmarks.some(r => r.preview.startsWith(`receipt ${topic}:`)))
  }
  assert.equal(got.ranges.reduce((n, r) => n + r.nodeCount, 0), nodes.length - 2)
  assert.equal(got.ranges.reduce((n, r) => n + r.sourceTokens, 0), (nodes.length - 2) * 100)
  assert.equal(got.ranges[0].containsOpening, true)
  assert.ok(!JSON.stringify(got).includes('inbox secret'))
  assert.match(got.note, /NOT automatically completed tasks/)
  assert.match(got.note, /no sampling or minimum source\/net filter/)
})

test('batch does not sample beyond its cap or silently swallow unshown topics into ranges', () => {
  const nodes = Array.from({ length: 450 }, (_, i) => user(i + 1, `topic ${i}`))
  nodes.push(call(451))
  const got = fixture(nodes).discover()
  assert.equal(got.landmarks.length, 200)
  assert.deepEqual(got.landmarks.map(r => r.seq), Array.from({ length: 200 }, (_, i) => i + 1))
  assert.equal(got.coverage.omittedSemanticLandmarks, 250)
  assert.equal(got.coverage.omittedRanges, 250)
  assert.equal(got.coverage.semanticComplete, false)
  assert.equal(got.coverage.complete, false)
  assert.equal(got.coverage.firstOmittedSeq, 201)
  assert.deepEqual(got.coverage.continuation, { mode: 'detail', startSeq: 201, endSeq: 450 })
  assert.equal(got.ranges.at(-1).endSeq, 200)
  assert.ok(JSON.stringify(got).length < 150_000)
})

test('batch distinguishes generated auxiliary snapshots from substantive user requests', () => {
  const nodes = [user(90, 'opening requirements'), user(1, 'Current runtime context. hidden environment'),
    user(2, 'Time sampled while preparing turn 2, step 1: now'),
    user(3, '<system-reminder>Context pressure: perform proactive compaction</system-reminder>'),
    user(4, 'Please investigate runtime memory and time sampling bugs'),
    assistant(5, [text('verified fix receipt')]), call(91)]
  const f = fixture(nodes), got = f.discover()
  assert.deepEqual(got.landmarks.map(r => r.seq), [90, 4, 5])
  assert.equal(got.surface.auxiliaryCount, 3)
  assert.equal(got.coverage.omittedAuxiliary, 3)
  assert.deepEqual(got.auxiliaryNavigation, { mode: 'detail', startSeq: 1, endSeq: 3, count: 3 })
  assert.deepEqual(f.discover({ query: 'hidden environment' }).candidates.map(r => r.seq), [1])
  assert.equal(got.coverage.semanticComplete, true)
  assert.equal(got.coverage.complete, false)
})

test('batch discloses exact toolstep identities across nonmonotonic IDs and pending multi-call corrections', () => {
  const nodes = [user(100, 'opening'), assistant(8, [text('doing independent tool work'),
    { type: 'tool-call', id: 'a' }, { type: 'tool-call', id: 'b' }]), result(19, 'first result'),
    user(3, 'user correction while calls pending'), result(80, 'last result'),
    assistant(4, [text('final receipt')]), call(101)]
  const f = fixture(nodes), got = f.discover()
  const correction = got.landmarks.find(r => r.seq === 3)
  assert.equal(correction.canStart, false)
  assert.equal(correction.canEnd, false)
  assert.equal(correction.startSeq, 8)
  assert.equal(correction.endSeq, 80)
  assert.equal(correction.sourceTokens, 400)
  assert.equal(correction.boundaryExpanded, true)
  assert.deepEqual(got.ranges.map(r => [r.startSeq, r.endSeq]), [[100, 100], [8, 80], [4, 4]])
  for (const r of got.ranges) {
    assert.equal(f.cuts.before(r.startSeq), true)
    assert.equal(f.cuts.after(r.endSeq), true)
  }
  const onlyTools = fixture([call(89, 'prior'), result(2, 'receipt'), call(90)]).discover()
  assert.deepEqual(onlyTools.landmarks.map(r => [r.seq, r.startSeq, r.endSeq]), [[2, 89, 2]])
  assert.deepEqual(onlyTools.ranges.map(r => [r.startSeq, r.endSeq]), [[89, 2]])
})

test('batch keeps small ranges and unknown token prices without a source/net gate', () => {
  const nodes = [user(1, 'opening'), user(2, 'small concluded task'), assistant(3, [text('done')]), call(4)]
  const f = fixture(nodes), got = f.discover()
  assert.equal(got.ranges.length, 3)
  assert.ok(got.ranges.every(r => r.sourceTokens === 100))
  const missing = discoverSurface(nodes, f.cuts, { measure: () => ({ nodes: [{ seq: 1, tokens: 3000 }] }) }, f.session, 'active')
  assert.deepEqual(missing.ranges.map(r => r.sourceTokens), [3000, null, null])
  assert.throws(() => f.discover({ mode: 'batch', startSeq: 1, endSeq: 3 }), /whole closed surface/)
})

test('batch exposes long prose endings and excludes arguments, reasoning and the active tail', () => {
  const prose = 'beginning ' + 'x'.repeat(1000) + ' final verified receipt and unresolved risk'
  const nodes = [user(1, 'opening'), assistant(2, [text(prose), { type: 'reasoning', text: 'hidden reasoning' }]),
    call(3), user(4, 'inbox secret')]
  const got = fixture(nodes).discover()
  assert.ok(got.landmarks[1].previewTruncated)
  assert.match(got.landmarks[1].tailPreview, /unresolved risk$/)
  assert.ok(!JSON.stringify(got).includes('hidden reasoning'))
  assert.ok(!JSON.stringify(got).includes('private arguments'))
  assert.ok(!JSON.stringify(got).includes('inbox secret'))
  assert.deepEqual(fixture(nodes).discover({}, 'missing').landmarks, [])
})

test('batch reports pending closed-surface steps without inventing a legal end', () => {
  const nodes = [user(1, 'opening'), call(2, 'still-running'), user(3, 'in-flight correction'), call(4)]
  const got = fixture(nodes).discover()
  const correction = got.landmarks.find(r => r.seq === 3)
  assert.equal(correction.startSeq, 2)
  assert.equal(correction.endSeq, null)
  assert.equal(correction.sourceTokens, null)
  assert.equal(got.coverage.unclosedSemanticLandmarks, 1)
  assert.deepEqual(got.ranges.map(r => [r.startSeq, r.endSeq]), [[1, 1]])
})

test('batch official pairing visits the session once, not once per hidden tool result', () => {
  const nodes = [user(1, 'opening')]
  for (let i = 0; i < 2500; i++) nodes.push(call(2 + i * 2, `tool-${i}`), result(3 + i * 2, 'noise'))
  nodes.push(assistant(5002, [text('verified receipt')]), call(5003))
  const f = fixture(nodes), original = f.session.eventAt
  let eventReads = 0
  f.session.eventAt = seq => { eventReads++; return original(seq) }
  const got = f.discover()
  assert.equal(got.landmarks.length, 2)
  assert.equal(eventReads, nodes.length)
  assert.equal(got.coverage.omittedToolResults, 2500)
})
