/**
 * The phase-5 golden: a synthetic whiteboard photo — known strokes under a
 * lighting ramp, a colour cast, sensor noise, an eraser-ghost band, isolated
 * grit and an i-dot — through the WHOLE clean pipeline. The assertions are the
 * plan's own verify list: the ghost yields ZERO surviving components, grit
 * dies while the i-dot survives, every stroke keeps its identity and votes the
 * right colour, and the themed compose paints exact palette hexes.
 */

import { describe, expect, it } from 'vitest';
import { composeCleaned, createCleaner, type CleanResult } from '../clean';
import { SCAN_PALETTE } from '../color';
import type { RgbaImage } from '../types';

const W = 320;
const H = 240;

/** The known ink, in pre-cast "true" colours. */
const STROKES = [
  { name: 'blue', y0: 56, y1: 60, x0: 40, x1: 160, rgb: [40, 90, 200] as const },
  { name: 'red', y0: 96, y1: 100, x0: 40, x1: 160, rgb: [200, 40, 40] as const },
  { name: 'black', y0: 136, y1: 140, x0: 40, x1: 160, rgb: [30, 30, 30] as const },
  { name: 'yellow', y0: 176, y1: 180, x0: 40, x1: 160, rgb: [200, 180, 40] as const },
];

/** The eraser-ghost band: faint grey, never strong anywhere. */
const GHOST = { x0: 220, x1: 260, y0: 40, y1: 200 };

/** Isolated grit far from any ink — must die as speckle. */
const SPECKLE = { x: 290, y: 24 };

/** A 2×2 dot just above the black stroke's end — the i-dot, must survive. */
const IDOT = { x0: 164, x1: 165, y0: 130, y1: 131 };

function syntheticPhoto(): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4);
  const cast: readonly [number, number, number] = [1, 0.9, 0.78];
  let state = 777;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = ((state >>> 16) % 5) - 2;
      const light = (0.6 + 0.4 * (x / (W - 1))) * (0.92 + 0.08 * (y / (H - 1)));
      let base: readonly [number, number, number] = [245, 245, 245];
      for (const s of STROKES) {
        if (y >= s.y0 && y <= s.y1 && x >= s.x0 && x <= s.x1) {
          base = s.rgb;
        }
      }
      if (x >= GHOST.x0 && x <= GHOST.x1 && y >= GHOST.y0 && y <= GHOST.y1) {
        base = [190, 190, 190];
      }
      if (x === SPECKLE.x && y === SPECKLE.y) {
        base = [40, 40, 40];
      }
      if (x >= IDOT.x0 && x <= IDOT.x1 && y >= IDOT.y0 && y <= IDOT.y1) {
        base = [30, 30, 30];
      }
      const p = (y * W + x) * 4;
      data[p] = base[0] * light * cast[0] + noise;
      data[p + 1] = base[1] * light * cast[1] + noise;
      data[p + 2] = base[2] * light * cast[2] + noise;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function runClean(image: RgbaImage): CleanResult {
  const job = createCleaner(image);
  let guard = 0;
  while (!job.done && guard++ < 100) {
    job.step();
  }
  expect(job.done).toBe(true);
  expect(job.progress).toBe(1);
  return job.result()!;
}

describe('the clean pipeline (S2–S4)', () => {
  // One run, shared across the assertions below; built lazily so the work
  // happens inside a test, not at collection time.
  let cached: CleanResult | null = null;
  const getResult = () => (cached ??= runClean(syntheticPhoto()));

  it('keeps every real stroke plus the i-dot, and nothing else', () => {
    const result = getResult();
    // 4 strokes + the i-dot = 5 components. The ghost and the speckle are gone.
    expect(result.extraction.components.length).toBe(5);
  });

  it('the eraser ghost yields zero surviving ink', () => {
    const result = getResult();
    const { labels } = result.extraction;
    for (let y = GHOST.y0; y <= GHOST.y1; y++) {
      for (let x = GHOST.x0; x <= GHOST.x1; x++) {
        expect(labels[y * W + x]).toBe(0);
      }
    }
  });

  it('isolated grit dies; the i-dot near ink survives', () => {
    const result = getResult();
    const { labels } = result.extraction;
    expect(labels[SPECKLE.y * W + SPECKLE.x]).toBe(0);
    expect(labels[IDOT.y0 * W + IDOT.x0]).not.toBe(0);
    expect(result.extraction.removed.speckle).toBeGreaterThanOrEqual(1);
  });

  it('estimates the stroke width from the ink itself', () => {
    const result = getResult();
    expect(result.extraction.strokeWidth).toBeGreaterThanOrEqual(3);
    expect(result.extraction.strokeWidth).toBeLessThanOrEqual(6.5);
  });

  it('votes the right colour for every stroke', () => {
    const result = getResult();
    const at = (x: number, y: number) => result.extraction.labels[y * W + x]!;
    const expectBucket = (x: number, y: number, bucket: string) => {
      const label = at(x, y);
      expect(label).not.toBe(0);
      expect(result.colors.byLabel.get(label)!.bucket).toBe(bucket);
    };
    expectBucket(100, 58, 'blue');
    expectBucket(100, 98, 'red');
    expectBucket(100, 138, 'black');
    expectBucket(100, 178, 'yellow');
  });

  it('reports no significant glare on this photo', () => {
    const result = getResult();
    expect(result.glareFraction).toBeLessThan(0.02);
  });

  it('themed compose paints exact palette hexes on pure white', () => {
    const result = getResult();
    const cleaned = composeCleaned(result, 'themed');
    const px = (x: number, y: number) => {
      const p = (y * W + x) * 4;
      return [cleaned.data[p]!, cleaned.data[p + 1]!, cleaned.data[p + 2]!] as const;
    };
    // Background: pure white, ramp and cast gone.
    expect(px(20, 20)).toEqual([255, 255, 255]);
    expect(px(300, 220)).toEqual([255, 255, 255]);
    // Ghost band: white too.
    expect(px(240, 120)).toEqual([255, 255, 255]);
    // Ink: the canonical palette hex, exactly.
    const hex = (s: string) => [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
    ];
    expect(px(100, 58)).toEqual(hex(SCAN_PALETTE.blue));
    expect(px(100, 98)).toEqual(hex(SCAN_PALETTE.red));
    expect(px(100, 138)).toEqual(hex(SCAN_PALETTE.black));
    expect(px(100, 178)).toEqual(hex(SCAN_PALETTE.yellow));
  });

  it('true-colour compose recovers the measured marker colour', () => {
    const result = getResult();
    const cleaned = composeCleaned(result, 'true');
    // The blue stroke was (40, 90, 200) before lighting; normalization maps
    // board white to ~255, so ink lands near 255/245 × its true value.
    const p = (58 * W + 100) * 4;
    expect(Math.abs(cleaned.data[p]! - 42)).toBeLessThan(25);
    expect(Math.abs(cleaned.data[p + 1]! - 94)).toBeLessThan(25);
    expect(Math.abs(cleaned.data[p + 2]! - 208)).toBeLessThan(25);
  });

  it('is deterministic end to end', () => {
    const result = getResult();
    const again = runClean(syntheticPhoto());
    const a = composeCleaned(result, 'themed');
    const b = composeCleaned(again, 'themed');
    expect(a.data.length).toBe(b.data.length);
    let diff = 0;
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] !== b.data[i]) {
        diff++;
      }
    }
    expect(diff).toBe(0);
  });

  it('colour-mode switching never changes the ink mask', () => {
    const result = getResult();
    const themed = composeCleaned(result, 'themed');
    const truth = composeCleaned(result, 'true');
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      const themedInk = themed.data[p] !== 255 || themed.data[p + 1] !== 255;
      const trueInk = truth.data[p] !== 255 || truth.data[p + 1] !== 255;
      if (result.extraction.labels[i] !== 0) {
        continue; // ink pixels may legitimately differ between modes
      }
      expect(themedInk).toBe(false);
      expect(trueInk).toBe(false);
    }
  });
});
