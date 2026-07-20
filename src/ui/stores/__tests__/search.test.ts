/**
 * Exercises the search store's `run()` orchestration: root enumeration
 * (default workspace + settings entries, deduped), local-vs-saf routing, the
 * shared result cap, per-root failure tolerance, and the stale-run guard.
 * The pure matching itself is covered in core/__tests__/search.test.ts; the
 * SAF walker in ui/__tests__/search-saf.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import type { SearchMatch } from '../../../core/search';
import { ipc, type SearchHit } from '../../../ipc/commands';
import { searchSafTree } from '../../search-saf';
import { setDefaultWorkspaceDispatch } from '../../session/facade';
import { searchStore } from '../search';
import { settingsStore } from '../settings';
import { DEFAULT_SETTINGS } from '../../../core/settings';

vi.mock('../../search-saf', () => ({ searchSafTree: vi.fn() }));

const mockedSafSearch = vi.mocked(searchSafTree);

function hit(path: string, line = 1): SearchHit {
  return { path, line, col: 1, lineText: 'x' };
}

function workspace(path: string) {
  return { name: 'W', path, color: null };
}

let searchNotesSpy: MockInstance<typeof ipc.searchNotes>;

beforeEach(() => {
  settingsStore.getState().replace({ ...DEFAULT_SETTINGS, workspaces: [] });
  setDefaultWorkspaceDispatch(() => '/notes');
  searchStore.setState({
    open: false,
    query: '',
    results: [],
    searching: false,
    truncated: false,
    error: null,
  });
  searchNotesSpy = vi.spyOn(ipc, 'searchNotes').mockResolvedValue([]);
  mockedSafSearch.mockReset();
});

afterEach(() => {
  searchNotesSpy.mockRestore();
});

describe('searchStore.run', () => {
  test('searches the default root plus every settings workspace, deduped', async () => {
    settingsStore.getState().replace({
      ...DEFAULT_SETTINGS,
      workspaces: [workspace('/extra'), workspace('C:\\Notes'), workspace('/NOTES')],
    });
    searchNotesSpy.mockImplementation(async (dir) => [hit(`${dir}/a.md`)]);

    await searchStore.getState().run('needle');

    // '/NOTES' dedupes against the default '/notes' (pathKey is case-insensitive).
    expect(searchNotesSpy.mock.calls.map((c) => c[0])).toEqual(['/notes', '/extra', 'C:\\Notes']);
    expect(searchStore.getState().results).toHaveLength(3);
    expect(searchStore.getState().searching).toBe(false);
    expect(searchStore.getState().error).toBeNull();
  });

  test('routes saf:// roots through the frontend walker and merges truncation', async () => {
    settingsStore.getState().replace({
      ...DEFAULT_SETTINGS,
      workspaces: [{ ...workspace('saf://TOKEN'), kind: 'synced' as const }],
    });
    searchNotesSpy.mockResolvedValue([hit('/notes/a.md')]);
    const safMatch: SearchMatch = { path: 'saf://TOKEN/b.md', line: 2, col: 1, lineText: 'y' };
    mockedSafSearch.mockResolvedValue({ matches: [safMatch], truncated: true });

    await searchStore.getState().run('needle');

    expect(searchNotesSpy).toHaveBeenCalledTimes(1); // saf root never hits Rust
    expect(mockedSafSearch).toHaveBeenCalledWith(
      'saf://TOKEN',
      'needle',
      expect.objectContaining({ fileCap: 200, sizeCap: 512 * 1024 }),
    );
    const s = searchStore.getState();
    expect(s.results).toEqual([expect.objectContaining({ path: '/notes/a.md' }), safMatch]);
    expect(s.truncated).toBe(true);
  });

  test('lowercases the query for the SAF walker', async () => {
    settingsStore.getState().replace({
      ...DEFAULT_SETTINGS,
      workspaces: [{ ...workspace('saf://T'), kind: 'synced' as const }],
    });
    mockedSafSearch.mockResolvedValue({ matches: [], truncated: false });
    await searchStore.getState().run('NeEdLe');
    expect(mockedSafSearch.mock.calls[0]?.[1]).toBe('needle');
  });

  test('a failed root keeps the other roots’ results without an error', async () => {
    settingsStore.getState().replace({ ...DEFAULT_SETTINGS, workspaces: [workspace('/extra')] });
    searchNotesSpy.mockImplementation(async (dir) => {
      if (dir === '/notes') {
        throw new Error('boom');
      }
      return [hit('/extra/a.md')];
    });

    await searchStore.getState().run('needle');

    const s = searchStore.getState();
    expect(s.results).toHaveLength(1);
    expect(s.error).toBeNull();
  });

  test('error is set only when every root failed', async () => {
    searchNotesSpy.mockRejectedValue(new Error('all gone'));
    await searchStore.getState().run('needle');
    const s = searchStore.getState();
    expect(s.results).toEqual([]);
    expect(s.error).toBe('all gone');
  });

  test('a root that fills the cap marks the run truncated', async () => {
    searchNotesSpy.mockImplementation(async (_dir, _q, max) =>
      Array.from({ length: max }, (_, i) => hit('/notes/a.md', i + 1)),
    );
    await searchStore.getState().run('needle');
    const s = searchStore.getState();
    expect(s.results).toHaveLength(500);
    expect(s.truncated).toBe(true);
  });

  test('queries under the minimum length clear instead of searching', async () => {
    searchStore.setState({ results: [hit('/notes/a.md')] });
    await searchStore.getState().run('x');
    expect(searchNotesSpy).not.toHaveBeenCalled();
    expect(searchStore.getState().results).toEqual([]);
  });

  test('a superseded run never clobbers the newer run’s results', async () => {
    let releaseFirst!: (hits: SearchHit[]) => void;
    const firstGate = new Promise<SearchHit[]>((resolve) => {
      releaseFirst = resolve;
    });
    searchNotesSpy
      .mockImplementationOnce(() => firstGate) // run 1 hangs
      .mockImplementationOnce(async () => [hit('/notes/new.md')]); // run 2

    const first = searchStore.getState().run('old-needle');
    const second = searchStore.getState().run('new-needle');
    await second;
    expect(searchStore.getState().results).toEqual([hit('/notes/new.md')]);

    releaseFirst([hit('/notes/old.md')]);
    await first;
    expect(searchStore.getState().results).toEqual([hit('/notes/new.md')]);
    expect(searchStore.getState().query).toBe('new-needle');
  });
});
