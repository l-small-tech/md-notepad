/**
 * Which AI TUI agents (and install tools) are actually on this machine.
 *
 * The Settings dialog lists every agent the AI row can launch; this store is
 * what lets it dim the ones that would fail to spawn and offer to install
 * them. One `find_programs` round-trip answers for every agent, the custom
 * command's program and the package managers an install line depends on
 * (`INSTALL_TOOLS`), so the dialog never fires a lookup per row.
 *
 * `refresh()` is fire-and-forget and cheap: after React mounts, when the
 * dialog opens, when an install tab closes, and from the Re-check button. A
 * result that arrives after a newer refresh started is dropped — the newest
 * scan is the truth. Android never has a pty, so there it is a no-op and
 * every status stays 'unknown' (the dialog does not show the section anyway).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { AI_TUI_AGENTS, parseCommandLine } from '../../core/settings';
import { AI_TUI_AGENT_IDS, type AiTuiAgentId } from '../../core/types';
import {
  INSTALL_TOOLS,
  installContextFrom,
  type InstallContext,
  type InstallTool,
} from '../../core/tui-install';
import { ipc } from '../../ipc/commands';
import { isAndroid } from '../platform';
import { settingsStore } from './settings';

export type TuiStatus = 'unknown' | 'installed' | 'missing';

export interface TuiAvailability {
  status: TuiStatus;
  /** Where the program resolved, when 'installed'. */
  path: string | null;
}

export const UNKNOWN_AVAILABILITY: TuiAvailability = { status: 'unknown', path: null };

interface TuiAvailabilityState {
  agents: Record<AiTuiAgentId, TuiAvailability>;
  /** The 'custom' choice's program (`settings.aiTuiCustomCommand`), when one is configured. */
  custom: TuiAvailability;
  tools: Record<InstallTool, TuiAvailability>;
  /** A scan is in flight (the Re-check button says so). */
  checking: boolean;
  /** Re-scan PATH for every known program. Resolves when the store is updated. */
  refresh: () => Promise<void>;
}

function allUnknown<K extends string>(keys: readonly K[]): Record<K, TuiAvailability> {
  return Object.fromEntries(keys.map((k) => [k, UNKNOWN_AVAILABILITY])) as Record<
    K,
    TuiAvailability
  >;
}

/** The program a custom command line names, or null when none is configured. */
export function customProgram(commandLine: string): string | null {
  return parseCommandLine(commandLine).program ?? null;
}

/**
 * Every program one scan asks about: the agents' commands, the install tools,
 * and the custom command's program. De-duplicated — a custom command that
 * happens to be `claude` is one lookup, not two.
 */
export function programsToCheck(custom: string | null): string[] {
  const names = new Set<string>();
  for (const id of AI_TUI_AGENT_IDS) {
    names.add(AI_TUI_AGENTS[id].program);
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
): TuiAvailability {
  const path = found[program];
  // A name the scan did not answer for stays unknown rather than becoming
  // "missing" — the command promises a key per name, so this is defensive.
  if (path === undefined) {
    return UNKNOWN_AVAILABILITY;
  }
  return path === null ? { status: 'missing', path: null } : { status: 'installed', path };
}

/** The install policy's view of the tools: present iff found. */
export function installContextOf(tools: Record<InstallTool, TuiAvailability>): InstallContext {
  return installContextFrom(
    Object.fromEntries(INSTALL_TOOLS.map((t) => [t, tools[t].status === 'installed'])),
  );
}

/**
 * What one agent's row shows. `installable` is whether an install route
 * exists with the tools present (`installCommandFor` non-null).
 */
export interface AgentRowModel {
  /** Draw the name muted: the agent is not on PATH. */
  dimmed: boolean;
  /** Short status beside the name, or null while nothing is known. */
  hint: string | null;
  /** Tooltip for the hint (the full path, which the hint may truncate). */
  title: string | null;
  /** Offer the Install button. */
  install: boolean;
}

export function agentRowModel(availability: TuiAvailability, installable: boolean): AgentRowModel {
  switch (availability.status) {
    case 'unknown':
      return { dimmed: false, hint: null, title: null, install: false };
    case 'installed':
      return {
        dimmed: false,
        hint: `✓ ${availability.path ?? ''}`.trimEnd(),
        title: availability.path,
        install: false,
      };
    case 'missing':
      return {
        dimmed: true,
        hint: installable ? 'not found on PATH' : 'not found on PATH — install Node.js first',
        title: null,
        install: installable,
      };
  }
}

/** Newest refresh wins: an older scan's answer arriving late is discarded. */
let refreshSeq = 0;

export const tuiAvailabilityStore = createStore<TuiAvailabilityState>()((set) => ({
  agents: allUnknown(AI_TUI_AGENT_IDS),
  custom: UNKNOWN_AVAILABILITY,
  tools: allUnknown(INSTALL_TOOLS),
  checking: false,

  async refresh() {
    // No pty, no terminal section, nothing to check (see `terminalsAvailable`
    // in ui/new-tab.ts — the same predicate, without that module's imports).
    if (isAndroid()) {
      return;
    }
    const seq = ++refreshSeq;
    set({ checking: true });
    const custom = customProgram(settingsStore.getState().settings.aiTuiCustomCommand);
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
    set({
      agents: Object.fromEntries(
        AI_TUI_AGENT_IDS.map((id) => [id, availabilityOf(found, AI_TUI_AGENTS[id].program)]),
      ) as Record<AiTuiAgentId, TuiAvailability>,
      tools: Object.fromEntries(
        INSTALL_TOOLS.map((tool) => [tool, availabilityOf(found, tool)]),
      ) as Record<InstallTool, TuiAvailability>,
      custom: custom ? availabilityOf(found, custom) : UNKNOWN_AVAILABILITY,
      checking: false,
    });
  },
}));

export function useTuiAvailability<T>(selector: (state: TuiAvailabilityState) => T): T {
  return useStore(tuiAvailabilityStore, selector);
}
