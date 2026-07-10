/**
 * Single source of truth for "is the app dark right now" — derived from the
 * settings store's `theme` plus the OS media query when `theme === 'system'`.
 * main.tsx uses this to drive `data-theme` on <html>; the split-mode preview
 * pane (M4) uses it too, since mermaid bakes colors in at render time and
 * needs an explicit boolean rather than a CSS variable.
 */

import { settingsStore } from './stores/settings';

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

export function isDark(): boolean {
  const { theme } = settingsStore.getState().settings;
  return theme === 'dark' || (theme === 'system' && prefersDark.matches);
}

/** Fires only on an actual light/dark flip (setting change or OS change while on 'system'). */
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
  prefersDark.addEventListener('change', check);
  return () => {
    unsubscribeSettings();
    prefersDark.removeEventListener('change', check);
  };
}
