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
 * The unified Theme picker (SettingsDialog) is one dropdown: the built-in
 * light/dark modes first, then every plugin. Selecting a mode uses the default
 * palette (`colorScheme = 'default'`); selecting a plugin uses that scheme and
 * follows the OS light/dark (`theme = 'system'`).
 */
export const APPEARANCE_MODES: ThemeOption[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const RESERVED_IDS = new Set(APPEARANCE_MODES.map((m) => m.value));

/** Plugin options for the Theme picker; skips ids that collide with the
 *  built-in system/light/dark modes (they'd be unreachable in the dropdown). */
export function themePluginOptions(plugins: readonly ThemePlugin[]): ThemeOption[] {
  return plugins
    .filter((p) => !RESERVED_IDS.has(p.id))
    .map((p) => ({ value: p.id, label: p.name }));
}

/** True when `value` selects a built-in light/dark mode (vs a plugin id). */
export function isAppearanceMode(value: string): value is 'system' | 'light' | 'dark' {
  return RESERVED_IDS.has(value);
}
