/**
 * Which harnesses (and install tools) are actually on this machine.
 *
 * The Settings dialog lists every harness the new-tab row can launch; this
 * store is what lets it dim the ones that would fail to spawn and offer to
 * install them. One `find_programs` round-trip answers for every harness, the
 * custom command's program and the package managers an install line depends
 * on (`INSTALL_TOOLS`), so the dialog never fires a lookup per row.
 *
 * A scan is also what settles an 'auto' harness setting: a fresh install has
 * chosen nothing, so the first scan that finds a harness writes it into
 * settings (`adoptDefaultHarness`) and the new-tab row wears its name.
 *
 * `refresh()` is fire-and-forget and cheap: after React mounts, when the
 * dialog opens, when an install tab closes, and from the Re-check button. A
 * result that arrives after a newer refresh started is dropped — the newest
 * scan is the truth. Android never has a pty, so there it is a no-op and
 * every status stays 'unknown' (the dialog does not show the section anyway).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { HARNESSES, parseCommandLine, pickDefaultHarness } from '../../core/settings';
import { HARNESS_IDS, type HarnessId } from '../../core/types';
import {
  INSTALL_TOOLS,
  installContextFrom,
  type InstallContext,
  type InstallTool,
} from '../../core/harness-install';
import { ipc } from '../../ipc/commands';
import { isAndroid } from '../platform';
import { settingsStore } from './settings';

export type HarnessStatus = 'unknown' | 'installed' | 'missing';

export interface HarnessAvailability {
  status: HarnessStatus;
  /** Where the program resolved, when 'installed'. */
  path: string | null;
}

export const UNKNOWN_AVAILABILITY: HarnessAvailability = { status: 'unknown', path: null };

interface HarnessAvailabilityState {
  harnesses: Record<HarnessId, HarnessAvailability>;
  /** The 'custom' choice's program (`settings.harnessCustomCommand`), when one is configured. */
  custom: HarnessAvailability;
  tools: Record<InstallTool, HarnessAvailability>;
  /** A scan is in flight (the Re-check button says so). */
  checking: boolean;
  /** Harnesses whose install tab is open and not yet found on PATH (the row says "Installing…"). */
  installing: readonly HarnessId[];
  setInstalling: (harness: HarnessId, on: boolean) => void;
  /** Re-scan PATH for every known program. Resolves when the store is updated. */
  refresh: () => Promise<void>;
}

function allUnknown<K extends string>(keys: readonly K[]): Record<K, HarnessAvailability> {
  return Object.fromEntries(keys.map((k) => [k, UNKNOWN_AVAILABILITY])) as Record<
    K,
    HarnessAvailability
  >;
}

/** The program a custom command line names, or null when none is configured. */
export function customProgram(commandLine: string): string | null {
  return parseCommandLine(commandLine).program ?? null;
}

/**
 * Every program one scan asks about: the harnesses' commands, the install
 * tools, and the custom command's program. De-duplicated — a custom command
 * that happens to be `claude` is one lookup, not two.
 */
export function programsToCheck(custom: string | null): string[] {
  const names = new Set<string>();
  for (const id of HARNESS_IDS) {
    names.add(HARNESSES[id].program);
  }
  for (const tool of INSTALL_TOOLS) {
    names.add(tool);
  }
  if (custom) {
    names.add(custom);
  }
  return [...names];
}

/** One program's availability from the scan's answer. */
export function availabilityOf(
  found: Record<string, string | null>,
  program: string,
): HarnessAvailability {
  const path = found[program];
  // A name the scan did not answer for stays unknown rather than becoming
  // "missing" — the command promises a key per name, so this is defensive.
  if (path === undefined) {
    return UNKNOWN_AVAILABILITY;
  }
  return path === null ? { status: 'missing', path: null } : { status: 'installed', path };
}

/** The install policy's view of the tools: present iff found. */
export function installContextOf(tools: Record<InstallTool, HarnessAvailability>): InstallContext {
  return installContextFrom(
    Object.fromEntries(INSTALL_TOOLS.map((t) => [t, tools[t].status === 'installed'])),
  );
}

/**
 * What one harness's row shows. `installable` is whether an install route
 * exists with the tools present (`installCommandFor` non-null).
 */
export interface HarnessRowModel {
  /** Draw the name muted: the harness is not on PATH. */
  dimmed: boolean;
  /** An install tab is open for it: show a pending indicator instead of the Install button. */
  installing: boolean;
  /** Short status beside the name, or null while nothing is known. */
  hint: string | null;
  /** Tooltip for the hint (the full path, which the hint may truncate). */
  title: string | null;
  /** Offer the Install button. */
  install: boolean;
}

export function harnessRowModel(
  availability: HarnessAvailability,
  installable: boolean,
  installing = false,
): HarnessRowModel {
  // Found on PATH is the truth even while the install tab is still open —
  // the install finished; the tab is just the shell it left behind.
  if (installing && availability.status !== 'installed') {
    return {
      dimmed: true,
      installing: true,
      hint: 'Installing… (watching the terminal tab)',
      title: 'This row updates by itself once the command is found on PATH',
      install: false,
    };
  }
  switch (availability.status) {
    case 'unknown':
      return { dimmed: false, installing: false, hint: null, title: null, install: false };
    case 'installed':
      return {
        dimmed: false,
        installing: false,
        hint: `✓ ${availability.path ?? ''}`.trimEnd(),
        title: availability.path,
        install: false,
      };
    case 'missing':
      return {
        dimmed: true,
        installing: false,
        hint: installable ? 'not found on PATH' : 'not found on PATH — install Node.js first',
        title: null,
        install: installable,
      };
  }
}

/** Newest refresh wins: an older scan's answer arriving late is discarded. */
let refreshSeq = 0;

export const harnessAvailabilityStore = createStore<HarnessAvailabilityState>()((set, get) => ({
  harnesses: allUnknown(HARNESS_IDS),
  custom: UNKNOWN_AVAILABILITY,
  tools: allUnknown(INSTALL_TOOLS),
  checking: false,
  installing: [],

  setInstalling(harness, on) {
    const current = get().installing;
    if (on === current.includes(harness)) {
      return;
    }
    set({ installing: on ? [...current, harness] : current.filter((h) => h !== harness) });
  },

  async refresh() {
    // No pty, no terminal section, nothing to check (see `terminalsAvailable`
    // in ui/new-tab.ts — the same predicate, without that module's imports).
    if (isAndroid()) {
      return;
    }
    const seq = ++refreshSeq;
    set({ checking: true });
    const custom = customProgram(settingsStore.getState().settings.harnessCustomCommand);
    let found: Record<string, string | null>;
    try {
      found = await ipc.findPrograms(programsToCheck(custom));
    } catch {
      // The command is desktop-only and infallible in practice; a failure
      // (an old backend) leaves every status as it was.
      if (seq === refreshSeq) {
        set({ checking: false });
      }
      return;
    }
    if (seq !== refreshSeq) {
      return;
    }
    const harnesses = Object.fromEntries(
      HARNESS_IDS.map((id) => [id, availabilityOf(found, HARNESSES[id].program)]),
    ) as Record<HarnessId, HarnessAvailability>;
    set({
      harnesses,
      tools: Object.fromEntries(
        INSTALL_TOOLS.map((tool) => [tool, availabilityOf(found, tool)]),
      ) as Record<InstallTool, HarnessAvailability>,
      custom: custom ? availabilityOf(found, custom) : UNKNOWN_AVAILABILITY,
      checking: false,
    });
    adoptDefaultHarness(harnesses);
  },
}));

/**
 * Settle an 'auto' harness setting against what the scan just found: the
 * first installed harness in preference order becomes the choice, for good.
 *
 * Written into settings (rather than resolved on every read) so the pick is
 * made ONCE — the row's name does not change under the user because a second
 * harness appeared on PATH later — and so the Settings radio shows a real
 * selection. With nothing installed the setting stays 'auto', which is what
 * the new-tab row reads to send the user to Settings instead of spawning a
 * command that is not there.
 */
function adoptDefaultHarness(harnesses: Record<HarnessId, HarnessAvailability>): void {
  const { settings, update } = settingsStore.getState();
  if (settings.harness !== 'auto') {
    return;
  }
  const pick = pickDefaultHarness((id) => harnesses[id].status === 'installed');
  if (pick) {
    update({ harness: pick });
  }
}

/**
 * Is any harness actually launchable — a known one on PATH, or a custom
 * command that resolved? False only when the scan has spoken and found
 * nothing: an unknown status (no scan yet, or Android) counts as launchable,
 * because refusing to open a terminal on a guess is worse than trying.
 */
export function harnessInstalled(state: {
  harnesses: Record<HarnessId, HarnessAvailability>;
  custom: HarnessAvailability;
}): boolean {
  const known = HARNESS_IDS.some((id) => state.harnesses[id].status !== 'missing');
  return known || state.custom.status !== 'missing';
}

export function useHarnessAvailability<T>(selector: (state: HarnessAvailabilityState) => T): T {
  return useStore(harnessAvailabilityStore, selector);
}
