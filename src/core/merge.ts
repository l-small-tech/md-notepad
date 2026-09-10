/**
 * Three-way line merge — the heart of Live Edit mode (shared cloud folders).
 *
 * Given the text we last wrote or loaded (`base`), what the editor holds now
 * (`mine`) and what just appeared on disk (`theirs`), produce ONE text that
 * carries both sides' changes:
 *
 * - a region only one side touched takes that side's lines;
 * - a region both sides changed identically takes it once;
 * - a region both sides changed DIFFERENTLY keeps both: my lines, then
 *   theirs. Never a conflict marker, never a dropped edit. This is what makes
 *   two machines converge instead of ping-ponging: once A saves "mine+theirs",
 *   B's next probe finds disk ≠ its baseline but equal to nothing it typed
 *   since, and simply adopts it.
 *
 * Texts are split on `\n` exactly like `diffLines` (a `\r` stays on its line,
 * a trailing newline yields a final empty line), so joining the merged lines
 * with `\n` reproduces either input byte-for-byte when the other side is
 * unchanged. Pure; no DOM, no Tauri, no React.
 */

import { diffLines, type DiffOp } from './diff';

/** A contiguous run of the merged text that came from the other side. */
export interface MergedRange {
  /** Char offsets into `text`, `[from, to)`. */
  from: number;
  to: number;
  /** 0-based line offsets into `text`, `[startLine, endLine)`. */
  startLine: number;
  endLine: number;
}

export interface MergeResult {
  text: string;
  /** Where the other side's lines landed — for the fading highlight. */
  theirs: MergedRange[];
  /** Regions where both sides edited the same lines and both were kept. */
  overlaps: number;
  /** True when `text` differs from `mine` — i.e. the editor must change. */
  changed: boolean;
}

/** One side's edit against the base: replace base lines `[start, end)` with `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Collapse a diff's non-equal runs into replace-hunks against the old text. */
function hunksFromOps(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      current = null;
      continue;
    }
    if (current === null) {
      current = { start: op.oldStart, end: op.oldStart, lines: [] };
      hunks.push(current);
    }
    if (op.type === 'delete') {
      current.end += op.lines.length;
    } else {
      current.lines.push(...op.lines);
    }
  }
  return hunks;
}

/**
 * Do two base ranges collide? Proper intersection, or an insertion (empty
 * range) that sits strictly INSIDE the other range, or two insertions at the
 * very same point. Insertions at a range's boundary do not collide — they
 * simply order before/after it.
 */
function collides(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  if (a.start < b.end && b.start < a.end) {
    return true;
  }
  const aEmpty = a.start === a.end;
  const bEmpty = b.start === b.end;
  if (aEmpty && bEmpty) {
    return a.start === b.start;
  }
  if (aEmpty) {
    return b.start < a.start && a.start < b.end;
  }
  if (bEmpty) {
    return a.start < b.start && b.start < a.end;
  }
  return false;
}

/** Apply one side's hunks that fall inside base `[start, end)` to that slice. */
function sideText(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...base.slice(pos, end));
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Which of our past snapshots did `theirs` grow from? Sync clients resolve a
 * write race last-writer-wins, so a text can arrive that was built on the
 * snapshot BEFORE our last write (our write never reached that machine).
 * Merging it against our latest snapshot would read our own lines as "theirs
 * deleted these" and drop them silently; merging against the snapshot it
 * actually derives from keeps both. The base is the candidate whose diff to
 * `theirs` is smallest — line count first, then word count for a finer read
 * of "did they edit MY line or write over the original?" — and on an exact
 * tie the OLDER one, because keeping both lines beats losing one.
 *
 * `candidates` is newest first: [current snapshot, ...history].
 */
export function pickMergeBase(candidates: readonly string[], theirs: string): string {
  if (candidates.length <= 1) {
    return candidates[0] ?? '';
  }
  const lineCost = candidates.map((c) => changedLines(diffLines(c, theirs)));
  const best = Math.min(...lineCost);
  const tied = candidates.filter((_, i) => lineCost[i] === best);
  if (tied.length === 1) {
    return tied[0]!;
  }
  const wordCost = tied.map((c) => changedLines(diffLines(words(c), words(theirs))));
  const bestWords = Math.min(...wordCost);
  // Last index among the tied = oldest.
  return tied[wordCost.lastIndexOf(bestWords)]!;
}

function changedLines(ops: DiffOp[]): number {
  let n = 0;
  for (const op of ops) {
    if (op.type !== 'equal') {
      n += op.lines.length;
    }
  }
  return n;
}

/** Whitespace-split tokens, one per line, so diffLines becomes a word diff. */
function words(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join('\n');
}

export function mergeThreeWay(base: string, mine: string, theirs: string): MergeResult {
  if (theirs === base || theirs === mine) {
    return { text: mine, theirs: [], overlaps: 0, changed: false };
  }
  const baseLines = base.split('\n');
  const mineHunks = hunksFromOps(diffLines(base, mine)).map((h) => ({
    ...h,
    side: 'mine' as const,
  }));
  const theirHunks = hunksFromOps(diffLines(base, theirs)).map((h) => ({
    ...h,
    side: 'theirs' as const,
  }));

  // Group colliding hunks (across sides) into regions of the base, in order.
  type Region = { start: number; end: number; mine: Hunk[]; theirs: Hunk[] };
  const all = [...mineHunks, ...theirHunks].sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.side === 'mine' ? -1 : 1),
  );
  const regions: Region[] = [];
  for (const h of all) {
    const last = regions[regions.length - 1];
    if (last && collides(last, h)) {
      last.start = Math.min(last.start, h.start);
      last.end = Math.max(last.end, h.end);
      last[h.side].push(h);
    } else {
      regions.push({ start: h.start, end: h.end, mine: [], theirs: [] });
      regions[regions.length - 1]![h.side].push(h);
    }
  }

  const out: string[] = [];
  const theirLineRanges: Array<[number, number]> = [];
  let overlaps = 0;
  let pos = 0;
  for (const r of regions) {
    out.push(...baseLines.slice(pos, r.start));
    pos = r.end;
    const mineText = r.mine.length > 0 ? sideText(baseLines, r.start, r.end, r.mine) : null;
    const theirText = r.theirs.length > 0 ? sideText(baseLines, r.start, r.end, r.theirs) : null;
    if (theirText === null) {
      out.push(...mineText!);
      continue;
    }
    if (mineText === null || sameLines(mineText, theirText)) {
      // Theirs only, or both made the same change: take it once. Highlight
      // only genuinely incoming lines.
      if (mineText === null && theirText.length > 0) {
        theirLineRanges.push([out.length, out.length + theirText.length]);
      }
      out.push(...theirText);
      continue;
    }
    // Both changed the same lines differently: keep mine, then theirs.
    overlaps += 1;
    out.push(...mineText);
    if (theirText.length > 0) {
      theirLineRanges.push([out.length, out.length + theirText.length]);
    }
    out.push(...theirText);
  }
  out.push(...baseLines.slice(pos));

  const text = out.join('\n');
  const offsets = lineOffsets(out);
  const ranges: MergedRange[] = theirLineRanges.map(([s, e]) => ({
    from: offsets[s]!,
    to: e < out.length ? offsets[e]! - 1 : text.length,
    startLine: s,
    endLine: e,
  }));
  return { text, theirs: ranges, overlaps, changed: text !== mine };
}

/** Start offset of each line (and one past the end) in `lines.join('\n')`. */
function lineOffsets(lines: string[]): number[] {
  const offsets = [0];
  let acc = 0;
  for (const line of lines) {
    acc += line.length + 1;
    offsets.push(acc);
  }
  return offsets;
}
