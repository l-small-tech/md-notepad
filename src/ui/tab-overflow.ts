/**
 * Tab-bar overflow measurement (pure; tested).
 *
 * The strip renders EVERY tab and lets them shrink like a browser's, then
 * scrolls once they hit their min-width floor. A strip that merely scrolls
 * hides tabs with nothing to say so, hence the overflow button — which
 * appears only while something is actually clipped and lists exactly the
 * clipped tabs.
 *
 * The decision is made from measured RECTANGLES rather than from a width
 * budget, because the tabs are elastic: the answer has to survive a window
 * resize, a renamed title and a scrolled strip alike, and only the browser
 * knows where things ended up. The measurement lives here,
 * away from the DOM, so the rule itself stays unit-testable; the component
 * keeps nothing but the `ResizeObserver` wiring.
 *
 * (This replaced a `computeTabWindow` that rendered only a contiguous window
 * of tabs. Rendering all of them is what makes scrolling, drag-reorder across
 * the whole strip, and `scrollIntoView` on the active tab work at all.)
 */

export interface Bounds {
  left: number;
  right: number;
}

/** One measured strip child: a tab. */
export interface StripItemRect extends Bounds {
  tabId: string;
}

/**
 * A pixel of slack in each direction: subpixel layout otherwise reports a
 * flush tab as clipped, which makes the overflow button flicker on resize.
 */
const SLACK = 1;

/**
 * The tabs the strip is cutting off, in strip order.
 *
 * An item counts as clipped when either edge falls outside the strip — half a
 * title is not a tab you can read — or when it has NO width at all. The
 * zero-width case is what the phone layout rides on: below 640px CSS hides
 * every inactive tab, and those collapse to empty rects that belong in the
 * switcher, which is exactly what the count pill lists.
 */
export function clippedTabIds(strip: Bounds, items: readonly StripItemRect[]): string[] {
  return items.filter((item) => isClipped(strip, item)).map((item) => item.tabId);
}

function isClipped(strip: Bounds, item: Bounds): boolean {
  if (item.right - item.left <= 0) {
    return true;
  }
  return item.left < strip.left - SLACK || item.right > strip.right + SLACK;
}

/**
 * The width to cap the strip at so it ends on a tab boundary — i.e. how much
 * room a whole number of tabs takes, never cutting one in half. `null` means
 * leave the strip alone: everything fits, or not even the first tab does (a
 * sliver of one tab still beats an empty bar).
 *
 * Derived from tab WIDTHS rather than from live positions, so the answer does
 * not change as the strip scrolls — a cap that tracked the scroll position
 * would shuffle the + button sideways under the cursor on every wheel tick.
 * With the tabs at their min-width floor (which is when the strip overflows at
 * all) the two agree exactly anyway.
 */
export function wholeTabsWidth(available: number, items: readonly Bounds[]): number | null {
  let total = 0;
  let fitted = 0;
  let overflowing = false;
  for (const item of items) {
    const width = item.right - item.left;
    if (width <= 0) {
      continue; // the phone layout's hidden tabs; they occupy no room
    }
    if (total + width > available + SLACK) {
      overflowing = true;
      break;
    }
    total += width;
    fitted += 1;
  }
  return overflowing && fitted > 0 ? total : null;
}

/** Same ids in the same order — the guard against a measure/render loop. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
