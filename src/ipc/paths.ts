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

import { appDataDir, join } from '@tauri-apps/api/path';
import type { Settings } from '../core/types';

export interface SessionPaths {
  notesDir: string;
  sessionDir: string;
}

export async function resolvePaths(settings: Settings): Promise<SessionPaths> {
  const base = await appDataDir();
  const notesDir = settings.notesDir ?? (await join(base, 'notes'));
  const sessionDir = await join(base, 'session');
  return { notesDir, sessionDir };
}
