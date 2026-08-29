/**
 * A minimal in-process Connect-RPC mock of the Cognition endpoints the
 * adapter talks to: GetUserJwt (unary), GetCascadeModelConfigs (unary), and
 * GetChatMessage (Connect-streaming).
 */

import { createServer, type Server } from 'node:http'
import {
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
} from '../src/cloud-direct/wire.ts'

function fakeJwt(ttlSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJl`
}

/** UsageStats entry: { #4 dimension { #2 fixed32 float }, #5 metric_id }. */
function usageEntry(metric: string, value: number): Buffer {
  const float = Buffer.alloc(4)
  float.writeFloatLE(value, 0)
  const dim = Buffer.concat([Buffer.from([(2 << 3) | 5]), float])
  return encodeMessage(2, Buffer.concat([encodeMessage(4, dim), encodeString(5, metric)]))
}

/** UsageStats block at proto field #28. */
export function usageBlock(inputTokens: number, outputTokens: number): Buffer {
  return encodeMessage(28, Buffer.concat([
    usageEntry('input_tokens', inputTokens),
    usageEntry('output_tokens', outputTokens),
  ]))
}

function textFrame(text: string): Buffer {
  return frameConnectStream(encodeString(3, text), true)
}

function reasoningFrame(text: string): Buffer {
  return frameConnectStream(encodeString(9, text), true)
}

function toolStartFrame(id: string, name: string): Buffer {
  return frameConnectStream(
    encodeMessage(6, Buffer.concat([encodeString(1, id), encodeString(2, name)])),
    true,
  )
}

function toolArgsFrame(argsDelta: string): Buffer {
  return frameConnectStream(encodeMessage(6, encodeString(3, argsDelta)), true)
}

function finishFrame(reason: number): Buffer {
  return frameConnectStream(encodeVarintField(5, reason), true)
}

/** EOS trailer frame (flags 0x02) carrying an optional payload. */
export function eosFrame(): Buffer {
  return Buffer.from([0x02, 0, 0, 0, 0])
}

function eosPayloadFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header[0] = 0x02
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

export interface MockChatScene {
  /** text deltas emitted in order */
  texts?: string[]
  /** reasoning deltas emitted in order */
  reasoning?: string[]
  /** tool call (id, name) then args deltas */
  tool?: { id: string; name: string; args: string[] }
  inputTokens?: number
  outputTokens?: number
  finishReason?: number
  /** When set, the trailer carries a JSON error instead of succeeding. */
  trailerError?: { code: string; message: string }
  /** Catalog entries served by GetCascadeModelConfigs (default: swe-1-7 only). */
  catalog?: { label: string; modelUid: string; disabled?: boolean }[]
}

export interface MockServer {
  server: Server
  port: number
  /** Requests seen by path, for assertions. */
  seen: Map<string, number>
  /** Headers of the most recent GetChatMessage request. */
  lastChatHeaders: Record<string, string> | undefined
  close: () => Promise<void>
}

/** Start the mock server; returns host-relative facts for the adapter. */
export async function startMockServer(scene: MockChatScene): Promise<MockServer> {
  const seen = new Map<string, number>()
  let lastChatHeaders: Record<string, string> | undefined
  const server = createServer((req, res) => {
    const path = req.url ?? ''
    seen.set(path, (seen.get(path) ?? 0) + 1)

    if (path.endsWith('/exa.auth_pb.AuthService/GetUserJwt')) {
      res.writeHead(200, { 'Content-Type': 'application/proto' })
      res.end(encodeString(1, fakeJwt(3600)))
      return
    }

    if (path.endsWith('/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs')) {
      // Repeated ClientModelConfig: { #1 label, #4 disabled, #22 model_uid }.
      const catalog = scene.catalog ?? [{ label: 'SWE-1.7', modelUid: 'swe-1-7' }]
      const entries = catalog.map(entry => encodeMessage(1, Buffer.concat([
        encodeString(1, entry.label),
        encodeVarintField(4, entry.disabled === true ? 1 : 0),
        encodeString(22, entry.modelUid),
      ])))
      res.writeHead(200, { 'Content-Type': 'application/proto' })
      res.end(Buffer.concat(entries))
      return
    }

    if (path.endsWith('/exa.api_server_pb.ApiServerService/GetChatMessage')) {
      lastChatHeaders = req.headers as Record<string, string>
      const frames: Buffer[] = []
      for (const t of scene.texts ?? []) frames.push(textFrame(t))
      for (const r of scene.reasoning ?? []) frames.push(reasoningFrame(r))
      if (scene.tool !== undefined) {
        frames.push(toolStartFrame(scene.tool.id, scene.tool.name))
        for (const a of scene.tool.args) frames.push(toolArgsFrame(a))
      }
      if (scene.inputTokens !== undefined || scene.outputTokens !== undefined) {
        frames.push(frameConnectStream(usageBlock(scene.inputTokens ?? 0, scene.outputTokens ?? 0), true))
      }
      if (scene.trailerError !== undefined) {
        frames.push(eosPayloadFrame(Buffer.from(JSON.stringify({ error: scene.trailerError }))))
      } else {
        frames.push(finishFrame(scene.finishReason ?? 2))
        frames.push(eosFrame())
      }
      res.writeHead(200, {
        'Content-Type': 'application/connect+proto',
        'Connect-Protocol-Version': '1',
      })
      res.end(Buffer.concat(frames))
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server: no port')
  return {
    server,
    port: address.port,
    seen,
    get lastChatHeaders(): Record<string, string> | undefined {
      return lastChatHeaders
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  }
}
