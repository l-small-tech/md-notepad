import { describe, expect, test } from 'vitest';
import {
  computeWorkspaceRuns,
  orderTabsByWorkspace,
  pathKey,
  workspaceForPath,
  type WorkspaceRoot,
  type WorkspaceTab,
} from '../tab-workspaces';

const ROOTS: WorkspaceRoot[] = [
  { path: '/notes', color: 'green' },
  { path: '/notes/project', color: 'blue' },
  { path: 'saf://TOKEN/Docs', color: null },
];

describe('pathKey', () => {
  test('local paths normalize separators and case', () => {
    expect(pathKey('C:\\Notes\\A.md')).toBe('c:/notes/a.md');
  });

  test('saf:// identifiers are opaque — returned verbatim', () => {
    expect(pathKey('saf://ToKeN/Docs')).toBe('saf://ToKeN/Docs');
  });
});

describe('workspaceForPath', () => {
  test('a file inside a workspace takes its color', () => {
    expect(workspaceForPath('/notes/a.md', ROOTS)).toEqual({ key: '/notes', color: 'green' });
  });

  test('the LONGEST matching root wins, so a nested workspace beats its parent', () => {
    expect(workspaceForPath('/notes/project/a.md', ROOTS)).toEqual({
      key: '/notes/project',
      color: 'blue',
    });
  });

  test('the root itself belongs to its own workspace', () => {
    expect(workspaceForPath('/notes', ROOTS)?.key).toBe('/notes');
  });

  test('a sibling folder that merely shares a prefix does NOT match', () => {
    expect(workspaceForPath('/notes-archive/a.md', ROOTS)).toBeNull();
  });

  test('a file outside every workspace, and a null path, have none', () => {
    expect(workspaceForPath('/tmp/scratch.md', ROOTS)).toBeNull();
    expect(workspaceForPath(null, ROOTS)).toBeNull();
  });

  test('case and separators are irrelevant on local paths', () => {
    expect(workspaceForPath('\\NOTES\\a.md', ROOTS)?.key).toBe('/notes');
  });

  test('a trailing slash on the root does not break the match', () => {
    expect(workspaceForPath('/notes/a.md', [{ path: '/notes/', color: null }])?.key).toBe('/notes');
  });

  test('a synced (saf://) workspace matches case-sensitively', () => {
    expect(workspaceForPath('saf://TOKEN/Docs/a.md', ROOTS)?.key).toBe('saf://TOKEN/Docs');
    expect(workspaceForPath('saf://token/Docs/a.md', ROOTS)).toBeNull();
  });
});

describe('orderTabsByWorkspace', () => {
  const tabs = (spec: string): WorkspaceTab[] =>
    [...spec].map((c, i) => ({ id: `${c}${i}`, workspaceKey: c === '.' ? null : c }));
  const keys = (list: readonly WorkspaceTab[]): string => list.map((t) => t.id[0]).join('');

  test('scattered members of one workspace gather at its first tab', () => {
    expect(keys(orderTabsByWorkspace(tabs('aba')))).toBe('aab');
  });

  test('already-contiguous input is returned as-is (no state churn)', () => {
    const input = tabs('aabb');
    expect(orderTabsByWorkspace(input)).toBe(input);
  });

  test('workspace order follows first appearance, not the root list', () => {
    expect(keys(orderTabsByWorkspace(tabs('bab')))).toBe('bba');
  });

  test('tabs with no workspace keep their own places and never merge', () => {
    expect(keys(orderTabsByWorkspace(tabs('a.a.')))).toBe('aa..');
    expect(keys(orderTabsByWorkspace(tabs('..')))).toBe('..');
  });
});

describe('computeWorkspaceRuns', () => {
  test('same-workspace neighbors merge into one run', () => {
    const runs = computeWorkspaceRuns([
      { id: '1', workspaceKey: 'a' },
      { id: '2', workspaceKey: 'a' },
      { id: '3', workspaceKey: 'b' },
    ]);
    expect(runs).toEqual([
      { workspaceKey: 'a', start: 0, count: 2 },
      { workspaceKey: 'b', start: 2, count: 1 },
    ]);
  });

  test('workspace-less tabs are each their own run — no band to draw', () => {
    const runs = computeWorkspaceRuns([
      { id: '1', workspaceKey: null },
      { id: '2', workspaceKey: null },
    ]);
    expect(runs.map((r) => r.count)).toEqual([1, 1]);
  });

  test('an empty strip has no runs', () => {
    expect(computeWorkspaceRuns([])).toEqual([]);
  });
});
