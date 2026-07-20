/**
 * Pure helpers of the theme-registry store (the store itself is a thin loader
 * around ipc/theme-loader, covered there).
 */
import { describe, expect, test } from 'vitest';
import {
  currentThemeValue,
  exportThemeGroups,
  themePickerGroups,
  themeSelectionPatch,
} from '../theme-registry';
import type { ThemePlugin } from '../../../core/theme-plugins';

const plugin = (id: string, name = id): ThemePlugin => ({
  id,
  name,
  light: { bg: '#fff' },
  dark: { bg: '#000' },
});

const PLUGINS = [
  plugin('light-green', 'Light Green'),
  plugin('dark-green', 'Dark Green'),
  plugin('nord', 'Nord'),
  plugin('solarized', 'Solarized'),
];

describe('exportThemeGroups', () => {
  test('greens first, then the other plugins — no System entry', () => {
    const groups = exportThemeGroups(PLUGINS);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.map((o) => o.value)).toEqual(['light-green', 'dark-green']);
    expect(groups[1]!.map((o) => o.value)).toEqual(['nord', 'solarized']);
    expect(groups.flat().some((o) => o.value === 'system')).toBe(false);
  });

  test('reserved ids are filtered; empty groups are dropped', () => {
    const groups = exportThemeGroups([plugin('nord'), plugin('dark')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((o) => o.value)).toEqual(['nord']);
    expect(exportThemeGroups([])).toEqual([]);
  });

  test('mirrors themePickerGroups minus the System entry', () => {
    const picker = themePickerGroups(PLUGINS).flat();
    const exportable = exportThemeGroups(PLUGINS).flat();
    expect(picker.filter((o) => o.value !== 'system')).toEqual(exportable);
  });
});

describe('currentThemeValue / themeSelectionPatch', () => {
  test('the default palette shows its appearance mode; a plugin shows its id', () => {
    expect(currentThemeValue({ theme: 'system', colorScheme: 'default' })).toBe('system');
    expect(currentThemeValue({ theme: 'dark', colorScheme: 'default' })).toBe('dark');
    // A plugin carries both modes, so its id wins over the saved mode.
    expect(currentThemeValue({ theme: 'system', colorScheme: 'nord' })).toBe('nord');
  });

  test('picking a mode returns to the default palette; picking a plugin follows the OS', () => {
    expect(themeSelectionPatch('system')).toEqual({ theme: 'system', colorScheme: 'default' });
    expect(themeSelectionPatch('dark')).toEqual({ theme: 'dark', colorScheme: 'default' });
    expect(themeSelectionPatch('nord')).toEqual({ theme: 'system', colorScheme: 'nord' });
  });

  test('round-trips: applying a patch makes that entry the current one', () => {
    for (const value of ['system', 'dark', 'nord', 'light-green']) {
      expect(currentThemeValue(themeSelectionPatch(value))).toBe(value);
    }
  });
});
