/**
 * Three-way line merge — the heart of Live Edit mode (shared cloud folders).
 *
 * Given the text we last wrote or loaded (`base`), what the editor holds now
 * (`mine`) and what just appeared on disk (`theirs`), produce ONE text that
 * carries both sides' changes:
 *
 * - a region only one side touched takes that side's lines;
 * - a region both sides changed identically takes it once;
 * - a region both sides changed DIFFERENTLY takes THEIRS — the version on
 *   disk. Deterministic, so two machines converge instead of ping-ponging
 *   (a "mine wins" would have each side re-saving its own version forever),
 *   and never a duplicate line the document has to be cleaned of. What it
 *   costs the local author is reported, not hidden: `removed` says which of
 *   the current lines are about to go (the editor flashes them red before the
 *   change lands), and `lost` carries the author's own overwritten lines with
 *   the spot they came from, so the UI can offer to put them back.
 *
 * Texts are split on `\n` exactly like `diffLines` (a `\r` stays on its line,
 * a trailing newline yields a final empty line), so joining the merged lines
 * with `\n` reproduces either input byte-for-byte when the other side is
 * unchanged. Pure; no DOM, no Tauri, no React.
 */

import { diffLines, type DiffOp } from './diff';

/** A char range `[from, to)`. */
export interface CharRange {
  from: number;
  to: number;
}

/** A block of the local author's lines that the merge replaced with theirs. */
export interface LostBlock {
  /** The overwritten lines, as they were. */
  lines: string[];
  /**
   * Char offset into the MERGED text of the start of the line right after
   * their replacement — where "Restore mine" reinserts the block, so the two
   * versions end up adjacent and the author can reconcile them.
   */
  afterOffset: number;
}

export interface MergeResult {
  text: string;
  /** Lines of `text` that came from the other side — the green flash. */
  theirs: CharRange[];
  /** Lines of `mine` (the CURRENT text) the merge removes or replaces — the red flash. */
  removed: CharRange[];
  /** My own edits that lost to theirs, for the Restore-mine banner. */
  lost: LostBlock[];
  /** Regions where both sides edited the same lines (theirs won). */
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

/** Char range covering lines `[startLine, endLine)`, excluding the final newline. */
function lineSpan(offsets: number[], startLine: number, endLine: number): CharRange {
  const from = offsets[startLine]!;
  return { from, to: Math.max(from, offsets[endLine]! - 1) };
}

/**
 * Which of our past snapshots did `theirs` grow from? Sync clients resolve a
 * write race last-writer-wins, so a text can arrive that was built on the
 * snapshot BEFORE our last write (our write never reached that machine).
 * Merging it against our latest snapshot would read our own lines as "theirs
 * deleted these" — a plain edit, nothing to warn about; merging against the
 * snapshot it actually derives from sees the collision, so the author gets
 * the red flash and the Restore-mine offer. The base is the candidate whose
 * diff to `theirs` is smallest — line count first, then word count for a
 * finer read of "did they edit MY line or write over the original?" — and on
 * an exact tie the OLDER one, because a warning you can dismiss beats a
 * silent loss.
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
    return { text: mine, theirs: [], removed: [], lost: [], overlaps: 0, changed: false };
  }
  const baseLines = base.split('\n');
  const mineOffsets = lineOffsets(mine.split('\n'));
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
  const theirsLines: Array<[number, number]> = [];
  const removed: CharRange[] = [];
  const lostBlocks: Array<{ lines: string[]; afterLine: number }> = [];
  let overlaps = 0;
  let pos = 0;
  // Where the current region starts in MINE's line space: its base position
  // plus the net growth of every one of my hunks before it.
  let mineDelta = 0;
  for (const r of regions) {
    out.push(...baseLines.slice(pos, r.start));
    pos = r.end;
    const mineStartLine = r.start + mineDelta;
    const mineSide = sideText(baseLines, r.start, r.end, r.mine);
    for (const h of r.mine) {
      mineDelta += h.lines.length - (h.end - h.start);
    }
    if (r.theirs.length === 0) {
      out.push(...mineSide); // mine only
      continue;
    }
    const theirText = sideText(baseLines, r.start, r.end, r.theirs);
    if (sameLines(mineSide, theirText)) {
      out.push(...theirText); // both made the same change: nothing to flag
      continue;
    }
    if (r.mine.length > 0) {
      // Both changed the same lines differently: theirs wins, mine is kept
      // aside for the Restore-mine offer.
      overlaps += 1;
      lostBlocks.push({ lines: mineSide, afterLine: out.length + theirText.length });
    }
    // Their lines replace mine here. Flag only what really changes: the
    // lines of mine that go (red, in the current text) and the lines of
    // theirs that are new (green, in the merged text). An empty side is a
    // pure deletion/insertion — diffing it would invent an empty line.
    if (theirText.length === 0) {
      removed.push(lineSpan(mineOffsets, mineStartLine, mineStartLine + mineSide.length));
    } else if (mineSide.length === 0) {
      theirsLines.push([out.length, out.length + theirText.length]);
    } else {
      for (const op of diffLines(mineSide.join('\n'), theirText.join('\n'))) {
        if (op.type === 'delete') {
          const startLine = mineStartLine + op.oldStart;
          removed.push(lineSpan(mineOffsets, startLine, startLine + op.lines.length));
        } else if (op.type === 'insert') {
          const startLine = out.length + op.newStart;
          theirsLines.push([startLine, startLine + op.lines.length]);
        }
      }
    }
    out.push(...theirText);
  }
  out.push(...baseLines.slice(pos));

  const text = out.join('\n');
  const outOffsets = lineOffsets(out);
  const lost: LostBlock[] = lostBlocks.map((b) => ({
    lines: b.lines,
    afterOffset: Math.min(outOffsets[b.afterLine]!, text.length),
  }));
  return {
    text,
    theirs: theirsLines.map(([s, e]) => lineSpan(outOffsets, s, e)),
    removed,
    lost,
    overlaps,
    changed: text !== mine,
  };
}

/**
 * "Restore mine": put lost blocks back into `text` right after the lines that
 * replaced them, highest offset first so earlier insertions do not shift the
 * later ones. An offset past the end (the document shrank since) appends.
 * Returns the new text and where each block landed (for the green flash).
 */
export function restoreLostBlocks(
  text: string,
  blocks: readonly LostBlock[],
): { text: string; inserted: CharRange[] } {
  const ordered = [...blocks].sort((a, b) => b.afterOffset - a.afterOffset);
  const inserted: CharRange[] = [];
  let out = text;
  for (const block of ordered) {
    const at = Math.min(block.afterOffset, out.length);
    const atLineStart = at === 0 || out[at - 1] === '\n';
    const atEnd = at === out.length;
    const body = block.lines.join('\n');
    // Keep the block on lines of its own whatever it lands next to, and keep
    // a newline-terminated document terminated when appending to it.
    const leading = atLineStart ? '' : '\n';
    const trailing = !atEnd || (atLineStart && at > 0) ? '\n' : '';
    const chunk = leading + body + trailing;
    out = out.slice(0, at) + chunk + out.slice(at);
    const from = at + (atLineStart ? 0 : 1);
    inserted.push({ from, to: from + body.length });
  }
  return { text: out, inserted };
}
