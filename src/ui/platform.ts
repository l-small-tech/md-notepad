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

export function detectRuntime(): Runtime {
  return isAndroid() ? 'android' : 'desktop';
}
