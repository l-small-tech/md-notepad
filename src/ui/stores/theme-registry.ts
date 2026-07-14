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
 * The built-in `default` scheme is NOT a plugin (it's base.css); the dropdown
 * helper prepends it. An unknown/deleted `colorScheme` id simply matches no
 * injected block and falls through to the default palette — no guard needed.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ThemePlugin } from '../../core/theme-plugins';
import { DEFAULT_COLOR_SCHEME } from '../../core/types';
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

/** Dropdown options: the built-in Default first, then each loaded plugin. */
export function themeOptions(plugins: readonly ThemePlugin[]): ThemeOption[] {
  return [
    { value: DEFAULT_COLOR_SCHEME, label: 'Default' },
    ...plugins.map((p) => ({ value: p.id, label: p.name })),
  ];
}
