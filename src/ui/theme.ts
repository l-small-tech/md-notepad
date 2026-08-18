/**
 * Single source of truth for "is the app dark right now" — while a theme
 * plugin is selected, its declared `mode` decides; otherwise it's the settings
 * store's `theme` plus the OS media query when `theme === 'system'`.
 * main.tsx uses this to drive `data-theme` on <html>; the split-mode preview
 * pane (M4) uses it too, since mermaid bakes colors in at render time and
 * needs an explicit boolean rather than a CSS variable.
 */

import { useSyncExternalStore } from 'react';
import { settingsStore } from './stores/settings';
import { themeRegistryStore } from './stores/theme-registry';

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

export function isDark(): boolean {
  const { theme, colorScheme } = settingsStore.getState().settings;
  const plugin = themeRegistryStore.getState().plugins.find((p) => p.id === colorScheme);
  if (plugin) {
    return plugin.mode === 'dark';
  }
  return theme === 'dark' || (theme === 'system' && prefersDark.matches);
}

/** Fires only on an actual light/dark flip (setting change, OS change while on
 *  'system', or a theme reload that changes the selected plugin's mode). */
export function subscribeDark(listener: (dark: boolean) => void): () => void {
  let last = isDark();
  function check(): void {
    const next = isDark();
    if (next !== last) {
      last = next;
      listener(next);
    }
  }
  const unsubscribeSettings = settingsStore.subscribe(check);
  const unsubscribeRegistry = themeRegistryStore.subscribe(check);
  prefersDark.addEventListener('change', check);
  return () => {
    unsubscribeSettings();
    unsubscribeRegistry();
    prefersDark.removeEventListener('change', check);
  };
}

/** React binding for {@link isDark}. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (onChange) => subscribeDark(onChange),
    isDark,
    // Server snapshot: there is no SSR here, but the hook requires one.
    () => false,
  );
}
