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

/** Comparable folder key: `C:\Notes` and `c:/notes/` are one folder. */
function dirKey(dir: string): string {
  return pathKey(dir).replace(/\/+$/, '');
}

/** Is `path` the folder `rootKey` itself or inside it? */
function isAtOrBelow(path: string, rootKey: string): boolean {
  const key = dirKey(path);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

/**
 * "Show unsupported files" for a folder. Two lists of explicit switches —
 * `shownDirs` (`settings.showAllFilesDirs`) and `hiddenDirs`
 * (`settings.hideUnsupportedDirs`) — and the NEAREST one wins: the folder's
 * own switch, else its closest switched parent, else off. So a workspace can
 * show everything while one subfolder hides it again. `explicit` = the folder
 * carries its own switch. Where `show` is true the explorer lists every file
 * (source files, configs…), which then open as plain source text.
 */
export function showAllFilesState(
  dir: string,
  shownDirs: readonly string[],
  hiddenDirs: readonly string[] = [],
): { show: boolean; explicit: boolean } {
  const key = dirKey(dir);
  let best: { len: number; show: boolean; explicit: boolean } = {
    len: -1,
    show: false,
    explicit: false,
  };
  const consider = (dirs: readonly string[], show: boolean): void => {
    for (const d of dirs) {
      const root = dirKey(d);
      if (root.length > best.len && isAtOrBelow(key, root)) {
        best = { len: root.length, show, explicit: root === key };
      }
    }
  };
  consider(shownDirs, true);
  consider(hiddenDirs, false);
  return { show: best.show, explicit: best.explicit };
}

/** Does the explorer list every file in `dir` (see `showAllFilesState`)? */
export function showsAllFiles(
  dir: string,
  shownDirs: readonly string[],
  hiddenDirs: readonly string[] = [],
): boolean {
  return showAllFilesState(dir, shownDirs, hiddenDirs).show;
}

/**
 * The right-click toggle: flip what `dir` shows. Every switch at or below
 * `dir` is cleared first — setting a folder (a workspace root included) resets
 * its subfolders so they all follow it — and `dir` then gets a switch of its
 * own only if what it inherits differs from the wanted state.
 */
export function toggleShowAllFiles(
  dir: string,
  shownDirs: readonly string[],
  hiddenDirs: readonly string[],
): { shown: string[]; hidden: string[] } {
  const key = dirKey(dir);
  const want = !showsAllFiles(dir, shownDirs, hiddenDirs);
  const shown = shownDirs.filter((d) => !isAtOrBelow(d, key));
  const hidden = hiddenDirs.filter((d) => !isAtOrBelow(d, key));
  if (showsAllFiles(dir, shown, hidden) !== want) {
    (want ? shown : hidden).push(dir);
  }
  return { shown, hidden };
}
