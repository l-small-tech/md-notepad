/**
 * The renderer's color contract.
 *
 * A `TerminalTheme` is the 16 ANSI colors plus the four "chrome" colors a
 * terminal needs (background, foreground, cursor, selection). The host loads
 * these from the active theme plugin — deriving them from its ten `branding`
 * keys when the theme has no `terminal` block (`src/core/terminal-palette.ts`)
 * — so nothing here reads CSS variables or the DOM: the renderer is handed a
 * resolved theme.
 *
 * The defaults below are the fallback palette; `src/core/terminal-palette.ts`
 * mirrors them as hex strings and a test holds the two in agreement.
 *
 * Colors are 0xRRGGBB numbers, the same representation `src/term` uses for
 * OSC 4/10/11/12, so no string parsing happens on the render path.
 */

/** The palette a terminal surface is painted with. */
export interface TerminalTheme {
  background: number;
  foreground: number;
  cursor: number;
  /** Glyph color under a block cursor; null = use the theme background. */
  cursorText: number | null;
  selection: number;
  /** Text color inside a selection; null = keep each cell's own foreground. */
  selectionText: number | null;
  /** The 16 ANSI colors: 0–7 standard, 8–15 bright. */
  ansi: readonly number[];
}

/** Default dark palette — the look the app ships with. */
export const DEFAULT_DARK_THEME: TerminalTheme = {
  background: 0x0b0f14,
  foreground: 0xe6ebf2,
  cursor: 0xe6ebf2,
  cursorText: null,
  selection: 0x264066,
  selectionText: null,
  ansi: [
    0x1c252e, 0xff6b5e, 0x9ece6a, 0xe0af68, 0x6ea1ff, 0xbb9af7, 0x7dcfff, 0xc0caf5, 0x414868,
    0xff8c80, 0xb9e07f, 0xf0c98a, 0x93bbff, 0xd0b8ff, 0xa5e2ff, 0xe6ebf2,
  ],
};

/**
 * Default light palette. The ANSI colors are darkened rather than reused:
 * bright terminal colors on a light background are the classic unreadable
 * combination, and every TUI assumes its palette contrasts with the surface.
 * So on this palette "bright" means darker, and colors 7/15 ("white",
 * "bright white") are inks, not paper — a TUI written for a dark terminal
 * writes its prose in them. Everything but black (which stays a background
 * color) clears WCAG AA against the surface; `core/terminal-palette.ts`
 * mirrors these values and derives themed palettes to the same rule.
 */
export const DEFAULT_LIGHT_THEME: TerminalTheme = {
  background: 0xfbfcfe,
  foreground: 0x1b2027,
  cursor: 0x1b2027,
  cursorText: null,
  selection: 0xbcd4f6,
  selectionText: null,
  ansi: [
    0x2e3440, 0xb02a1f, 0x3f7d20, 0x9a6b09, 0x1f5fc4, 0x7a3fa8, 0x0e6b78, 0x53575d, 0x5b6673,
    0x902219, 0x34671a, 0x7e5807, 0x194ea1, 0x64348a, 0x0b5862, 0x1b2027,
  ],
};

/** The palette used when a host mounts a view without naming a theme. */
export const DEFAULT_THEME = DEFAULT_DARK_THEME;

export type PartialTheme = Partial<Omit<TerminalTheme, 'ansi'>> & { ansi?: readonly number[] };

/**
 * Fill a partial theme out with the defaults. A short `ansi` array keeps the
 * default colors for the entries it does not provide, so a theme file that
 * only overrides a few colors is valid.
 */
export function resolveTheme(theme: PartialTheme = {}): TerminalTheme {
  const ansi = DEFAULT_THEME.ansi.map((color, i) => theme.ansi?.[i] ?? color);
  return { ...DEFAULT_THEME, ...theme, ansi };
}

/**
 * `#rrggbb` for a 0xRRGGBB value, memoized: a full repaint resolves the same
 * handful of colors thousands of times and canvas wants strings.
 */
const cssCache = new Map<number, string>();

export function cssColor(rgb: number): string {
  let css = cssCache.get(rgb);
  if (css === undefined) {
    css = `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
    cssCache.set(rgb, css);
  }
  return css;
}

/** `rgba()` string for a color at `alpha` (used for dim text and overlays). */
export function cssColorAlpha(rgb: number, alpha: number): string {
  return `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, ${alpha})`;
}

/** Linear blend of two 0xRRGGBB colors; `t` = 0 gives `a`, 1 gives `b`. */
export function blend(a: number, b: number, t: number): number {
  const mix = (shift: number) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + (to - from) * t) & 0xff;
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
