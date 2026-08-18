/**
 * One grid row: packed cell storage.
 *
 * Layout is three Uint32 words per cell — [content, fg, bg]:
 *   content: bits 0–20 codepoint, bits 21–22 display width, bit 23 "has
 *            combining suffix" (full grapheme lives in `combining`), bit 24
 *            "wide spacer" (the dead cell to the right of a wide char).
 *   fg/bg:   see attributes.ts.
 *
 * Rare per-cell data (combining suffixes, underline color, hyperlink id)
 * lives in side maps so the common path stays 12 bytes per cell.
 */

import { AttributeState, BG_EXTENDED, type ExtendedAttrs } from './attributes';

export const CP_MASK = 0x1fffff;
export const WIDTH_SHIFT = 21;
export const WIDTH_MASK = 0b11 << WIDTH_SHIFT;
export const HAS_COMBINING = 1 << 23;
export const WIDE_SPACER = 1 << 24;

const WORDS = 3;

export interface Cell {
  /** The cell's text (grapheme), '' for an empty cell or a wide spacer. */
  text: string;
  /** 0 for a wide spacer, 1 or 2 otherwise (empty cells are width 1). */
  width: number;
  fg: number;
  bg: number;
  extended: ExtendedAttrs | null;
}

export class Row {
  data: Uint32Array;
  /** True when the previous row soft-wrapped onto this one (autowrap). */
  wrapped = false;
  private combining: Map<number, string> | null = null;
  private extended: Map<number, ExtendedAttrs> | null = null;

  constructor(public cols: number) {
    this.data = new Uint32Array(cols * WORDS);
  }

  /** Write a printable into `col`. `width` is 1 or 2 (spacers are set separately). */
  setCell(col: number, cp: number, width: 1 | 2, attrs: AttributeState): void {
    const i = col * WORDS;
    this.data[i] = (cp & CP_MASK) | (width << WIDTH_SHIFT);
    this.data[i + 1] = attrs.fg;
    this.combining?.delete(col);
    if (attrs.needsExtended) {
      this.data[i + 2] = attrs.bg | BG_EXTENDED;
      (this.extended ??= new Map()).set(col, {
        underlineColor: attrs.underlineColor,
        linkId: attrs.linkId,
      });
    } else {
      this.data[i + 2] = attrs.bg;
      this.extended?.delete(col);
    }
  }

  /** Mark `col` as the dead right half of a wide character. */
  setWideSpacer(col: number, attrs: AttributeState): void {
    const i = col * WORDS;
    this.data[i] = WIDE_SPACER;
    this.data[i + 1] = attrs.fg;
    this.data[i + 2] = attrs.bg & ~BG_EXTENDED;
    this.combining?.delete(col);
    this.extended?.delete(col);
  }

  /** Append a combining mark / ZWJ-sequence continuation to the cell's grapheme. */
  appendCombining(col: number, suffix: string): void {
    const i = col * WORDS;
    this.data[i]! |= HAS_COMBINING;
    const map = (this.combining ??= new Map());
    map.set(col, (map.get(col) ?? '') + suffix);
  }

  /** Erase to "blank with current background" (BCE), fg/flags cleared. */
  eraseCell(col: number, attrs: AttributeState): void {
    const i = col * WORDS;
    this.data[i] = 0;
    this.data[i + 1] = 0;
    this.data[i + 2] = attrs.bg & ~BG_EXTENDED;
    this.combining?.delete(col);
    this.extended?.delete(col);
  }

  eraseRange(start: number, end: number, attrs: AttributeState): void {
    for (let col = start; col < end; col++) this.eraseCell(col, attrs);
  }

  getCell(col: number): Cell {
    const i = col * WORDS;
    const content = this.data[i]!;
    const cp = content & CP_MASK;
    const width = content & WIDE_SPACER ? 0 : (content & WIDTH_MASK) >>> WIDTH_SHIFT || 1;
    let text = '';
    if (width > 0 && cp !== 0) {
      text = String.fromCodePoint(cp);
      if (content & HAS_COMBINING) text += this.combining?.get(col) ?? '';
    }
    return {
      text,
      width,
      fg: this.data[i + 1]!,
      bg: this.data[i + 2]!,
      extended: content !== 0 ? (this.extended?.get(col) ?? null) : null,
    };
  }

  /** Codepoint at `col` (0 for empty/spacer) — cheap probe used by the screen model. */
  codepointAt(col: number): number {
    const content = this.data[col * WORDS]!;
    return content & WIDE_SPACER ? 0 : content & CP_MASK;
  }

  isWideSpacer(col: number): boolean {
    return (this.data[col * WORDS]! & WIDE_SPACER) !== 0;
  }

  isWideStart(col: number): boolean {
    return (this.data[col * WORDS]! & WIDTH_MASK) >>> WIDTH_SHIFT === 2;
  }

  /**
   * Shift cells right by `count` starting at `col` (ICH); vacated cells are
   * erased with `attrs`, cells pushed past the end are dropped.
   */
  insertCells(col: number, count: number, attrs: AttributeState): void {
    const cols = this.cols;
    count = Math.min(count, cols - col);
    this.data.copyWithin((col + count) * WORDS, col * WORDS, (cols - count) * WORDS);
    this.moveSideMaps(col, col, count);
    this.eraseRange(col, col + count, attrs);
  }

  /** Shift cells left by `count` starting at `col` (DCH); tail erased with `attrs`. */
  deleteCells(col: number, count: number, attrs: AttributeState): void {
    const cols = this.cols;
    count = Math.min(count, cols - col);
    this.data.copyWithin(col * WORDS, (col + count) * WORDS, cols * WORDS);
    this.moveSideMaps(col, col + count, -count);
    this.eraseRange(cols - count, cols, attrs);
  }

  /**
   * Re-key the combining/extended side maps after a horizontal shift: entries
   * at or beyond `regionStart` are dropped unless they were at or beyond
   * `srcStart`, in which case they move by `delta` (dropped if pushed out).
   */
  private moveSideMaps(regionStart: number, srcStart: number, delta: number): void {
    for (const map of [this.combining, this.extended] as const) {
      if (!map?.size) continue;
      const moved: [number, string | ExtendedAttrs][] = [];
      for (const [col, value] of map) {
        if (col < regionStart) continue;
        map.delete(col);
        const target = col + delta;
        if (col >= srcStart && target >= 0 && target < this.cols) moved.push([target, value]);
      }
      for (const [col, value] of moved) map.set(col, value as string & ExtendedAttrs);
    }
  }

  /** Grow or shrink to `cols`; new cells are blank with default attributes. */
  resize(cols: number): void {
    if (cols === this.cols) return;
    const data = new Uint32Array(cols * WORDS);
    data.set(this.data.subarray(0, Math.min(cols, this.cols) * WORDS));
    this.data = data;
    if (cols < this.cols) {
      for (const map of [this.combining, this.extended] as const) {
        if (!map) continue;
        for (const col of map.keys()) if (col >= cols) map.delete(col);
      }
      // A wide char cut in half at the new edge leaves a dangling spacer-less
      // lead cell; blank it rather than render half a glyph.
      if (cols > 0 && this.isWideStart(cols - 1)) {
        this.data[(cols - 1) * WORDS] = 0;
        this.combining?.delete(cols - 1);
        this.extended?.delete(cols - 1);
      }
    }
    this.cols = cols;
  }

  /** The row's text with trailing blanks trimmed (spacers contribute nothing). */
  text(): string {
    let out = '';
    let pendingBlanks = '';
    for (let col = 0; col < this.cols; col++) {
      const cell = this.getCell(col);
      if (cell.width === 0) continue; // wide spacer
      if (cell.text === '') {
        pendingBlanks += ' ';
      } else {
        out += pendingBlanks + cell.text;
        pendingBlanks = '';
      }
    }
    return out;
  }

  clone(): Row {
    const copy = new Row(this.cols);
    copy.data.set(this.data);
    copy.wrapped = this.wrapped;
    if (this.combining?.size) copy.combining = new Map(this.combining);
    if (this.extended?.size) {
      copy.extended = new Map();
      for (const [col, ext] of this.extended) copy.extended.set(col, { ...ext });
    }
    return copy;
  }
}
