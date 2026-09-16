/**
 * Where a popover menu goes so the whole of it stays on screen.
 *
 * Menus in the file explorer hang off the row they were opened from, which is
 * fine until the row is near the bottom of the window — then the tail of the
 * menu falls off the viewport (and, anchored inside the scrolling tree, gets
 * clipped). `placeMenu` is the pure geometry behind the fix: prefer below the
 * row, flip above when the menu doesn't fit there, and when neither side has
 * room take the roomier one and report a `maxHeight` the menu scrolls within.
 *
 * All coordinates are viewport coordinates (what getBoundingClientRect gives).
 */

/** The part of a DOMRect this module needs. */
export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** Cap for the menu's height — it scrolls when the content is taller. */
  maxHeight: number;
}

/** Breathing room kept between the menu and every viewport edge. */
export const MENU_VIEWPORT_MARGIN = 6;

/**
 * Place a menu of `menu` size against `anchor` inside `viewport`.
 * `offsetX` nudges it in from the anchor's left edge (the explorer's 8px).
 */
export function placeMenu(
  anchor: AnchorRect,
  menu: MenuSize,
  viewport: Viewport,
  offsetX = 8,
): MenuPlacement {
  const m = MENU_VIEWPORT_MARGIN;

  // Horizontal: start at the anchor, pull back in when the menu would run off
  // the right edge, and never past the left edge (a menu wider than the
  // viewport starts at the margin and simply overflows to the right).
  const left = Math.max(m, Math.min(anchor.left + offsetX, viewport.width - menu.width - m));

  const below = viewport.height - m - anchor.bottom;
  const above = anchor.top - m;

  if (menu.height <= below) {
    return { top: anchor.bottom, left, maxHeight: below };
  }
  if (menu.height <= above) {
    return { top: anchor.top - menu.height, left, maxHeight: above };
  }
  // Neither side fits: use the roomier one and let the menu scroll.
  return below >= above
    ? { top: anchor.bottom, left, maxHeight: below }
    : { top: m, left, maxHeight: above };
}
