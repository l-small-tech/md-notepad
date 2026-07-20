/**
 * Exercises the capped SAF search walker against a fake storage provider
 * (the injectable `provider` parameter): tree recursion, the sidecar /
 * non-text / size filters, both caps, and read-failure tolerance. Matching
 * semantics are covered in core/__tests__/search.test.ts.
 */
import { describe, expect, test } from 'vitest';
import type { DirEntryMeta } from '../../ipc/commands';
import type { StorageProvider } from '../../ipc/provider';
import { searchSafTree } from '../search-saf';

interface FakeTree {
  /** dir id → entries. */
  dirs: Record<string, DirEntryMeta[]>;
  /** file id → text ('THROW' simulates an unreadable file). */
  files: Record<string, string>;
}

function file(path: string, size = 10): DirEntryMeta {
  return { path, isDir: false, mtimeMs: 0, size };
}

function dir(path: string): DirEntryMeta {
  return { path, isDir: true, mtimeMs: 0, size: 0 };
}

function makeProvider(tree: FakeTree): StorageProvider {
  return {
    listDir: async (d: string) => tree.dirs[d] ?? [],
    readTextFile: async (path: string) => {
      const text = tree.files[path];
      if (text === undefined || text === 'THROW') {
        throw new Error(`unreadable: ${path}`);
      }
      return { text, mtimeMs: 0 };
    },
  } as unknown as StorageProvider;
}

const CAPS = { fileCap: 200, sizeCap: 512 * 1024, resultCap: 500 };

describe('searchSafTree', () => {
  test('finds hits across nested dirs; skips sidecars, non-text, oversized', async () => {
    const provider = makeProvider({
      dirs: {
        'saf://T': [
          file('saf://T/a.md'),
          file('saf://T/a.comments.md'),
          file('saf://T/pic.png'),
          file('saf://T/big.md', 10 * 1024 * 1024),
          dir('saf://T/sub'),
        ],
        'saf://T/sub': [file('saf://T/sub/b.txt')],
      },
      files: {
        'saf://T/a.md': 'a needle here',
        'saf://T/a.comments.md': 'needle',
        'saf://T/pic.png': 'needle',
        'saf://T/big.md': 'needle',
        'saf://T/sub/b.txt': 'x\nneedle again',
      },
    });

    const { matches, truncated } = await searchSafTree('saf://T', 'needle', CAPS, provider);
    expect(truncated).toBe(false);
    expect(matches.map((m) => [m.path, m.line]).sort()).toEqual([
      ['saf://T/a.md', 1],
      ['saf://T/sub/b.txt', 2],
    ]);
  });

  test('stops at resultCap and reports truncation', async () => {
    const provider = makeProvider({
      dirs: { 'saf://T': [file('saf://T/a.md')] },
      files: { 'saf://T/a.md': 'x x x x x x x x' },
    });
    const { matches, truncated } = await searchSafTree(
      'saf://T',
      'x',
      { ...CAPS, resultCap: 3 },
      provider,
    );
    expect(matches).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  test('reads at most fileCap files and reports truncation', async () => {
    const provider = makeProvider({
      dirs: {
        'saf://T': [file('saf://T/a.md'), file('saf://T/b.md'), file('saf://T/c.md')],
      },
      files: {
        'saf://T/a.md': 'needle',
        'saf://T/b.md': 'needle',
        'saf://T/c.md': 'needle',
      },
    });
    const { matches, truncated } = await searchSafTree(
      'saf://T',
      'needle',
      { ...CAPS, fileCap: 2 },
      provider,
    );
    expect(matches).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  test('an unreadable file (or unlistable dir) is skipped, not fatal', async () => {
    const provider = makeProvider({
      dirs: {
        'saf://T': [file('saf://T/broken.md'), file('saf://T/ok.md'), dir('saf://T/ghost')],
        // 'saf://T/ghost' has no listing → listDir returns [] (missing key).
      },
      files: { 'saf://T/broken.md': 'THROW', 'saf://T/ok.md': 'needle' },
    });
    const { matches, truncated } = await searchSafTree('saf://T', 'needle', CAPS, provider);
    expect(truncated).toBe(false);
    expect(matches.map((m) => m.path)).toEqual(['saf://T/ok.md']);
  });

  test('the walk itself never matches — an empty query yields nothing', async () => {
    const provider = makeProvider({
      dirs: { 'saf://T': [file('saf://T/a.md')] },
      files: { 'saf://T/a.md': 'anything' },
    });
    const { matches } = await searchSafTree('saf://T', '', CAPS, provider);
    expect(matches).toEqual([]);
  });
});
