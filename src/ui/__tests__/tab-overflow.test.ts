import { describe, expect, test } from 'vitest';
import { computeTabWindow } from '../tab-overflow';

describe('computeTabWindow', () => {
  test('everything fits: window starts at 0', () => {
    expect(computeTabWindow(3, 10, 1, 0)).toBe(0);
  });

  test('keeps the previous start while the active tab stays visible', () => {
    // 10 tabs, 4 visible, window at [2..5]: activating 3 doesn't move it.
    expect(computeTabWindow(10, 4, 3, 2)).toBe(2);
  });

  test('slides right just enough to reveal an active tab past the window', () => {
    // Window [0..3], active 5 → window [2..5].
    expect(computeTabWindow(10, 4, 5, 0)).toBe(2);
  });

  test('slides left to an active tab before the window', () => {
    expect(computeTabWindow(10, 4, 1, 5)).toBe(1);
  });

  test('never extends past the last tab (e.g. after closing tabs)', () => {
    // prevStart 8 with 10 tabs and capacity 4 → clamp to 6.
    expect(computeTabWindow(10, 4, 7, 8)).toBe(6);
  });

  test('a shrinking capacity pulls the active tab back into view', () => {
    // Window was [2..7] (cap 6); capacity drops to 3, active at 7 → [5..7].
    expect(computeTabWindow(10, 3, 7, 2)).toBe(5);
  });

  test('capacity is clamped to at least one tab', () => {
    expect(computeTabWindow(5, 0, 4, 0)).toBe(4);
  });

  test('no active tab (not found): just clamps the previous start', () => {
    expect(computeTabWindow(10, 4, -1, 3)).toBe(3);
    expect(computeTabWindow(2, 4, -1, 3)).toBe(0);
  });
});
