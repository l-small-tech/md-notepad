/**
 * Workspace grouping for the tab strip (pure; tested) — what replaced the
 * Chrome-style tab groups.
 *
 * A tab's "group" is no longer something the user creates: it is the
 * WORKSPACE its file lives in (the explorer's own folders, see
 * `WorkspaceEntry` and the implicit notes-dir workspace). That is what gives
 * a tab its color cue — the same `data-color` → `--ws-accent` tokens the
 * explorer's workspace sections use — with no state to persist, name, or
 * garbage-collect.
 *
 * Two things live here:
 *
 * - `workspaceForPath` — longest-prefix match of a file path against the
 *   workspace roots, so `/notes/project/a.md` belongs to `/notes/project`
 *   rather than to the `/notes` it is nested in.
 * - `orderTabsByWorkspace` — the OPTIONAL auto-arrange (the
 *   `groupTabsByWorkspace` setting): pull each workspace's tabs into one
 *   contiguous run, anchored where that workspace's first tab already sits.
 *   Off by default; with it off the strip keeps whatever order the user
 *   dragged tabs into and this module only supplies colors.
 *
 * The functions work on minimal projections rather than on `TabEntry` — core
 * imports nothing app-local (invariant I9) and the caller re-maps its rich
 * entries onto the returned order.
 */

import type { WorkspaceColor } from './types';

/** A workspace as this module needs it: a root path and its accent color. */
export interface WorkspaceRoot {
  /** Absolute folder path, or a `saf://` identifier for a synced workspace. */
  path: string;
  /** Accent color token, or null for an uncolored workspace. */
  color: WorkspaceColor | null;
}

/** The projection of a tab the ordering works on. */
export interface WorkspaceTab {
  id: string;
  /**
   * Key of the workspace the tab belongs to (`workspaceForPath().key`), or
   * null for a tab with no file — a terminal, an unsaved note. Null-keyed
   * tabs are never pulled into a run; each stays where it is.
   */
  workspaceKey: string | null;
}

/**
 * Comparable form of a path. Synced (SAF) identifiers (`saf://<token>/<rel>`)
 * are opaque and case-sensitive — the token encodes a case-sensitive document
 * URI, so lowercasing one would corrupt the id and could collide two distinct
 * trees. They are returned verbatim; local paths get separator/case
 * normalization so `C:\Notes` and `c:/notes` are one workspace.
 */
export function pathKey(path: string): string {
  if (path.startsWith('saf://')) {
    return path;
  }
  return path.replaceAll('\\', '/').toLowerCase();
}

/** A root's key: its path key without a trailing slash, so `/notes` and
 *  `/notes/` are one workspace rather than two. */
function rootKey(root: string): string {
  return pathKey(root).replace(/\/+$/, '');
}

/** Is `path` the root itself or inside it? Compared on normalized keys. */
function isInside(path: string, root: string): boolean {
  const p = pathKey(path);
  const r = rootKey(root);
  return p === r || p.startsWith(`${r}/`);
}

/** A workspace match: its key (for grouping) and color (for the cue). */
export interface WorkspaceMatch {
  key: string;
  color: WorkspaceColor | null;
}

/**
 * The workspace a file belongs to: the LONGEST matching root, so a workspace
 * nested inside another wins. Returns null for a null/empty path or one that
 * lies outside every root (a file opened from anywhere on disk).
 */
export function workspaceForPath(
  path: string | null,
  roots: readonly WorkspaceRoot[],
): WorkspaceMatch | null {
  if (!path) {
    return null;
  }
  let best: WorkspaceRoot | null = null;
  for (const root of roots) {
    if (!isInside(path, root.path)) {
      continue;
    }
    if (best === null || rootKey(root.path).length > rootKey(best.path).length) {
      best = root;
    }
  }
  return best === null ? null : { key: rootKey(best.path), color: best.color };
}

/**
 * Auto-arrange: every workspace's tabs become one contiguous run, anchored at
 * the position of that workspace's FIRST tab, so turning the setting on moves
 * as little as possible. Tabs with no workspace (terminals, unsaved notes)
 * keep their own places in the sequence and are never merged with each other.
 *
 * Returns the input array itself when nothing had to move — the cheap no-op
 * detection the store uses to skip a state update.
 */
export function orderTabsByWorkspace(tabs: readonly WorkspaceTab[]): readonly WorkspaceTab[] {
  const buckets: WorkspaceTab[][] = [];
  const byWorkspace = new Map<string, WorkspaceTab[]>();
  for (const tab of tabs) {
    const existing = tab.workspaceKey !== null ? byWorkspace.get(tab.workspaceKey) : undefined;
    if (existing) {
      existing.push(tab);
      continue;
    }
    const bucket = [tab];
    buckets.push(bucket);
    if (tab.workspaceKey !== null) {
      byWorkspace.set(tab.workspaceKey, bucket);
    }
  }
  const flat = buckets.flat();
  return flat.every((t, i) => t === tabs[i]) ? tabs : flat;
}

/**
 * One contiguous run of same-workspace tabs, as the strip renders them: the
 * run's ends get the rounded corners, everything between flows together.
 * Null-keyed tabs are each their own run (no band to draw).
 */
export interface WorkspaceRun {
  workspaceKey: string | null;
  /** Index of the first member in the tab array. */
  start: number;
  /** Number of members. */
  count: number;
}

/** Split the strip into contiguous runs; same-workspace neighbors merge. */
export function computeWorkspaceRuns(tabs: readonly WorkspaceTab[]): WorkspaceRun[] {
  const runs: WorkspaceRun[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const last = runs[runs.length - 1];
    if (last && last.workspaceKey !== null && last.workspaceKey === tab.workspaceKey) {
      last.count++;
    } else {
      runs.push({ workspaceKey: tab.workspaceKey, start: i, count: 1 });
    }
  }
  return runs;
}
