/**
 * Which workspace a tab belongs to, and therefore what color it wears.
 *
 * The tab strip takes its color cues from the SAME workspaces the explorer
 * lists (there are no user-made tab groups any more — see
 * core/tab-workspaces.ts): a tab whose file lives in a colored workspace gets
 * that workspace's accent, exactly like the explorer's workspace sections.
 * This module is the one place the two sides agree on the root list — the
 * resolved notes dir (the implicit default workspace, whose color is
 * `defaultWorkspaceColor`) plus every entry in `settings.workspaces`.
 *
 * Kept out of `core/` because it reads live app state (the settings store and
 * the session controller's resolved notes dir); the matching rule itself is
 * pure and lives in core/tab-workspaces.ts.
 */

import { workspaceForPath, type WorkspaceMatch, type WorkspaceRoot } from '../core/tab-workspaces';
import { getDefaultWorkspacePath } from './session';
import { settingsStore } from './stores/settings';

/** The workspace roots as the explorer shows them: notes dir first, then the added ones. */
export function workspaceRoots(): WorkspaceRoot[] {
  const { settings } = settingsStore.getState();
  const defaultPath = getDefaultWorkspacePath();
  return [
    ...(defaultPath === null ? [] : [{ path: defaultPath, color: settings.defaultWorkspaceColor }]),
    ...settings.workspaces.map((w) => ({ path: w.path, color: w.color })),
  ];
}

/** The minimum a tab has to expose to be placed in a workspace. */
export interface CueableTab {
  kind: string;
  notePath: string | null;
  filePath: string | null;
}

/**
 * The workspace a tab belongs to, or null when it has no file (a terminal) or
 * its file lies outside every workspace. Note tabs belong to the default
 * workspace BY DEFINITION — their file lives in the notes dir — so a brand-new
 * note wears the right color before its first flush has given it a path.
 */
export function workspaceCueFor(tab: CueableTab): WorkspaceMatch | null {
  const roots = workspaceRoots();
  const path = tab.filePath ?? tab.notePath;
  const match = workspaceForPath(path, roots);
  if (match) {
    return match;
  }
  if (tab.kind !== 'note') {
    return null;
  }
  const fallback = roots[0];
  return fallback ? workspaceForPath(fallback.path, roots) : null;
}
