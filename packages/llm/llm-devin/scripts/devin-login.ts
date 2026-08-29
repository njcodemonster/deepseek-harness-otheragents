/**
 * One-command Devin login for the DeepSeek Harness.
 *
 *   node --import tsx/esm scripts/devin-login.ts
 *
 * Two paths:
 *
 * A) If the Devin Desktop app (or the Devin CLI) has already signed in, this
 *    script imports the stored credential directly from
 *    `%APPDATA%\devin\credentials.toml` — no browser, no token paste, no
 *    key ever displayed.
 *
 * B) Otherwise it runs the interactive flow:
 *    1. Prints the Windsurf sign-in URL (opens it in your browser on Windows).
 *    2. Prompts for the token the sign-in page displays — paste it once.
 *    3. Exchanges it for the long-lived Devin API key via
 *       `register.windsurf.com` (SeatManagementService/RegisterUser).
 *
 * In both paths the key is stored as the `DEVIN_API_KEY` credential
 * reference in the harness credentials document (`$DSH_HOME/.credentials.yaml`),
 * preserving any existing entries. The running harness picks it up per
 * request — no restart required. You never see or manage the API key itself.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { buildSignInUrl, DEFAULT_REGION, registerUser } from '../src/login.ts'
import { parseDesktopCredentials, upsertRef } from '../src/desktop-login.ts'
import type { DesktopCredential } from '../src/desktop-login.ts'

const CREDENTIAL_REF = 'DEVIN_API_KEY'

/** Locations the Devin Desktop app stores its credential, per platform. */
function desktopCredentialCandidates(): string[] {
  if (process.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'devin', 'credentials.toml')]
  }
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'devin', 'credentials.toml')]
  }
  return [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'devin', 'credentials.toml')]
}

/** Read the Devin Desktop credential, if present. */
async function desktopCredential(): Promise<DesktopCredential | undefined> {
  for (const path of desktopCredentialCandidates()) {
    try {
      const toml = await readFile(path, 'utf8')
      const parsed = parseDesktopCredentials(toml)
      if (parsed !== undefined) return parsed
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function credentialsPath(): string {
  return join(dshHome(), '.credentials.yaml')
}

async function main(): Promise<void> {
  let apiKey: string
  let accountName: string | undefined

  const desktop = await desktopCredential()
  if (desktop !== undefined) {
    apiKey = desktop.apiKey
    accountName = desktop.name
    console.log('Found an existing Devin Desktop login; importing its credential (no browser needed).')
    if (desktop.apiServerUrl !== undefined) {
      console.log(`   API server: ${desktop.apiServerUrl}`)
    }
  } else {
    const url = buildSignInUrl(DEFAULT_REGION)
    console.log('1) Open this page and sign in with your Devin (Windsurf) account:')
    console.log('   ' + url)
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
      console.log('   (opened in your browser)')
    }

    const rl = createInterface({ input: stdin, output: stdout })
    try {
      const token = await rl.question(
        '2) After signing in, the page shows a token. Paste it here and press Enter: ',
      )
      if (!token.trim()) {
        console.error('No token provided; aborting.')
        process.exitCode = 1
        return
      }
      console.log('3) Exchanging token for a Devin API key…')
      const result = await registerUser(token.trim(), DEFAULT_REGION)
      apiKey = result.apiKey
      accountName = result.name
    } finally {
      rl.close()
    }
  }

  console.log(`Authenticated as: ${accountName ?? '(unknown)'}`)
  const path = credentialsPath()
  let document = ''
  try {
    document = await readFile(path, 'utf8')
  } catch {
    document = 'version: 1\n'
  }
  const next = upsertRef(document, CREDENTIAL_REF, apiKey)
  await writeFile(path, next, { mode: 0o600 })
  console.log(`Stored ${CREDENTIAL_REF} in ${path}`)
  console.log('Done. The harness will use your Devin account on the next request — no restart needed.')
}

if (import.meta.main) {
  void main()
}
