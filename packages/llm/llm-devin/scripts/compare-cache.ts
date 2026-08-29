/**
 * Live cache comparison: the SAME 3-turn conversation run through the two
 * in-harness provider routes — DeepSeek (`deepseek-official`, the GUI's
 * default) and Devin (`devin` via the cloud-direct adapter) — printing each
 * turn's provider-reported usage, including cache read/write tokens.
 *
 * Uses the user's real `$DSH_HOME/.credentials.yaml` (DEEPSEEK_API_KEY +
 * DEVIN_API_KEY refs). No keys are printed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmDevin from '@deepseek-ai/dsh-llm-devin'

const CONVERSATION = [
  'What is 7 * 8? Reply with only the number.',
  'Now multiply that result by 3. Reply with only the number.',
  'Add 10 to that result. Reply with only the number.',
]

/**
 * A long static preamble (~1700 tokens) emulating the GUI's system prompt.
 * DeepSeek only engages its automatic prefix cache above ~1K tokens, so a
 * bare chat would never show cache hits.
 */
const PADDING = ('You are a careful assistant that answers arithmetic questions precisely and briefly. ').repeat(120)
const SYSTEM = PADDING + '\nAlways follow the user instructions exactly.'

interface TurnReport {
  turn: number
  usage: TokenUsage
}

async function runProvider(ctx: Context, provider: string, model: string, prompts: string[]): Promise<TurnReport[]> {
  console.log(`\n=== ${provider} (${model}) ===`)
  const reports: TurnReport[] = []
  const messages: Message[] = []
  for (let turn = 0; turn < prompts.length; turn++) {
    messages.push(createUserMessage({
      content: [{ type: 'text', text: prompts[turn] }],
      source: { kind: 'user' },
    }))
    const assembler = new BlockAssembler()
    let usage: TokenUsage | undefined
    for await (const chunk of ctx.llm.stream({ provider, model, messages, system: SYSTEM })) {
      if (chunk.type === 'usage') usage = chunk.usage
      assembler.push(chunk)
    }
    if (usage === undefined) throw new Error(`${provider}: no usage chunk`)
    reports.push({ turn: turn + 1, usage })
    const read = usage.cacheReadTokens ?? 0
    const hitRate = usage.inputTokens + read === 0 ? 0 : Math.round((read / (usage.inputTokens + read)) * 100)
    console.log(
      `  turn ${turn + 1}: input=${usage.inputTokens} cacheRead=${read} cacheWrite=${usage.cacheWriteTokens ?? 0} output=${usage.outputTokens} hitRate=${hitRate}%`,
    )
    messages.push(assembler.message({
      kind: 'model',
      provider,
      model,
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }))
  }
  return reports
}

const root = await mkdtemp(join(tmpdir(), 'dsh-cache-compare-'))
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
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
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
    ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
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

  const routes = ctx.llm.listProviders().map(provider => provider.id)
  console.log('registered routes:', routes.join(', '))

  await runProvider(ctx, 'deepseek-official', 'deepseek-v4-flash', CONVERSATION)
  await runProvider(ctx, 'devin', 'swe-1-7', CONVERSATION)

  console.log('\nDONE — compare per-turn cacheRead and hitRate across the two rows above.')
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
