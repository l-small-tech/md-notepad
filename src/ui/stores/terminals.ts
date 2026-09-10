/**
 * Terminal tabs: pane trees and per-pane state.
 *
 * Deliberately NOT part of the tabs store. That store is the document model,
 * and every OSC-title change a shell emits (`cd` on a themed prompt does it
 * per command) would otherwise churn the tab array and re-render the whole
 * TabBar. Here it re-renders one pane's header instead.
 *
 * The split layout itself is `core/panes.ts` — a pure, immutable binary tree
 * with its own test suite. This store owns only the *identity* of things:
 * which tab has which tree, which pane is focused, what each pane's shell has
 * told us about itself. The ptys live in the components (one pane element,
 * one pty, for the element's whole life); nothing here holds a handle.
 *
 * Ids are allocated here so a restored tree and a freshly split one look the
 * same to everyone downstream: `p<n>` for panes, `s<n>` for splits.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  clampRatio,
  leaf,
  neighborPane,
  normalizePaneTree,
  paneIds,
  removePane,
  setSplitRatio,
  splitPane,
  type PaneNode,
  type SplitDirection,
} from '../../core/panes';
import type { TerminalSnapshot } from '../../core/types';

/** What one live pane knows about itself. */
export interface TerminalPaneState {
  id: string;
  tabId: string;
  /** Which `TerminalProfile` this pane was launched from. */
  profileId: string;
  /** The shell's OSC 0/2 title, or null before it sets one. */
  title: string | null;
  /** The shell's OSC 7 working directory, or null if it never reported one. */
  cwd: string | null;
  /** The child exited (the pane is only still here because onExit = 'keep'). */
  exited: boolean;
  exitCode: number | null;
  /**
   * Text to type into the shell once, as soon as it is ready — the Settings
   * dialog's **Install** button opens a shell and has it run the install
   * command this way, so the user sees the exact line and keeps the shell
   * afterwards. Transient: the pane clears it after writing, a split does not
   * inherit it, and `snapshot` never records it (a restored terminal is a new
   * shell, not a replay).
   */
  initialInput: string | null;
  /**
   * The pty this pane is talking to, reported by the pane once its shell is
   * running (null before that, and for a pane whose spawn failed). The store
   * holds the id, never the handle — so a handover snapshot can name the
   * shell without anyone here being able to write to it.
   */
  ptyId: number | null;
  /**
   * An EXISTING pty this pane should attach to instead of spawning: set when
   * the pane was adopted from another window with its tab (`openSession` from
   * a handover snapshot). Transient — the pane clears it once it has
   * attached, so a later remount spawns a shell like any other pane.
   */
  adoptPtyId: number | null;
}

/**
 * Panes whose pty is being handed to another window rather than closed.
 *
 * `closeSession` removes a pane's record before its element unmounts, so the
 * unmounting pane has nowhere left to ask "was I released, or closed?" — this
 * set is that answer, written by `releaseSession` and consumed once by the
 * pane's cleanup. A released pane detaches from its pty; a closed one kills it.
 */
const released = new Set<string>();

/** True once, for a pane whose session was released (see the set above). */
export function consumePaneRelease(paneId: string): boolean {
  return released.delete(paneId);
}

export interface TerminalSession {
  tree: PaneNode;
  activePaneId: string;
}

export interface OpenSessionInit {
  profileId: string;
  /** Inherited working directory for the first pane. */
  cwd?: string | null;
  /** A restored layout; when present it wins over profileId/cwd. */
  snapshot?: TerminalSnapshot | null;
  /** A line to type into the first pane's shell once it is ready (see `TerminalPaneState`). */
  initialInput?: string | null;
}

interface TerminalsState {
  /** tabId → its layout. A tab with no entry has not been opened yet. */
  sessions: Record<string, TerminalSession>;
  /** paneId → pane state, flat across every tab (pane ids are unique). */
  panes: Record<string, TerminalPaneState>;

  openSession: (tabId: string, init: OpenSessionInit) => void;
  closeSession: (tabId: string) => void;
  /**
   * Let go of a tab's panes WITHOUT killing their shells — the tab is moving
   * to another window, which attaches to the same ptys. Otherwise identical
   * to `closeSession`.
   */
  releaseSession: (tabId: string) => void;

  splitActivePane: (tabId: string, direction: SplitDirection) => void;
  /** Close one pane. Returns true when that emptied the tab. */
  closePane: (paneId: string) => boolean;
  focusPane: (tabId: string, paneId: string) => void;
  cyclePane: (tabId: string, delta: number) => void;
  setRatio: (tabId: string, splitId: string, ratio: number) => void;

  setPaneTitle: (paneId: string, title: string) => void;
  setPaneCwd: (paneId: string, cwd: string) => void;
  markExited: (paneId: string, code: number) => void;
  /** The pane wrote its `initialInput`; forget it so nothing can type it twice. */
  clearInitialInput: (paneId: string) => void;
  /** The pane's shell is live on this pty (null when it is gone). */
  setPanePty: (paneId: string, ptyId: number | null) => void;
  /** The pane attached to its adopted pty; forget it so a remount spawns instead. */
  clearAdoptPtyId: (paneId: string) => void;

  /**
   * The persistable layout, or null for a tab with no session. With
   * `handover`, each pane also names its live pty (see `TerminalSnapshot`) —
   * for a tab moving to another window, never for the manifest on disk.
   */
  snapshot: (tabId: string, opts?: { handover?: boolean }) => TerminalSnapshot | null;
}

let counter = 0;
const nextPaneId = (): string => `p${(counter += 1)}`;
const nextSplitId = (): string => `s${(counter += 1)}`;

/** Test hook: makes generated ids deterministic from the start of a case. */
export function resetTerminalIds(): void {
  counter = 0;
  released.clear();
}

function makePane(
  id: string,
  tabId: string,
  profileId: string,
  cwd?: string | null,
  initialInput?: string | null,
) {
  return {
    id,
    tabId,
    profileId,
    title: null,
    cwd: cwd ?? null,
    exited: false,
    exitCode: null,
    initialInput: initialInput || null,
    ptyId: null,
    adoptPtyId: null,
  } satisfies TerminalPaneState;
}

/** Drop every pane belonging to `tabId` from the flat pane map. */
function withoutTab(
  panes: Record<string, TerminalPaneState>,
  tabId: string,
): Record<string, TerminalPaneState> {
  const out: Record<string, TerminalPaneState> = {};
  for (const [id, pane] of Object.entries(panes)) {
    if (pane.tabId !== tabId) {
      out[id] = pane;
    }
  }
  return out;
}

export const terminalsStore = createStore<TerminalsState>()((set, get) => ({
  sessions: {},
  panes: {},

  openSession(tabId, init) {
    if (get().sessions[tabId]) {
      return;
    }
    const snapshot = init.snapshot ?? null;
    if (snapshot) {
      // Stored ids are renamed on the way in: two windows restoring the same
      // manifest (M8 tear-off) would otherwise share pane ids, and the flat
      // pane map is global.
      const renamed = new Map<string, string>();
      const tree = normalizePaneTree(
        snapshot.tree,
        (stored) => {
          const fresh = nextPaneId();
          renamed.set(stored, fresh);
          return fresh;
        },
        nextSplitId,
      );
      if (tree) {
        const byStoredId = new Map(snapshot.panes.map((p) => [p.id, p]));
        const panes: Record<string, TerminalPaneState> = { ...get().panes };
        for (const [stored, fresh] of renamed) {
          const record = byStoredId.get(stored);
          panes[fresh] = {
            ...makePane(fresh, tabId, record?.profileId ?? init.profileId, record?.cwd),
            // A handover snapshot names a shell that is still running; the
            // pane attaches to it instead of starting a new one.
            adoptPtyId: record?.ptyId ?? null,
          };
        }
        const active = renamed.get(snapshot.activePaneId) ?? paneIds(tree)[0]!;
        set({ sessions: { ...get().sessions, [tabId]: { tree, activePaneId: active } }, panes });
        return;
      }
      // An unreadable tree degrades to one fresh pane rather than no tab.
    }
    const id = nextPaneId();
    set({
      sessions: { ...get().sessions, [tabId]: { tree: leaf(id), activePaneId: id } },
      panes: {
        ...get().panes,
        [id]: makePane(id, tabId, init.profileId, init.cwd, init.initialInput),
      },
    });
  },

  closeSession(tabId) {
    const { [tabId]: existing, ...sessions } = get().sessions;
    if (!existing) {
      return;
    }
    set({ sessions, panes: withoutTab(get().panes, tabId) });
  },

  releaseSession(tabId) {
    const session = get().sessions[tabId];
    if (!session) {
      return;
    }
    for (const id of paneIds(session.tree)) {
      released.add(id);
    }
    get().closeSession(tabId);
  },

  splitActivePane(tabId, direction) {
    const session = get().sessions[tabId];
    if (!session) {
      return;
    }
    const source = get().panes[session.activePaneId];
    const newId = nextPaneId();
    const tree = splitPane(session.tree, session.activePaneId, {
      direction,
      newId,
      splitId: nextSplitId(),
    });
    if (tree === session.tree) {
      return;
    }
    set({
      sessions: { ...get().sessions, [tabId]: { tree, activePaneId: newId } },
      panes: {
        ...get().panes,
        // A split inherits the pane it grew out of — same profile, same cwd —
        // which is what "another one of these, next to it" means.
        [newId]: makePane(newId, tabId, source?.profileId ?? '', source?.cwd),
      },
    });
  },

  closePane(paneId) {
    const pane = get().panes[paneId];
    const session = pane ? get().sessions[pane.tabId] : undefined;
    if (!pane || !session) {
      return false;
    }
    const tree = removePane(session.tree, paneId);
    if (!tree) {
      // The last pane: the caller closes the tab, which calls closeSession.
      return true;
    }
    const { [paneId]: _closed, ...panes } = get().panes;
    const remaining = paneIds(tree);
    set({
      sessions: {
        ...get().sessions,
        [pane.tabId]: {
          tree,
          activePaneId: remaining.includes(session.activePaneId)
            ? session.activePaneId
            : remaining[0]!,
        },
      },
      panes,
    });
    return false;
  },

  focusPane(tabId, paneId) {
    const session = get().sessions[tabId];
    if (!session || session.activePaneId === paneId || !get().panes[paneId]) {
      return;
    }
    set({ sessions: { ...get().sessions, [tabId]: { ...session, activePaneId: paneId } } });
  },

  cyclePane(tabId, delta) {
    const session = get().sessions[tabId];
    if (!session) {
      return;
    }
    const next = neighborPane(session.tree, session.activePaneId, delta);
    if (next === session.activePaneId) {
      return;
    }
    set({ sessions: { ...get().sessions, [tabId]: { ...session, activePaneId: next } } });
  },

  setRatio(tabId, splitId, ratio) {
    const session = get().sessions[tabId];
    if (!session) {
      return;
    }
    const tree = setSplitRatio(session.tree, splitId, clampRatio(ratio));
    if (tree === session.tree) {
      return;
    }
    set({ sessions: { ...get().sessions, [tabId]: { ...session, tree } } });
  },

  setPaneTitle(paneId, title) {
    const pane = get().panes[paneId];
    if (!pane || pane.title === title) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, title } } });
  },

  setPaneCwd(paneId, cwd) {
    const pane = get().panes[paneId];
    if (!pane || pane.cwd === cwd) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, cwd } } });
  },

  markExited(paneId, code) {
    const pane = get().panes[paneId];
    if (!pane || pane.exited) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, exited: true, exitCode: code } } });
  },

  clearInitialInput(paneId) {
    const pane = get().panes[paneId];
    if (!pane || pane.initialInput === null) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, initialInput: null } } });
  },

  setPanePty(paneId, ptyId) {
    const pane = get().panes[paneId];
    if (!pane || pane.ptyId === ptyId) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, ptyId } } });
  },

  clearAdoptPtyId(paneId) {
    const pane = get().panes[paneId];
    if (!pane || pane.adoptPtyId === null) {
      return;
    }
    set({ panes: { ...get().panes, [paneId]: { ...pane, adoptPtyId: null } } });
  },

  snapshot(tabId, opts) {
    const session = get().sessions[tabId];
    if (!session) {
      return null;
    }
    const panes = get().panes;
    return {
      tree: session.tree,
      activePaneId: session.activePaneId,
      // Scrollback is deliberately absent: a RESTORED terminal respawns its
      // shell, it does not resurrect the old one's output. A handover is the
      // other case — the shell never died, so the pty id travels instead and
      // the backend replays to the window that attaches.
      panes: paneIds(session.tree).flatMap((id) => {
        const pane = panes[id];
        return pane
          ? [
              {
                id,
                profileId: pane.profileId,
                ...(pane.cwd ? { cwd: pane.cwd } : {}),
                ...(opts?.handover && pane.ptyId !== null ? { ptyId: pane.ptyId } : {}),
              },
            ]
          : [];
      }),
    };
  },
}));

export function useTerminalsStore<T>(selector: (state: TerminalsState) => T): T {
  return useStore(terminalsStore, selector);
}

/** The pane a tab's keyboard goes to, or null when the tab has no session. */
export function activePaneOf(tabId: string): TerminalPaneState | null {
  const state = terminalsStore.getState();
  const session = state.sessions[tabId];
  return session ? (state.panes[session.activePaneId] ?? null) : null;
}

/**
 * The working directory a terminal TAB is "in": its focused pane's cwd (the
 * last OSC 7 the shell sent, or the directory it was spawned in), or null
 * when the tab has no session or the pane never learned one. A selector, so
 * the tabs store can mirror it onto the tab entry and the strip can color a
 * terminal by the workspace it is standing in.
 */
export function activePaneCwd(state: Pick<TerminalsState, 'sessions' | 'panes'>, tabId: string) {
  const session = state.sessions[tabId];
  return session ? (state.panes[session.activePaneId]?.cwd ?? null) : null;
}
