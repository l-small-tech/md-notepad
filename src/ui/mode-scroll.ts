/**
 * Per-tab scroll anchors, so a mode switch lands where you were reading.
 *
 * Same module-map shape as `editor-registry` and the preview reveal hooks:
 * each live surface registers a port for its tab, the store captures from the
 * outgoing surface BEFORE the mode changes (the old DOM is still on screen and
 * measurable), and the incoming surface takes the parked line when it is ready
 * — which for a freshly-attached preview pane is several async renders later,
 * so the anchor waits in the map rather than being pushed at a surface that
 * cannot use it yet.
 *
 * The anchor is always a 1-based SOURCE LINE (`core/mode-scroll`); translating
 * it into a scroll offset is each surface's own business.
 */

import { scrollSurfaceFor, type ScrollSurface } from '../core/mode-scroll';
import type { EditorMode } from '../core/types';

export interface ScrollAnchorPort {
  /** The 1-based source line at the top of this surface, or null if unknown. */
  getTopLine(): number | null;
  /** Put that source line back at the top of this surface. */
  scrollToLine(line: number): void;
}

const ports = new Map<string, ScrollAnchorPort>();
/** tabId → the line captured on the way out of the previous mode. */
const anchors = new Map<string, number>();

function key(tabId: string, surface: ScrollSurface): string {
  return `${tabId}:${surface}`;
}

export function registerScrollAnchor(
  tabId: string,
  surface: ScrollSurface,
  port: ScrollAnchorPort,
): void {
  ports.set(key(tabId, surface), port);
}

export function unregisterScrollAnchor(tabId: string, surface: ScrollSurface): void {
  ports.delete(key(tabId, surface));
}

/**
 * Remember where the tab is right now, so the mode it is switching TO can
 * restore it. Call while `mode` is still the mode on screen. Surfaces that
 * cannot report a line (nothing rendered yet, a draw/term tab) leave the
 * previous anchor alone rather than clobbering it with a guess.
 */
export function captureScrollAnchor(tabId: string, mode: EditorMode): void {
  const surface = scrollSurfaceFor(mode);
  if (!surface) {
    return;
  }
  const line = ports.get(key(tabId, surface))?.getTopLine() ?? null;
  if (line !== null) {
    anchors.set(tabId, line);
  }
}

/**
 * The line parked for this tab, without consuming it — for a surface that
 * should follow the anchor but does not own it (split mode's preview column,
 * which rides along with the source editor's position).
 */
export function peekScrollAnchor(tabId: string): number | null {
  return anchors.get(tabId) ?? null;
}

/** Take the parked line (it is spent once the owning surface has used it). */
export function takeScrollAnchor(tabId: string): number | null {
  const line = anchors.get(tabId) ?? null;
  anchors.delete(tabId);
  return line;
}

/** Put a surface at a source line, if it is the one currently registered. */
export function scrollSurfaceToLine(tabId: string, surface: ScrollSurface, line: number): void {
  ports.get(key(tabId, surface))?.scrollToLine(line);
}

/** The tab is gone — drop anything held for it. */
export function clearScrollAnchor(tabId: string): void {
  anchors.delete(tabId);
}
