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
 * Deliberate phase-6 decision, revised after desktop UAT — residue IS dropped
 * here, but only by WIDTH, never by contrast or size alone. The phase-5 rounds
 * proved raster-level discriminators kill fading ink; the vector level has the
 * one signal the raster never had: the measured ink width in units of the
 * page's own pen width. A marker leaves nib-width marks — an i-dot, a comma, a
 * fading tail are all at least half a nib wide OR long. Residue (eraser dust,
 * edge wisps) is under half a nib wide AND short. Only that conjunction is
 * dropped; thin-but-long ink (a fading hairline stroke) always survives.
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
/** Ink narrower than this fraction of the pen width is residue-thin. */
const RESIDUE_WIDTH_FACTOR = 0.5;
/** Residue-thin ink shorter than this many pen widths is dropped; longer
 *  thin ink is a genuine fading stroke and stays. */
const RESIDUE_LENGTH_FACTOR = 3;

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
  /** Per-path median width — the constant width each emitted stroke renders.
   *  Per PATH, not per component: one component can hold a marker-fat line
   *  and its hairline continuation, and averaging them lies about both. */
  readonly pathWidths: readonly number[];
  /** Overall median sampled width across the component's kept paths. */
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
    const components = suppressCoveredResidue(bridgeNicks(traced, w), w);
    final = { components, strokeWidth: w, width, height };
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
        const result = traceComponent(component, extraction.labels, distance, width, w);
        if (result !== null) {
          traced.push(result);
        }
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

/** Null when the whole component is residue — the vector-level despeckle. */
function traceComponent(
  c: InkComponent,
  labels: Int32Array,
  distance: Float32Array,
  imageWidth: number,
  w: number,
): TracedComponent | null {
  const window = componentWindow(c, labels, imageWidth);
  const residueWidth = RESIDUE_WIDTH_FACTOR * w;
  const residueLength = RESIDUE_LENGTH_FACTOR * w;

  /** Full width (2·EDT) at a window-local point, from the full-image EDT. */
  const widthAt = (p: Point): number => {
    const x = Math.min(Math.max(Math.round(p.x - 0.5) + window.offsetX, 0), imageWidth - 1);
    const y = Math.round(p.y - 0.5) + window.offsetY;
    return Math.max(1, 2 * (distance[y * imageWidth + x] ?? 0.5));
  };

  // A nib-sized dab — an i-dot, a bullet point, a period — IS a dot; neither
  // a centerline nor a contour would say anything its centre and width don't.
  if (c.maxX - c.minX + 1 <= 1.5 * w && c.maxY - c.minY + 1 <= 1.5 * w) {
    const dotWidth = Math.max(1.5, 2 * c.dtMax);
    if (dotWidth < residueWidth) {
      return null; // a dab far thinner than the nib is a speck, not an i-dot
    }
    const centre = { x: (c.minX + c.maxX) / 2 + 0.5, y: (c.minY + c.maxY) / 2 + 0.5 };
    return {
      kind: 'stroke',
      label: c.label,
      paths: [[centre]],
      widths: [[dotWidth]],
      pathWidths: [dotWidth],
      strokeWidth: dotWidth,
    };
  }

  // Obviously stroke-shaped components skip the ambiguity test entirely.
  let strokeLike = c.thinness >= STROKE_THINNESS;

  // Thin a copy — the blob test needs the skeleton either way.
  const skeleton = window.mask.slice();
  thinInPlace(skeleton, window.width, window.height);
  const paths = traceSkeletonPaths(skeleton, window.width, window.height, SPUR_FACTOR * w, {
    widthAt,
    residueWidth,
    residueLength,
  });

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
  const candidatePaths: Point[][] =
    paths.length > 0
      ? paths.map((path) => path.map((p) => ({ x: p.x + window.offsetX, y: p.y + window.offsetY })))
      : [[{ x: (c.minX + c.maxX) / 2 + 0.5, y: (c.minY + c.maxY) / 2 + 0.5 }]];

  // The despeckle: residue-thin AND short (a dot counts as short) is dropped.
  const offsetPaths: Point[][] = [];
  const widths: number[][] = [];
  const pathWidths: number[] = [];
  const allWidths: number[] = [];
  for (const path of candidatePaths) {
    const perVertex = path.map((p) =>
      widthAt({ x: p.x - window.offsetX, y: p.y - window.offsetY }),
    );
    const pathWidth = Math.max(1, median([...perVertex]));
    if (pathWidth < residueWidth) {
      let length = 0;
      for (let i = 1; i < path.length; i++) {
        length += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
      }
      if (length < residueLength) {
        continue;
      }
    }
    // The WIDTH FLOOR, the despeckle's complement: ink thinner than half the
    // nib that survives (because it is long) is a faint stroke drawn with the
    // same marker — the sub-nib measurement is binarization catching only its
    // core, and rendering it verbatim makes it near-invisible. Floor at the
    // residue threshold so the two rules compose: below it and short → gone,
    // below it and long → drawn at exactly the floor.
    const floored = perVertex.map((v) => Math.max(v, residueWidth));
    offsetPaths.push(path);
    widths.push(floored);
    pathWidths.push(Math.max(pathWidth, residueWidth));
    allWidths.push(...floored);
  }
  if (offsetPaths.length === 0) {
    return null;
  }
  const strokeWidth = Math.max(1, median([...allWidths]));
  return { kind: 'stroke', label: c.label, paths: offsetPaths, widths, pathWidths, strokeWidth };
}

/* ------------------------------ nick bridging ------------------------------ */

/** Endpoint pairs at most this far apart (in units of `w`) may be one
 *  stroke. The pixel-scale nick itself is under half a nib, but THINNING
 *  retreats each skeleton endpoint by about half a nib too, so the measured
 *  end-to-end distance across a nick is roughly `nick + w`, with another
 *  half-nib of slack for where the retreat lands. Letter spacing at this
 *  distance is possible — the ALIGNMENT gate below is what rules it out. */
const NICK_GAP_FACTOR = 2;
/** Both end tangents must continue across the gap within this angle —
 *  a nick interrupts one pen movement, so the two sides are collinear;
 *  neighbouring letters at this distance almost never are. */
const NICK_ALIGN_LIMIT = (50 * Math.PI) / 180;

interface BridgeItem {
  label: number;
  points: Point[];
  widths: number[];
}
interface BridgeEnd {
  item: number;
  /** true = the path's first point sits at this end. */
  atStart: boolean;
}

/**
 * Join stroke paths whose ENDPOINTS sit within half a nib of each other — the
 * pixel-scale nicks where binarization briefly lost a faint stroke, which
 * split a drawn circle into arcs (and its components apart, so the skeleton
 * graph never saw the connection). Half a nib is deliberately tiny: gaps
 * between letters are several nib widths, so handwriting is never ligatured;
 * only breaks that were almost certainly one pen movement are healed. A
 * path's two ends can even pair with each other's partner chain ends —
 * a circle drawn in one movement with one nick closes back into a loop.
 */
function bridgeNicks(components: readonly TracedComponent[], w: number): TracedComponent[] {
  const gapLimit = Math.max(2, NICK_GAP_FACTOR * w);
  const out: TracedComponent[] = [];
  const items: BridgeItem[] = [];
  for (const c of components) {
    if (c.kind === 'fill') {
      out.push(c);
      continue;
    }
    const passthroughIdx: number[] = [];
    c.paths.forEach((path, pi) => {
      if (path.length < 2) {
        passthroughIdx.push(pi); // dots take no part in bridging
      } else {
        items.push({ label: c.label, points: [...path], widths: [...c.widths[pi]!] });
      }
    });
    if (passthroughIdx.length > 0) {
      out.push({
        kind: 'stroke',
        label: c.label,
        paths: passthroughIdx.map((pi) => c.paths[pi]!),
        widths: passthroughIdx.map((pi) => c.widths[pi]!),
        pathWidths: passthroughIdx.map((pi) => c.pathWidths[pi]!),
        strokeWidth: c.strokeWidth,
      });
    }
  }

  const endPoint = (end: BridgeEnd): Point => {
    const points = items[end.item]!.points;
    return end.atStart ? points[0]! : points[points.length - 1]!;
  };

  /** Unit OUTWARD tangent at a path end (the direction a nick would continue). */
  const endTangent = (end: BridgeEnd): Point => {
    const points = items[end.item]!.points;
    const tip = endPoint(end);
    const back = Math.min(4, points.length - 1);
    const inner = end.atStart ? points[back]! : points[points.length - 1 - back]!;
    const length = Math.hypot(tip.x - inner.x, tip.y - inner.y) || 1;
    return { x: (tip.x - inner.x) / length, y: (tip.y - inner.y) / length };
  };

  // All endpoint pairs within the gap, nearest first; each end pairs once.
  const ends: BridgeEnd[] = items.flatMap((_, i) => [
    { item: i, atStart: true },
    { item: i, atStart: false },
  ]);
  const candidates: { a: number; b: number; distance: number }[] = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      // Only across COMPONENTS: a nick by definition split the ink into two
      // components. Paths within one component share junctions at distance
      // zero — the box corners and T-joints the 75° continuation rule
      // deliberately refused to fuse; bridging must not overrule it.
      if (items[ends[i]!.item]!.label === items[ends[j]!.item]!.label) {
        continue;
      }
      const p = endPoint(ends[i]!);
      const q = endPoint(ends[j]!);
      const distance = Math.hypot(q.x - p.x, q.y - p.y);
      if (distance > gapLimit || distance === 0) {
        continue;
      }
      const gap = { x: (q.x - p.x) / distance, y: (q.y - p.y) / distance };
      const ti = endTangent(ends[i]!);
      const tj = endTangent(ends[j]!);
      const outI = Math.acos(Math.max(-1, Math.min(1, ti.x * gap.x + ti.y * gap.y)));
      const outJ = Math.acos(Math.max(-1, Math.min(1, -(tj.x * gap.x + tj.y * gap.y))));
      if (outI <= NICK_ALIGN_LIMIT && outJ <= NICK_ALIGN_LIMIT) {
        candidates.push({ a: i, b: j, distance });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  /** partner[item] = the paired end at each side, or null. */
  const partners: { atStart: BridgeEnd | null; atEnd: BridgeEnd | null }[] = items.map(() => ({
    atStart: null,
    atEnd: null,
  }));
  const partnerOf = (end: BridgeEnd): BridgeEnd | null => {
    const p = partners[end.item]!;
    return end.atStart ? p.atStart : p.atEnd;
  };
  const setPartner = (end: BridgeEnd, to: BridgeEnd): void => {
    const p = partners[end.item]!;
    if (end.atStart) {
      p.atStart = to;
    } else {
      p.atEnd = to;
    }
  };
  for (const { a, b } of candidates) {
    if (partnerOf(ends[a]!) === null && partnerOf(ends[b]!) === null) {
      setPartner(ends[a]!, ends[b]!);
      setPartner(ends[b]!, ends[a]!);
    }
  }

  // Assemble chains, exactly like the skeleton graph's continuation walk.
  const consumed = new Uint8Array(items.length);
  const chainFrom = (start: BridgeEnd): { points: Point[]; widths: number[]; label: number } => {
    const points: Point[] = [];
    const widths: number[] = [];
    let longest = 0;
    let label = items[start.item]!.label;
    let end: BridgeEnd | null = start;
    while (end !== null && consumed[end.item] === 0) {
      consumed[end.item] = 1;
      const item = items[end.item]!;
      const p = end.atStart ? item.points : [...item.points].reverse();
      const vw = end.atStart ? item.widths : [...item.widths].reverse();
      for (let i = 0; i < p.length; i++) {
        points.push(p[i]!);
        widths.push(vw[i]!);
      }
      if (item.points.length > longest) {
        longest = item.points.length;
        label = item.label;
      }
      end = partnerOf({ item: end.item, atStart: !end.atStart });
    }
    return { points, widths, label };
  };

  const emit = (chain: { points: Point[]; widths: number[]; label: number }): void => {
    const pathWidth = Math.max(1, median([...chain.widths]));
    out.push({
      kind: 'stroke',
      label: chain.label,
      paths: [chain.points],
      widths: [chain.widths],
      pathWidths: [pathWidth],
      strokeWidth: pathWidth,
    });
  };

  for (let i = 0; i < items.length; i++) {
    if (consumed[i] !== 0) {
      continue;
    }
    const p = partners[i]!;
    if (p.atStart === null) {
      emit(chainFrom({ item: i, atStart: true }));
    } else if (p.atEnd === null) {
      emit(chainFrom({ item: i, atStart: false }));
    }
  }
  for (let i = 0; i < items.length; i++) {
    if (consumed[i] === 0) {
      emit(chainFrom({ item: i, atStart: true })); // a fully-paired ring
    }
  }
  return out;
}

/* --------------------------- covered residue ---------------------------- */

/** Only paths at or below this fraction of `w` can be suppressed. */
const COVER_WIDTH_FACTOR = 0.75;
/** Fraction of sampled vertices that must sit inside a wider stroke's band. */
const COVER_FRACTION = 0.8;
/** At most this many vertices are distance-tested per candidate path. */
const COVER_SAMPLES = 48;

/**
 * Drop thin paths that run INSIDE the painted band of a wider stroke — the
 * parallel edge-doubling tracks binarization leaves along a rough marker
 * line. They carry no visible ink of their own (the wider stroke already
 * paints every pixel they would), but each one is another small element and,
 * width-floored, a visible wart along a clean edge. A thin path in OPEN
 * space (a fading hairline, a faint circle arc) is covered by nothing and
 * always survives — this rule can only remove ink that is already drawn.
 */
export function suppressCoveredResidue(
  components: readonly TracedComponent[],
  w: number,
): TracedComponent[] {
  interface Entry {
    points: readonly Point[];
    width: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  const entries: Entry[] = [];
  const index: { component: number; path: number; entry: number }[] = [];
  components.forEach((c, ci) => {
    if (c.kind !== 'stroke') {
      return;
    }
    c.paths.forEach((path, pi) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of path) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      index.push({ component: ci, path: pi, entry: entries.length });
      entries.push({ points: path, width: c.pathWidths[pi]!, minX, minY, maxX, maxY });
    });
  });

  const segmentDistance = (p: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t =
      lengthSq === 0
        ? 0
        : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };

  const covered = new Set<number>();
  for (let e = 0; e < entries.length; e++) {
    const thin = entries[e]!;
    if (thin.width > COVER_WIDTH_FACTOR * w) {
      continue;
    }
    // Coverers: strictly wider paths whose bbox could reach this one.
    const coverers = entries.filter(
      (other, oi) =>
        oi !== e &&
        !covered.has(oi) &&
        other.points.length >= 2 &&
        other.width >= thin.width + 1 &&
        other.minX - other.width <= thin.maxX &&
        other.maxX + other.width >= thin.minX &&
        other.minY - other.width <= thin.maxY &&
        other.maxY + other.width >= thin.minY,
    );
    if (coverers.length === 0) {
      continue;
    }
    const step = Math.max(1, Math.floor(thin.points.length / COVER_SAMPLES));
    let sampled = 0;
    let inside = 0;
    for (let i = 0; i < thin.points.length; i += step) {
      const p = thin.points[i]!;
      sampled++;
      for (const coverer of coverers) {
        const reach = coverer.width / 2 + thin.width / 2 + 0.5;
        let hit = false;
        for (let s = 1; s < coverer.points.length; s++) {
          if (segmentDistance(p, coverer.points[s - 1]!, coverer.points[s]!) <= reach) {
            hit = true;
            break;
          }
        }
        if (hit) {
          inside++;
          break;
        }
      }
    }
    if (sampled > 0 && inside / sampled >= COVER_FRACTION) {
      covered.add(e);
    }
  }
  if (covered.size === 0) {
    return [...components];
  }

  const dropByComponent = new Map<number, Set<number>>();
  for (const { component, path, entry } of index) {
    if (covered.has(entry)) {
      let set = dropByComponent.get(component);
      if (!set) {
        set = new Set();
        dropByComponent.set(component, set);
      }
      set.add(path);
    }
  }
  const out: TracedComponent[] = [];
  components.forEach((c, ci) => {
    const drop = dropByComponent.get(ci);
    if (c.kind !== 'stroke' || !drop) {
      out.push(c);
      return;
    }
    const keep = c.paths.map((_, pi) => pi).filter((pi) => !drop.has(pi));
    if (keep.length === 0) {
      return;
    }
    out.push({
      kind: 'stroke',
      label: c.label,
      paths: keep.map((pi) => c.paths[pi]!),
      widths: keep.map((pi) => c.widths[pi]!),
      pathWidths: keep.map((pi) => c.pathWidths[pi]!),
      strokeWidth: c.strokeWidth,
    });
  });
  return out;
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
        // The PATH's own median width — a component can hold a marker-fat
        // line and its fading hairline, and one shared width lies about both.
        strokeWidth: Math.max(0.1, Math.round(component.pathWidths[i]! * scale * 100) / 100),
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
