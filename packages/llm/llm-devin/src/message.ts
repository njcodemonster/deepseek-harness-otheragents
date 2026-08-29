/**
 * Pure mapping from the harness conversation vocabulary (`Message[]` +
 * `GenerateOptions.system`) into the shapes the cloud-direct gRPC layer
 * expects (`ChatHistoryItem[]` + `ToolDef[]`).
 *
 * No side effects, no I/O — trivially unit-testable.
 *
 * @module dsh-llm-devin/message
 */

import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ChatHistoryItem, ContentPart, ToolDef } from './cloud-direct/chat.ts'

export interface MappedChat {
  messages: ChatHistoryItem[]
  tools: ToolDef[]
}

/** Join every TextBlock in a content list. Reasoning/tool-call blocks are skipped. */
function extractText(content: readonly { type: string; text?: unknown }[]): string {
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

/**
 * Map one harness {@link Message} into a cloud-direct {@link ChatHistoryItem}.
 *
 * - user message        → `{ role: 'user', content: <joined text> }`
 * - tool-result message → `{ role: 'tool', content: <result text>, tool_call_id }`
 * - assistant message   → `{ role: 'assistant', content: <joined text>, tool_calls? }`
 * - system message      → `{ role: 'system', content: <text> }`
 */
function mapMessage(msg: Message): ChatHistoryItem {
  if (msg.role === 'user' && msg.source.kind === 'tool') {
    const resultBlock = msg.content[0]
    const text = resultBlock !== undefined && resultBlock.type === 'tool-result'
      ? extractText(resultBlock.content as { type: string; text?: unknown }[])
      : ''
    return { role: 'tool', content: text, ...{ tool_call_id: msg.source.callId } }
  }
  if (msg.role === 'assistant') {
    const text = extractText(msg.content as { type: string; text?: unknown }[])
    const toolCalls = msg.content.flatMap((block): Array<{ id: string; name: string; arguments: string }> => {
      if (block.type === 'tool-call') {
        return [{ id: String(block.id), name: block.name, arguments: block.arguments }]
      }
      return []
    })
    return {
      role: 'assistant',
      content: text,
      ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    }
  }
  if (msg.role === 'system') {
    return { role: 'system', content: extractText(msg.content as { type: string; text?: unknown }[]) }
  }
  // user
  return { role: 'user', content: extractText(msg.content as { type: string; text?: unknown }[]) }
}

/**
 * Convert a harness request (system prompt + messages + tools) into the
 * cloud-direct chat shapes. The system prompt is prepended as a `system`
 * message; `collapseSystemIntoUser` inlines it into the next user turn.
 */
export function mapToChatHistory(options: {
  system?: string
  messages: readonly Message[]
  tools?: readonly ToolSchema[]
}): MappedChat {
  const messages: ChatHistoryItem[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const msg of options.messages) {
    messages.push(mapMessage(msg))
  }
  const tools: ToolDef[] = (options.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
  }))
  return { messages, tools }
}

/** Re-export the content-part union for consumers that build history by hand. */
export type { ContentPart }
