/**
 * Window-local theme override — the "this window only" half of the theme
 * picker.
 *
 * Picking a theme normally changes it everywhere: the settings store is the
 * shared value, main.tsx persists it and mirrors it to the other windows over
 * `settings-changed`. Right-clicking a theme (☰ Menu → Themes) or the Settings
 * dialog's "This window only" box instead pins the choice to THIS webview.
 *
 * The pinned theme still lands in the settings store — every downstream
 * consumer (DOM attributes, terminal palette, export preview, preview pane)
 * reads it from there, and none of them should have to know about the
 * override. What the override changes is the two edges where settings leave or
 * enter the window:
 *
 *   - out: {@link sharedSettings} swaps the pinned theme back to the shared one
 *     before main.tsx saves or broadcasts, so a window-only theme never becomes
 *     everyone's (nor survives a restart);
 *   - in: {@link mergeIncomingSettings} takes everything a sibling window sends
 *     EXCEPT the theme, so this window keeps its pin — including the echo of
 *     our own broadcast, which would otherwise undo it immediately.
 *
 * The override is deliberately not persisted: it lasts as long as the window.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Settings } from '../../core/types';

/** The theme half of the settings — what a picker choice actually changes. */
export interface ThemeSelection {
  theme: Settings['theme'];
  colorScheme: Settings['colorScheme'];
}

/** An active pin: what this window shows, and what the rest of the app uses. */
export interface WindowThemeOverride {
  /** The theme pinned to this window (also live in the settings store). */
  local: ThemeSelection;
  /** The shared theme the other windows keep — restored on `clear`. */
  shared: ThemeSelection;
}

export interface WindowThemeState {
  /** `null` while this window follows the shared, all-windows theme. */
  override: WindowThemeOverride | null;
  set: (override: WindowThemeOverride | null) => void;
}

export const windowThemeStore = createStore<WindowThemeState>()((set) => ({
  override: null,
  set: (override) => set({ override }),
}));

export const useWindowTheme = <T>(selector: (s: WindowThemeState) => T): T =>
  useStore(windowThemeStore, selector);

/** Just the theme fields of a settings object. */
export function themeSelectionOf(settings: Settings): ThemeSelection {
  return { theme: settings.theme, colorScheme: settings.colorScheme };
}

/**
 * What this window may save and broadcast: its settings with the pinned theme
 * swapped back for the shared one. Identity when nothing is pinned.
 */
export function sharedSettings(settings: Settings, override: WindowThemeOverride | null): Settings {
  return override === null ? settings : { ...settings, ...override.shared };
}

/**
 * Fold a sibling window's settings into this one. Everything else is taken as
 * sent; the theme is remembered as the new shared value but not applied while a
 * pin is active. Returns the settings to store plus the override to store with
 * them (unchanged `shared` → the same object, so callers can compare cheaply).
 */
export function mergeIncomingSettings(
  incoming: Settings,
  override: WindowThemeOverride | null,
): { settings: Settings; override: WindowThemeOverride | null } {
  if (override === null) {
    return { settings: incoming, override: null };
  }
  const shared = themeSelectionOf(incoming);
  const changed =
    shared.theme !== override.shared.theme || shared.colorScheme !== override.shared.colorScheme;
  return {
    settings: { ...incoming, ...override.local },
    override: changed ? { ...override, shared } : override,
  };
}
