/**
 * Opening a terminal tab, with the working directory a user expects.
 *
 * "Another one of these" is the whole point of the inheritance rule: from a
 * terminal, a new one starts where that shell is standing (its OSC 7 cwd);
 * from a document, it starts in that document's folder. A profile that names
 * its own `cwd` overrides both — that decision lives in `TerminalPane`, which
 * is where the spawn actually happens.
 */

import { dirName } from '../core/session/plan-flush';
import { tabsStore } from './stores/tabs';
import { activePaneOf } from './stores/terminals';
import { settingsStore } from './stores/settings';
import { isAndroid } from './platform';

/** The directory a new terminal should start in, or null to inherit the app's. */
export function inheritedCwd(): string | null {
  const store = tabsStore.getState();
  const tab = store.activeTab();
  if (!tab) {
    return null;
  }
  if (tab.kind === 'terminal') {
    return activePaneOf(tab.id)?.cwd ?? null;
  }
  const path = tab.filePath ?? tab.notePath;
  return path ? dirName(path) || null : null;
}

/**
 * Open a terminal tab. No-op on Android, which has no pty — callers may still
 * call it unconditionally.
 */
export function openTerminal(profileId?: string): string | null {
  if (isAndroid()) {
    return null;
  }
  const settings = settingsStore.getState().settings;
  return tabsStore.getState().openTerminalTab({
    profileId: profileId ?? settings.defaultTerminalProfile,
    cwd: inheritedCwd(),
  });
}
