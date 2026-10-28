import test from 'node:test'
import assert from 'node:assert/strict'
// Node 24 的原生 type stripping：直接测源码，不需要构建或写入 lib。
import { PATCH_VERSION, patchEngine, runWithExternalSummary } from '../src/optimizer.ts'

const agentOf = (id = 'shared-session') => ({ session: { id } })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const injected = (text) => ({
  summary: [{ type: 'text', text }],
  rawOutput: [],
  llmStreamCall: false,
  provider: 'agent',
  model: 'agent',
  maxTokens: 0,
})
function fixture() {
  const calls = []
  const official = { summary: [{ type: 'text', text: 'official' }] }
  const engine = {
    async summarize(input, agent, signal) {
      calls.push({ receiver: this, input, agent, signal })
      return official
    },
    // Basic compactRegion 同样会在首次 await 前同步调用 summarize。
    async compactRegion(input, agent, signal) {
      signal?.throwIfAborted()
      return await this.summarize(input, agent, signal)
    },
  }
  return { engine, calls, official }
}

// 精确模拟已发布 v3：原 summarizer 仅存在闭包，不提供 unpatch 句柄。
function installV3(engine) {
  const original = engine.summarize.bind(engine)
  engine.summarize = async function (input, agent, signal) {
    const sid = agent?.session?.id
    const ext = this._externalSummary
    if (sid && ext && typeof ext[sid] === 'string') {
      const text = ext[sid]
      delete ext[sid]
      return injected(text)
    }
    return original(input, agent, signal)
  }
  engine.__ctxcOptimized = 3
}

async function assertReleased(engine, agent, text = 'next ticket') {
  const result = await runWithExternalSummary(engine, agent, text,
    () => engine.compactRegion({}, agent))
  assert.deepEqual(result, injected(text))
}

test('patch is versioned, idempotent, and no-ticket calls forward official arguments and receiver', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const input = { span: [1, 2] }
  const signal = new AbortController().signal
  assert.equal(PATCH_VERSION, 4)
  assert.equal(patchEngine(engine), true)
  const wrapper = engine.summarize
  assert.equal(patchEngine(engine), true)
  assert.equal(engine.summarize, wrapper)
  assert.equal(engine.__ctxcOptimized, PATCH_VERSION)
  assert.equal(await engine.summarize(input, agent, signal), official)
  assert.deepEqual(calls, [{ receiver: engine, input, agent, signal }])
  assert.equal(await engine.summarize(input, undefined), official)
  assert.equal(patchEngine({}), false)
})

test('helper invokes callback synchronously and returns exactly one compatible summary envelope', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  let invoked = false
  const pending = runWithExternalSummary(engine, agent, 'checkpoint', () => {
    invoked = true
    return engine.compactRegion({ span: [1, 2] }, agent)
  })
  assert.equal(invoked, true, 'install -> run -> consume must have no await gap')
  assert.deepEqual(await pending, injected('checkpoint'))
  assert.equal(calls.length, 0)
  assert.equal(await engine.compactRegion({}, agent), official)
  assert.equal(calls.length, 1)
  await assertReleased(engine, agent)
})

test('one ticket can only be consumed once even within the synchronous callback', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const results = await runWithExternalSummary(engine, agent, 'one', () => {
    const first = engine.summarize({ attempt: 1 }, agent)
    const second = engine.summarize({ attempt: 2 }, agent)
    return Promise.all([first, second])
  })
  assert.deepEqual(results, [injected('one'), official])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { attempt: 2 })
})

test('different agent identities sharing the exact same session cannot steal a ticket', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const other = { session: agent.session }
  const results = await runWithExternalSummary(engine, agent, 'owner only', () => {
    const unrelated = engine.compactRegion({}, other)
    const owned = engine.compactRegion({}, agent)
    return Promise.all([unrelated, owned])
  })
  assert.deepEqual(results, [official, injected('owner only')])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, other)
})

test('same-engine same-agent concurrency rejects without running or removing the first ticket', async () => {
  const { engine, calls } = fixture()
  const agent = agentOf()
  const gate = deferred()
  const first = runWithExternalSummary(engine, agent, 'first', () => {
    const summary = engine.compactRegion({}, agent)
    return gate.promise.then(() => summary)
  })
  let secondRan = false
  await assert.rejects(runWithExternalSummary(engine, agent, 'second', () => {
    secondRan = true
  }), /already active/)
  assert.equal(secondRan, false)
  // 已消费不代表已释放互斥。
  await assert.rejects(runWithExternalSummary(engine, agent, 'third', () => {}), /already active/)
  gate.resolve()
  assert.deepEqual(await first, injected('first'))
  assert.equal(calls.length, 0)
  await assertReleased(engine, agent)
})

test('pending tickets for different agents in one session remain independent', async () => {
  const { engine, calls, official } = fixture()
  const a = agentOf()
  const b = { session: a.session }
  const gate = deferred()
  const first = runWithExternalSummary(engine, a, 'A', () => {
    const summary = engine.compactRegion({}, a)
    return gate.promise.then(() => summary)
  })
  const second = await runWithExternalSummary(engine, b, 'B', () => engine.compactRegion({}, b))
  assert.deepEqual(second, injected('B'))
  assert.equal(await engine.compactRegion({}, a), official)
  assert.equal(await engine.compactRegion({}, b), official)
  await assert.rejects(runWithExternalSummary(engine, a, 'steal', () => {}), /already active/)
  gate.resolve()
  assert.deepEqual(await first, injected('A'))
  assert.equal(calls.length, 2)
})

test('same agent on distinct engines has independent tickets and locks', async () => {
  const left = fixture()
  const right = fixture()
  const agent = agentOf()
  const gate = deferred()
  const first = runWithExternalSummary(left.engine, agent, 'left', () => {
    const summary = left.engine.compactRegion({}, agent)
    return gate.promise.then(() => summary)
  })
  assert.deepEqual(await runWithExternalSummary(right.engine, agent, 'right',
    () => right.engine.compactRegion({}, agent)), injected('right'))
  gate.resolve()
  assert.deepEqual(await first, injected('left'))
})

test('an engine inheriting a patched engine does not inherit its identity lock', async () => {
  const { engine } = fixture()
  const derived = Object.create(engine)
  const agent = agentOf()
  const results = await runWithExternalSummary(engine, agent, 'base', () => {
    const own = engine.compactRegion({}, agent)
    const child = runWithExternalSummary(derived, agent, 'derived',
      () => derived.compactRegion({}, agent))
    return Promise.all([own, child])
  })
  assert.deepEqual(results, [injected('base'), injected('derived')])
})

test('borrowed summarize receiver cannot consume another engine ticket', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const otherEngine = {}
  const results = await runWithExternalSummary(engine, agent, 'right receiver', () => {
    const wrong = engine.summarize.call(otherEngine, {}, agent)
    const right = engine.compactRegion({}, agent)
    return Promise.all([wrong, right])
  })
  assert.deepEqual(results, [official, injected('right receiver')])
  assert.equal(calls[0].receiver, otherEngine)
})

test('await-before-compact callback is disarmed; neither official nor delayed work steals summary', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  const gate = deferred()
  const pending = runWithExternalSummary(engine, agent, 'must not escape', async () => {
    await gate.promise
    return engine.compactRegion({}, agent)
  })
  assert.equal(await engine.compactRegion({ automatic: true }, agent), official)
  await assert.rejects(runWithExternalSummary(engine, agent, 'concurrent', () => {}), /already active/)
  gate.resolve()
  assert.equal(await pending, official)
  assert.equal(calls.length, 2)
  await assertReleased(engine, agent)
})

test('a callback which never consumes releases its ticket without affecting official compaction', async () => {
  const { engine, official } = fixture()
  const agent = agentOf()
  assert.equal(await runWithExternalSummary(engine, agent, 'unused', () => 42), 42)
  assert.equal(await engine.compactRegion({}, agent), official)
  await assertReleased(engine, agent)
})

test('fail-before-consume synchronous throw and async rejection both preserve error and release', async (t) => {
  for (const asyncFailure of [false, true]) {
    await t.test(asyncFailure ? 'rejection' : 'synchronous throw', async () => {
      const { engine, official } = fixture()
      const agent = agentOf()
      const error = new Error('range validation failed before summarize')
      await assert.rejects(runWithExternalSummary(engine, agent, 'unused', () => {
        if (asyncFailure) return Promise.reject(error)
        throw error
      }), (actual) => actual === error)
      assert.equal(await engine.compactRegion({}, agent), official)
      await assertReleased(engine, agent)
    })
  }
})

test('abort before consume and abort during an unconsumed pending operation both release', async (t) => {
  await t.test('already aborted Basic-style compactRegion', async () => {
    const { engine, official } = fixture()
    const agent = agentOf()
    const error = new Error('abort before consume')
    const controller = new AbortController()
    controller.abort(error)
    await assert.rejects(runWithExternalSummary(engine, agent, 'unused',
      () => engine.compactRegion({}, agent, controller.signal)), (actual) => actual === error)
    assert.equal(await engine.compactRegion({}, agent), official)
    await assertReleased(engine, agent)
  })
  await t.test('abort pending callback', async () => {
    const { engine, official } = fixture()
    const agent = agentOf()
    const controller = new AbortController()
    const error = new Error('abort pending')
    const pending = runWithExternalSummary(engine, agent, 'unused', () => new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    }))
    controller.abort(error)
    await assert.rejects(pending, (actual) => actual === error)
    assert.equal(await engine.compactRegion({}, agent), official)
    await assertReleased(engine, agent)
  })
})

test('direct summarize with an aborted signal does not consume or inject', async () => {
  const { engine, calls } = fixture()
  const agent = agentOf()
  const controller = new AbortController()
  const error = new Error('aborted')
  controller.abort(error)
  await assert.rejects(runWithExternalSummary(engine, agent, 'unused',
    () => engine.summarize({}, agent, controller.signal)), (actual) => actual === error)
  assert.equal(calls.length, 0)
  await assertReleased(engine, agent)
})

test('throw or abort after consumption cannot leave a ticket behind', async (t) => {
  for (const abort of [false, true]) {
    await t.test(abort ? 'abort' : 'throw', async () => {
      const { engine, official } = fixture()
      const agent = agentOf()
      const error = new Error('failure after consumption')
      const controller = new AbortController()
      await assert.rejects(runWithExternalSummary(engine, agent, 'consumed', async () => {
        assert.deepEqual(await engine.compactRegion({}, agent), injected('consumed'))
        if (abort) {
          controller.abort(error)
          controller.signal.throwIfAborted()
        }
        throw error
      }), (actual) => actual === error)
      assert.equal(await engine.compactRegion({}, agent), official)
      await assertReleased(engine, agent)
    })
  }
})

test('v3 upgrade and later legacy sid writes cannot contaminate official fallback', async () => {
  const { engine, calls, official } = fixture()
  const agent = agentOf()
  installV3(engine)
  engine._externalSummary = { [agent.session.id]: 'stale before upgrade' }
  assert.equal(patchEngine(engine), true)
  assert.equal(engine.__ctxcOptimized, PATCH_VERSION)
  assert.equal(await engine.compactRegion({}, agent), official)
  engine._externalSummary = { [agent.session.id]: 'legacy writer after upgrade' }
  assert.equal(await engine.compactRegion({}, agent), official)
  assert.equal(engine._externalSummary, undefined)
  engine._externalSummary = { [agent.session.id]: 'stale before failure' }
  await assert.rejects(runWithExternalSummary(engine, agent, 'unused', () => {
    throw new Error('validation failed')
  }), /validation failed/)
  assert.equal(await engine.compactRegion({}, agent), official)
  assert.equal(calls.length, 3)
  await assertReleased(engine, agent)
  engine._externalSummary = { [agent.session.id]: 'legacy writer after success' }
  assert.equal(await engine.compactRegion({}, agent), official)
})

test('official fallback rejection is passed through, not intercepted or disabled', async () => {
  const error = new Error('official summarizer failure')
  let calls = 0
  const engine = { summarize() { calls++; throw error } }
  patchEngine(engine)
  await assert.rejects(engine.summarize({}, agentOf()), (actual) => actual === error)
  assert.equal(calls, 1)
})

test('module reload shares per-engine identity lock and does not stack wrappers', async () => {
  const reloaded = await import('../src/optimizer.ts?optimizer-reload-test')
  const { engine } = fixture()
  const agent = agentOf()
  const gate = deferred()
  const first = runWithExternalSummary(engine, agent, 'first module', () => {
    const summary = engine.compactRegion({}, agent)
    return gate.promise.then(() => summary)
  })
  const wrapper = engine.summarize
  assert.equal(reloaded.patchEngine(engine), true)
  assert.equal(engine.summarize, wrapper)
  await assert.rejects(reloaded.runWithExternalSummary(engine, agent, 'other module', () => {}), /already active/)
  gate.resolve()
  assert.deepEqual(await first, injected('first module'))
  assert.deepEqual(await reloaded.runWithExternalSummary(engine, agent, 'reloaded',
    () => engine.compactRegion({}, agent)), injected('reloaded'))
})

test('invalid helper inputs fail before callback; a numeric version alone is not trusted', async () => {
  const { engine } = fixture()
  let ran = false
  const run = () => { ran = true }
  await assert.rejects(runWithExternalSummary(engine, null, 'text', run), /identity/)
  await assert.rejects(runWithExternalSummary(engine, agentOf(), undefined, run), /string/)
  await assert.rejects(runWithExternalSummary(engine, agentOf(), 'text', undefined), /callback/)
  await assert.rejects(runWithExternalSummary({}, agentOf(), 'text', run), /unavailable/)
  assert.equal(ran, false)
  engine.__ctxcOptimized = PATCH_VERSION
  await assertReleased(engine, agentOf(), 'not skipped')
})
