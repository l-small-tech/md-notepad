/**
 * Snapping: the grid, and the smart guides that beat it.
 *
 * Everything here is one axis at a time. A snap on x knows nothing about a
 * snap on y — which is why a box can land on a neighbour's left edge while its
 * top stays wherever the hand put it, and why the whole module is a few dozen
 * lines instead of a solver.
 *
 * The model, in order of precedence per axis:
 *
 * 1. **A smart guide within the threshold wins.** Candidates are the left /
 *    centre / right and top / middle / bottom of every other visible element.
 *    Aligning to a thing you can see beats aligning to an abstraction, always
 *    — that is the whole reason guides exist in editors that already have a
 *    grid.
 * 2. **Otherwise the grid**, when the document asks for one.
 * 3. **Otherwise nothing**, and the geometry passes through untouched.
 *
 * The threshold arrives in SCENE units (the adapter divides {@link
 * SNAP_THRESHOLD} screen pixels by the zoom), so the pull feels identical at
 * every magnification while the grid, which is a property of the drawing,
 * scales with it.
 *
 * Two deliberate exclusions, both about what a guide is FOR. Freehand ink is
 * never a candidate: a scribble's bounding box is not an alignment anyone
 * meant, and flattening every path on the board per gesture would cost more
 * than the feature is worth. Locked, hidden and foreign layers are out too —
 * you cannot move them, so offering to line up with them is a promise about
 * content the editor does not own.
 */

import { distance, type Point, type Rect } from './geometry';
import { elementBounds } from './hit-test';
import { isEditable, type ElementRef } from './layers';
import { DEFAULT_GRID, gridSnaps, snapToGrid, type GridSettings } from './grid';
import type { SceneDoc } from './scene';
import { AXIS_PORTS, portPoints } from './connectors';

export { SNAP_THRESHOLD } from './tool-settings';

/** Which way a guide line runs: `'x'` is vertical (a constant x). */
export type GuideAxis = 'x' | 'y';

/**
 * A matched alignment, ready to draw. `from`/`to` span the moving geometry AND
 * the element it matched, so the line drawn between them shows WHY it
 * appeared rather than stretching across the whole board.
 */
export interface GuideLine {
  readonly axis: GuideAxis;
  /** The coordinate the line sits at (an x for `'x'`, a y for `'y'`). */
  readonly at: number;
  /** Extent along the OTHER axis. */
  readonly from: number;
  readonly to: number;
}

/** Everything a snap needs to know that isn't the geometry being snapped. */
export interface SnapContext {
  readonly grid: GridSettings;
  /** Candidate rectangles — see {@link guideRects}. */
  readonly guides: readonly Rect[];
  /**
   * Candidate PORTS (`guidePorts`): the four axis points of every host. A
   * point within the threshold of one lands exactly on it, both axes at once
   * — a port is a target, not a coincidence, so it beats the edge guides.
   */
  readonly ports: readonly Point[];
  /** Match distance in SCENE units (screen pixels ÷ zoom). */
  readonly threshold: number;
  /** False turns the whole thing off — Alt held, or a pen stroke. */
  readonly enabled: boolean;
}

export interface SnapPointResult {
  readonly point: Point;
  readonly guides: readonly GuideLine[];
  /** The port the point landed on, when one won — the adapter highlights it. */
  readonly port: Point | null;
}

export interface SnapRectResult {
  readonly rect: Rect;
  /** How far the rect was moved to get there — the adjusted drag delta. */
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly GuideLine[];
}

/** A context that never snaps — the pen's, and what Alt produces. */
export const NO_SNAP: SnapContext = {
  grid: DEFAULT_GRID,
  guides: [],
  ports: [],
  threshold: 0,
  enabled: false,
};

/**
 * The ports a gesture may land on: the four axis points of every element
 * that can host a connector, on editable layers, minus `exclude` (expanded,
 * like {@link guideRects}). Computed once per gesture for the same reason.
 */
export function guidePorts(doc: SceneDoc, exclude: readonly ElementRef[] = []): Point[] {
  const skip = new Set(exclude.map((ref) => `${ref.layerId}:${ref.index}`));
  const points: Point[] = [];
  for (const layer of doc.layers) {
    if (!isEditable(layer)) {
      continue;
    }
    layer.elements.forEach((element, index) => {
      if (skip.has(`${layer.id}:${index}`)) {
        return;
      }
      const ports = portPoints(element);
      if (ports !== null) {
        for (const port of AXIS_PORTS) {
          points.push(ports[port]);
        }
      }
    });
  }
  return points;
}

/**
 * The rectangles a gesture may align to: every shape, text and image on an
 * editable layer, minus `exclude` (which the caller passes ALREADY EXPANDED —
 * a group being dragged must not offer its own members as guides). Computed
 * once per gesture by the adapter, not per frame: it depends only on the
 * drag's base document.
 */
export function guideRects(doc: SceneDoc, exclude: readonly ElementRef[] = []): Rect[] {
  const skip = new Set(exclude.map((ref) => `${ref.layerId}:${ref.index}`));
  const rects: Rect[] = [];
  for (const layer of doc.layers) {
    if (!isEditable(layer)) {
      continue;
    }
    layer.elements.forEach((element, index) => {
      // Ink is not an alignment. See the header.
      if (element.kind === 'raw' || element.kind === 'stroke') {
        return;
      }
      if (skip.has(`${layer.id}:${index}`)) {
        return;
      }
      const bounds = elementBounds(element);
      if (bounds !== null) {
        rects.push(bounds);
      }
    });
  }
  return rects;
}

/**
 * Snap one point — a shape drag's corner, a resize handle, where text will
 * land. Each axis takes the nearest guide within the threshold, else the grid,
 * else itself.
 */
export function snapPoint(point: Point, context: SnapContext): SnapPointResult {
  if (!context.enabled) {
    return { point, guides: [], port: null };
  }
  // A port within reach takes the point whole. Nearest wins; strictly nearer
  // so two coincident ports cannot flicker.
  let port: Point | null = null;
  let best = context.threshold;
  for (const candidate of context.ports) {
    const d = distance(point, candidate);
    if (d <= best && (port === null || d < best)) {
      port = candidate;
      best = d;
    }
  }
  if (port !== null) {
    return { point: port, guides: [], port };
  }
  const x = snapAxis('x', [point.x], point.y, point.y, context);
  const y = snapAxis('y', [point.y], point.x, point.x, context);
  return {
    point: { x: point.x + x.delta, y: point.y + y.delta },
    guides: [...x.guides, ...y.guides],
    port: null,
  };
}

/**
 * Snap a whole rectangle by TRANSLATING it — the move drag, and the box a
 * shape is being drawn into once both corners are known. All six of its
 * interesting coordinates (three per axis) compete for the nearest guide, and
 * the winner moves the entire rect; the grid, when it is what's left, snaps
 * the top-left corner so a box drawn on the grid stays on it.
 */
export function snapRect(rect: Rect, context: SnapContext): SnapRectResult {
  if (!context.enabled) {
    return { rect, dx: 0, dy: 0, guides: [] };
  }
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const x = snapAxis('x', [left, (left + right) / 2, right], top, bottom, context);
  const y = snapAxis('y', [top, (top + bottom) / 2, bottom], left, right, context);
  return {
    rect: { ...rect, x: rect.x + x.delta, y: rect.y + y.delta },
    dx: x.delta,
    dy: y.delta,
    guides: [...x.guides, ...y.guides],
  };
}

/* -------------------------------------------------------------------------- */

interface AxisSnap {
  readonly delta: number;
  readonly guides: readonly GuideLine[];
}

const NOTHING: AxisSnap = { delta: 0, guides: [] };

/**
 * One axis: the best (guide value, moving value) pair within the threshold
 * wins; failing that the grid moves the FIRST moving value (the rect's edge,
 * or the point itself). `spanFrom`/`spanTo` are the moving geometry's extent
 * along the other axis, so a matched guide can be drawn as a line that
 * actually reaches both things.
 */
function snapAxis(
  axis: GuideAxis,
  values: readonly number[],
  spanFrom: number,
  spanTo: number,
  context: SnapContext,
): AxisSnap {
  let best: { delta: number; at: number; from: number; to: number } | null = null;
  for (const rect of context.guides) {
    const [low, high, otherLow, otherHigh] =
      axis === 'x'
        ? [rect.x, rect.x + rect.width, rect.y, rect.y + rect.height]
        : [rect.y, rect.y + rect.height, rect.x, rect.x + rect.width];
    for (const candidate of [low, (low + high) / 2, high]) {
      for (const value of values) {
        const delta = candidate - value;
        if (Math.abs(delta) > context.threshold) {
          continue;
        }
        // Strictly nearer, so the FIRST candidate at a given distance wins and
        // the result cannot flicker between two coincident elements.
        if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, at: candidate, from: otherLow, to: otherHigh };
        }
      }
    }
  }
  if (best !== null) {
    return {
      delta: best.delta,
      guides: [
        {
          axis,
          at: best.at,
          from: Math.min(best.from, spanFrom),
          to: Math.max(best.to, spanTo),
        },
      ],
    };
  }
  if (!gridSnaps(context.grid)) {
    return NOTHING;
  }
  const first = values[0];
  if (first === undefined) {
    return NOTHING;
  }
  return { delta: snapToGrid(first, context.grid.size) - first, guides: [] };
}
