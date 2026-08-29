/**
 * Cloud-direct event translation into the Harness streaming protocol.
 *
 * The cloud-direct layer yields {@link CloudChatEvent} deltas with implicit
 * tool-call termination (a new `tool_call_start` or stream `finish` closes
 * the prior call). This module assembles them into `StreamChunk`s: block
 * starts/deltas/ends for text, reasoning, and tool-call blocks; one `usage`
 * chunk immediately before the terminal `finish`; raw-JSON tool arguments
 * end to end.
 *
 * @module dsh-llm-devin/stream
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CloudChatEvent } from './cloud-direct/chat.ts'

/** Map a cloud-direct usage event onto the harness token vocabulary. */
export function mapUsage(usage: Extract<CloudChatEvent, { kind: 'usage' }>): TokenUsage {
  return {
    inputTokens: usage.promptTokens ?? 0,
    outputTokens: usage.completionTokens ?? 0,
    ...usage.cachedInputTokens !== undefined ? { cacheReadTokens: usage.cachedInputTokens } : {},
    ...usage.cacheCreationInputTokens !== undefined ? { cacheWriteTokens: usage.cacheCreationInputTokens } : {},
    ...usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {},
  }
}

/** Map a cloud-direct finish reason onto the harness finish vocabulary. */
function finishFor(reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    case 'content_filter':
      return {
        kind: 'error',
        failure: { message: 'The model response was filtered by Cognition content policy', code: 'CONTENT_FILTER' },
      }
  }
}

/**
 * Translate the cloud-direct event stream into StreamChunks. Ends with one
 * `usage` chunk then a terminal `finish`; throws `LlmError` (`STREAM_CLOSED`)
 * if the source ends without a finish event.
 * @param events - the cloud-direct event stream for one model call.
 * @returns the harness chunks, ending with `usage` then `finish`.
 */
export async function* translateEvents(
  events: AsyncIterable<CloudChatEvent> | Iterable<CloudChatEvent>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textIndex: number | null = null
  let reasoningIndex: number | null = null
  let toolIndex: number | null = null
  let toolId = ''
  let toolName = ''
  let toolArgs = ''
  let textBuffer = ''
  let reasoningBuffer = ''
  let lastUsage: Extract<CloudChatEvent, { kind: 'usage' }> | undefined
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | undefined

  /** Close the open text block; returns the terminal chunk, or null. */
  const closeText = (): StreamChunk | null => {
    if (textIndex === null) return null
    const chunk: StreamChunk = { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } }
    textIndex = null
    textBuffer = ''
    return chunk
  }
  /** Close the open reasoning block; returns the terminal chunk, or null. */
  const closeReasoning = (): StreamChunk | null => {
    if (reasoningIndex === null) return null
    const chunk: StreamChunk = {
      type: 'block-end',
      index: reasoningIndex,
      block: { type: 'reasoning', text: reasoningBuffer },
    }
    reasoningIndex = null
    reasoningBuffer = ''
    return chunk
  }
  /** Close the open tool-call block; returns the terminal chunk, or null. */
  const closeTool = (): StreamChunk | null => {
    if (toolIndex === null) return null
    const chunk: StreamChunk = {
      type: 'block-end',
      index: toolIndex,
      block: { type: 'tool-call', id: ToolCallId(toolId), name: toolName, arguments: toolArgs },
    }
    toolIndex = null
    toolId = ''
    toolName = ''
    toolArgs = ''
    return chunk
  }

  for await (const ev of events) {
    switch (ev.kind) {
      case 'text': {
        const reasoningEnd = closeReasoning()
        if (reasoningEnd !== null) yield reasoningEnd
        const toolEnd = closeTool()
        if (toolEnd !== null) yield toolEnd
        if (textIndex === null) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textBuffer += ev.text
        yield { type: 'text-delta', index: textIndex, text: ev.text }
        break
      }
      case 'reasoning': {
        const textEnd = closeText()
        if (textEnd !== null) yield textEnd
        const toolEnd = closeTool()
        if (toolEnd !== null) yield toolEnd
        if (reasoningIndex === null) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        reasoningBuffer += ev.text
        yield { type: 'reasoning-delta', index: reasoningIndex, text: ev.text }
        break
      }
      case 'tool_call_start': {
        const textEnd = closeText()
        if (textEnd !== null) yield textEnd
        const reasoningEnd = closeReasoning()
        if (reasoningEnd !== null) yield reasoningEnd
        const toolEnd = closeTool()
        if (toolEnd !== null) yield toolEnd
        toolIndex = nextIndex++
        toolId = ev.id
        toolName = ev.name
        toolArgs = ''
        yield { type: 'block-start', index: toolIndex, blockType: 'tool-call' }
        break
      }
      case 'tool_call_args': {
        if (toolIndex === null) break // defensive: no start seen
        toolArgs += ev.argsDelta
        yield {
          type: 'tool-call-delta',
          index: toolIndex,
          id: ToolCallId(toolId),
          name: toolName,
          argumentsDelta: ev.argsDelta,
        }
        break
      }
      case 'usage': {
        lastUsage = ev
        break
      }
      case 'finish': {
        // Cognition sends the usage block AFTER the finish frame, so the
        // finish is recorded and the loop keeps draining; the terminal
        // chunks are emitted once the source ends.
        finishReason = ev.reason
        break
      }
    }
  }
  const textEnd = closeText()
  if (textEnd !== null) yield textEnd
  const reasoningEnd = closeReasoning()
  if (reasoningEnd !== null) yield reasoningEnd
  const toolEnd = closeTool()
  if (toolEnd !== null) yield toolEnd
  if (finishReason === undefined) {
    // The cloud-direct layer throws on a stream that ends without EOS, so a
    // missing finish here means the producer misbehaved — fail loud.
    throw new LlmError('devin: cloud event stream ended without a finish event', 'STREAM_CLOSED')
  }
  yield {
    type: 'usage',
    usage: lastUsage === undefined
      ? { inputTokens: 0, outputTokens: 0 }
      : mapUsage(lastUsage),
  }
  yield { type: 'finish', reason: finishFor(finishReason) }
}
