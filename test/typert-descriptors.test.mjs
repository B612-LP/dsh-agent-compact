import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 与 Web 宿主共享的 zod 模块。
import * as zod from 'zod'

import { TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// strict TypertCodec 通过 `create: () => TypertSchema` 惰性物化 schema：
// Gateway 的解码路径是 `codec.create().parse(value)`。描述符只是普通对象
// 字面量，tsc 不会按 TypertCodec 校验，所以这里显式守卫。
function assertStrictCodec(codec, where) {
  assert.ok(codec, `${where}: missing codec`)
  assert.equal(codec.mode, 'strict', `${where}: expected a strict codec`)
  assert.equal(typeof codec.typeSymbol, 'string', `${where}: missing typeSymbol`)
  assert.equal(typeof codec.create, 'function', `${where}: strict codec must expose create()`)
  assert.equal(typeof codec.create().parse, 'function', `${where}: create() must return a schema with parse()`)
  assert.equal('schema' in codec, false, `${where}: strict codec must not carry a pre-built \`schema\` field`)
}

function assertDescriptors(contribution, face) {
  const list = face === 'host' ? contribution.invocations : contribution.descriptors
  assert.ok(Array.isArray(list) && list.length > 0, `${face}: expected at least one invocation`)
  for (const descriptor of list) {
    const at = `${face} ${descriptor.id}`
    for (const parameter of descriptor.parameters) assertStrictCodec(parameter.codec, `${at} parameter ${parameter.wire}`)
    assertStrictCodec(descriptor.result, `${at} result`)
    if (descriptor.invocation.kind === 'context') assertStrictCodec(descriptor.invocation.codec, `${at} context`)
  }
}

test('host typert face declares strict `create` codecs', () => {
  assert.equal(TYPERT.face, 'host')
  assertDescriptors(TYPERT, 'host')
})

test('client typert face declares strict `create` codecs', () => {
  assertDescriptors(TYPERT_REMOTE, 'remote')
})

test('built client bundle keeps `create` codecs (build-client.mjs stays in sync)', () => {
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  assert.match(bundle, /create:\s*\(\)\s*=>\s*_ctxSurface_read_request\$schema/)
  assert.match(bundle, /create:\s*\(\)\s*=>\s*_ctxSurface_read_result\$schema/)
  assert.doesNotMatch(bundle, /schema:\s*_ctxSurface_read_request\$schema/)
  assert.doesNotMatch(bundle, /schema:\s*_ctxSurface_read_result\$schema/)
})

test('built client bundle takes zod from the host module loader', () => {
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  // 宿主 ClientModuleSystem 暴露共享 zod；官方 bundle 同样 require("zod")。
  // 若这里回退成内联副本，schema 会由与宿主不同实例的 zod 构造。
  assert.match(bundle, /require\("zod"\)/)
  assert.doesNotMatch(bundle, /zod\/v4\/core\/core\.js/)
})

test('built client bundle materializes against the host-shared zod namespace', () => {
  // schema 区段必须保留 `z.` 前缀，否则在浏览器里会以
  // ReferenceError: object is not defined 失败。
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  let captured
  const win = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
  new Function('window', bundle)(win)
  assert.ok(captured, 'bundle did not register with the module loader')
  const reactStub = new Proxy({}, { get: () => () => undefined })
  const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
  const requireStub = (spec) => {
    if (spec === 'zod') return zod
    if (spec === 'react') return reactStub
    if (spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime') return jsxStub
    throw new Error('unexpected require: ' + spec)
  }
  const mod = captured.factory(requireStub)
  assert.equal(captured.id, '@mimichunterz/agent-compact')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'remote'])
})
