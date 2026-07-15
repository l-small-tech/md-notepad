/**
 * Resolves the two directories the session lives in. Kept in `src/ipc`
 * because it is the only frontend code that touches `@tauri-apps/api/path`
 * (same rationale as commands.ts owning `invoke`).
 *
 * - `notesDir`   — user data: real `.md` files. The settings override wins;
 *   otherwise `<appDataDir>/notes`. (Settings persistence is M6; until then
 *   `settings.notesDir` is null and the default applies.)
 * - `sessionDir` — machine-local app state: `session.json` + `buffers/`.
 *   Always `<appDataDir>/session`, never user-configurable (see
 *   src/core/README.md, two-tier data placement).
 */

import { appDataDir, join, resolveResource } from '@tauri-apps/api/path';
import type { Settings } from '../core/types';
import { ipc } from './commands';
import { detectRuntime, type Runtime } from '../ui/platform';

export interface SessionPaths {
  notesDir: string;
  sessionDir: string;
}

/**
 * `sessionDir` (machine-local app state) always lives under the INTERNAL app
 * data dir, on every platform — it is the app's private scratch area.
 *
 * `notesDir` (user data) defaults to `<appDataDir>/notes` on desktop, but on
 * Android to the app-specific EXTERNAL dir
 * (`/storage/emulated/0/Android/data/<pkg>/files/notes`) so the files are
 * visible in a file manager and need no runtime permission. `appDataDir()` on
 * Android only exposes the internal dir, so we ask Rust for the external one and
 * fall back to internal if it is unavailable. A user override always wins.
 */
export async function resolvePaths(
  settings: Settings,
  platform: Runtime = detectRuntime(),
): Promise<SessionPaths> {
  const base = await appDataDir();
  const sessionDir = await join(base, 'session');

  let defaultNotes = await join(base, 'notes');
  if (platform === 'android') {
    const ext = await ipc.externalFilesDir().catch(() => null);
    if (ext) {
      defaultNotes = await join(ext, 'notes');
    }
  }

  const notesDir = settings.notesDir ?? defaultNotes;
  return { notesDir, sessionDir };
}

/**
 * The pluggable-themes folder: user-droppable theme `.json` files (see
 * ipc/theme-loader.ts). Like `notesDir`, it defaults under the INTERNAL app data
 * dir on desktop (`<appDataDir>/themes`) but on Android under the app-specific
 * EXTERNAL files dir so the seeded example files are visible in a file manager
 * (and thus copyable/editable). Always app-owned local storage — never a SAF
 * synced tree — so the std::fs-based commands handle it on both platforms. Falls
 * back to the internal dir if the external one is unavailable.
 */
export async function resolveThemesDir(platform: Runtime = detectRuntime()): Promise<string> {
  const base = await appDataDir();
  if (platform === 'android') {
    const ext = await ipc.externalFilesDir().catch(() => null);
    if (ext) {
      return await join(ext, 'themes');
    }
  }
  return await join(base, 'themes');
}

/**
 * The bundled user documentation folder (tauri.conf.json bundles ../docs as a
 * `docs` resource). Null when resolution fails (e.g. outside a Tauri webview);
 * the Settings "Open docs" button degrades to a notice then.
 *
 * On Android the resource lives inside the APK as a compressed asset, so
 * `resolveResource` would return an `asset://` URI our std::fs-based read/list
 * commands can't touch. Instead we ask Rust to extract the tree to a real
 * internal-storage path (see `ipc.extractDocsDir`) and hand that back.
 */
export async function resolveDocsDir(platform: Runtime = detectRuntime()): Promise<string | null> {
  if (platform === 'android') {
    return await ipc.extractDocsDir().catch(() => null);
  }
  try {
    return await resolveResource('docs');
  } catch {
    return null;
  }
}
