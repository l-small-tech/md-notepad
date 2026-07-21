import { describe, expect, test } from 'vitest';
import {
  computeGroupRuns,
  deriveGroupForInsert,
  nextGroupColor,
  normalizeGroupContiguity,
  planTabMove,
  sanitizeRestoredGroups,
  type GroupedTab,
} from '../tab-groups';
import { WORKSPACE_COLORS, type TabGroup } from '../types';

function t(id: string, groupId: string | null = null): GroupedTab {
  return { id, groupId };
}

function group(id: string, overrides: Partial<TabGroup> = {}): TabGroup {
  return { id, name: '', color: 'blue', collapsed: false, ...overrides };
}

function ids(tabs: readonly GroupedTab[]): string[] {
  return tabs.map((x) => x.id);
}

describe('computeGroupRuns', () => {
  test('merges grouped neighbors, keeps ungrouped tabs as single runs', () => {
    const runs = computeGroupRuns([t('a'), t('b', 'g1'), t('c', 'g1'), t('d'), t('e')]);
    expect(runs).toEqual([
      { groupId: null, start: 0, count: 1 },
      { groupId: 'g1', start: 1, count: 2 },
      { groupId: null, start: 3, count: 1 },
      { groupId: null, start: 4, count: 1 },
    ]);
  });

  test('empty strip yields no runs', () => {
    expect(computeGroupRuns([])).toEqual([]);
  });
});

describe('normalizeGroupContiguity', () => {
  test('returns the same array when already contiguous', () => {
    const tabs = [t('a'), t('b', 'g1'), t('c', 'g1'), t('d')];
    expect(normalizeGroupContiguity(tabs)).toBe(tabs);
  });

  test('pulls a stray member up to the end of its group run', () => {
    const tabs = [t('a', 'g1'), t('b'), t('c', 'g1'), t('d')];
    expect(ids(normalizeGroupContiguity(tabs))).toEqual(['a', 'c', 'b', 'd']);
  });

  test('handles two interleaved groups (first appearance anchors each run)', () => {
    const tabs = [t('a', 'g1'), t('b', 'g2'), t('c', 'g1'), t('d', 'g2')];
    expect(ids(normalizeGroupContiguity(tabs))).toEqual(['a', 'c', 'b', 'd']);
  });
});

describe('planTabMove', () => {
  test('plain reorder with no groups', () => {
    const tabs = [t('a'), t('b'), t('c')];
    expect(ids(planTabMove(tabs, 'a', 2, null)!)).toEqual(['b', 'c', 'a']);
  });

  test('unknown tab returns null', () => {
    expect(planTabMove([t('a')], 'zz', 0, null)).toBeNull();
  });

  test('clamps an out-of-range index', () => {
    const tabs = [t('a'), t('b')];
    expect(ids(planTabMove(tabs, 'a', 99, null)!)).toEqual(['b', 'a']);
  });

  test('moving into a group keeps the group contiguous', () => {
    const tabs = [t('a'), t('b', 'g1'), t('c', 'g1'), t('d')];
    // Index 2 of [b, c, d] = between c and d — a joins at the end of the run.
    const moved = planTabMove(tabs, 'a', 2, 'g1')!;
    expect(ids(moved)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved[2]!.groupId).toBe('g1');
  });

  test('an impossible position degrades to the nearest legal one instead of splitting', () => {
    // Dropping an ungrouped tab in the middle of g1's run WITHOUT membership:
    // normalization pulls the run back together behind its anchor.
    const tabs = [t('a', 'g1'), t('b', 'g1'), t('c')];
    const moved = planTabMove(tabs, 'c', 1, null)!;
    expect(ids(moved)).toEqual(['a', 'b', 'c']);
  });

  test('moving the last member away leaves the rest untouched', () => {
    const tabs = [t('a', 'g1'), t('b'), t('c')];
    const moved = planTabMove(tabs, 'a', 2, null)!;
    expect(ids(moved)).toEqual(['b', 'c', 'a']);
    expect(moved[2]!.groupId).toBeNull();
  });
});

describe('deriveGroupForInsert', () => {
  test('strictly inside a group run → that group', () => {
    expect(deriveGroupForInsert(t('a', 'g1'), t('b', 'g1'))).toBe('g1');
  });

  test('boundaries and strip ends → ungrouped', () => {
    expect(deriveGroupForInsert(t('a'), t('b', 'g1'))).toBeNull();
    expect(deriveGroupForInsert(t('a', 'g1'), t('b'))).toBeNull();
    expect(deriveGroupForInsert(t('a', 'g1'), t('b', 'g2'))).toBeNull();
    expect(deriveGroupForInsert(undefined, t('b', 'g1'))).toBeNull();
    expect(deriveGroupForInsert(t('a', 'g1'), undefined)).toBeNull();
    expect(deriveGroupForInsert(undefined, undefined)).toBeNull();
  });

  test('between two ungrouped tabs → ungrouped', () => {
    expect(deriveGroupForInsert(t('a'), t('b'))).toBeNull();
  });
});

describe('nextGroupColor', () => {
  test('picks the first unused palette color', () => {
    expect(nextGroupColor([])).toBe(WORKSPACE_COLORS[0]);
    expect(nextGroupColor([group('g1', { color: WORKSPACE_COLORS[0] })])).toBe(WORKSPACE_COLORS[1]);
  });

  test('cycles once every color is taken', () => {
    const all = WORKSPACE_COLORS.map((color, i) => group(`g${i}`, { color }));
    expect(nextGroupColor(all)).toBe(WORKSPACE_COLORS[all.length % WORKSPACE_COLORS.length]);
  });
});

describe('sanitizeRestoredGroups', () => {
  test('drops memberships of unknown groups and unreferenced definitions', () => {
    const result = sanitizeRestoredGroups(
      [t('a', 'gone'), t('b', 'g1')],
      [group('g1'), group('unused')],
    );
    expect(result.tabs.map((x) => x.groupId)).toEqual([null, 'g1']);
    expect(result.groups.map((g) => g.id)).toEqual(['g1']);
  });

  test('re-establishes contiguity from a hand-edited manifest', () => {
    const result = sanitizeRestoredGroups([t('a', 'g1'), t('b'), t('c', 'g1')], [group('g1')]);
    expect(ids(result.tabs)).toEqual(['a', 'c', 'b']);
  });

  test('clean input passes through unchanged (order and identity of entries)', () => {
    const tabs = [t('a', 'g1'), t('b', 'g1'), t('c')];
    const groups = [group('g1')];
    const result = sanitizeRestoredGroups(tabs, groups);
    expect(result.tabs.map((x, i) => x === tabs[i])).toEqual([true, true, true]);
    expect(result.groups).toEqual(groups);
  });
});
