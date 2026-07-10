import { afterEach, describe, expect, test, vi } from 'vitest';

// The path plugin is not available under Vitest; stub it with a POSIX join and
// a fixed appDataDir so the resolution logic is what's under test.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/app-data',
  join: async (...parts: string[]) => parts.join('/'),
}));

import { resolvePaths } from '../paths';
import { DEFAULT_SETTINGS } from '../../core/settings';

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolvePaths', () => {
  test('defaults notesDir under appDataDir when settings has no override', async () => {
    const paths = await resolvePaths(DEFAULT_SETTINGS);
    expect(paths).toEqual({ notesDir: '/app-data/notes', sessionDir: '/app-data/session' });
  });

  test('honors a notesDir override but never the sessionDir', async () => {
    const paths = await resolvePaths({ ...DEFAULT_SETTINGS, notesDir: 'D:/MyNotes' });
    expect(paths.notesDir).toBe('D:/MyNotes');
    expect(paths.sessionDir).toBe('/app-data/session');
  });
});
