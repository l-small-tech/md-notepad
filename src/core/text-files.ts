/**
 * Which file extensions the app treats as editable text notes. Markdown is the
 * native format; plain `.txt` files are first-class citizens too — they list in
 * the explorer, open in the normal editor tabs, and save through the same
 * atomic-write path. Kept as its own tiny module so the explorer, the storage
 * providers, and the session controller all agree on one definition (the Rust
 * `list_dir` filter mirrors it — see src-tauri/src/commands/fs.rs).
 */

import { pathKey } from './tab-workspaces';

/** True for markdown files (`.md` / `.markdown`). */
export function isMarkdownPath(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** True for any editable text note: markdown or plain `.txt`. */
export function isEditableTextPath(name: string): boolean {
  return isMarkdownPath(name) || name.toLowerCase().endsWith('.txt');
}

/**
 * "Show unsupported files" for a folder (`settings.showAllFilesDirs`): 'on'
 * when the folder itself was switched on, 'inherited' when a parent folder or
 * its workspace was, 'off' otherwise. Where it isn't 'off' the explorer lists
 * every file (source files, configs…), which then open as plain source text.
 * Compared on path keys, so `C:\Notes` and `c:/notes/` are one folder.
 */
export function showAllFilesState(
  dir: string,
  enabledDirs: readonly string[],
): 'on' | 'inherited' | 'off' {
  const key = pathKey(dir).replace(/\/+$/, '');
  let inherited = false;
  for (const enabled of enabledDirs) {
    const root = pathKey(enabled).replace(/\/+$/, '');
    if (key === root) {
      return 'on';
    }
    if (key.startsWith(`${root}/`)) {
      inherited = true;
    }
  }
  return inherited ? 'inherited' : 'off';
}

/** Does the explorer list every file in `dir` (see `showAllFilesState`)? */
export function showsAllFiles(dir: string, enabledDirs: readonly string[]): boolean {
  return showAllFilesState(dir, enabledDirs) !== 'off';
}
