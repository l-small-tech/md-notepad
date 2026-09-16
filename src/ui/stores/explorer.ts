/**
 * The file drawer's row selection and its cut/copy/paste clipboard.
 *
 * Two pieces of transient state that belong together and outlive no session:
 *
 * - `selected` — the row that was last clicked or right-clicked, file OR
 *   folder. `uiStore.selectedExplorerDir` already tracks the selected
 *   *directory* (the paste destination, and a new terminal's cwd), but the
 *   keyboard needs to know which ROW the user means, and files are rows too.
 *   The two are set together on a folder click; a file click only moves this
 *   one.
 * - `clipboard` — one cut or copied entry (see `core/explorer-clipboard.ts`
 *   for the pure half). Single-entry by design: the drawer has no multi-select
 *   anywhere, so neither does this.
 *
 * A cut entry is only a marked path — nothing has moved yet, and nothing does
 * until a paste. `dropUnder` clears both when the folder they point into is
 * deleted or its workspace is removed, mirroring
 * `uiStore.dropSelectedExplorerDirUnder`.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ExplorerClipboardEntry, ExplorerClipboardMode } from '../../core/explorer-clipboard';
import { pathKey } from '../../core/tab-workspaces';

/** A selected explorer row. */
export interface ExplorerSelection {
  path: string;
  isDir: boolean;
}

export interface ExplorerState {
  selected: ExplorerSelection | null;
  clipboard: ExplorerClipboardEntry | null;
  /** Remember the row the user clicked or right-clicked. */
  select: (row: ExplorerSelection | null) => void;
  /** Put a row on the clipboard; replaces whatever was there. */
  put: (entry: { path: string; name: string; isDir: boolean }, mode: ExplorerClipboardMode) => void;
  /** Empty the clipboard (after a cut+paste, or when the source vanishes). */
  clearClipboard: () => void;
  /** Forget a selection/clipboard entry at or under `root` (deleted folder,
   *  removed workspace). */
  dropUnder: (root: string) => void;
}

/** `path` is `root` itself, or lives inside it. */
function isUnder(path: string, root: string): boolean {
  const key = pathKey(path);
  const rootKey = pathKey(root);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

export const explorerStore = createStore<ExplorerState>()((set) => ({
  selected: null,
  clipboard: null,

  select(row) {
    set((s) =>
      s.selected?.path === row?.path && s.selected?.isDir === row?.isDir ? s : { selected: row },
    );
  },

  put(entry, mode) {
    set({ clipboard: { ...entry, mode } });
  },

  clearClipboard() {
    set((s) => (s.clipboard === null ? s : { clipboard: null }));
  },

  dropUnder(root) {
    set((s) => {
      const next: Partial<ExplorerState> = {};
      if (s.selected && isUnder(s.selected.path, root)) {
        next.selected = null;
      }
      if (s.clipboard && isUnder(s.clipboard.path, root)) {
        next.clipboard = null;
      }
      return Object.keys(next).length > 0 ? next : s;
    });
  },
}));

export const useExplorerStore = <T>(selector: (s: ExplorerState) => T): T =>
  useStore(explorerStore, selector);
