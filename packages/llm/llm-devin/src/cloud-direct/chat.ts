/**
 * Cloud-direct streaming chat: talks to
 * `server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage` with
 * no local language server in the path.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package (which derives the
 * transport from opencode-windsurf-auth). Supports single/multi-turn chat on
 * the prompt-and-history pattern, all models the account's api_key is
 * entitled to, and Connect-streaming deltas. The wire-format notes below are
 * the port's field map, verified against captured Windsurf language-server
 * traffic by the upstream projects.
 *
 * @module dsh-llm-devin/cloud-direct/chat
 */

import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import {
  bodyOf,
  encodeMessage,
  encodeString,
  encodeVarintField,
  frameConnectStream,
  iterFields,
} from './wire.ts'
import { buildMetadata } from './metadata.ts'
import { getCachedUserJwt } from './auth.ts'
import { getCachedCatalog, ModelNotAvailableError } from './catalog.ts'

/** Inactivity timeout — the cloud's own idle limit is ~90s on most models. */
const CLOUD_STREAM_IDLE_MS = 120_000
/** Time-to-first-byte timeout. */
const CLOUD_STREAM_TTFB_MS = 60_000

/** Compose multiple AbortSignals into one that aborts when ANY input aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof builtin === 'function') return builtin(signals)
  const controller = new AbortController()
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s.reason)
      break
    }
    s.addEventListener('abort', () => onAbort(s.reason), { once: true })
  }
  return controller.signal
}

// ----------------------------------------------------------------------------
// Per-(apiKey, host) session/cascade IDs — server-side context caching
// ----------------------------------------------------------------------------

interface SessionIds {
  sessionId: string
  cascadeId: string
}
const sessionCache = new Map<string, SessionIds>()

export function allocateCascadeId(): string {
  return crypto.randomUUID()
}

function getOrAllocateSessionIds(apiKey: string, host: string, cascadeIdOverride?: string): SessionIds {
  const key = `${host}\x1f${apiKey}`
  let ids = sessionCache.get(key)
  if (ids === undefined) {
    ids = {
      sessionId: crypto.randomUUID(),
      cascadeId: cascadeIdOverride ?? allocateCascadeId(),
    }
    sessionCache.set(key, ids)
  } else if (cascadeIdOverride !== undefined && ids.cascadeId !== cascadeIdOverride) {
    ids = { sessionId: ids.sessionId, cascadeId: cascadeIdOverride }
    sessionCache.set(key, ids)
  }
  return ids
}

/** Drop the cached session IDs — call after logout so a new sign-in starts fresh. */
export function clearSessionIds(): void {
  sessionCache.clear()
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64Data: string; caption?: string }

export interface ChatHistoryItem {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
}

export interface ToolDef {
  name: string
  description: string
  parameters: unknown
}

/**
 * Streaming event emitted by the cloud-direct chat loop. There is no
 * `tool_call_end` event: Cognition's wire format ends a tool call implicitly
 * when a new `tool_call_start` fires or the stream finishes.
 */
export type CloudChatEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call_start'; id: string; name: string }
  | { kind: 'tool_call_args'; argsDelta: string; id?: string }
  | { kind: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' }
  | {
    kind: 'usage'
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    cacheCreationInputTokens?: number
    reasoningTokens?: number
  }

// ----------------------------------------------------------------------------
// Request encoders
// ----------------------------------------------------------------------------

function encodeImageData(img: { mimeType: string; base64Data: string; caption?: string }): Buffer {
  const parts: Buffer[] = [
    encodeString(1, img.base64Data),
    encodeString(2, img.mimeType),
  ]
  if (img.caption !== undefined) parts.push(encodeString(3, img.caption))
  return Buffer.concat(parts)
}

function encodeChatToolCall(tc: { id: string; name: string; arguments: string }): Buffer {
  return Buffer.concat([
    encodeString(1, tc.id),
    encodeString(2, tc.name),
    encodeString(3, tc.arguments),
  ])
}

function encodeChatMessagePrompt(
  content: ContentPart[],
  source: number,
  opts?: { toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> },
): Buffer {
  const textParts = content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
  const imageParts = content.filter(
    (p): p is { type: 'image'; mimeType: string; base64Data: string; caption?: string } => p.type === 'image',
  )
  const joined = textParts.map(p => p.text).join('\n')
  const parts: Buffer[] = [
    encodeVarintField(2, source),
    encodeString(3, joined),
    encodeVarintField(4, Math.max(1, Math.floor(joined.length / 4))),
    encodeVarintField(5, 1),
  ]
  if (opts?.toolCallId !== undefined) {
    parts.push(encodeString(7, opts.toolCallId))
  }
  if (opts?.toolCalls !== undefined && opts.toolCalls.length > 0) {
    for (const tc of opts.toolCalls) {
      parts.push(encodeMessage(6, encodeChatToolCall(tc)))
    }
  }
  for (const img of imageParts) {
    parts.push(encodeMessage(10, encodeImageData(img)))
  }
  return Buffer.concat(parts)
}

const SOURCE_BY_ROLE: Record<string, number> = {
  user: 1,
  assistant: 2,
  // Do NOT send source=3 (SYSTEM): the backend rejects it. System context is
  // inlined into the next user turn (see collapseSystemIntoUser).
  system: 1,
  tool: 4,
}

/**
 * Collapse OpenAI-style messages so all `role:'system'` entries are inlined
 * into the immediately-following user message, matching the wire format the
 * IDE uses. Cognition's chat backend rejects raw role=system entries.
 */
function collapseSystemIntoUser(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  let pendingSystem: string[] = []

  const flushTextOf = (content: ContentPart[]): string =>
    content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text).join('\n')

  for (const m of messages) {
    if (m.role === 'system') {
      const text = flushTextOf(normalizeContent(m.content))
      if (text) pendingSystem.push(text)
    } else if (m.role === 'user' && pendingSystem.length > 0) {
      const userParts = normalizeContent(m.content)
      const userText = flushTextOf(userParts)
      const userImages = userParts.filter((p): p is ContentPart & { type: 'image' } => p.type === 'image')
      const wrapped = `<system>\n${pendingSystem.join('\n\n')}\n</system>\n${userText}`
      out.push({ role: 'user', content: [{ type: 'text', text: wrapped }, ...userImages] })
      pendingSystem = []
    } else {
      out.push(m)
    }
  }
  if (pendingSystem.length > 0) {
    out.push({
      role: 'user',
      content: [{ type: 'text', text: `<system>\n${pendingSystem.join('\n\n')}\n</system>` }],
    })
  }
  return out
}

function encodeCompletionConfiguration(opts: {
  maxOutputTokens?: number
  maxInputTokens?: number
  temperature?: number
  topK?: number
  topP?: number
}): Buffer {
  const enc64 = (fieldNum: number, n: number): Buffer => {
    const b = Buffer.alloc(8)
    b.writeDoubleLE(n, 0)
    return Buffer.concat([Buffer.from([(fieldNum << 3) | 1]), b])
  }
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, opts.maxInputTokens ?? 64000),
    encodeVarintField(3, opts.maxOutputTokens ?? 128_000),
    enc64(5, opts.temperature ?? 0.7),
    enc64(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    enc64(8, 1.0),
    enc64(11, 1.0),
  ])
}

/** Normalize ChatHistoryItem content into structured parts. */
function normalizeContent(content: string | ContentPart[] | unknown): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out: ContentPart[] = []
  for (const p of content as Array<Record<string, unknown>>) {
    if (p === null || typeof p !== 'object') continue
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'text', text: p.text })
    } else if (p.type === 'image' && typeof p.base64Data === 'string') {
      const mimeType = typeof p.mimeType === 'string' ? p.mimeType : 'image/png'
      const caption = typeof p.caption === 'string' ? p.caption : undefined
      out.push({
        type: 'image',
        mimeType,
        base64Data: p.base64Data,
        ...caption !== undefined ? { caption } : {},
      })
    } else if (p.type === 'image_url' && p.image_url !== undefined && p.image_url !== null) {
      const imgRef = p.image_url as string | { url?: string }
      const url: string = typeof imgRef === 'string' ? imgRef : (imgRef.url ?? '')
      const m = url.match(/^data:([^;]+);base64,(.+)$/)
      if (m !== null) out.push({ type: 'image', mimeType: m[1] ?? 'image/png', base64Data: m[2] ?? '' })
      else if (url) out.push({ type: 'text', text: `[image url: ${url}]` })
    }
  }
  return out
}

/**
 * The Codeium tool validator rejects descriptions at exactly 7,000 chars with
 * a misleading MCP error; truncate to a safe margin.
 */
const MAX_TOOL_DESC_LEN = 6998

function encodeToolDef(tool: ToolDef): Buffer {
  const rawDesc = tool.description ?? ''
  const desc =
    rawDesc.length > MAX_TOOL_DESC_LEN
      ? rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24) + '\n…(truncated for cloud)'
      : rawDesc
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, desc),
    encodeString(3, JSON.stringify(tool.parameters ?? {})),
  ])
}

interface BuildArgs {
  apiKey: string
  userJwt: string
  modelUid: string
  messages: ChatHistoryItem[]
  cascadeId: string
  promptId: string
  sessionId: string
  requestId: bigint
  triggerId: string
  tools?: ToolDef[]
  requestType?: number
  completionOpts?: {
    maxOutputTokens?: number
    maxInputTokens?: number
    temperature?: number
    topK?: number
    topP?: number
  }
}

function buildGetChatMessageRequest(args: BuildArgs): Buffer {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId,
  })

  const collapsed = collapseSystemIntoUser(args.messages)
  const promptParts = collapsed.map(m =>
    encodeMessage(
      3,
      encodeChatMessagePrompt(
        normalizeContent(m.content),
        SOURCE_BY_ROLE[m.role] ?? 1,
        {
          ...m.role === 'tool' && m.tool_call_id !== undefined ? { toolCallId: m.tool_call_id } : {},
          ...m.role === 'assistant' && m.tool_calls !== undefined ? { toolCalls: m.tool_calls } : {},
        },
      ),
    ),
  )

  const completion = encodeCompletionConfiguration(args.completionOpts ?? {})
  const toolParts: Buffer[] = (args.tools ?? []).map(t => encodeMessage(10, encodeToolDef(t)))

  // Field layout from captured LS traffic:
  //   #1 metadata, #3 chat_message_prompts, #7 request_type, #8 completion,
  //   #10 tools, #16 cascade_id, #21 chat_model_uid, #22 prompt_id
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...promptParts,
    encodeVarintField(7, args.requestType ?? 5),
    encodeMessage(8, completion),
    ...toolParts,
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId),
  ])
}

// ----------------------------------------------------------------------------
// Response parsing
// ----------------------------------------------------------------------------

/**
 * Decode one streaming ChatMessage proto frame into CloudChatEvents:
 *   ChatMessage {
 *     #5 finish_reason (varint — 10 = tool_calls)
 *     #6 ToolCallDelta { #1 id, #2 name, #3 arguments_delta }
 *     #7 ChatStatus { #6 status_code, #9 model_name }
 *     #9 delta_text (visible answer)
 *     #3 delta_text (thinking / chain-of-thought)
 *     #28 UsageStats
 *   }
 * Verified live by the upstream project: #3 streams the visible answer while
 * #9 streams the meta-narration — the mapping here matches that capture.
 */
function* decodeChatFrame(proto: Buffer): Generator<CloudChatEvent> {
  for (const f of iterFields(proto)) {
    if (f.num === 3 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const s = (f.value as Buffer).toString('utf8')
      if (s) yield { kind: 'text', text: s }
    } else if (f.num === 9 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const s = (f.value as Buffer).toString('utf8')
      if (s) yield { kind: 'reasoning', text: s }
    } else if (f.num === 6 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      let id: string | undefined
      let name: string | undefined
      let argsDelta: string | undefined
      for (const sf of iterFields(f.value as Buffer)) {
        if (sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          const s = (sf.value as Buffer).toString('utf8')
          if (sf.num === 1) id = s
          else if (sf.num === 2) name = s
          else if (sf.num === 3) argsDelta = s
        }
      }
      if (id !== undefined && name !== undefined) {
        yield { kind: 'tool_call_start', id, name }
      }
      if (argsDelta !== undefined) {
        yield { kind: 'tool_call_args', argsDelta, ...id !== undefined ? { id } : {} }
      }
    } else if (f.num === 5 && f.wire === 0) {
      const v = Number(f.value)
      // exa.codeium_common_pb.StopReason → OpenAI finish_reason:
      //   0 UNSPECIFIED → stop | 1 INCOMPLETE → length | 2 STOP_PATTERN → stop
      //   3 MAX_TOKENS → length | 10 FUNCTION_CALL → tool_calls
      //   11 CONTENT_FILTER → content_filter | others → stop
      let reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop'
      if (v === 10) reason = 'tool_calls'
      else if (v === 11) reason = 'content_filter'
      else if (v === 1 || v === 3) reason = 'length'
      yield { kind: 'finish', reason }
    } else if (f.num === 28 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const usage = decodeUsageBlock(f.value as Buffer)
      if (usage !== null) yield usage
    }
  }
}

/**
 * UsageStats block at proto field #28. Each UsageEntry has a metric_id
 * (`input_tokens`, `output_tokens`, …) and a displayed value.
 */
function decodeUsageBlock(buf: Buffer): CloudChatEvent | null {
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  let cachedInputTokens: number | undefined
  let cacheCreationInputTokens: number | undefined
  let reasoningTokens: number | undefined

  for (const f of iterFields(buf)) {
    if (f.num !== 2 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue
    let entryMetric: string | undefined
    let entryValue: number | undefined
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 5 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        entryMetric = (sf.value as Buffer).toString('utf8')
      } else if (sf.num === 4 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        for (const ssf of iterFields(sf.value as Buffer)) {
          if (ssf.num === 2 && ssf.wire === 5 && Buffer.isBuffer(ssf.value)) {
            entryValue = (ssf.value as Buffer).readFloatLE(0)
            break
          }
        }
      }
    }
    if (entryMetric !== undefined && entryValue !== undefined && Number.isFinite(entryValue)) {
      const n = Math.round(entryValue)
      if (entryMetric === 'input_tokens') promptTokens = n
      else if (entryMetric === 'output_tokens') completionTokens = n
      else if (entryMetric === 'cached_input_tokens' || entryMetric === 'cache_read_input_tokens') {
        cachedInputTokens = (cachedInputTokens ?? 0) + n
      } else if (entryMetric === 'cache_creation_input_tokens') {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + n
      } else if (entryMetric === 'reasoning_tokens' || entryMetric === 'output_reasoning_tokens') {
        reasoningTokens = (reasoningTokens ?? 0) + n
      }
    }
  }
  if (promptTokens === undefined && completionTokens === undefined) return null
  const total = (promptTokens ?? 0) + (completionTokens ?? 0)
  return {
    kind: 'usage',
    ...promptTokens !== undefined ? { promptTokens } : {},
    ...completionTokens !== undefined ? { completionTokens } : {},
    ...total > 0 ? { totalTokens: total } : {},
    ...cachedInputTokens !== undefined ? { cachedInputTokens } : {},
    ...cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {},
    ...reasoningTokens !== undefined ? { reasoningTokens } : {},
  }
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export interface CloudChatRequest {
  /** Persistent OAuth-issued api_key (`devin-session-token$<JWT>`). */
  apiKey: string
  /** Pre-resolved API server URL from RegisterUser (falls back to default). */
  apiServerUrl?: string
  /** Model UID — e.g. `swe-1-7-lightning`. */
  modelUid: string
  /** Chat history. */
  messages: ChatHistoryItem[]
  /** Tool definitions available to the model. */
  tools?: ToolDef[]
  /** Cascade ID — reuse across turns of the same conversation. */
  cascadeId?: string
  /** Optional sampling overrides. */
  completionOpts?: BuildArgs['completionOpts']
  /** Override request_type (default = 5, CASCADE). */
  requestType?: number
  /** Abort signal — closes the fetch stream. */
  signal?: AbortSignal
  /** Extra headers merged into every request (app attribution). */
  extraHeaders?: Readonly<Record<string, string>>
}

export class CloudChatError extends Error {
  constructor(message: string, public readonly code?: string, public readonly traceId?: string) {
    super(message)
    this.name = 'CloudChatError'
  }
}

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i

/**
 * Stream chat events from the cloud. Yields CloudChatEvent deltas; throws
 * {@link CloudChatError} with the cloud's `code` + `traceId` on failure.
 */
export async function* streamChatEvents(req: CloudChatRequest): AsyncGenerator<CloudChatEvent> {
  const host = (req.apiServerUrl ?? 'https://server.codeium.com').replace(/\/$/, '')
  const userJwt = await getCachedUserJwt(req.apiKey, host, req.signal, req.extraHeaders)

  // Pre-flight: consult the per-account model catalog (best-effort).
  const catalog = await getCachedCatalog(req.apiKey, host, req.signal, req.extraHeaders).catch(() => null)
  if (catalog !== null) {
    const entry = catalog.byUid.get(req.modelUid)
    if (entry === undefined) {
      throw new ModelNotAvailableError(req.modelUid, req.modelUid, 'not_listed')
    }
    if (entry.disabled) {
      throw new ModelNotAvailableError(req.modelUid, entry.label, 'disabled')
    }
  }

  const sessionIds = getOrAllocateSessionIds(req.apiKey, host, req.cascadeId)

  const proto = buildGetChatMessageRequest({
    apiKey: req.apiKey,
    userJwt,
    modelUid: req.modelUid,
    messages: req.messages,
    ...req.tools !== undefined ? { tools: req.tools } : {},
    cascadeId: sessionIds.cascadeId,
    promptId: crypto.randomUUID(),
    sessionId: sessionIds.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
    ...req.requestType !== undefined ? { requestType: req.requestType } : {},
    ...req.completionOpts !== undefined ? { completionOpts: req.completionOpts } : {},
  })
  const body = frameConnectStream(proto, true)

  const ttfbController = new AbortController()
  const ttfbTimer = setTimeout(
    () => ttfbController.abort(new Error(`cloud-direct: time-to-first-byte timeout (${CLOUD_STREAM_TTFB_MS}ms)`)),
    CLOUD_STREAM_TTFB_MS,
  )
  const ttfbSignal = ttfbController.signal
  const initialSignal: AbortSignal = req.signal !== undefined ? anySignal([req.signal, ttfbSignal]) : ttfbSignal

  let resp: Response
  try {
    resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/connect+proto',
        'Connect-Protocol-Version': '1',
        'Connect-Content-Encoding': 'gzip',
        'Connect-Accept-Encoding': 'gzip',
        ...req.extraHeaders,
      },
      body: bodyOf(body),
      signal: initialSignal,
    })
  } finally {
    clearTimeout(ttfbTimer)
  }

  if (!resp.ok) {
    const text = await resp.text()
    throw new CloudChatError(`GetChatMessage HTTP ${resp.status}: ${text.slice(0, 300)}`, undefined)
  }
  if (resp.body === null) {
    throw new CloudChatError('GetChatMessage response had no body stream')
  }

  // Incremental frame parsing with a running offset (O(n) over the stream).
  const chunkQueue: Buffer[] = []
  let queuedBytes = 0
  const reader = resp.body.getReader()
  let trailerError: { code?: string; message: string; traceId?: string } | null = null
  let sawEos = false

  function peek(n: number): Buffer | null {
    if (queuedBytes < n) return null
    if (chunkQueue.length === 1) {
      const head = chunkQueue[0]
      if (head !== undefined && head.length >= n) return head.slice(0, n)
    }
    const parts: Buffer[] = []
    let remaining = n
    for (const c of chunkQueue) {
      if (remaining <= 0) break
      if (c.length <= remaining) {
        parts.push(c)
        remaining -= c.length
      } else {
        parts.push(c.slice(0, remaining))
        remaining = 0
      }
    }
    return Buffer.concat(parts, n)
  }

  function drop(n: number): void {
    queuedBytes -= n
    let remaining = n
    while (remaining > 0 && chunkQueue.length > 0) {
      const head = chunkQueue[0]
      if (head === undefined) break
      if (head.length <= remaining) {
        chunkQueue.shift()
        remaining -= head.length
      } else {
        chunkQueue[0] = head.slice(remaining)
        remaining = 0
      }
    }
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const resetIdle = (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      const idleController = new AbortController()
      idleTimer = setTimeout(
        () => idleController.abort(new Error(`cloud-direct: idle timeout (${CLOUD_STREAM_IDLE_MS}ms with no bytes)`)),
        CLOUD_STREAM_IDLE_MS,
      )
      return new Promise((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          fn()
        }
        const readP = reader.read()
        readP.catch(() => { /* swallowed; outer promise already settled */ })
        idleController.signal.addEventListener('abort', () => {
          try { void resp.body?.cancel(idleController.signal.reason ?? new Error('idle abort')) } catch { /* */ }
          settle(() => reject(idleController.signal.reason ?? new Error('idle abort')))
        }, { once: true })
        readP.then(
          v => settle(() => resolve(v)),
          e => settle(() => reject(e)),
        )
      })
    }

    while (true) {
      const { value, done } = await resetIdle()
      if (done) break
      if (value !== undefined) {
        chunkQueue.push(Buffer.from(value))
        queuedBytes += value.length
      }

      while (queuedBytes >= 5) {
        const header = peek(5)
        if (header === null) break
        const flags = header[0]
        if (flags === undefined) break
        const len = header.readUInt32BE(1)
        if (queuedBytes < 5 + len) break
        drop(5)
        const raw = peek(len) ?? Buffer.alloc(0)
        drop(len)

        let payload = raw
        if (flags & 0x01) {
          try {
            payload = zlib.gunzipSync(raw)
          } catch (gzipErr) {
            throw new CloudChatError(`Connect frame gunzip failed: ${(gzipErr as Error).message}`)
          }
        }
        const eos = (flags & 0x02) !== 0

        if (eos) {
          sawEos = true
          const text = payload.toString('utf8')
          if (text && text.includes('"error"')) {
            let code: string | undefined
            let message = text
            try {
              const j = JSON.parse(text) as { error?: { code?: string; message?: string } }
              code = j.error?.code
              if (j.error?.message !== undefined) message = j.error.message
            } catch { /* keep raw */ }
            const traceMatch = message.match(TRACE_ID_RE)
            trailerError = {
              message,
              ...code !== undefined ? { code } : {},
              ...traceMatch?.[1] !== undefined ? { traceId: traceMatch[1] } : {},
            }
          }
          continue
        }
        yield* decodeChatFrame(payload)
      }
    }
  } finally {
    if (idleTimer !== null) clearTimeout(idleTimer)
    try { reader.releaseLock() } catch { /* */ }
    try { void resp.body?.cancel() } catch { /* */ }
  }

  if (trailerError !== null) {
    const isOpaquePermissionDenial =
      trailerError.code === 'permission_denied' &&
      /an internal error occurred/i.test(trailerError.message)
    if (isOpaquePermissionDenial) {
      const enriched =
        `Cognition denied this request for model "${req.modelUid}" with the opaque ` +
        '"an internal error occurred" message. This almost always means the model ' +
        'is not enabled for your account/tier — see https://codeium.com/account. ' +
        `(cloud trace ID: ${trailerError.traceId ?? 'n/a'}; raw message: ${trailerError.message})`
      throw new CloudChatError(enriched, trailerError.code, trailerError.traceId)
    }
    throw new CloudChatError(trailerError.message, trailerError.code, trailerError.traceId)
  }
  if (!sawEos) {
    throw new CloudChatError(
      `Cloud stream ended without EOS trailer (${queuedBytes} bytes orphaned). ` +
      'Connection likely dropped mid-response.',
      'truncated_stream',
    )
  }
}

/** Back-compat: yield text content only (drops tool calls). */
export async function* streamChat(req: CloudChatRequest): AsyncGenerator<string> {
  for await (const ev of streamChatEvents(req)) {
    if (ev.kind === 'text') yield ev.text
  }
}
