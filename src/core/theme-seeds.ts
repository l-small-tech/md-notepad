/**
 * Built-in theme plugins, seeded into the themes folder on first run (only when
 * a file with the same id is absent) so they double as editable, AI-friendly
 * examples. These are the exact palettes that used to live as hard-coded blocks
 * in styles/themes.css — ported 1:1 (the authors' published hex values, lightly
 * adapted only where the app needs a variable the original doesn't name, e.g. a
 * recessed --editor-bg or a --selection tint). 'default' is NOT here: it is the
 * base.css palette and needs no plugin.
 */

import type { ThemePlugin } from './theme-plugins';

export const BUILT_IN_THEMES: ThemePlugin[] = [
  {
    id: 'solarized',
    name: 'Solarized',
    light: {
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
    },
    dark: {
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
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    light: {
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
    },
    dark: {
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
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    light: {
      bg: '#fbf1c7',
      editorBg: '#f4e8c1',
      bgAlt: '#ebdbb2',
      bgHover: '#e0d3a8',
      fg: '#3c3836',
      fgMuted: '#7c6f64',
      accent: '#d65d0e',
      border: '#e6d5a8',
      danger: '#cc241d',
      selection: '#e8c99a',
    },
    dark: {
      bg: '#282828',
      editorBg: '#1d2021',
      bgAlt: '#3c3836',
      bgHover: '#504945',
      fg: '#ebdbb2',
      fgMuted: '#a89984',
      accent: '#fe8019',
      border: '#3c3836',
      danger: '#fb4934',
      selection: '#504945',
    },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    light: {
      bg: '#fdf6e3',
      editorBg: '#f2efdf',
      bgAlt: '#f4f0d9',
      bgHover: '#efebd4',
      fg: '#5c6a72',
      fgMuted: '#939f91',
      accent: '#8da101',
      border: '#eae5cf',
      danger: '#f85552',
      selection: '#dfe6c8',
    },
    dark: {
      bg: '#2d353b',
      editorBg: '#232a2e',
      bgAlt: '#343f44',
      bgHover: '#3d484d',
      fg: '#d3c6aa',
      fgMuted: '#859289',
      accent: '#a7c080',
      border: '#3d484d',
      danger: '#e67e80',
      selection: '#475258',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    light: {
      bg: '#faf4ed',
      editorBg: '#f2ece3',
      bgAlt: '#f2e9e1',
      bgHover: '#e9dfd6',
      fg: '#575279',
      fgMuted: '#797593',
      accent: '#907aa9',
      border: '#ece3d8',
      danger: '#b4637a',
      selection: '#dfdad9',
    },
    dark: {
      bg: '#191724',
      editorBg: '#16151f',
      bgAlt: '#1f1d2e',
      bgHover: '#26233a',
      fg: '#e0def4',
      fgMuted: '#908caa',
      accent: '#c4a7e7',
      border: '#26233a',
      danger: '#eb6f92',
      selection: '#403d52',
    },
  },
  // Two originals drawn straight from the University of the Fraser Valley's live
  // web palette (ufv.ca): PANTONE 349 forest green #00703c ("growth and
  // transformation"), the fresh leaf-green #7cb232 it pairs with, pale-lime
  // highlights (#daebbd/#cfe6a9), warm-orange #e45300, and charcoal — never pure
  // black — over open, airy neutrals.
  //
  // These two are intentionally MODE-LOCKED: unlike the adaptive schemes above,
  // each presents ONE character no matter the OS light/dark setting, because
  // that character *is* the point — you pick the mood, not the machine.
  //   • "Light Green" is a bright, high-contrast light theme for glare, daylight,
  //     and meetings — near-white green-tinted paper, forest-green ink.
  //   • "Dark Green" is a low-light dark theme that's easy on the eyes for long
  //     or late sessions — deep emerald-forest with a soft (non-white) fg.
  // The lock is achieved by giving `light` and `dark` the SAME palette: the
  // renderer's dark block (higher specificity) then also overrides base.css's
  // own dark defaults, so the look holds in either OS mode. Keep the two blocks
  // in sync if you edit them — that's what pins the mood.
  {
    id: 'light-green',
    name: 'Light Green',
    // Always-light. `dark` mirrors `light` on purpose (see note above).
    light: {
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
    dark: {
      bg: '#eaf1e4',
      editorBg: '#fbfdf8',
      bgAlt: '#e0ebd8',
      bgHover: '#d3e3c9',
      fg: '#000000',
      fgMuted: '#586a5b',
      accent: '#00703c',
      border: '#d2e0c9',
      danger: '#c62828',
      selection: '#cfe6a9',
    },
    syntax: {
      // Headings walk UFV's forest-green → fresh-leaf-green range for hierarchy.
      light: {
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
      dark: {
        heading1: '#005c31',
        heading2: '#00703c',
        heading3: '#2f7d43',
        heading4: '#47913c',
        heading5: '#619f36',
        heading6: '#7cb232',
        bold: '#17241b',
        italic: '#5f7a63',
        strikethrough: '#8a978c',
        link: '#00703c',
        code: '#b5451f',
        quote: '#4e7358',
        list: '#4f9e3c',
      },
    },
  },
  {
    id: 'dark-green',
    name: 'Dark Green',
    // Always-dark. `light` mirrors `dark` on purpose (see note above).
    light: {
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
    dark: {
      bg: '#111c15',
      editorBg: '#0c150f',
      bgAlt: '#18261c',
      bgHover: '#223529',
      fg: '#ffffff',
      fgMuted: '#7d9585',
      accent: '#56c07a',
      border: '#223529',
      danger: '#e5766a',
      selection: '#21503a',
    },
    syntax: {
      // Lifted greens on the deep bg; a warm-sand code color for contrast.
      light: {
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
      dark: {
        heading1: '#7fd39b',
        heading2: '#6ac98a',
        heading3: '#56c07a',
        heading4: '#6fbf6e',
        heading5: '#8ccb5f',
        heading6: '#a6d96a',
        bold: '#e2efe3',
        italic: '#93ab97',
        strikethrough: '#6f8677',
        link: '#4ec9a0',
        code: '#e0a878',
        quote: '#8aa891',
        list: '#8ecb62',
      },
    },
  },
];
