/**
 * Live Edit activity store — what the status-bar "Live" chip shows: per tab,
 * when a change from disk was last merged in, how many merges have landed
 * (the chip pulses when this moves) and whether the last one had to keep
 * both versions of an overlapping edit. Session-only display state; whether a
 * tab IS live comes from settings + the tab (core/live-edit.ts), not here.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface LiveEditActivity {
  /** Wall-clock ms of the last merge from disk. */
  lastMergeAt: number;
  /** Monotonic per-tab merge counter — the chip keys its pulse animation on it. */
  merges: number;
  /** The last merge kept both sides of an overlapping edit. */
  overlapped: boolean;
}

export interface LiveEditState {
  byTab: Record<string, LiveEditActivity>;
  recordMerge: (tabId: string, at: number, overlapped: boolean) => void;
  forget: (tabId: string) => void;
}

export const liveEditStore = createStore<LiveEditState>()((set, get) => ({
  byTab: {},

  recordMerge(tabId, at, overlapped) {
    const prev = get().byTab[tabId];
    set({
      byTab: {
        ...get().byTab,
        [tabId]: { lastMergeAt: at, merges: (prev?.merges ?? 0) + 1, overlapped },
      },
    });
  },

  forget(tabId) {
    if (!(tabId in get().byTab)) {
      return;
    }
    const next = { ...get().byTab };
    delete next[tabId];
    set({ byTab: next });
  },
}));

export const useLiveEditStore = <T>(selector: (s: LiveEditState) => T): T =>
  useStore(liveEditStore, selector);
