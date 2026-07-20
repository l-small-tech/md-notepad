/**
 * search.ts — the pure text-matching half of global workspace search.
 *
 * Case-insensitive substring matching only, by design: the caller passes an
 * already-lowercased needle (`queryLower`), and each line is lowercased here
 * before an indexOf scan. Regex support is intentionally future work — keeping
 * the query parameter a plain (pre-lowered) string leaves that door open
 * without changing the signature's shape.
 *
 * The Rust command `search_notes` (src-tauri/src/commands/search.rs) is the
 * fast path for local roots and mirrors these rules exactly — matching
 * semantics (non-overlapping occurrences, 1-based line/col) and the ~200-char
 * clipping window must stay in sync between the two implementations. This TS
 * side serves the SAF (synced-folder) walker, where Rust cannot see the tree.
 */

export interface SearchMatch {
  /** The file's identifier (local path or `saf://…` id), verbatim. */
  path: string;
  /** 1-based line number of the hit. */
  line: number;
  /** 1-based column (character offset within the lowercased line) of the hit. */
  col: number;
  /** The matched line, trimmed of leading whitespace and clipped to ~200 chars
   *  centered on the hit, with `…` marking a cut at either end. */
  lineText: string;
}

/** Max characters of a line shown around a hit (excluding the `…` markers). */
const CLIP_WIDTH = 200;

/**
 * Clip `line` to at most {@link CLIP_WIDTH} characters centered on the hit at
 * `hitIdx`, after dropping leading whitespace (unless the hit sits inside it).
 * A cut at either end is marked with `…`; the leading-whitespace trim is not a
 * cut, so it gets no marker.
 */
function clipAroundHit(line: string, hitIdx: number): string {
  const trimStart = Math.min(line.length - line.trimStart().length, hitIdx);
  const body = line.slice(trimStart);
  const hit = hitIdx - trimStart;
  if (body.length <= CLIP_WIDTH) {
    return body;
  }
  let start = Math.max(0, hit - Math.floor(CLIP_WIDTH / 2));
  const end = Math.min(body.length, start + CLIP_WIDTH);
  start = Math.max(0, end - CLIP_WIDTH);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end) + suffix;
}

/**
 * Find every case-insensitive occurrence of `queryLower` in `text`, up to
 * `cap` matches. Occurrences are non-overlapping (the scan resumes after each
 * hit); a line with several hits yields one match per occurrence. CRLF line
 * endings are handled (the trailing `\r` is stripped before matching). An
 * empty query — or a non-positive cap — yields no matches.
 */
export function findMatchesInText(
  path: string,
  text: string,
  queryLower: string,
  cap: number,
): SearchMatch[] {
  if (queryLower.length === 0 || cap <= 0 || text.length === 0) {
    return [];
  }
  const matches: SearchMatch[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    const lower = line.toLowerCase();
    let from = 0;
    while (from <= lower.length - queryLower.length) {
      const idx = lower.indexOf(queryLower, from);
      if (idx === -1) {
        break;
      }
      matches.push({
        path,
        line: i + 1,
        col: idx + 1,
        lineText: clipAroundHit(line, idx),
      });
      if (matches.length >= cap) {
        return matches;
      }
      from = idx + queryLower.length;
    }
  }
  return matches;
}
