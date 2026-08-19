import { describe, expect, test } from 'vitest';
import {
  AI_TUI_AGENTS,
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA,
  MAX_EXPLORER_PATHS,
  normalizePathList,
  normalizeSettings,
  pickUnusedColor,
  resolveTerminalProfile,
} from '../settings';
import { AI_THEME_PROFILE_ID, AI_TUI_PROFILE_ID } from '../types';
import {
  CURSOR_STYLES,
  EDITOR_FONT_IDS,
  TERMINAL_BELLS,
  UI_FONT_IDS,
  WORKSPACE_COLORS,
} from '../types';

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
      aiTuiAgent: 'chatgpt',
      // Light/Dark is a meaningful override only on the built-in default palette;
      // a plugin scheme is exercised by the merged-model test below.
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      lineNumbers: true,
      ligatures: false,
      readerMargins: 'wide',
      smoothScrolling: false,
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      previewTabs: false,
      groupTabsByWorkspace: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
      scanPreset: 'balanced',
      scanSmoothing: 'precise',
      schemaVersion: SETTINGS_SCHEMA,
    });
    expect(settings).toEqual({
      notesDir: 'D:/notes',
      aiTuiAgent: 'chatgpt',
      theme: 'dark',
      colorScheme: 'default',
      fontSize: 16,
      editorFont: 'jetbrains-mono',
      uiFont: 'inter',
      defaultMode: 'split',
      wordWrap: false,
      lineNumbers: true,
      ligatures: false,
      readerMargins: 'wide',
      smoothScrolling: false,
      cursorStyle: 'underscore',
      confirmFileMove: false,
      liveSave: true,
      previewTabs: false,
      groupTabsByWorkspace: false,
      workspaces: [{ name: 'Work', path: 'D:/work-notes', color: 'teal' }],
      defaultWorkspaceColor: 'blue',
      imagePasteLocation: 'workspaceRoot',
      imageFolderName: 'assets',
      explorerCollapsedWorkspaces: [],
      explorerExpandedDirs: [],
      scanPreset: 'balanced',
      scanSmoothing: 'precise',
      schemaVersion: SETTINGS_SCHEMA,
      // Not supplied above, so every terminal field comes back at its default.
      terminalProfiles: DEFAULT_SETTINGS.terminalProfiles,
      defaultTerminalProfile: 'shell',
      terminalShell: '',
      terminalFont: 'fira-code',
      terminalScrollback: 10_000,
      terminalScrollLines: 3,
      terminalCursorStyle: 'block',
      terminalCursorBlink: true,
      terminalBell: 'cursor',
      terminalCopyOnSelect: false,
      terminalConfirmMultilinePaste: true,
      terminalAllowOscClipboard: false,
      terminalAltSendsEscape: true,
      terminalBackspaceSendsDelete: true,
      terminalOnExit: 'close',
      terminalConfirmCloseRunning: true,
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
      lineNumbers: 'on',
      ligatures: 1,
      readerMargins: 'huge',
      smoothScrolling: 'yes',
      cursorStyle: 'beam',
      confirmFileMove: 'sure',
      liveSave: 'always',
      previewTabs: 'maybe',
      workspaces: 'not-a-list',
      defaultWorkspaceColor: 'mauve',
      imagePasteLocation: 'wherever',
      imageFolderName: 42,
      scanPreset: 'ultra',
      scanSmoothing: 'extreme',
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test('scan prefs round-trip and reject unknown values', () => {
    expect(normalizeSettings({ scanPreset: 'fast', scanSmoothing: 'simplified' })).toMatchObject({
      scanPreset: 'fast',
      scanSmoothing: 'simplified',
    });
    expect(normalizeSettings({ scanPreset: 3600, scanSmoothing: 2 })).toMatchObject({
      scanPreset: DEFAULT_SETTINGS.scanPreset,
      scanSmoothing: DEFAULT_SETTINGS.scanSmoothing,
    });
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

  test('every bell mode is accepted; anything else defaults to the cursor bell', () => {
    for (const bell of TERMINAL_BELLS) {
      // Stamped with the current schema, so the 'visual' migration below is
      // out of the way and this is validation only.
      expect(
        normalizeSettings({ terminalBell: bell, schemaVersion: SETTINGS_SCHEMA }).terminalBell,
      ).toBe(bell);
    }
    // Including 'audible': there is no such mode, and a settings file that asks
    // for one must not silently become a flashing pane.
    expect(normalizeSettings({ terminalBell: 'audible' }).terminalBell).toBe('cursor');
  });

  test('a pre-versioning "visual" bell upgrades to the cursor bell, once', () => {
    // The old dialog had one checkbox: 'visual' meant "a bell at all", never a
    // preference for the flash — so an unversioned file upgrades.
    expect(normalizeSettings({ terminalBell: 'visual' }).terminalBell).toBe('cursor');
    expect(normalizeSettings({ terminalBell: 'off' }).terminalBell).toBe('off');
    // Once stamped, a deliberate pick of the flash survives every later load.
    const chosen = normalizeSettings({ terminalBell: 'visual', schemaVersion: SETTINGS_SCHEMA });
    expect(chosen.terminalBell).toBe('visual');
    expect(normalizeSettings(chosen).terminalBell).toBe('visual');
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

describe('terminal profiles: the schema-2 migration', () => {
  const stockClaude = { id: 'claude', name: 'Claude Code', program: 'claude', args: [], env: {} };
  const stockShell = { id: 'shell', name: 'System shell', args: [], env: {} };

  test('a pre-2 file loses the stock Claude Code profile and gains the new shell name', () => {
    const s = normalizeSettings({
      schemaVersion: 1,
      terminalProfiles: [stockShell, stockClaude],
      defaultTerminalProfile: 'claude',
    });
    expect(s.terminalProfiles).toEqual([{ id: 'shell', name: 'Shell', args: [], env: {} }]);
    // Its default pointed at the profile that just went away.
    expect(s.defaultTerminalProfile).toBe('shell');
    expect(s.schemaVersion).toBe(2);
  });

  test('a claude profile the user configured is a real choice and survives', () => {
    const configured = { ...stockClaude, args: ['--resume'] };
    const s = normalizeSettings({ schemaVersion: 1, terminalProfiles: [stockShell, configured] });
    expect(s.terminalProfiles.map((p) => p.id)).toEqual(['shell', 'claude']);
    // A renamed shell is a choice too — only the stock string is rewritten.
    const renamed = normalizeSettings({
      schemaVersion: 1,
      terminalProfiles: [{ ...stockShell, name: 'My shell' }],
    });
    expect(renamed.terminalProfiles[0]!.name).toBe('My shell');
  });

  test('a file already at schema 2 is left alone — a re-added claude profile stays', () => {
    const s = normalizeSettings({
      schemaVersion: 2,
      terminalProfiles: [{ id: 'shell', name: 'Shell', args: [], env: {} }, stockClaude],
    });
    expect(s.terminalProfiles.map((p) => p.id)).toEqual(['shell', 'claude']);
  });

  test('migrating away every profile falls back to the defaults, never an empty list', () => {
    const s = normalizeSettings({ schemaVersion: 0, terminalProfiles: [stockClaude] });
    expect(s.terminalProfiles).toEqual(DEFAULT_SETTINGS.terminalProfiles);
  });
});

describe('the AI TUI virtual profile', () => {
  test('the agent setting defaults to claude and rejects unknown values', () => {
    expect(DEFAULT_SETTINGS.aiTuiAgent).toBe('claude');
    expect(normalizeSettings({ aiTuiAgent: 'chatgpt' }).aiTuiAgent).toBe('chatgpt');
    expect(normalizeSettings({ aiTuiAgent: 'skynet' }).aiTuiAgent).toBe('claude');
  });

  test('ai-tui resolves to the configured agent command', () => {
    const claude = resolveTerminalProfile(DEFAULT_SETTINGS, AI_TUI_PROFILE_ID);
    expect(claude).toMatchObject({ name: 'Claude', program: 'claude' });
    const chatgpt = resolveTerminalProfile(
      { ...DEFAULT_SETTINGS, aiTuiAgent: 'chatgpt' },
      AI_TUI_PROFILE_ID,
    );
    expect(chatgpt).toMatchObject({
      name: AI_TUI_AGENTS.chatgpt.name,
      program: AI_TUI_AGENTS.chatgpt.program,
    });
  });

  test('resolution is identity-stable per agent (TerminalPane contract)', () => {
    expect(resolveTerminalProfile(DEFAULT_SETTINGS, AI_TUI_PROFILE_ID)).toBe(
      resolveTerminalProfile(DEFAULT_SETTINGS, AI_TUI_PROFILE_ID),
    );
  });

  test('ai-theme resolves to the agent with its opening prompt; claude pinned to haiku', () => {
    const claude = resolveTerminalProfile(DEFAULT_SETTINGS, AI_THEME_PROFILE_ID);
    expect(claude.program).toBe('claude');
    expect(claude.name).toBe('AI theme');
    expect(claude.args.slice(0, 2)).toEqual(['--model', 'haiku']);
    expect(claude.args[2]).toMatch(/AGENTS\.md/);
    const chatgpt = resolveTerminalProfile(
      { ...DEFAULT_SETTINGS, aiTuiAgent: 'chatgpt' },
      AI_THEME_PROFILE_ID,
    );
    expect(chatgpt.program).toBe('codex');
    expect(chatgpt.args).toHaveLength(1);
    expect(chatgpt.args[0]).toMatch(/AGENTS\.md/);
  });

  test('a real profile with the ai-tui id shadows the virtual one', () => {
    const shadow = { id: AI_TUI_PROFILE_ID, name: 'Mine', program: 'aider', args: [], env: {} };
    const s = {
      ...DEFAULT_SETTINGS,
      terminalProfiles: [...DEFAULT_SETTINGS.terminalProfiles, shadow],
    };
    expect(resolveTerminalProfile(s, AI_TUI_PROFILE_ID)).toBe(shadow);
  });
});
