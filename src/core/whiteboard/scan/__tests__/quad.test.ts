/**
 * Board detection. The synthetic fixtures are built here rather than committed
 * as bytes so the goldens stay deterministic across platforms (a JPEG decoder
 * differs between them; a generated buffer does not).
 *
 * What is asserted is behaviour under the conditions the detector actually
 * meets: a bright quad on a darker wall seen at an angle, a board that fills
 * the frame, and a photo with nothing board-shaped in it at all.
 */

import { describe, expect, it } from 'vitest';
import {
  convexHull,
  decimatePolygon,
  detectBoardQuad,
  frameQuad,
  maxAreaQuad,
  orderQuad,
  polygonArea,
} from '../quad';
import type { Quad, RgbaImage, ScanPoint } from '../types';

/** A blank RGBA canvas filled with one grey level. */
function canvas(width: number, height: number, level: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = level;
    data[i + 1] = level;
    data[i + 2] = level;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Is `p` inside the (convex) polygon? Same-sign cross products all round. */
function inside(polygon: readonly ScanPoint[], p: ScanPoint): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) {
      continue;
    }
    const next = cross > 0 ? 1 : -1;
    if (sign === 0) {
      sign = next;
    } else if (sign !== next) {
      return false;
    }
  }
  return true;
}

/** Paint a bright convex quad onto a darker background. */
function boardImage(width: number, height: number, quad: Quad, wall = 60, board = 235): RgbaImage {
  const image = canvas(width, height, wall);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inside(quad, { x: x + 0.5, y: y + 0.5 })) {
        const p = (y * width + x) * 4;
        image.data[p] = board;
        image.data[p + 1] = board;
        image.data[p + 2] = board;
      }
    }
  }
  return image;
}

describe('convexHull', () => {
  it('drops interior points and keeps the extremes', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
      { x: 3, y: 7 },
    ]);
    expect(hull).toHaveLength(4);
    expect(polygonArea(hull)).toBeCloseTo(100, 6);
  });

  it('returns short inputs unchanged', () => {
    expect(convexHull([{ x: 1, y: 2 }])).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('decimatePolygon', () => {
  it('reaches the vertex budget exactly', () => {
    const circle: ScanPoint[] = [];
    for (let i = 0; i < 40; i++) {
      const t = (i / 40) * Math.PI * 2;
      circle.push({ x: Math.cos(t) * 100, y: Math.sin(t) * 100 });
    }
    expect(decimatePolygon(circle, 12)).toHaveLength(12);
  });

  it('keeps the corners of a square with noise along its edges', () => {
    const square: ScanPoint[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0.2 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
      { x: 50, y: 100.2 },
      { x: 0, y: 100 },
      { x: 0, y: 50 },
    ];
    const kept = decimatePolygon(square, 4);
    expect(kept).toHaveLength(4);
    // Area is preserved to within the noise, i.e. the true corners survived.
    expect(polygonArea(kept)).toBeGreaterThan(9900);
  });
});

describe('maxAreaQuad', () => {
  it('picks the four extreme vertices of an octagon', () => {
    const octagon: ScanPoint[] = [
      { x: 0, y: 30 },
      { x: 30, y: 0 },
      { x: 70, y: 0 },
      { x: 100, y: 30 },
      { x: 100, y: 70 },
      { x: 70, y: 100 },
      { x: 30, y: 100 },
      { x: 0, y: 70 },
    ];
    const quad = maxAreaQuad(octagon);
    expect(quad).not.toBeNull();
    expect(polygonArea(quad!)).toBeGreaterThan(polygonArea(octagon) * 0.7);
  });

  it('refuses fewer than four vertices', () => {
    expect(
      maxAreaQuad([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    ).toBeNull();
  });
});

describe('orderQuad', () => {
  it('canonicalizes any winding to TL, TR, BR, BL', () => {
    const expected: Quad = [
      { x: 10, y: 20 },
      { x: 90, y: 15 },
      { x: 95, y: 80 },
      { x: 5, y: 85 },
    ];
    // Every rotation and the reversed winding must produce the same order.
    for (let shift = 0; shift < 4; shift++) {
      const rotated = [0, 1, 2, 3].map((i) => expected[(i + shift) % 4]!) as unknown as Quad;
      expect(orderQuad(rotated)).toEqual(expected);
      const reversed = [...rotated].reverse() as unknown as Quad;
      expect(orderQuad(reversed)).toEqual(expected);
    }
  });
});

describe('detectBoardQuad', () => {
  it('finds a bright board seen at an angle, within a few pixels', () => {
    const truth: Quad = [
      { x: 120, y: 90 },
      { x: 640, y: 40 },
      { x: 690, y: 460 },
      { x: 90, y: 420 },
    ];
    const result = detectBoardQuad(boardImage(800, 560, truth));
    expect(result.source).toBe('detected');
    for (let i = 0; i < 4; i++) {
      expect(
        Math.hypot(result.quad[i]!.x - truth[i]!.x, result.quad[i]!.y - truth[i]!.y),
      ).toBeLessThan(16);
    }
  });

  it('falls back to the whole frame when the board fills it', () => {
    const result = detectBoardQuad(canvas(400, 300, 240));
    expect(result.source).toBe('frame');
    expect(result.quad).toEqual(frameQuad(400, 300));
  });

  it('falls back when the bright region is too small to be a board', () => {
    const speck: Quad = [
      { x: 10, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 40 },
      { x: 10, y: 40 },
    ];
    expect(detectBoardQuad(boardImage(400, 300, speck)).source).toBe('frame');
  });

  it('falls back on an image too small to detect anything in', () => {
    expect(detectBoardQuad(canvas(4, 4, 128)).source).toBe('frame');
  });
});
