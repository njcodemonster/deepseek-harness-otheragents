/**
 * Behavior tests for the Devin catalog builder: the selector list mirrors the
 * live per-account catalog, and only an absent catalog falls back to the
 * static placeholder list.
 */

import { describe, expect, it } from 'vitest'
import { buildLiveModels, FALLBACK_MODELS } from '../src/models.ts'

interface Entry { modelUid: string; label: string; disabled?: boolean }

function mapOf(entries: Entry[]): Map<string, { modelUid: string; label: string; disabled: boolean }> {
  return new Map(entries.map(entry => [
    entry.modelUid,
    { modelUid: entry.modelUid, label: entry.label, disabled: entry.disabled ?? false },
  ]))
}

describe('buildLiveModels', () => {
  it('returns the static fallback when no catalog is available', () => {
    expect(buildLiveModels(undefined).map(model => model.id)).toEqual(FALLBACK_MODELS.map(model => model.id))
  })

  it('returns an empty list when the account catalog lists no wanted families', () => {
    const byUid = mapOf([{ modelUid: 'gemini-3-5-flash-high', label: 'Gemini 3.5 Flash High' }])
    expect(buildLiveModels(byUid)).toEqual([])
  })

  it('filters to wanted families, skips disabled entries, and stamps metadata', () => {
    const byUid = mapOf([
      { modelUid: 'swe-1-7', label: 'SWE-1.7' },
      { modelUid: 'claude-sonnet-5-high', label: 'Claude Sonnet 5 High' },
      { modelUid: 'glm-5-2-max', label: 'GLM-5.2 Max', disabled: true },
      { modelUid: 'gemini-3-5-flash-high', label: 'Gemini 3.5 Flash High' },
    ])
    expect(buildLiveModels(byUid)).toEqual([
      { id: 'swe-1-7', name: 'SWE-1.7', contextWindow: 256_000, maxTokens: 128_000 },
      { id: 'claude-sonnet-5-high', name: 'Claude Sonnet 5 High', contextWindow: 200_000, maxTokens: 64_000 },
    ])
  })

  it('never surfaces the families Cognition serves only in its desktop app', () => {
    const byUid = mapOf([
      { modelUid: 'gpt-5-6-sol-high', label: 'GPT-5.6 Sol High Thinking' },
      { modelUid: 'gpt-5-6-luna-medium', label: 'GPT-5.6 Luna Medium Thinking' },
      { modelUid: 'swe-1-7', label: 'SWE-1.7' },
    ])
    expect(buildLiveModels(byUid).map(model => model.id)).toEqual(['swe-1-7'])
    expect(FALLBACK_MODELS.some(model => model.id.startsWith('gpt-5-6'))).toBe(false)
  })

  it('matches the renamed claude-5-fable family', () => {
    const byUid = mapOf([{ modelUid: 'claude-5-fable-high', label: 'Claude Fable 5 High' }])
    expect(buildLiveModels(byUid).map(model => model.id)).toEqual(['claude-5-fable-high'])
  })
})
