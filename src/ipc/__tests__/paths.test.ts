import { afterEach, describe, expect, test, vi } from 'vitest';

// The path plugin is not available under Vitest; stub it with a POSIX join and
// a fixed appDataDir so the resolution logic is what's under test.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app-data',
  join: async (...parts: string[]) => parts.join('/'),
}));

import { resolvePaths } from '../paths';
import { ipc } from '../commands';
import { DEFAULT_SETTINGS } from '../../core/settings';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('resolvePaths', () => {
  test('defaults notesDir under appDataDir when settings has no override', async () => {
    const paths = await resolvePaths(DEFAULT_SETTINGS, 'desktop');
    expect(paths).toEqual({ notesDir: '/app-data/notes', sessionDir: '/app-data/session' });
  });

  test('honors a notesDir override but never the sessionDir', async () => {
    const paths = await resolvePaths({ ...DEFAULT_SETTINGS, notesDir: 'D:/MyNotes' }, 'desktop');
    expect(paths.notesDir).toBe('D:/MyNotes');
    expect(paths.sessionDir).toBe('/app-data/session');
  });

  describe('android', () => {
    test('notesDir uses the external files dir; sessionDir stays internal', async () => {
      vi.spyOn(ipc, 'externalFilesDir').mockResolvedValue(
        '/storage/emulated/0/Android/data/x/files',
      );
      const paths = await resolvePaths(DEFAULT_SETTINGS, 'android');
      expect(paths.notesDir).toBe('/storage/emulated/0/Android/data/x/files/notes');
      expect(paths.sessionDir).toBe('/app-data/session');
    });

    test('falls back to internal notes when external storage is null', async () => {
      vi.spyOn(ipc, 'externalFilesDir').mockResolvedValue(null);
      const paths = await resolvePaths(DEFAULT_SETTINGS, 'android');
      expect(paths.notesDir).toBe('/app-data/notes');
    });

    test('falls back to internal notes when the plugin call rejects', async () => {
      vi.spyOn(ipc, 'externalFilesDir').mockRejectedValue(new Error('no plugin'));
      const paths = await resolvePaths(DEFAULT_SETTINGS, 'android');
      expect(paths.notesDir).toBe('/app-data/notes');
    });

    test('a settings override still wins over the external dir', async () => {
      vi.spyOn(ipc, 'externalFilesDir').mockResolvedValue('/ext/files');
      const paths = await resolvePaths({ ...DEFAULT_SETTINGS, notesDir: '/custom' }, 'android');
      expect(paths.notesDir).toBe('/custom');
    });
  });
});
