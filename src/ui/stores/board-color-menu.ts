/**
 * The "theme colours / true colours" right-click menu for a whiteboard image
 * shown inside a markdown document (preview pane in read/split, the rich
 * editor's image node). Transient, never persisted — the same contract as the
 * diagram viewer. The renderers only REPORT the right-click (path, current
 * mode, pointer); this store holds what the menu needs and `BoardColorMenu`
 * draws it.
 *
 * Applying a choice rewrites the `.svg` file (see `ui/board-color-mode.ts`),
 * and every open view showing that file must then reload its bytes. The
 * views' refresh hooks live in a module map keyed by view (a tab's preview
 * pane, a tab's rich editor) — plain functions with the view's lifetime, not
 * reactive state, exactly like `preview-nav.ts`'s goBack registry.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { BoardColorMode } from '../../core/whiteboard/scene';

export interface BoardColorMenuState {
  open: boolean;
  /** Absolute path of the right-clicked board; null while closed. */
  path: string | null;
  /** The mode the board renders in right now. */
  mode: BoardColorMode;
  /** Every board referenced by the document the click came from (absolute). */
  docPaths: string[];
  /** Viewport position the menu anchors at. */
  x: number;
  y: number;
  openFor: (info: {
    path: string;
    mode: BoardColorMode;
    docPaths: string[];
    x: number;
    y: number;
  }) => void;
  close: () => void;
}

export const boardColorMenuStore = createStore<BoardColorMenuState>()((set) => ({
  open: false,
  path: null,
  mode: 'themed',
  docPaths: [],
  x: 0,
  y: 0,

  openFor({ path, mode, docPaths, x, y }) {
    set({ open: true, path, mode, docPaths, x, y });
  },

  close() {
    set({ open: false, path: null, docPaths: [] });
  },
}));

export const useBoardColorMenu = <T>(selector: (s: BoardColorMenuState) => T): T =>
  useStore(boardColorMenuStore, selector);

/* ------------------------- the image refresh registry ---------------------- */

type ImageRefresher = (paths: readonly string[]) => void;

const refreshers = new Map<string, ImageRefresher>();

/** `key` names one view (e.g. `${tabId}:preview`); re-registering replaces. */
export function registerImageRefresher(key: string, refresh: ImageRefresher): void {
  refreshers.set(key, refresh);
}

export function unregisterImageRefresher(key: string): void {
  refreshers.delete(key);
}

/** Tell every live view that these files changed on disk. */
export function refreshImagesEverywhere(paths: readonly string[]): void {
  for (const refresh of refreshers.values()) {
    refresh(paths);
  }
}
