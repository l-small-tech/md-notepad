/**
 * Live Edit activity store — what the status-bar "Live" chip and the
 * Restore-mine banner show: per tab, when a change from disk was last merged
 * in, how many merges have landed (the chip pulses when this moves), and the
 * author's own lines the last merge overwrote (`lost`), kept until restored
 * or dismissed. Session-only display state; whether a tab IS live comes from
 * settings + the tab (core/live-edit.ts), not here.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { LostBlock } from '../../core/merge';

export interface LiveEditActivity {
  /** Wall-clock ms of the last merge from disk. */
  lastMergeAt: number;
  /** Monotonic per-tab merge counter — the chip keys its pulse animation on it. */
  merges: number;
}

export interface LiveEditState {
  byTab: Record<string, LiveEditActivity>;
  /** Tabs whose last merge replaced lines the local author had written. */
  lost: Record<string, LostBlock[]>;
  recordMerge: (tabId: string, at: number) => void;
  /** Remember (or, with an empty list, clear) the author's overwritten lines. */
  setLost: (tabId: string, blocks: LostBlock[]) => void;
  forget: (tabId: string) => void;
}

export const liveEditStore = createStore<LiveEditState>()((set, get) => ({
  byTab: {},
  lost: {},

  recordMerge(tabId, at) {
    const prev = get().byTab[tabId];
    set({
      byTab: { ...get().byTab, [tabId]: { lastMergeAt: at, merges: (prev?.merges ?? 0) + 1 } },
    });
  },

  setLost(tabId, blocks) {
    const lost = { ...get().lost };
    if (blocks.length === 0) {
      if (!(tabId in lost)) {
        return;
      }
      delete lost[tabId];
    } else {
      lost[tabId] = blocks;
    }
    set({ lost });
  },

  forget(tabId) {
    const s = get();
    if (!(tabId in s.byTab) && !(tabId in s.lost)) {
      return;
    }
    const byTab = { ...s.byTab };
    const lost = { ...s.lost };
    delete byTab[tabId];
    delete lost[tabId];
    set({ byTab, lost });
  },
}));

export const useLiveEditStore = <T>(selector: (s: LiveEditState) => T): T =>
  useStore(liveEditStore, selector);
