/**
 * A theme plugin's `branding` → a terminal palette.
 *
 * The terminal needs 16 ANSI colors plus background/foreground/cursor/
 * selection. A theme file declares ten semantic keys and a mode. Rather than
 * ask every theme author for twenty more colors, this module DERIVES the
 * palette — the mapping is the obvious one where a semantic key *is* the
 * terminal color (`accent` is blue, `danger` is red, `fgMuted` is
 * brightBlack), with the built-in hues supplying the four the semantic keys
 * have no opinion about (green, yellow, magenta, cyan).
 *
 * Every derived color is then held to a measured contrast floor against the
 * surface, because a theme's `accent` was chosen to sit on chrome, not on the
 * terminal background. That floor is what makes derived palettes readable
 * instead of merely plausible.
 *
 * A theme that wants exact control declares an optional `terminal` block; it
 * is merged OVER the derived palette, so a block that sets only `cursor` is
 * valid and sets the cursor.
 *
 * Pure logic: no DOM, no Tauri, and deliberately no import from
 * `src/renderer` (the layer rules forbid it) — everything here is hex
 * strings, and `src/ui/terminal-theme.ts` converts them to the numbers the
 * renderer takes.
 */

import { adjust, ensureContrast, formatColor, mix, parseColor } from './color';
import type { Branding, PaletteKey, ThemeMode, ThemePlugin } from './theme-plugins';

/** The 16 ANSI color names a `terminal` block may set, in index order. */
export const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type AnsiName = (typeof ANSI_NAMES)[number];

/** A terminal palette as hex strings — the file-format side of the renderer's. */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  /** Glyph color under a block cursor; null = the theme background. */
  cursorText: string | null;
  selection: string;
  /** Text color inside a selection; null = keep each cell's own foreground. */
  selectionText: string | null;
  /** 16 entries: 0–7 standard, 8–15 bright. */
  ansi: string[];
}

/** What a theme file may declare under `terminal`. Every field is optional. */
export type TerminalPalette = Partial<Record<AnsiName, string>> & {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string | null;
  selection?: string;
  selectionText?: string | null;
};

/**
 * base.css's ten light/dark palette values, mirrored here so derivation works
 * with NO plugin selected without reading the DOM. `terminal-palette.test.ts`
 * asserts these still match base.css — update both together.
 */
export const BASE_PALETTE_LIGHT: Record<PaletteKey, string> = {
  bg: '#eaf1e4',
  editorBg: '#fbfdf8',
  bgAlt: '#e0ebd8',
  bgHover: '#d3e3c9',
  fg: '#17241b',
  fgMuted: '#586a5b',
  accent: '#00703c',
  border: '#d2e0c9',
  danger: '#c62828',
  selection: '#cfe6a9',
};

export const BASE_PALETTE_DARK: Record<PaletteKey, string> = {
  bg: '#111c15',
  editorBg: '#0c150f',
  bgAlt: '#18261c',
  bgHover: '#223529',
  fg: '#eef4ef',
  fgMuted: '#7d9585',
  accent: '#56c07a',
  border: '#223529',
  danger: '#e5766a',
  selection: '#21503a',
};

/**
 * The built-in ANSI palettes — the same colors `src/renderer/theme.ts` ships
 * as `DEFAULT_DARK_THEME` / `DEFAULT_LIGHT_THEME`, in file-format form. They
 * are the hue source derivation starts from.
 */
export const DEFAULT_ANSI_DARK: readonly string[] = [
  '#1c252e',
  '#ff6b5e',
  '#9ece6a',
  '#e0af68',
  '#6ea1ff',
  '#bb9af7',
  '#7dcfff',
  '#c0caf5',
  '#414868',
  '#ff8c80',
  '#b9e07f',
  '#f0c98a',
  '#93bbff',
  '#d0b8ff',
  '#a5e2ff',
  '#e6ebf2',
];

/**
 * The light palette. On a light surface "bright" means DARKER, not lighter:
 * a TUI written for a dark terminal paints its emphasis in bright colors, and
 * a bright color on white is the classic unreadable combination. Every entry
 * except black (a background color) clears 4.5:1 against a white surface, and
 * `white` is deliberately a mid ink rather than a pale gray — applications use
 * color 7 as their *text* color far more often than as a background.
 */
export const DEFAULT_ANSI_LIGHT: readonly string[] = [
  '#2e3440',
  '#b02a1f',
  '#3f7d20',
  '#9a6b09',
  '#1f5fc4',
  '#7a3fa8',
  '#0e6b78',
  '#53575d',
  '#5b6673',
  '#902219',
  '#34671a',
  '#7e5807',
  '#194ea1',
  '#64348a',
  '#0b5862',
  '#1b2027',
];

/**
 * Contrast floor a *derived* ANSI color must clear against the background.
 *
 * Light surfaces get the AA body-text ratio rather than the 3:1 large-text
 * one, because that is what these colors are on a light terminal: a TUI that
 * assumes a dark background paints its ordinary prose in ANSI colors, and 3:1
 * — legible for a heading — is not legible for a wall of 12px monospace. On a
 * dark surface the same nominal ratio reads considerably heavier (light text
 * blooms against dark), so the dark floor stays where it was and dark themes
 * are untouched by this.
 */
const MIN_CONTRAST = { light: 4.5, dark: 3 } as const;
/**
 * …and the lower floor for brightBlack, which is a dim color on purpose:
 * enough to read as secondary text, never enough to be mistaken for prose.
 */
const MIN_CONTRAST_DIM = { light: 3, dark: 2 } as const;

/**
 * Derive a terminal palette from a theme's branding.
 *
 * ANSI black is exempt from the contrast floor: applications use it as a
 * *background*, and forcing it to contrast with the surface would defeat the
 * point.
 *
 * On a light theme that exemption is also the one thing this cannot have both
 * ways. Colors 7/15 are inverted to dark inks so that a dark-assuming TUI's
 * text stays readable on our light surface — which is the overwhelmingly
 * common case, and the same choice GitHub's light terminal theme makes — but
 * it means the rarer "white text on an ANSI-black fill" comes out dark-on-dark.
 * The alternative (a light "white", the Solarized Light ordering) trades a
 * rare bug for a constant one: unreadable body text. Text wins.
 */
export function deriveTerminalColors(branding: Branding, mode: ThemeMode): TerminalColors {
  const dark = mode === 'dark';
  const defaults = dark ? BASE_PALETTE_DARK : BASE_PALETTE_LIGHT;
  const base = (dark ? DEFAULT_ANSI_DARK : DEFAULT_ANSI_LIGHT).map(
    (hex) => parseColor(hex) ?? 0x000000,
  );
  // A theme may omit any key (and may use a color syntax `parseColor` cannot
  // read, like `color-mix()`), so both misses fall back to base.css's value.
  const get = (key: PaletteKey): number =>
    parseColor(branding[key] ?? '') ?? parseColor(defaults[key])!;

  const background = get('editorBg');
  const foreground = get('fg');
  const muted = get('fgMuted');
  const accent = get('accent');
  const danger = get('danger');
  /** How much a "bright" variant moves: lighter on dark themes, darker on light. */
  const brighten = dark ? 0.2 : -0.18;

  const ansi = base.slice();
  ansi[0] = dark ? mix(background, foreground, 0.25) : mix(foreground, background, 0.1);
  ansi[1] = danger;
  ansi[4] = accent;
  // White is the ink, softened a quarter of the way toward the paper — in BOTH
  // modes, because "color 7" means the same thing in both: the default text
  // color, one step down from brightWhite. Deriving it from `border` (as this
  // did) made it a pale line color on light themes: it landed below the
  // contrast floor every time, got blackened into mud by it, and still came
  // out LIGHTER than brightBlack — so a TUI's ordinary text (7) was harder to
  // read than its dim text (8), which is exactly backwards.
  ansi[7] = mix(foreground, background, 0.25);
  ansi[8] = muted;
  ansi[9] = adjust(danger, brighten);
  ansi[12] = adjust(accent, brighten);
  ansi[15] = foreground;
  for (const index of [2, 3, 5, 6]) {
    ansi[index + 8] = adjust(ansi[index]!, brighten);
  }

  const key = dark ? 'dark' : 'light';
  const floored = ansi.map((rgb, index) => {
    if (index === 0) {
      return rgb;
    }
    return ensureContrast(rgb, background, (index === 8 ? MIN_CONTRAST_DIM : MIN_CONTRAST)[key]);
  });

  return {
    background: formatColor(background),
    foreground: formatColor(foreground),
    cursor: formatColor(get('accent')),
    cursorText: null,
    selection: formatColor(get('selection')),
    selectionText: null,
    ansi: floored.map(formatColor),
  };
}

/**
 * Environment a pty is spawned with so a TUI can tell light from dark BEFORE
 * it paints anything.
 *
 * `COLORFGBG` is the rxvt convention every "is this terminal light?" helper
 * has read for thirty years (Vim's `background` detection, chalk, termenv,
 * Rich): two palette *indices*, `fg;bg`. `0;15` is black-on-white → a light
 * surface; `15;0` is white-on-black → a dark one. It is a static hint, so it
 * is only ever a starting guess — an application that also queries OSC 11 or
 * DSR 996 gets the live answer from `src/term/screen.ts` — but it is the ONLY
 * signal available to a TUI that decides its theme before its first draw, and
 * to one that never queries at all.
 *
 * `GROK_APPEARANCE` is the one vendor-specific hint worth setting: the Grok
 * CLI (one of the harnesses) resolves its light/dark look
 * from the *OS* appearance first and only then falls back to OSC 11, so on a
 * dark desktop it would paint a dark TUI onto our light console no matter what
 * the terminal answers. The variable is its documented per-invocation override,
 * it is read by nothing else, and it costs one entry in the environment. Its
 * `LC_GROK_APPEARANCE` twin is deliberately NOT set — that one exists to ride
 * along an SSH connection, and this app's theme has no business following the
 * user onto a remote host.
 *
 * TypeScript decides this rather than `pty.rs`, because the theme is a
 * frontend concept; Rust keeps owning `TERM`/`COLORTERM`, which describe the
 * emulator and never change. Spread a profile's own `env` AFTER this so a
 * user who sets either variable themselves still wins.
 */
export function terminalEnvHints(dark: boolean): Record<string, string> {
  return {
    COLORFGBG: dark ? '15;0' : '0;15',
    GROK_APPEARANCE: dark ? 'dark' : 'light',
  };
}

/** A declared color wins only when it actually parses; else the derived one. */
function pick(value: string | undefined, derived: string): string {
  return value !== undefined && parseColor(value) !== null ? value : derived;
}

function pickOptional(value: string | null | undefined, derived: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value !== undefined && parseColor(value) !== null ? value : derived;
}

/**
 * The palette to paint with for one theme. `plugin` is the active theme
 * plugin, or null for the built-in look (base.css's palette), in which case
 * `dark` selects the mode. Any explicit `terminal` block merges over the
 * derived palette, key by key.
 */
export function terminalColorsFor(plugin: ThemePlugin | null, dark: boolean): TerminalColors {
  const mode: ThemeMode = plugin ? plugin.mode : dark ? 'dark' : 'light';
  const derived = deriveTerminalColors(plugin?.branding ?? {}, mode);
  const raw = plugin?.terminal;
  if (!raw) {
    return derived;
  }
  return {
    background: pick(raw.background, derived.background),
    foreground: pick(raw.foreground, derived.foreground),
    cursor: pick(raw.cursor, derived.cursor),
    cursorText: pickOptional(raw.cursorText, derived.cursorText),
    selection: pick(raw.selection, derived.selection),
    selectionText: pickOptional(raw.selectionText, derived.selectionText),
    ansi: ANSI_NAMES.map((name, index) => pick(raw[name], derived.ansi[index]!)),
  };
}
