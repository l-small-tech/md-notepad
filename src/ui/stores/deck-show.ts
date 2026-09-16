/**
 * The live deck panes, by tab — the one registry the full-screen show needs.
 *
 * Same module-map shape as `editor-registry` / `preview-nav`: `EditorHost`
 * registers a tab's deck pane while Split or Present has one mounted, and the
 * show (`components/DeckShow`) asks it for the slide at the top on the way in
 * and puts the slide it was showing back on top on the way out. In Raw mode
 * there is no pane; the show then starts from the source editor's top line
 * through the scroll-anchor ports (`ui/mode-scroll readSurfaceTopLine`).
 */

import type { DeckPane } from '../../preview/deck';

const panes = new Map<string, DeckPane>();

export function registerDeckPane(tabId: string, pane: DeckPane): void {
  panes.set(tabId, pane);
}

export function unregisterDeckPane(tabId: string): void {
  panes.delete(tabId);
}

export function deckPaneFor(tabId: string): DeckPane | null {
  return panes.get(tabId) ?? null;
}
