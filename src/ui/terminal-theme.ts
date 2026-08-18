/**
 * The bridge between the app's theme and the terminal renderer.
 *
 * A theme's colors are hex strings, because that is what a human edits; the
 * renderer takes 0xRRGGBB numbers, because that is what a repaint can afford.
 * This module is the one conversion, memoized per (plugin, mode) — a
 * `ThemePlugin` is immutable and shared, so the palette is built once no
 * matter how many panes ask for it.
 *
 * The renderer never touches the DOM: the palette is resolved here and handed
 * to `view.setTheme`. The font is the one thing genuinely read from the DOM,
 * because `--font-mono` and `--editor-font-size` are what the rest of the app
 * already uses — so the existing "Editor font" setting and mod+=/-/0 drive
 * terminal cells for free.
 */

import { parseColor } from '../core/color';
import { terminalColorsFor, type TerminalColors } from '../core/terminal-palette';
import type { ThemePlugin } from '../core/theme-plugins';
import { DEFAULT_FONT, type FontSpec, type TerminalTheme } from '../renderer';
import { themeRegistryStore } from './stores/theme-registry';
import { settingsStore } from './stores/settings';
import { isDark } from './theme';

function rgb(value: string, fallback: number): number {
  return parseColor(value) ?? fallback;
}

/** Hex palette → the renderer's numeric one. */
export function terminalThemeFrom(colors: TerminalColors): TerminalTheme {
  const background = rgb(colors.background, 0x000000);
  const foreground = rgb(colors.foreground, 0xffffff);
  return {
    background,
    foreground,
    cursor: rgb(colors.cursor, foreground),
    cursorText: colors.cursorText === null ? null : rgb(colors.cursorText, background),
    selection: rgb(colors.selection, background),
    selectionText: colors.selectionText === null ? null : rgb(colors.selectionText, foreground),
    ansi: Array.from({ length: 16 }, (_, i) => rgb(colors.ansi[i] ?? '', foreground)),
  };
}

/** Memo per plugin object; the no-plugin case is keyed by mode separately. */
const cache = new WeakMap<ThemePlugin, Partial<Record<'light' | 'dark', TerminalTheme>>>();
const baseCache: Partial<Record<'light' | 'dark', TerminalTheme>> = {};

/** The renderer palette for one theme. Memoized. */
export function terminalThemeFor(plugin: ThemePlugin | null, dark: boolean): TerminalTheme {
  const key = dark ? 'dark' : 'light';
  if (!plugin) {
    return (baseCache[key] ??= terminalThemeFrom(terminalColorsFor(null, dark)));
  }
  let modes = cache.get(plugin);
  if (!modes) {
    modes = {};
    cache.set(plugin, modes);
  }
  return (modes[key] ??= terminalThemeFrom(terminalColorsFor(plugin, dark)));
}

/**
 * The palette for the theme that is selected RIGHT NOW.
 *
 * Keyed off `isDark()` rather than the `theme` setting: `normalizeSettings`
 * rewrites `theme` to 'system' whenever a plugin color scheme is active, so
 * the setting alone cannot tell light from dark. `isDark()` consults the
 * theme registry first and is the same answer the DOM is painted with.
 */
export function currentTerminalTheme(): TerminalTheme {
  const { colorScheme } = settingsStore.getState().settings;
  const plugin = themeRegistryStore.getState().plugins.find((p) => p.id === colorScheme) ?? null;
  return terminalThemeFor(plugin, isDark());
}

/** The cell font, from the CSS variables `applyDomSettings` maintains. */
export function currentFont(): FontSpec {
  if (typeof document === 'undefined') {
    return DEFAULT_FONT;
  }
  const style = getComputedStyle(document.documentElement);
  const family = style.getPropertyValue('--font-mono').trim();
  const size = Number.parseFloat(style.getPropertyValue('--editor-font-size'));
  return {
    family: family || DEFAULT_FONT.family,
    size: Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT.size,
    lineHeight: DEFAULT_FONT.lineHeight,
  };
}

/**
 * The console SURFACE for one theme: what the pane paints behind the cells.
 *
 * The renderer leaves default-background cells fully transparent (see
 * renderer/README.md), so this layer is what the user actually sees as "the
 * terminal background" — and why an image or a translucent background is a
 * CSS concern here rather than a renderer one.
 */
export interface ConsoleSurface {
  /** The palette's background color, as a CSS color string. */
  background: string;
  /** `data:` URL of the theme's background image, or null. */
  imageUrl: string | null;
  /** Opacity of the whole layer (color and image alike); 1 = opaque. */
  opacity: number;
}

/** The surface for the theme selected right now. */
export function currentConsoleSurface(): ConsoleSurface {
  const { colorScheme } = settingsStore.getState().settings;
  const plugin = themeRegistryStore.getState().plugins.find((p) => p.id === colorScheme) ?? null;
  return consoleSurfaceFor(plugin, isDark());
}

/** The surface for one theme (null = the app's built-in palette). */
export function consoleSurfaceFor(plugin: ThemePlugin | null, dark: boolean): ConsoleSurface {
  const colors = terminalColorsFor(plugin, dark);
  const surface = plugin?.consoleBackground;
  return {
    background: colors.background,
    imageUrl: surface?.imageUrl ?? null,
    opacity: surface?.opacity ?? 1,
  };
}
