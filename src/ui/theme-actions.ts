/**
 * Theme actions — the side-effecting half of the theme picker, shared by the
 * ☰ menu's Themes submenu (the primary surface) and the Settings dropdown.
 *
 * Kept out of both components so the two can't drift: selecting a theme,
 * revealing the themes folder, seeding a new theme file, reloading the folder,
 * and opening the themes guide all live here. The pure "which entry is
 * current / what does this choice mean" logic stays in stores/theme-registry.
 */

import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { currentProvider } from '../ipc/provider';
import { writeThemeTemplate } from '../ipc/theme-loader';
import { openDocs } from './session';
import { settingsStore } from './stores/settings';
import { themeRegistryStore, themeSelectionPatch } from './stores/theme-registry';
import { themeSelectionOf, windowThemeStore } from './stores/window-theme';

/**
 * Apply a picker choice (appearance mode or plugin id) to the settings.
 *
 * `windowOnly` pins the choice to this window instead of changing it
 * everywhere — the settings store still carries it (every consumer reads the
 * theme from there), but main.tsx neither persists nor broadcasts it, and a
 * sibling window's theme no longer reaches us. See stores/window-theme.
 */
export function selectTheme(value: string, windowOnly = false): void {
  const settings = settingsStore.getState();
  const { override } = windowThemeStore.getState();
  const local = themeSelectionPatch(value);
  if (windowOnly) {
    // While a pin is already active the settings store holds the LOCAL theme,
    // so the shared one to preserve is the override's, not the store's.
    const shared = override?.shared ?? themeSelectionOf(settings.settings);
    windowThemeStore.getState().set({ local, shared });
  } else {
    windowThemeStore.getState().set(null);
  }
  settings.update(local);
}

/** Pin the theme this window currently shows, without changing it. */
export function pinThemeToWindow(): void {
  const current = themeSelectionOf(settingsStore.getState().settings);
  windowThemeStore.getState().set({ local: current, shared: current });
}

/** Drop the pin: follow the shared, all-windows theme again. */
export function unpinThemeFromWindow(): void {
  const { override, set } = windowThemeStore.getState();
  if (!override) {
    return;
  }
  set(null);
  settingsStore.getState().update(override.shared);
}

/** True where the OS file manager can be driven (desktop) — gates "Open folder". */
export function canRevealThemesFolder(): boolean {
  return currentProvider().capabilities.isLocalFs;
}

/** Reveal the themes folder so the user can drop in / edit theme files. */
export async function openThemesFolder(): Promise<void> {
  const { themesDir } = themeRegistryStore.getState();
  if (themesDir) {
    await revealItemInDir(themesDir).catch(() => {});
  }
}

/** Write a starter theme file, reload the registry, select it, and reveal it. */
export async function newTheme(): Promise<void> {
  const { themesDir, plugins, reload } = themeRegistryStore.getState();
  if (!themesDir) {
    return;
  }
  const existing = new Set(plugins.map((p) => p.id));
  const { id, path } = await writeThemeTemplate(themesDir, existing);
  await reload();
  selectTheme(id);
  if (canRevealThemesFolder()) {
    await revealItemInDir(path).catch(() => {});
  }
}

/** Re-read the themes folder after the user edited or added files. */
export async function reloadThemes(): Promise<void> {
  await themeRegistryStore.getState().reload();
}

/** "Help" — open the bundled themes guide (how to author a theme file). */
export function openThemesHelp(): void {
  openDocs('themes.md');
}
