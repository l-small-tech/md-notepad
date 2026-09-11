/**
 * Review-pane state, one `ReviewState` per tab (view · filter · expanded
 * cards · x-ray depths · baseline). The pane (`preview/code-review.ts`) is a
 * DOM projection driven by `pane.setState(...)`, and its taps come back as
 * `ReviewAction`s through `dispatch` — `EditorHost` wires the two. Transient:
 * never persisted, and a tab's entry is dropped by `clear` when the tab
 * closes. Kept out of the tabs store so a tap on a chip never re-renders the
 * TabBar (same reasoning as `preview-nav.ts`).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  DEFAULT_REVIEW_STATE,
  reduceReview,
  type ReviewAction,
  type ReviewBaseline,
  type ReviewExpander,
  type ReviewFilter,
  type ReviewState,
  type ReviewView,
} from '../../core/code/review-state';

export interface CodeReviewStoreState {
  tabs: Record<string, ReviewState>;
  /** Apply one pane action to a tab (creating the tab's entry on first use). */
  dispatch: (tabId: string, action: ReviewAction) => void;
  setView: (tabId: string, view: ReviewView) => void;
  setFilter: (tabId: string, filter: ReviewFilter) => void;
  toggleExpander: (tabId: string, unitId: string, expander: ReviewExpander) => void;
  openXray: (tabId: string, unitId: string, line: number, depth: number) => void;
  setXrayDepth: (tabId: string, unitId: string, depth: number) => void;
  setShowAll: (tabId: string, showAll: boolean) => void;
  setBaseline: (tabId: string, baseline: ReviewBaseline | null) => void;
  /** Forget a tab (it closed). */
  clear: (tabId: string) => void;
}

export const codeReviewStore = createStore<CodeReviewStoreState>()((set, get) => {
  const dispatch = (tabId: string, action: ReviewAction): void => {
    set((s) => {
      const before = s.tabs[tabId] ?? DEFAULT_REVIEW_STATE;
      const after = reduceReview(before, action);
      return after === before && tabId in s.tabs ? s : { tabs: { ...s.tabs, [tabId]: after } };
    });
  };
  return {
    tabs: {},
    dispatch,
    setView: (tabId, view) => dispatch(tabId, { type: 'view', view }),
    setFilter: (tabId, filter) => dispatch(tabId, { type: 'filter', filter }),
    toggleExpander: (tabId, unitId, expander) =>
      dispatch(tabId, { type: 'toggle-expander', unitId, expander }),
    openXray: (tabId, unitId, line, depth) =>
      dispatch(tabId, { type: 'open-xray', unitId, line, depth }),
    setXrayDepth: (tabId, unitId, depth) => dispatch(tabId, { type: 'xray-depth', unitId, depth }),
    setShowAll: (tabId, showAll) => dispatch(tabId, { type: 'show-all', showAll }),
    setBaseline: (tabId, baseline) => dispatch(tabId, { type: 'baseline', baseline }),
    clear(tabId) {
      if (!(tabId in get().tabs)) {
        return;
      }
      set((s) => {
        const tabs = { ...s.tabs };
        delete tabs[tabId];
        return { tabs };
      });
    },
  };
});

/** A tab's review state (the default for a tab that has none yet). */
export function reviewStateFor(tabId: string): ReviewState {
  return codeReviewStore.getState().tabs[tabId] ?? DEFAULT_REVIEW_STATE;
}

export const useCodeReview = <T>(selector: (s: CodeReviewStoreState) => T): T =>
  useStore(codeReviewStore, selector);
