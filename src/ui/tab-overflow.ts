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
 * resize, a renamed title, a collapsed group and a scrolled strip alike, and
 * only the browser knows where things ended up. The measurement lives here,
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

/** One measured strip child: a tab, or a group's chip. */
export interface StripItemRect extends Bounds {
  /** The tab this rect belongs to, or null when it is a group chip. */
  tabId: string | null;
  /**
   * The group this item belongs to: a chip's own group, or a tab's
   * membership. A clipped CHIP takes its whole run with it — a run you can
   * only see the tail of is not a group you can read.
   */
  groupId: string | null;
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
  const clippedGroups = new Set<string>();
  for (const item of items) {
    if (item.tabId === null && item.groupId !== null && isClipped(strip, item)) {
      clippedGroups.add(item.groupId);
    }
  }
  const out: string[] = [];
  for (const item of items) {
    if (item.tabId === null) {
      continue;
    }
    if (isClipped(strip, item) || (item.groupId !== null && clippedGroups.has(item.groupId))) {
      out.push(item.tabId);
    }
  }
  return out;
}

function isClipped(strip: Bounds, item: Bounds): boolean {
  if (item.right - item.left <= 0) {
    return true;
  }
  return item.left < strip.left - SLACK || item.right > strip.right + SLACK;
}

/** Same ids in the same order — the guard against a measure/render loop. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
