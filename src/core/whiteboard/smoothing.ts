/**
 * Raw pointer samples → a smooth `<path d>`.
 *
 * Hand-rolled, ~150 lines, no dependency. `perfect-freehand` was considered and
 * declined: it emits a FILLED OUTLINE, which would break stroke semantics
 * (`stroke`/`stroke-width` stop meaning anything, the eraser's centerline
 * hit-test stops working, and a scanned centerline could no longer be the same
 * kind of element as a drawn one). If variable-width ink is wanted later it
 * belongs in a separate "brush" tool, not in the pen.
 *
 * Three stages, each independently useful and independently tested:
 *
 * 1. {@link createOneEuroFilter} — the 1€ filter (Casiez, Roussel & Vogel,
 *    CHI 2012). Jitter at rest, no lag while moving; the cutoff frequency rises
 *    with speed. This is what makes a shaky finger or a cheap digitizer draw a
 *    clean line without the rubber-banding a fixed low-pass would add.
 * 2. {@link simplifyPoints} — Ramer–Douglas–Peucker. A 4 s stroke can be 1000
 *    samples; the eye cannot tell 1000 from 60, and the file size and the
 *    hit-test both care. Phase 6's tracer reuses this with an ε scaled to the
 *    stroke width.
 * 3. {@link strokePathData} — Catmull-Rom through the surviving points,
 *    converted to cubic Béziers (the standard `±(p2−p0)/6` control points).
 *    Interpolating, so the ink passes exactly through the sampled points.
 */

import type { Point } from './geometry';
import { distance } from './geometry';
import { num } from './serialize';

/* ------------------------------- 1€ filter -------------------------------- */

export interface OneEuroOptions {
  /** Cutoff at zero speed, Hz. Lower = steadier at rest, more lag. */
  minCutoff?: number;
  /** How fast the cutoff rises with speed. Higher = less lag when moving fast. */
  beta?: number;
  /** Cutoff for the speed estimate itself, Hz. */
  dCutoff?: number;
}

/** Tuned on pen and mouse input at 60–240 Hz; steady at rest, no visible lag. */
const DEFAULT_ONE_EURO: Required<OneEuroOptions> = {
  minCutoff: 1.2,
  beta: 0.02,
  dCutoff: 1,
};

function smoothingFactor(deltaSeconds: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * deltaSeconds;
  return r / (r + 1);
}

/**
 * A stateful per-stroke filter. Feed it every raw sample with its timestamp
 * (ms); it returns the filtered position. Create a new one per stroke — the
 * state is the previous sample and the previous speed estimate.
 */
export function createOneEuroFilter(
  options: OneEuroOptions = {},
): (point: Point, timeMs: number) => Point {
  const { minCutoff, beta, dCutoff } = { ...DEFAULT_ONE_EURO, ...options };
  let previous: Point | null = null;
  let previousDerivative: Point = { x: 0, y: 0 };
  let previousTime = 0;

  return (point, timeMs) => {
    if (previous === null) {
      previous = point;
      previousTime = timeMs;
      return point;
    }
    // Guard against duplicate/backwards timestamps: some WebViews report the
    // same ms for coalesced events, and 1/0 would blow the filter up.
    const deltaSeconds = Math.max((timeMs - previousTime) / 1000, 1 / 1000);
    previousTime = timeMs;

    const alphaD = smoothingFactor(deltaSeconds, dCutoff);
    const derivative = {
      x:
        previousDerivative.x +
        alphaD * ((point.x - previous.x) / deltaSeconds - previousDerivative.x),
      y:
        previousDerivative.y +
        alphaD * ((point.y - previous.y) / deltaSeconds - previousDerivative.y),
    };
    previousDerivative = derivative;

    const speed = Math.hypot(derivative.x, derivative.y);
    const alpha = smoothingFactor(deltaSeconds, minCutoff + beta * speed);
    const filtered = {
      x: previous.x + alpha * (point.x - previous.x),
      y: previous.y + alpha * (point.y - previous.y),
    };
    previous = filtered;
    return filtered;
  };
}

/* -------------------------------- decimation ------------------------------ */

/** Drop samples closer than `minDistance` to the last kept one. */
export function decimatePoints(points: readonly Point[], minDistance: number): Point[] {
  if (points.length === 0) {
    return [];
  }
  const kept: Point[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    if (distance(kept[kept.length - 1]!, points[i]!) >= minDistance) {
      kept.push(points[i]!);
    }
  }
  // The final sample is where the user lifted the pen; never lose it.
  const last = points[points.length - 1]!;
  if (kept[kept.length - 1] !== last) {
    kept.push(last);
  }
  return kept;
}

/**
 * Ramer–Douglas–Peucker. Iterative (an explicit stack) rather than recursive:
 * a scanned stroke can be tens of thousands of points, and this must not be
 * able to blow the call stack.
 */
export function simplifyPoints(points: readonly Point[], epsilon: number): Point[] {
  return simplifyIndices(points, epsilon).map((i) => points[i]!);
}

/**
 * The same RDP, returning the KEPT INDICES instead of the points. The scan
 * tracer needs this form: each traced vertex carries a sampled width, and the
 * widths must survive simplification in lockstep with their points.
 */
export function simplifyIndices(points: readonly Point[], epsilon: number): number[] {
  if (points.length <= 2 || epsilon <= 0) {
    return points.map((_, i) => i);
  }
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) {
      continue;
    }
    const a = points[from]!;
    const b = points[to]!;
    let worst = 0;
    let worstIndex = -1;
    for (let i = from + 1; i < to; i++) {
      const d = perpendicularDistance(points[i]!, a, b);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > epsilon && worstIndex > 0) {
      keep[worstIndex] = 1;
      stack.push([from, worstIndex], [worstIndex, to]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) {
      out.push(i);
    }
  }
  return out;
}

/** Distance from `p` to the INFINITE line through a–b (RDP's measure). */
function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return distance(p, a);
  }
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / length;
}

/* ------------------------------- path building ---------------------------- */

/** Catmull-Rom tension: 1/6 is the value that makes the spline interpolating. */
const CR_TENSION = 1 / 6;

/**
 * Points → `d`, as cubic Béziers through every point.
 *
 * A single point becomes a zero-length segment, which with
 * `stroke-linecap="round"` renders as a dot — a tap must leave a mark.
 */
export function strokePathData(points: readonly Point[]): string {
  if (points.length === 0) {
    return '';
  }
  const first = points[0]!;
  if (points.length === 1) {
    return `M${num(first.x)} ${num(first.y)}L${num(first.x)} ${num(first.y)}`;
  }
  if (points.length === 2) {
    const second = points[1]!;
    return `M${num(first.x)} ${num(first.y)}L${num(second.x)} ${num(second.y)}`;
  }

  let d = `M${num(first.x)} ${num(first.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    // The endpoints duplicate themselves so the curve starts and ends cleanly
    // instead of overshooting toward a phantom neighbour.
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * CR_TENSION;
    const c1y = p1.y + (p2.y - p0.y) * CR_TENSION;
    const c2x = p2.x - (p3.x - p1.x) * CR_TENSION;
    const c2y = p2.y - (p3.y - p1.y) * CR_TENSION;
    d += `C${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(p2.x)} ${num(p2.y)}`;
  }
  return d;
}

/**
 * The whole pen pipeline: decimate → simplify → spline. The editor feeds this
 * the ALREADY 1€-filtered samples (filtering must happen live, per sample, so
 * the ink looks right while it is being drawn).
 */
export function buildStrokePath(points: readonly Point[], epsilon = 0.6): string {
  return strokePathData(simplifyPoints(decimatePoints(points, 0.75), epsilon));
}
