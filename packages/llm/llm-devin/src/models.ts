/**
 * Static model catalog for the Devin (Cognition) provider.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package's model table. The
 * catalog shown before login (and as the fallback when the live
 * `GetCascadeModelConfigs` fetch fails) carries context-window and max-token
 * metadata the account catalog does not disclose. All models accept text;
 * multimodal input is deferred until the adapter resolves image attachments.
 *
 * @module dsh-llm-devin/models
 */

export interface DevinCatalogModel {
  /** Model UID accepted by GetChatMessage. */
  id: string
  /** Human-readable label for selectors. */
  name: string
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
  /** Maximum output tokens. */
  maxTokens: number
}

export const DEFAULT_CONTEXT_WINDOW = 256_000
export const DEFAULT_MAX_TOKENS = 128_000

/** Static fallback list — the 11 model families pi-devin-auth tracks. */
export const FALLBACK_MODELS: readonly DevinCatalogModel[] = [
  { id: 'swe-1-7', name: 'SWE-1.7', contextWindow: 256_000, maxTokens: 128_000 },
  { id: 'swe-1-7-lightning', name: 'SWE-1.7 Lightning', contextWindow: 256_000, maxTokens: 128_000 },
  { id: 'gpt-5-6-sol', name: 'GPT-5.6 Sol', contextWindow: 1_050_000, maxTokens: 128_000 },
  { id: 'gpt-5-6-luna', name: 'GPT-5.6 Luna', contextWindow: 1_050_000, maxTokens: 128_000 },
  { id: 'gpt-5-6-terra', name: 'GPT-5.6 Terra', contextWindow: 1_050_000, maxTokens: 128_000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 200_000, maxTokens: 128_000 },
  { id: 'claude-5-fable', name: 'Claude Fable 5', contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'glm-5-2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 131_000 },
  { id: 'kimi-k2-7', name: 'Kimi K2.7', contextWindow: 256_000, maxTokens: 256_000 },
  { id: 'grok-4-5', name: 'Grok 4.5', contextWindow: 500_000, maxTokens: 128_000 },
]

/** Prefixes of the model families we surface from the live catalog. */
const WANTED_PREFIXES: readonly string[] = [
  'swe-1-7',
  'gpt-5-6-sol',
  'gpt-5-6-luna',
  'gpt-5-6-terra',
  'claude-opus-4-8',
  'claude-5-fable',
  'claude-sonnet-5',
  'glm-5-2',
  'kimi-k2-7',
  'grok-4-5',
]

function matchesWantedPrefix(uid: string): boolean {
  for (const prefix of WANTED_PREFIXES) {
    if (uid === prefix || uid.startsWith(prefix + '-') || uid.startsWith(prefix + '_')) {
      return true
    }
  }
  return false
}

/** Per-family metadata keyed by UID prefix (longest match wins). */
const META_BY_PREFIX: Readonly<Record<string, { contextWindow: number; maxTokens: number }>> = {
  'swe-1-7': { contextWindow: 256_000, maxTokens: 128_000 },
  'swe-1-7-lightning': { contextWindow: 256_000, maxTokens: 128_000 },
  'gpt-5-6-sol': { contextWindow: 1_050_000, maxTokens: 128_000 },
  'gpt-5-6-luna': { contextWindow: 1_050_000, maxTokens: 128_000 },
  'gpt-5-6-terra': { contextWindow: 1_050_000, maxTokens: 128_000 },
  'claude-opus-4-8': { contextWindow: 200_000, maxTokens: 128_000 },
  'claude-5-fable': { contextWindow: 1_000_000, maxTokens: 128_000 },
  'claude-sonnet-5': { contextWindow: 200_000, maxTokens: 64_000 },
  'glm-5-2': { contextWindow: 1_000_000, maxTokens: 131_000 },
  'kimi-k2-7': { contextWindow: 256_000, maxTokens: 256_000 },
  'grok-4-5': { contextWindow: 500_000, maxTokens: 128_000 },
}

function findMeta(uid: string): { contextWindow: number; maxTokens: number } | undefined {
  let best: { key: string; meta: { contextWindow: number; maxTokens: number } } | null = null
  for (const [key, meta] of Object.entries(META_BY_PREFIX)) {
    if (uid === key || uid.startsWith(key + '-') || uid.startsWith(key + '_')) {
      if (best === null || key.length > best.key.length) {
        best = { key, meta }
      }
    }
  }
  return best?.meta
}

/**
 * Build the model list from a live catalog response, filtered to the wanted
 * families and stamped with metadata. A provided catalog (even an empty one)
 * yields only the models it actually lists — the caller supplies
 * {@link FALLBACK_MODELS} as its own fallback when no catalog is available,
 * so a real catalog that lists none of the wanted families produces an empty
 * list rather than advertising UIDs the account cannot use.
 */
export function buildLiveModels(
  byUid: ReadonlyMap<string, { modelUid: string; label: string; disabled: boolean }> | undefined,
): DevinCatalogModel[] {
  if (byUid === undefined) return [...FALLBACK_MODELS]
  const models: DevinCatalogModel[] = []
  for (const entry of byUid.values()) {
    if (entry.disabled) continue
    if (!matchesWantedPrefix(entry.modelUid)) continue
    const meta = findMeta(entry.modelUid) ?? { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
    models.push({ id: entry.modelUid, name: entry.label || entry.modelUid, ...meta })
  }
  return models
}
