import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PATCH_VERSION, patchEngine, runWithExternalSummary } from '../src/optimizer.ts'

const agentOf = (id = 'shared-session') => ({ session: { id } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const injected = (text) => ({
  summary: [{ type: 'text', text }], rawOutput: [], llmStreamCall: false,
  provider: 'agent', model: 'agent', maxTokens: 0,
})
const span = { start: 1, end: 2 }
function fixture({ dependencies = true } = {}) {
  const calls = []
  const official = { summary: [{ type: 'text', text: 'official' }] }
  const engine = {
    async summarize(input, agent, signal) {
      calls.push({ receiver: this, input, agent, signal })
      return official
    },
    async compactRegion(start, end, agent, signal) {
      signal?.throwIfAborted()
      const input = { start, end }
      return dependencies
        ? this.regionDependencies().summarize(input, agent, signal)
        : this.summarize(input, agent, signal)
    },
    ...(dependencies ? {
      regionDependencies() {
        return { summarize: (input, agent, signal) => this.summarize(input, agent, signal) }
      },
    } : {}),
  }
  return { engine, calls, official }
}
const compact = (engine, agent, signal) => engine.compactRegion(1, 2, agent, signal)
const run = (engine, agent, text, callback = () => compact(engine, agent)) =>
  runWithExternalSummary(engine, agent, text, callback, span)
async function assertReleased(engine, agent) {
  assert.deepEqual(await run(engine, agent, 'next'), injected('next'))
}

function cordisFixture() {
  const ctx = new Context()
  const calls = []
  const official = { summary: [{ type: 'text', text: 'official' }] }
  class Engine extends Service {
    constructor(ctx) { super(ctx, 'testEngine') }
    async summarize(input, agent, signal) {
      calls.push({ receiver: this, input, agent, signal, ctx: this.ctx })
      return official
    }
    async compactRegion(start, end, agent, signal) {
      await Promise.resolve()
      return this.regionDependencies().summarize({ start, end }, agent, signal)
    }
    regionDependencies() {
      return { summarize: (input, agent, signal) => this.summarize(input, agent, signal) }
    }
  }
  const raw = new Engine(ctx)
  class Agent extends Service {
    constructor(ctx) { super(ctx, 'testAgent'); this.session = { id: 'same-session' } }
  }
  const rawAgent = new Agent(ctx)
  const scoped = ctx.extend({ scopeLabel: 'caller-scope' })
  return {
    ctx, scoped, raw, rawAgent, official, calls,
    read: (scope = scoped) => scope.get('testEngine', false),
    agent: (scope = scoped) => scope.get('testAgent', false),
  }
}

// 发布 v4 的实际错误形状：它比较新 proxy 与旧 proxy，并保留无法解包的闭包链。
function installV4(engine) {
  const original = engine.summarize
  const summarize = async function (input, agent, signal) {
    return original.call(this, input, agent, signal)
  }
  engine.summarize = summarize
  engine[Symbol.for('@mimichunterz/agent-compact/optimizer/v4')] = {
    engine, tickets: new WeakMap(), summarize,
  }
  engine.__ctxcOptimized = 4
}
function installV3(engine) {
  const original = engine.summarize.bind(engine)
  engine.summarize = async function (input, agent, signal) {
    const text = this._externalSummary?.[agent?.session?.id]
    if (typeof text === 'string') return injected(text)
    return original(input, agent, signal)
  }
  engine.__ctxcOptimized = 3
}

test('patch is versioned/idempotent and official fallback preserves receiver/input/signal', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const input = {}
  const signal = new AbortController().signal
  assert.equal(PATCH_VERSION, 5)
  assert.equal(patchEngine(engine), true)
  const wrapper = engine.summarize
  assert.equal(patchEngine(engine), true)
  assert.equal(engine.summarize, wrapper)
  assert.equal(await engine.summarize(input, agent, signal), official)
  assert.deepEqual(calls, [{ receiver: engine, input, agent, signal }])
  assert.equal(patchEngine({}), false)
})

test('callback starts synchronously, consumes once, and legacy four-argument API works', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  let invoked = false
  const result = runWithExternalSummary(engine, agent, 'checkpoint', () => {
    invoked = true
    return compact(engine, agent)
  })
  assert.equal(invoked, true)
  assert.deepEqual(await result, injected('checkpoint'))
  assert.equal(await compact(engine, agent), official)
  assert.equal(calls.length, 1)
  await assertReleased(engine, agent)
})

test('async callback keeps operation ticket; parallel official work cannot steal it', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const gate = deferred()
  const pending = run(engine, agent, 'async checkpoint', async () => {
    await gate.promise
    return compact(engine, agent)
  })
  assert.equal(await compact(engine, agent), official)
  await assert.rejects(run(engine, agent, 'concurrent'), /already active/)
  gate.resolve()
  assert.deepEqual(await pending, injected('async checkpoint'))
  assert.equal(calls.length, 1)
})

test('same-agent different span, direct summarize and borrowed receiver cannot steal ticket', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const results = await run(engine, agent, 'owner', async () => {
    const direct = await engine.summarize({}, agent)
    const wrong = await engine.compactRegion(9, 10, agent)
    const borrowed = await engine.compactRegion.call({
      summarize: engine.summarize, regionDependencies: engine.regionDependencies,
    }, 1, 2, agent)
    const right = await compact(engine, agent)
    const second = await compact(engine, agent)
    return [direct, wrong, borrowed, right, second]
  })
  assert.deepEqual(results, [official, official, official, injected('owner'), official])
  assert.equal(calls.length, 4)
})

test('agent identity rather than session identity; separate engines and agents remain independent', async () => {
  const left = fixture()
  const right = fixture()
  const a = agentOf()
  const b = { session: a.session }
  const result = await run(left.engine, a, 'A', async () => {
    const unrelated = await compact(left.engine, b)
    const second = await run(left.engine, b, 'B')
    const otherEngine = await run(right.engine, a, 'right')
    const owned = await compact(left.engine, a)
    return [unrelated, second, otherEngine, owned]
  })
  assert.deepEqual(result, [left.official, injected('B'), injected('right'), injected('A')])
})

test('consumed ticket remains locked until callback settles, then releases', async () => {
  const { engine } = fixture()
  const agent = agentOf()
  const gate = deferred()
  const pending = run(engine, agent, 'first', async () => {
    const summary = await compact(engine, agent)
    await gate.promise
    return summary
  })
  await assert.rejects(run(engine, agent, 'second'), /already active/)
  gate.resolve()
  assert.deepEqual(await pending, injected('first'))
  await assertReleased(engine, agent)
})

test('detached descendants after settle are revoked and cannot steal a newer ticket', async () => {
  const { engine, official } = fixture()
  const agent = agentOf()
  const oldGate = deferred()
  let detached
  assert.equal(await run(engine, agent, 'expired', () => {
    detached = oldGate.promise.then(() => compact(engine, agent))
    return 42
  }), 42)
  const newGate = deferred()
  const pending = run(engine, agent, 'new', async () => {
    await newGate.promise
    return compact(engine, agent)
  })
  oldGate.resolve()
  assert.equal(await detached, official)
  newGate.resolve()
  assert.deepEqual(await pending, injected('new'))
})

test('exception, rejection and abort before/after consumption release exactly their own ticket', async (t) => {
  for (const mode of ['throw', 'reject', 'abort-before', 'abort-pending', 'abort-after']) {
    await t.test(mode, async () => {
      const { engine, official } = fixture()
      const agent = agentOf()
      const error = new Error(mode)
      const controller = new AbortController()
      const pending = run(engine, agent, 'unused', () => {
        if (mode === 'throw') throw error
        if (mode === 'reject') return Promise.reject(error)
        if (mode === 'abort-before') {
          controller.abort(error)
          return compact(engine, agent, controller.signal)
        }
        if (mode === 'abort-pending') return new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        })
        return compact(engine, agent).then(() => {
          controller.abort(error)
          controller.signal.throwIfAborted()
        })
      })
      if (mode === 'abort-pending') controller.abort(error)
      await assert.rejects(pending, (actual) => actual === error)
      assert.equal(await compact(engine, agent), official)
      await assertReleased(engine, agent)
    })
  }
})

test('actual dependencies bind replay input; unrelated direct summarize inside preparation cannot steal', async () => {
  const { engine, official } = fixture()
  const agent = agentOf()
  const originalDependencies = engine.regionDependencies
  const unrelated = []
  engine.regionDependencies = function () {
    unrelated.push(this.summarize({ unrelated: true }, agent))
    return originalDependencies.call(this)
  }
  assert.deepEqual(await run(engine, agent, 'real input'), injected('real input'))
  assert.deepEqual(await Promise.all(unrelated), [official])
})

test('minimal engines without regionDependencies still scope the actual compactRegion operation', async () => {
  const { engine } = fixture({ dependencies: false })
  assert.deepEqual(await run(engine, agentOf(), 'minimal'), injected('minimal'))
})

test('real Cordis service/get/extended-context proxies inject across async boundaries and preserve context', async () => {
  const f = cordisFixture()
  assert.notEqual(f.read(), f.read())
  assert.notEqual(f.read().summarize, f.read().summarize)
  assert.notEqual(f.agent(), f.agent())
  assert.deepEqual(await run(f.read(f.ctx), f.agent(f.ctx), 'proxy checkpoint', async () => {
    await Promise.resolve()
    return compact(f.read(), f.agent())
  }), injected('proxy checkpoint'))
  assert.equal(f.calls.length, 0)
  assert.equal(await compact(f.read(), f.agent()), f.official)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].ctx.scopeLabel, 'caller-scope', 'do not bind official fallback to root ctx')
})

test('real Cordis repeated proxy reads plus HMR module reloads never stack wrappers or lose locks', async () => {
  const f = cordisFixture()
  patchEngine(f.read())
  const wrapper = f.raw.summarize
  const compactWrapper = f.raw.compactRegion
  const gate = deferred()
  const pending = run(f.read(), f.agent(), 'original module', async () => {
    await gate.promise
    return compact(f.read(), f.agent())
  })
  for (let reload = 0; reload < 12; reload++) {
    const module = await import(`../src/optimizer.ts?real-cordis-hmr=${reload}`)
    for (let n = 0; n < 250; n++) assert.equal(module.patchEngine(f.read()), true)
    assert.equal(f.raw.summarize, wrapper)
    assert.equal(f.raw.compactRegion, compactWrapper)
    await assert.rejects(module.runWithExternalSummary(f.read(), f.agent(), 'conflict', () => {}, span), /already active/)
  }
  gate.resolve()
  assert.deepEqual(await pending, injected('original module'))
  assert.equal(await compact(f.read(), f.agent()), f.official)
  assert.equal(f.calls.length, 1)
})

test('migrates thousands of legacy v4 proxy wrappers without entering recursive chain', async () => {
  const f = cordisFixture()
  for (let n = 0; n < 3000; n++) installV4(f.read())
  assert.equal(patchEngine(f.read()), true)
  assert.deepEqual(await run(f.read(), f.agent(), 'recovered'), injected('recovered'))
  assert.equal(await compact(f.read(), f.agent()), f.official)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].ctx.scopeLabel, 'caller-scope')
})

test('legacy v4 object without recoverable prototype fails explicitly, never recurses', () => {
  const { engine } = fixture()
  installV4(engine)
  assert.throws(() => patchEngine(engine), /cannot safely recover legacy v4/)
})

test('old v3 sid cache is ignored before/after upgrade and before official fallback', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  installV3(engine)
  engine._externalSummary = { [agent.session.id]: 'stale' }
  patchEngine(engine)
  assert.equal(await compact(engine, agent), official)
  engine._externalSummary = { [agent.session.id]: 'legacy writer' }
  assert.equal(await compact(engine, agent), official)
  assert.equal(engine._externalSummary, undefined)
  assert.deepEqual(await run(engine, agent, 'owned'), injected('owned'))
  assert.equal(calls.length, 2)
})

test('derived engines have their own identities and do not inherit parent locks or wrappers', async () => {
  const { engine } = fixture()
  const derived = Object.create(engine)
  const agent = agentOf()
  const result = await run(engine, agent, 'base', async () => {
    const child = await run(derived, agent, 'derived')
    return [child, await compact(engine, agent)]
  })
  assert.deepEqual(result, [injected('derived'), injected('base')])
})

test('official fallback failure passes through exactly once', async () => {
  const error = new Error('official failure')
  let calls = 0
  const engine = { summarize() { calls++; throw error } }
  patchEngine(engine)
  await assert.rejects(engine.summarize({}, agentOf()), (actual) => actual === error)
  assert.equal(calls, 1)
})

test('span IDs are identities, not numeric order after checkpoint replacements',async()=>{
 const {engine,calls}=fixture(),agent=agentOf()
 const selected={start:9105,end:7081}
 const result=await runWithExternalSummary(engine,agent,'all facts',()=>engine.compactRegion(selected.start,selected.end,agent),selected)
 assert.deepEqual(result,injected('all facts'));assert.equal(calls.length,0)
})

test('invalid inputs and numeric version alone cannot install or skip a ticket', async () => {
  const { engine } = fixture()
  let ran = false
  const callback = () => { ran = true }
  await assert.rejects(runWithExternalSummary(engine, null, 'text', callback), /identity/)
  await assert.rejects(runWithExternalSummary(engine, agentOf(), undefined, callback), /string/)
  await assert.rejects(runWithExternalSummary(engine, agentOf(), 'text', undefined), /callback/)
  await assert.rejects(runWithExternalSummary({}, agentOf(), 'text', callback), /unavailable/)
  await assert.rejects(runWithExternalSummary(engine, agentOf(), 'text', callback, { start: -1, end: 1 }), /span/)
  assert.equal(ran, false)
  engine.__ctxcOptimized = PATCH_VERSION
  await assertReleased(engine, agentOf())
})

test('actual Basic engine commits injected replay summary on detached Session after legacy/HMR migration', async () => {
  const ctx = new Context()
  const session = Session.create('optimizer-detached-runtime-fixture')
  session.append('turn/start', { turn: 'fixture-turn' })
  const start = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'resolved history '.repeat(500) }],
  }), { surfaceOp: 'append' }).seq
  const end = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'closed followup '.repeat(500) }],
  }), { surfaceOp: 'append' }).seq
  ctx.provide('tokenMeter', {
    measure(owner) {
      return { nodes: owner.surface.nodes.map((seq) => ({ seq, tokens: 10000, heuristicTokens: 10000 })) }
    },
    estimateMessage() { return 20 },
  })
  // 没有提供 LLM：任何静默官方 fallback 都会使本测试失败；不接触磁盘 session。
  const raw = new BasicCompactionEngine(ctx, { auto: false })
  const automaticHook = raw.compactIfNeeded
  const read = () => ctx.get('compaction', false)
  for (let n = 0; n < 1000; n++) installV4(read())
  const reloaded = await import('../src/optimizer.ts?actual-basic-runtime-hmr')
  for (let n = 0; n < 1000; n++) reloaded.patchEngine(read())
  assert.equal(raw.compactIfNeeded, automaticHook, 'automatic policy method stays untouched')
  const agent = { session }
  const result = await reloaded.runWithExternalSummary(read(), agent, 'runtime checkpoint', async () => {
    await Promise.resolve()
    return read().compactRegion(start, end, agent)
  }, { start, end })
  assert.deepEqual(result.summary, [{ type: 'text', text: 'runtime checkpoint' }])
  assert.deepEqual(result.shadowedSeqs, [start, end])
  assert.equal(session.surface.nodes.length, 1)
  assert.equal(session.eventAt(result.endSeq).type, 'compaction/end')
  assert.equal(session.eventAt(result.endSeq).data.error, undefined)
  assert.equal(session.eventAt(result.summarySeq).data.provider, 'agent')
})

test('runtime BasicCompactionEngine dependency callback binds the injected input through real Cordis receiver', async () => {
  const f = cordisFixture()
  // 使用实际安装版本的 dependency 回调，而不触及任何真实 session 或 LLM。
  f.raw.regionDependencies = BasicCompactionEngine.prototype.regionDependencies
  f.scoped.provide('tokenMeter', {})
  assert.deepEqual(await run(f.read(), f.agent(), 'runtime hook'), injected('runtime hook'))
  assert.equal(f.calls.length, 0)
})
