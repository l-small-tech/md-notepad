/**
 * Theme plugins — the pure model behind pluggable color schemes.
 *
 * The whole app styles itself through ten CSS variables (see styles/base.css),
 * redefined per light/dark and selected by `data-color-scheme` on <html>. A
 * "theme plugin" is just those ten variables for light and dark, authored as a
 * small JSON file the user drops in the themes folder (loaded by
 * ipc/theme-loader.ts). This module is DOM/Tauri-free: it validates a parsed
 * JSON blob into a `ThemePlugin` and renders a plugin to the scoped CSS the app
 * injects at boot.
 *
 * Design notes:
 * - Palette values are validated as *safe* color strings — anything containing
 *   `;{}:` or a newline is dropped, so a hand-edited value can't break out of
 *   its declaration and corrupt the whole stylesheet. Missing keys are simply
 *   omitted; the app falls back to base.css's default for that variable, so a
 *   partial theme still works.
 * - `css` is an intentional escape hatch: verbatim CSS the author scopes
 *   themselves (for spacing/font tweaks the ten-variable palette can't express).
 *   It is emitted as-is — the themes folder is the user's own machine.
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

export type PaletteKey = keyof typeof PALETTE_KEYS;

export const PALETTE_KEY_LIST = Object.keys(PALETTE_KEYS) as PaletteKey[];

/** A light or dark palette: any subset of the ten keys → color string. */
export type Palette = Partial<Record<PaletteKey, string>>;

export interface ThemePlugin {
  /** Slug (from the filename); also the `data-color-scheme` value. */
  id: string;
  /** Display name for the settings dropdown. */
  name: string;
  light: Palette;
  dark: Palette;
  /** Optional verbatim CSS appended after the palette blocks. */
  css?: string;
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

/** Keep only known keys with safe values; drop everything else silently. */
function normalizePalette(raw: unknown): Palette {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Palette = {};
  for (const key of PALETTE_KEY_LIST) {
    const value = raw[key];
    if (isSafeColor(value)) {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * Validate a parsed JSON blob into a `ThemePlugin`. Returns null only when the
 * input is unusable (not an object, or no palette values at all after
 * validation) — a lenient parse so a slightly-malformed theme degrades rather
 * than disappearing. `id` is supplied by the caller (the filename slug).
 */
export function parseThemePlugin(id: string, raw: unknown): ThemePlugin | null {
  if (!isRecord(raw)) {
    return null;
  }
  const light = normalizePalette(raw.light);
  const dark = normalizePalette(raw.dark);
  if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
    // Nothing to apply — treat as invalid so the loader skips it.
    return null;
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id;
  const css = typeof raw.css === 'string' && raw.css.trim().length > 0 ? raw.css : undefined;
  return { id, name, light, dark, ...(css ? { css } : {}) };
}

/** CSS-escape a single-quoted attribute value (id is already slug-safe, but be
 *  defensive against quotes/backslashes ever reaching here). */
function escapeAttrValue(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function declarations(palette: Palette): string {
  return PALETTE_KEY_LIST.filter((key) => palette[key] !== undefined)
    .map((key) => `  ${PALETTE_KEYS[key]}: ${palette[key]};`)
    .join('\n');
}

/**
 * Render a plugin to the CSS the app injects: an unscoped light block plus a
 * `[data-theme='dark']` block (which wins by specificity, exactly like the
 * built-in schemes in the old styles/themes.css), then the verbatim `css`.
 */
export function themePluginToCss(plugin: ThemePlugin): string {
  const attr = escapeAttrValue(plugin.id);
  const blocks: string[] = [];
  const light = declarations(plugin.light);
  if (light) {
    blocks.push(`:root[data-color-scheme='${attr}'] {\n${light}\n}`);
  }
  const dark = declarations(plugin.dark);
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
