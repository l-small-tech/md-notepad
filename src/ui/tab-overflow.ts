/**
 * Tab-bar overflow windowing (pure; tested).
 *
 * When more tabs are open than fit the bar, the TabBar shows a contiguous
 * window of whole tabs (never a partially cut-off one) and folds the rest
 * into a "⋯" menu. This module owns the window placement math: which index
 * the window starts at, given how many tabs fit and where the active tab is.
 */

/**
 * Pick the start index of the visible tab window.
 *
 * Rules, in order:
 *  - the window never extends past the end (start ≤ total - capacity);
 *  - the active tab must be inside the window — the window slides the
 *    minimum distance to include it;
 *  - otherwise keep `prevStart`, so switching between already-visible tabs
 *    never shifts the row (stability over recentering).
 */
export function computeTabWindow(
  total: number,
  capacity: number,
  activeIndex: number,
  prevStart: number,
): number {
  const cap = Math.max(1, capacity);
  let start = Math.min(Math.max(prevStart, 0), Math.max(0, total - cap));
  if (activeIndex >= 0) {
    if (activeIndex < start) {
      start = activeIndex;
    } else if (activeIndex >= start + cap) {
      start = activeIndex - cap + 1;
    }
  }
  return start;
}
