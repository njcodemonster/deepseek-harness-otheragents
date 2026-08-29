/**
 * Per-account model catalog from Cognition's `GetCascadeModelConfigs`.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package. The cloud's
 * `GetChatMessage` returns an opaque `permission_denied: "an internal error
 * occurred (trace ID: …)"` trailer whenever the account tier cannot run a
 * requested `model_uid`; this pre-flight checks the catalog's `disabled` flag
 * so the adapter can surface a named error instead. A catalog fetch failure
 * falls back to the chat path (best-effort).
 *
 * @module dsh-llm-devin/cloud-direct/catalog
 */

import * as crypto from 'node:crypto'
import { buildMetadata } from './metadata.ts'
import { getCachedUserJwt } from './auth.ts'
import { bodyOf, encodeMessage, iterFields } from './wire.ts'

const CATALOG_TTL_MS = 10 * 60 * 1000
const CATALOG_FETCH_TIMEOUT_MS = 10_000

export interface ModelCatalogEntry {
  /** Cloud-side `model_uid` (e.g. `swe-1-7-lightning`). */
  modelUid: string
  /** Human label used in error messages. */
  label: string
  /** True when the caller's account tier cannot use this UID for chat. */
  disabled: boolean
}

export interface CacheEntry {
  /** Lookup keyed by `model_uid`. */
  byUid: Map<string, ModelCatalogEntry>
  fetchedAt: number
  apiKey: string
  host: string
}

let cached: CacheEntry | null = null
let inFlight: Promise<CacheEntry> | null = null
let inFlightKey: string | null = null

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`
}

async function fetchCatalog(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<CacheEntry> {
  const userJwt = await getCachedUserJwt(apiKey, host, signal, extraHeaders)

  const metadata = buildMetadata({
    apiKey,
    userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  })
  const reqBody = encodeMessage(1, metadata)

  const ac = new AbortController()
  const timer = setTimeout(
    () => ac.abort(new Error(`catalog: fetch timeout (${CATALOG_FETCH_TIMEOUT_MS}ms)`)),
    CATALOG_FETCH_TIMEOUT_MS,
  )
  const cleanupOnAbort = signal !== undefined
    ? (() => {
      if (signal.aborted) ac.abort(signal.reason)
      const fwd = (): void => ac.abort(signal.reason)
      signal.addEventListener('abort', fwd, { once: true })
      return () => signal.removeEventListener('abort', fwd)
    })()
    : (): void => { /* no caller signal */ }

  let resp: Response
  try {
    resp = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1', ...extraHeaders },
      body: bodyOf(reqBody),
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
    cleanupOnAbort()
  }

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`GetCascadeModelConfigs HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  const buf = Buffer.from(await resp.arrayBuffer())

  // GetCascadeModelConfigsResponse #1 (repeated ClientModelConfig):
  //   ClientModelConfig { #1 label, #4 disabled (bool), #22 model_uid }
  const byUid = new Map<string, ModelCatalogEntry>()
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue
    let label = ''
    let modelUid = ''
    let disabled = false
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        label = (sf.value as Buffer).toString('utf8')
      } else if (sf.num === 4 && sf.wire === 0) {
        disabled = sf.value === 1n
      } else if (sf.num === 22 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        modelUid = (sf.value as Buffer).toString('utf8')
      }
    }
    if (modelUid.length > 0) {
      byUid.set(modelUid, { modelUid, label: label || modelUid, disabled })
    }
  }

  return { byUid, fetchedAt: Date.now(), apiKey, host }
}

/**
 * Get the cached catalog for `(apiKey, host)`, fetching when missing or stale.
 * Returns `null` on fetch failure — the caller skips pre-flight then.
 */
export async function getCachedCatalog(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<CacheEntry | null> {
  if (cached !== null && cached.apiKey === apiKey && cached.host === host) {
    if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached
    }
  }

  const key = flightKey(apiKey, host)
  if (inFlight !== null && inFlightKey === key) {
    try {
      return await inFlight
    } catch {
      return null
    }
  }

  const promise = fetchCatalog(apiKey, host, signal, extraHeaders)
  inFlight = promise
  inFlightKey = key
  try {
    const result = await promise
    cached = result
    return result
  } catch {
    return null
  } finally {
    if (inFlight === promise) {
      inFlight = null
      inFlightKey = null
    }
  }
}

/** Drop the cached catalog; call after logout/account switch. */
export function clearCachedCatalog(): void {
  cached = null
  inFlight = null
  inFlightKey = null
}

/**
 * Tier-disabled error thrown by the chat pre-flight. Replaces Cognition's
 * opaque "an internal error occurred" trailer with a message naming the model.
 */
export class ModelNotAvailableError extends Error {
  constructor(
    public readonly modelUid: string,
    public readonly label: string,
    public readonly reason: 'disabled' | 'not_listed',
  ) {
    super(
      reason === 'disabled'
        ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account. `
          + 'The Cognition catalog returned it with disabled=true — your current plan/tier '
          + 'does not include this model. Check the model picker on https://codeium.com/account, '
          + 'or pick a different model.'
        : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account. `
          + 'Either the UID has been retired upstream or your account/region doesn\'t serve it.',
    )
    this.name = 'ModelNotAvailableError'
  }
}
