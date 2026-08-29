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
      { modelUid: 'gpt-5-6-luna-high', label: 'GPT-5.6 Luna High Thinking' },
      { modelUid: 'gpt-5-6-terra-high', label: 'GPT-5.6 Terra High Thinking', disabled: true },
      { modelUid: 'gemini-3-5-flash-high', label: 'Gemini 3.5 Flash High' },
    ])
    expect(buildLiveModels(byUid)).toEqual([
      { id: 'swe-1-7', name: 'SWE-1.7', contextWindow: 256_000, maxTokens: 128_000 },
      { id: 'gpt-5-6-luna-high', name: 'GPT-5.6 Luna High Thinking', contextWindow: 1_050_000, maxTokens: 128_000 },
    ])
  })

  it('matches the renamed claude-5-fable family', () => {
    const byUid = mapOf([{ modelUid: 'claude-5-fable-high', label: 'Claude Fable 5 High' }])
    expect(buildLiveModels(byUid).map(model => model.id)).toEqual(['claude-5-fable-high'])
  })
})
