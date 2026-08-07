/**
 * Theme a saved whiteboard `.svg` WITHOUT parsing it as a scene — pure string
 * surgery on the root tag, shared by every place that shows a board through an
 * `<img>` (the split preview and the rich editor inline local images as data
 * URLs).
 *
 * Why this exists: an SVG loaded through `<img>` is a sealed document. The
 * app's `--wb-*` custom properties live in the page's CSS and cannot cross
 * that boundary, so a board in the markdown preview could only ever follow the
 * OS colour scheme via its embedded palette block — never the app theme. The
 * fix is to bake the RESOLVED theme values into the file text as an inline
 * `style` on the root `<svg>` right before building the data URL: inline
 * declarations beat the embedded block (the same trick the draw adapter uses
 * on the live board), and the bytes inside the `<img>` then carry the theme.
 *
 * Only the root tag is touched, and only for a board that opted in: the
 * serializer's `wb-board` class present, `wb-fixed` (colorMode `'fixed'`)
 * absent. Everything else — foreign SVGs, fixed-colour boards, `themed:false`
 * documents (which have no `wb-board` class) — passes through byte-identical.
 */

/** The palette variables a theme provides, in the file's own vocabulary. */
export const WB_THEME_VAR_NAMES = [
  '--wb-bg',
  '--wb-c0',
  '--wb-c1',
  '--wb-c2',
  '--wb-c3',
  '--wb-c4',
  '--wb-c5',
  '--wb-c6',
  '--wb-c7',
] as const;

/** name → resolved CSS colour; entries with empty values are skipped. */
export type BoardThemeVars = ReadonlyMap<string, string>;

/**
 * A stable one-line identity for a resolved var set — the cache key that keeps
 * "same image, same theme" a single disk read while a theme change misses.
 */
export function boardThemeFingerprint(vars: BoardThemeVars): string {
  return WB_THEME_VAR_NAMES.map((name) => `${name}:${vars.get(name) ?? ''}`).join(';');
}

/** The root `<svg …>` tag's source span, or null when there is none. */
function rootSvgTag(source: string): { start: number; end: number } | null {
  // Skip prolog/comments/doctype: find the first `<svg` that starts a tag.
  const start = source.search(/<svg[\s>]/);
  if (start < 0) {
    return null;
  }
  // Scan for the tag's closing `>` respecting quoted attribute values — an
  // attribute may legally contain `>`.
  let quote: string | null = null;
  for (let i = start + 4; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { start, end: i };
    }
  }
  return null;
}

/** The `class` attribute's value inside a tag's source, or null. */
function classValue(tag: string): string | null {
  const match = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/.exec(tag);
  return match ? (match[2] ?? match[3] ?? '') : null;
}

/**
 * Whether this SVG source is a whiteboard that WANTS the viewer's theme:
 * `wb-board` on the root (the serializer emits it only for themable docs) and
 * not `wb-fixed` (colorMode `'fixed'` — literal colours by request).
 */
export function isThemableBoardSvg(source: string): boolean {
  const span = rootSvgTag(source);
  if (!span) {
    return false;
  }
  const tokens = (classValue(source.slice(span.start, span.end + 1)) ?? '').split(/\s+/);
  return tokens.includes('wb-board') && !tokens.includes('wb-fixed');
}

/** `&`/`<`/`"` escaped for an XML attribute value. Colours never need more. */
function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Bake resolved `--wb-*` values into the root `<svg>` as an inline `style`
 * attribute. An existing root style keeps its declarations; ours are appended
 * after them, so on a conflict the theme wins (later declaration, same
 * specificity). Returns the source unchanged when it is not a themable board
 * or the var set resolves to nothing.
 */
export function injectBoardThemeVars(source: string, vars: BoardThemeVars): string {
  if (!isThemableBoardSvg(source)) {
    return source;
  }
  const declarations = WB_THEME_VAR_NAMES.flatMap((name) => {
    const value = vars.get(name)?.trim();
    return value ? [`${name}:${value}`] : [];
  }).join(';');
  if (declarations.length === 0) {
    return source;
  }
  const escaped = escapeAttrValue(declarations);
  const span = rootSvgTag(source)!;
  const tag = source.slice(span.start, span.end);
  const styleMatch = /([\s])style\s*=\s*("([^"]*)"|'([^']*)')/.exec(tag);
  let nextTag: string;
  if (styleMatch) {
    // The existing value is kept as its RAW attribute source (entities and
    // all) — re-escaping it would double-encode; only ours needs escaping.
    // The original quote character is kept too, so a value that legally
    // contains the other kind stays well-formed.
    const quote = styleMatch[2]!.startsWith("'") ? "'" : '"';
    const existing = (styleMatch[3] ?? styleMatch[4] ?? '').replace(/;\s*$/, '');
    const merged = existing.length > 0 ? `${existing};${escaped}` : escaped;
    nextTag =
      tag.slice(0, styleMatch.index) +
      `${styleMatch[1]}style=${quote}${merged}${quote}` +
      tag.slice(styleMatch.index + styleMatch[0].length);
  } else {
    nextTag = `${tag} style="${escaped}"`;
  }
  return source.slice(0, span.start) + nextTag + source.slice(span.end);
}
