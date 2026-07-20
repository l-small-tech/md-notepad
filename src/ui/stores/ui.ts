/**
 * Transient UI state that is NOT per-document and NOT persisted:
 *
 * - `notice`  — a status-bar message (editor error now; flush errors and the
 *   normalization hint later). Auto-dismisses; never modal (src/ui/README).
 * - `cursor`  — the active editor's caret position, reported by the CM6
 *   adapter. Kept OUT of the tabs store on purpose: caret moves must not
 *   invalidate the tabs array (which would re-render the whole TabBar on
 *   every arrow-key press). Only the focused editor reports, and we accept
 *   reports solely for the currently active tab.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { tabsStore } from './tabs';

export interface CursorReadout {
  line: number;
  col: number;
}

/** Full-screen view stage — see `fullscreenView` below. */
export type FullscreenStage = 'normal' | 'window' | 'screen';

/**
 * Work-area split (tab context menu → Split right / Split down). `tabId` is
 * the tab PINNED into the secondary pane; the tab strip keeps driving the
 * primary pane exactly as before. `'right'` puts the pinned pane beside the
 * primary (vertical divider), `'down'` below it (horizontal divider).
 * Session-only, like the explorer width — not persisted.
 */
export interface WorkSplit {
  tabId: string;
  orientation: 'right' | 'down';
}

export interface UiState {
  notice: string | null;
  cursor: CursorReadout | null;
  /** The settings dialog (Ctrl+,) is open (M6). Transient, never persisted. */
  settingsOpen: boolean;
  /** The left-side file explorer drawer is open. Transient, never persisted. */
  explorerOpen: boolean;
  /**
   * Directory currently hovered by an OS file drag (main.tsx hit-tests the
   * Tauri drag-drop events), or null. Drives the explorer's drop highlight.
   */
  dropTargetDir: string | null;
  /** Bumped whenever files were written into a workspace outside the tab flow
   *  (paste/drop) so the explorer re-lists. */
  explorerRefresh: number;
  /**
   * Full screen (any mode), in two stages: 'window' hides all app chrome but
   * keeps the window as-is; 'screen' additionally makes the OS window
   * fullscreen. Only the value lives here — the window-API side effect is
   * owned by `../fullscreen`, which is the only writer.
   */
  fullscreenView: FullscreenStage;
  /** Work-area split, or null when the work area is a single pane. */
  workSplit: WorkSplit | null;
  /** Show a status-bar notice that auto-clears after `ms` (default 6s). */
  showNotice: (message: string, ms?: number) => void;
  clearNotice: () => void;
  /** Adapter → UI. Ignored unless `tabId` is the active tab. */
  reportCursor: (tabId: string, cursor: CursorReadout) => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleExplorer: () => void;
  setDropTarget: (dir: string | null) => void;
  refreshExplorer: () => void;
  setFullscreenView: (stage: FullscreenStage) => void;
  setWorkSplit: (split: WorkSplit | null) => void;
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const uiStore = createStore<UiState>()((set) => ({
  notice: null,
  cursor: null,
  settingsOpen: false,
  explorerOpen: false,
  dropTargetDir: null,
  explorerRefresh: 0,
  fullscreenView: 'normal',
  workSplit: null,

  showNotice(message, ms = 6000) {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
    }
    set({ notice: message });
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      set({ notice: null });
    }, ms);
  },

  clearNotice() {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    set({ notice: null });
  },

  reportCursor(tabId, cursor) {
    if (tabsStore.getState().activeTabId !== tabId) {
      return;
    }
    set({ cursor });
  },

  openSettings() {
    set({ settingsOpen: true });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  toggleExplorer() {
    set((s) => ({ explorerOpen: !s.explorerOpen }));
  },

  setDropTarget(dir) {
    // Drag-over events fire continuously; only re-render on actual change.
    set((s) => (s.dropTargetDir === dir ? s : { dropTargetDir: dir }));
  },

  refreshExplorer() {
    set((s) => ({ explorerRefresh: s.explorerRefresh + 1 }));
  },

  setFullscreenView(stage) {
    set({ fullscreenView: stage });
  },

  setWorkSplit(split) {
    set({ workSplit: split });
  },
}));

/**
 * Split a tab into the secondary work-area pane. If the tab is currently the
 * active (primary) one, the primary hands off to a neighbor first — one tab
 * can never show in both panes (each tab has exactly one mounted editor, I7).
 * With a single open tab there is nothing to pair it with, so this no-ops
 * (the menu hides the Split items in that case too).
 */
export function splitTab(tabId: string, orientation: WorkSplit['orientation']): void {
  const ts = tabsStore.getState();
  const idx = ts.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) {
    return;
  }
  if (ts.activeTabId === tabId) {
    const neighbor = ts.tabs[idx + 1] ?? ts.tabs[idx - 1];
    if (!neighbor) {
      return;
    }
    ts.activateTab(neighbor.id);
  }
  uiStore.getState().setWorkSplit({ tabId, orientation });
}

/**
 * Keep the split coherent as tabs come and go:
 *  - the pinned tab was closed/detached → drop the split;
 *  - the pinned tab became the ACTIVE tab (tab-strip click, Ctrl+Tab, …) →
 *    swap panes, pinning the previously active tab instead, so the selection
 *    is honored in the primary pane without ever double-mounting a tab. If
 *    the previous active tab is gone too, drop the split.
 */
let lastActiveTabId = tabsStore.getState().activeTabId;
tabsStore.subscribe((ts) => {
  const prevActive = lastActiveTabId;
  lastActiveTabId = ts.activeTabId;
  const split = uiStore.getState().workSplit;
  if (!split) {
    return;
  }
  if (!ts.tabs.some((t) => t.id === split.tabId)) {
    uiStore.getState().setWorkSplit(null);
    return;
  }
  if (ts.activeTabId === split.tabId) {
    const prevStillOpen = prevActive !== split.tabId && ts.tabs.some((t) => t.id === prevActive);
    uiStore.getState().setWorkSplit(prevStillOpen ? { ...split, tabId: prevActive } : null);
  }
});

export const useUiStore = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
