/**
 * S2 — the flat-field stage. The contracts from the plan: after normalization
 * a ramped/vignetted background's deviation collapses below a fixed bound,
 * per-channel division neutralizes an injected colour cast, and glare is
 * detected (bright AND locally flat) without flagging ordinary board.
 */

import { describe, expect, it } from 'vitest';
import { boxBlur, detectGlare, dilate, normalizeIllumination } from '../illumination';
import type { RgbaImage } from '../types';

/** A board with a lighting model: per-pixel multiplier over a white surface. */
function board(
  width: number,
  height: number,
  light: (x: number, y: number) => number,
  cast: readonly [number, number, number] = [1, 1, 1],
  paint?: (x: number, y: number) => readonly [number, number, number] | null,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = ((state >>> 16) % 7) - 3;
      const ink = paint?.(x, y) ?? null;
      const base: readonly [number, number, number] = ink ?? [245, 245, 245];
      const l = light(x, y);
      const p = (y * width + x) * 4;
      data[p] = base[0] * l * cast[0] + noise;
      data[p + 1] = base[1] * l * cast[1] + noise;
      data[p + 2] = base[2] * l * cast[2] + noise;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

function stats(image: RgbaImage): { mean: number; std: number } {
  let sum = 0;
  let sumSq = 0;
  const n = image.width * image.height;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const lum = 0.2126 * image.data[p]! + 0.7152 * image.data[p + 1]! + 0.0722 * image.data[p + 2]!;
    sum += lum;
    sumSq += lum * lum;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

describe('dilate / boxBlur', () => {
  it('dilation recovers the local maximum', () => {
    const plane = new Uint8ClampedArray(9 * 5);
    plane.fill(10);
    plane[2 * 9 + 4] = 200;
    const out = dilate(plane, 9, 5, 2);
    // Everything within the (2r+1)² window of the peak reads the peak.
    expect(out[2 * 9 + 2]).toBe(200);
    expect(out[0 * 9 + 4]).toBe(200);
    // Beyond the window, the flat value survives.
    expect(out[2 * 9 + 0]).toBe(10);
  });

  it('box blur preserves a constant plane exactly', () => {
    const plane = new Uint8ClampedArray(16 * 8);
    plane.fill(77);
    const out = boxBlur(plane, 16, 8, 3);
    expect([...out].every((v) => v === 77)).toBe(true);
  });
});

describe('normalizeIllumination', () => {
  it('flattens a strong side-light ramp with vignette', () => {
    const image = board(256, 192, (x, y) => {
      const ramp = 0.55 + 0.45 * (x / 255);
      const dx = x / 255 - 0.5;
      const dy = y / 191 - 0.5;
      const vignette = 1 - 0.5 * (dx * dx + dy * dy);
      return ramp * vignette;
    });
    const before = stats(image);
    const { normalized } = normalizeIllumination(image);
    const after = stats(normalized);
    // The estimate is a dilation, which overshoots where the field curves —
    // the bound is "an order of magnitude flatter", not "perfect".
    expect(before.std).toBeGreaterThan(20);
    expect(after.std).toBeLessThan(8);
    expect(after.mean).toBeGreaterThan(240);
  });

  it('neutralizes a colour cast (automatic white balance)', () => {
    const image = board(128, 96, () => 0.9, [1, 0.82, 0.66]);
    const { normalized } = normalizeIllumination(image);
    let dr = 0;
    let dg = 0;
    const n = normalized.width * normalized.height;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      dr += normalized.data[p]! - normalized.data[p + 1]!;
      dg += normalized.data[p + 1]! - normalized.data[p + 2]!;
    }
    expect(Math.abs(dr / n)).toBeLessThan(4);
    expect(Math.abs(dg / n)).toBeLessThan(4);
  });

  it('does not let ink drag the background estimate down', () => {
    // A stroke is far narrower than the dilation window, so the field over it
    // must still read "board" and the normalized ink must stay dark.
    const image = board(
      256,
      192,
      () => 0.8,
      [1, 1, 1],
      (x, y) => (y >= 90 && y < 94 && x >= 40 && x <= 200 ? [30, 30, 30] : null),
    );
    const { normalized } = normalizeIllumination(image);
    const p = (92 * 256 + 120) * 4;
    expect(normalized.data[p]!).toBeLessThan(60);
  });
});

describe('detectGlare', () => {
  it('flags a blown flat patch and reports its fraction', () => {
    const image = board(240, 180, (x, y) =>
      x >= 50 && x < 150 && y >= 40 && y < 120 ? 1.12 : 0.85,
    );
    const glare = detectGlare(image);
    expect(glare.fraction).toBeGreaterThan(0.05);
    expect(glare.fraction).toBeLessThan(0.35);
    expect(glare.mask[70 * 240 + 100]).toBe(1);
    expect(glare.mask[160 * 240 + 20]).toBe(0);
  });

  it('does not flag an ordinary well-lit board', () => {
    const image = board(240, 180, () => 0.9);
    expect(detectGlare(image).fraction).toBeLessThan(0.01);
  });
});
