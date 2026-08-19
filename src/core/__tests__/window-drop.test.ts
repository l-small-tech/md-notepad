import { describe, expect, test } from 'vitest';
import { pickDropWindow, type DropWindowCandidate } from '../window-drop';

function win(label: string, x: number, y: number, w: number, h: number, focusOrder = 0) {
  return { label, x, y, width: w, height: h, focusOrder } satisfies DropWindowCandidate;
}

describe('pickDropWindow', () => {
  test('null when the cursor is over no candidate (tear-off)', () => {
    expect(pickDropWindow({ x: 50, y: 50 }, [win('a', 100, 100, 200, 200)])).toBeNull();
    expect(pickDropWindow({ x: 0, y: 0 }, [])).toBeNull();
  });

  test('picks the one window containing the cursor', () => {
    const windows = [win('a', 0, 0, 100, 100), win('b', 200, 0, 100, 100)];
    expect(pickDropWindow({ x: 250, y: 50 }, windows)).toBe('b');
    expect(pickDropWindow({ x: 10, y: 10 }, windows)).toBe('a');
  });

  test('bounds are half-open: the left/top edge is inside, right/bottom is not', () => {
    const windows = [win('a', 0, 0, 100, 100), win('b', 100, 0, 100, 100)];
    // x=100 is a's exclusive right edge AND b's inclusive left edge → b only.
    expect(pickDropWindow({ x: 100, y: 0 }, windows)).toBe('b');
    expect(pickDropWindow({ x: 200, y: 50 }, windows)).toBeNull();
    expect(pickDropWindow({ x: 50, y: 100 }, [win('a', 0, 0, 100, 100)])).toBeNull();
  });

  test('overlapping candidates resolve to the most recently focused', () => {
    const windows = [win('lower', 0, 0, 300, 300, 3), win('upper', 100, 100, 300, 300, 7)];
    // In the overlap → the upper (more recently focused) one wins, whatever
    // the array order.
    expect(pickDropWindow({ x: 150, y: 150 }, windows)).toBe('upper');
    expect(pickDropWindow({ x: 150, y: 150 }, [...windows].reverse())).toBe('upper');
    // Outside the overlap the containment still decides.
    expect(pickDropWindow({ x: 50, y: 50 }, windows)).toBe('lower');
    expect(pickDropWindow({ x: 350, y: 350 }, windows)).toBe('upper');
  });

  test('a never-focused window (order 0) still catches a drop when alone under the cursor', () => {
    expect(pickDropWindow({ x: 10, y: 10 }, [win('a', 0, 0, 100, 100, 0)])).toBe('a');
  });

  test('degenerate (zero-sized) bounds never match', () => {
    expect(pickDropWindow({ x: 0, y: 0 }, [win('a', 0, 0, 0, 100)])).toBeNull();
    expect(pickDropWindow({ x: 0, y: 0 }, [win('a', 0, 0, 100, 0)])).toBeNull();
  });
});
