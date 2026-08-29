/**
 * `exa.codeium_common_pb.Metadata` proto builder for Cognition cloud-direct.
 *
 * Ported from the MIT-licensed `pi-devin-auth` package. Field numbers are the
 * canonical set the Windsurf language server populates; the version strings
 * must look like a real Windsurf release or the cloud rejects the request
 * with `failed_precondition: "an internal error occurred"`.
 *
 * @module dsh-llm-devin/cloud-direct/metadata
 */

import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from './wire.ts'

/** Pinned to a known-good Windsurf release string the cloud recognizes. */
const WINDSURF_VERSION_STRING = '2.0.0'

export interface MetadataInput {
  /** Persistent api_key from OAuth (`devin-session-token$<JWT>`). */
  apiKey: string
  /** Fresh user_jwt from GetUserJwt — required for chat methods. */
  userJwt?: string
  /** UUID — one per adapter process is fine. */
  sessionId: string
  /** Monotonic, milliseconds since epoch. */
  requestId: bigint
  /** UUID — one per RPC call. */
  triggerId: string
  /** Optional override for the version string. Cosmetic. */
  windsurfVersion?: string
  /** Optional override for the host OS string. */
  osName?: string
}

function osString(): string {
  switch (process.platform) {
    case 'darwin': return 'darwin'
    case 'linux': return 'linux'
    case 'win32': return 'windows'
    default: return String(process.platform)
  }
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.windsurfVersion ?? WINDSURF_VERSION_STRING
  const os = input.osName ?? osString()
  const parts: Buffer[] = [
    encodeString(1, 'windsurf'),                     // ide_name
    encodeString(2, version),                         // extension_version
    encodeString(3, input.apiKey),                    // api_key
    encodeString(4, 'en'),                            // locale
    encodeString(5, os),                              // os
    encodeString(7, version),                         // ide_version
    encodeVarintField(9, input.requestId),            // request_id (uint64 monotonic)
    encodeString(10, input.sessionId),                // session_id
    encodeString(12, 'windsurf'),                     // extension_name
    encodeMessage(16, encodeTimestampBody()),         // ls_timestamp
    encodeString(25, input.triggerId),                // trigger_id
    encodeString(26, 'Unset'),                        // plan_name
    encodeString(28, 'windsurf'),                     // ide_type
  ]
  if (input.userJwt !== undefined) parts.push(encodeString(21, input.userJwt)) // user_jwt
  return Buffer.concat(parts)
}
