import { describe, expect, it } from 'vitest';
import { MENU_VIEWPORT_MARGIN, placeMenu, type AnchorRect } from '../menu-position';

const viewport = { width: 1000, height: 800 };
const menu = { width: 180, height: 200 };
const m = MENU_VIEWPORT_MARGIN;

function row(top: number, height = 22): AnchorRect {
  return { top, bottom: top + height, left: 20 };
}

describe('placeMenu', () => {
  it('hangs below the row when there is room, offset in from its left edge', () => {
    const p = placeMenu(row(100), menu, viewport);
    expect(p.top).toBe(122);
    expect(p.left).toBe(28);
    expect(p.maxHeight).toBeGreaterThanOrEqual(menu.height);
  });

  it('flips above the row when the menu would run off the bottom', () => {
    const p = placeMenu(row(700), menu, viewport);
    expect(p.top).toBe(700 - menu.height);
    expect(p.top + menu.height).toBeLessThanOrEqual(700);
  });

  it('caps the height when neither side fits, choosing the roomier side', () => {
    const tall = { width: 180, height: 900 };

    const low = placeMenu(row(600), tall, viewport);
    expect(low.top).toBe(m);
    expect(low.maxHeight).toBe(600 - m);

    const high = placeMenu(row(100), tall, viewport);
    expect(high.top).toBe(122);
    expect(high.maxHeight).toBe(viewport.height - m - 122);
  });

  it('pulls the menu back in from the right edge', () => {
    const p = placeMenu({ top: 10, bottom: 32, left: 950 }, menu, viewport);
    expect(p.left).toBe(viewport.width - menu.width - m);
  });

  it('never places the menu past the left edge, even when it is wider than the viewport', () => {
    const p = placeMenu({ top: 10, bottom: 32, left: 0 }, { width: 1200, height: 100 }, viewport);
    expect(p.left).toBe(m);
  });
});
