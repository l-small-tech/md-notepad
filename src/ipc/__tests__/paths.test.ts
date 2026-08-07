import { afterEach, describe, expect, test, vi } from 'vitest';

// The path plugin is not available under Vitest; stub it with a POSIX join and
// a fixed appDataDir so the resolution logic is what's under test.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app-data',
  join: async (...parts: string[]) => parts.join('/'),
}));

import { resolvePaths, resolveScanDebugDir } from '../paths';
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

describe('resolveScanDebugDir', () => {
  // Always app-owned local storage, never the (possibly cloud-synced) workspace
  // — a dump is tens of megabytes of throwaway rasters.
  test('sits under the internal app data dir on desktop', async () => {
    expect(await resolveScanDebugDir('desktop')).toBe('/app-data/scan-debug');
  });

  test('uses the external files dir on android so a file manager can reach it', async () => {
    vi.spyOn(ipc, 'externalFilesDir').mockResolvedValue('/ext/files');
    expect(await resolveScanDebugDir('android')).toBe('/ext/files/scan-debug');
  });

  test('falls back to internal storage when the external dir is unavailable', async () => {
    vi.spyOn(ipc, 'externalFilesDir').mockRejectedValue(new Error('no plugin'));
    expect(await resolveScanDebugDir('android')).toBe('/app-data/scan-debug');
  });
});
