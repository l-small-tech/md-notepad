/**
 * Opening a terminal tab, with the working directory a user expects.
 *
 * A new terminal starts in the WORKSPACE the user is standing in: the
 * directory selected in the explorer (a workspace header or one of its
 * folders), falling back to the default (notes dir) workspace when nothing
 * has been selected. That beats inheriting from whatever tab happens to be in
 * front — the workspace is the thing the user picked on purpose. A profile
 * that names its own `cwd` still overrides it — that decision lives in
 * `TerminalPane`, which is where the spawn actually happens. Splitting an
 * existing pane is a separate path and keeps inheriting that pane's cwd.
 */

import { getDefaultWorkspacePath } from './session';
import { tabsStore } from './stores/tabs';
import { settingsStore } from './stores/settings';
import { uiStore } from './stores/ui';
import { isAndroid } from './platform';

/** The directory a new terminal should start in, or null to inherit the app's. */
export function workspaceCwd(): string | null {
  const dir = uiStore.getState().selectedExplorerDir ?? getDefaultWorkspacePath();
  // Synced (SAF) workspaces are opaque document ids, not paths a shell can be
  // spawned in — and Android has no pty anyway.
  if (dir === null || dir.startsWith('saf://')) {
    return null;
  }
  return dir;
}

export interface OpenTerminalOptions {
  /**
   * A command line typed into the shell, Enter included, once it is ready —
   * the Settings dialog's Install button runs an agent's install command this
   * way so the user sees the exact line and keeps the shell afterwards.
   * Transient: never part of the session snapshot.
   */
  initialInput?: string;
}

/**
 * Open a terminal tab. No-op on Android, which has no pty — callers may still
 * call it unconditionally. `cwd` overrides the workspace default for callers
 * that know where the session belongs (the AI-theme terminal starts in the
 * themes folder).
 */
export function openTerminal(
  profileId?: string,
  cwd?: string,
  options: OpenTerminalOptions = {},
): string | null {
  if (isAndroid()) {
    return null;
  }
  const settings = settingsStore.getState().settings;
  return tabsStore.getState().openTerminalTab({
    profileId: profileId ?? settings.defaultTerminalProfile,
    cwd: cwd ?? workspaceCwd(),
    initialInput: options.initialInput ?? null,
  });
}
