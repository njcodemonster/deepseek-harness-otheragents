# Agent Note: win32 native picker requires an interactive desktop

Status: implemented

English | [中文](2026-08-24-win32-native-picker-requires-interactive-desktop.zh.md)

## Problem

`directory-picker-auto` resolved `native` on win32 whenever the bind was loopback and no SSH markers were set, assuming any win32 process can show a chooser. That assumption fails when the web server runs on a desktop the operator cannot see: sandboxed launches (an isolated `exebox-*` desktop) and service sessions (`Service-0x0-…$`) create the dialog window on an invisible desktop. The pick then never fails loudly — the dialog just never appears — so "Add workspace" looks dead while a real dialog accumulates on the hidden desktop.

## Decision

`resolveDirectoryPickerBackend` gains a required `interactiveDesktop` boot-time fact. On win32 it is sampled by the new `hasInteractiveDesktop` probe, which reads the process window station and desktop through koffi (`GetProcessWindowStation`, `GetThreadDesktop`, `GetUserObjectInformationW`) and requires exactly `WinSta0\Default`. darwin samples true (no probe exists); linux keeps its `DISPLAY`/`WAYLAND_DISPLAY` signal. The probe returns true on non-win32 hosts without loading koffi, and a failed binding load resolves false — the native backend needs the same koffi binding to serve a pick, so `browse` is the working interaction on such a host.

When the fact is false, the chooser mounts the already-shipped browse pair (host backend + client surface), and the picker renders in the browser. The web-app bundle already declares both faces, so no composition change is needed.

## Verification

The resolver spec pins the new branch (win32 and darwin with `interactiveDesktop: false` resolve `browse`; linux ignores the fact). A new probe spec drives every branch against injected fake bindings. The REAL-composition loader spec mocks the probe — the OS desktop is a fact no env stub can force — and pins both outcomes: interactive hosts mount `native`, non-interactive hosts mount `browse`.

## Alternatives considered

**Keep `native` and rely on the surfaced failure.** Rejected: an invisible dialog does not fail — the pick hangs silently, so the backend's retryable error surface never appears and the user sees "nothing happens".

**Probe through a spawned child that reports its own desktop.** Rejected: the child inherits the parent's desktop and the result is equivalent, but a boot-time process spawn costs more than the in-process koffi read, which reuses the workspace's existing koffi dependency and the native backend's binding patterns.

**Host the probe in `directory-picker-native` and read it through the seam.** Rejected: resolution runs before the backend mounts, and `-auto` importing the picker package would add a dependency edge that does not exist.

**Fall back to `browse` at runtime when a native pick fails.** Already rejected by the [PowerShell-chain removal note](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md): the flow holes are `single`-kind and the chooser picks one backend at boot; a runtime cross-kind hop would double-mount both faces.

## Consequences

Hosts without an interactive desktop — harness sandboxes, service sessions, remote/headless deployments — now get the in-browser browse picker, and the invisible-dialog symptom disappears. Interactive desktops keep `native`. The auto package gains `koffi` as a dependency (already present in the workspace tree) and a win32 probe that runs in the host process; its failure mode is a conservative `browse`. Related decisions — the [native picker feature](../feature/2026-07-27-native-workspace-directory-picker.md), the [koffi dialog tier](../feature/2026-08-02-win32-in-process-folder-dialog.md), and the [fallback criterion](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md) — stand unchanged.
