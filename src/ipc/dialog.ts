/**
 * Native dialogs the UI reaches for outside the session controller's own
 * dialog set (main.tsx wires those). Same contract as every other seam here:
 * a rejection — no Tauri runtime, a dialog the platform cannot show — reads
 * as "the user cancelled", never as an exception in the caller.
 */

import { open } from '@tauri-apps/plugin-dialog';

/**
 * The OS folder picker, opened at `defaultPath` when one is given. Returns the
 * chosen folder's absolute path, or null when cancelled (or unavailable).
 */
export async function pickDirectory(
  defaultPath?: string | null,
  title?: string,
): Promise<string | null> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      ...(defaultPath ? { defaultPath } : {}),
      ...(title ? { title } : {}),
    });
    return typeof selected === 'string' ? selected : null;
  } catch {
    return null;
  }
}
