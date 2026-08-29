/**
 * Real-composition guard for the Devin adapter: LlmRuntime, settings-file,
 * credentials-local, the authorization seam, and a bare `llm-devin` row boot
 * from a test-only cordis.yml through the actual Loader + Include path. The
 * `devin` route registers at mount with its static catalog, the Devin
 * sign-in flow appears on the authorization seam, and a request without any
 * credential fails with MISSING_CREDENTIAL instead of reaching the network.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import * as LlmDevin from '@deepseek-ai/dsh-llm-devin'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the composition: bare `llm-devin` row, no config at all. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devin-composition-'))
  const settingsPath = join(root, 'settings.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(join(root, '.credentials.yaml'), 'version: 1\nrefs: {}\n', { mode: 0o600 })

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
    `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
    '    debounceMs: 10',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-devin',
    "  name: '@deepseek-ai/dsh-llm-devin'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-devin', LlmDevin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('llm-devin real composition', () => {
  it('registers the devin route and the sign-in flow at mount', async () => {
    const ctx = await loadComposition()

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['devin'])
    expect(ctx.llm.listProviders()[0]?.name).toBe('Devin (Cognition)')
    const models = await ctx.llm.listModels('devin')
    expect(models.some(model => model.id === 'swe-1-7')).toBe(true)
    expect(models.every(model => model.inputModalities?.includes('text'))).toBe(true)

    const flows = ctx.authorization.list()
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({
      key: 'llm-devin/devin',
      label: 'Devin (Cognition / Windsurf)',
      inFlight: false,
    })
  })

  it('fails a request without a credential as MISSING_CREDENTIAL, without network I/O', async () => {
    const ctx = await loadComposition()
    const user = createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'devin',
      model: 'swe-1-7',
      messages: [user],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.reason.kind).toBe('error')
      if (finish.reason.kind === 'error') {
        expect(finish.reason.failure.code).toBe('MISSING_CREDENTIAL')
      }
    }
  })
})
