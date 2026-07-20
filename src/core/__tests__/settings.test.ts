import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_EXPLORER_PATHS,
  normalizePathList,
  normalizeSettings,
  pickUnusedColor,
} from '../settings';
import { CURSOR_STYLES, EDITOR_FONT_IDS, UI_FONT_IDS, WORKSPACE_COLORS } from '../types';

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
      // Light/Dark is a meaningful override only on the built-in default palette;
      // a plugin scheme is exercised by the merged-model test below.
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      ligatures: false,
      readerMargins: 'wide',
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      previewTabs: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
    });
    expect(settings).toEqual({
      notesDir: 'D:/notes',
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      ligatures: false,
      readerMargins: 'wide',
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      previewTabs: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
      explorerCollapsedWorkspaces: [],
      explorerExpandedDirs: [],
    });
  });

  test('a plugin colorScheme forces theme to system (merged Theme picker)', () => {
    // The unified Theme picker makes a plugin scheme always follow the OS
    // light/dark, so a legacy `theme: 'light'|'dark'` paired with a plugin is
    // coerced back to 'system'. The plugin id itself passes through.
    expect(normalizeSettings({ theme: 'dark', colorScheme: 'nord' })).toMatchObject({
      theme: 'system',
      colorScheme: 'nord',
    });
    // On the default palette, a forced light/dark is preserved.
    expect(normalizeSettings({ theme: 'dark', colorScheme: 'default' })).toMatchObject({
      theme: 'dark',
      colorScheme: 'default',
    });
  });

  test('each invalid field independently falls back to its default', () => {
    const settings = normalizeSettings({
      notesDir: 123,
      theme: 'sepia',
      // colorScheme accepts any non-empty string now (pluggable themes), so an
      // "invalid" value here is a non-string that must fall back to the default.
      colorScheme: 42,
      fontSize: 'big',
      editorFont: 'comic-sans',
      uiFont: 'papyrus',
      defaultMode: 'zen',
      wordWrap: 'yes',
      ligatures: 1,
      readerMargins: 'huge',
      cursorStyle: 'beam',
      confirmFileMove: 'sure',
      liveSave: 'always',
      previewTabs: 'maybe',
      workspaces: 'not-a-list',
      defaultWorkspaceColor: 'mauve',
      imagePasteLocation: 'wherever',
      imageFolderName: 42,
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test('workspaces keeps well-formed entries and drops malformed ones', () => {
    const settings = normalizeSettings({
      workspaces: [
        { name: 'Work', path: 'D:/work', color: 'red' },
        { name: '   ', path: 'D:/unnamed' }, // blank name falls back to path
        { name: 'no path' },
        { path: '' },
        'garbage',
        null,
      ],
    });
    expect(settings.workspaces).toEqual([
      { name: 'Work', path: 'D:/work', color: 'red' },
      { name: 'D:/unnamed', path: 'D:/unnamed', color: null },
    ]);
  });

  test('pickUnusedColor prefers the first unused palette color', () => {
    expect(pickUnusedColor([])).toBe(WORKSPACE_COLORS[0]);
    expect(pickUnusedColor(['red', null])).toBe('orange');
    expect(pickUnusedColor(['orange', 'red'])).toBe('yellow');
  });

  test('pickUnusedColor cycles fairly once the palette is exhausted', () => {
    // Every color used once, 'red' used twice → the next least-used in
    // palette order is 'orange'.
    expect(pickUnusedColor([...WORKSPACE_COLORS, 'red'])).toBe('orange');
    // All used equally → back to the first palette color.
    expect(pickUnusedColor([...WORKSPACE_COLORS])).toBe('red');
  });

  test('an unknown workspace color falls back to null', () => {
    const settings = normalizeSettings({
      workspaces: [{ name: 'W', path: 'D:/w', color: '#ff0000' }],
      defaultWorkspaceColor: 42,
    });
    expect(settings.workspaces[0]!.color).toBeNull();
    expect(settings.defaultWorkspaceColor).toBeNull();
  });

  test('empty notesDir string means "use platform default"', () => {
    expect(normalizeSettings({ notesDir: '' }).notesDir).toBeNull();
  });

  test('image paste location accepts the three modes and rejects others', () => {
    for (const loc of ['subfolder', 'sameFolder', 'workspaceRoot'] as const) {
      expect(normalizeSettings({ imagePasteLocation: loc }).imagePasteLocation).toBe(loc);
    }
    expect(normalizeSettings({ imagePasteLocation: 'nope' }).imagePasteLocation).toBe('subfolder');
  });

  test('image folder name trims, and blank/non-string falls back to default', () => {
    expect(normalizeSettings({ imageFolderName: '  assets  ' }).imageFolderName).toBe('assets');
    expect(normalizeSettings({ imageFolderName: '   ' }).imageFolderName).toBe('images');
    expect(normalizeSettings({ imageFolderName: 5 }).imageFolderName).toBe('images');
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

  test('every bundled editor font and ui font id is accepted', () => {
    for (const id of EDITOR_FONT_IDS) {
      expect(normalizeSettings({ editorFont: id }).editorFont).toBe(id);
    }
    for (const id of UI_FONT_IDS) {
      expect(normalizeSettings({ uiFont: id }).uiFont).toBe(id);
    }
    // A font family name (rather than an id) is not accepted — defaults win.
    expect(normalizeSettings({ editorFont: 'Fira Code' }).editorFont).toBe('fira-code');
    expect(normalizeSettings({ uiFont: 'Inter' }).uiFont).toBe('match');
  });

  test('any non-empty string is a valid (pluggable) color scheme id', () => {
    // Themes are now pluggable, so an arbitrary id is accepted and kept — an id
    // with no loaded theme falls back to the default palette at render time.
    for (const scheme of ['default', 'solarized', 'my-custom-theme']) {
      expect(normalizeSettings({ colorScheme: scheme }).colorScheme).toBe(scheme);
    }
    expect(normalizeSettings({ colorScheme: '  spaced  ' }).colorScheme).toBe('spaced');
    // Blank / non-string / missing degrade to the default id.
    expect(normalizeSettings({ colorScheme: '   ' }).colorScheme).toBe('default');
    expect(normalizeSettings({ colorScheme: 42 }).colorScheme).toBe('default');
    expect(normalizeSettings({}).colorScheme).toBe('default');
  });

  test('every reader-margins mode is accepted', () => {
    for (const margins of ['narrow', 'normal', 'wide'] as const) {
      expect(normalizeSettings({ readerMargins: margins }).readerMargins).toBe(margins);
    }
  });

  test('every cursor style is accepted; anything else defaults to bar', () => {
    for (const style of CURSOR_STYLES) {
      expect(normalizeSettings({ cursorStyle: style }).cursorStyle).toBe(style);
    }
    expect(normalizeSettings({ cursorStyle: 'beam' }).cursorStyle).toBe('bar');
  });

  test('unknown extra fields are dropped', () => {
    const settings = normalizeSettings({ legacyField: true, theme: 'light' });
    expect(settings).not.toHaveProperty('legacyField');
    expect(settings.theme).toBe('light');
  });
});

describe('normalizePathList (persisted explorer tree shape)', () => {
  test('drops non-strings and empties, de-duplicates, preserves order', () => {
    expect(normalizePathList(['D:/a', 42, '', 'D:/b', null, 'D:/a'])).toEqual(['D:/a', 'D:/b']);
  });

  test('a non-array (missing/garbage key) yields an empty list', () => {
    expect(normalizePathList(undefined)).toEqual([]);
    expect(normalizePathList('D:/a')).toEqual([]);
  });

  test('keeps the newest entries when over the cap', () => {
    const many = Array.from({ length: MAX_EXPLORER_PATHS + 5 }, (_, i) => `D:/d${i}`);
    const kept = normalizePathList(many);
    expect(kept).toHaveLength(MAX_EXPLORER_PATHS);
    expect(kept.at(-1)).toBe(many.at(-1));
    expect(kept[0]).toBe('D:/d5');
  });

  test('round-trips through normalizeSettings', () => {
    expect(
      normalizeSettings({
        explorerCollapsedWorkspaces: ['D:/work'],
        explorerExpandedDirs: ['D:/work/sub', 7],
      }),
    ).toMatchObject({
      explorerCollapsedWorkspaces: ['D:/work'],
      explorerExpandedDirs: ['D:/work/sub'],
    });
  });
});
