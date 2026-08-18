/**
 * The selection model.
 *
 * Selection lives in *absolute buffer lines* — the same numbering OSC 133
 * marks use — not viewport rows, so a selection stays anchored to its text
 * while output scrolls past. (Lines evicted from scrollback take their part of
 * a selection with them; the renderer simply finds no row for them.)
 *
 * Pure geometry and text extraction: the renderer paints what this describes
 * and Phase 4's mouse handling produces the points that feed it.
 */

export interface Point {
  /** Absolute buffer line (0 = the first line ever written). */
  line: number;
  col: number;
}

export interface Selection {
  /** Where the drag started. */
  anchor: Point;
  /** Where the pointer is now — may be before the anchor. */
  head: Point;
}

export interface Range {
  start: Point;
  end: Point;
}

function before(a: Point, b: Point): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** Order a selection's endpoints; `end` is exclusive at the column level. */
export function normalize(selection: Selection): Range {
  return before(selection.head, selection.anchor)
    ? { start: selection.head, end: selection.anchor }
    : { start: selection.anchor, end: selection.head };
}

export function isEmpty(selection: Selection): boolean {
  return (
    selection.anchor.line === selection.head.line && selection.anchor.col === selection.head.col
  );
}

/**
 * The half-open column range selected on `line`, or null when the line is
 * outside the selection. `cols` bounds full lines in the middle of a
 * multi-line selection.
 */
export function rangeForLine(
  selection: Selection,
  line: number,
  cols: number,
): { start: number; end: number } | null {
  const { start, end } = normalize(selection);
  if (line < start.line || line > end.line) return null;
  const from = line === start.line ? start.col : 0;
  const to = line === end.line ? end.col : cols;
  return to > from ? { start: from, end: to } : null;
}

/** Characters that bound a word for double-click selection. */
const WORD_SEPARATORS = new Set([...' \t ()[]{}<>\'"`,;:!?*|&^%$#@=+\\']);

/**
 * Word bounds around `col` in `text`. A click on whitespace selects the run of
 * whitespace, which is what every terminal does and what keeps double-click
 * drag-extension sane.
 */
export function expandToWord(text: string, col: number): { start: number; end: number } {
  const chars = [...text];
  if (col < 0 || col >= chars.length) return { start: col, end: col + 1 };
  const isSeparator = (index: number) => WORD_SEPARATORS.has(chars[index]!);
  const separator = isSeparator(col);
  let start = col;
  let end = col + 1;
  while (start > 0 && isSeparator(start - 1) === separator) start--;
  while (end < chars.length && isSeparator(end) === separator) end++;
  return { start, end };
}

/** How the extractor reads the buffer — implemented over `Terminal` by the host. */
export interface LineSource {
  /** Text of an absolute line, or null when it is no longer retained. */
  lineText(line: number): string | null;
  /** True when `line` soft-wrapped into the next one (no newline was typed). */
  isWrapped(line: number): boolean;
  cols: number;
}

/**
 * The selected text. Soft-wrapped lines are joined without a newline — pasting
 * a wrapped command back into a shell must reproduce the original command, not
 * a broken two-line version — and trailing blanks on hard lines are trimmed.
 */
export function selectionText(selection: Selection, source: LineSource): string {
  const { start, end } = normalize(selection);
  let out = '';
  for (let line = start.line; line <= end.line; line++) {
    const text = source.lineText(line);
    if (text === null) continue;
    const from = line === start.line ? start.col : 0;
    const to = line === end.line ? end.col : source.cols;
    const chars = [...text];
    let piece = chars.slice(from, to).join('');
    if (line !== end.line) {
      // A row's text is already right-trimmed; only a wrap continues the line.
      if (!source.isWrapped(line)) {
        piece = piece.replace(/\s+$/, '');
        piece += '\n';
      }
    }
    out += piece;
  }
  return out;
}
