/**
 * Theme plugins — the pure model behind pluggable color schemes.
 *
 * The whole app styles itself through ten CSS variables (see styles/base.css),
 * redefined per light/dark and selected by `data-color-scheme` on <html>. A
 * "theme plugin" is those ten variables for light and dark, plus an optional
 * `syntax` block that recolors individual markdown elements (headings, bold,
 * links, …) — authored as a small JSON file the user drops in the themes folder
 * (loaded by ipc/theme-loader.ts). This module is DOM/Tauri-free: it validates a
 * parsed JSON blob into a `ThemePlugin` and renders a plugin to the scoped CSS
 * the app injects at boot.
 *
 * Design notes:
 * - Palette/syntax values are validated as *safe* color strings — anything
 *   containing `;{}:` or a newline is dropped, so a hand-edited value can't break
 *   out of its declaration and corrupt the whole stylesheet. Missing keys are
 *   simply omitted; the app falls back to base.css's default for that variable
 *   (and each `--md-*` var itself falls back to a palette var in the consuming
 *   stylesheet), so a partial theme still works.
 * - `css` is an intentional escape hatch: verbatim CSS the author scopes
 *   themselves (for spacing/font tweaks the variables can't express). It is
 *   emitted as-is — the themes folder is the user's own machine.
 */

/** The ten palette keys (JSON field → CSS custom property). Every scheme block
 *  in the app is exactly these variables; see styles/base.css. */
export const PALETTE_KEYS = {
  bg: '--bg',
  editorBg: '--editor-bg',
  bgAlt: '--bg-alt',
  bgHover: '--bg-hover',
  fg: '--fg',
  fgMuted: '--fg-muted',
  accent: '--accent',
  border: '--border',
  danger: '--danger',
  selection: '--selection',
} as const;

/**
 * Optional markdown-element colors (JSON field → CSS custom property). Each maps
 * to a `--md-*` variable consumed by the three rendering surfaces (editors/cm6.ts,
 * styles/preview.css, styles/wysiwyg.css). Every consumer references its var with
 * a fallback to the previous palette-derived color, so an unset key changes
 * nothing. `heading` sets all levels; `heading1`…`heading6` override per level.
 */
export const SYNTAX_KEYS = {
  heading: '--md-heading',
  heading1: '--md-heading1',
  heading2: '--md-heading2',
  heading3: '--md-heading3',
  heading4: '--md-heading4',
  heading5: '--md-heading5',
  heading6: '--md-heading6',
  bold: '--md-bold',
  italic: '--md-italic',
  strikethrough: '--md-strike',
  link: '--md-link',
  code: '--md-code',
  quote: '--md-quote',
  list: '--md-list',
} as const;

export type PaletteKey = keyof typeof PALETTE_KEYS;
export type SyntaxKey = keyof typeof SYNTAX_KEYS;

export const PALETTE_KEY_LIST = Object.keys(PALETTE_KEYS) as PaletteKey[];
export const SYNTAX_KEY_LIST = Object.keys(SYNTAX_KEYS) as SyntaxKey[];

/** A light or dark palette: any subset of the ten keys → color string. */
export type Palette = Partial<Record<PaletteKey, string>>;
/** A light or dark markdown-element palette: any subset of the syntax keys. */
export type SyntaxPalette = Partial<Record<SyntaxKey, string>>;

/** Per-mode markdown-element colors. */
export interface SyntaxColors {
  light: SyntaxPalette;
  dark: SyntaxPalette;
}

export interface ThemePlugin {
  /** Slug (from the filename); also the `data-color-scheme` value. */
  id: string;
  /** Display name for the settings dropdown. */
  name: string;
  light: Palette;
  dark: Palette;
  /** Optional per-mode markdown-element colors (the `--md-*` vars). */
  syntax?: SyntaxColors;
  /** Optional verbatim CSS appended after the palette blocks. */
  css?: string;
  /** Seed-content version, stamped only on the built-in examples we write to the
   *  themes folder. Lets the loader refresh a stale copy when the shipped
   *  definition changes (see ipc/theme-loader.ts). User-authored themes omit it. */
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A color value is accepted only if it's a non-empty string free of the
 * characters that would let it escape a `--var: <value>;` declaration. We do
 * NOT try to parse color syntax — hex, rgb(), hsl(), and named colors all pass;
 * garbage merely renders as an invalid (ignored) declaration.
 */
function isSafeColor(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[;{}:\n\r]/.test(value);
}

/** Keep only the given keys with safe values; drop everything else silently. */
function pickSafe<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = raw[key];
    if (isSafeColor(value)) {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * Validate a parsed JSON blob into a `ThemePlugin`. Returns null only when the
 * input is unusable (not an object, or no *palette* values at all after
 * validation) — a lenient parse so a slightly-malformed theme degrades rather
 * than disappearing. A theme with only `syntax` colors and no palette is treated
 * as invalid (there'd be nothing to distinguish it from the default palette).
 * `id` is supplied by the caller (the filename slug).
 */
export function parseThemePlugin(id: string, raw: unknown): ThemePlugin | null {
  if (!isRecord(raw)) {
    return null;
  }
  const light = pickSafe(raw.light, PALETTE_KEY_LIST);
  const dark = pickSafe(raw.dark, PALETTE_KEY_LIST);
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    // Nothing to apply — treat as invalid so the loader skips it.
    return null;
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id;
  const css = typeof raw.css === 'string' && raw.css.trim().length > 0 ? raw.css : undefined;

  const syntaxRaw = isRecord(raw.syntax) ? raw.syntax : undefined;
  const syntaxLight = pickSafe(syntaxRaw?.light, SYNTAX_KEY_LIST);
  const syntaxDark = pickSafe(syntaxRaw?.dark, SYNTAX_KEY_LIST);
  const syntax =
    Object.keys(syntaxLight).length > 0 || Object.keys(syntaxDark).length > 0
      ? { light: syntaxLight, dark: syntaxDark }
      : undefined;

  return {
    id,
    name,
    light,
    dark,
    ...(syntax ? { syntax } : {}),
    ...(css ? { css } : {}),
  };
}

/** CSS-escape a single-quoted attribute value (id is already slug-safe, but be
 *  defensive against quotes/backslashes ever reaching here). */
function escapeAttrValue(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Render `values` as `--var: color;` lines for the keys that are present. */
function declarations<K extends string>(
  values: Partial<Record<K, string>>,
  vars: Record<K, string>,
  keys: readonly K[],
): string {
  return keys
    .filter((key) => values[key] !== undefined)
    .map((key) => `  ${vars[key]}: ${values[key]};`)
    .join('\n');
}

/** Join the palette declarations and (optional) syntax declarations for one mode. */
function modeDeclarations(palette: Palette, syntax: SyntaxPalette | undefined): string {
  return [
    declarations(palette, PALETTE_KEYS, PALETTE_KEY_LIST),
    syntax ? declarations(syntax, SYNTAX_KEYS, SYNTAX_KEY_LIST) : '',
  ]
    .filter((block) => block.length > 0)
    .join('\n');
}

/**
 * Render a plugin to the CSS the app injects: a light block scoped
 * `:not([data-theme='dark'])` plus a `[data-theme='dark']` block, then the
 * verbatim `css`. base.css signals dark with `data-theme='dark'` on <html> and
 * this stylesheet is appended AFTER it, so the light block MUST exclude dark
 * mode — otherwise a theme that sets a `light` key but omits the same `dark` key
 * would tie base.css's dark rule on specificity and (winning by source order)
 * leak its light color into OS dark mode. Excluding dark preserves the contract
 * that a missing key falls back to base.css's default in BOTH modes.
 * Palette and `--md-*` syntax vars share each mode's block.
 */
export function themePluginToCss(plugin: ThemePlugin): string {
  const attr = escapeAttrValue(plugin.id);
  const blocks: string[] = [];
  const light = modeDeclarations(plugin.light, plugin.syntax?.light);
  if (light) {
    blocks.push(`:root[data-color-scheme='${attr}']:not([data-theme='dark']) {\n${light}\n}`);
  }
  const dark = modeDeclarations(plugin.dark, plugin.syntax?.dark);
  if (dark) {
    blocks.push(`:root[data-color-scheme='${attr}'][data-theme='dark'] {\n${dark}\n}`);
  }
  if (plugin.css) {
    blocks.push(plugin.css);
  }
  return blocks.join('\n');
}

/** Concatenate every plugin's CSS into one stylesheet body. */
export function themePluginsToCss(plugins: readonly ThemePlugin[]): string {
  return plugins.map(themePluginToCss).join('\n\n');
}
