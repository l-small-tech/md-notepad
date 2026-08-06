/**
 * The blob fallback: marching squares must return closed, hole-aware loops —
 * a solid square is one loop, a donut is two (which is what makes
 * `fill-rule="evenodd"` paint it correctly).
 */

import { describe, expect, it } from 'vitest';
import { traceContours } from '../contour';

const W = 40;
const H = 40;

function grid(): Uint8Array {
  return new Uint8Array(W * H);
}

function fill(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number, value = 1): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      mask[y * W + x] = value;
    }
  }
}

describe('traceContours', () => {
  it('traces a solid square as one closed loop around it', () => {
    const mask = grid();
    fill(mask, 8, 8, 24, 24);
    const loops = traceContours(mask, W, H);
    expect(loops.length).toBe(1);
    const loop = loops[0]!;
    const first = loop[0]!;
    const last = loop[loop.length - 1]!;
    expect(last.x).toBeCloseTo(first.x, 5);
    expect(last.y).toBeCloseTo(first.y, 5);
    // Within half a pixel of the mask boundary.
    for (const p of loop) {
      expect(p.x).toBeGreaterThan(7);
      expect(p.x).toBeLessThan(26);
      expect(p.y).toBeGreaterThan(7);
      expect(p.y).toBeLessThan(26);
    }
  });

  it('traces a donut as an outer loop plus a hole', () => {
    const mask = grid();
    fill(mask, 6, 6, 30, 30);
    fill(mask, 14, 14, 22, 22, 0);
    const loops = traceContours(mask, W, H);
    expect(loops.length).toBe(2);
  });

  it('returns nothing for an empty window', () => {
    expect(traceContours(grid(), W, H).length).toBe(0);
  });
});
