/**
 * The rectifier's maths. Two things carry real risk here and both are tested
 * against ground truth rather than against themselves:
 *
 * - the DLT solve (a property test: forward ∘ inverse is the identity over
 *   random quads, and the solved map really does take the corners where it was
 *   told to);
 * - the Zhang & He aspect recovery, checked by PROJECTING a rectangle of known
 *   shape through a synthetic camera and asking for its ratio back.
 */

import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  invertHomography,
  quadAspectRatio,
  rectifyTransform,
  sideLengthAspect,
  solveHomography,
  warpQuad,
} from '../homography';
import type { Quad, RgbaImage } from '../types';

const UNIT: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** A tiny deterministic PRNG — property tests must be reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Project a `width × height` world rectangle (on the z = 0 plane, centred at
 * the origin) through a pinhole camera with focal length `f`, rotated by
 * `yaw`/`pitch` and pushed `distance` down the optical axis.
 */
function project(
  width: number,
  height: number,
  f: number,
  yaw: number,
  pitch: number,
  distance: number,
  imageWidth: number,
  imageHeight: number,
): Quad {
  const corners = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ] as const;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const mapped = corners.map(([x, y]) => {
    // Rotate about Y (yaw), then about X (pitch).
    const x1 = cy * x;
    const z1 = -sy * x;
    const y2 = cp * y - sp * z1;
    const z2 = sp * y + cp * z1 + distance;
    return { x: (f * x1) / z2 + imageWidth / 2, y: (f * y2) / z2 + imageHeight / 2 };
  });
  return [mapped[0]!, mapped[1]!, mapped[2]!, mapped[3]!];
}

describe('solveHomography', () => {
  it('takes the source corners exactly onto the destination corners', () => {
    const target: Quad = [
      { x: 30, y: 12 },
      { x: 210, y: 40 },
      { x: 190, y: 160 },
      { x: 15, y: 140 },
    ];
    const h = solveHomography(UNIT, target)!;
    expect(h).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const mapped = applyHomography(h, UNIT[i]!);
      expect(mapped.x).toBeCloseTo(target[i]!.x, 9);
      expect(mapped.y).toBeCloseTo(target[i]!.y, 9);
    }
  });

  it('round-trips through its inverse for random quads', () => {
    const random = rng(20260805);
    for (let trial = 0; trial < 50; trial++) {
      const quad: Quad = [
        { x: random() * 100, y: random() * 100 },
        { x: 400 + random() * 100, y: random() * 100 },
        { x: 400 + random() * 100, y: 300 + random() * 100 },
        { x: random() * 100, y: 300 + random() * 100 },
      ];
      const h = solveHomography(UNIT, quad);
      expect(h).not.toBeNull();
      const inverse = invertHomography(h!);
      expect(inverse).not.toBeNull();
      const probe = { x: random(), y: random() };
      const back = applyHomography(inverse!, applyHomography(h!, probe));
      expect(back.x).toBeCloseTo(probe.x, 6);
      expect(back.y).toBeCloseTo(probe.y, 6);
    }
  });

  it('refuses a degenerate correspondence', () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(solveHomography(UNIT, collinear)).toBeNull();
    expect(rectifyTransform(collinear, 10, 10)).toBeNull();
  });
});

describe('quadAspectRatio', () => {
  it('recovers a known rectangle shape from an angled shot within 3%', () => {
    const imageWidth = 1600;
    const imageHeight = 1200;
    const focal = 1500;
    for (const [w, h] of [
      [200, 100],
      [160, 90],
      [120, 120],
    ] as const) {
      const quad = project(w, h, focal, 0.42, 0.22, 400, imageWidth, imageHeight);
      const ratio = quadAspectRatio(quad, imageWidth, imageHeight);
      expect(ratio).not.toBeNull();
      expect(Math.abs(ratio! - w / h) / (w / h)).toBeLessThan(0.03);
    }
  });

  it('beats the naive side-length estimate on a strongly angled shot', () => {
    const quad = project(200, 100, 1500, 0.6, 0.3, 380, 1600, 1200);
    const recovered = quadAspectRatio(quad, 1600, 1200)!;
    const naive = sideLengthAspect(quad);
    expect(Math.abs(recovered - 2)).toBeLessThan(Math.abs(naive - 2));
  });

  it('declines a fronto-parallel shot, where there is no perspective to invert', () => {
    const quad = project(200, 100, 1500, 0, 0, 400, 1600, 1200);
    expect(quadAspectRatio(quad, 1600, 1200)).toBeNull();
    // …and the fallback is exactly right in that case.
    expect(sideLengthAspect(quad)).toBeCloseTo(2, 6);
  });
});

describe('warpQuad', () => {
  /** Red ramps left→right, green top→bottom: position is readable per pixel. */
  function rampImage(size: number): RgbaImage {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = (y * size + x) * 4;
        data[p] = x;
        data[p + 1] = y;
        data[p + 3] = 255;
      }
    }
    return { width: size, height: size, data };
  }

  it('lifts an axis-aligned crop out pixel-for-pixel', () => {
    const image = rampImage(128);
    const crop: Quad = [
      { x: 20, y: 30 },
      { x: 84, y: 30 },
      { x: 84, y: 78 },
      { x: 20, y: 78 },
    ];
    const out = warpQuad(image, crop, 64, 48)!;
    expect(out).not.toBeNull();
    for (const [x, y] of [
      [0, 0],
      [17, 5],
      [40, 31],
      [63, 47],
    ] as const) {
      const p = (y * 64 + x) * 4;
      expect(out.data[p]!).toBeCloseTo(20 + x, 0);
      expect(out.data[p + 1]!).toBeCloseTo(30 + y, 0);
    }
  });

  it('follows the quad orientation — a flipped quad mirrors the output', () => {
    const image = rampImage(128);
    const flipped: Quad = [
      { x: 84, y: 30 },
      { x: 20, y: 30 },
      { x: 20, y: 78 },
      { x: 84, y: 78 },
    ];
    const out = warpQuad(image, flipped, 64, 48)!;
    const left = out.data[(24 * 64 + 2) * 4]!;
    const right = out.data[(24 * 64 + 61) * 4]!;
    expect(left).toBeGreaterThan(right);
  });

  it('straightens an angled quad so its parameter axes come out square', () => {
    const image = rampImage(128);
    const angled: Quad = [
      { x: 18, y: 12 },
      { x: 104, y: 30 },
      { x: 92, y: 108 },
      { x: 10, y: 86 },
    ];
    const h = rectifyTransform(angled, 64, 64)!;
    const out = warpQuad(image, angled, 64, 64)!;
    // Each output pixel must carry the source coordinates the transform says
    // it came from — that is the whole contract of the inverse map.
    for (const [x, y] of [
      [8, 8],
      [32, 32],
      [55, 20],
    ] as const) {
      const source = applyHomography(h, { x: x + 0.5, y: y + 0.5 });
      const p = (y * 64 + x) * 4;
      expect(out.data[p]!).toBeCloseTo(source.x - 0.5, 0);
      expect(out.data[p + 1]!).toBeCloseTo(source.y - 0.5, 0);
    }
  });

  it('returns null for a degenerate quad', () => {
    const image: RgbaImage = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(warpQuad(image, collinear, 8, 8)).toBeNull();
  });
});
