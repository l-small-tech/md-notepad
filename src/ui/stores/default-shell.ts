/**
 * What "Automatic" resolves to: the shell Rust picks when a profile names no
 * program (`src-tauri/src/shell.rs`). Two places need the answer — the
 * Settings dialog labels its Auto row with it ("Auto (pwsh)"), and a terminal
 * pane needs it BEFORE spawning to know which shell integration to inject —
 * so it is asked once and cached here rather than fetched by each.
 *
 * The answer cannot change while the app runs (it depends on what is
 * installed), so there is no invalidation; a failed request is simply retried
 * by the next caller.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { getPtyProvider } from '../../ipc/pty';

export interface DefaultShellState {
  /** The program AUTO spawns on this machine, or null until the backend has answered. */
  program: string | null;
  /** The answer, asking the backend on the first call; concurrent callers share one request. */
  resolve: () => Promise<string | null>;
}

let inflight: Promise<string | null> | null = null;

export const defaultShellStore = createStore<DefaultShellState>()((set, get) => ({
  program: null,

  resolve() {
    const known = get().program;
    if (known !== null) {
      return Promise.resolve(known);
    }
    inflight ??= getPtyProvider()
      .defaultShell()
      .then(
        (program) => {
          set({ program });
          return program;
        },
        // No pty backend (a browser dev session, Android) — nothing to cache.
        () => null,
      )
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
}));

/** Test hook: forget the cached answer and any request in flight. */
export function resetDefaultShell(): void {
  inflight = null;
  defaultShellStore.setState({ program: null });
}

export const useDefaultShell = (): string | null => useStore(defaultShellStore, (s) => s.program);
