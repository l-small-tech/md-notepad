/**
 * The pen pipeline. The properties that matter are not "the numbers equal
 * these numbers" but: ink passes through the points the user drew, jitter is
 * attenuated without lag, a tap still leaves a mark, and the output is
 * deterministic (goldens downstream depend on it).
 */

import { describe, expect, it } from 'vitest';
import {
  buildStrokePath,
  createOneEuroFilter,
  decimatePoints,
  simplifyPoints,
  strokePathData,
} from '../smoothing';
import { flattenPathData, type Point } from '../geometry';

describe('createOneEuroFilter', () => {
  it('passes the first sample through untouched', () => {
    const filter = createOneEuroFilter();
    expect(filter({ x: 5, y: 7 }, 0)).toEqual({ x: 5, y: 7 });
  });

  it('attenuates jitter around a stationary point', () => {
    const filter = createOneEuroFilter();
    let time = 0;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      time += 16;
      // ±2px of noise, the scale a shaky hand or a cheap digitizer produces.
      const noisy = { x: 100 + (i % 2 ? 2 : -2), y: 100 + (i % 3 ? 1.5 : -1.5) };
      const last = filter(noisy, time);
      if (i > 10) {
        worst = Math.max(worst, Math.hypot(last.x - 100, last.y - 100));
      }
    }
    expect(worst).toBeLessThan(1);
  });

  it('tracks a fast straight drag closely (speed raises the cutoff)', () => {
    const filter = createOneEuroFilter();
    let time = 0;
    let filtered: Point = { x: 0, y: 0 };
    for (let i = 0; i <= 40; i++) {
      time += 16;
      filtered = filter({ x: i * 12, y: 0 }, time);
    }
    // Within a few pixels of the true position after a long constant-speed run.
    expect(Math.abs(filtered.x - 480)).toBeLessThan(12);
  });

  it('survives duplicate timestamps (coalesced events report them)', () => {
    const filter = createOneEuroFilter();
    filter({ x: 0, y: 0 }, 100);
    const out = filter({ x: 10, y: 10 }, 100);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.y)).toBe(true);
  });
});

describe('decimatePoints', () => {
  it('drops samples inside the minimum spacing but always keeps the last', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.2, y: 0 },
      { x: 5, y: 0 },
      { x: 5.1, y: 0 },
    ];
    expect(decimatePoints(points, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5.1, y: 0 },
    ]);
  });

  it('is a no-op on an empty or single-point stroke', () => {
    expect(decimatePoints([], 1)).toEqual([]);
    expect(decimatePoints([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
  });
});

describe('simplifyPoints', () => {
  it('collapses a straight run to its endpoints', () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyPoints(line, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 49, y: 0 },
    ]);
  });

  it('keeps a corner that exceeds the tolerance', () => {
    const kept = simplifyPoints(
      [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ],
      1,
    );
    expect(kept).toHaveLength(3);
  });

  it('never blows the stack on a very long stroke', () => {
    // Iterative RDP: a scanned stroke can be tens of thousands of points.
    const spiral = Array.from({ length: 50_000 }, (_, i) => ({
      x: Math.cos(i / 50) * i,
      y: Math.sin(i / 50) * i,
    }));
    expect(() => simplifyPoints(spiral, 0.5)).not.toThrow();
  });
});

describe('strokePathData', () => {
  it('renders a single tap as a zero-length segment (a round-cap dot)', () => {
    expect(strokePathData([{ x: 3, y: 4 }])).toBe('M3 4L3 4');
  });

  it('renders two points as a straight line', () => {
    expect(
      strokePathData([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ]),
    ).toBe('M0 0L10 5');
  });

  it('is empty for no points', () => {
    expect(strokePathData([])).toBe('');
  });

  it('interpolates: the curve passes through every input point', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 30, y: 5 },
      { x: 50, y: 25 },
    ];
    const flat = flattenPathData(strokePathData(points), 24).flat();
    for (const p of points) {
      const nearest = Math.min(...flat.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      expect(nearest).toBeLessThan(0.05);
    }
  });

  it('rounds to 2 decimals, so output is deterministic and diffable', () => {
    const d = strokePathData([
      { x: 1 / 3, y: 2 / 3 },
      { x: 1, y: 1 },
    ]);
    expect(d).toBe('M0.33 0.67L1 1');
  });
});

describe('buildStrokePath', () => {
  it('turns a dense noisy capture into a short path that still tracks the line', () => {
    const raw = Array.from({ length: 400 }, (_, i) => ({ x: i / 4, y: 50 }));
    const d = buildStrokePath(raw);
    // 400 samples of a straight line must not become 400 curve segments.
    expect((d.match(/C/g) ?? []).length).toBeLessThan(4);
    const flat = flattenPathData(d).flat();
    for (const p of flat) {
      expect(Math.abs(p.y - 50)).toBeLessThan(0.5);
    }
  });

  it('is empty when there is nothing to draw', () => {
    expect(buildStrokePath([])).toBe('');
  });
});
