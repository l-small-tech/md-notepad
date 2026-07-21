/**
 * Tab-group logic (pure; tested). Owns the ONE structural invariant of
 * Chrome-style tab groups: members of a group are always CONTIGUOUS in the
 * tab strip. Every mutation the tabs store performs on grouped tabs goes
 * through these helpers so the invariant can't drift, and restore runs the
 * same normalization defensively over whatever the manifest recorded.
 *
 * The functions work on a minimal `{ id, groupId }` projection, not TabEntry
 * — core imports nothing app-local (invariant I9) and the store just re-maps
 * its rich entries onto the returned id order.
 */

import { WORKSPACE_COLORS, type TabGroup, type WorkspaceColor } from './types';

/** The projection of a tab these helpers operate on. */
export interface GroupedTab {
  id: string;
  groupId: string | null;
}

/**
 * One contiguous run of same-group tabs (groupId null = a single ungrouped
 * tab; ungrouped runs are NOT merged — each ungrouped tab is its own run so
 * renderers can treat "run" as "chip boundary" only when groupId is set).
 */
export interface GroupRun {
  groupId: string | null;
  /** Index of the first member in the tab array. */
  start: number;
  /** Number of members. */
  count: number;
}

/** Split the strip into contiguous runs; grouped neighbors merge, ungrouped don't. */
export function computeGroupRuns(tabs: readonly GroupedTab[]): GroupRun[] {
  const runs: GroupRun[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const last = runs[runs.length - 1];
    if (last && last.groupId !== null && last.groupId === tab.groupId) {
      last.count++;
    } else {
      runs.push({ groupId: tab.groupId, start: i, count: 1 });
    }
  }
  return runs;
}

/**
 * Re-establish contiguity without reordering more than necessary: the first
 * member of each group anchors its run, and later stray members are pulled up
 * to the end of that run. Ungrouped tabs keep their relative order. Returns
 * the input array itself when nothing had to move (cheap no-op detection for
 * the store).
 */
export function normalizeGroupContiguity(tabs: readonly GroupedTab[]): readonly GroupedTab[] {
  const buckets: GroupedTab[][] = [];
  const byGroup = new Map<string, GroupedTab[]>();
  for (const tab of tabs) {
    const existing = tab.groupId !== null ? byGroup.get(tab.groupId) : undefined;
    if (existing) {
      existing.push(tab);
    } else {
      const bucket = [tab];
      buckets.push(bucket);
      if (tab.groupId !== null) {
        byGroup.set(tab.groupId, bucket);
      }
    }
  }
  const flat = buckets.flat();
  return flat.every((t, i) => t === tabs[i]) ? tabs : flat;
}

/**
 * Plan a drag/move: take `movedId` out, insert it at `toIndex` (an index into
 * the array WITHOUT the moved tab, clamped) with the given group membership,
 * then normalize. Returns null when the tab doesn't exist.
 */
export function planTabMove(
  tabs: readonly GroupedTab[],
  movedId: string,
  toIndex: number,
  groupId: string | null,
): readonly GroupedTab[] | null {
  const from = tabs.findIndex((t) => t.id === movedId);
  if (from < 0) {
    return null;
  }
  const rest = tabs.filter((t) => t.id !== movedId);
  const clamped = Math.max(0, Math.min(toIndex, rest.length));
  rest.splice(clamped, 0, { id: movedId, groupId });
  return normalizeGroupContiguity(rest);
}

/**
 * The membership an insertion BETWEEN two neighbors implies (the drop rule):
 * strictly inside a group's run → that group; anywhere else — a boundary
 * between runs, the ends of the strip — → ungrouped. Joining a group at its
 * very edge is an explicit gesture (drop on the chip, context menu), never an
 * accident of a nearby drop.
 */
export function deriveGroupForInsert(
  left: GroupedTab | undefined,
  right: GroupedTab | undefined,
): string | null {
  if (left && right && left.groupId !== null && left.groupId === right.groupId) {
    return left.groupId;
  }
  return null;
}

/** First palette color no existing group uses, else cycle by group count. */
export function nextGroupColor(groups: readonly TabGroup[]): WorkspaceColor {
  const used = new Set(groups.map((g) => g.color));
  for (const color of WORKSPACE_COLORS) {
    if (!used.has(color)) {
      return color;
    }
  }
  return WORKSPACE_COLORS[groups.length % WORKSPACE_COLORS.length]!;
}

/**
 * Restore-time cleanup: drop group definitions no tab references, null out
 * memberships of unknown groups, and re-establish contiguity. Tolerant by
 * design — the manifest may predate groups or have been hand-edited.
 */
export function sanitizeRestoredGroups(
  tabs: readonly GroupedTab[],
  groups: readonly TabGroup[],
): { tabs: readonly GroupedTab[]; groups: TabGroup[] } {
  const known = new Set(groups.map((g) => g.id));
  const cleaned = tabs.map((t) =>
    t.groupId !== null && !known.has(t.groupId) ? { id: t.id, groupId: null } : t,
  );
  const referenced = new Set(cleaned.map((t) => t.groupId));
  return {
    tabs: normalizeGroupContiguity(cleaned),
    groups: groups.filter((g) => referenced.has(g.id)),
  };
}
