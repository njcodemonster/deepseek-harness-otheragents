/**
 * Devin (Cognition / Windsurf) implementation of the Harness LLM seam.
 *
 * Each operation re-reads the current connection facts and resolves the
 * credential once, so a configuration change reaches the next request without
 * a restart while an in-flight stream keeps the facts it started with.
 * Streaming goes through the cloud-direct gRPC-Connect transport
 * (`streamChatEvents`) and the event translation in `stream.ts`.
 *
 * @module dsh-llm-devin/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { CloudChatError, streamChatEvents } from './cloud-direct/chat.ts'
import { getCachedCatalog, ModelNotAvailableError } from './cloud-direct/catalog.ts'
import { mapToChatHistory } from './message.ts'
import { translateEvents } from './stream.ts'
import { buildLiveModels } from './models.ts'
import type { DevinCatalogModel } from './models.ts'
import type { DevinCredential } from './login.ts'

/** One resolution's complete request facts, validated at resolution time. */
export interface ResolvedDevinOptions {
  /** Credential reference resolved per request; `DEVIN_API_KEY` by default. */
  apiKeyEnv: CredentialRef
  /** API server base URL; the account's RegisterUser value wins when stored. */
  baseURL: string
  /** Advisory model catalog in adapter-preferred order. */
  models: readonly DevinCatalogModel[]
  /** Deployment-chosen default output cap; absent means provider default. */
  maxTokens?: number
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Provider-owned model-request retry policy. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link DevinAdapter}. */
export interface DevinAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => ResolvedDevinOptions
  /**
   * Resolve the credential for one request: the long-lived Devin API key and,
   * when known, the account's API server URL. Called once per stream call and
   * frozen for that call.
   */
  resolveCredential: (connection: ResolvedDevinOptions) => Promise<DevinCredential>
}

/** Classify a cloud-direct transport failure into a harness error code. */
function classifyCloudError(error: CloudChatError): string {
  const text = error.message
  const code = error.code
  if (code === 'truncated_stream') return 'TRANSPORT'
  if (code === 'permission_denied' || code === 'unauthenticated') return 'AUTH'
  if (/quota|resource_exhausted/i.test(text)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b(?:400|invalid)/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b|internal/i.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(text)) return 'TRANSPORT'
  return 'DEVIN_ERROR'
}

function classifyGenericError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (/quota|resource_exhausted/i.test(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return 'TRANSPORT'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  return 'DEVIN_ERROR'
}

/** Translate a transport/protocol failure into a harness `LlmError`. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof ModelNotAvailableError) {
    return new LlmError(`devin: ${error.message}`, 'INVALID_REQUEST')
  }
  if (error instanceof CloudChatError) {
    return new LlmError(`devin: ${error.message}`, classifyCloudError(error))
  }
  if (error instanceof LlmError) return error
  if (error instanceof Error) {
    return new LlmError(`devin: ${error.message}`, classifyGenericError(error.message))
  }
  return new LlmError('devin: unknown streaming failure', 'DEVIN_ERROR')
}

/** The single provider route this adapter owns. */
export const PROVIDER = 'devin'
/** Human-readable provider name for selectors. */
export const PROVIDER_NAME = 'Devin (Cognition)'

/**
 * Devin-backed adapter. Each operation captures the current options, resolves
 * the credential once, and streams through the cloud-direct transport.
 */
export class DevinAdapter extends LlmAdapter {
  constructor(private readonly config: DevinAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  override providerRetryPolicy(): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  /**
   * Resolve the advisory catalog for discovery consumers. Prefers the
   * account's live per-account catalog — the same source the chat pre-flight
   * validates requests against — so the selector never advertises a model UID
   * the account cannot use. Falls back to the configured static catalog when
   * no credential is available yet or the live fetch fails.
   */
  private async catalogModels(): Promise<readonly DevinCatalogModel[]> {
    const connection = this.config.options()
    try {
      const credential = await this.config.resolveCredential(connection)
      const host = credential.apiServerUrl ?? connection.baseURL
      const catalog = await getCachedCatalog(credential.apiKey, host)
      if (catalog !== null) return buildLiveModels(catalog.byUid)
    } catch (_unavailable) {
      // No credential yet, or the account catalog is unreachable: the static
      // configured catalog remains the pre-login / offline placeholder.
    }
    return connection.models
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.catalogModels()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const opts = this.config.options()
    const models = await this.catalogModels()
    const entry = models.find(m => m.id === model)
    const base: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'],
      ...entry !== undefined ? { context: { contextWindow: entry.contextWindow } } : {},
      ...opts.maxTokens !== undefined ? { defaultMaxTokens: opts.maxTokens } : {},
    }
    return base
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const connection = this.config.options()
    const credential = await this.config.resolveCredential(connection)
    const host = credential.apiServerUrl ?? connection.baseURL
    const { messages, tools } = mapToChatHistory({
      ...options.system !== undefined ? { system: options.system } : {},
      messages: options.messages,
      ...options.tools !== undefined ? { tools: options.tools } : {},
    })
    const headers = attributionHeaders()
    const events = streamChatEvents({
      apiKey: credential.apiKey,
      apiServerUrl: host,
      modelUid: options.model,
      messages,
      ...tools.length > 0 ? { tools } : {},
      ...options.signal !== undefined ? { signal: options.signal } : {},
      extraHeaders: headers,
      completionOpts: {
        ...options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      },
    })
    try {
      yield* translateEvents(events)
    } catch (error) {
      if (options.signal !== undefined && options.signal.aborted) {
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'devin stream aborted', code: 'ABORTED' } },
        }
        return
      }
      throw toLlmError(error)
    }
  }
}
