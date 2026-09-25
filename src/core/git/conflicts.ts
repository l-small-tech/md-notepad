/**
 * Conflict markers — DETECTION only. The app never resolves a conflict
 * itself: the user's agent does, and this module is how the panel watches
 * that happen (the tracker re-reads each unmerged file and asks "any
 * markers left?"). Pure; no DOM, no Tauri, no React.
 *
 * A conflict block is `<<<<<<< ` … (`||||||| ` … in diff3 style) `=======` …
 * `>>>>>>> `, each marker at the start of a line. A lone `=======` is NOT a
 * marker — it is a setext heading underline in half the markdown files this
 * app opens — so only a `=======` between an opening and a closing marker
 * counts. CRLF endings are tolerated. The scan is meant for files git has
 * reported unmerged; on an arbitrary file a fenced code block quoting a
 * conflict would read as one.
 */

import type { ConflictTracker } from './types';

const OPEN = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SEP = /^={7}$/;
const CLOSE = /^>{7}(?: |$)/;

interface Block {
  /** 1-based line numbers of the block's marker lines, in order. */
  markers: number[];
}

function scan(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let open: number[] | null = null;
  let sawSep = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const n = i + 1;
    if (OPEN.test(line)) {
      // A new opener abandons an unfinished block.
      open = [n];
      sawSep = false;
    } else if (open !== null && BASE.test(line) && !sawSep) {
      open.push(n);
    } else if (open !== null && SEP.test(line) && !sawSep) {
      open.push(n);
      sawSep = true;
    } else if (open !== null && sawSep && CLOSE.test(line)) {
      open.push(n);
      blocks.push({ markers: open });
      open = null;
      sawSep = false;
    }
  }
  return blocks;
}

/** Does the text still hold at least one complete conflict block? */
export function hasConflictMarkers(text: string): boolean {
  return scan(text).length > 0;
}

/** 1-based line numbers of every marker line that belongs to a complete block. */
export function conflictMarkerLines(text: string): number[] {
  return scan(text).flatMap((b) => b.markers);
}

/** How many complete conflict blocks the text holds. */
export function countConflictBlocks(text: string): number {
  return scan(text).length;
}

/** Why Continue is disabled, or `enabled: true`. */
export interface ContinueGate {
  enabled: boolean;
  reason: string | null;
}

/**
 * Continue merge is allowed only when git reports NO unmerged entry AND the
 * last marker scan found every tracked file clean (git happily commits a
 * file that was `git add`ed with its markers still in). `tracker` null means
 * no merge is being tracked: git's word alone decides.
 */
export function continueGate(unmergedCount: number, tracker: ConflictTracker | null): ContinueGate {
  if (unmergedCount > 0) {
    return {
      enabled: false,
      reason: `${unmergedCount} ${unmergedCount === 1 ? 'file is' : 'files are'} still unmerged`,
    };
  }
  if (tracker) {
    const dirty = tracker.files.filter((f) => tracker.markerFree[f] !== true);
    if (dirty.length > 0) {
      return {
        enabled: false,
        reason: `Conflict markers remain in ${dirty.length === 1 ? dirty[0] : `${dirty.length} files`}`,
      };
    }
  }
  return { enabled: true, reason: null };
}

/** `2 of 3 files clean` — the tracker line under the conflict list. */
export function trackerProgress(tracker: ConflictTracker): { clean: number; total: number } {
  return {
    clean: tracker.files.filter((f) => tracker.markerFree[f] === true).length,
    total: tracker.files.length,
  };
}
