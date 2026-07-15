/**
 * Theme-registry store — the loaded pluggable themes (see ipc/theme-loader.ts).
 *
 * Holds the validated `ThemePlugin[]` plus the resolved themes folder. `load`
 * runs once at boot (before React mounts); `reload` re-reads the folder for the
 * Settings "Reload themes" button and after "New theme…". main.tsx subscribes to
 * this store and (re)injects the `<style>` element on every change, exactly the
 * way it subscribes to the settings store for `data-*` attributes — so the store
 * itself stays DOM-free.
 *
 * The built-in `default` scheme is NOT a plugin (it's base.css); the unified
 * Theme picker represents it via the System/Light/Dark modes (see
 * `APPEARANCE_MODES` / `themePluginOptions`). An unknown/deleted `colorScheme`
 * id simply matches no injected block and falls through to the default palette
 * — no guard needed.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ThemePlugin } from '../../core/theme-plugins';
import { loadThemePlugins } from '../../ipc/theme-loader';

export interface ThemeOption {
  value: string;
  label: string;
}

export interface ThemeRegistryState {
  plugins: ThemePlugin[];
  themesDir: string | null;
  /** Boot load: remember the folder, read + validate every theme. */
  load: (themesDir: string) => Promise<void>;
  /** Re-read the folder (Settings "Reload themes"); no-op before `load`. */
  reload: () => Promise<void>;
}

export const themeRegistryStore = createStore<ThemeRegistryState>()((set, get) => ({
  plugins: [],
  themesDir: null,
  load: async (themesDir) => {
    set({ themesDir });
    set({ plugins: await loadThemePlugins(themesDir) });
  },
  reload: async () => {
    const { themesDir } = get();
    if (themesDir === null) {
      return;
    }
    set({ plugins: await loadThemePlugins(themesDir) });
  },
}));

export const useThemeRegistry = <T>(selector: (s: ThemeRegistryState) => T): T =>
  useStore(themeRegistryStore, selector);

/**
 * The unified Theme picker (SettingsDialog) is one dropdown. Selecting a mode
 * uses the default palette (`colorScheme = 'default'`); selecting a plugin uses
 * that scheme and follows the OS light/dark (`theme = 'system'`). See
 * `themePickerGroups` for the on-screen ordering.
 */
export const APPEARANCE_MODES: ThemeOption[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const RESERVED_IDS = new Set(APPEARANCE_MODES.map((m) => m.value));

/** Built-in green themes, headed up with `System` because the default palette
 *  (base.css) is itself green-tinted — so these are the "system default" family.
 *  Order here is the on-screen order: Light Green, then Dark Green. */
export const GREEN_THEME_IDS: readonly string[] = ['light-green', 'dark-green'];

/** Plugin options for the Theme picker; skips ids that collide with the
 *  built-in system/light/dark modes (they'd be unreachable in the dropdown). */
export function themePluginOptions(plugins: readonly ThemePlugin[]): ThemeOption[] {
  return plugins
    .filter((p) => !RESERVED_IDS.has(p.id))
    .map((p) => ({ value: p.id, label: p.name }));
}

/**
 * Partitioned option groups for the Theme picker, top → bottom, rendered with a
 * divider between groups:
 *   1. `System` + the green themes (the green-tinted system defaults)
 *   2. every other plugin (Solarized, Nord, …), in folder order
 *   3. the plain `Light` / `Dark` forced modes
 * Empty groups are dropped so no stray divider is drawn.
 */
export function themePickerGroups(plugins: readonly ThemePlugin[]): ThemeOption[][] {
  const pluginOptions = themePluginOptions(plugins);
  const byId = new Map(pluginOptions.map((o) => [o.value, o]));
  const green = GREEN_THEME_IDS.map((id) => byId.get(id)).filter(
    (o): o is ThemeOption => o !== undefined,
  );
  const others = pluginOptions.filter((o) => !GREEN_THEME_IDS.includes(o.value));
  const system = APPEARANCE_MODES.filter((m) => m.value === 'system');
  const forced = APPEARANCE_MODES.filter((m) => m.value !== 'system');
  return [[...system, ...green], others, forced].filter((group) => group.length > 0);
}

/** True when `value` selects a built-in light/dark mode (vs a plugin id). */
export function isAppearanceMode(value: string): value is 'system' | 'light' | 'dark' {
  return RESERVED_IDS.has(value);
}
