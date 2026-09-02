/**
 * Cell attributes → the colors actually painted.
 *
 * This is where the transparency rule lives: a cell whose background is the
 * *default* resolves to `null`, and the renderer leaves that area of the
 * canvas untouched so the pane's own CSS background (`--editor-bg`) shows
 * through. Any explicitly colored background paints opaquely.
 *
 * Pure functions over numbers: no canvas, no DOM, fully unit-tested.
 */

import {
  ColorMode,
  DEFAULT_PALETTE,
  FG_BOLD,
  FG_DIM,
  FG_INVERSE,
  FG_INVISIBLE,
  colorMode,
  colorValue,
  type Cell,
} from '../term';
import { blend, type TerminalTheme } from './theme';

/** The default fg/bg/cursor colors, which OSC 10/11/12 can move at runtime. */
export interface DefaultColors {
  foreground: number;
  background: number;
  cursor: number;
}

export interface ColorOptions {
  /**
   * SGR bold promotes palette colors 0–7 to their bright twin (xterm default).
   * Safe on light palettes because "bright" there means *darker* — see
   * `core/terminal-palette.ts`.
   */
  boldIsBright?: boolean;
  /**
   * How far SGR dim pulls text toward the background (0–1). Toward the
   * BACKGROUND, not toward black: on a light theme "less bright" would mean
   * more contrast, which turns an application's faintest text into its
   * loudest.
   */
  dimAmount?: number;
}

export interface CellColors {
  fg: number;
  /** `null` means "default background": paint nothing, stay translucent. */
  bg: number | null;
  /** Underline/strikethrough color (SGR 58 falls back to the foreground). */
  underline: number;
  /** SGR 8 (invisible): the glyph is not drawn, the background still is. */
  hidden: boolean;
}

const DIM_AMOUNT = 0.4;

/**
 * Resolves packed color words against a theme, the live OSC defaults and any
 * OSC 4 palette overrides. Held by the renderer for the lifetime of a theme;
 * `palette` is memoized because a repaint resolves the same indices constantly.
 */
export class ColorResolver {
  private palette: (number | null)[] = new Array<number | null>(256).fill(null);

  constructor(
    private theme: TerminalTheme,
    private defaults: DefaultColors,
    /** OSC 4 override for a palette index, or null when the theme's color stands. */
    private override: (index: number) => number | null = () => null,
    private options: ColorOptions = {},
  ) {}

  setTheme(theme: TerminalTheme): void {
    this.theme = theme;
    this.invalidate();
  }

  setDefaults(defaults: DefaultColors): void {
    this.defaults = defaults;
  }

  /** Drop the memoized palette — call when OSC 4 changed a color. */
  invalidate(): void {
    this.palette.fill(null);
  }

  get currentTheme(): TerminalTheme {
    return this.theme;
  }

  get currentDefaults(): DefaultColors {
    return this.defaults;
  }

  /** RGB for a 256-color index: OSC 4 override, then theme, then xterm default. */
  paletteColor(index: number): number {
    const cached = this.palette[index];
    if (cached !== null && cached !== undefined) return cached;
    const color =
      this.override(index) ??
      (index < 16 ? this.theme.ansi[index] : undefined) ??
      DEFAULT_PALETTE[index] ??
      this.defaults.foreground;
    this.palette[index] = color;
    return color;
  }

  private colorOf(word: number, fallback: number, bright: boolean): number {
    switch (colorMode(word)) {
      case ColorMode.Palette: {
        let index = colorValue(word) & 0xff;
        if (bright && index < 8) index += 8;
        return this.paletteColor(index);
      }
      case ColorMode.Rgb:
        return colorValue(word);
      default:
        return fallback;
    }
  }

  /**
   * Resolve one cell. `reverseVideo` is DECSCNM, which inverts the whole
   * screen on top of each cell's own SGR 7.
   */
  resolve(cell: Cell, reverseVideo = false): CellColors {
    const { fg: fgWord, bg: bgWord } = cell;
    const bold = (fgWord & FG_BOLD) !== 0;
    const bright = bold && (this.options.boldIsBright ?? true);

    let fg = this.colorOf(fgWord, this.defaults.foreground, bright);
    const bgIsDefault = colorMode(bgWord) === ColorMode.Default;
    let bg: number | null = bgIsDefault
      ? null
      : this.colorOf(bgWord, this.defaults.background, false);

    if (((fgWord & FG_INVERSE) !== 0) !== reverseVideo) {
      const swappedFg = bg ?? this.defaults.background;
      bg = fg;
      fg = swappedFg;
    }

    if ((fgWord & FG_DIM) !== 0) {
      fg = blend(fg, bg ?? this.defaults.background, this.options.dimAmount ?? DIM_AMOUNT);
    }

    const underlineWord = cell.extended?.underlineColor ?? 0;
    const underline =
      colorMode(underlineWord) === ColorMode.Default ? fg : this.colorOf(underlineWord, fg, false);

    return { fg, bg, underline, hidden: (fgWord & FG_INVISIBLE) !== 0 };
  }

  /** Colors for a selected cell: the theme's selection background wins. */
  resolveSelected(cell: Cell, reverseVideo = false): CellColors {
    const base = this.resolve(cell, reverseVideo);
    return {
      ...base,
      fg: this.theme.selectionText ?? base.fg,
      bg: this.theme.selection,
    };
  }
}
