/**
 * The phase-6 golden: a synthetic cleaned board through the WHOLE tracer.
 * A drawn bar comes back as ONE pen stroke of the right length and width; a
 * solid block falls back to a filled contour; a dot stays a dot; colours snap
 * to the palette in themed mode, stay measured in true mode, and follow the
 * review screen's remap; the transform bakes pixel→scene coordinates; and the
 * size guard measures honestly.
 */

import { describe, expect, it } from 'vitest';
import { createCleaner, type CleanResult } from '../clean';
import { SCAN_PALETTE, type MarkerColor } from '../color';
import { buildScanElements, createTracer, fitScanElements, type TraceResult } from '../trace';
import { flattenPathData } from '../../geometry';
import type { RgbaImage } from '../types';

const W = 320;
const H = 240;

/** White board, no lighting tricks — phase 5 owns those; this is S5's turn. */
function syntheticBoard(): RgbaImage {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const paint = (x: number, y: number, rgb: readonly [number, number, number]) => {
    const i = (y * W + x) * 4;
    data[i] = rgb[0];
    data[i + 1] = rgb[1];
    data[i + 2] = rgb[2];
  };
  // A long horizontal blue bar, 6 px thick: one stroke.
  for (let y = 60; y < 66; y++) {
    for (let x = 30; x < 230; x++) {
      paint(x, y, [40, 90, 200]);
    }
  }
  // A solid 40×40 black block: blob → contour fill.
  for (let y = 120; y < 160; y++) {
    for (let x = 40; x < 80; x++) {
      paint(x, y, [25, 25, 25]);
    }
  }
  // A 6×6 red dot: must survive as a dot.
  for (let y = 120; y < 126; y++) {
    for (let x = 200; x < 206; x++) {
      paint(x, y, [200, 40, 40]);
    }
  }
  return { width: W, height: H, data };
}

function clean(): CleanResult {
  const job = createCleaner(syntheticBoard());
  while (!job.done) {
    job.step();
  }
  return job.result()!;
}

function trace(cleaned: CleanResult): TraceResult {
  const job = createTracer(cleaned);
  while (!job.done) {
    job.step();
  }
  return job.result()!;
}

function polylineLength(d: string): number {
  let total = 0;
  for (const sub of flattenPathData(d)) {
    for (let i = 1; i < sub.length; i++) {
      total += Math.hypot(sub[i]!.x - sub[i - 1]!.x, sub[i]!.y - sub[i - 1]!.y);
    }
  }
  return total;
}

describe('createTracer', () => {
  const cleaned = clean();
  const result = trace(cleaned);

  it('finds all three components and keeps their shapes apart', () => {
    expect(result.components.length).toBe(3);
    expect(result.components.filter((c) => c.kind === 'stroke').length).toBe(2);
    expect(result.components.filter((c) => c.kind === 'fill').length).toBe(1);
  });

  it('traces the bar as one centerline of the drawn length and width', () => {
    const strokes = result.components.filter((c) => c.kind === 'stroke');
    const bar = strokes.find((s) => s.paths.some((p) => p.length > 1))!;
    expect(bar).toBeDefined();
    expect(bar.paths.length).toBe(1);
    const path = bar.paths[0]!;
    const xs = path.map((p) => p.x);
    const drawn = 200; // 30..230
    const traced = Math.max(...xs) - Math.min(...xs);
    // Centerline length within tolerance of the drawn bar (thinning eats
    // roughly half a stroke width at each end).
    expect(traced).toBeGreaterThan(drawn - 12);
    expect(traced).toBeLessThan(drawn + 4);
    expect(bar.strokeWidth).toBeGreaterThan(4);
    expect(bar.strokeWidth).toBeLessThan(9);
  });

  it('keeps the dot as a dot', () => {
    const strokes = result.components.filter((c) => c.kind === 'stroke');
    const dot = strokes.find((s) => s.paths.every((p) => p.length <= 2))!;
    expect(dot).toBeDefined();
    expect(dot.strokeWidth).toBeGreaterThan(2);
  });
});

describe('vector-level despeckle', () => {
  /** The golden board plus residue: a 2×2 speck, and a long 2px hairline. */
  function speckledBoard(): RgbaImage {
    const board = syntheticBoard();
    const paint = (x: number, y: number, rgb: readonly [number, number, number]) => {
      const i = (y * W + x) * 4;
      board.data[i] = rgb[0];
      board.data[i + 1] = rgb[1];
      board.data[i + 2] = rgb[2];
    };
    // A 2×2 eraser-residue speck: far thinner than the 6 px pen — dropped.
    for (let y = 200; y < 202; y++) {
      for (let x = 60; x < 62; x++) {
        paint(x, y, [90, 60, 110]);
      }
    }
    // A 60px-long 2px hairline: thin but LONG — genuine fading ink, kept.
    for (let y = 200; y < 202; y++) {
      for (let x = 150; x < 210; x++) {
        paint(x, y, [90, 60, 110]);
      }
    }
    return board;
  }

  const job = createCleaner(speckledBoard());
  while (!job.done) {
    job.step();
  }
  const cleaned = job.result()!;
  const result = trace(cleaned);

  it('drops the speck, keeps the thin-but-long hairline and everything real', () => {
    // 3 originals + hairline; the speck is gone.
    expect(result.components.length).toBe(4);
    const strokes = result.components.filter((c) => c.kind === 'stroke');
    const hairline = strokes.find(
      (s) => s.paths.length === 1 && s.paths[0]!.length > 1 && s.strokeWidth <= 3,
    );
    expect(hairline).toBeDefined();
    // Nothing traced anywhere near the speck.
    const nearSpeck = strokes.some((s) =>
      s.paths.some((p) => p.some((q) => Math.hypot(q.x - 61, q.y - 201) < 5)),
    );
    expect(nearSpeck).toBe(false);
  });

  it('gives each path its own width instead of one component-wide median', () => {
    const elements = buildScanElements(result, cleaned.colors, { mode: 'true' });
    const pens = elements.filter((e) => e.tool === 'pen' && polylineLength(e.d) > 30);
    const widths = pens.map((p) => p.strokeWidth);
    // The fat bar and the hairline must NOT share a width.
    expect(Math.max(...widths)).toBeGreaterThan(4);
    expect(Math.min(...widths)).toBeLessThan(3);
  });
});

describe('buildScanElements', () => {
  const cleaned = clean();
  const result = trace(cleaned);

  it('emits pen strokes with palette colours and per-vertex widths (themed)', () => {
    const elements = buildScanElements(result, cleaned.colors, { mode: 'themed' });
    const pens = elements.filter((e) => e.tool === 'pen');
    expect(pens.length).toBe(2);
    for (const pen of pens) {
      expect(Object.values(SCAN_PALETTE)).toContain(pen.stroke);
      expect(pen.widths).not.toBeNull();
      expect(pen.widths!.split(' ').length).toBeGreaterThan(0);
    }
    expect(pens.some((p) => p.stroke === SCAN_PALETTE.blue)).toBe(true);
    expect(pens.some((p) => p.stroke === SCAN_PALETTE.red)).toBe(true);
  });

  it('emits the block as an evenodd fill in its voted colour', () => {
    const elements = buildScanElements(result, cleaned.colors, { mode: 'themed' });
    const fills = elements.filter((e) => e.tool === 'scanfill');
    expect(fills.length).toBe(1);
    expect(fills[0]!.stroke).toBe(SCAN_PALETTE.black);
    expect(fills[0]!.d.endsWith('Z')).toBe(true);
  });

  it('keeps measured colours in true mode', () => {
    const elements = buildScanElements(result, cleaned.colors, { mode: 'true' });
    const palette = new Set(Object.values(SCAN_PALETTE));
    // Measured colours are medians of the synthetic ink, not canonical hexes.
    expect(elements.some((e) => !palette.has(e.stroke))).toBe(true);
  });

  it('follows a remap in every mode', () => {
    const remap = new Map<MarkerColor, MarkerColor>([['blue', 'green']]);
    for (const mode of ['themed', 'true'] as const) {
      const elements = buildScanElements(result, cleaned.colors, { mode, remap });
      expect(elements.some((e) => e.stroke === SCAN_PALETTE.green)).toBe(true);
      expect(elements.some((e) => e.stroke === SCAN_PALETTE.blue)).toBe(false);
    }
  });

  it('bakes the transform into coordinates and widths', () => {
    const identity = buildScanElements(result, cleaned.colors, { mode: 'themed' });
    const scaled = buildScanElements(result, cleaned.colors, {
      mode: 'themed',
      transform: { scale: 0.5, dx: 100, dy: 40 },
    });
    const bar = identity.find((e) => e.tool === 'pen' && polylineLength(e.d) > 50)!;
    const barScaled = scaled.find((e) => e.tool === 'pen' && polylineLength(e.d) > 25)!;
    expect(polylineLength(barScaled.d)).toBeCloseTo(polylineLength(bar.d) / 2, 0);
    expect(barScaled.strokeWidth).toBeCloseTo(bar.strokeWidth / 2, 1);
  });
});

describe('fitScanElements', () => {
  const cleaned = clean();
  const result = trace(cleaned);

  it('measures the build and does not coarsen a small board', () => {
    const fitted = fitScanElements(result, cleaned.colors, { mode: 'themed' });
    expect(fitted.strokes).toBe(3);
    expect(fitted.bytes).toBeGreaterThan(0);
    expect(fitted.epsilonFactor).toBe(1);
    expect(fitted.reduced).toBe(false);
  });
});
