import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { automaticBudget, evaluateNudge, registerProactiveCompaction, COMPACTION_GUIDANCE } from '../lib/proactive.js'

const defaults = { volumeNudgeTokens: 300000, autoSafetyMarginTokens: 65536 }
const route = { provider: 'test', model: 'large', maxTokens: 32768 }
const policy = { thresholdRatio: 0.8, headroomTokens: 65536 }
const info = { context: { contextWindow: 500000 }, defaultMaxTokens: 32768 }
const budget = () => automaticBudget(policy, route, info, defaults)
const fresh = () => ({ pressureActive: false, safetyActive: false })

test('official overflow guard uses both ratio and output/headroom, separate from quality bands', () => {
  assert.deepEqual(budget(), { threshold: 400000, urgent: 334464, safetyTarget: 301696 })
  assert.equal(automaticBudget(policy, { ...route, maxTokens: 100000 }, info, defaults).threshold, 334464)
})

test('exact-route model override selects threshold and headroom independently', () => {
  const config = { ...policy, modelPolicies: [
    { provider: 'test', model: 'large-extra', thresholdRatio: 0.1 },
    { provider: 'test', model: 'large', thresholdRatio: 0.4, headroomTokens: 10000 },
  ] }
  assert.equal(automaticBudget(config, route, info, defaults).threshold, 200000)
  assert.equal(automaticBudget(config, { ...route, provider: 'other' }, info, defaults).threshold, 400000)
})

test('request output cap wins; missing cap uses the model default', () => {
  assert.equal(automaticBudget(policy, { provider: 'test', model: 'large' },
    { ...info, defaultMaxTokens: 200000 }, defaults).threshold, 234464)
  assert.equal(automaticBudget(policy, { ...route, maxTokens: 0 }, info, defaults).threshold, 400000)
})

test('unknown capacity, route or backend never fabricates an official threshold', () => {
  assert.equal(automaticBudget(undefined, route, info, defaults), null)
  assert.equal(automaticBudget(policy, route, undefined, defaults), null)
  assert.equal(automaticBudget(policy, {}, info, defaults), null)
  assert.equal(automaticBudget(policy, { ...route, maxTokens: 500000 }, info, defaults), null)
})

test('250k is the absolute notice boundary, not a percentage or accumulated growth', () => {
  const state = fresh()
  assert.equal(evaluateNudge(249999, null, state, 300000), 'quiet')
  assert.equal(evaluateNudge(250000, null, state, 300000), 'notice')
  assert.equal(evaluateNudge(299999, null, state, 300000), 'notice')
  assert.equal(evaluateNudge(300000, null, state, 300000), 'pressure')
})

test('500k and 1M windows use identical 250k notice and 300k continuous quality bands', () => {
  const big = automaticBudget(policy, route, { ...info, context: { contextWindow: 1000000 } }, defaults)
  for (const b of [budget(), big, null]) {
    assert.equal(evaluateNudge(250000, b, fresh(), 300000), 'notice')
    assert.equal(evaluateNudge(300000, b, fresh(), 300000), 'pressure')
  }
})

test('continuous reminders persist on every evaluation without waiting for another growth tier', () => {
  const state = fresh()
  for (let i = 0; i < 8; i++) assert.equal(evaluateNudge(310000, null, state, 300000), 'pressure')
})

test('58,924-token partial reduction does not silence still-full current occupancy', () => {
  const state = fresh()
  assert.equal(evaluateNudge(360000, null, state, 300000), 'pressure')
  assert.equal(evaluateNudge(301076, null, state, 300000), 'pressure')
  assert.equal(evaluateNudge(260000, null, state, 300000), 'pressure')
  assert.equal(evaluateNudge(249999, null, state, 300000), 'quiet')
})

test('restart above 300k immediately re-arms without needing any compaction history', () => {
  assert.equal(evaluateNudge(310000, null, fresh(), 300000), 'pressure')
})

test('metadata loss does not disable absolute maintenance', () => {
  const state = fresh()
  assert.equal(evaluateNudge(310000, budget(), state, 300000), 'pressure')
  assert.equal(evaluateNudge(280000, null, state, 300000), 'pressure')
  assert.equal(evaluateNudge(280000, budget(), state, 300000), 'pressure')
})

test('small models still have an earlier secondary overflow guard', () => {
  const b = automaticBudget({ ...policy, headroomTokens: 8000 }, { ...route, maxTokens: 4000 },
    { context: { contextWindow: 64000 } }, defaults)
  assert.equal(b.threshold, 51200)
  assert.equal(evaluateNudge(40000, b, fresh(), 300000), 'urgent')
  assert.equal(evaluateNudge(1000, b, fresh(), 300000), 'quiet')
})

test('lost overflow budget cannot falsely clear an active safety cycle', () => {
  const state = fresh()
  assert.equal(evaluateNudge(350000, budget(), state, 300000), 'urgent')
  assert.equal(evaluateNudge(320000, null, state, 300000), 'urgent')
  assert.equal(evaluateNudge(300000, budget(), state, 300000), 'pressure')
})

test('disabling quality bands leaves the secondary overflow guard intact', () => {
  assert.equal(evaluateNudge(310000, null, fresh(), 0), 'quiet')
  assert.equal(evaluateNudge(350000, budget(), fresh(), 0), 'urgent')
})

function harness() {
  const listeners = new Map(), contexts = new Map(), sections = new Map(), logs = []
  let now = 310000
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
    // Real ordering: provider first, async assembly waterfall second, pre-step last.
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

test('same-assembly registered context has absolute bands, even without model metadata', async () => {
  const h = harness()
  assert.match(h.text(), /v0.2.5\/pressure/)
  assert.match(h.text(), /notice at 250k, continuous maintenance at 300k/)
  const assembly = await h.prepare()
  assert.equal(assembly.contexts[0].text, 'preserve me')
  assert.match(assembly.contexts[1].text, /[Oo]fficial fallback limit ~400k/)
  assert.equal(h.contexts.get('agent-compact:volume-nudge').required, true)
  h.dispose()
  assert.equal(h.contexts.size + h.sections.size + h.listeners.size, 0)
})

test('no summary-event baseline reset can silence still-high pressure', async () => {
  const h = harness()
  await h.prepare()
  assert.match(h.text(), /pressure/)
  // New code deliberately has no session/event reset listener.
  assert.equal(h.listeners.has('session/event'), false)
  h.setNow(301076)
  assert.match(h.text(), /partial compaction does not clear/)
  h.setNow(260000)
  assert.match(h.text(), /v0.2.5\/pressure/)
  h.setNow(249999)
  assert.equal(h.text(), '')
})

test('route switch preserves absolute cycle but never reuses old metadata or GUI capacity', async () => {
  const h = harness()
  await h.prepare()
  h.text()
  h.setHeader({ config: { provider: 'test', model: 'other', maxTokens: 32768 } })
  h.setNow(280000)
  assert.match(h.text(), /v0.2.5\/pressure/)
  assert.doesNotMatch(h.text(), /[Oo]fficial fallback limit/)
  h.services.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 32768 }) }
  await h.prepare()
  assert.match(h.text(), /[Oo]fficial fallback limit ~800k/)
  assert.match(h.text(), /notice at 250k, continuous maintenance at 300k/)
})

test('metadata lookup failure does not block the assembly or absolute 300k maintenance', async () => {
  const h = harness()
  h.services.llm = { resolveModelInfo: async () => { throw new Error('offline metadata') } }
  const assembly = await h.prepare()
  assert.equal(assembly.contexts[0].text, 'preserve me')
  assert.match(assembly.contexts[1].text, /v0.2.5\/pressure/)
  assert.doesNotMatch(h.text(), /[Oo]fficial fallback limit/)
})

test('two presets with identical route names retain independent LLM metadata', async () => {
  const h = harness()
  const a = { session: { id: 'a', requestHeader: () => ({ config: route }) }, ctx: { name: 'a' } }
  const b = { session: { id: 'b', requestHeader: () => ({ config: route }) }, ctx: { name: 'b' } }
  const llms = { a: { resolveModelInfo: async () => info },
    b: { resolveModelInfo: async () => ({ ...info, context: { contextWindow: 1000000 } }) } }
  h.services.agentPresets = { serviceFor: ({ ctx }, name) => name === 'llm' ? llms[ctx.name] : undefined }
  h.setNow(260000)
  for (const agent of [a, b, a, b, a]) {
    h.setAgent(agent)
    const assembly = await h.prepare()
    assert.match(assembly.contexts[1].text, /v0.2.5\/notice/)
    assert.match(assembly.contexts[1].text, agent === a ? /limit ~400k/ : /limit ~800k/)
  }
})

test('expired metadata outage retains matching cached safety budget', async () => {
  const h = harness()
  await h.prepare()
  const originalNow = Date.now
  const future = originalNow() + 120000
  Date.now = () => future
  h.services.llm.resolveModelInfo = async () => { throw new Error('temporary outage') }
  try {
    assert.match((await h.prepare()).contexts[1].text, /[Oo]fficial fallback limit ~400k/)
    assert.match(h.text(), /v0.2.5\/pressure/)
  } finally { Date.now = originalNow }
})

test('broken optional projection cannot hide a working meter', async () => {
  const h = harness()
  h.services.sessionProjections.snapshot = () => { throw new Error('broken projection') }
  await h.prepare()
  assert.match(h.text(), /v0.2.5\/pressure/)
})

test('real Cordis + SystemPrompt includes same-assembly and admission hints with runtime context disabled', async () => {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, { includeRuntimeContext: false })
  const session = { id: 'isolated-real-api-test', requestHeader: () => ({ config: route }) }
  const disposers = [
    ctx.provide('agents', { currentInitiator: () => ({ session }) }),
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 310000, surfaceTokens: 120000 }) }),
    ctx.provide('llm', { resolveModelInfo: async () => info }),
    ctx.provide('compaction', { config: policy }),
  ]
  const dispose = registerProactiveCompaction(ctx, defaults)
  try {
    const assembly = await prompt.assemble({})
    const hint = assembly.contexts.find(c => c.name === 'agent-compact:volume-nudge')
    assert.match(hint.text, /v0.2.5\/pressure/)
    assert.match(hint.text, /notice at 250k, continuous maintenance at 300k/)
    assert.match(hint.text, /[Oo]fficial fallback limit ~400k/)
    const refreshed = prompt.refreshContext(assembly, {})
    assert.match(refreshed.contexts.find(c => c.name === hint.name).text, /proactive maintenance/)
  } finally { dispose(); for (const off of disposers) off() }
})

test('guidance protects detail and active spans without vetoing unrelated finished spans', () => {
  assert.match(COMPACTION_GUIDANCE, /user corrections verbatim/)
  assert.match(COMPACTION_GUIDANCE, /unrelated background task is NOT a reason/)
  assert.match(COMPACTION_GUIDANCE, /one concluded sub-task per call/)
  assert.match(COMPACTION_GUIDANCE, /absolute token occupancy/)
  assert.doesNotMatch(COMPACTION_GUIDANCE, /evaluate only when a nudge appears/)
})

test('assembly upgrades stale sid summary caches before official fallback even without a tool call', async () => {
  const h=harness()
  h.services.compaction._externalSummary={ [h.session.id]: 'stale checkpoint from old failed operation' }
  h.services.compaction.summarize=async function(_input, agent) {
    return this._externalSummary?.[agent.session.id] ?? 'official'
  }
  h.setNow(1000) // Even quiet sessions must discard the obsolete injected cache.
  assert.equal(h.text(),'')
  assert.equal(h.services.compaction._externalSummary,undefined)
  assert.equal(await h.services.compaction.summarize({}, {session:h.session}),'official')
  h.dispose()
})
