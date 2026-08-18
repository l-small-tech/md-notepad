/**
 * Packed cell attributes.
 *
 * A cell stores three 32-bit words (see row.ts): content, fg, bg. The fg/bg
 * words defined here pack color (16/256-palette or truecolor) plus the common
 * SGR flags. Rare attributes (underline color, hyperlink id) live in a
 * per-row side table keyed by an "extended" bit, keeping the hot path at
 * 12 bytes per cell.
 */

/** Color mode stored in bits 24–25 of a color word. */
export enum ColorMode {
  Default = 0,
  /** bits 0–7 are a 256-color palette index (the 16 ANSI colors are 0–15). */
  Palette = 1,
  /** bits 0–23 are RGB. */
  Rgb = 2,
}

export const COLOR_MASK = 0x00ffffff;
export const MODE_SHIFT = 24;
export const MODE_MASK = 0b11 << MODE_SHIFT;

// fg word flag bits.
export const FG_BOLD = 1 << 26;
export const FG_DIM = 1 << 27;
export const FG_ITALIC = 1 << 28;
export const FG_BLINK = 1 << 29;
export const FG_INVERSE = 1 << 30;
export const FG_INVISIBLE = -2147483648; // 1 << 31 kept in int32 range

// bg word flag bits.
export const BG_STRIKETHROUGH = 1 << 26;
export const BG_UNDERLINE_SHIFT = 27;
export const BG_UNDERLINE_MASK = 0b111 << BG_UNDERLINE_SHIFT;
/** Set when the cell has an entry in the row's extended-attribute table. */
export const BG_EXTENDED = 1 << 30;

export enum UnderlineStyle {
  None = 0,
  Single = 1,
  Double = 2,
  Curly = 3,
  Dotted = 4,
  Dashed = 5,
}

export function colorMode(word: number): ColorMode {
  return ((word & MODE_MASK) >>> MODE_SHIFT) as ColorMode;
}

export function colorValue(word: number): number {
  return word & COLOR_MASK;
}

export function paletteColor(index: number): number {
  return (index & 0xff) | (ColorMode.Palette << MODE_SHIFT);
}

export function rgbColor(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff) | (ColorMode.Rgb << MODE_SHIFT);
}

/** Underline color, packed the same way as fg/bg (mode+color only, no flags). */
export interface ExtendedAttrs {
  /** 0 (ColorMode.Default) means "follow the foreground". */
  underlineColor: number;
  /** 0 means no hyperlink; otherwise an id from the terminal's link registry. */
  linkId: number;
}

/**
 * The live SGR state — mutated by SGR sequences, snapshotted into each cell
 * as it is printed.
 */
export class AttributeState {
  fg = 0;
  bg = 0;
  underlineColor = 0;
  linkId = 0;

  reset(): void {
    this.fg = 0;
    this.bg = 0;
    this.underlineColor = 0;
  }

  /** True when the cell being printed needs a side-table entry. */
  get needsExtended(): boolean {
    return this.underlineColor !== 0 || this.linkId !== 0;
  }

  clone(): AttributeState {
    const copy = new AttributeState();
    copy.fg = this.fg;
    copy.bg = this.bg;
    copy.underlineColor = this.underlineColor;
    copy.linkId = this.linkId;
    return copy;
  }

  copyFrom(other: AttributeState): void {
    this.fg = other.fg;
    this.bg = other.bg;
    this.underlineColor = other.underlineColor;
    this.linkId = other.linkId;
  }
}
