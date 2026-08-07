import { beforeEach, describe, expect, test, vi } from 'vitest';

// The unsaved-board fallback resolves app storage through the path plugin,
// which is not available under Vitest — stub the resolver.
vi.mock('../../ipc/paths', () => ({
  resolveScanDebugDir: async () => '/app-data/scan-debug',
}));
const refreshExplorer = vi.fn();
vi.mock('../stores/ui', () => ({
  uiStore: { getState: () => ({ refreshExplorer }) },
}));

import { createScanDebugSaver } from '../scan-debug';
import { LocalFsProvider } from '../../ipc/provider';

const AT = new Date(2026, 7, 6, 14, 32, 5);
const now = (): Date => AT;

const FILES = [
  { name: '1-source.jpg', kind: 'base64' as const, data: 'AAA' },
  { name: '4-traced.svg', kind: 'text' as const, data: '<svg/>' },
];

let created: string[];
let written: [string, string][];

// `currentProvider()` resolves to LocalFsProvider unless a synced workspace
// is active, so spying on LocalFsProvider covers both code paths here.
beforeEach(() => {
  created = [];
  written = [];
  refreshExplorer.mockClear();
  vi.spyOn(LocalFsProvider, 'createDir').mockImplementation(async (p) => {
    created.push(p);
  });
  vi.spyOn(LocalFsProvider, 'atomicWriteText').mockImplementation(async (p, t) => {
    written.push([p, t]);
  });
  vi.spyOn(LocalFsProvider, 'writeFileBase64').mockImplementation(async (p, d) => {
    written.push([p, d]);
  });
});

describe('createScanDebugSaver', () => {
  test('a saved board dumps BESIDE the board (UAT: where the user is looking)', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    const folder = await save(FILES);

    expect(folder).toBe('D:/MyNotes/scan-debug-2026-08-06-143205');
    expect(created).toEqual(['D:/MyNotes/scan-debug-2026-08-06-143205']);
    // And the explorer refreshes so the new folder is visible.
    expect(refreshExplorer).toHaveBeenCalledTimes(1);
  });

  test('routes each file by kind, keeping the pipeline order', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    await save(FILES);

    expect(written).toEqual([
      ['D:/MyNotes/scan-debug-2026-08-06-143205/1-source.jpg', 'AAA'],
      ['D:/MyNotes/scan-debug-2026-08-06-143205/4-traced.svg', '<svg/>'],
    ]);
  });

  test('an unsaved board falls back to app-local storage', async () => {
    const save = createScanDebugSaver(() => null, now);
    expect(await save(FILES)).toBe('/app-data/scan-debug/scan-2026-08-06-143205');
    expect(created).toHaveLength(1);
    // Nothing to show in the explorer — the dump is outside every workspace.
    expect(refreshExplorer).not.toHaveBeenCalled();
  });

  test('writes nothing when the pipeline produced no artifacts', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    expect(await save([])).toBeNull();
    expect(created).toEqual([]);
    expect(written).toEqual([]);
    expect(refreshExplorer).not.toHaveBeenCalled();
  });
});
