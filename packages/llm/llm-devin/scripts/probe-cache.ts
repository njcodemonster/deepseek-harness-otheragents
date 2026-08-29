/**
 * Live cache probe: two identical swe-1-7 calls through the llm-devin
 * transport. Prints the FULL usage event for each (including cached-input
 * fields) to show whether Cognition reports prefix-cache hits.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { streamChatEvents } from '../src/cloud-direct/chat.ts'

async function loadKey(): Promise<string> {
  const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  const doc = await readFile(path, 'utf8')
  const m = doc.match(/^  DEVIN_API_KEY:\s*'?([^'\n]+)'?\s*$/m)
  if (m?.[1] === undefined) throw new Error('DEVIN_API_KEY not found in credentials document')
  return m[1].trim()
}

const key = await loadKey()
const messages = [
  { role: 'user' as const, content: 'What is 7 * 8? Reply with only the number.' },
]

for (let call = 1; call <= 2; call++) {
  console.log(`--- call ${call} ---`)
  for await (const ev of streamChatEvents({ apiKey: key, modelUid: 'swe-1-7', messages })) {
    if (ev.kind === 'usage') {
      const { kind, ...fields } = ev
      console.log('usage fields:', JSON.stringify(fields))
    } else if (ev.kind === 'finish') {
      console.log('finish:', ev.reason)
    }
  }
}
console.log('DONE')
