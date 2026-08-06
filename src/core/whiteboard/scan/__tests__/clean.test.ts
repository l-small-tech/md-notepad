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

/**
 * A 4×4 dot just above the black stroke's end — the i-dot, must survive. It is
 * as wide as the strokes are thick BY DESIGN: a marker cannot lay down a mark
 * narrower than its own tip, and that is exactly the evidence the i-dot rule
 * demands before sparing a speckle.
 */
const IDOT = { x0: 164, x1: 167, y0: 128, y1: 131 };

/**
 * Grit 6 px from the red stroke. This one SURVIVES, by decision: the i-dot
 * rule is generous, because nothing at the raster level separates residue from
 * faint ink without also cutting holes in lightly-drawn strokes. Phase 6
 * decides it after tracing, where "no length, no continuation" is answerable.
 */
const NEAR_GRIT = { x0: 166, x1: 167, y0: 97, y1: 98 };

/**
 * A faint 12×1 dash just past the blue stroke's end: too small to clear the
 * speckle area, but long enough to read as a piece of a line (a dashed arrow
 * shaft, a fading box edge). Must survive — and must come out BLUE, not black,
 * even though it is one pixel thick and therefore all anti-aliased edge.
 */
const DASH = { x0: 166, x1: 177, y: 58 };

/**
 * A light stroke fading off the black one into pieces SHORTER than `w`: 4-px
 * dashes, 2 px tall, weak everywhere (never strong). Neither a dab nor a
 * span-`w` fragment, so the shape tests reject all of them — only the
 * continuity rescue can save these, and it must. This is the second-UAT-round
 * complaint: with the shape tests alone a faint arrow shaft and a lightly drawn
 * circle come back full of holes.
 */
const FADING_TAIL = { x0: 166, x1: 200, y0: 137, y1: 138, on: 4, off: 3 };

function inFadingTail(x: number, y: number): boolean {
  if (y < FADING_TAIL.y0 || y > FADING_TAIL.y1 || x < FADING_TAIL.x0 || x > FADING_TAIL.x1) {
    return false;
  }
  return (x - FADING_TAIL.x0) % (FADING_TAIL.on + FADING_TAIL.off) < FADING_TAIL.on;
}

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
      if (x >= NEAR_GRIT.x0 && x <= NEAR_GRIT.x1 && y >= NEAR_GRIT.y0 && y <= NEAR_GRIT.y1) {
        base = [40, 40, 40];
      }
      if (x >= DASH.x0 && x <= DASH.x1 && y === DASH.y) {
        base = [40, 90, 200];
      }
      if (inFadingTail(x, y)) {
        base = [195, 195, 195];
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

describe('light-marker continuity (the phase-5 UAT circle)', () => {
  /** A small board with one stroke that fades: dark on the left, a gap, then
   *  a faint weak-only tail — plus optional sparse dark dots on the tail. */
  function fadingBoard(tailDarkDots: boolean): RgbaImage {
    const w = 240;
    const h = 120;
    const data = new Uint8ClampedArray(w * h * 4);
    let state = 31;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const noise = ((state >>> 16) % 5) - 2;
        let v = 245;
        if (y >= 56 && y <= 60) {
          if (x >= 30 && x <= 110) {
            v = 35; // solid ink
          } else if (x >= 113 && x <= 200) {
            // Faint tail, below the strong gate everywhere…
            v = 190;
            if (tailDarkDots && x >= 113 && x <= 116) {
              v = 40; // …except a tiny dark patch: strongRatio ≈ 0.04
            }
          }
        }
        const p = (y * w + x) * 4;
        data[p] = v + noise;
        data[p + 1] = v + noise;
        data[p + 2] = v + noise;
        data[p + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  }

  it('rescues a disconnected faint continuation of kept ink', () => {
    const result = runClean(fadingBoard(false));
    // The faint tail is weak-only and 8-disconnected from the solid stroke —
    // pure hysteresis would kill it (that is what ate the UAT circle).
    const label = result.extraction.labels[58 * 240 + 160]!;
    expect(label).not.toBe(0);
  });

  it('keeps a faint stroke whose strong pixels are sparse', () => {
    const result = runClean(fadingBoard(true));
    // strongRatio ≈ 0.04 < 0.15: the faint filter must spare it because it is
    // stroke-shaped; only DIFFUSE faint components are smears.
    const label = result.extraction.labels[58 * 240 + 160]!;
    expect(label).not.toBe(0);
  });
});

describe('the clean pipeline (S2–S4)', () => {
  // One run, shared across the assertions below; built lazily so the work
  // happens inside a test, not at collection time.
  let cached: CleanResult | null = null;
  const getResult = () => (cached ??= runClean(syntheticPhoto()));

  it('keeps every real stroke, the i-dot, the dash and the fade', () => {
    const result = getResult();
    // 4 strokes + the i-dot + the faint dash + the fading tail's 5 dashes +
    // the tolerated grit near the red stroke = 12. The ghost and the ISOLATED
    // speckle — the two things nothing vouches for — are gone.
    expect(result.extraction.components.length).toBe(12);
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

  it('grit NEAR ink survives — the i-dot rule is generous on purpose', () => {
    const result = getResult();
    // Not an endorsement of the speck: an accepted cost. Every raster-level
    // test that would kill it also cuts holes in faint strokes (two UAT rounds
    // proved that), and unlike a lost stroke a survivor is one tap from gone.
    expect(result.extraction.labels[NEAR_GRIT.y0 * W + NEAR_GRIT.x0]).not.toBe(0);
  });

  it('a light stroke fragmenting into pieces shorter than w keeps every piece', () => {
    const result = getResult();
    const { labels } = result.extraction;
    // Every dash, not just the first: a gappy circle is the failure this
    // guards, and it only shows up further along the fade.
    for (let x = FADING_TAIL.x0; x <= FADING_TAIL.x1; x++) {
      if (inFadingTail(x, FADING_TAIL.y0)) {
        expect(labels[FADING_TAIL.y0 * W + x]).not.toBe(0);
      }
    }
  });

  it('a faint dash beside a stroke survives as a fragment of a line', () => {
    const result = getResult();
    const label = result.extraction.labels[DASH.y * W + DASH.x1]!;
    expect(label).not.toBe(0);
  });

  it('a coreless fragment inherits the colour of the ink beside it', () => {
    const result = getResult();
    const label = result.extraction.labels[DASH.y * W + DASH.x1]!;
    // One pixel thick: every pixel is anti-aliased edge, so its own vote is
    // black. It belongs to the blue stroke it continues, and must say so.
    expect(result.colors.byLabel.get(label)!.bucket).toBe('blue');
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

  it('supports a transparent sheet and resolved ink overrides', () => {
    const result = getResult();
    const cleaned = composeCleaned(result, 'themed', {
      background: 'transparent',
      inkFor: () => [1, 2, 3],
    });
    const bg = (20 * W + 20) * 4;
    expect(cleaned.data[bg + 3]).toBe(0);
    const ink = (58 * W + 100) * 4;
    expect(cleaned.data[ink + 3]).toBe(255);
    expect([cleaned.data[ink], cleaned.data[ink + 1], cleaned.data[ink + 2]]).toEqual([1, 2, 3]);
  });

  it('colour-mode switching never changes WHICH pixels carry ink', () => {
    const result = getResult();
    const themed = composeCleaned(result, 'themed');
    const truth = composeCleaned(result, 'true');
    // The invariant is the footprint, not the colour: recolouring must not
    // move, grow or shrink the ink. Painted-ness now includes the one-pixel
    // anti-aliased ring outside the mask, so it is read from the pixels rather
    // than assumed to equal `labels != 0`.
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      const painted = (img: typeof themed) =>
        img.data[p] !== 255 || img.data[p + 1] !== 255 || img.data[p + 2] !== 255;
      expect(painted(themed)).toBe(painted(truth));
      if (result.coverage[i] === 0) {
        expect(painted(themed)).toBe(false);
      }
    }
  });
});
