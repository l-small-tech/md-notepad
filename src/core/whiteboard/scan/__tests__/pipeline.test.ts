/**
 * Output sizing and the banded rectifier. The contract worth pinning is that a
 * banded run produces EXACTLY the bytes a one-shot warp does — the whole point
 * of banding is to be invisible — and that the plan never upsamples a quad
 * beyond what the source resolves.
 */

import { describe, expect, it } from 'vitest';
import { warpQuad } from '../homography';
import { createRectifier, planRectify } from '../pipeline';
import { downscale, luminance, otsuThreshold, resample, rotate90 } from '../image-ops';
import type { Quad, RgbaImage } from '../types';

function noiseImage(width: number, height: number, seed = 1): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = state >>> 24;
    data[i + 1] = (state >>> 16) & 0xff;
    data[i + 2] = (state >>> 8) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

const ANGLED: Quad = [
  { x: 40, y: 30 },
  { x: 560, y: 60 },
  { x: 540, y: 380 },
  { x: 60, y: 350 },
];

describe('planRectify', () => {
  it('clamps the long edge to what the source actually resolves', () => {
    const image = noiseImage(600, 420);
    const plan = planRectify(image, ANGLED, 'detailed');
    // The quad's widest side is ~520 px, so 'detailed' (2400) must not apply.
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(525);
  });

  it('uses the preset when the source has the pixels', () => {
    const big: Quad = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 2000 },
      { x: 0, y: 2000 },
    ];
    const plan = planRectify(noiseImage(8, 8), big, 'fast');
    expect(Math.max(plan.width, plan.height)).toBe(1200);
    expect(plan.aspectSource).toBe('sides');
    expect(plan.aspect).toBeCloseTo(1.5, 6);
  });

  it('never emits a degenerate size', () => {
    const sliver: Quad = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 0.2 },
      { x: 0, y: 0.2 },
    ];
    const plan = planRectify(noiseImage(320, 8), sliver, 'balanced');
    expect(plan.width).toBeGreaterThanOrEqual(16);
    expect(plan.height).toBeGreaterThanOrEqual(16);
  });
});

describe('createRectifier', () => {
  it('produces byte-identical output to a one-shot warp', () => {
    const image = noiseImage(600, 420, 7);
    const job = createRectifier(image, ANGLED, 'fast')!;
    expect(job).not.toBeNull();
    expect(job.result()).toBeNull();
    let guard = 0;
    while (!job.done && guard++ < 10_000) {
      job.step(17);
    }
    expect(job.done).toBe(true);
    const banded = job.result()!;
    const oneShot = warpQuad(image, ANGLED, job.plan.width, job.plan.height)!;
    expect(banded.width).toBe(oneShot.width);
    expect(banded.height).toBe(oneShot.height);
    expect(Array.from(banded.data)).toEqual(Array.from(oneShot.data));
  });

  it('refuses a degenerate quad', () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(createRectifier(noiseImage(8, 8), collinear)).toBeNull();
  });
});

describe('image-ops', () => {
  it('downscale returns the same object when nothing needs doing', () => {
    const image = noiseImage(100, 80);
    expect(downscale(image, 200)).toBe(image);
  });

  it('downscale box-averages rather than subsampling', () => {
    // A 2×1 checkerboard: averaging gives mid-grey, subsampling gives an
    // extreme. Nearest-neighbour here is what turns strokes into speckle.
    const data = new Uint8ClampedArray(8);
    data.set([0, 0, 0, 255], 0);
    data.set([255, 255, 255, 255], 4);
    const halved = resample({ width: 2, height: 1, data }, 1, 1);
    expect(halved.data[0]).toBeGreaterThan(100);
    expect(halved.data[0]).toBeLessThan(155);
  });

  it('otsuThreshold splits a bimodal histogram between its modes', () => {
    const gray = new Uint8ClampedArray(1000);
    gray.fill(40, 0, 400);
    gray.fill(210, 400);
    // "Bright" means `> level`, so the boundary level itself is a valid answer:
    // what matters is that thresholding there separates the two modes.
    const level = otsuThreshold(gray);
    expect(level).toBeGreaterThanOrEqual(40);
    expect(level).toBeLessThan(210);
  });

  it('rotate90 turns clockwise and swaps the axes', () => {
    // A 2×1 strip: red then green. A quarter turn clockwise makes it 1×2 with
    // red on TOP — the marker for "clockwise" rather than the other way.
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const turned = rotate90({ width: 2, height: 1, data });
    expect(turned.width).toBe(1);
    expect(turned.height).toBe(2);
    expect([turned.data[0], turned.data[1]]).toEqual([255, 0]);
    expect([turned.data[4], turned.data[5]]).toEqual([0, 255]);
  });

  it('rotate90 four times is the identity', () => {
    const image = noiseImage(5, 3, 99);
    let turned = image;
    for (let i = 0; i < 4; i++) {
      turned = rotate90(turned);
    }
    expect(turned.width).toBe(image.width);
    expect(turned.height).toBe(image.height);
    expect(Array.from(turned.data)).toEqual(Array.from(image.data));
  });

  it('luminance weights green most heavily', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const gray = luminance({ width: 3, height: 1, data });
    expect(gray[1]!).toBeGreaterThan(gray[0]!);
    expect(gray[0]!).toBeGreaterThan(gray[2]!);
  });
});
