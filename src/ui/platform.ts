/**
 * Runtime platform detection for behaviour that must differ on mobile.
 *
 * Kept separate from `keymap.ts`'s `detectPlatform` (which only distinguishes
 * mac vs other for keyboard modifiers). Here we care about Android, because the
 * storage model, launch-file handling, and several desktop-only UI affordances
 * (native window controls, folder pickers, tab tear-off) do not apply there.
 *
 * The Android WebView user-agent reliably contains "Android"; we avoid a Rust
 * round-trip so this can run on the boot-critical path (`resolvePaths`).
 */

import type { DesktopOs } from '../core/terminal-shells';

export type Runtime = 'android' | 'desktop';

/** Pure predicate over a user-agent string (kept separate so it's unit-testable). */
export function isAndroidUA(ua: string): boolean {
  return /Android/i.test(ua);
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && isAndroidUA(navigator.userAgent);
}

/** Any touch-first mobile OS. iOS support would extend this later. */
export function isMobile(): boolean {
  return isAndroid();
}

/** Pure predicate over a user-agent string (kept separate so it's unit-testable).
 *  Every Windows WebView2 UA carries "Windows NT"; Android never does. */
export function isWindowsUA(ua: string): boolean {
  return /Windows NT/i.test(ua);
}

/** Desktop Windows — where the scan's OCR has an on-device engine
 *  (`Windows.Media.Ocr`); macOS/Linux report it unavailable. */
export function isWindows(): boolean {
  return typeof navigator !== 'undefined' && !isAndroid() && isWindowsUA(navigator.userAgent);
}

/** Pure predicate over a user-agent string. Every WebKit UA on macOS says so. */
export function isMacUA(ua: string): boolean {
  return /Mac OS X|Macintosh/i.test(ua);
}

/**
 * Which desktop OS this is — the granularity the terminal's shell picker
 * needs, and the reason it is here rather than in `keymap.ts` (which only
 * cares whether the modifier key is Cmd). Android reports 'linux'; nothing
 * there opens a terminal, so the answer never reaches a user.
 */
export function desktopOsFromUA(ua: string): DesktopOs {
  if (isWindowsUA(ua)) return 'windows';
  if (!/Android/i.test(ua) && isMacUA(ua)) return 'mac';
  return 'linux';
}

export function desktopOs(): DesktopOs {
  return desktopOsFromUA(typeof navigator === 'undefined' ? '' : navigator.userAgent);
}

export function detectRuntime(): Runtime {
  return isAndroid() ? 'android' : 'desktop';
}
