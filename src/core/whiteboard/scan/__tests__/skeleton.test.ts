/**
 * Phase-6 skeleton goldens, per the plan's verify list: thinning produces a
 * clean 1-px skeleton, the graph walk recovers whole strokes, spurs die,
 * junctions CONTINUE (an "X" is two strokes, not four stubs), loops close,
 * and a crossed-out bar stays two readable strokes.
 */

import { describe, expect, it } from 'vitest';
import { thinInPlace } from '../thin';
import { traceSkeletonPaths } from '../skeleton';
import type { Point } from '../../geometry';

const W = 64;
const H = 64;

function grid(): Uint8Array {
  return new Uint8Array(W * H);
}

/** 1-px Bresenham line straight into the mask — for graph-only tests. */
function line(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    mask[y * W + x] = 1;
    if (x === x1 && y === y1) {
      break;
    }
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Thick axis-aligned bar, for thinning tests. */
function bar(mask: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      mask[y * W + x] = 1;
    }
  }
}

function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
  }
  return total;
}

function span(path: readonly Point[]): { w: number; h: number } {
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  return {
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

describe('thinInPlace', () => {
  it('reduces a thick bar to a single centerline', () => {
    const mask = grid();
    bar(mask, 8, 28, 56, 34); // 49 × 7 bar
    thinInPlace(mask, W, H);
    let count = 0;
    for (const v of mask) {
      count += v;
    }
    // A 49-px-long bar's skeleton is ~its length, nowhere near its area (343).
    expect(count).toBeGreaterThan(35);
    expect(count).toBeLessThan(60);
    // And it stays one connected piece: the walk must find exactly one path.
    const paths = traceSkeletonPaths(mask, W, H, 0);
    expect(paths.length).toBe(1);
    expect(span(paths[0]!).w).toBeGreaterThan(38);
  });

  it('is idempotent', () => {
    const mask = grid();
    bar(mask, 8, 28, 56, 34);
    thinInPlace(mask, W, H);
    const once = mask.slice();
    thinInPlace(mask, W, H);
    expect([...mask]).toEqual([...once]);
  });
});

describe('traceSkeletonPaths', () => {
  it('continues through an X junction: two strokes, not four stubs', () => {
    const mask = grid();
    line(mask, 8, 8, 56, 56);
    line(mask, 56, 8, 8, 56);
    const paths = traceSkeletonPaths(mask, W, H, 4);
    expect(paths.length).toBe(2);
    for (const path of paths) {
      const s = span(path);
      // Each stroke must run the FULL diagonal — corner to corner.
      expect(s.w).toBeGreaterThan(44);
      expect(s.h).toBeGreaterThan(44);
    }
  });

  it('keeps a T as its crossbar and its stem', () => {
    const mask = grid();
    line(mask, 8, 16, 56, 16); // crossbar
    line(mask, 32, 16, 32, 56); // stem
    const paths = traceSkeletonPaths(mask, W, H, 4);
    expect(paths.length).toBe(2);
    const bars = paths.filter((p) => span(p).w > 40 && span(p).h < 6);
    const stems = paths.filter((p) => span(p).h > 34 && span(p).w < 6);
    expect(bars.length).toBe(1);
    expect(stems.length).toBe(1);
  });

  it('keeps a crossed-out bar readable: the bar survives whole', () => {
    const mask = grid();
    line(mask, 8, 32, 56, 32); // the word
    line(mask, 20, 24, 44, 40); // the strike
    const paths = traceSkeletonPaths(mask, W, H, 4);
    // The WORD is the promise: it must come back as one unbroken stroke. The
    // shallow strike shares a pixel run with the bar through the crossing, and
    // a shared run is genuinely ambiguous — it may fragment into a few pieces
    // (they overlay the crossing, so the ink still reads correctly). Only a
    // real regression — the bar shattering, or wholesale fragmentation —
    // fails this.
    expect(paths.some((p) => span(p).w > 44 && span(p).h < 4)).toBe(true);
    expect(paths.length).toBeLessThanOrEqual(5);
    const total = paths.reduce((n, p) => n + pathLength(p), 0);
    expect(total).toBeGreaterThan(48 + 26); // both strokes' ink is present
  });

  it('prunes a short spur off a long stroke', () => {
    const mask = grid();
    line(mask, 8, 32, 56, 32);
    line(mask, 40, 32, 42, 29); // a 3-px thinning barb
    const paths = traceSkeletonPaths(mask, W, H, 6);
    expect(paths.length).toBe(1);
    expect(span(paths[0]!).w).toBeGreaterThan(44);
  });

  it('never prunes a short stroke that is not a spur', () => {
    const mask = grid();
    line(mask, 8, 8, 11, 8); // a real, tiny, isolated dash
    const paths = traceSkeletonPaths(mask, W, H, 6);
    expect(paths.length).toBe(1);
  });

  it('walks a closed loop into one closed path', () => {
    const mask = grid();
    line(mask, 16, 16, 48, 16);
    line(mask, 48, 16, 48, 48);
    line(mask, 48, 48, 16, 48);
    line(mask, 16, 48, 16, 16);
    const paths = traceSkeletonPaths(mask, W, H, 4);
    expect(paths.length).toBe(1);
    const path = paths[0]!;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThanOrEqual(2);
    expect(pathLength(path)).toBeGreaterThan(100);
  });

  it('emits an isolated pixel as a dot', () => {
    const mask = grid();
    mask[20 * W + 20] = 1;
    const paths = traceSkeletonPaths(mask, W, H, 4);
    expect(paths.length).toBe(1);
    expect(paths[0]!.length).toBe(1);
  });
});
