/**
 * Line diff — pure text comparison for the DiffView (conflict banner "View
 * diff") and, later, the git integration. No DOM, no React, no Tauri.
 *
 * Two layers:
 *   - `diffLines(old, new)` — Myers O(ND) on lines, with common prefix/suffix
 *     trimming and a depth cap (beyond it the trimmed middle degrades to one
 *     delete+insert block rather than blowing memory on pathological inputs).
 *   - `buildDiffRows(ops)` — folds the ops into side-by-side rows: a delete
 *     block followed by an insert block is paired line-for-line (VS Code's
 *     "modified line" alignment), and each pair gets an intra-line changed
 *     range from common prefix/suffix trimming.
 *
 * Texts are compared EXACTLY (no CRLF or trailing-newline normalization) —
 * the app preserves line endings end-to-end, so the diff must too. `\r` is
 * stripped only for DISPLAY, in the row builder.
 */

export interface DiffOp {
  type: 'equal' | 'delete' | 'insert';
  /** The lines this op covers (from old for equal/delete, from new for insert). */
  lines: string[];
  /** 0-based line offsets where this op begins in the old / new text. */
  oldStart: number;
  newStart: number;
}

/** One side of a side-by-side row. */
export interface DiffSide {
  /** 1-based line number in that side's text. */
  num: number;
  /** Line text with a trailing `\r` stripped (display only). */
  text: string;
  changed: boolean;
  /** Intra-line changed char range `[start, end)`, when this row pairs a
   *  deleted line with an inserted one and the range is meaningful. */
  hi: [number, number] | null;
}

/** A side-by-side row; a side is null where the other side has no partner. */
export interface DiffRow {
  left: DiffSide | null;
  right: DiffSide | null;
}

/** Beyond this search depth (edit-script length) the middle of the texts is
 *  reported as one whole delete+insert block. Keeps memory bounded on
 *  pathological inputs; unreachable for ordinary notes. */
const MAX_EDIT_DEPTH = 2000;

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Myers greedy forward search over `a`/`b` slices; returns the edit script
 *  as 'e' (equal) / 'd' (delete) / 'i' (insert) steps, or null past the cap. */
function myersScript(a: string[], b: string[]): string | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DEPTH);
  const offset = max;
  // trace[d] snapshots V after round d, for backtracking.
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 2);
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!; // down: insert from b
      } else {
        x = v[offset + k - 1]! + 1; // right: delete from a
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice());
    if (found >= 0) {
      break;
    }
  }
  if (found < 0) {
    return null;
  }
  // Backtrack from (n, m) through the snapshots.
  let x = n;
  let y = m;
  const steps: string[] = [];
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
      prevK = k + 1; // came via insert
    } else {
      prevK = k - 1; // came via delete
    }
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push('e');
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      steps.push('i');
      y -= 1;
    } else {
      steps.push('d');
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    steps.push('e');
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    steps.push('d');
    x -= 1;
  }
  while (y > 0) {
    steps.push('i');
    y -= 1;
  }
  return steps.reverse().join('');
}

/** Line-based diff of two texts. Equal texts yield a single equal op (or an
 *  empty list for two empty texts is avoided — one equal op with ['']). */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Trim common prefix/suffix — the interesting region is usually small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre += 1;
  }
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const script = myersScript(midA, midB) ?? 'd'.repeat(midA.length) + 'i'.repeat(midB.length);

  const ops: DiffOp[] = [];
  let oldPos = 0;
  let newPos = 0;
  const push = (type: DiffOp['type'], lines: string[]): void => {
    if (lines.length === 0) {
      return;
    }
    const last = ops[ops.length - 1];
    if (last && last.type === type) {
      last.lines.push(...lines);
    } else {
      ops.push({ type, lines: [...lines], oldStart: oldPos, newStart: newPos });
    }
    if (type !== 'insert') {
      oldPos += lines.length;
    }
    if (type !== 'delete') {
      newPos += lines.length;
    }
  };

  push('equal', a.slice(0, pre));
  let ai = pre;
  let bi = pre;
  for (const step of script) {
    if (step === 'e') {
      push('equal', [a[ai]!]);
      ai += 1;
      bi += 1;
    } else if (step === 'd') {
      push('delete', [a[ai]!]);
      ai += 1;
    } else {
      push('insert', [b[bi]!]);
      bi += 1;
    }
  }
  push('equal', a.slice(a.length - suf));
  if (ops.length === 0) {
    ops.push({ type: 'equal', lines: [...a], oldStart: 0, newStart: 0 });
  }
  return ops;
}

/** Added/removed line counts over a diff. */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'insert') {
      added += op.lines.length;
    } else if (op.type === 'delete') {
      removed += op.lines.length;
    }
  }
  return { added, removed };
}

function display(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Common prefix/suffix trim of a paired old/new line → per-side changed
 *  char ranges (null where the range would be empty). */
function intraline(
  oldLine: string,
  newLine: string,
): { left: [number, number] | null; right: [number, number] | null } {
  let p = 0;
  const max = Math.min(oldLine.length, newLine.length);
  while (p < max && oldLine[p] === newLine[p]) {
    p += 1;
  }
  let s = 0;
  while (s < max - p && oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]) {
    s += 1;
  }
  const left: [number, number] = [p, oldLine.length - s];
  const right: [number, number] = [p, newLine.length - s];
  return {
    left: left[0] < left[1] ? left : null,
    right: right[0] < right[1] ? right : null,
  };
}

/**
 * Fold ops into aligned side-by-side rows. A delete block immediately followed
 * by an insert block is treated as a modification: its lines are paired
 * index-for-index (leftovers keep a null partner), and each pair carries
 * intra-line changed ranges.
 */
export function buildDiffRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    if (op.type === 'equal') {
      for (const line of op.lines) {
        rows.push({
          left: { num: oldNum, text: display(line), changed: false, hi: null },
          right: { num: newNum, text: display(line), changed: false, hi: null },
        });
        oldNum += 1;
        newNum += 1;
      }
      continue;
    }
    const dels = op.type === 'delete' ? op.lines : [];
    let inss = op.type === 'insert' ? op.lines : [];
    if (op.type === 'delete' && ops[i + 1]?.type === 'insert') {
      inss = ops[i + 1]!.lines;
      i += 1;
    }
    const span = Math.max(dels.length, inss.length);
    for (let j = 0; j < span; j += 1) {
      const oldLine = j < dels.length ? dels[j]! : null;
      const newLine = j < inss.length ? inss[j]! : null;
      const hi = oldLine !== null && newLine !== null ? intraline(oldLine, newLine) : null;
      rows.push({
        left:
          oldLine !== null
            ? { num: oldNum, text: display(oldLine), changed: true, hi: hi?.left ?? null }
            : null,
        right:
          newLine !== null
            ? { num: newNum, text: display(newLine), changed: true, hi: hi?.right ?? null }
            : null,
      });
      if (oldLine !== null) {
        oldNum += 1;
      }
      if (newLine !== null) {
        newNum += 1;
      }
    }
  }
  return rows;
}
