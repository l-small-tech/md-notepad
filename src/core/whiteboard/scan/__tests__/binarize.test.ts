/**
 * The strong/weak gates in isolation. The single most important property is
 * negative: a BLANK board — even a noisy one — produces no weak pixels at
 * all, because Sauvola's dynamic-range term declines to threshold a
 * low-variance window. That is the difference between this design and a
 * Bradley-style mean offset, which speckles empty regions.
 */

import { describe, expect, it } from 'vitest';
import { binarize } from '../binarize';
import type { RgbaImage } from '../types';

function flat(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  noise = 0,
  paint?: (x: number, y: number) => readonly [number, number, number] | null,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 99;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const n = noise > 0 ? ((state >>> 16) % (2 * noise + 1)) - noise : 0;
      const base = paint?.(x, y) ?? rgb;
      const p = (y * width + x) * 4;
      data[p] = base[0] + n;
      data[p + 1] = base[1] + n;
      data[p + 2] = base[2] + n;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

const count = (mask: Uint8Array) => mask.reduce((a, b) => a + b, 0);

describe('binarize', () => {
  it('a blank noisy board stays blank', () => {
    const masks = binarize(flat(96, 64, [250, 250, 250], 3));
    expect(count(masks.weak)).toBe(0);
    expect(count(masks.strong)).toBe(0);
  });

  it('a dark stroke is strong; strong is a subset of weak', () => {
    const masks = binarize(
      flat(96, 64, [250, 250, 250], 2, (x, y) =>
        y >= 30 && y < 34 && x >= 20 && x < 76 ? [40, 40, 40] : null,
      ),
    );
    expect(masks.strong[31 * 96 + 40]).toBe(1);
    for (let i = 0; i < masks.strong.length; i++) {
      if (masks.strong[i] === 1) {
        expect(masks.weak[i]).toBe(1);
      }
    }
  });

  it('a bright saturated stroke (yellow marker) reaches strong via chroma', () => {
    const masks = binarize(
      flat(96, 64, [250, 250, 250], 2, (x, y) =>
        y >= 30 && y < 34 && x >= 20 && x < 76 ? [210, 190, 40] : null,
      ),
    );
    expect(masks.strong[31 * 96 + 40]).toBe(1);
  });

  it('the glare mask pre-empts both gates', () => {
    const exclude = new Uint8Array(96 * 64).fill(1);
    const masks = binarize(
      flat(96, 64, [250, 250, 250], 0, (x, y) =>
        y >= 30 && y < 34 && x >= 20 && x < 76 ? [40, 40, 40] : null,
      ),
      exclude,
    );
    expect(count(masks.weak)).toBe(0);
  });
});
