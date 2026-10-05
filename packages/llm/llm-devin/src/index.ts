/**
 * Register a {@link DevinAdapter} for the `devin` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-devin` user-settings section (`ctx.settings`) and resolves the API key
 * through the optional credential seam (`ctx.credentials`) — a key stored by
 * the Models page, a `DEVIN_API_KEY` environment value, or the grant record
 * produced by the browser-OAuth Devin sign-in flow registered on
 * `ctx.authorization`.
 *
 * @module @deepseek-ai/dsh-llm-devin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, FALLBACK_MODELS, type DevinCatalogModel } from './models.ts'
import { DevinAdapter, PROVIDER, PROVIDER_NAME } from './adapter.ts'
import type { ResolvedDevinOptions } from './adapter.ts'
import { DEFAULT_HOST } from './cloud-direct/auth.ts'
import { registerDevinFlow, resolveStoredCredential } from './login.ts'
import type { DevinCredential } from './login.ts'

export { DevinAdapter, PROVIDER, PROVIDER_NAME, toLlmError } from './adapter.ts'
export type { ResolvedDevinOptions, DevinAdapterOptions } from './adapter.ts'
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, FALLBACK_MODELS, buildLiveModels } from './models.ts'
export type { DevinCatalogModel } from './models.ts'
export { DEFAULT_HOST } from './cloud-direct/auth.ts'
export { streamChatEvents, CloudChatError, streamChat } from './cloud-direct/chat.ts'
export type { CloudChatEvent, CloudChatRequest, ChatHistoryItem, ToolDef, ContentPart } from './cloud-direct/chat.ts'
export { buildSignInUrl, DEFAULT_REGION, registerUser, resolveStoredCredential } from './login.ts'
export type { DevinCredential, OAuthLoginResult, WindsurfRegion } from './login.ts'
export { mapToChatHistory } from './message.ts'
export type { MappedChat } from './message.ts'
export { translateEvents, mapUsage } from './stream.ts'

export const name = 'llm-devin'
export const inject = ['llm']

const DEFAULT_API_KEY_ENV = 'DEVIN_API_KEY'
/** Public API server default; the account's RegisterUser value wins when stored. */
export const PUBLIC_BASE_URL = DEFAULT_HOST

/** Plugin config, validated by the same-named schemastery schema and doubling as the `llm-devin` settings-section shape. */
export interface Config {
  /** Credential reference resolved per request; defaults to `DEVIN_API_KEY`. */
  apiKeyEnv?: string
  /** API server base URL; the account's RegisterUser value wins when stored. */
  baseURL?: string
  /** Advisory model catalog shown by discovery consumers. */
  models?: DevinCatalogModel[]
  /** Positive context capacity used when the selected model has no exact value (default 256,000). */
  defaultContextWindow?: number
  /** Default per-request output cap; the model's own cap and explicit request values win. */
  maxTokens?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<DevinCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  models: z.array(catalogModel).default([...FALLBACK_MODELS]),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  retryPolicy: RetryPolicySchema,
})

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly DevinCatalogModel[] | undefined): DevinCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? FALLBACK_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-devin: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-devin: catalog model "${model.id}" has an empty name`)
    }
    if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) {
      throw new Error(`llm-devin: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) {
      throw new Error(`llm-devin: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-devin: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return { id: model.id, name: model.name ?? model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 */
export function resolveAdapterOptions(config: Config): ResolvedDevinOptions {
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-devin: defaultContextWindow must be a positive integer')
  }
  const maxTokens = config.maxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new Error('llm-devin: maxTokens must be a positive safe integer')
  }
  const baseURL = config.baseURL ?? PUBLIC_BASE_URL
  if (baseURL.length === 0) throw new Error('llm-devin: baseURL must be non-empty')
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL,
    models: resolveModels(config.models),
    ...maxTokens !== undefined ? { maxTokens } : {},
    defaultContextWindow,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-devin: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  const options = (): ResolvedDevinOptions => resolveAdapterOptions(config)
  options()

  const resolveCredential = async (connection: ResolvedDevinOptions): Promise<DevinCredential> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(connection.apiKeyEnv)
      if (hit !== undefined) {
        const apiKey = assertUsableApiKey(hit.value, 'llm-devin', connection.apiKeyEnv)
        return { apiKey }
      }
    }
    const stored = await resolveStoredCredential(credentials)
    if (stored !== undefined) return stored
    throw new LlmError(
      `llm-devin: no Devin credential for provider route "${PROVIDER}"; store ${connection.apiKeyEnv} through the`
      + ' credentials service (the web Models page writes it), export it in the launching environment,'
      + ' or sign in with Devin (Cognition / Windsurf) from the Models page',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new DevinAdapter({ options, resolveCredential })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: PROVIDER_NAME, settingsNs, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // The sign-in flow registers lazily when the authorization seam is mounted
  // (the credentials seam is a base-composition constant); the route still
  // authenticates via apiKeyEnv when the flow is absent.
  ctx.inject(['authorization'], (authorized) => {
    registerDevinFlow(authorized)
  })
}
