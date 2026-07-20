/**
 * Global workspace search — state + the one `run()` orchestrator behind the
 * SearchPanel overlay (Ctrl/Cmd+Shift+F).
 *
 * A run searches every workspace root: the default notes dir plus each entry
 * of `settings.workspaces[]` (deduped by pathKey). Local roots go through the
 * Rust walker (`ipc.searchNotes`) for speed; Android `saf://` synced roots go
 * through the capped frontend walker (`searchSafTree`) because a Rust fs walk
 * cannot see SAF trees. Roots are searched sequentially so the shared result
 * cap flows from one root into the next.
 *
 * Failure model: a root that errors is skipped (its results are simply
 * missing) — `error` is set only when EVERY root failed. Stale-run guard: each
 * run takes a token; a run superseded by a newer one abandons its results
 * instead of clobbering them.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { SearchMatch } from '../../core/search';
import { ipc } from '../../ipc/commands';
import { isSafPath } from '../../ipc/provider';
import { getDefaultWorkspacePath, pathKey } from '../session';
import { searchSafTree } from '../search-saf';
import { settingsStore } from './settings';

/** Queries shorter than this don't run (the panel shows a hint instead). */
export const MIN_QUERY_LENGTH = 2;

/** Hard cap across all roots — results beyond this set `truncated`. */
const TOTAL_RESULT_CAP = 500;

/** Per-synced-root walker caps (see search-saf.ts). */
const SAF_FILE_CAP = 200;
const SAF_SIZE_CAP = 512 * 1024;

export interface SearchState {
  /** The search overlay is open. Transient, never persisted. */
  open: boolean;
  /** The last query `run()` was called with. */
  query: string;
  results: SearchMatch[];
  /** A run is in flight. */
  searching: boolean;
  /** Some source stopped at a cap — the result list is not exhaustive. */
  truncated: boolean;
  /** Set only when every root failed; a partial failure keeps its results. */
  error: string | null;
  setOpen: (open: boolean) => void;
  openSearch: () => void;
  closeSearch: () => void;
  run: (query: string) => Promise<void>;
  clear: () => void;
}

/** Monotonic run token — results from a superseded run are dropped. */
let runToken = 0;

/** Every workspace root to search: default notes dir + settings entries. */
function workspaceRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const defaultPath = getDefaultWorkspacePath();
  for (const path of [
    ...(defaultPath ? [defaultPath] : []),
    ...settingsStore.getState().settings.workspaces.map((w) => w.path),
  ]) {
    const key = pathKey(path);
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(path);
    }
  }
  return roots;
}

export const searchStore = createStore<SearchState>()((set, get) => ({
  open: false,
  query: '',
  results: [],
  searching: false,
  truncated: false,
  error: null,

  setOpen(open) {
    set({ open });
  },

  openSearch() {
    set({ open: true });
  },

  closeSearch() {
    set({ open: false });
  },

  async run(query) {
    const token = ++runToken;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      set({ query, results: [], searching: false, truncated: false, error: null });
      return;
    }
    set({ query, searching: true, error: null });

    const queryLower = trimmed.toLowerCase();
    const roots = workspaceRoots();
    const results: SearchMatch[] = [];
    let truncated = false;
    let failures = 0;
    let firstError: string | null = null;

    for (const root of roots) {
      const remaining = TOTAL_RESULT_CAP - results.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      try {
        if (isSafPath(root)) {
          const out = await searchSafTree(root, queryLower, {
            fileCap: SAF_FILE_CAP,
            sizeCap: SAF_SIZE_CAP,
            resultCap: remaining,
          });
          results.push(...out.matches);
          truncated = truncated || out.truncated;
        } else {
          // SearchHit is shape-identical to SearchMatch (path/line/col/lineText).
          const hits = await ipc.searchNotes(root, trimmed, remaining);
          results.push(...hits);
          // The Rust walker stops AT the cap, so filling it means there may
          // have been more.
          truncated = truncated || hits.length >= remaining;
        }
      } catch (e) {
        failures++;
        firstError ??= e instanceof Error ? e.message : String(e);
      }
      if (token !== runToken) {
        return; // superseded — a newer run owns the state now
      }
    }

    if (token !== runToken) {
      return;
    }
    const allFailed = roots.length > 0 && failures === roots.length;
    set({
      results,
      searching: false,
      truncated: truncated || results.length >= TOTAL_RESULT_CAP,
      error: allFailed ? (firstError ?? 'Search failed.') : null,
    });
  },

  clear() {
    runToken++; // any in-flight run becomes stale
    if (get().searching || get().query !== '' || get().results.length > 0) {
      set({ query: '', results: [], searching: false, truncated: false, error: null });
    }
  },
}));

export const useSearchStore = <T>(selector: (s: SearchState) => T): T =>
  useStore(searchStore, selector);
