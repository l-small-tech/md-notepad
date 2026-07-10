import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../settings';

describe('normalizeSettings', () => {
  test('non-object input yields pure defaults', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  test('valid fields pass through', () => {
    const settings = normalizeSettings({
      notesDir: 'D:/notes',
      theme: 'dark',
      fontSize: 16,
      defaultMode: 'split',
      wordWrap: false,
      ligatures: false,
    });
    expect(settings).toEqual({
      notesDir: 'D:/notes',
      theme: 'dark',
      fontSize: 16,
      defaultMode: 'split',
      wordWrap: false,
      ligatures: false,
    });
  });

  test('each invalid field independently falls back to its default', () => {
    const settings = normalizeSettings({
      notesDir: 123,
      theme: 'sepia',
      fontSize: 'big',
      defaultMode: 'zen',
      wordWrap: 'yes',
      ligatures: 1,
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test('empty notesDir string means "use platform default"', () => {
    expect(normalizeSettings({ notesDir: '' }).notesDir).toBeNull();
  });

  test('every editor mode is accepted as a default, including read', () => {
    for (const mode of ['raw', 'split', 'wysiwyg', 'read'] as const) {
      expect(normalizeSettings({ defaultMode: mode }).defaultMode).toBe(mode);
    }
  });

  test('fontSize is rounded and clamped to a sane range', () => {
    expect(normalizeSettings({ fontSize: 13.6 }).fontSize).toBe(14);
    expect(normalizeSettings({ fontSize: 2 }).fontSize).toBe(8);
    expect(normalizeSettings({ fontSize: 400 }).fontSize).toBe(40);
    expect(normalizeSettings({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  test('unknown extra fields are dropped', () => {
    const settings = normalizeSettings({ legacyField: true, theme: 'light' });
    expect(settings).not.toHaveProperty('legacyField');
    expect(settings.theme).toBe('light');
  });
});
