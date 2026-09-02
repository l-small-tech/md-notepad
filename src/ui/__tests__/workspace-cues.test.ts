/**
 * Which workspace a tab wears: files by their path, terminals by the folder
 * their shell is standing in, notes by definition.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The module graph behind the session facade reaches the Tauri plugins; only
// the resolved notes dir matters here.
const defaultWorkspacePath = vi.fn<() => string | null>(() => '/home/u/notes');
vi.mock('../session', () => ({
  getDefaultWorkspacePath: () => defaultWorkspacePath(),
}));

import { DEFAULT_SETTINGS } from '../../core/settings';
import { settingsStore } from '../stores/settings';
import { cuePathFor, workspaceCueFor, workspaceRoots } from '../workspace-cues';

beforeEach(() => {
  defaultWorkspacePath.mockReturnValue('/home/u/notes');
  settingsStore.getState().replace({
    ...DEFAULT_SETTINGS,
    defaultWorkspaceColor: 'green',
    workspaces: [{ name: 'proj', path: '/home/u/proj', color: 'blue' }],
  });
});

describe('workspaceRoots', () => {
  test('notes dir first, then the added workspaces', () => {
    expect(workspaceRoots()).toEqual([
      { path: '/home/u/notes', color: 'green' },
      { path: '/home/u/proj', color: 'blue' },
    ]);
  });
});

describe('cuePathFor', () => {
  test("a terminal is placed by its shell's cwd, everything else by its file", () => {
    expect(
      cuePathFor({ kind: 'terminal', notePath: null, filePath: null, terminalCwd: '/x' }),
    ).toBe('/x');
    expect(cuePathFor({ kind: 'terminal', notePath: null, filePath: null })).toBeNull();
    expect(cuePathFor({ kind: 'file', notePath: null, filePath: '/f.md' })).toBe('/f.md');
    expect(cuePathFor({ kind: 'note', notePath: '/n.md', filePath: null })).toBe('/n.md');
  });
});

describe('workspaceCueFor', () => {
  test('a terminal standing in a workspace wears its color', () => {
    const tab = {
      kind: 'terminal',
      notePath: null,
      filePath: null,
      terminalCwd: '/home/u/proj/src',
    };
    expect(workspaceCueFor(tab)).toEqual({ key: '/home/u/proj', color: 'blue' });
  });

  test('a terminal in the notes dir wears the default workspace color', () => {
    const tab = { kind: 'terminal', notePath: null, filePath: null, terminalCwd: '/home/u/notes' };
    expect(workspaceCueFor(tab)).toEqual({ key: '/home/u/notes', color: 'green' });
  });

  test('a terminal outside every workspace, or with no cwd yet, has no cue', () => {
    expect(
      workspaceCueFor({ kind: 'terminal', notePath: null, filePath: null, terminalCwd: '/tmp' }),
    ).toBeNull();
    expect(
      workspaceCueFor({ kind: 'terminal', notePath: null, filePath: null, terminalCwd: null }),
    ).toBeNull();
    expect(workspaceCueFor({ kind: 'terminal', notePath: null, filePath: null })).toBeNull();
  });

  test('the cue follows a cd: same tab, new cwd, new workspace', () => {
    const base = { kind: 'terminal', notePath: null, filePath: null };
    expect(workspaceCueFor({ ...base, terminalCwd: '/home/u/proj' })?.color).toBe('blue');
    expect(workspaceCueFor({ ...base, terminalCwd: '/home/u/notes/daily' })?.color).toBe('green');
    expect(workspaceCueFor({ ...base, terminalCwd: '/' })).toBeNull();
  });

  test('a file tab is placed by its path; one outside every workspace has none', () => {
    expect(
      workspaceCueFor({ kind: 'file', notePath: null, filePath: '/home/u/proj/README.md' })?.key,
    ).toBe('/home/u/proj');
    expect(workspaceCueFor({ kind: 'file', notePath: null, filePath: '/etc/hosts' })).toBeNull();
  });

  test('a note with no path yet belongs to the default workspace by definition', () => {
    expect(workspaceCueFor({ kind: 'note', notePath: null, filePath: null })).toEqual({
      key: '/home/u/notes',
      color: 'green',
    });
  });

  test('with no workspace at all, a pathless note has no cue either', () => {
    defaultWorkspacePath.mockReturnValue(null);
    settingsStore.getState().replace({ ...DEFAULT_SETTINGS, workspaces: [] });
    expect(workspaceCueFor({ kind: 'note', notePath: null, filePath: null })).toBeNull();
  });
});
