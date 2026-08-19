/**
 * Cross-window tab drop (M8) — which window is under the cursor?
 *
 * A tab drag released outside its window either lands on another app window
 * (that window adopts the tab, Chrome-style) or on empty desktop (tear-off
 * into a new window). The caller — main.tsx — gathers the geometry: the
 * global cursor position and every OTHER window's outer bounds, all in
 * PHYSICAL pixels (one coordinate space, no per-window scale-factor mixing;
 * minimized windows are excluded before this is called). This module owns
 * only the decision, so the rule is testable without a windowing system.
 *
 * Overlap is resolved by focus recency: the OS won't tell an app its windows'
 * z-order, but among normal app windows "most recently focused" IS the upper
 * one for any pair the cursor can reach. Candidates the map has never seen
 * focus for rank lowest (0), not out.
 */

/** One window the cursor might be over, in physical screen pixels. */
export interface DropWindowCandidate {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Monotonic focus counter — higher = focused more recently; 0 = unknown. */
  focusOrder: number;
}

/**
 * The label of the topmost candidate containing `cursor`, or null when the
 * release landed on none of them (→ tear-off). Bounds are half-open
 * (`[x, x+width)`) so abutting windows never both claim an edge pixel.
 */
export function pickDropWindow(
  cursor: { x: number; y: number },
  windows: readonly DropWindowCandidate[],
): string | null {
  let best: DropWindowCandidate | null = null;
  for (const w of windows) {
    if (w.width <= 0 || w.height <= 0) {
      continue;
    }
    const inside =
      cursor.x >= w.x && cursor.x < w.x + w.width && cursor.y >= w.y && cursor.y < w.y + w.height;
    if (inside && (best === null || w.focusOrder > best.focusOrder)) {
      best = w;
    }
  }
  return best === null ? null : best.label;
}
