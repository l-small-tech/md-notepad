/**
 * Live Edit mode — the policy half (pure; tested). The merge itself is
 * `merge.ts`; the session controller wires both to the file watcher.
 *
 * A FILE tab is live when its own override says so, else when the workspace
 * its file lives in is marked `liveEdit` (the shared Drive/OneDrive folder).
 * Notes, images, imports and terminals are never live: a note's file is
 * managed by the flusher, the rest hold no editable text.
 */

import { workspaceEntryForPath } from './tab-workspaces';

/** The projection of a tab this module decides on. */
export interface LiveEditTab {
  kind: string;
  filePath: string | null;
  /** Per-tab override: true/false, or null to follow the workspace. */
  liveEdit: boolean | null;
}

export interface LiveEditWorkspace {
  path: string;
  liveEdit?: boolean;
}

export function isLiveEditTab(tab: LiveEditTab, workspaces: readonly LiveEditWorkspace[]): boolean {
  if (tab.kind !== 'file' || !tab.filePath) {
    return false;
  }
  if (tab.liveEdit !== null) {
    return tab.liveEdit;
  }
  return workspaceEntryForPath(tab.filePath, workspaces)?.liveEdit === true;
}

/**
 * Directories the watcher must cover BEYOND the workspace roots: the parent
 * folder of every live tab whose file lies outside all of `roots` (a shared
 * file opened from anywhere on disk with the per-tab override). Deduped on
 * the normalized path key, original spelling kept.
 */
export function extraLiveWatchDirs(
  tabs: readonly LiveEditTab[],
  workspaces: readonly LiveEditWorkspace[],
  roots: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tab of tabs) {
    if (!isLiveEditTab(tab, workspaces) || !tab.filePath) {
      continue;
    }
    if (
      workspaceEntryForPath(
        tab.filePath,
        roots.map((path) => ({ path })),
      ) !== null
    ) {
      continue;
    }
    const idx = Math.max(tab.filePath.lastIndexOf('/'), tab.filePath.lastIndexOf('\\'));
    if (idx <= 0) {
      continue;
    }
    const dir = tab.filePath.slice(0, idx);
    const key = dir.replaceAll('\\', '/').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(dir);
    }
  }
  return out;
}

/**
 * Local wall-clock label ("14:03:27") for the status chip's "last merged"
 * readout. Absolute rather than relative on purpose: a React render must be
 * pure, and "3 min ago" would need the current time at render.
 */
export function formatClockTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
