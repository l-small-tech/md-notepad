/**
 * Coverage turns a yes/no mask back into something with edges. The cases below
 * are the three ways that can go wrong: a solid stroke must stay SOLID (or the
 * flat palette colour never appears anywhere), a bright chromatic marker must
 * not be measured as if coverage meant darkness, and the taper must reach past
 * the mask so a stroke does not end on a step.
 */

import { describe, expect, it } from 'vitest';
import { inkCoverage } from '../coverage';
import { distanceTransform } from '../distance';
import type { InkComponent, InkExtraction } from '../components';
import type { RgbaImage } from '../types';

const W = 40;
const H = 20;

/**
 * Build an extraction by hand: one component covering `inside`, with real
 * distance-transform values so the core/rim split is the genuine one.
 */
function extractionFor(inside: (x: number, y: number) => boolean): InkExtraction {
  const mask = new Uint8Array(W * H);
  const labels = new Int32Array(W * H);
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) {
        continue;
      }
      mask[y * W + x] = 1;
      labels[y * W + x] = 1;
      area++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const distance = distanceTransform(mask, W, H);
  let dtMax = 0;
  for (let i = 0; i < distance.length; i++) {
    if (labels[i] !== 0 && distance[i]! > dtMax) {
      dtMax = distance[i]!;
    }
  }
  const component: InkComponent = {
    label: 1,
    area,
    minX,
    minY,
    maxX,
    maxY,
    perimeter: 0,
    thinness: 0,
    strongRatio: 1,
    meanChroma: 0,
    dtMax,
    touchesBorder: false,
    glareRatio: 0,
  };
  return {
    mask,
    labels,
    components: [component],
    strokeWidth: 4,
    distance,
    removed: { ghost: 0, speckle: 0, faint: 0, blob: 0, border: 0, glare: 0 },
  };
}

/** A white board with `ink` painted where `inside` says, plus a soft rim. */
function image(
  inside: (x: number, y: number) => boolean,
  ink: readonly [number, number, number],
  rim?: readonly [number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const near =
        !inside(x, y) && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => inside(x + dx, y + dy)));
      const rgb = inside(x, y) ? ink : near && rim ? rim : ([255, 255, 255] as const);
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

/** A 6-px-thick horizontal bar — thick enough to have a real core. */
const bar = (x: number, y: number) => x >= 8 && x <= 30 && y >= 7 && y <= 12;

describe('inkCoverage', () => {
  it('paints a solid stroke solid, so the flat palette colour survives', () => {
    const coverage = inkCoverage(image(bar, [30, 30, 30]), extractionFor(bar));
    // Every interior pixel, not just the middle: a plateau that only saturates
    // at its centre would leave the stroke visibly domed.
    for (let y = 8; y <= 11; y++) {
      for (let x = 10; x <= 28; x++) {
        expect(coverage[y * W + x]).toBe(255);
      }
    }
  });

  it('measures a BRIGHT chromatic marker as fully covered too', () => {
    // Yellow is lighter than most board pixels in two channels; a coverage
    // measured by luminance would render it nearly transparent, which is
    // exactly the trap `inkness = 255 - min(R,G,B)` exists to avoid.
    const coverage = inkCoverage(image(bar, [235, 220, 40]), extractionFor(bar));
    expect(coverage[9 * W + 20]).toBe(255);
  });

  it('tapers into the ring OUTSIDE the mask instead of ending on a step', () => {
    const coverage = inkCoverage(image(bar, [30, 30, 30], [150, 150, 150]), extractionFor(bar));
    const justOutside = coverage[6 * W + 20]!;
    expect(justOutside).toBeGreaterThan(0);
    expect(justOutside).toBeLessThan(255);
    // …and stops there: two pixels out is clean board.
    expect(coverage[5 * W + 20]).toBe(0);
  });

  it('leaves blank board at zero', () => {
    const coverage = inkCoverage(image(bar, [30, 30, 30]), extractionFor(bar));
    expect(coverage[1 * W + 1]).toBe(0);
    expect(coverage[18 * W + 38]).toBe(0);
  });

  it('is deterministic and handles an empty extraction', () => {
    const empty = extractionFor(() => false);
    const coverage = inkCoverage(image(bar, [30, 30, 30]), {
      ...empty,
      components: [],
    });
    expect(coverage.every((v) => v === 0)).toBe(true);
  });

  it('scales a FAINT stroke to solid — coverage is where, not how hard', () => {
    // A dying marker leaves a light trace. It must read as present, not as a
    // uniformly translucent smear; the component's flat colour already carries
    // which marker it was.
    const faint = inkCoverage(image(bar, [205, 195, 215]), extractionFor(bar));
    const dark = inkCoverage(image(bar, [40, 30, 60]), extractionFor(bar));
    expect(faint[9 * W + 20]).toBe(255);
    expect(dark[9 * W + 20]).toBe(255);
  });
});
