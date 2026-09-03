/**
 * The Settings dialog's **Install** button: open a plain shell tab and type
 * the harness's install command into it.
 *
 * Deliberately not a hidden subprocess. The user sees the exact command,
 * answers any prompt the installer puts up (a UAC dialog, a license, a
 * `sudo` password), and is left standing in a working shell afterwards. The
 * command itself is pure policy in core/harness-install.ts; this file only picks
 * the shell it will run in, opens the tab, and watches PATH while that tab
 * is open so the harness's row flips from "Installing…" to installed by
 * itself — the user need not recognise what a finished install looks like.
 */

import { resolveTerminalProfile, terminalProgram } from '../core/settings';
import { installCommandFor, installShellFor } from '../core/harness-install';
import { SHELL_PROFILE_ID, type HarnessId } from '../core/types';
import { getDefaultWorkspacePath } from './session';
import { desktopOs, isAndroid } from './platform';
import { defaultShellStore } from './stores/default-shell';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import { installContextOf, harnessAvailabilityStore } from './stores/harness-availability';
import { openTerminal } from './terminal-open';

/**
 * The profile the install runs in: the stock shell profile, else whatever
 * "New terminal" opens. A profile is used (rather than a bare shell) so the
 * user's shell choice, environment and font apply exactly as they do to any
 * other terminal tab.
 */
function shellProfileId(): string {
  const settings = settingsStore.getState().settings;
  return settings.terminalProfiles.some((p) => p.id === SHELL_PROFILE_ID)
    ? SHELL_PROFILE_ID
    : settings.defaultTerminalProfile;
}

/**
 * The program that shell profile will actually spawn: its own, the app-wide
 * shell setting, or — when that is automatic — what the backend picks.
 */
async function shellProgram(profileId: string): Promise<string | null> {
  const settings = settingsStore.getState().settings;
  const explicit = terminalProgram(settings, resolveTerminalProfile(settings, profileId));
  if (explicit) {
    return explicit;
  }
  // The same cached answer the Settings dialog and terminal panes use.
  return defaultShellStore.getState().resolve();
}

/** Run `onClose` once the tab with this id is gone from the tab strip. */
export function whenTabCloses(tabId: string, onClose: () => void): () => void {
  const unsubscribe = tabsStore.subscribe((state) => {
    if (!state.tabs.some((t) => t.id === tabId)) {
      unsubscribe();
      onClose();
    }
  });
  return unsubscribe;
}

/**
 * Open a shell tab running the install command for `harness`. Returns the tab
 * id, or null when there is no route (the button is not shown then) or no
 * terminal can exist (Android).
 */
export async function installHarness(harness: HarnessId): Promise<string | null> {
  if (isAndroid()) {
    return null;
  }
  const os = desktopOs();
  const profileId = shellProfileId();
  const shell = installShellFor(await shellProgram(profileId), os);
  const ctx = installContextOf(harnessAvailabilityStore.getState().tools);
  const command = installCommandFor(harness, os, ctx, shell);
  if (!command) {
    return null;
  }
  // The default workspace, not the explorer selection: an install has nothing
  // to do with whichever folder happens to be highlighted.
  const tabId = openTerminal(profileId, getDefaultWorkspacePath() ?? undefined, {
    initialInput: command,
  });
  if (tabId) {
    watchInstall(harness, tabId);
  }
  return tabId;
}

/** How often PATH is re-scanned while an install tab is open. */
export const INSTALL_POLL_MS = 2000;

/**
 * Mark `harness` as installing and re-scan PATH every `INSTALL_POLL_MS` until
 * it is found (the row shows ✓) or the tab is closed (the row goes back to
 * offering Install). One last scan runs on close, as before.
 */
export function watchInstall(harness: HarnessId, tabId: string): void {
  const store = harnessAvailabilityStore;
  store.getState().setInstalling(harness, true);
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    clearInterval(timer);
    unsubscribeTab();
    unsubscribeStore();
    store.getState().setInstalling(harness, false);
  };
  const timer = setInterval(() => {
    if (!store.getState().checking) {
      void store.getState().refresh();
    }
  }, INSTALL_POLL_MS);
  const unsubscribeStore = store.subscribe((state) => {
    if (state.harnesses[harness].status === 'installed') {
      finish();
    }
  });
  const unsubscribeTab = whenTabCloses(tabId, () => {
    finish();
    void store.getState().refresh();
  });
}
