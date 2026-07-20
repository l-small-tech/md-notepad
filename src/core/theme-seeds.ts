/**
 * Built-in theme plugins, seeded into the themes folder so they double as
 * editable, AI-friendly examples. The palettes are the authors' published hex
 * values, lightly adapted only where the app needs a variable the original
 * doesn't name (e.g. a recessed --editor-bg or a --selection tint). 'default'
 * is NOT here: it is the base.css palette and needs no plugin.
 *
 * Every built-in is MODE-LOCKED: it presents ONE character — light or dark —
 * no matter the OS light/dark setting, because that character *is* the point:
 * you pick the mood, not the machine. Adaptive schemes were split into
 * explicit variants (Solarized Light / Solarized Dark, …) so the picker can
 * group all themes by Light / Dark. The lock is achieved by giving `light` and
 * `dark` the SAME palette (see `locked`): the renderer's dark block (higher
 * specificity) then also overrides base.css's own dark defaults, so the look
 * holds in either OS mode.
 *
 * Each seeded file is stamped with SEED_VERSION. The loader (ipc/theme-loader.ts)
 * writes a built-in when absent AND refreshes a copy whose stamped version is
 * older than SEED_VERSION — so a definition change here (a fixed color, an added
 * syntax block) reaches devices that seeded an earlier build, instead of the old
 * write-once behavior that left stale files forever. Bump SEED_VERSION whenever
 * any definition below changes.
 */

import type { Palette, SyntaxPalette, ThemePlugin } from './theme-plugins';

/** Bump when any built-in definition below changes (see module comment). */
export const SEED_VERSION = 3;

/**
 * Built-ins we used to seed but no longer ship. Gruvbox/Everforest/Rosé Pine
 * were dropped for looking too much alike; `solarized` and `nord` were replaced
 * by their mode-locked Light/Dark variants. The loader DELETES a themes-folder
 * copy of these ids, but only when the file still carries our seed `version`
 * stamp — a stamp-less file is user-authored (or user-adopted) and is left
 * alone.
 */
export const RETIRED_THEME_IDS: readonly string[] = [
  'gruvbox',
  'everforest',
  'rose-pine',
  'solarized',
  'nord',
];

/** A mode-locked theme: `dark` mirrors `light` (see module comment). */
function locked(id: string, name: string, palette: Palette, syntax?: SyntaxPalette): ThemePlugin {
  return {
    id,
    name,
    light: palette,
    dark: palette,
    ...(syntax ? { syntax: { light: syntax, dark: syntax } } : {}),
  };
}

const BUILT_IN_THEME_DEFS: ThemePlugin[] = [
  // Two originals drawn straight from the University of the Fraser Valley's live
  // web palette (ufv.ca): PANTONE 349 forest green #00703c ("growth and
  // transformation"), the fresh leaf-green #7cb232 it pairs with, pale-lime
  // highlights (#daebbd/#cfe6a9), warm-orange #e45300, and charcoal — never pure
  // black — over open, airy neutrals.
  //   • "Light Green" is a bright, high-contrast light theme for glare, daylight,
  //     and meetings — near-white green-tinted paper, forest-green ink.
  //   • "Dark Green" is a low-light dark theme that's easy on the eyes for long
  //     or late sessions — deep emerald-forest with a soft (non-white) fg.
  locked(
    'light-green',
    'Light Green',
    {
      bg: '#eaf1e4', // app chrome: pale green-grey
      editorBg: '#fbfdf8', // writing surface: near-white, faint green warmth, bright for glare
      bgAlt: '#e0ebd8', // raised panels / cards
      bgHover: '#d3e3c9',
      fg: '#000000', // black ink — maximum contrast for daylight readability
      fgMuted: '#586a5b',
      accent: '#00703c', // UFV PANTONE 349 forest green
      border: '#d2e0c9',
      danger: '#c62828', // readable alert red (near UFV #ce2127)
      selection: '#cfe6a9', // UFV pale-lime highlight
    },
    // Headings walk UFV's forest-green → fresh-leaf-green range for hierarchy.
    {
      heading1: '#005c31', // deepest forest
      heading2: '#00703c', // UFV primary
      heading3: '#2f7d43',
      heading4: '#47913c',
      heading5: '#619f36',
      heading6: '#7cb232', // UFV fresh leaf-green
      bold: '#17241b', // strong green-charcoal
      italic: '#5f7a63',
      strikethrough: '#8a978c',
      link: '#00703c',
      code: '#b5451f', // burnt orange (UFV #e45300, darkened for a light bg)
      quote: '#4e7358',
      list: '#4f9e3c',
    },
  ),
  // "Paper": warm sepia stationery — cream paper, brown-black ink, a leather-
  // brown accent. The calm reading-room counterpart to Light Green's daylight
  // brightness.
  locked(
    'paper',
    'Paper',
    {
      bg: '#efe6d5', // aged-paper chrome
      editorBg: '#faf5e9', // cream writing sheet
      bgAlt: '#e7dcc6',
      bgHover: '#ddcfb3',
      fg: '#3b3226', // warm brown-black ink
      fgMuted: '#84765f',
      accent: '#8c5a2b', // leather brown
      border: '#ddd1b8',
      danger: '#b3402e', // sealing-wax red
      selection: '#e9d9a9', // soft parchment highlight
    },
    {
      heading: '#7a4a21', // darker leather for all heading levels
      bold: '#2c2418',
      italic: '#6b5d45',
      strikethrough: '#a3967e',
      link: '#3d6b6b', // muted ink-teal, distinct from the browns
      code: '#9a4a1f',
      quote: '#84765f',
      list: '#8c5a2b',
    },
  ),
  // Solarized (Ethan Schoonover): the canonical beige/slate pair, split into
  // its two published halves.
  locked('solarized-light', 'Solarized Light', {
    bg: '#fdf6e3',
    editorBg: '#f7f1de',
    bgAlt: '#eee8d5',
    bgHover: '#e4dcc4',
    fg: '#586e75',
    fgMuted: '#93a1a1',
    accent: '#268bd2',
    border: '#e5ddc8',
    danger: '#dc322f',
    selection: '#cfe0ef',
  }),
  locked('solarized-dark', 'Solarized Dark', {
    bg: '#002b36',
    editorBg: '#00252e',
    bgAlt: '#073642',
    bgHover: '#0a4451',
    fg: '#93a1a1',
    fgMuted: '#657b83',
    accent: '#268bd2',
    border: '#0f4b58',
    danger: '#dc322f',
    selection: '#124651',
  }),
  // Nord: frosty blue-greys, split into its Snow Storm (light) and Polar Night
  // (dark) halves.
  locked('nord-light', 'Nord Light', {
    bg: '#eceff4',
    editorBg: '#e9edf3',
    bgAlt: '#e5e9f0',
    bgHover: '#dbe1ea',
    fg: '#2e3440',
    fgMuted: '#5b6577',
    accent: '#5e81ac',
    border: '#d8dee9',
    danger: '#bf616a',
    selection: '#d2dbe8',
  }),
  locked('nord-dark', 'Nord Dark', {
    bg: '#2e3440',
    editorBg: '#2b303b',
    bgAlt: '#3b4252',
    bgHover: '#434c5e',
    fg: '#d8dee9',
    fgMuted: '#8a93a5',
    accent: '#88c0d0',
    border: '#3b4252',
    danger: '#bf616a',
    selection: '#434c5e',
  }),
  locked(
    'dark-green',
    'Dark Green',
    {
      bg: '#111c15', // deep-forest chrome
      editorBg: '#0c150f', // deepest writing surface
      bgAlt: '#18261c', // raised panels
      bgHover: '#223529',
      fg: '#ffffff', // white text on the deep-forest bg
      fgMuted: '#7d9585',
      accent: '#56c07a', // lifted emerald: on-brand green that reads on dark without glowing
      border: '#223529',
      danger: '#e5766a', // soft coral-red for dark
      selection: '#21503a', // forest highlight
    },
    // Lifted greens on the deep bg; a warm-sand code color for contrast.
    {
      heading1: '#7fd39b', // brightest mint at the top level
      heading2: '#6ac98a',
      heading3: '#56c07a', // accent emerald
      heading4: '#6fbf6e',
      heading5: '#8ccb5f',
      heading6: '#a6d96a', // fresh leaf-green, lifted
      bold: '#e2efe3', // brighter than fg for clean emphasis
      italic: '#93ab97',
      strikethrough: '#6f8677',
      link: '#4ec9a0', // teal-green, distinct from the heading greens
      code: '#e0a878', // warm sand — pops against the greens
      quote: '#8aa891',
      list: '#8ecb62',
    },
  ),
  // Dracula (draculatheme.com): vivid purple-and-pink on cool navy — canonically
  // a dark theme, shipped as one.
  locked(
    'dracula',
    'Dracula',
    {
      bg: '#282a36',
      editorBg: '#21222c',
      bgAlt: '#343746',
      bgHover: '#44475a',
      fg: '#f8f8f2',
      fgMuted: '#8b91b0',
      accent: '#bd93f9',
      border: '#343746',
      danger: '#ff5555',
      selection: '#44475a',
    },
    // The canonical Dracula accents: pink headings, orange bold, yellow italic,
    // cyan links, green code.
    {
      heading: '#bd93f9',
      bold: '#ffb86c',
      italic: '#f1fa8c',
      strikethrough: '#6272a4',
      link: '#8be9fd',
      code: '#50fa7b',
      quote: '#6272a4',
      list: '#ff79c6',
    },
  ),
  // Monokai (the classic TextMate/Sublime palette): warm charcoal with
  // high-energy magenta/green/yellow pops — canonically dark, shipped as such.
  locked(
    'monokai',
    'Monokai',
    {
      bg: '#272822',
      editorBg: '#1e1f1c',
      bgAlt: '#34352f',
      bgHover: '#3e3d32',
      fg: '#f8f8f2',
      fgMuted: '#90918b',
      accent: '#f92672',
      border: '#3e3d32',
      danger: '#ff7043',
      selection: '#49483e',
    },
    // Monokai's syntax spread: green headings, orange bold, purple italic,
    // cyan links, yellow code, magenta list markers.
    {
      heading: '#a6e22e',
      bold: '#fd971f',
      italic: '#ae81ff',
      strikethrough: '#75715e',
      link: '#66d9ef',
      code: '#e6db74',
      quote: '#75715e',
      list: '#f92672',
    },
  ),
];

/** Built-in light themes, in picker order (headed by the green "system
 *  default" — base.css is itself green-tinted). */
export const LIGHT_THEME_IDS: readonly string[] = [
  'light-green',
  'paper',
  'solarized-light',
  'nord-light',
];

/** Built-in dark themes, in picker order. */
export const DARK_THEME_IDS: readonly string[] = [
  'dark-green',
  'solarized-dark',
  'nord-dark',
  'dracula',
  'monokai',
];

/** The built-ins as seeded: every one stamped with the current SEED_VERSION so
 *  the loader can tell a shipped copy apart from an older, stale one. */
export const BUILT_IN_THEMES: ThemePlugin[] = BUILT_IN_THEME_DEFS.map((theme) => ({
  ...theme,
  version: SEED_VERSION,
}));
