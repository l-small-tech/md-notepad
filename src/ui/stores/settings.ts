/**
 * Settings store — the in-memory source of truth for user preferences.
 *
 * M1 only reads `theme` (to drive `data-theme` on <html>) and `ligatures`
 * (the `no-ligatures` class) and `fontSize` (the `--editor-font-size` CSS
 * variable). Persistence via tauri-plugin-store and the settings dialog
 * arrive in M6; until then the store simply holds DEFAULT_SETTINGS and any
 * runtime overrides. `normalizeSettings` (core) stays the single validation
 * choke point when M6 wires loading.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { DEFAULT_SETTINGS } from '../../core/settings';
import type { Settings } from '../../core/types';

export interface SettingsState {
  settings: Settings;
  /** Merge a partial update (M6's settings dialog calls this per field). */
  update: (partial: Partial<Settings>) => void;
  /** Replace wholesale (M6's load path, after normalizeSettings). */
  replace: (next: Settings) => void;
}

export const settingsStore = createStore<SettingsState>()((set) => ({
  settings: DEFAULT_SETTINGS,
  update: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),
  replace: (next) => set({ settings: next }),
}));

export const useSettingsStore = <T>(selector: (s: SettingsState) => T): T =>
  useStore(settingsStore, selector);
