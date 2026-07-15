import { describe, expect, test } from 'vitest';
import { DOUBLE_TAP_MOVE_PX, DOUBLE_TAP_MS, isDoubleTap, type Tap } from '../dismiss-keyboard';

const at = (time: number, x = 0, y = 0): Tap => ({ time, x, y });

describe('isDoubleTap', () => {
  test('the first tap of a pair (no previous tap) is never a double-tap', () => {
    expect(isDoubleTap(null, at(0))).toBe(false);
  });

  test('two quick taps at the same spot are a double-tap', () => {
    expect(isDoubleTap(at(1000), at(1000 + DOUBLE_TAP_MS - 1))).toBe(true);
  });

  test('taps too far apart in time are not a double-tap', () => {
    expect(isDoubleTap(at(1000), at(1000 + DOUBLE_TAP_MS + 1))).toBe(false);
  });

  test('the time boundary is inclusive', () => {
    expect(isDoubleTap(at(0), at(DOUBLE_TAP_MS))).toBe(true);
  });

  test('taps too far apart in space are not a double-tap', () => {
    expect(isDoubleTap(at(0, 0, 0), at(10, DOUBLE_TAP_MOVE_PX + 1, 0))).toBe(false);
    expect(isDoubleTap(at(0, 0, 0), at(10, 0, DOUBLE_TAP_MOVE_PX + 1))).toBe(false);
  });

  test('movement within threshold on both axes still counts', () => {
    expect(isDoubleTap(at(0, 0, 0), at(10, DOUBLE_TAP_MOVE_PX, DOUBLE_TAP_MOVE_PX))).toBe(true);
  });

  test('custom thresholds are honoured', () => {
    expect(isDoubleTap(at(0), at(50), 40, 30)).toBe(false); // 50ms > 40ms window
    expect(isDoubleTap(at(0), at(30), 40, 30)).toBe(true);
  });
});
