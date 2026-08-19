/**
 * SVG recoloring for exports (pure; invariant I9 — no DOM, no Tauri, no
 * React). A diagram drawn on white paper with black ink lands in a themed
 * export looking like a pasted-in stranger: white plate, black strokes, on a
 * dark page. `themeSvg` remaps the markup's own colors onto the export
 * theme's ink/paper so embedded .svg files share the document's look.
 *
 * The rule is deliberately narrow, because the alternative — repainting every
 * color — destroys diagrams that use color to MEAN something (a red error
 * path, a green success branch):
 *
 * - Achromatic colors (black, white, every gray) are ink and paper. They are
 *   remapped continuously by luminance: pure black → `fg`, pure white → `bg`,
 *   grays to the corresponding blend. That preserves the drawing's internal
 *   contrast ordering while flipping it into the theme.
 * - Chromatic colors are meaning. They pass through untouched.
 * - `none`, `transparent`, `currentColor`, `url(#…)` are untouched — they are
 *   not colors, and `currentColor` already follows the injected root `color`.
 *
 * Colors are rewritten in the places SVG actually paints from: the paint
 * attributes (`fill`, `stroke`, `stop-color`, …) and CSS declarations, both in
 * `style="…"` attributes and in `<style>` blocks. Text content is never
 * touched, so a label reading "#ffffff" survives.
 *
 * Two CSS passes run first, because a stylesheet can hide its colors from a
 * plain declaration scan — this app's own whiteboard `.svg` does both:
 *
 * 1. `@media (prefers-color-scheme: …)` blocks are resolved to the drawing's
 *    LIGHT form — light blocks unwrapped, dark blocks dropped. Two reasons.
 *    Inside an `<img>` that query follows the READER's OS, so an export left
 *    holding both looks dark on one machine and light on the next, neither
 *    necessarily the theme that was chosen. And the ink/paper ramp below is
 *    what performs the flip: it maps black→fg and white→bg, so it must be fed
 *    the light palette. Handing it an already-dark one inverts it twice and
 *    the paper comes out as ink.
 * 2. `var(--x, fallback)` references are substituted with the custom
 *    property's declared value. A declaration the scan never resolves (`fill:
 *    var(--pen)`) is a color it can never remap — and pdfmake's SVG renderer
 *    doesn't understand custom properties at all, so the substitution is what
 *    gets those colors into the PDF in the first place.
 *
 * Parsing is textual rather than XML — core has no DOM, and a regex pass over
 * paint attributes cannot corrupt structure the way a hand-rolled parser can.
 *
 * Consumers: the HTML export re-encodes the themed markup as a data: URL
 * (`ui/session/export.ts`), the PDF export hands it to pdfmake's `svg` block
 * (`export/pdf.ts`). DOCX has no SVG path at all — Word's own style gallery
 * owns that document's look — so nothing calls this there.
 */

import { formatColor, luminance, mix, parseColor } from '../color';
import type { ThemePlugin } from '../theme-plugins';

/** Ink and paper an SVG is remapped onto. Both are `#rgb`/`#rrggbb`. */
export interface SvgTheme {
  /** The document's text color — where pure black lands. */
  fg: string;
  /** The document's page background — where pure white lands. */
  bg: string;
}

/** Ink/paper for the default palette — the same neutral pair the PDF export's
 *  `DEFAULT_PDF_THEME` uses, so an untouched theme reads identically. */
const DEFAULT_SVG_THEME: SvgTheme = { fg: '#1a1a1a', bg: '#ffffff' };

/**
 * Saturation (max−min over 255) below which a color counts as ink/paper
 * rather than meaning. Loose enough to catch the very slightly tinted grays
 * drawing tools emit (#f8f9fa and friends), tight enough to leave a muted
 * pastel alone.
 */
const ACHROMATIC_MAX_SATURATION = 0.1;

/**
 * Perceptual lightness (CIE L*, 0…1) from WCAG relative luminance. Luminance
 * alone is far too bottom-heavy to interpolate on — #333333 sits at 0.03 of
 * it, which would collapse every dark gray onto the foreground and flatten
 * the drawing's shading.
 */
function lightness(rgb: number): number {
  const y = luminance(rgb);
  return (y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y) / 100;
}

/** The named CSS colors worth recognizing: the achromatic ones. A chromatic
 *  name would pass through untouched anyway, so listing them buys nothing. */
const ACHROMATIC_NAMES: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  dimgray: '#696969',
  dimgrey: '#696969',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  slategray: '#708090',
  slategrey: '#708090',
  silver: '#c0c0c0',
  gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5',
  snow: '#fffafa',
  ivory: '#fffff0',
  linen: '#faf0e6',
};

/**
 * The end of the `{ … }` block starting at `open` (the index of the brace),
 * or -1 when it never closes. Brace counting is enough for CSS: the strings
 * that could hide a brace (`content: "}"`) don't appear in SVG stylesheets.
 */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') {
      depth++;
    } else if (css[i] === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Collapse `prefers-color-scheme` media blocks onto the drawing's light form:
 * a `light` block is unwrapped in place (keeping its position, so its
 * declarations still override the earlier defaults), a `dark` block is
 * dropped. The remapper needs the light palette to flip (see the file
 * header); the reader's OS must not get a vote in an exported file. Media
 * queries about anything else are left alone.
 */
function resolveColorSchemeMedia(markup: string): string {
  let out = markup;
  const at = /@media\b([^{]*)\{/gi;
  for (let match = at.exec(out); match; match = at.exec(out)) {
    const scheme = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(match[1]!);
    if (!scheme) {
      continue;
    }
    const open = match.index + match[0].length - 1;
    const close = blockEnd(out, open);
    if (close < 0) {
      break; // unbalanced stylesheet — leave the rest as it is
    }
    const body = scheme[1]!.toLowerCase() === 'light' ? out.slice(open + 1, close) : '';
    out = out.slice(0, match.index) + body + out.slice(close + 1);
    at.lastIndex = match.index; // the replacement may itself hold @media
  }
  return out;
}

/**
 * Substitute `var(--x, fallback)` with `--x`'s declared value, falling back to
 * the reference's own fallback (which is why this runs even when the document
 * declares no custom properties at all) and finally leaving the reference
 * alone.
 * Later declarations win, matching the cascade for the single-element-deep
 * `:root`-ish selectors SVG palettes use.
 */
function substituteCustomProperties(markup: string): string {
  const defined = new Map<string, string>();
  for (const match of markup.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    defined.set(match[1]!, match[2]!.trim());
  }
  let out = markup;
  // A value may itself reference another property; a couple of rounds settles
  // every palette worth supporting, and the bound stops a cyclic definition.
  for (let round = 0; round < 3 && out.includes('var('); round++) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/g,
      (reference, name: string, fallback: string | undefined) =>
        defined.get(name) ?? fallback ?? reference,
    );
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/** Attributes whose value is a paint (possibly `none` / `url(#…)`). */
const PAINT_ATTRIBUTES =
  'fill|stroke|color|stop-color|flood-color|lighting-color|solid-color|background-color';

/** CSS properties whose value carries a color. */
const PAINT_PROPERTIES = `${PAINT_ATTRIBUTES}|background|border-color|outline-color`;

/** A parsed color plus how to write it back with its original alpha. */
interface ParsedPaint {
  rgb: number;
  /** Re-encode a remapped rgb in the source's own notation. */
  format: (rgb: number) => string;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` or an achromatic name. */
function parsePaint(token: string): ParsedPaint | null {
  const value = token.trim();
  const named = ACHROMATIC_NAMES[value.toLowerCase()];
  if (named !== undefined) {
    return { rgb: parseColor(named)!, format: formatColor };
  }
  const hex8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(value);
  if (hex8) {
    const alpha = hex8[2]!;
    return { rgb: parseColor(`#${hex8[1]!}`)!, format: (rgb) => `${formatColor(rgb)}${alpha}` };
  }
  const plain = parseColor(value);
  if (plain !== null) {
    return { rgb: plain, format: formatColor };
  }
  const fn =
    /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*(?:[,/]\s*([0-9.%]+)\s*)?\)$/i.exec(
      value,
    );
  if (!fn) {
    return null;
  }
  const [r, g, b] = [fn[1]!, fn[2]!, fn[3]!].map((n) => Math.min(255, Math.round(Number(n))));
  if ([r, g, b].some((n) => !Number.isFinite(n))) {
    return null;
  }
  const alpha = fn[4];
  return {
    rgb: (r! << 16) | (g! << 8) | b!,
    format: (rgb) => {
      const hex = formatColor(rgb);
      const parts = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      return alpha === undefined
        ? `rgb(${parts.join(', ')})`
        : `rgba(${parts.join(', ')}, ${alpha})`;
    },
  };
}

/** Saturation as max−min over the channels, 0 (gray) to 1. */
function saturation(rgb: number): number {
  const channels = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  return (Math.max(...channels) - Math.min(...channels)) / 255;
}

/** One color through the ink/paper rule; chromatic colors return unchanged. */
export function remapSvgColor(rgb: number, theme: SvgTheme): number {
  if (saturation(rgb) > ACHROMATIC_MAX_SATURATION) {
    return rgb;
  }
  const fg = parseColor(theme.fg);
  const bg = parseColor(theme.bg);
  if (fg === null || bg === null) {
    return rgb; // a non-hex theme slot — leave the drawing alone
  }
  // Black (L* 0) lands exactly on fg, white (L* 1) exactly on bg.
  return mix(fg, bg, lightness(rgb));
}

/** Remap every color token in a paint value, leaving keywords and `url()`. */
function remapPaintValue(value: string, theme: SvgTheme): string {
  return value.replace(/[#\w][\w#.%]*(?:\([^)]*\))?/g, (token) => {
    const paint = parsePaint(token);
    return paint ? paint.format(remapSvgColor(paint.rgb, theme)) : token;
  });
}

/** Inject `attr="value"` into the root `<svg …>` tag unless already present. */
function withRootAttribute(markup: string, attr: string, value: string): string {
  return markup.replace(/<svg\b([^>]*)>/i, (tag, attrs: string) => {
    if (new RegExp(`\\b${attr}\\s*=`, 'i').test(attrs)) {
      return tag;
    }
    const selfClosing = attrs.endsWith('/');
    const body = selfClosing ? attrs.slice(0, -1) : attrs;
    return `<svg${body} ${attr}="${value}"${selfClosing ? ' /' : ''}>`;
  });
}

/**
 * `markup` recolored onto `theme`. Also strips the XML prolog and doctype
 * (pdfmake's SVG renderer wants a bare `<svg>` element) and pins the root's
 * inherited `fill`/`color` to the theme foreground, so shapes that never
 * declare a paint — SVG's initial `fill` is black — and any `currentColor`
 * reference follow the theme too.
 *
 * Markup with no `<svg>` element is returned unchanged: a file the exporter
 * couldn't parse must still export as whatever it was.
 */
export function themeSvg(markup: string, theme: SvgTheme): string {
  if (!/<svg\b/i.test(markup)) {
    return markup;
  }
  const bare = markup.replace(/<\?xml[\s\S]*?\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  const flattened = substituteCustomProperties(resolveColorSchemeMedia(bare));
  const attrRecolored = flattened.replace(
    new RegExp(`\\b(${PAINT_ATTRIBUTES})\\s*=\\s*("[^"]*"|'[^']*')`, 'gi'),
    (_match, attr: string, quoted: string) => {
      const quote = quoted[0]!;
      const value = quoted.slice(1, -1);
      return `${attr}=${quote}${remapPaintValue(value, theme)}${quote}`;
    },
  );
  const cssRecolored = attrRecolored.replace(
    new RegExp(`\\b(${PAINT_PROPERTIES})\\s*:\\s*([^;"'<}]+)`, 'gi'),
    (_match, prop: string, value: string) => `${prop}: ${remapPaintValue(value, theme)}`,
  );
  return withRootAttribute(
    withRootAttribute(cssRecolored.trimStart(), 'fill', theme.fg),
    'color',
    theme.fg,
  );
}

/**
 * The SVG's intrinsic pixel size from the root tag's `width`/`height`, falling
 * back to the `viewBox` extent — the PDF exporter needs a width to lay a
 * diagram out, and pdfmake will not measure one for us. Percentage or missing
 * dimensions with no viewBox give null (the caller picks a default).
 */
export function svgIntrinsicSize(markup: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(markup)?.[0];
  if (!tag) {
    return null;
  }
  const attr = (name: string): number | null => {
    const raw = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(
      tag,
    );
    const value = raw?.[1] ?? raw?.[2];
    if (value === undefined || /%\s*$/.test(value)) {
      return null; // relative units have no intrinsic size
    }
    const px = Number.parseFloat(value);
    return Number.isFinite(px) && px > 0 ? px : null;
  };
  const width = attr('width');
  const height = attr('height');
  if (width !== null && height !== null) {
    return { width, height };
  }
  const box =
    /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)/i.exec(
      tag,
    );
  if (!box) {
    return null;
  }
  const boxWidth = Number.parseFloat(box[3]!);
  const boxHeight = Number.parseFloat(box[4]!);
  if (!(boxWidth > 0) || !(boxHeight > 0)) {
    return null;
  }
  // One known dimension plus the viewBox's aspect ratio fixes the other.
  if (width !== null) {
    return { width, height: (width * boxHeight) / boxWidth };
  }
  if (height !== null) {
    return { width: (height * boxWidth) / boxHeight, height };
  }
  return { width: boxWidth, height: boxHeight };
}

/**
 * The ink/paper pair for a theme plugin, mirroring the fallback chain of
 * `pdfThemeFromPlugin` (`--fg`, `--editor-bg → --bg`). Plugins may hold any
 * safe CSS color, but the remapper needs hex — a non-hex slot falls back to
 * the neutral default, which at worst leaves the drawing near its original
 * black-on-white. `null` (the default palette) returns that neutral pair.
 */
export function svgThemeFromPlugin(plugin: ThemePlugin | null): SvgTheme {
  if (!plugin) {
    return DEFAULT_SVG_THEME;
  }
  const hexOr = (fallback: string, ...candidates: (string | undefined)[]): string =>
    candidates
      .find((value) => value !== undefined && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()))
      ?.trim() ?? fallback;
  return {
    fg: hexOr(DEFAULT_SVG_THEME.fg, plugin.branding.fg),
    bg: hexOr(DEFAULT_SVG_THEME.bg, plugin.branding.editorBg, plugin.branding.bg),
  };
}
