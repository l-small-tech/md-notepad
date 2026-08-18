/**
 * Executing a `NewTabChoice`. The decision itself is pure and lives in
 * `core/new-tab.ts`; this is the one place it becomes an action, so the "+"
 * button, mod+N and the command palette all take the same path.
 */

import { defaultNewTabChoice, type NewTabChoice } from '../core/new-tab';
import { createWhiteboard } from './session';
import { tabsStore } from './stores/tabs';
import { isAndroid } from './platform';
import { openTerminal } from './terminal-open';

/** True where a terminal tab can exist at all (everywhere but Android). */
export function terminalsAvailable(): boolean {
  return !isAndroid();
}

/** What a plain "+" / mod+N makes right now. */
export function currentNewTabChoice(): NewTabChoice {
  return defaultNewTabChoice(tabsStore.getState().activeTab() ?? null, terminalsAvailable());
}

export function runNewTabChoice(choice: NewTabChoice): void {
  switch (choice) {
    case 'terminal':
      openTerminal();
      return;
    case 'drawing':
      void createWhiteboard();
      return;
    case 'note':
      tabsStore.getState().newTab();
      return;
  }
}

/** "+" with no modifier, and mod+N: another one of whatever is in front. */
export function newTabDefault(): void {
  runNewTabChoice(currentNewTabChoice());
}
