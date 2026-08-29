/**
 * Message-mapping tests: harness Message[] → cloud-direct ChatHistoryItem[].
 */

import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mapToChatHistory } from '../src/message.ts'

describe('mapToChatHistory', () => {
  it('prepends the system prompt and maps user text', () => {
    const user = createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })
    const { messages } = mapToChatHistory({ system: 'sys', messages: [user] })
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('maps assistant text and tool calls with raw JSON arguments', () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool-call', id: CallId('tc-9'), name: 'read', arguments: '{"path":"a"}' },
      ],
      source: { provider: 'devin', model: 'swe-1-7' },
    })
    const { messages } = mapToChatHistory({ messages: [assistant] })
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'tc-9', name: 'read', arguments: '{"path":"a"}' }],
      },
    ])
  })

  it('maps tool results with their call id', () => {
    const result = createToolResultMessage({
      callId: CallId('tc-9'),
      content: [{ type: 'text', text: 'the answer' }],
      isError: false,
    })
    const { messages } = mapToChatHistory({ messages: [result] })
    expect(messages).toEqual([
      { role: 'tool', content: 'the answer', tool_call_id: 'tc-9' },
    ])
  })

  it('maps tool schemas into ToolDefs', () => {
    const user = createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    })
    const { tools } = mapToChatHistory({
      messages: [user],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    })
    expect(tools).toEqual([{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }])
  })
})
