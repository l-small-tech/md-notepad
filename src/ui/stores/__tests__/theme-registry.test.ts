/**
 * Pure helpers of the theme-registry store (the store itself is a thin loader
 * around ipc/theme-loader, covered there).
 */
import { describe, expect, test } from 'vitest';
import { exportThemeGroups, themePickerGroups } from '../theme-registry';
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
