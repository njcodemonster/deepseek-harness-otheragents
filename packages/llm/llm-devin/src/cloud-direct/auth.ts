/**
 * Mint the short-lived `user_jwt` every chat RPC needs alongside the
 * persistent OAuth-issued `api_key`.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package:
 *
 *   POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt
 *   Content-Type: application/proto             ← unary, NOT streaming
 *   Body: GetUserJwtRequest { metadata: Metadata }
 *   Response: GetUserJwtResponse { user_jwt: string }  (field 1)
 *
 * The JWT has a ~24-minute TTL; we cache it and refresh shortly before `exp`.
 *
 * @module dsh-llm-devin/cloud-direct/auth
 */

import * as crypto from 'node:crypto'
import { bodyOf, encodeMessage, iterFields } from './wire.ts'
import { buildMetadata } from './metadata.ts'

export const DEFAULT_HOST = 'https://server.codeium.com'

/** Compose multiple AbortSignals so the result aborts when ANY input aborts. */
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

export interface MintedUserJwt {
  jwt: string
  /** Unix epoch seconds when the JWT expires. */
  expiresAt: number
}

export class CloudAuthError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'CloudAuthError'
  }
}

const MINT_TIMEOUT_MS = 30_000

export async function mintUserJwt(
  apiKey: string,
  host: string = DEFAULT_HOST,
  signal?: AbortSignal,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<MintedUserJwt> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  })
  const req = encodeMessage(1, metadata)

  const timeoutSignal = AbortSignal.timeout(MINT_TIMEOUT_MS)
  const combinedSignal: AbortSignal = signal
    ? anySignal([signal, timeoutSignal])
    : timeoutSignal

  const resp = await fetch(`${host.replace(/\/$/, '')}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/proto',
      'Connect-Protocol-Version': '1',
      ...extraHeaders,
    },
    body: bodyOf(req),
    signal: combinedSignal,
  })
  const buf = Buffer.from(await resp.arrayBuffer())

  if (!resp.ok) {
    const text = buf.toString('utf8')
    throw new CloudAuthError(`GetUserJwt HTTP ${resp.status}: ${text.slice(0, 400)}`, resp.status)
  }

  // GetUserJwtResponse { user_jwt: string } where user_jwt is field 1.
  let jwt: string | null = null
  for (const f of iterFields(buf)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      const s = (f.value as Buffer).toString('utf8')
      if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(s)) {
        jwt = s
        break
      }
    }
  }
  if (jwt === null) {
    throw new CloudAuthError(
      `GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes): ${buf.toString('utf8').slice(0, 200)}`,
    )
  }

  let expiresAt = Math.floor(Date.now() / 1000) + 600
  try {
    const parts = jwt.split('.')
    const payloadPart = parts[1]
    if (payloadPart !== undefined) {
      const pad = (s: string): string => s + '='.repeat((4 - (s.length % 4)) % 4)
      const payload = JSON.parse(
        Buffer.from(pad(payloadPart).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
      ) as { exp?: number }
      if (typeof payload.exp === 'number') expiresAt = payload.exp
    }
  } catch {
    // fall back to default
  }

  return { jwt, expiresAt }
}

interface CacheEntry {
  jwt: string
  expiresAt: number
  apiKey: string
  host: string
}

let cache: CacheEntry | null = null
const inFlight = new Map<string, Promise<MintedUserJwt>>()
let cacheEpoch = 0

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`
}

/** Get a cached user_jwt or mint a new one; refreshes within 60s of expiry. */
export async function getCachedUserJwt(
  apiKey: string,
  host: string = DEFAULT_HOST,
  signal?: AbortSignal,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cache !== null && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt
  }
  const key = flightKey(apiKey, host)
  const existing = inFlight.get(key)
  if (existing !== undefined) return (await existing).jwt
  const promise = mintUserJwt(apiKey, host, signal, extraHeaders)
  inFlight.set(key, promise)
  const epochAtStart = cacheEpoch
  try {
    const minted = await promise
    if (cacheEpoch === epochAtStart) {
      cache = { jwt: minted.jwt, expiresAt: minted.expiresAt, apiKey, host }
    }
    return minted.jwt
  } finally {
    inFlight.delete(key)
  }
}

/** Drop the in-memory JWT cache; call after logout/account switch. */
export function clearCachedUserJwt(): void {
  cache = null
  inFlight.clear()
  cacheEpoch++
}
