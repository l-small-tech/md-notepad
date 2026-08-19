/**
 * Cross-window active-workspace selection — the same split the theme picker
 * uses: the default action applies to every window, right-click keeps it to
 * this one.
 *
 * The active workspace itself lives in `uiStore.selectedExplorerDir`, which is
 * per-window in-memory state (deliberately: two windows can work in two
 * workspaces). "Set active" in the workspace context menu is the one place a
 * selection should fan out, so it goes through {@link setActiveWorkspace},
 * which broadcasts over a Tauri event; every window (this one included — the
 * echo is an idempotent no-op) folds it into its own store via
 * {@link listenActiveWorkspace}. Implicit selections elsewhere (adding a
 * workspace, `?ws=` tear-off inheritance, paste-target side effects) stay
 * window-local and never broadcast.
 */

import { emit, listen } from '@tauri-apps/api/event';
import { uiStore } from './stores/ui';

const ACTIVE_WORKSPACE_EVENT = 'active-workspace-changed';

/**
 * Make `dir` the active workspace — in every window by default, or only in
 * this one with `thisWindowOnly` (the context menu's right-click variant).
 */
export function setActiveWorkspace(dir: string, opts?: { thisWindowOnly?: boolean }): void {
  uiStore.getState().setSelectedExplorerDir(dir);
  if (!opts?.thisWindowOnly) {
    void emit(ACTIVE_WORKSPACE_EVENT, { dir }).catch(() => {});
  }
}

/** Follow siblings' all-window activations. Called once at boot (main.tsx). */
export function listenActiveWorkspace(): void {
  void listen<{ dir: string }>(ACTIVE_WORKSPACE_EVENT, (event) => {
    uiStore.getState().setSelectedExplorerDir(event.payload.dir);
  }).catch(() => {});
}
