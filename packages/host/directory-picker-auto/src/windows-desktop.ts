/**
 * Interactive-desktop probe for the native backend's win32 tier: whether this
 * process runs on the operator-visible `WinSta0\Default` desktop — the one
 * interactivity signal `resolveDirectoryPickerBackend` cannot read from the
 * environment. Sampled once at boot with the other resolver facts; a host
 * whose chooser can never reach the operator keeps the `browse` interaction.
 * The module loads on every platform; koffi is imported lazily inside the
 * loader, so a non-win32 process never loads it (the same containment as the
 * native backend's win32 bindings).
 * @module @deepseek-ai/dsh-host-directory-picker-auto/windows-desktop
 */

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface Koffi { load(path: string): KoffiLibrary }

/** The user32/kernel32 calls the probe sequences (satisfied by koffi in production). */
export interface DesktopProbeBindings {
  /** `GetProcessWindowStation` of this process. */
  getProcessWindowStation(): unknown
  /** `GetCurrentThreadId` of the calling thread. */
  getCurrentThreadId(): number
  /** `GetThreadDesktop` of the given thread. */
  getThreadDesktop(threadId: number): unknown
  /**
   * `GetUserObjectInformationW(UOI_NAME)` of a user object.
   * @param handle - the window station or desktop handle.
   * @param buffer - wide-character name buffer the call fills.
   * @param needed - 4-byte buffer the call fills with the required length.
   * @returns the call's BOOL result.
   */
  readUserObjectName(handle: unknown, buffer: Buffer, needed: Buffer): number
}

/** Injectable seams for deterministic cross-platform tests. */
export interface WindowsDesktopProbeInternals {
  /** Platform override; production reads `process.platform`. */
  platform?: NodeJS.Platform
  /** Binding loader override; production loads koffi. */
  loadBindings?: () => Promise<DesktopProbeBindings>
}

/** `UOI_NAME`: the user object's name. */
const UOI_NAME = 2
/** Name-buffer size in wide characters; user object names are far shorter. */
const NAME_BUFFER_WIDE_CHARS = 256
/** The interactive window station every logon session's desktop sits on. */
const INTERACTIVE_WINDOW_STATION = 'WinSta0'
/** The interactive desktop inside that window station. */
const INTERACTIVE_DESKTOP = 'Default'

async function loadKoffiBindings(): Promise<DesktopProbeBindings> {
  const koffi = (await import('koffi')).default as unknown as Koffi
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  return {
    getProcessWindowStation: () => user32.func('__stdcall', 'GetProcessWindowStation', 'void *', [])(),
    getCurrentThreadId: () => kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])() as number,
    getThreadDesktop: threadId => user32.func('__stdcall', 'GetThreadDesktop', 'void *', ['uint32'])(threadId),
    readUserObjectName: (handle, buffer, needed) =>
      user32.func('__stdcall', 'GetUserObjectInformationW', 'int', ['void *', 'int', 'void *', 'int', 'void *'])(handle, UOI_NAME, buffer, buffer.length, needed) as number,
  }
}

/** Find the first aligned NUL wide character (even offset); -1 when absent. */
function wideNul(buffer: Buffer): number {
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    if (buffer.readUInt16LE(offset) === 0) return offset
  }
  return -1
}

/** Trim the wide-char name buffer at its NUL terminator. */
function readName(bindings: DesktopProbeBindings, handle: unknown): string {
  if (handle === null || handle === undefined) return ''
  const buffer = Buffer.alloc(NAME_BUFFER_WIDE_CHARS * 2)
  const needed = Buffer.alloc(4)
  if (bindings.readUserObjectName(handle, buffer, needed) === 0) return ''
  const nul = wideNul(buffer)
  return buffer.toString('utf16le', 0, nul === -1 ? buffer.length : nul)
}

/**
 * Whether a native chooser can reach the operator: non-win32 hosts are
 * treated as attended (linux consults `DISPLAY` in the resolver, darwin has
 * no probe), and a win32 host qualifies only when its process window station
 * and desktop are the interactive ones. A failed binding load resolves to
 * false: the native backend needs the same koffi binding to serve a pick, so
 * `browse` is the working interaction on such a host.
 * @param internals - platform and binding-loader hooks for deterministic tests.
 * @returns whether this process runs on the interactive desktop.
 */
export async function hasInteractiveDesktop(internals: WindowsDesktopProbeInternals = {}): Promise<boolean> {
  const platform = internals.platform ?? process.platform
  if (platform !== 'win32') return true
  let bindings: DesktopProbeBindings
  try {
    bindings = await (internals.loadBindings ?? loadKoffiBindings)()
  } catch {
    return false
  }
  return readName(bindings, bindings.getProcessWindowStation()) === INTERACTIVE_WINDOW_STATION
    && readName(bindings, bindings.getThreadDesktop(bindings.getCurrentThreadId())) === INTERACTIVE_DESKTOP
}
