/**
 * Debug: harness-path Devin call — print every chunk type, the raw usage
 * event, and the finish reason.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmDevin from '@deepseek-ai/dsh-llm-devin'

const root = await mkdtemp(join(tmpdir(), 'dsh-devin-debug-'))
const ctx = new Context()
try {
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# empty\n')
  const credentialsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    '- id: settings',
    "  name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: ${JSON.stringify(settingsPath)}`,
    '    debounceMs: 10',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    debounceMs: 10',
    '- id: llm-devin',
    "  name: '@deepseek-ai/dsh-llm-devin'",
    '',
  ].join('\n'))

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-devin', LlmDevin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  const user = createUserMessage({
    content: [{ type: 'text', text: 'What is 7 * 8? Reply with only the number.' }],
    source: { kind: 'user' },
  })
  const counts = new Map<string, number>()
  for await (const chunk of ctx.llm.stream({ provider: 'devin', model: 'swe-1-7', messages: [user] })) {
    counts.set(chunk.type, (counts.get(chunk.type) ?? 0) + 1)
    if (chunk.type === 'usage') console.log('usage chunk:', JSON.stringify(chunk.usage))
    if (chunk.type === 'finish') console.log('finish chunk:', JSON.stringify(chunk.reason))
  }
  console.log('chunk type counts:', JSON.stringify(Object.fromEntries(counts)))
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
