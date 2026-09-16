/**
 * The explorer's cut/copy/paste clipboard — the pure half.
 *
 * The clipboard itself is one entry (a file or a folder) plus the mode it was
 * put there with; the store in `ui/stores/explorer.ts` holds it and the disk
 * surgery lives in `ui/session/explorer-ops.ts`. What is decidable without
 * touching disk lives here: what a pasted duplicate is called, and whether a
 * paste is allowed at all.
 *
 * Deliberately an IN-APP clipboard, not the OS one: the system clipboard
 * carries file lists in a platform-specific format (CF_HDROP on Windows,
 * NSFilenamesPboardType on macOS, `text/uri-list` on X11) that neither the
 * webview nor the Tauri clipboard plugin can write. Files copied in the OS
 * file manager still paste INTO the drawer — that path is the `paste` event in
 * FileExplorer, which sees them as `DataTransfer` files.
 */

import { dirName } from './session/plan-flush';
import { pathKey } from './tab-workspaces';

export type ExplorerClipboardMode = 'cut' | 'copy';

/** One cut/copied explorer row. `name` is kept so a moved/renamed source can
 *  still be named in a notice after the fact. */
export interface ExplorerClipboardEntry {
  path: string;
  name: string;
  isDir: boolean;
  mode: ExplorerClipboardMode;
}

/**
 * The name a pasted duplicate takes, VSCode-style: attempt 0 is the original
 * name (the no-collision case), then `notes copy.md`, `notes copy 2.md`, …
 * The extension is preserved for files; a folder's whole name is its base, so
 * `v1.2` stays `v1.2 copy` rather than growing a suffix in the middle.
 */
export function duplicateName(name: string, isDir: boolean, attempt: number): string {
  if (attempt <= 0) {
    return name;
  }
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const suffix = attempt === 1 ? 'copy' : `copy ${attempt}`;
  return `${base} ${suffix}${ext}`;
}

/**
 * What pasting `entry` into `destDir` would do, before any disk call:
 * - `into-self` — a folder pasted into itself or into one of its own
 *   descendants, which would recurse forever (copy) or vanish (move);
 * - `noop` — a cut pasted back into the folder it already lives in;
 * - `ok` — everything else. A COPY into the source's own folder is `ok`: that
 *   is "duplicate this", and {@link duplicateName} gives it a name.
 */
export function checkPaste(
  entry: Pick<ExplorerClipboardEntry, 'path' | 'isDir' | 'mode'>,
  destDir: string,
): 'ok' | 'noop' | 'into-self' {
  const source = pathKey(entry.path);
  const dest = pathKey(destDir);
  if (entry.isDir && (dest === source || dest.startsWith(`${source}/`))) {
    return 'into-self';
  }
  if (entry.mode === 'cut' && pathKey(dirName(entry.path)) === dest) {
    return 'noop';
  }
  return 'ok';
}
