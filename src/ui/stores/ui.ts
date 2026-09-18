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
import { pathKey } from '../../core/tab-workspaces';
import { tabsStore } from './tabs';

export interface CursorReadout {
  line: number;
  col: number;
}

/**
 * A section of the settings dialog. Lives here rather than beside the dialog
 * so a caller can ask for a section (`openSettings('harness')`) without the
 * store importing the component.
 */
export type SettingsTabId =
  'appearance' | 'editor' | 'files' | 'voice' | 'terminal' | 'harness' | 'updates';

/** Where the full-screen long-press menu was summoned (viewport px). */
export interface MenuPoint {
  x: number;
  y: number;
}

export interface UiState {
  notice: string | null;
  cursor: CursorReadout | null;
  /** The settings dialog (Ctrl+,) is open (M6). Transient, never persisted. */
  settingsOpen: boolean;
  /**
   * Which section the dialog should open on, when the caller cares — the
   * Harness row opens it on Harness so an uninstalled harness is one click
   * from its Install button. Null means "wherever it was left".
   */
  settingsTab: SettingsTabId | null;
  /** The command palette (Ctrl+K) is open. Transient, never persisted. */
  paletteOpen: boolean;
  /**
   * The new-tab TYPE picker is open, anchored to the "+" button. A store flag
   * rather than component state because mod+Shift+N has to open it too, and
   * global shortcuts dispatch store actions (never bind their own keys).
   */
  newTabMenuOpen: boolean;
  /** The left-side file explorer drawer is open. Transient, never persisted. */
  explorerOpen: boolean;
  /** The right-side outline (headings) panel is open. Transient, never persisted. */
  outlineOpen: boolean;
  /**
   * Directory currently hovered by an OS file drag (main.tsx hit-tests the
   * Tauri drag-drop events), or null. Drives the explorer's drop highlight.
   */
  dropTargetDir: string | null;
  /** Bumped whenever files were written into a workspace outside the tab flow
   *  (paste/drop) so the explorer re-lists. */
  explorerRefresh: number;
  /**
   * The directory selected in the explorer (a workspace header or one of its
   * folders), or null for "none picked yet" — which every reader treats as
   * the default (notes dir) workspace. It lives here rather than in
   * `FileExplorer` because non-explorer code reads it: a new terminal starts
   * in this directory (`terminal-open.ts`). Session-only, never persisted.
   */
  selectedExplorerDir: string | null;
  /**
   * Distraction-free (any mode): the app chrome — tabbar, ribbon, status bar
   * — is hidden and only the document shows. Pure CSS; the OS window is
   * untouched. Written only by `../fullscreen`.
   */
  distractionFree: boolean;
  /**
   * The OS window fills the screen (F11). Independent of `distractionFree`:
   * full screen changes nothing about the interface. Only the value lives
   * here — the window-API side effect is owned by `../fullscreen`, which is
   * the only writer. Never true on Android (see that module).
   */
  osFullscreen: boolean;
  /**
   * The distraction-free tap-and-hold menu's anchor point, or null when it is
   * closed. Distraction-free hides every piece of chrome, so a touch device
   * has no button to press; a long press anywhere summons this menu instead.
   * Kept here (not in the component) so the one global Escape handler in
   * main.tsx can close it before Escape leaves the view.
   */
  fullscreenMenu: MenuPoint | null;
  /** Show a status-bar notice that auto-clears after `ms` (default 6s). */
  showNotice: (message: string, ms?: number) => void;
  clearNotice: () => void;
  /** Adapter → UI. Ignored unless `tabId` is the active tab. */
  reportCursor: (tabId: string, cursor: CursorReadout) => void;
  openSettings: (tab?: SettingsTabId) => void;
  closeSettings: () => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openNewTabMenu: () => void;
  closeNewTabMenu: () => void;
  toggleExplorer: () => void;
  toggleOutline: () => void;
  openExplorer: () => void;
  openOutline: () => void;
  /** Shut both side panels — what entering full screen does. */
  closePanels: () => void;
  openFullscreenMenu: (at: MenuPoint) => void;
  closeFullscreenMenu: () => void;
  setDropTarget: (dir: string | null) => void;
  setSelectedExplorerDir: (dir: string | null) => void;
  /**
   * Clear the explorer selection when `root` (a deleted folder or removed
   * workspace) is, or contains, the selected directory — pastes and new
   * terminals must not keep targeting a path that no longer exists.
   */
  dropSelectedExplorerDirUnder: (root: string) => void;
  refreshExplorer: () => void;
  setDistractionFree: (on: boolean) => void;
  setOsFullscreen: (on: boolean) => void;
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const uiStore = createStore<UiState>()((set) => ({
  notice: null,
  cursor: null,
  settingsOpen: false,
  settingsTab: null,
  paletteOpen: false,
  newTabMenuOpen: false,
  explorerOpen: false,
  outlineOpen: false,
  dropTargetDir: null,
  explorerRefresh: 0,
  selectedExplorerDir: null,
  distractionFree: false,
  osFullscreen: false,
  fullscreenMenu: null,

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

  openSettings(tab) {
    set({ settingsOpen: true, settingsTab: tab ?? null });
  },

  closeSettings() {
    // Clear the requested section too: the next open asks for its own, and a
    // stale one would otherwise look unchanged and be ignored.
    set({ settingsOpen: false, settingsTab: null });
  },

  openPalette() {
    set({ paletteOpen: true });
  },

  closePalette() {
    set({ paletteOpen: false });
  },

  openNewTabMenu() {
    set({ newTabMenuOpen: true });
  },

  closeNewTabMenu() {
    set({ newTabMenuOpen: false });
  },

  togglePalette() {
    set((s) => ({ paletteOpen: !s.paletteOpen }));
  },

  toggleExplorer() {
    set((s) => ({ explorerOpen: !s.explorerOpen }));
  },

  toggleOutline() {
    set((s) => ({ outlineOpen: !s.outlineOpen }));
  },

  openExplorer() {
    set({ explorerOpen: true });
  },

  openOutline() {
    set({ outlineOpen: true });
  },

  closePanels() {
    set({ explorerOpen: false, outlineOpen: false });
  },

  openFullscreenMenu(at) {
    set({ fullscreenMenu: at });
  },

  closeFullscreenMenu() {
    set((s) => (s.fullscreenMenu === null ? s : { fullscreenMenu: null }));
  },

  setDropTarget(dir) {
    // Drag-over events fire continuously; only re-render on actual change.
    set((s) => (s.dropTargetDir === dir ? s : { dropTargetDir: dir }));
  },

  setSelectedExplorerDir(dir) {
    set((s) => (s.selectedExplorerDir === dir ? s : { selectedExplorerDir: dir }));
  },

  dropSelectedExplorerDirUnder(root) {
    set((s) => {
      if (s.selectedExplorerDir === null) {
        return s;
      }
      const selected = pathKey(s.selectedExplorerDir);
      const rootKey = pathKey(root);
      return selected === rootKey || selected.startsWith(`${rootKey}/`)
        ? { selectedExplorerDir: null }
        : s;
    });
  },

  refreshExplorer() {
    set((s) => ({ explorerRefresh: s.explorerRefresh + 1 }));
  },

  setDistractionFree(on) {
    // The menu belongs to the chrome-less view it was summoned from — leaving
    // it must never leave the menu floating over the chrome.
    set({ distractionFree: on, fullscreenMenu: null });
  },
  setOsFullscreen(on) {
    set({ osFullscreen: on });
  },
}));

export const useUiStore = <T>(selector: (s: UiState) => T): T => useStore(uiStore, selector);
