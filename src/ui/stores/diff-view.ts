/**
 * Diff-view state — which tabs currently show the inline diff pane (conflict
 * banner "View diff"), each with the on-disk text snapshot read at open time.
 * Transient, never persisted (same contract as uiStore's overlays). The
 * snapshot deliberately does NOT live-update: it shows what the conflict
 * check saw; Reload / Keep mine / a fresh "View diff" refresh reality.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface DiffViewState {
  /** tabId → the on-disk text captured when the diff was opened. */
  byTab: Record<string, { diskText: string }>;
  open: (tabId: string, diskText: string) => void;
  close: (tabId: string) => void;
}

export const diffViewStore = createStore<DiffViewState>()((set) => ({
  byTab: {},

  open(tabId, diskText) {
    set((s) => ({ byTab: { ...s.byTab, [tabId]: { diskText } } }));
  },

  close(tabId) {
    set((s) => {
      if (!(tabId in s.byTab)) {
        return s;
      }
      const byTab = { ...s.byTab };
      delete byTab[tabId];
      return { byTab };
    });
  },
}));

export const useDiffView = <T>(selector: (s: DiffViewState) => T): T =>
  useStore(diffViewStore, selector);
