/**
 * Devin (Cognition / Windsurf) browser-OAuth login, ported from the
 * MIT-licensed `pi-devin-auth` package.
 *
 * Flow:
 *   1. Build an Auth0 implicit-grant URL (`response_type=token`) pointing at
 *      Windsurf's SPA sign-in page with `redirect_uri=show-auth-token` — the
 *      page renders the resulting token on screen for manual copy.
 *   2. The harness authorization session opens the browser (`session.notify`).
 *   3. `session.prompt` collects the pasted token — the Firebase ID token.
 *   4. `registerUser` exchanges it for a long-lived Devin API key
 *      (`devin-session-token$<JWT>`) via `register.windsurf.com`.
 *   5. The key (plus account facts) is committed as a `grant` credential
 *      record under the `llm-devin` scope.
 *
 * The paste-token shape (instead of a loopback redirect) is the same trick
 * the opencode-windsurf-auth CLI uses for headless / SSH environments, and
 * it is the only shape that fits the authorization seam's prompt vocabulary.
 *
 * @module dsh-llm-devin/login
 */

import * as crypto from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'

/** The record scope every credential this adapter family writes under. */
export const RECORD_SCOPE = 'llm-devin'
/** The harness provider route / record id. */
export const PROVIDER_ID = 'devin'

/** The record address for the Devin credential. */
export function recordKeyFor(): CredentialKey {
  return credentialKey(RECORD_SCOPE, PROVIDER_ID)
}

export interface WindsurfRegion {
  /** Where to send users for browser sign-in. */
  website: string
  /** Where to POST RegisterUser. */
  registerApiServerUrl: string
  /** Auth0 client id passed in the OAuth URL. */
  oauthClientId: string
}

/** The single tenant (free / personal) configuration. */
export const DEFAULT_REGION: WindsurfRegion = {
  website: 'https://windsurf.com',
  registerApiServerUrl: 'https://register.windsurf.com',
  oauthClientId: '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u',
}

/** One year — the Devin API key is effectively non-expiring. */

/** Build the Auth0 implicit-grant URL for Windsurf's SPA sign-in page. */
export function buildSignInUrl(region: WindsurfRegion): string {
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: region.oauthClientId,
    redirect_uri: 'show-auth-token',
    state: crypto.randomUUID(),
    prompt: 'login',
  })
  return `${region.website}/windsurf/signin?${params.toString()}`
}

export interface OAuthLoginResult {
  /** The opaque API key used as `Metadata.api_key` in every Cascade RPC. */
  apiKey: string
  /** Human-readable account name. */
  name: string
  /** Cloud API server URL (falls back to the default when empty). */
  apiServerUrl: string
  redirectUrl?: string
}

interface RegisterUserResponseJson {
  api_key?: string
  name?: string
  api_server_url?: string
  redirect_url?: string
  team_options?: unknown[]
}

interface ConnectErrorJson {
  code?: string
  message?: string
}

export class WindsurfRegistrationError extends Error {
  readonly status: number
  readonly connectCode: string | undefined
  readonly traceId: string | undefined

  constructor(message: string, status: number, connectCode?: string, traceId?: string) {
    super(message)
    this.name = 'WindsurfRegistrationError'
    this.status = status
    this.connectCode = connectCode
    this.traceId = traceId
  }
}

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i

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

/**
 * Exchange the Firebase ID token for a long-lived Windsurf API key via the
 * Connect-RPC `SeatManagementService/RegisterUser` endpoint (plain JSON over
 * HTTPS — no gRPC framing required).
 */
export async function registerUser(
  firebaseIdToken: string,
  region: WindsurfRegion,
  abortSignal?: AbortSignal,
): Promise<OAuthLoginResult> {
  if (!firebaseIdToken) {
    throw new WindsurfRegistrationError('Empty firebase_id_token', 0, 'invalid_argument')
  }

  const url = `${region.registerApiServerUrl.replace(/\/$/, '')}/exa.seat_management_pb.SeatManagementService/RegisterUser`

  const timeoutSignal = AbortSignal.timeout(30_000)
  const combinedSignal: AbortSignal = abortSignal !== undefined
    ? anySignal([abortSignal, timeoutSignal])
    : timeoutSignal

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    signal: combinedSignal,
  })

  const text = await response.text()

  if (!response.ok) {
    let connectCode: string | undefined
    let message = text || `RegisterUser failed with HTTP ${response.status}`
    try {
      const errJson = JSON.parse(text) as ConnectErrorJson
      connectCode = errJson.code
      if (errJson.message !== undefined) message = errJson.message
    } catch {
      // non-JSON error body — keep raw text in `message`
    }
    const traceMatch = message.match(TRACE_ID_RE)
    throw new WindsurfRegistrationError(message, response.status, connectCode, traceMatch?.[1])
  }

  let parsed: RegisterUserResponseJson
  try {
    parsed = JSON.parse(text) as RegisterUserResponseJson
  } catch {
    throw new WindsurfRegistrationError(
      `RegisterUser returned 200 but body is not JSON: ${text.slice(0, 200)}`,
      response.status,
      'internal',
    )
  }

  const apiKey = parsed.api_key
  const name = parsed.name
  // Empty api_server_url is normal for single-tenant accounts — fall back.
  const apiServerUrl = parsed.api_server_url !== undefined && parsed.api_server_url.length > 0
    ? parsed.api_server_url
    : 'https://server.codeium.com'

  if (apiKey === undefined) {
    throw new WindsurfRegistrationError(
      'RegisterUser returned 200 but api_key was empty',
      response.status,
      'malformed_response',
    )
  }
  if (name === undefined) {
    throw new WindsurfRegistrationError(
      'RegisterUser returned 200 but name was empty',
      response.status,
      'malformed_response',
    )
  }

  return {
    apiKey,
    name,
    apiServerUrl,
    ...parsed.redirect_url !== undefined ? { redirectUrl: parsed.redirect_url } : {},
  }
}

/**
 * The credential this adapter family resolves for one request: the
 * long-lived Devin API key plus the account's API server URL when known.
 */
export interface DevinCredential {
  apiKey: string
  apiServerUrl?: string
  name?: string
}

interface DevinGrantPayload {
  type: 'devin'
  apiKey: string
  name: string
  apiServerUrl: string
  issuedAt: string
}

/** Read the stored Devin credential record, if any. */
export async function resolveStoredCredential(
  credentials: CredentialProvider | undefined,
): Promise<DevinCredential | undefined> {
  if (credentials === undefined) return undefined
  const record = await credentials.readRecord(recordKeyFor())
  if (record === undefined) return undefined
  if (record.kind === 'api-key' && record.key !== undefined) {
    return { apiKey: record.key }
  }
  if (record.kind === 'grant') {
    const payload = record.payload as DevinGrantPayload | undefined
    if (payload !== undefined && typeof payload.apiKey === 'string' && payload.apiKey.length > 0) {
      return {
        apiKey: payload.apiKey,
        ...typeof payload.apiServerUrl === 'string' ? { apiServerUrl: payload.apiServerUrl } : {},
        ...typeof payload.name === 'string' ? { name: payload.name } : {},
      }
    }
  }
  return undefined
}

/**
 * Register the Devin authorization flow on `ctx.authorization`, if the seam
 * is mounted. The flow writes the grant record through `ctx.credentials`,
 * which the seam confirms before reporting success. Intended to run inside a
 * `ctx.inject(['authorization'], …)` scope where both seams are available.
 */
export function registerDevinFlow(ctx: Context): void {
  const credentials = ctx.get('credentials')
  const authorization = ctx.get('authorization')
  if (credentials === undefined || authorization === undefined) return
  authorization.registerFlow({
    key: recordKeyFor(),
    label: 'Devin (Cognition / Windsurf)',
    methods: [{ id: 'oauth', label: 'Sign in with Devin (Windsurf)' }],
    async run(session: AuthorizationSession) {
      const url = buildSignInUrl(DEFAULT_REGION)
      session.notify({
        message: 'Open the Devin (Windsurf) sign-in page in your browser. After signing in it shows a token — paste that token into the prompt to finish signing in.',
        url,
      })
      const firebaseIdToken = await session.prompt({
        kind: 'secret',
        message: 'Paste the token shown on the Devin (Windsurf) sign-in page:',
      })
      if (!firebaseIdToken) {
        throw new WindsurfRegistrationError('No token pasted; cannot complete sign-in.', 0, 'invalid_argument')
      }
      const result = await registerUser(firebaseIdToken.trim(), DEFAULT_REGION, session.signal)
      const payload: DevinGrantPayload = {
        type: 'devin',
        apiKey: result.apiKey,
        name: result.name,
        apiServerUrl: result.apiServerUrl,
        issuedAt: new Date().toISOString(),
      }
      await credentials.modifyRecord(recordKeyFor(), async () => ({ kind: 'grant', payload }))
    },
  })
}
