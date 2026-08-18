import { describe, expect, test } from 'vitest';
import { clippedTabIds, sameIds, type StripItemRect } from '../tab-overflow';

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

  test('results come back in strip order', () => {
    expect(
      clippedTabIds(STRIP, [tab('a', 120, 160), tab('b', 60, 90), tab('c', 200, 240)]),
    ).toEqual(['a', 'c']);
  });

  test('an empty strip clips nothing', () => {
    expect(clippedTabIds(STRIP, [])).toEqual([]);
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
