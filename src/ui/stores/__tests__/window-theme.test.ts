/**
 * The two edges of a window-only theme: what leaves the window (save +
 * broadcast) and what a sibling window's settings do to it.
 */
import { describe, expect, test } from 'vitest';
import {
  mergeIncomingSettings,
  sharedSettings,
  themeSelectionOf,
  windowThemeStore,
  type WindowThemeOverride,
} from '../window-theme';
import { DEFAULT_SETTINGS } from '../../../core/settings';
import type { Settings } from '../../../core/types';

const settingsWith = (theme: Settings['theme'], colorScheme: string, fontSize = 14): Settings => ({
  ...DEFAULT_SETTINGS,
  theme,
  colorScheme,
  fontSize,
});

const PINNED: WindowThemeOverride = {
  local: { theme: 'system', colorScheme: 'vantablack' },
  shared: { theme: 'system', colorScheme: 'light-green' },
};

describe('sharedSettings', () => {
  test('passes settings through untouched with no pin', () => {
    const s = settingsWith('system', 'vantablack');
    expect(sharedSettings(s, null)).toBe(s);
  });

  test('swaps the pinned theme back for the shared one', () => {
    const s = settingsWith('system', 'vantablack', 18);
    const out = sharedSettings(s, PINNED);
    expect(out.colorScheme).toBe('light-green');
    // Everything else still travels — only the theme is window-local.
    expect(out.fontSize).toBe(18);
  });

  test('restores a forced appearance mode too, not just the palette', () => {
    const override: WindowThemeOverride = {
      local: { theme: 'system', colorScheme: 'vantablack' },
      shared: { theme: 'dark', colorScheme: 'default' },
    };
    expect(sharedSettings(settingsWith('system', 'vantablack'), override)).toMatchObject({
      theme: 'dark',
      colorScheme: 'default',
    });
  });
});

describe('mergeIncomingSettings', () => {
  test('takes a sibling window wholesale with no pin', () => {
    const incoming = settingsWith('system', 'my-theme');
    expect(mergeIncomingSettings(incoming, null)).toEqual({ settings: incoming, override: null });
  });

  test('keeps the pinned theme but takes every other field', () => {
    const { settings } = mergeIncomingSettings(settingsWith('system', 'my-theme', 20), PINNED);
    expect(settings.colorScheme).toBe('vantablack');
    expect(settings.fontSize).toBe(20);
  });

  test('the echo of our own broadcast cannot undo the pin', () => {
    // persistSettingsDebounced emits the SHARED settings, which come back here.
    const echo = sharedSettings(settingsWith('system', 'vantablack'), PINNED);
    const merged = mergeIncomingSettings(echo, PINNED);
    expect(merged.settings.colorScheme).toBe('vantablack');
    expect(merged.override).toBe(PINNED); // unchanged shared → same object
  });

  test('remembers the new shared theme so unpinning lands on it', () => {
    const merged = mergeIncomingSettings(settingsWith('system', 'my-theme'), PINNED);
    expect(merged.override?.shared).toEqual({ theme: 'system', colorScheme: 'my-theme' });
    expect(merged.override?.local).toEqual(PINNED.local);
  });
});

describe('windowThemeStore', () => {
  test('starts unpinned and round-trips an override', () => {
    expect(windowThemeStore.getState().override).toBeNull();
    windowThemeStore.getState().set(PINNED);
    expect(windowThemeStore.getState().override).toEqual(PINNED);
    windowThemeStore.getState().set(null);
    expect(windowThemeStore.getState().override).toBeNull();
  });
});

describe('themeSelectionOf', () => {
  test('picks out just the theme pair', () => {
    expect(themeSelectionOf(settingsWith('dark', 'my-theme'))).toEqual({
      theme: 'dark',
      colorScheme: 'my-theme',
    });
  });
});
