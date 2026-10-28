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
  const session = { surface: { nodes: nodes.map(n => n.seq), replaceGeneration: 0 }, eventAt: seq => nodes.find(n => n.seq === seq) }
  const meter = { measure: () => ({ nodes: nodes.map(n => ({ seq: n.seq, tokens: 100 })) }) }
  const cuts = { before: seq => toolPairingBalancedBefore(session, seq), after: seq => toolPairingBalancedAfter(session, seq) }
  return { session, meter, cuts, discover: (options, callId = 'active') => discoverSurface(nodes, cuts, meter, session, callId, options) }
}

test('default overview reaches the entire closed surface despite thousands of tool-result previews', () => {
  const nodes = [user(1, 'opening requirements')]
  let seq = 2
  for (let topic = 0; topic < 30; topic++) {
    nodes.push(user(seq++, `topic ${topic}: exact user correction`))
    for (let t = 0; t < 80; t++) nodes.push(call(seq++, `tool-${topic}-${t}`), result(seq++, `tool noise ${topic}/${t}`))
    nodes.push(assistant(seq++, [text(`receipt ${topic}: evidence and remaining risk`)]))
  }
  nodes.push(call(seq++), user(seq++, 'later inbox must stay hidden'))
  const f = fixture(nodes), got = f.discover()
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
    const got = f.discover({ limit })
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
  for (const mode of ['overview', 'detail', 'search']) {
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
  const f = fixture(nodes), got = f.discover({ limit: 1 })
  for (const c of got.groups.flatMap(g => g.candidates)) {
    assert.equal(c.canStart, f.cuts.before(c.seq)); assert.equal(c.canEnd, f.cuts.after(c.seq))
  }
  assert.throws(() => seqRegion(nodes, 1, 5, f.cuts, 'active'), /open tool-call/)
  assert.match(got.note, /do not establish semantic completion/)
})

test('tool-only and empty closed surfaces remain navigable without invented message IDs', () => {
  const nodes = [call(89, 'prior'), result(90, 'receipt from a closed tool'), call(1, 'other'), result(2, 'next result'), call(91)]
  const got = fixture(nodes).discover({ limit: 1 })
  assert.deepEqual(got.groups[0].candidates.map(c => c.seq), [90, 2])
  assert.equal(got.groups[0].rangeStartSeq, 89)
  assert.equal(got.groups[0].rangeEndSeq, 2)
  assert.deepEqual(fixture([call(1)]).discover().groups, [])
})

test('discovery evaluates cut predicates only for returned previews, not every hidden tool result', () => {
  const nodes = [user(1, 'topic'), ...Array.from({ length: 2000 }, (_, i) => result(i + 2, 'noise')), assistant(2002, [text('receipt')]), call(2003)]
  let reads = 0
  const cuts = { before: () => { reads++; return true }, after: () => { reads++; return true } }
  const meter = { measure: () => ({ nodes: [] }) }
  const got = discoverSurface(nodes, cuts, meter, {}, 'active', { limit: 1 })
  assert.equal(reads, got.groups[0].candidates.length * 2)
  assert.equal(reads, 4)
})
