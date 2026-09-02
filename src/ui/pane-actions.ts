/**
 * The registry of live terminal panes' action runners.
 *
 * A pane resolves its own shortcuts (copy, paste, scroll, zoom) from the
 * keymap. The command palette and the pane's right-click menu have to reach
 * that same code — otherwise "Copy" from the palette and Ctrl+Shift+C would be
 * two implementations of one command — so each pane registers its runner here
 * while it is mounted.
 *
 * Module state rather than a React context: pane ids are globally unique, and
 * a plain map keeps this out of the render path entirely.
 */

import type { ShortcutAction } from './keymap';

/**
 * The terminal actions a PANE services itself. The rest (split, close pane,
 * cycle pane) are layout changes and belong to `terminalsStore`.
 *
 * `terminal-send` has no shortcut: it is how the right-click helpers type a
 * command (`cd …`, `ls`, the agent's launch line) into the pane's pty — raw
 * keystrokes, not a paste, so a shell with bracketed paste on still runs it
 * on the Enter that follows.
 */
export type PaneAction =
  | Extract<
      ShortcutAction,
      | { type: 'terminal-copy' }
      | { type: 'terminal-paste' }
      | { type: 'terminal-select-all' }
      | { type: 'terminal-clear-scrollback' }
      | { type: 'terminal-scroll' }
      | { type: 'font-inc' }
      | { type: 'font-dec' }
      | { type: 'font-reset' }
    >
  | { type: 'terminal-send'; text: string };

const runners = new Map<string, (action: PaneAction) => void>();

/** Register a pane's runner, or drop it by passing null (on unmount). */
export function registerPaneActions(
  paneId: string,
  run: ((action: PaneAction) => void) | null,
): void {
  if (run) {
    runners.set(paneId, run);
  } else {
    runners.delete(paneId);
  }
}

/** Run an action in a pane; false when that pane is no longer mounted. */
export function runPaneAction(paneId: string, action: PaneAction): boolean {
  const run = runners.get(paneId);
  if (!run) {
    return false;
  }
  run(action);
  return true;
}
