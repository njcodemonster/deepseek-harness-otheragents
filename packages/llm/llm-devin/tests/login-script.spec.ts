/**
 * Tests for the one-command login script's credential-document editing.
 */

import { describe, expect, it } from 'vitest'
import { parseDesktopCredentials, upsertRef } from '../src/desktop-login.ts'

const KEY = 'devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.sig'

describe('upsertRef', () => {
  it('appends a refs block when the document has none', () => {
    const out = upsertRef('version: 1\n', 'DEVIN_API_KEY', KEY)
    expect(out).toBe(`version: 1
refs:
  DEVIN_API_KEY: '${KEY}'
`)
  })

  it('replaces an existing DEVIN_API_KEY entry', () => {
    const doc = `version: 1
refs:
  DEEPSEEK_API_KEY: old-deepseek
  DEVIN_API_KEY: old-devin
`
    const out = upsertRef(doc, 'DEVIN_API_KEY', KEY)
    expect(out).toContain(`DEVIN_API_KEY: '${KEY}'`)
    expect(out).not.toContain('old-devin')
    expect(out).toContain('DEEPSEEK_API_KEY: old-deepseek')
  })

  it('inserts into an existing refs block without disturbing siblings', () => {
    const doc = `version: 1
refs:
  DEEPSEEK_API_KEY: sk-deepseek
`
    const out = upsertRef(doc, 'DEVIN_API_KEY', KEY)
    const lines = out.split('\n')
    expect(lines).toContain(`  DEVIN_API_KEY: '${KEY}'`)
    expect(lines).toContain('  DEEPSEEK_API_KEY: sk-deepseek')
    // version line untouched at top
    expect(lines[0]).toBe('version: 1')
  })

  it('quotes values containing single quotes', () => {
    const out = upsertRef('version: 1\n', 'DEVIN_API_KEY', "a'b")
    expect(out).toContain("DEVIN_API_KEY: 'a''b'")
  })
})

describe('parseDesktopCredentials', () => {
  it('extracts the windsurf api key and server from the Devin Desktop toml', () => {
    const toml = [
      'windsurf_api_key = "devin-session-token$abc"',
      'api_server_url = "https://server.codeium.com"',
      'devin_webapp_host = "app.devin.ai"',
      'devin_api_url = "https://api.devin.ai"',
    ].join('\n')
    expect(parseDesktopCredentials(toml)).toEqual({
      apiKey: 'devin-session-token$abc',
      apiServerUrl: 'https://server.codeium.com',
    })
  })

  it('returns undefined when no windsurf api key is present', () => {
    expect(parseDesktopCredentials('devin_api_url = "https://api.devin.ai"\n')).toBeUndefined()
  })
})
