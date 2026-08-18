/**
 * Row → draw runs.
 *
 * Painting a canvas terminal cell by cell is what makes naive implementations
 * slow: one `fillRect` and one `fillText` per cell means ~2000 calls a frame
 * for an 80×24 screen. Instead each row is reduced to
 *
 *   - background spans: consecutive cells sharing a resolved background,
 *   - text runs: consecutive cells sharing every text-affecting attribute,
 *
 * so a typical line of shell output is a couple of calls rather than a
 * hundred. Runs are computed from cell state only — no canvas involved — so
 * the batching logic is unit-tested directly.
 */

import {
  BG_STRIKETHROUGH,
  BG_UNDERLINE_MASK,
  BG_UNDERLINE_SHIFT,
  FG_BLINK,
  FG_BOLD,
  FG_ITALIC,
  UnderlineStyle,
  type Row,
} from '../term';
import type { CellColors, ColorResolver } from './colors';

/** A run of cells painted with one `fillText`, or per glyph when `perCell`. */
export interface TextRun {
  col: number;
  /** Columns the run covers (wide cells count 2). */
  width: number;
  text: string;
  colors: CellColors;
  bold: boolean;
  italic: boolean;
  blink: boolean;
  underline: UnderlineStyle;
  strikethrough: boolean;
  /** OSC 8 link id, 0 when the run is not part of a hyperlink. */
  linkId: number;
  /**
   * Draw each cell's glyph at its own column. Set for wide characters and
   * anything outside the Latin range, whose advance in a fallback font is not
   * guaranteed to equal the cell width — batching those drifts visibly.
   */
  perCell: boolean;
}

/** A run of cells sharing one background color. */
export interface BackgroundRun {
  col: number;
  width: number;
  color: number;
}

export interface RowRuns {
  backgrounds: BackgroundRun[];
  texts: TextRun[];
}

export interface RunOptions {
  /** DECSCNM. */
  reverseVideo?: boolean;
  /** Half-open column range covered by the selection on this row. */
  selection?: { start: number; end: number } | null;
}

/**
 * Codepoints below this are guaranteed-monospace in every font we ship or
 * fall back to; above it (box drawing, powerline, CJK, emoji) advances vary,
 * so glyphs are placed per cell. A glyph atlas (deferred, plan §Phase 3) would
 * make the distinction moot.
 */
const BATCHABLE_MAX = 0x2000;

function isBatchable(text: string): boolean {
  if (text.length === 0) return true;
  if (text.length > 1) return false; // combining sequence / emoji ZWJ cluster
  return text.codePointAt(0)! < BATCHABLE_MAX;
}

/** Split one row into background spans and text runs. */
export function buildRowRuns(
  row: Row,
  cols: number,
  resolver: ColorResolver,
  options: RunOptions = {},
): RowRuns {
  const reverseVideo = options.reverseVideo ?? false;
  const selection = options.selection ?? null;
  const backgrounds: BackgroundRun[] = [];
  const texts: TextRun[] = [];

  let background: BackgroundRun | null = null;
  let run: TextRun | null = null;
  let previousFg = 0;
  let previousBg = 0;
  let previousSelected = false;

  for (let col = 0; col < cols; col++) {
    const cell = row.getCell(col);
    // The dead half of a wide character: its lead cell already claimed both
    // columns, and its color words were copied from the lead, so the spans
    // simply continue through it.
    if (cell.width === 0) {
      if (background) background.width++;
      continue;
    }

    const selected = selection !== null && col >= selection.start && col < selection.end;
    const colors = selected
      ? resolver.resolveSelected(cell, reverseVideo)
      : resolver.resolve(cell, reverseVideo);
    const span = Math.min(cell.width, cols - col);

    // ---- background span
    if (background && background.color === colors.bg) {
      background.width += span;
    } else {
      if (background) backgrounds.push(background);
      background = colors.bg === null ? null : { col, width: span, color: colors.bg };
    }

    // ---- text run
    const linkId = cell.extended?.linkId ?? 0;
    const batchable = cell.width === 1 && isBatchable(cell.text);
    const continues =
      run !== null &&
      batchable &&
      run.perCell === false &&
      cell.fg === previousFg &&
      cell.bg === previousBg &&
      selected === previousSelected &&
      run.linkId === linkId &&
      run.col + run.width === col;

    const underline = ((cell.bg & BG_UNDERLINE_MASK) >>> BG_UNDERLINE_SHIFT) as UnderlineStyle;
    const decorated =
      underline !== UnderlineStyle.None || (cell.bg & BG_STRIKETHROUGH) !== 0 || linkId !== 0;

    if ((cell.text === '' || colors.hidden) && !decorated) {
      // Nothing to draw: an empty cell breaks the run rather than padding it
      // with spaces that would cost a draw call for no pixels.
      if (run) texts.push(run);
      run = null;
    } else if (continues) {
      run!.text += colors.hidden ? '' : cell.text;
      run!.width += span;
    } else {
      if (run) texts.push(run);
      run = {
        col,
        width: span,
        text: colors.hidden ? '' : cell.text,
        colors,
        bold: (cell.fg & FG_BOLD) !== 0,
        italic: (cell.fg & FG_ITALIC) !== 0,
        blink: (cell.fg & FG_BLINK) !== 0,
        underline,
        strikethrough: (cell.bg & BG_STRIKETHROUGH) !== 0,
        linkId,
        perCell: !batchable,
      };
    }

    previousFg = cell.fg;
    previousBg = cell.bg;
    previousSelected = selected;
    if (span === 2) col++; // skip the spacer we already accounted for
  }

  if (background) backgrounds.push(background);
  if (run) texts.push(run);
  // A run of pure spaces still matters when it is underlined or struck
  // through; anything else with no glyphs is dropped here.
  return {
    backgrounds,
    texts: texts.filter(
      (text) =>
        text.text.trim() !== '' ||
        text.underline !== UnderlineStyle.None ||
        text.strikethrough ||
        text.linkId !== 0,
    ),
  };
}
