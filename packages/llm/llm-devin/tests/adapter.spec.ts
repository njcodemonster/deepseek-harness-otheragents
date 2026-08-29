/**
 * End-to-end adapter tests against the in-process mock Connect server.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DevinAdapter } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { startMockServer, type MockChatScene, type MockServer } from './mock-server.ts'

let currentMock: MockServer | undefined

afterEach(async () => {
  if (currentMock !== undefined) {
    await currentMock.close()
    currentMock = undefined
  }
})

async function withMock(scene: MockChatScene): Promise<MockServer> {
  const mock = await startMockServer(scene)
  currentMock = mock
  return mock
}

function adapterFor(mock: MockServer): DevinAdapter {
  return new DevinAdapter({
    options: () => resolveAdapterOptions({ baseURL: `http://127.0.0.1:${mock.port}` }),
    resolveCredential: async () => ({
      apiKey: 'devin-session-token$fake',
      apiServerUrl: `http://127.0.0.1:${mock.port}`,
    }),
  })
}

async function run(adapter: DevinAdapter, model = 'swe-1-7'): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const user = createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  })
  for await (const chunk of adapter.stream({
    provider: 'devin',
    model,
    messages: [user],
    system: 'sys',
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('DevinAdapter.stream', () => {
  it('streams a text completion with usage and a stop finish', async () => {
    const mock = await withMock({ texts: ['Hello ', 'world'], inputTokens: 7, outputTokens: 3 })
    const chunks = await run(adapterFor(mock))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // JWT mint, catalog pre-flight, and chat all hit the mock.
    expect(mock.seen.get('/exa.auth_pb.AuthService/GetUserJwt')).toBeGreaterThanOrEqual(1)
    expect(mock.seen.get('/exa.api_server_pb.ApiServerService/GetChatMessage')).toBe(1)
  })

  it('streams reasoning and tool-call blocks', async () => {
    const mock = await withMock({
      reasoning: ['thinking…'],
      tool: { id: 'tc-1', name: 'read', args: ['{"path":', '"a.txt"}'] },
      finishReason: 10,
    })
    const chunks = await run(adapterFor(mock))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'tc-1', name: 'read', argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 1, id: 'tc-1', name: 'read', argumentsDelta: '"a.txt"}' },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: 'tc-1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('maps a model-not-available catalog pre-flight to INVALID_REQUEST', async () => {
    const mock = await withMock({ texts: ['x'] })
    // The mock catalog only lists swe-1-7; ask for a model outside it.
    await expect(run(adapterFor(mock), 'claude-opus-4-8')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('surfaces an opaque permission denial as an AUTH error naming the model', async () => {
    const mock = await withMock({
      trailerError: { code: 'permission_denied', message: 'an internal error occurred (trace ID: deadbeef)' },
    })
    await expect(run(adapterFor(mock))).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('sends the app attribution user-agent header', async () => {
    const mock = await withMock({ texts: ['ok'] })
    const chunks = await run(adapterFor(mock))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(mock.lastChatHeaders?.['user-agent']).toMatch(/^deepseek-harness\//)
  })
})

describe('DevinAdapter.listModels', () => {
  it('reflects the account live catalog instead of the static fallback', async () => {
    const mock = await withMock({})
    const models = await adapterFor(mock).listModels('devin')
    expect(models.map(model => model.id)).toEqual(['swe-1-7'])
    expect(models[0]).toMatchObject({ provider: 'devin', name: 'SWE-1.7', inputModalities: ['text'] })
  })

  it('filters the live catalog to wanted families and skips disabled entries', async () => {
    const mock = await withMock({
      catalog: [
        { label: 'SWE-1.7', modelUid: 'swe-1-7' },
        { label: 'GPT-5.6 Luna High Thinking', modelUid: 'gpt-5-6-luna-high' },
        { label: 'GPT-5.6 Terra High Thinking', modelUid: 'gpt-5-6-terra-high', disabled: true },
        { label: 'Gemini 3.5 Flash High', modelUid: 'gemini-3-5-flash-high' },
      ],
    })
    const models = await adapterFor(mock).listModels('devin')
    expect(models.map(model => model.id)).toEqual(['swe-1-7', 'gpt-5-6-luna-high'])
  })

  it('falls back to the static catalog when no credential resolves', async () => {
    const adapter = new DevinAdapter({
      options: () => resolveAdapterOptions({}),
      resolveCredential: async () => { throw new Error('no credential') },
    })
    const models = await adapter.listModels('devin')
    expect(models.some(model => model.id === 'swe-1-7')).toBe(true)
    expect(models.some(model => model.id === 'claude-sonnet-5')).toBe(true)
  })

  it('resolves name and context metadata from the live catalog', async () => {
    const mock = await withMock({
      catalog: [{ label: 'GPT-5.6 Luna High Thinking', modelUid: 'gpt-5-6-luna-high' }],
    })
    const resolved = await adapterFor(mock).resolveModel('devin', 'gpt-5-6-luna-high')
    expect(resolved.name).toBe('GPT-5.6 Luna High Thinking')
    expect(resolved.context?.contextWindow).toBe(1_050_000)
  })
})
