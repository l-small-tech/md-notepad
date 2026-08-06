/**
 * S5 — vectorize: cleaned ink components → the SAME `<path wb:tool="pen">`
 * elements the pen tool draws, via the SAME smoothing pipeline. That identity
 * is the whole point of centerline tracing: a scanned stroke is erasable,
 * selectable, movable and themeable exactly like a drawn one, so any artifact
 * the raster filters tolerated is two taps from gone.
 *
 * Per component, the REPRESENTATION follows the shape:
 * - stroke-like (thin outline, or area ≈ skeleton·width) → thin to a skeleton,
 *   walk it into polylines (spur pruning + junction continuation), sample the
 *   width along the centerline;
 * - blob-like → marching-squares contour, filled with `evenodd`
 *   (`wb:tool="scanfill"`), because a centerline through a solid arrowhead
 *   would be a lie.
 *
 * Like every stage before it this is a resumable job: `createTracer` hands
 * back something the UI pumps between frames, one component batch at a time.
 *
 * Deliberate phase-6 decision — NOTHING is dropped here. The phase-5 rounds
 * proved that every raster-level residue discriminator also kills fading ink,
 * and at the vector level the same trade holds: a residue speck and an i-dot
 * both trace to a dot. So specks become dots in their inherited colour (the
 * phase-5 colour fix is what makes them unobtrusive), and removal stays where
 * it is decidable — the user's eraser, on elements that are now one tap each.
 */

import type { Point } from '../geometry';
import { simplifyIndices, strokePathData } from '../smoothing';
import { num, serializeElement } from '../serialize';
import type { StrokeElement } from '../scene';
import { distanceTransform } from './distance';
import { thinInPlace } from './thin';
import { traceSkeletonPaths } from './skeleton';
import { traceContours } from './contour';
import type { CleanResult, ScanColorMode } from './clean';
import { SCAN_PALETTE, type ColorAssignment, type MarkerColor } from './color';
import type { InkComponent } from './components';

/** Same threshold as the raster filters: P²/A at or above this is a stroke. */
const STROKE_THINNESS = 20;
/** Blob test: area within this factor of skeletonLength·width is a stroke. */
const AREA_RATIO_LIMIT = 2;
/** Spur pruning length, in units of the page stroke width `w`. */
const SPUR_FACTOR = 1.2;
/** RDP ε in units of `w` — scaled to stroke width, NEVER a constant, or small
 *  handwriting is destroyed while big shapes barely notice. */
const EPSILON_FACTOR = 0.35;

/** The size guard (plan risk 3): raise ε and re-fit until under these. */
export const MAX_SCAN_BYTES = 1_500_000;
export const MAX_SCAN_STROKES = 4000;

/** A component traced to its centerline polylines, window offsets applied. */
export interface TracedStroke {
  readonly kind: 'stroke';
  readonly label: number;
  /** One or more centerline polylines, in rectified-image pixels. */
  readonly paths: readonly (readonly Point[])[];
  /** Per-path per-vertex FULL widths (2 × the distance transform), px. */
  readonly widths: readonly (readonly number[])[];
  /** 2 × median sampled half-width — the constant width v1 renders. */
  readonly strokeWidth: number;
}

export interface TracedFill {
  readonly kind: 'fill';
  readonly label: number;
  /** Closed boundary loops (outer + holes), rectified-image pixels. */
  readonly loops: readonly (readonly Point[])[];
}

export type TracedComponent = TracedStroke | TracedFill;

export interface TraceResult {
  readonly components: readonly TracedComponent[];
  /** The page stroke width the ε and spur thresholds are expressed in. */
  readonly strokeWidth: number;
  readonly width: number;
  readonly height: number;
}

export interface TraceJob {
  /** 0–1, monotonic. */
  readonly progress: number;
  readonly done: boolean;
  step(): number;
  result(): TraceResult | null;
}

/** Roughly how many bbox pixels one `step()` chews through before yielding. */
const STEP_PIXEL_BUDGET = 400_000;
/** Progress share of the EDT stage; the rest is per-component work. */
const EDT_SHARE = 0.15;

export function createTracer(clean: CleanResult): TraceJob {
  const { extraction, width, height } = clean;
  const w = extraction.strokeWidth;
  const components = extraction.components;
  let distance: Float32Array | null = null;
  let index = 0;
  let progress = 0;
  const traced: TracedComponent[] = [];
  let final: TraceResult | null = null;

  const finish = (): void => {
    final = { components: traced, strokeWidth: w, width, height };
    progress = 1;
  };

  return {
    get progress() {
      return progress;
    },
    get done() {
      return final !== null;
    },
    step() {
      if (final !== null) {
        return progress;
      }
      if (distance === null) {
        // The kept-mask EDT. `extraction.distance` measured the WEAK mask —
        // rejected neighbours inflate it; widths must come from kept ink only.
        distance = distanceTransform(extraction.mask, width, height);
        progress = EDT_SHARE;
        if (components.length === 0) {
          finish();
        }
        return progress;
      }
      let budget = STEP_PIXEL_BUDGET;
      while (index < components.length && budget > 0) {
        const component = components[index]!;
        budget -= windowArea(component);
        traced.push(traceComponent(component, extraction.labels, distance, width, w));
        index++;
      }
      progress = EDT_SHARE + (1 - EDT_SHARE) * (index / components.length);
      if (index >= components.length) {
        finish();
      }
      return progress;
    },
    result: () => final,
  };
}

function windowArea(c: InkComponent): number {
  return (c.maxX - c.minX + 3) * (c.maxY - c.minY + 3);
}

/** Copy a component (by label) into a padded local window. */
function componentWindow(
  c: InkComponent,
  labels: Int32Array,
  imageWidth: number,
): { mask: Uint8Array; width: number; height: number; offsetX: number; offsetY: number } {
  const offsetX = c.minX - 1;
  const offsetY = c.minY - 1;
  const width = c.maxX - c.minX + 3;
  const height = c.maxY - c.minY + 3;
  const mask = new Uint8Array(width * height);
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * imageWidth + x] === c.label) {
        mask[(y - offsetY) * width + (x - offsetX)] = 1;
      }
    }
  }
  return { mask, width, height, offsetX, offsetY };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)]!;
}

function traceComponent(
  c: InkComponent,
  labels: Int32Array,
  distance: Float32Array,
  imageWidth: number,
  w: number,
): TracedComponent {
  const window = componentWindow(c, labels, imageWidth);

  /** Full width (2·EDT) at a window-local point, from the full-image EDT. */
  const widthAt = (p: Point): number => {
    const x = Math.min(Math.max(Math.round(p.x - 0.5) + window.offsetX, 0), imageWidth - 1);
    const y = Math.round(p.y - 0.5) + window.offsetY;
    return Math.max(1, 2 * (distance[y * imageWidth + x] ?? 0.5));
  };

  // A nib-sized dab — an i-dot, a bullet point, a period — IS a dot; neither
  // a centerline nor a contour would say anything its centre and width don't.
  if (c.maxX - c.minX + 1 <= 1.5 * w && c.maxY - c.minY + 1 <= 1.5 * w) {
    const centre = { x: (c.minX + c.maxX) / 2 + 0.5, y: (c.minY + c.maxY) / 2 + 0.5 };
    const dotWidth = Math.max(1.5, 2 * c.dtMax);
    return {
      kind: 'stroke',
      label: c.label,
      paths: [[centre]],
      widths: [[dotWidth]],
      strokeWidth: dotWidth,
    };
  }

  // Obviously stroke-shaped components skip the ambiguity test entirely.
  let strokeLike = c.thinness >= STROKE_THINNESS;

  // Thin a copy — the blob test needs the skeleton either way.
  const skeleton = window.mask.slice();
  thinInPlace(skeleton, window.width, window.height);
  const paths = traceSkeletonPaths(skeleton, window.width, window.height, SPUR_FACTOR * w);

  if (!strokeLike) {
    // Area ≈ skeletonLength · width within 2× means the ink really is a
    // ribbon around its own centerline; a solid blob has far more area.
    let skeletonLength = 0;
    const sampled: number[] = [];
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) {
        skeletonLength += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
      }
      for (const p of path) {
        sampled.push(widthAt(p));
      }
    }
    const componentWidth = Math.max(1, median(sampled));
    strokeLike = c.area <= AREA_RATIO_LIMIT * Math.max(skeletonLength, 1) * componentWidth;
  }

  if (!strokeLike) {
    const loops = traceContours(window.mask, window.width, window.height).map((loop) =>
      loop.map((p) => ({ x: p.x + window.offsetX, y: p.y + window.offsetY })),
    );
    if (loops.length > 0) {
      return { kind: 'fill', label: c.label, loops };
    }
    // A contour can only be empty for a degenerate sliver — fall through and
    // emit whatever the skeleton found rather than dropping ink.
  }

  // A component whose skeleton vanished entirely (thinning can consume a
  // 2×2 dot) is still ink: a dot at its centre, at its measured width.
  const offsetPaths: Point[][] =
    paths.length > 0
      ? paths.map((path) => path.map((p) => ({ x: p.x + window.offsetX, y: p.y + window.offsetY })))
      : [[{ x: (c.minX + c.maxX) / 2 + 0.5, y: (c.minY + c.maxY) / 2 + 0.5 }]];

  const widths: number[][] = [];
  const allWidths: number[] = [];
  for (const path of offsetPaths) {
    const perVertex = path.map((p) =>
      widthAt({ x: p.x - window.offsetX, y: p.y - window.offsetY }),
    );
    widths.push(perVertex);
    allWidths.push(...perVertex);
  }
  const strokeWidth = Math.max(1, median([...allWidths]));
  return { kind: 'stroke', label: c.label, paths: offsetPaths, widths, strokeWidth };
}

/* ----------------------------- element building ---------------------------- */

export interface ScanTransform {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}

export const IDENTITY_TRANSFORM: ScanTransform = { scale: 1, dx: 0, dy: 0 };

export interface ScanElementOptions {
  /** Themed strokes carry the canonical palette hex (themeable classes for
   *  free); true keeps the measured colour, literal in every scheme. */
  readonly mode: ScanColorMode;
  /** Review-screen colour remap/merge: bucket → replacement bucket. */
  readonly remap?: ReadonlyMap<MarkerColor, MarkerColor>;
  /** Rectified-image pixels → scene coordinates. */
  readonly transform?: ScanTransform;
  /** Multiplies the base ε (0.35·w). The size guard raises this. */
  readonly epsilonFactor?: number;
}

export interface ScanElements {
  readonly elements: readonly StrokeElement[];
  /** Serialized size of the elements, bytes. */
  readonly bytes: number;
  readonly strokes: number;
  readonly epsilonFactor: number;
  /** True when the size guard had to coarsen the fit. */
  readonly reduced: boolean;
}

/** One traced board → scene elements, at a given ε. Geometry only. */
export function buildScanElements(
  trace: TraceResult,
  colors: ColorAssignment,
  options: ScanElementOptions,
): StrokeElement[] {
  const { scale, dx, dy } = options.transform ?? IDENTITY_TRANSFORM;
  const epsilon = EPSILON_FACTOR * trace.strokeWidth * (options.epsilonFactor ?? 1);
  const map = (p: Point): Point => ({ x: p.x * scale + dx, y: p.y * scale + dy });

  const colorFor = (label: number): string => {
    const color = colors.byLabel.get(label);
    if (!color) {
      return SCAN_PALETTE.black;
    }
    const target = options.remap?.get(color.bucket);
    if (target !== undefined && target !== color.bucket) {
      // A remapped colour has no measured value — the canonical hex IS the
      // user's chosen answer, in either mode.
      return SCAN_PALETTE[target];
    }
    return options.mode === 'themed' ? color.snapped : color.measured;
  };

  const elements: StrokeElement[] = [];
  for (const component of trace.components) {
    const stroke = colorFor(component.label);
    if (component.kind === 'fill') {
      const d = component.loops
        .map((loop) => {
          const kept = simplifyIndices(loop, epsilon).map((i) => map(loop[i]!));
          return (
            `M${num(kept[0]!.x)} ${num(kept[0]!.y)}` +
            kept
              .slice(1)
              .map((p) => `L${num(p.x)} ${num(p.y)}`)
              .join('') +
            'Z'
          );
        })
        .join('');
      elements.push({
        kind: 'stroke',
        id: null,
        tool: 'scanfill',
        d,
        stroke,
        strokeWidth: 0,
        opacity: null,
        widths: null,
      });
      continue;
    }
    for (let i = 0; i < component.paths.length; i++) {
      const path = component.paths[i]!;
      const perVertex = component.widths[i]!;
      const kept = simplifyIndices(path, epsilon);
      const points = kept.map((k) => map(path[k]!));
      const widths = kept.map((k) => Math.round(perVertex[k]! * scale * 10) / 10);
      elements.push({
        kind: 'stroke',
        id: null,
        tool: 'pen',
        d: strokePathData(points),
        stroke,
        strokeWidth: Math.max(0.1, Math.round(component.strokeWidth * scale * 100) / 100),
        opacity: null,
        widths: widths.join(' '),
      });
    }
  }
  return elements;
}

/**
 * The SIZE GUARD: build, measure, and if the serialized result exceeds the
 * caps raise ε and re-fit — geometry only, never a re-trace — until it fits
 * or ε has grown 8×. A dense board must not push a multi-MB string through
 * the session flusher. The stroke COUNT cannot be reduced by ε (dropping
 * strokes would drop ink); past `MAX_SCAN_STROKES` the caller warns instead.
 */
export function fitScanElements(
  trace: TraceResult,
  colors: ColorAssignment,
  options: ScanElementOptions,
): ScanElements {
  let factor = options.epsilonFactor ?? 1;
  for (;;) {
    const elements = buildScanElements(trace, colors, { ...options, epsilonFactor: factor });
    let bytes = 0;
    for (const element of elements) {
      bytes += serializeElement(element).length + 1;
    }
    const strokes = elements.length;
    if (bytes <= MAX_SCAN_BYTES || factor >= 8) {
      return {
        elements,
        bytes,
        strokes,
        epsilonFactor: factor,
        reduced: factor > (options.epsilonFactor ?? 1),
      };
    }
    factor *= 1.6;
  }
}
