import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { automaticBudget, evaluateNudge, registerProactiveCompaction, COMPACTION_GUIDANCE } from '../lib/proactive.js'

const defaults = { volumeNudgeTokens: 300000, pressureStartRatio: 0.6, pressureTargetRatio: 0.5 }
const route = { provider: 'test', model: 'large', maxTokens: 32768 }
const policy = { thresholdRatio: 0.8, headroomTokens: 65536 }
const info = { context: { contextWindow: 500000 }, defaultMaxTokens: 32768 }
const budget = () => automaticBudget(policy, route, info, defaults)
const fresh = () => ({ baseline: 0, pressureActive: false, growthActive: false })

test('uses the official ratio AND completion/headroom limit, not raw window percent', () => {
  assert.deepEqual(budget(), { threshold: 400000, start: 240000, target: 200000, urgent: 320000 })
  const capped = automaticBudget(policy, { ...route, maxTokens: 100000 }, info, defaults)
  assert.equal(capped.threshold, 334464)
  assert.equal(capped.start, Math.floor(334464 * 0.6))
})

test('exact model override selects threshold and headroom independently', () => {
  const config = { ...policy, modelPolicies: [
    { provider: 'test', model: 'large-extra', thresholdRatio: 0.1 },
    { provider: 'test', model: 'large', thresholdRatio: 0.4, headroomTokens: 10000 },
  ] }
  assert.equal(automaticBudget(config, route, info, defaults).threshold, 200000)
  assert.equal(automaticBudget(config, { ...route, provider: 'other' }, info, defaults).threshold, 400000)
})

test('model default output is used only when the durable request omits its cap', () => {
  assert.equal(automaticBudget(policy, { provider: 'test', model: 'large' },
    { ...info, defaultMaxTokens: 200000 }, defaults).threshold, 234464)
  assert.equal(automaticBudget(policy, { ...route, maxTokens: 0 }, info, defaults).threshold, 400000)
})

test('unknown route, model capacity, backend or impossible reservation never fabricates a threshold', () => {
  assert.equal(automaticBudget(undefined, route, info, defaults), null)
  assert.equal(automaticBudget(policy, route, undefined, defaults), null)
  assert.equal(automaticBudget(policy, {}, info, defaults), null)
  assert.equal(automaticBudget(policy, { ...route, maxTokens: 500000 }, info, defaults), null)
})

test('small-window models are warned well before 250k growth can ever happen', () => {
  const b = automaticBudget({ ...policy, headroomTokens: 8000 }, { ...route, maxTokens: 4000 },
    { context: { contextWindow: 64000 } }, defaults)
  assert.equal(b.threshold, 51200)
  assert.equal(evaluateNudge(31000, b, fresh(), 300000), 'pressure')
})

test('absolute high pressure stays active after partial compaction even with zero growth', () => {
  const state = fresh()
  assert.equal(evaluateNudge(360000, budget(), state, 300000), 'urgent')
  // Reproduce the 58,924-token reduction: old growth-only code would be silent.
  state.baseline = 301076
  state.growthActive = false
  assert.equal(evaluateNudge(301076, budget(), state, 300000), 'pressure')
  assert.equal(evaluateNudge(330000, budget(), state, 300000), 'urgent')
  assert.equal(evaluateNudge(210000, budget(), state, 300000), 'pressure')
  assert.equal(evaluateNudge(200000, budget(), state, 300000), 'quiet')
})

test('growth safeguard is persistent rather than a one-turn hint', () => {
  const state = fresh()
  for (let i = 0; i < 5; i++) assert.equal(evaluateNudge(250000, null, state, 300000), 'growth')
  state.baseline = 120000
  state.growthActive = false
  assert.equal(evaluateNudge(120000, null, state, 300000), 'quiet')
})

test('disabling growth does not disable absolute pressure maintenance', () => {
  assert.equal(evaluateNudge(260000, budget(), fresh(), 0), 'pressure')
})

test('hysteresis avoids repeated on/off oscillation near start', () => {
  const state = fresh()
  assert.equal(evaluateNudge(239000, budget(), state, 0), 'quiet')
  assert.equal(evaluateNudge(240000, budget(), state, 0), 'pressure')
  assert.equal(evaluateNudge(239000, budget(), state, 0), 'pressure')
  assert.equal(evaluateNudge(200000, budget(), state, 0), 'quiet')
})

function harness() {
  const listeners = new Map()
  const contexts = new Map()
  const sections = new Map()
  const logs = []
  let now = 360000
  let header = { config: { ...route } }
  const session = { id: 'synthetic-session', requestHeader: () => header }
  let agent = { session, ctx: {} }
  const services = {
    tokenMeter: { measure: () => ({ totalTokens: now, surfaceTokens: 120000 }) },
    compaction: { config: policy },
    llm: { resolveModelInfo: async () => info },
    agents: { currentInitiator: () => agent },
    sessionProjections: { snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }) },
    systemPrompt: {
      section(value) { sections.set(value.name, value); return () => sections.delete(value.name) },
      context(value) { contexts.set(value.name, value); return () => contexts.delete(value.name) },
    },
  }
  const ctx = {
    get: name => services[name],
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  }
  const dispose = registerProactiveCompaction(ctx, defaults)
  const text = () => contexts.get('agent-compact:volume-nudge').text()
  const prepare = () => {
    // Real DSH ordering: sync provider first, THEN async assemble waterfall,
    // then official pre-step. Do not fake prepare -> text as initial assembly.
    const assembly = { contexts: [
      { name: 'unrelated-context', text: 'preserve me' },
      { name: 'agent-compact:volume-nudge', text: text() },
    ], sections: [], tools: [], variables: {} }
    return listeners.get('system-prompt/assemble')(assembly,
      { signal: new AbortController().signal }, () => Promise.resolve(assembly))
  }
  return { services, listeners, contexts, sections, text, prepare, dispose, session, logs,
    setNow: n => { now = n }, setHeader: v => { header = v }, setAgent: v => { agent = v } }
}

test('registered context uses real meter pressure and required durable hints, no GUI capacity gating', async () => {
  const h = harness()
  assert.equal((await h.prepare()).contexts[0].text, 'preserve me')
  assert.match(h.text(), /urgent/)
  assert.match(h.text(), /official fallback limit ~400k/)
  assert.match(h.text(), /healthy target <=200k/)
  assert.equal(h.contexts.get('agent-compact:volume-nudge').required, true)
  assert.equal(h.sections.get('tool:context_compact').text, COMPACTION_GUIDANCE)
  h.dispose()
  assert.equal(h.contexts.size, 0)
  assert.equal(h.sections.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('session compaction reset cannot silence still-high pressure; another healthy reduction can', async () => {
  const h = harness()
  await h.prepare()
  assert.match(h.text(), /urgent/)
  h.listeners.get('session/event')(h.session, { type: 'compaction/summary' })
  h.setNow(301076)
  assert.match(h.text(), /proactive maintenance/)
  assert.match(h.text(), /partial compaction does not clear/)
  h.listeners.get('session/event')(h.session, { type: 'compaction/summary' })
  h.setNow(190000)
  assert.equal(h.text(), '')
})

test('failed calls without a committed summary never reset maintenance', async () => {
  const h = harness()
  await h.prepare()
  h.text()
  h.listeners.get('session/event')(h.session, { type: 'compaction/start' })
  h.listeners.get('session/event')(h.session, { type: 'compaction/end' })
  assert.match(h.text(), /urgent/)
})

test('route switch does not reuse the old model capacity, default maxTokens or GUI window', async () => {
  const h = harness()
  await h.prepare()
  h.text()
  h.setHeader({ config: { provider: 'test', model: 'small', maxTokens: 4000 } })
  assert.doesNotMatch(h.text(), /official fallback limit/)
  h.services.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100000 }, defaultMaxTokens: 4000 }) }
  h.services.compaction.config = { ...policy, headroomTokens: 8000 }
  await h.prepare()
  assert.match(h.text(), /official fallback limit ~80k/)
})

test('model-info lookup failure preserves next() and never fabricates an official limit', async () => {
  const h = harness()
  h.services.llm = { resolveModelInfo: async () => { throw new Error('offline metadata') } }
  assert.equal((await h.prepare()).contexts[0].text, 'preserve me')
  assert.match(h.text(), /Model budget unavailable/)
  assert.doesNotMatch(h.text(), /official fallback limit/)
})

test('session state is isolated across agents and restart at high occupancy immediately re-arms', async () => {
  const h = harness()
  await h.prepare()
  assert.match(h.text(), /urgent/)
  const other = { id: 'other', requestHeader: () => ({ config: route }) }
  h.setAgent({ session: other })
  h.setNow(100000)
  assert.equal(h.text(), '')
  h.setNow(350000)
  assert.match(h.text(), /urgent/)
})

test('metadata outage in the hysteresis band cannot mark context healthy', () => {
  const state = { baseline: 210000, growthActive: false, pressureActive: true }
  assert.equal(evaluateNudge(210000, budget(), state, 0), 'pressure')
  assert.equal(evaluateNudge(210000, null, state, 0), 'pressure')
  assert.equal(evaluateNudge(210000, budget(), state, 0), 'pressure')
  assert.equal(evaluateNudge(200000, budget(), state, 0), 'quiet')
})

test('cold assembly includes pressure hint in the SAME request below growth trigger', async () => {
  const h = harness()
  h.setNow(245000)
  assert.equal(h.text(), '') // provider runs before metadata is resolved
  const assembly = await h.prepare()
  assert.match(assembly.contexts[1].text, /proactive maintenance/)
  assert.match(assembly.contexts[1].text, /official fallback limit ~400k/)
  assert.equal(assembly.contexts[0].text, 'preserve me')
})

test('two scoped LLMs on the same route cannot evict each other’s pressure metadata', async () => {
  const h = harness()
  const a = { session: { id: 'a', requestHeader: () => ({ config: route }) }, ctx: { name: 'a' } }
  const b = { session: { id: 'b', requestHeader: () => ({ config: route }) }, ctx: { name: 'b' } }
  const llms = { a: { resolveModelInfo: async () => info }, b: { resolveModelInfo: async () => info } }
  h.services.agentPresets = { serviceFor: ({ ctx }, name) => name === 'llm' ? llms[ctx.name] : undefined }
  h.setNow(245000)
  for (const agent of [a, b, a, b, a]) {
    h.setAgent(agent)
    const assembly = await h.prepare()
    assert.match(assembly.contexts[1].text, /official fallback limit ~400k/)
    assert.match(h.text(), /proactive maintenance/)
  }
})

test('expired metadata refresh failure retains last matching budget and active cycle', async () => {
  const h = harness()
  await h.prepare()
  h.text()
  h.listeners.get('session/event')(h.session, { type: 'compaction/summary' })
  h.setNow(210000)
  assert.match(h.text(), /proactive maintenance/)
  const originalNow = Date.now
  const future = originalNow() + 120000
  Date.now = () => future
  h.services.llm.resolveModelInfo = async () => { throw new Error('temporary outage') }
  try {
    const assembly = await h.prepare()
    assert.match(assembly.contexts[1].text, /official fallback limit ~400k/)
    assert.match(h.text(), /proactive maintenance/)
  } finally { Date.now = originalNow }
})

test('broken optional projection service cannot mask working token meter', async () => {
  const h = harness()
  h.services.sessionProjections.snapshot = () => { throw new Error('broken projection') }
  await h.prepare()
  assert.match(h.text(), /urgent/)
})

test('real Cordis + SystemPrompt emits same-assembly pressure context even with optional runtime disabled', async () => {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, { includeRuntimeContext: false })
  const session = { id: 'isolated-real-api-test', requestHeader: () => ({ config: route }) }
  const disposers = [
    ctx.provide('agents', { currentInitiator: () => ({ session }) }),
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 245000, surfaceTokens: 120000 }) }),
    ctx.provide('llm', { resolveModelInfo: async () => info }),
    ctx.provide('compaction', { config: policy }),
  ]
  const dispose = registerProactiveCompaction(ctx, defaults)
  try {
    const assembly = await prompt.assemble({})
    const hint = assembly.contexts.find(c => c.name === 'agent-compact:volume-nudge')
    assert.match(hint.text, /official fallback limit ~400k/)
    assert.match(hint.text, /healthy target <=200k/)
    // Admission refresh uses the registered synchronous provider, now warmed.
    const refreshed = prompt.refreshContext(assembly, {})
    assert.match(refreshed.contexts.find(c => c.name === 'agent-compact:volume-nudge').text, /proactive maintenance/)
  } finally {
    dispose()
    for (const off of disposers) off()
  }
})

test('guidance protects necessary detail but does not veto all compaction for unrelated jobs', () => {
  assert.match(COMPACTION_GUIDANCE, /user corrections verbatim/)
  assert.match(COMPACTION_GUIDANCE, /unrelated background task is NOT a reason/)
  assert.match(COMPACTION_GUIDANCE, /one concluded sub-task per call/)
  assert.doesNotMatch(COMPACTION_GUIDANCE, /evaluate only when a nudge appears/)
})
