/**
 * Translation tests: CloudChatEvent sequences → StreamChunks.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CloudChatEvent } from '../src/cloud-direct/chat.ts'
import { translateEvents } from '../src/stream.ts'

async function collect(events: CloudChatEvent[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateEvents(events)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('translateEvents', () => {
  it('assembles a text-only turn with usage before finish', async () => {
    const events: CloudChatEvent[] = [
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
      { kind: 'usage', promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      { kind: 'finish', reason: 'stop' },
    ]
    const chunks = await collect(events)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('separates reasoning deltas into reasoning blocks', async () => {
    const events: CloudChatEvent[] = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: 'answer' },
      { kind: 'finish', reason: 'stop' },
    ]
    const chunks = await collect(events)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles tool-call blocks with raw JSON arguments', async () => {
    const events: CloudChatEvent[] = [
      { kind: 'tool_call_start', id: 'tc-1', name: 'read' },
      { kind: 'tool_call_args', argsDelta: '{"path":' },
      { kind: 'tool_call_args', argsDelta: '"a.txt"}' },
      { kind: 'finish', reason: 'tool_calls' },
    ]
    const chunks = await collect(events)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'tc-1', name: 'read', argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 0, id: 'tc-1', name: 'read', argumentsDelta: '"a.txt"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'tc-1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('surfaces usage that arrives after the finish frame (Cognition ordering)', async () => {
    const events: CloudChatEvent[] = [
      { kind: 'text', text: 'ok' },
      { kind: 'finish', reason: 'stop' },
      { kind: 'usage', promptTokens: 76, completionTokens: 21, totalTokens: 97, cachedInputTokens: 320 },
    ]
    const chunks = await collect(events)
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 76, outputTokens: 21, cacheReadTokens: 320 },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('implicitly closes a tool call when a new one starts', async () => {
    const events: CloudChatEvent[] = [
      { kind: 'tool_call_start', id: 'a', name: 'one' },
      { kind: 'tool_call_args', argsDelta: '{}' },
      { kind: 'tool_call_start', id: 'b', name: 'two' },
      { kind: 'tool_call_args', argsDelta: '{"k":1}' },
      { kind: 'finish', reason: 'tool_calls' },
    ]
    const chunks = await collect(events)
    const blockEnds = chunks.filter(c => c.type === 'block-end')
    expect(blockEnds).toHaveLength(2)
    expect(blockEnds[0]).toMatchObject({ block: { type: 'tool-call', id: 'a', arguments: '{}' } })
    expect(blockEnds[1]).toMatchObject({ block: { type: 'tool-call', id: 'b', arguments: '{"k":1}' } })
  })

  it('maps length and content_filter finishes', async () => {
    const length = await collect([{ kind: 'finish', reason: 'length' }])
    expect(length.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    const filtered = await collect([{ kind: 'finish', reason: 'content_filter' }])
    const finish = filtered.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.reason.kind).toBe('error')
    }
  })

  it('carries cache and reasoning usage counts when present', async () => {
    const chunks = await collect([
      { kind: 'usage', promptTokens: 5, completionTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 },
      { kind: 'finish', reason: 'stop' },
    ])
    const usage = chunks.find(c => c.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, reasoningTokens: 1 },
    })
  })

  it('throws STREAM_CLOSED when the source ends without finish', async () => {
    await expect(collect([{ kind: 'text', text: 'x' }])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
