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
  plugin('nord-light', 'Nord Light'),
  plugin('monokai', 'Monokai'),
  plugin('my-theme', 'My Theme'),
];

describe('exportThemeGroups', () => {
  test('labeled Light / Dark / Custom groups, seed order first — no System entry', () => {
    const groups = exportThemeGroups(PLUGINS);
    expect(groups.map((g) => g.label)).toEqual(['Light', 'Dark', 'Custom']);
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['light-green', 'nord-light']);
    expect(groups[1]!.options.map((o) => o.value)).toEqual(['dark-green', 'monokai']);
    expect(groups[2]!.options.map((o) => o.value)).toEqual(['my-theme']);
    expect(groups.some((g) => g.options.some((o) => o.value === 'system'))).toBe(false);
  });

  test('reserved ids are filtered; empty groups are dropped', () => {
    const groups = exportThemeGroups([plugin('monokai'), plugin('dark')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Dark');
    expect(groups[0]!.options.map((o) => o.value)).toEqual(['monokai']);
    expect(exportThemeGroups([])).toEqual([]);
  });

  test('mirrors themePickerGroups minus the System entry', () => {
    const picker = themePickerGroups(PLUGINS).flatMap((g) => g.options);
    const exportable = exportThemeGroups(PLUGINS).flatMap((g) => g.options);
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
