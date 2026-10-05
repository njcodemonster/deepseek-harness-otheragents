/**
 * Pure mapping from the harness conversation vocabulary (`RequestMessage[]` +
 * `GenerateOptions.system`) into the shapes the cloud-direct gRPC layer
 * expects (`ChatHistoryItem[]` + `ToolDef[]`).
 *
 * No side effects, no I/O — trivially unit-testable.
 *
 * @module dsh-llm-devin/message
 */

import type { ContentBlock, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ChatHistoryItem, ToolDef } from './cloud-direct/chat.ts'

export interface MappedChat {
  messages: ChatHistoryItem[]
  tools: ToolDef[]
}

/** Join every text block in a content list. Reasoning/tool-call blocks are skipped. */
function extractText(content: readonly ContentBlock[]): string {
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text') texts.push(block.text)
  }
  return texts.join('\n')
}

/**
 * Map one harness {@link RequestMessage} into a cloud-direct
 * {@link ChatHistoryItem}.
 *
 * - tool message       → `{ role: 'tool', content: <result text>, tool_call_id }`
 * - assistant message  → `{ role: 'assistant', content: <text>, tool_calls? }`
 * - system message     → `{ role: 'system', content: <text> }`
 * - developer message  → skipped (the adapter sends the complete tool list every
 *   request, so tool-addition/removal blocks have no text to forward)
 * - user message       → `{ role: 'user', content: <joined text> }`
 */
function mapMessage(msg: RequestMessage): ChatHistoryItem | undefined {
  if (msg.role === 'developer') return undefined
  if (msg.role === 'tool') {
    return { role: 'tool', content: extractText(msg.content), ...{ tool_call_id: String(msg.toolCallId) } }
  }
  if (msg.role === 'assistant') {
    const text = extractText(msg.content)
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
    return { role: 'system', content: extractText(msg.content) }
  }
  // user (a durable UserMessage or an identity-free RequestUserInput)
  return { role: 'user', content: extractText(msg.content) }
}

/**
 * Convert a harness request (system prompt + messages + tools) into the
 * cloud-direct chat shapes. The system prompt is prepended as a `system`
 * message; `collapseSystemIntoUser` inlines it into the next user turn.
 */
export function mapToChatHistory(options: {
  system?: string
  messages: readonly RequestMessage[]
  tools?: readonly ToolSchema[]
}): MappedChat {
  const messages: ChatHistoryItem[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const msg of options.messages) {
    const mapped = mapMessage(msg)
    if (mapped !== undefined) messages.push(mapped)
  }
  const tools: ToolDef[] = (options.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
  }))
  return { messages, tools }
}

/** Re-export the content-part union for consumers that build history by hand. */
export type { ContentPart } from './cloud-direct/chat.ts'
