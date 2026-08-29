/**
 * Live smoke test: drive the llm-devin transport against the real Cognition
 * cloud using the imported DEVIN_API_KEY. Prints event kinds and usage only —
 * never the key.
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
console.log('key loaded:', key.slice(0, 12) + '…' + key.slice(-6))

const events = []
try {
  for await (const ev of streamChatEvents({
    apiKey: key,
    modelUid: 'swe-1-7',
    messages: [{ role: 'user', content: 'Reply with exactly: DEVIN-LINK-OK' }],
  })) {
    if (ev.kind === 'usage') {
      console.log('usage:', JSON.stringify({ promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, totalTokens: ev.totalTokens }))
    } else if (ev.kind === 'text' || ev.kind === 'reasoning') {
      events.push(ev.kind)
    } else if (ev.kind === 'tool_call_start' || ev.kind === 'tool_call_args') {
      events.push(ev.kind)
    } else if (ev.kind === 'finish') {
      console.log('finish reason:', ev.reason)
    }
  }
  console.log('streamed events:', events.join(','))
  console.log(events.includes('text') ? 'SMOKE TEST: OK — real streaming works' : 'SMOKE TEST: no text emitted')
} catch (error) {
  console.error('SMOKE TEST FAILED:', (error as Error).message)
  process.exitCode = 1
}
