/**
 * Capped frontend search walker for synced (`saf://`) workspace roots.
 *
 * Local roots are searched in Rust (`ipc.searchNotes`) for speed, but a Rust
 * fs walk cannot see an Android SAF tree — those live behind the platform's
 * DocumentsProvider — so synced roots are walked here through the storage
 * provider (listDir + readTextFile per file). Every SAF round trip is an IPC
 * call into a content resolver, so the walk is defensively capped: at most
 * `fileCap` files are read, none larger than `sizeCap`, and matching stops at
 * `resultCap` hits. Reads run `CONCURRENCY` at a time — enough to hide
 * per-file latency without hammering the provider.
 *
 * On desktop no `saf://` root exists, so this path simply never triggers.
 */

import { isCommentsPath } from '../core/comments';
import { findMatchesInText, type SearchMatch } from '../core/search';
import { isEditableTextPath } from '../core/text-files';
import { currentProvider, type StorageProvider } from '../ipc/provider';

export interface SafSearchOptions {
  /** Max number of files to read (walk stops beyond this → truncated). */
  fileCap: number;
  /** Files larger than this many bytes are skipped. */
  sizeCap: number;
  /** Stop after this many matches (→ truncated). */
  resultCap: number;
}

/** Same recursion guard as the Rust walker (pathological trees / cycles). */
const MAX_DEPTH = 16;

/** Parallel file reads. */
const CONCURRENCY = 4;

/**
 * Search every text note under the synced root `root` for `queryLower`
 * (already lowercased, like `findMatchesInText`'s parameter). Unlistable
 * dirs / unreadable files are skipped — search is best-effort. `provider` is
 * injectable for tests; the app always passes the active (routing) provider.
 */
export async function searchSafTree(
  root: string,
  queryLower: string,
  { fileCap, sizeCap, resultCap }: SafSearchOptions,
  provider: StorageProvider = currentProvider(),
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  let truncated = false;

  // Phase 1 — collect candidate files breadth-first, stopping at fileCap.
  const files: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await provider.listDir(dir);
      } catch {
        continue; // one unlistable dir must not kill the search
      }
      for (const entry of entries) {
        if (entry.isDir) {
          next.push(entry.path);
          continue;
        }
        if (!isEditableTextPath(entry.path) || isCommentsPath(entry.path)) {
          continue;
        }
        if (entry.size > sizeCap) {
          continue;
        }
        if (files.length >= fileCap) {
          truncated = true;
          break;
        }
        files.push(entry.path);
      }
      if (files.length >= fileCap && truncated) {
        break;
      }
    }
    if (files.length >= fileCap && truncated) {
      break;
    }
    level = next;
  }

  // Phase 2 — read + match, CONCURRENCY files at a time. `nextIndex` and
  // `matches` are shared safely: JS is single-threaded, and each worker only
  // touches them between awaits.
  const matches: SearchMatch[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < files.length && matches.length < resultCap) {
      const path = files[nextIndex++]!;
      let text: string;
      try {
        text = (await provider.readTextFile(path)).text;
      } catch {
        continue; // unreadable file: skip, keep searching
      }
      const remaining = resultCap - matches.length;
      if (remaining <= 0) {
        return;
      }
      matches.push(...findMatchesInText(path, text, queryLower, remaining));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
  if (matches.length >= resultCap) {
    truncated = true;
  }
  return { matches, truncated };
}
