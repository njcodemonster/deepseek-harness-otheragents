/**
 * Unit lane of the win32 interactive-desktop probe: every branch of
 * `hasInteractiveDesktop` against injected fake bindings, plus the production
 * koffi loader driven through a mocked `koffi` module (the
 * `dsh-session-persistence-jsonl` technique), on any host platform.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasInteractiveDesktop, type DesktopProbeBindings } from '../src/windows-desktop.ts'

/** Scripted koffi world: name queue for the two user-object reads, plus a load-failure switch. */
const koffiControl = vi.hoisted(() => {
  const state = { names: ['WinSta0', 'Default'], index: 0, failLoad: false, funcCalls: [] as string[] }
  return {
    state,
    reset() {
      state.index = 0
      state.failLoad = false
      state.funcCalls.length = 0
    },
  }
})

vi.mock('koffi', () => ({
  default: {
    load() {
      if (koffiControl.state.failLoad) throw new Error('koffi load failed')
      return {
        func: (_convention: string, name: string, _result: string, _args: string[]) => {
          koffiControl.state.funcCalls.push(name)
          return (...callArgs: unknown[]) => {
            switch (name) {
              case 'GetCurrentThreadId':
                return 42
              case 'GetProcessWindowStation':
                return 1
              case 'GetThreadDesktop':
                return 2
              case 'GetUserObjectInformationW': {
                const buffer = callArgs[2] as Buffer
                buffer.write(`${koffiControl.state.names[koffiControl.state.index] ?? ''}\0`, 'utf16le')
                koffiControl.state.index += 1
                return 1
              }
              default:
                return 0
            }
          }
        },
      }
    },
  },
}))

/**
 * Fake bindings whose `readUserObjectName` answers each call from a name
 * queue in order (station first, then desktop), filling the buffer with the
 * name plus a NUL wide character.
 */
function queuedNames(names: string[], overrides: Partial<DesktopProbeBindings> = {}): DesktopProbeBindings {
  let index = 0
  return {
    getProcessWindowStation: () => 1,
    getCurrentThreadId: () => 42,
    getThreadDesktop: () => 2,
    readUserObjectName: (_handle, buffer, _needed) => {
      buffer.write(`${names[index] ?? ''}\0`, 'utf16le')
      index += 1
      return 1
    },
    ...overrides,
  }
}

beforeEach(() => {
  koffiControl.reset()
})

describe('hasInteractiveDesktop', () => {
  it('treats non-win32 hosts as attended without loading bindings', async () => {
    const loadBindings = vi.fn(async () => queuedNames([]))
    await expect(hasInteractiveDesktop({ platform: 'linux', loadBindings })).resolves.toBe(true)
    await expect(hasInteractiveDesktop({ platform: 'darwin', loadBindings })).resolves.toBe(true)
    expect(loadBindings).not.toHaveBeenCalled()
  })

  it('reads the real platform when the internals omit it', async () => {
    // Covers the `?? process.platform` default; the injected loader keeps the
    // outcome deterministic on every host (non-win32 returns before use).
    const loadBindings = vi.fn(async () => queuedNames(['WinSta0', 'Default']))
    await expect(hasInteractiveDesktop({ loadBindings })).resolves.toBe(true)
  })

  it('resolves true on win32 when both user objects are the interactive ones', async () => {
    const loadBindings = vi.fn(async () => queuedNames(['WinSta0', 'Default']))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(true)
    expect(loadBindings).toHaveBeenCalledTimes(1)
  })

  it('resolves false when the window station is not the interactive one', async () => {
    const loadBindings = vi.fn(async () => queuedNames(['Service-0x0-3e7$', 'Default']))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('resolves false when the desktop inside the interactive station is not Default', async () => {
    const loadBindings = vi.fn(async () => queuedNames(['WinSta0', 'exebox-RKHI3SKGDJV3SNSOEAX3JC6CBS']))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('resolves false when the binding load fails, keeping browse as the working interaction', async () => {
    const loadBindings = vi.fn(async () => { throw new Error('koffi missing') })
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('resolves false when a user-object handle is null', async () => {
    const loadBindings = vi.fn(async () => queuedNames([], {
      getProcessWindowStation: () => null,
    }))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('resolves false when the user-object name read fails', async () => {
    const loadBindings = vi.fn(async () => queuedNames([], {
      readUserObjectName: () => 0,
    }))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('resolves false for a name buffer without a NUL terminator', async () => {
    const loadBindings = vi.fn(async () => queuedNames([], {
      readUserObjectName: (_handle, buffer, _needed) => {
        buffer.fill(0xff)
        return 1
      },
    }))
    await expect(hasInteractiveDesktop({ platform: 'win32', loadBindings })).resolves.toBe(false)
  })

  it('drives the production koffi loader through the mocked module', async () => {
    await expect(hasInteractiveDesktop({ platform: 'win32' })).resolves.toBe(true)
    // Read order: each `readName` evaluates its handle call first, then the name read.
    expect(koffiControl.state.funcCalls).toEqual([
      'GetProcessWindowStation', 'GetUserObjectInformationW',
      'GetCurrentThreadId', 'GetThreadDesktop', 'GetUserObjectInformationW',
    ])
  })

  it('resolves false when the production koffi loader fails', async () => {
    koffiControl.state.failLoad = true
    await expect(hasInteractiveDesktop({ platform: 'win32' })).resolves.toBe(false)
  })
})
