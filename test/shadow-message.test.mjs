import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createShadowUserMessage, SHADOW_SOURCE_KIND } from '../lib/shadow-message.js'

test('paired cleanup replacements remain valid user messages', () => {
  const session = Session.create('session-shadow-test')
  const assistantSeq = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: 'call-shadow-test', name: 'context_compact', arguments: '{}' }],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    },
    { surfaceOp: 'append' },
  ).seq
  const toolCallSeq = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-shadow-test',
    name: 'context_compact',
    arguments: {},
  }).seq
  const resultSeq = session.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'call-shadow-test',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    },
    { surfaceOp: 'append', sourceEventSeqs: [toolCallSeq] },
  ).seq

  session.append(
    'user/message',
    createShadowUserMessage('assistant placeholder'),
    {
      surfaceOp: { op: 'replace', startSeq: assistantSeq, endSeq: assistantSeq },
      sourceEventSeqs: [assistantSeq],
    },
  )
  session.append(
    'user/message',
    createShadowUserMessage('result placeholder'),
    {
      surfaceOp: { op: 'replace', startSeq: resultSeq, endSeq: resultSeq },
      sourceEventSeqs: [resultSeq],
    },
  )

  assert.doesNotThrow(() => session.deriveMessages().forEach((message) => {
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    // 合成消息使用插件私有 kind，不会被误认成压缩检查点。
    assert.equal(message.source.kind, SHADOW_SOURCE_KIND)
    assert.equal(isCompactCheckpointSource(message.source), false)
  }))
})
