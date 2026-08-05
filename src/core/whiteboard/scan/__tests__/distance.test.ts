/**
 * The exact EDT is the foundation every stroke-width-relative threshold
 * stands on, so it is tested the only way that means anything: against the
 * brute-force O(n²) definition, exactly.
 */

import { describe, expect, it } from 'vitest';
import { distanceTransform, estimateStrokeWidth } from '../distance';

function bruteForce(mask: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) {
        continue;
      }
      let best = Infinity;
      for (let by = 0; by < height; by++) {
        for (let bx = 0; bx < width; bx++) {
          if (mask[by * width + bx] === 0) {
            const d = (bx - x) ** 2 + (by - y) ** 2;
            if (d < best) {
              best = d;
            }
          }
        }
      }
      out[y * width + x] = Number.isFinite(best) ? Math.sqrt(best) : 0;
    }
  }
  return out;
}

describe('distanceTransform', () => {
  it('matches the brute-force definition on random masks', () => {
    let state = 42;
    for (let trial = 0; trial < 5; trial++) {
      const width = 25;
      const height = 17;
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        mask[i] = (state >>> 16) % 3 === 0 ? 1 : 0;
      }
      // Guarantee at least one background pixel so distances are finite.
      mask[0] = 0;
      const fast = distanceTransform(mask, width, height);
      const slow = bruteForce(mask, width, height);
      for (let i = 0; i < mask.length; i++) {
        expect(Math.abs(fast[i]! - slow[i]!)).toBeLessThan(1e-4);
      }
    }
  });

  it('reads zero outside the mask', () => {
    const mask = new Uint8Array(9);
    mask[4] = 1;
    const d = distanceTransform(mask, 3, 3);
    expect(d[0]).toBe(0);
    expect(d[4]).toBeCloseTo(1, 5);
  });
});

describe('estimateStrokeWidth', () => {
  it('recovers the width of a drawn bar to within a pixel', () => {
    const width = 60;
    const height = 30;
    const mask = new Uint8Array(width * height);
    for (let y = 13; y < 17; y++) {
      for (let x = 10; x < 50; x++) {
        mask[y * width + x] = 1;
      }
    }
    const d = distanceTransform(mask, width, height);
    const w = estimateStrokeWidth(d, width, height);
    expect(w).toBeGreaterThanOrEqual(3);
    expect(w).toBeLessThanOrEqual(5.5);
  });

  it('falls back sanely on an empty mask', () => {
    const d = distanceTransform(new Uint8Array(100), 10, 10);
    expect(estimateStrokeWidth(d, 10, 10)).toBe(3);
  });
});
