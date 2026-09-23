import { describe, expect, it } from 'vitest';
import { defaultWorkspaceParent, folderNameError } from '../new-workspace';

describe('folderNameError', () => {
  it('accepts ordinary names', () => {
    expect(folderNameError('Research notes')).toBeNull();
    expect(folderNameError('project-2026.v2')).toBeNull();
    expect(folderNameError('Café')).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(folderNameError('')).toMatch(/name/);
  });

  it('rejects characters a folder cannot hold', () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb']) {
      expect(folderNameError(bad)).not.toBeNull();
    }
  });

  it('rejects dot names and a trailing dot or space', () => {
    expect(folderNameError('.')).not.toBeNull();
    expect(folderNameError('..')).not.toBeNull();
    expect(folderNameError('notes.')).not.toBeNull();
    expect(folderNameError('notes ')).not.toBeNull();
  });

  it('rejects Windows device names, with or without an extension', () => {
    expect(folderNameError('CON')).not.toBeNull();
    expect(folderNameError('nul.txt')).not.toBeNull();
    expect(folderNameError('com1')).not.toBeNull();
    expect(folderNameError('console')).toBeNull();
  });

  it('rejects names over 255 characters', () => {
    expect(folderNameError('a'.repeat(256))).not.toBeNull();
    expect(folderNameError('a'.repeat(255))).toBeNull();
  });
});

describe('defaultWorkspaceParent', () => {
  const none = {
    workspacePaths: [],
    defaultWorkspacePath: null,
    appDataDir: null,
    documentsDir: null,
  };

  it('uses the parent of the most recently added workspace', () => {
    expect(
      defaultWorkspaceParent({
        ...none,
        workspacePaths: ['C:\\Users\\me\\Old\\a', 'D:/Work/projects/b'],
        defaultWorkspacePath: 'C:\\Users\\me\\Notes',
        documentsDir: 'C:\\Users\\me\\Documents',
      }),
    ).toBe('D:/Work/projects');
  });

  it('falls back to a default workspace the user placed themselves', () => {
    expect(
      defaultWorkspaceParent({
        ...none,
        defaultWorkspacePath: 'G:\\My Drive\\Notes',
        appDataDir: 'C:\\Users\\me\\AppData\\Roaming\\app',
        documentsDir: 'C:\\Users\\me\\Documents',
      }),
    ).toBe('G:\\My Drive');
  });

  it('skips a default workspace inside app data, for Documents', () => {
    expect(
      defaultWorkspaceParent({
        ...none,
        defaultWorkspacePath: 'C:\\Users\\me\\AppData\\Roaming\\App\\notes',
        appDataDir: 'c:/users/me/appdata/roaming/app/',
        documentsDir: 'C:\\Users\\me\\Documents',
      }),
    ).toBe('C:\\Users\\me\\Documents');
  });

  it('does not mistake a sibling folder with a shared prefix for app data', () => {
    expect(
      defaultWorkspaceParent({
        ...none,
        defaultWorkspacePath: '/home/me/app-notes/notes',
        appDataDir: '/home/me/app',
      }),
    ).toBe('/home/me/app-notes');
  });

  it('ignores a trailing separator', () => {
    expect(defaultWorkspaceParent({ ...none, workspacePaths: ['/home/me/notes/'] })).toBe(
      '/home/me',
    );
  });

  it('turns a bare drive into its root, and skips a workspace that is a drive root', () => {
    expect(defaultWorkspaceParent({ ...none, workspacePaths: ['D:\\Notes'] })).toBe('D:\\');
    expect(
      defaultWorkspaceParent({ ...none, workspacePaths: ['C:\\'], documentsDir: '/docs' }),
    ).toBe('/docs');
  });

  it('is null with nothing to go on', () => {
    expect(defaultWorkspaceParent(none)).toBeNull();
  });
});
