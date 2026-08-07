import { beforeEach, describe, expect, test, vi } from 'vitest';

// The dump target is app-owned local storage; the path plugin behind
// `resolveScanDebugDir` is not available under Vitest, so stub the resolver.
vi.mock('../../ipc/paths', () => ({
  resolveScanDebugDir: async () => '/app-data/scan-debug',
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

beforeEach(() => {
  created = [];
  written = [];
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
  test('writes into local app storage, not beside the board', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    const folder = await save(FILES);

    expect(folder).toBe('/app-data/scan-debug/board-2026-08-06-143205');
    expect(created).toEqual(['/app-data/scan-debug/board-2026-08-06-143205']);
    // Nothing under the workspace root the board lives in.
    expect(written.every(([p]) => p.startsWith('/app-data/scan-debug/'))).toBe(true);
  });

  test('routes each file by kind, keeping the pipeline order', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    await save(FILES);

    expect(written).toEqual([
      ['/app-data/scan-debug/board-2026-08-06-143205/1-source.jpg', 'AAA'],
      ['/app-data/scan-debug/board-2026-08-06-143205/4-traced.svg', '<svg/>'],
    ]);
  });

  test('a synced (saf://) board still dumps locally', async () => {
    const save = createScanDebugSaver(() => 'saf://tree%3Aabc/notes/board.md', now);
    expect(await save(FILES)).toBe('/app-data/scan-debug/board-2026-08-06-143205');
  });

  test('an unsaved board can be debugged — it just has no name to borrow', async () => {
    const save = createScanDebugSaver(() => null, now);
    expect(await save(FILES)).toBe('/app-data/scan-debug/scan-2026-08-06-143205');
    expect(created).toHaveLength(1);
  });

  test('writes nothing when the pipeline produced no artifacts', async () => {
    const save = createScanDebugSaver(() => 'D:/MyNotes/board.md', now);
    expect(await save([])).toBeNull();
    expect(created).toEqual([]);
    expect(written).toEqual([]);
  });
});
