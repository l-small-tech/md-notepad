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

/** Read-mode view stage — see `readerView` below. */
export type ReaderViewStage = 'normal' | 'window' | 'screen';

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
   * Read-mode full screen, in two stages: 'window' hides all app chrome but
   * keeps the window as-is; 'screen' additionally makes the OS window
   * fullscreen. Only the value lives here — the window-API side effect is
   * owned by `../reader-fullscreen`, which is the only writer.
   */
  readerView: ReaderViewStage;
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
  setReaderView: (stage: ReaderViewStage) => void;
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const uiStore = createStore<UiState>()((set) => ({
  notice: null,
  cursor: null,
  settingsOpen: false,
  explorerOpen: false,
  dropTargetDir: null,
  explorerRefresh: 0,
  readerView: 'normal',

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

  setReaderView(stage) {
    set({ readerView: stage });
  },
}));

export const useUiStore = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
