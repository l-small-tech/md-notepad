/**
 * Preview in-pane navigation state, surfaced OUT of the preview pane so the
 * fullscreen control cluster (App.tsx) can host the Back button alongside the
 * exit/stage buttons. Kept in its own tiny store — NOT the tabs store — so a
 * followed-link change never re-renders the TabBar (same reasoning as `cursor`
 * in ui.ts).
 *
 * `canGoBack` is reactive (drives whether the cluster shows a Back button); the
 * `goBack` callbacks are plain functions with the pane's lifetime, so they live
 * in a module map rather than reactive state.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

interface PreviewNavState {
  /** tabId → can the active preview pop a followed-link page? */
  canGoBack: Record<string, boolean>;
  setCanGoBack: (tabId: string, value: boolean) => void;
  clear: (tabId: string) => void;
}

export const previewNavStore = createStore<PreviewNavState>()((set) => ({
  canGoBack: {},
  setCanGoBack(tabId, value) {
    set((s) =>
      s.canGoBack[tabId] === value ? s : { canGoBack: { ...s.canGoBack, [tabId]: value } },
    );
  },
  clear(tabId) {
    set((s) => {
      if (!(tabId in s.canGoBack)) {
        return s;
      }
      const next = { ...s.canGoBack };
      delete next[tabId];
      return { canGoBack: next };
    });
  },
}));

const goBackFns = new Map<string, () => void>();

export function registerPreviewGoBack(tabId: string, goBack: () => void): void {
  goBackFns.set(tabId, goBack);
}

export function unregisterPreviewGoBack(tabId: string): void {
  goBackFns.delete(tabId);
}

/** Pop the active preview's followed-link page, if one is registered. */
export function goBackPreview(tabId: string): void {
  goBackFns.get(tabId)?.();
}

export const usePreviewNav = <T>(selector: (s: PreviewNavState) => T): T =>
  useStore(previewNavStore, selector);
