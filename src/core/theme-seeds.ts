/**
 * Built-in theme plugins, seeded into the themes folder so they double as
 * editable, AI-friendly examples. 'default' is NOT here: it is the base.css
 * palette and needs no plugin.
 *
 * Every theme presents ONE character — light or dark — no matter the OS
 * light/dark setting, because that character *is* the point: you pick the
 * mood, not the machine. The lock is DECLARED via each theme's `mode`, which
 * groups the picker and pins `data-theme` on <html> while the theme is
 * selected.
 *
 * Each built-in's `branding` carries the brand trio (primary/secondary/
 * tertiary) — the theme's three identity colors, which drive the vector
 * graphics ink derivation in styles/base.css. primary is the theme's accent;
 * secondary and tertiary are picked from each palette's strongest supporting
 * colors.
 *
 * The collection (rebuilt 2026-08 around the branding structure):
 *  - Light/Dark Green — the flagship pair, drawn from UFV's live web palette.
 *  - Beacon / Vantablack — high-contrast light & dark, for glare, low vision,
 *    and e-ink-like clarity.
 *  - Skylark / Nightjar — color-vision-friendly light & dark, built on the
 *    Okabe–Ito palette (distinguishable under protan/deutan/tritan vision).
 *  - Lagoon / Abyss — shallow-ocean light & deep-ocean dark.
 *  - The color-wheel series, one theme per major hue (green is covered by the
 *    flagship pair): Garnet (red), Marmalade (orange), Honeycomb (yellow),
 *    Cyanotype (cyan), Ultramarine (blue), Amethyst (violet), Dragonfruit
 *    (magenta).
 *
 * Every theme except the flagship green pair ships a `consoleBackground`
 * image — deep space behind acrylic frost, tinted to its palette — generated
 * by scripts/gen-theme-backgrounds.py and seeded next to the theme's JSON by
 * ipc/theme-loader.ts (SEED_IMAGES). The greens keep a flat color on purpose.
 *
 * Each seeded file is stamped with SEED_VERSION. The loader (ipc/theme-loader.ts)
 * writes a built-in when absent AND refreshes a copy whose stamped version is
 * older than SEED_VERSION — so a definition change here (a fixed color, an added
 * syntax block) reaches devices that seeded an earlier build, instead of the old
 * write-once behavior that left stale files forever. Bump SEED_VERSION whenever
 * any definition below changes.
 */

import type { ThemePlugin } from './theme-plugins';

/** Bump when any built-in definition below changes (see module comment) —
 *  including the bundled background images (ipc/theme-seed-images.ts): the
 *  loader reseeds a theme's image only when the theme file itself refreshes. */
export const SEED_VERSION = 9;

/**
 * Built-ins we used to seed but no longer ship. Gruvbox/Everforest/Rosé Pine
 * were dropped for looking too much alike; `solarized` and `nord` were replaced
 * by their mode-locked Light/Dark variants; the 2026-08 rebuild retired the
 * borrowed editor palettes (Solarized, Nord, Dracula, Monokai) and Paper in
 * favor of an original collection. The loader DELETES a themes-folder copy of
 * these ids, but only when the file still carries our seed `version` stamp — a
 * stamp-less file is user-authored (or user-adopted) and is left alone.
 */
export const RETIRED_THEME_IDS: readonly string[] = [
  'gruvbox',
  'everforest',
  'rose-pine',
  'solarized',
  'nord',
  'paper',
  'solarized-light',
  'solarized-dark',
  'nord-light',
  'nord-dark',
  'dracula',
  'monokai',
];

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
  {
    id: 'light-green',
    name: 'Light Green',
    mode: 'light',
    branding: {
      primary: '#00703c', // UFV forest green
      secondary: '#b5451f', // burnt orange
      tertiary: '#7cb232', // fresh leaf-green
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
    syntax: {
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
  },
  {
    id: 'dark-green',
    name: 'Dark Green',
    mode: 'dark',
    branding: {
      primary: '#56c07a', // lifted emerald
      secondary: '#e0a878', // warm sand
      tertiary: '#a6d96a', // lifted leaf-green
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
    syntax: {
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
  },
  // "Beacon": the high-contrast light theme — pure white paper, pure black ink,
  // a deep signal-blue accent, and a highlighter-yellow selection. For harsh
  // glare, low-vision use, and anyone who wants text that simply cannot smear.
  {
    id: 'beacon',
    consoleBackground: { image: 'beacon-bg.webp' },
    name: 'Beacon',
    mode: 'light',
    branding: {
      primary: '#0033cc', // signal blue
      secondary: '#cc0000', // alarm red
      tertiary: '#008055', // sea-signal green
      bg: '#ffffff',
      editorBg: '#ffffff', // no tint anywhere — maximum figure/ground separation
      bgAlt: '#f0f0f0',
      bgHover: '#dcdcdc',
      fg: '#000000',
      fgMuted: '#3d3d3d', // "muted" still passes AAA on white
      accent: '#0033cc',
      border: '#767676', // hard, visible panel lines
      danger: '#cc0000',
      selection: '#ffe066', // highlighter yellow — unmistakable selection
    },
    // Black-on-white stays the rule; color only where it carries meaning.
    syntax: {
      heading: '#000000', // headings by weight/size, not tint — print-like
      bold: '#000000',
      italic: '#3d3d3d',
      strikethrough: '#5c5c5c',
      link: '#0033cc',
      code: '#8a0f0f', // dark red monospace, unambiguous on white
      quote: '#3d3d3d',
      list: '#000000',
    },
  },
  // "Vantablack": the high-contrast dark theme — true-black ground, pure white
  // text, one hot amber accent. Named for the light-swallowing coating; ideal
  // for OLED screens and pitch-dark rooms.
  {
    id: 'vantablack',
    consoleBackground: { image: 'vantablack-bg.webp' },
    name: 'Vantablack',
    mode: 'dark',
    branding: {
      primary: '#ffd400', // hot amber — the one loud voice on black
      secondary: '#4dd9ff', // electric cyan
      tertiary: '#ff5c8a', // hot pink
      bg: '#000000',
      editorBg: '#000000', // true black edge to edge (OLED off-pixels)
      bgAlt: '#141414',
      bgHover: '#242424',
      fg: '#ffffff',
      fgMuted: '#bdbdbd', // still AAA on black
      accent: '#ffd400',
      border: '#6e6e6e', // hard, visible panel lines
      danger: '#ff5252',
      selection: '#264f9c', // deep cobalt — visible without dimming white text
    },
    syntax: {
      heading: '#ffd400', // amber headings — the theme's single flourish
      bold: '#ffffff',
      italic: '#bdbdbd',
      strikethrough: '#8a8a8a',
      link: '#4dd9ff',
      code: '#7dffa8', // phosphor green monospace
      quote: '#bdbdbd',
      list: '#ffd400',
    },
  },
  // "Skylark": the color-vision-friendly light theme. Every hue is drawn from
  // the Okabe–Ito palette, engineered so its colors stay distinguishable under
  // protan, deutan, and tritan vision — meaning is never carried by a red/green
  // difference. Bright, airy, blue-and-orange like its namesake's morning sky.
  {
    id: 'skylark',
    consoleBackground: { image: 'skylark-bg.webp' },
    name: 'Skylark',
    mode: 'light',
    branding: {
      primary: '#0072b2', // Okabe–Ito blue
      secondary: '#d55e00', // Okabe–Ito vermillion
      tertiary: '#e69f00', // Okabe–Ito orange
      bg: '#f2f5f9',
      editorBg: '#ffffff',
      bgAlt: '#e7edf4',
      bgHover: '#d9e2ec',
      fg: '#22262e',
      fgMuted: '#5c6470',
      accent: '#0072b2',
      border: '#d3dce6',
      danger: '#d55e00', // vermillion, NOT red — stays loud for every viewer
      selection: '#b8d9ee',
    },
    // Blue for structure, vermillion for code, orange for emphasis marks —
    // three hues no common color-vision type collapses together.
    syntax: {
      heading: '#0072b2',
      bold: '#171a20',
      italic: '#5c6470',
      strikethrough: '#8b93a0',
      link: '#005a8e', // deeper blue than headings, still clearly a link
      code: '#b34e00', // vermillion, darkened for white paper
      quote: '#56728a',
      list: '#e69f00',
    },
  },
  // "Nightjar": the color-vision-friendly dark theme — Skylark's nocturnal
  // sibling, same Okabe–Ito discipline on a moonless slate ground. Sky-blue
  // structure, orange warmth, reddish-purple markers: separable by lightness
  // as well as hue.
  {
    id: 'nightjar',
    consoleBackground: { image: 'nightjar-bg.webp' },
    name: 'Nightjar',
    mode: 'dark',
    branding: {
      primary: '#56b4e9', // Okabe–Ito sky blue
      secondary: '#e69f00', // Okabe–Ito orange
      tertiary: '#cc79a7', // Okabe–Ito reddish purple
      bg: '#171a20',
      editorBg: '#111419',
      bgAlt: '#1f242c',
      bgHover: '#293039',
      fg: '#e8e8e6',
      fgMuted: '#949aa5',
      accent: '#56b4e9',
      border: '#2b323c',
      danger: '#e69042', // lifted vermillion-orange — alarm without relying on red
      selection: '#274a63',
    },
    syntax: {
      heading: '#56b4e9',
      bold: '#f5f5f3',
      italic: '#a7adb8',
      strikethrough: '#6e747f',
      link: '#8fd0f5', // lighter sky than headings
      code: '#e69f00', // orange monospace — pops on slate
      quote: '#94a8b8',
      list: '#cc79a7',
    },
  },
  // "Lagoon": the shallow-ocean light theme — sun on a sandy-floored reef
  // lagoon. Pale aqua chrome, near-white foam writing surface, tropical-teal
  // accent, a live-coral counterpoint.
  {
    id: 'lagoon',
    consoleBackground: { image: 'lagoon-bg.webp' },
    name: 'Lagoon',
    mode: 'light',
    branding: {
      primary: '#0e8a94', // tropical teal
      secondary: '#d96a3e', // live coral
      tertiary: '#2ea8c9', // clear-water cyan
      bg: '#e0f1ef', // sunlit shallows
      editorBg: '#f7fcfb', // white foam writing surface
      bgAlt: '#d2eae7',
      bgHover: '#c1e1dd',
      fg: '#0f3438', // deep-water ink
      fgMuted: '#54797d',
      accent: '#0e8a94',
      border: '#c4ded9',
      danger: '#c04030', // coral-red warning
      selection: '#aee0e0',
    },
    // Teal structure with coral code — a snorkeler's palette.
    syntax: {
      heading1: '#0a6b74', // deepest channel
      heading2: '#0e8a94',
      heading3: '#1897a8',
      heading4: '#24a4ba',
      heading5: '#2ea8c9',
      heading6: '#57b8d4', // shallowest water
      bold: '#0a2528',
      italic: '#547e79',
      strikethrough: '#8fa9a6',
      link: '#0b7286',
      code: '#c05a2e', // coral, darkened for the pale ground
      quote: '#4e7d81',
      list: '#17a08c',
    },
  },
  // "Abyss": the deep-ocean dark theme — the lightless water column below the
  // last blue photon. Near-black blue ground; the only color is what glows:
  // bioluminescent cyan, lure-green, jelly-violet.
  {
    id: 'abyss',
    name: 'Abyss',
    mode: 'dark',
    branding: {
      primary: '#38b6d8', // bioluminescent cyan
      secondary: '#5fe0b7', // anglerfish lure-green
      tertiary: '#8f9ff0', // jellyfish violet-blue
      bg: '#071220', // the last hint of blue before black
      editorBg: '#040c17', // the floor of the trench
      bgAlt: '#0c1c2e',
      bgHover: '#13293f',
      fg: '#cfe2ee', // pale, cold light
      fgMuted: '#64809a',
      accent: '#38b6d8',
      border: '#132638',
      danger: '#f0716e', // deep-sea red — the color that vanishes first, kept for alarms
      selection: '#123a55',
    },
    // Structure descends from surface-cyan toward violet depth; code glows
    // lure-green.
    syntax: {
      heading1: '#6fd3ec', // nearest the surface, brightest
      heading2: '#4fc2df',
      heading3: '#38b6d8',
      heading4: '#4aa8de',
      heading5: '#6ba0e8',
      heading6: '#8f9ff0', // deepest, violet
      bold: '#e4f1f8',
      italic: '#8aa3b8',
      strikethrough: '#54687c',
      link: '#5ccfe6',
      code: '#5fe0b7', // the lure
      quote: '#7590a8',
      list: '#49bfc9',
    },
    consoleBackground: { image: 'abyss-bg.webp' },
  },
  // ——— The color-wheel series: one theme per major hue. Green is covered by
  // the flagship Light/Dark Green pair. ———
  //
  // "Garnet" (RED, dark): deep gemstone red — wine-dark ground, cut-stone red
  // accent, a candlelight amber second voice. Because the theme itself is red,
  // danger leans hot orange so alarms still read as alarms.
  {
    id: 'garnet',
    consoleBackground: { image: 'garnet-bg.webp' },
    name: 'Garnet',
    mode: 'dark',
    branding: {
      primary: '#d65858', // cut garnet
      secondary: '#e8a04c', // candlelight amber
      tertiary: '#c97b9d', // rhodolite pink
      bg: '#1e1114',
      editorBg: '#170c0f',
      bgAlt: '#2a181c',
      bgHover: '#372126',
      fg: '#f2e6e6',
      fgMuted: '#a58a8d',
      accent: '#d65858',
      border: '#38222a',
      danger: '#ff8a4d', // hot orange — distinct from the theme's own reds
      selection: '#57262e',
    },
    syntax: {
      heading1: '#e87f7f', // brightest facet
      heading2: '#df6b6b',
      heading3: '#d65858',
      heading4: '#cc5f70',
      heading5: '#c96f88',
      heading6: '#c97b9d', // pinkest facet
      bold: '#f9efee',
      italic: '#b39a9c',
      strikethrough: '#7d6467',
      link: '#e39a68', // amber links, never confusable with body reds
      code: '#e8a04c',
      quote: '#a88a90',
      list: '#d65868',
    },
  },
  // "Marmalade" (ORANGE, light): breakfast-table warmth — toast-cream paper,
  // bitter-orange accent, a teal complement for links so the citrus never
  // becomes monotone.
  {
    id: 'marmalade',
    consoleBackground: { image: 'marmalade-bg.webp' },
    name: 'Marmalade',
    mode: 'light',
    branding: {
      primary: '#c9660d', // bitter seville orange
      secondary: '#2a7f8c', // teapot teal
      tertiary: '#e09a2b', // peel-zest gold
      bg: '#f9efe1', // toast cream
      editorBg: '#fffaf2',
      bgAlt: '#f2e3cc',
      bgHover: '#e9d5b7',
      fg: '#3a2a1a', // toast-crust brown
      fgMuted: '#8a7154',
      accent: '#c9660d',
      border: '#e8d5ba',
      danger: '#bf3527',
      selection: '#f8dca6',
    },
    syntax: {
      heading1: '#a34f06', // darkest rind
      heading2: '#c9660d',
      heading3: '#d0761a',
      heading4: '#d78628',
      heading5: '#dc9029',
      heading6: '#e09a2b', // lightest zest
      bold: '#2d2012',
      italic: '#8a7154',
      strikethrough: '#b3a189',
      link: '#2a7f8c', // teal — the palate-cleanser
      code: '#b04a12',
      quote: '#8a6f4e',
      list: '#d3821c',
    },
  },
  // "Honeycomb" (YELLOW, light): warm wax and honey — yellow is the hardest hue
  // to read on white, so the golds are kept dark (goldenrod, not lemon) and the
  // paper carries the sunshine instead.
  {
    id: 'honeycomb',
    consoleBackground: { image: 'honeycomb-bg.webp' },
    name: 'Honeycomb',
    mode: 'light',
    branding: {
      primary: '#a87708', // dark honey-gold
      secondary: '#6b4fae', // violet complement
      tertiary: '#d4a017', // goldenrod
      bg: '#f9f2da', // beeswax
      editorBg: '#fffdf4', // comb-cell cream
      bgAlt: '#f2e8c6',
      bgHover: '#eaddab',
      fg: '#332a0f', // dark amber ink
      fgMuted: '#83784f',
      accent: '#a87708',
      border: '#e8dcae',
      danger: '#bb3a2a',
      selection: '#f6e48f', // pollen highlight
    },
    syntax: {
      heading1: '#8a5f04', // darkest honey
      heading2: '#a87708',
      heading3: '#b3830c',
      heading4: '#bf9010',
      heading5: '#ca9813',
      heading6: '#d4a017', // brightest goldenrod
      bold: '#291f0a',
      italic: '#83784f',
      strikethrough: '#aea375',
      link: '#6b4fae', // violet — yellow's true complement, unmistakably a link
      code: '#9c520f', // amber-brown monospace
      quote: '#7d724a',
      list: '#c08c0e',
    },
  },
  // "Cyanotype" (CYAN, dark): the blueprint process — Prussian-blue paper,
  // white-line drawing, sun-bleached cyan accents. Crisper and bluer than
  // Abyss, which owns the near-black deep water.
  {
    id: 'cyanotype',
    consoleBackground: { image: 'cyanotype-bg.webp' },
    name: 'Cyanotype',
    mode: 'dark',
    branding: {
      primary: '#4fc3e8', // developed cyan
      secondary: '#dcebf5', // white-line print
      tertiary: '#2e86ab', // wet Prussian wash
      bg: '#0e1e33', // Prussian blue sheet
      editorBg: '#0a1728',
      bgAlt: '#15293f',
      bgHover: '#1d344d',
      fg: '#dcebf5', // the white line itself
      fgMuted: '#7e97ad',
      accent: '#4fc3e8',
      border: '#1e3550',
      danger: '#ff7a85', // red pencil markup on the blueprint
      selection: '#1f4568',
    },
    syntax: {
      heading: '#4fc3e8',
      bold: '#f0f7fc', // brightest white-line
      italic: '#9db4c8',
      strikethrough: '#5c7288',
      link: '#8fdcf2',
      code: '#8ee8d0', // developer-bath green
      quote: '#8aa5bc',
      list: '#3aa8d8',
    },
  },
  // "Ultramarine" (BLUE, light): the pigment ground from lapis lazuli — cool
  // porcelain paper, deep ultramarine accent, a burnt-sienna complement (the
  // classic painter's pairing).
  {
    id: 'ultramarine',
    consoleBackground: { image: 'ultramarine-bg.webp' },
    name: 'Ultramarine',
    mode: 'light',
    branding: {
      primary: '#2f52c9', // ultramarine
      secondary: '#bf5b2d', // burnt sienna
      tertiary: '#5a7de0', // lightened lapis
      bg: '#e9eef8', // cool porcelain
      editorBg: '#fafbfe',
      bgAlt: '#dee6f4',
      bgHover: '#cfdaf0',
      fg: '#1a2340', // ink-navy
      fgMuted: '#5d6a8c',
      accent: '#2f52c9',
      border: '#d0daee',
      danger: '#c03434',
      selection: '#c3d2f5',
    },
    syntax: {
      heading1: '#20389c', // deepest pigment
      heading2: '#2f52c9',
      heading3: '#3c60d4',
      heading4: '#4a6eda',
      heading5: '#5276de',
      heading6: '#5a7de0', // most diluted wash
      bold: '#121a33',
      italic: '#5d6a8c',
      strikethrough: '#94a0bc',
      link: '#1f47c4',
      code: '#a8481c', // burnt sienna monospace
      quote: '#56648a',
      list: '#3f63d2',
    },
  },
  // "Amethyst" (VIOLET, dark): the gemstone at dusk — deep aubergine ground,
  // lifted amethyst accent, a citrine-gold second stone for contrast.
  {
    id: 'amethyst',
    consoleBackground: { image: 'amethyst-bg.webp' },
    name: 'Amethyst',
    mode: 'dark',
    branding: {
      primary: '#a678e8', // lifted amethyst
      secondary: '#e8c268', // citrine gold
      tertiary: '#d78ac2', // rose quartz
      bg: '#1a1425',
      editorBg: '#140f1d',
      bgAlt: '#251c33',
      bgHover: '#302543',
      fg: '#e9e2f2',
      fgMuted: '#9c8fb3',
      accent: '#a678e8',
      border: '#2e2440',
      danger: '#f0716e',
      selection: '#3d2c5c',
    },
    syntax: {
      heading1: '#c3a0f2', // palest facet
      heading2: '#b48cee',
      heading3: '#a678e8',
      heading4: '#b078dc',
      heading5: '#c481d0',
      heading6: '#d78ac2', // rosiest facet
      bold: '#f4eff9',
      italic: '#ab9ec2',
      strikethrough: '#6f6484',
      link: '#c9aef4',
      code: '#e8c268', // citrine monospace
      quote: '#a495bc',
      list: '#b98ae0',
    },
  },
  // "Dragonfruit" (MAGENTA, light): the fruit itself — blush-pink skin for the
  // chrome, pale flesh for the page, hot magenta accent, and the fruit's green
  // scale-tips as the supporting voice.
  {
    id: 'dragonfruit',
    consoleBackground: { image: 'dragonfruit-bg.webp' },
    name: 'Dragonfruit',
    mode: 'light',
    branding: {
      primary: '#c2186f', // hot magenta
      secondary: '#3f9e6f', // scale-tip green
      tertiary: '#e05a9a', // blush pink
      bg: '#fae9f1', // pink skin
      editorBg: '#fefafc', // pale flesh
      bgAlt: '#f5dce9',
      bgHover: '#eeccdf',
      fg: '#381528', // seed-dark ink
      fgMuted: '#93677d',
      accent: '#c2186f',
      border: '#eed3e1',
      danger: '#bf3527',
      selection: '#f6c8de',
    },
    syntax: {
      heading1: '#9c0e57', // deepest magenta
      heading2: '#c2186f',
      heading3: '#ca2f7e',
      heading4: '#d2418a',
      heading5: '#d94e92',
      heading6: '#e05a9a', // lightest blush
      bold: '#2c0f1f',
      italic: '#93677d',
      strikethrough: '#bd93a6',
      link: '#a8125f',
      code: '#2f7f57', // scale-tip green monospace
      quote: '#8e6478',
      list: '#d24488',
    },
  },
];

/** Seeded picker order (light themes first, headed by the green "system
 *  default" — base.css is itself green-tinted). Used only for SORTING the
 *  theme list; grouping comes from each plugin's `mode`. */
export const BUILT_IN_ORDER: readonly string[] = [
  'light-green',
  'beacon',
  'skylark',
  'lagoon',
  'marmalade',
  'honeycomb',
  'ultramarine',
  'dragonfruit',
  'dark-green',
  'vantablack',
  'nightjar',
  'abyss',
  'garnet',
  'cyanotype',
  'amethyst',
];

/** The built-ins as seeded: every one stamped with the current SEED_VERSION so
 *  the loader can tell a shipped copy apart from an older, stale one. */
export const BUILT_IN_THEMES: ThemePlugin[] = BUILT_IN_THEME_DEFS.map((theme) => ({
  ...theme,
  version: SEED_VERSION,
}));
