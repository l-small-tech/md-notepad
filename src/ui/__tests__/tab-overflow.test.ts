import { describe, expect, test } from 'vitest';
import {
  clippedTabIds,
  sameIds,
  wholeTabsFit,
  wholeTabsWidth,
  type StripItemRect,
} from '../tab-overflow';

const STRIP = { left: 0, right: 100 };

function tab(tabId: string, left: number, right: number) {
  return { tabId, left, right } satisfies StripItemRect;
}

describe('clippedTabIds', () => {
  test('nothing is clipped when everything fits', () => {
    expect(clippedTabIds(STRIP, [tab('a', 0, 40), tab('b', 40, 80)])).toEqual([]);
  });

  test('a tab hanging off either end is clipped', () => {
    expect(
      clippedTabIds(STRIP, [tab('left', -30, 10), tab('mid', 10, 60), tab('right', 60, 130)]),
    ).toEqual(['left', 'right']);
  });

  test('a PARTIALLY visible tab counts — half a title is not readable', () => {
    expect(clippedTabIds(STRIP, [tab('a', 0, 60), tab('b', 60, 101.5)])).toEqual(['b']);
  });

  test('a pixel of slack absorbs subpixel layout', () => {
    // Without it the overflow button flickers on and off during a resize.
    expect(clippedTabIds(STRIP, [tab('a', -0.4, 99.6), tab('b', 99.6, 100.7)])).toEqual([]);
  });

  test('a zero-width item is clipped — this is the phone layout', () => {
    // Below 640px CSS hides every inactive tab; their rects collapse, and the
    // count pill lists exactly them.
    expect(
      clippedTabIds(STRIP, [tab('hidden', 0, 0), tab('active', 0, 100), tab('gone', 0, 0)]),
    ).toEqual(['hidden', 'gone']);
  });

  test('an empty strip clips nothing', () => {
    expect(clippedTabIds(STRIP, [])).toEqual([]);
  });
});

describe('wholeTabsWidth', () => {
  test('a strip with room to spare keeps its natural width', () => {
    expect(wholeTabsWidth(100, [tab('a', 0, 40), tab('b', 40, 80)])).toBeNull();
  });

  test('a strip that ends mid-tab is capped at the last whole one', () => {
    // Three 40px tabs in 100px: the third would be sliced at 20px.
    expect(wholeTabsWidth(100, [tab('a', 0, 40), tab('b', 40, 80), tab('c', 80, 120)])).toBe(80);
  });

  test('a tab flush with the edge still counts as whole', () => {
    expect(wholeTabsWidth(80, [tab('a', 0, 40), tab('b', 40, 80), tab('c', 80, 120)])).toBe(80);
  });

  test('subpixel slack does not cost a tab its place', () => {
    expect(wholeTabsWidth(79.6, [tab('a', 0, 40), tab('b', 40, 80), tab('c', 80, 120)])).toBe(80);
  });

  test('a strip too narrow for even one tab shows the sliver', () => {
    // Capping to zero would leave an empty bar, which says less than a sliver.
    expect(wholeTabsWidth(30, [tab('a', 0, 40), tab('b', 40, 80)])).toBeNull();
  });

  test('zero-width tabs (the phone layout) take no room', () => {
    expect(
      wholeTabsWidth(50, [tab('hidden', 0, 0), tab('active', 0, 40), tab('gone', 40, 40)]),
    ).toBeNull();
  });

  test('an empty strip has nothing to cap', () => {
    expect(wholeTabsWidth(100, [])).toBeNull();
  });
});

describe('wholeTabsFit', () => {
  test('reports the fitted count alongside the boundary width', () => {
    // Three 40px tabs in 100px: two fit whole, 20px of remainder to justify.
    expect(wholeTabsFit(100, [tab('a', 0, 40), tab('b', 40, 80), tab('c', 80, 120)])).toEqual({
      width: 80,
      count: 2,
    });
  });

  test('null when everything fits — nothing to justify', () => {
    expect(wholeTabsFit(100, [tab('a', 0, 40), tab('b', 40, 80)])).toBeNull();
  });

  test('zero-width tabs (the phone layout) are not counted', () => {
    expect(wholeTabsFit(50, [tab('hidden', 0, 0), tab('a', 0, 40), tab('b', 40, 80)])).toEqual({
      width: 40,
      count: 1,
    });
  });
});

describe('sameIds', () => {
  test('order and length both matter', () => {
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});
