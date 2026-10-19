import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 本插件注入的合成用户消息所用的来源标记。
 *
 * 插件私有的 kind 让这些消息既区别于真实用户轮次，也不会被误认成压缩检查点；
 * 消费者对未知 kind 按未知处理。
 */
export const SHADOW_SOURCE_KIND = 'agent-compact'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-compact': { kind: 'agent-compact' }
  }
}

/** 为 surface shadow 创建一个合法、非检查点的用户消息。 */
export function createShadowUserMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SHADOW_SOURCE_KIND },
  })
}
