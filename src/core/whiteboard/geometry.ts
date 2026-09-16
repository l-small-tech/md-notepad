/**
 * Plane geometry for the whiteboard: points, rectangles, path flattening.
 *
 * Everything the tools need to answer "what is under this point" without a DOM.
 * Hit-testing an SVG in the browser would mean `document.elementFromPoint` or
 * `isPointInStroke` — both need a live document and neither can be tested in
 * the node env, so the editor flattens geometry here instead. The scan
 * pipeline (phases 5–6) reuses the same primitives.
 *
 * There are no transforms anywhere in the format (see `scene.ts`), so every
 * coordinate in this file is already scene space. That is the whole reason
 * these functions can stay this simple.
 */

import type { BoxShapeKind, ConnectorPort, ShapeElement, ShapeKind } from './scene';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Shortest distance from `p` to the segment `a`–`b` (0-length segments ok). */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return distance(p, a);
  }
  // Projection parameter, clamped to the segment.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from `p` to an open polyline. `Infinity` when empty. */
export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  if (points.length === 0) {
    return Infinity;
  }
  if (points.length === 1) {
    return distance(p, points[0]!);
  }
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    best = Math.min(best, distanceToSegment(p, points[i - 1]!, points[i]!));
  }
  return best;
}

/* --------------------------------- rects ---------------------------------- */

/** The rect spanned by two opposite corners, however they are ordered. */
export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function padRect(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

export function pointInRect(p: Point, rect: Rect): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

/**
 * Even-odd interior test over a set of closed polygons (subpaths). A ray cast
 * to +x counts crossings across EVERY loop, so holes subtract — matching how
 * `fill-rule="evenodd"` paints a traced blob (`wb:tool="scanfill"`), which is
 * what hit-testing one must match.
 */
export function pointInPolygonsEvenOdd(p: Point, polygons: readonly (readonly Point[])[]): boolean {
  let inside = false;
  for (const polygon of polygons) {
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = polygon[i]!;
      const b = polygon[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Is `inner` entirely within `outer`? The marquee's containment test. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The smallest rect covering both, or the other one when either is null. */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Axis-aligned bounds of a point set, or null when there are none. */
export function boundsOfPoints(points: readonly Point[]): Rect | null {
  if (points.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The four corners of `rect`, closed back to the first — a hit-test polyline. */
export function rectOutline(rect: Rect): Point[] {
  const { x, y, width: w, height: h } = rect;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
}

/** An ellipse sampled into a closed polyline — enough for hit-testing. */
export function ellipseOutline(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  steps = 48,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  return points;
}

/* ------------------------------ box shapes -------------------------------- */

/**
 * How far a parallelogram leans, and how far a hexagon's corners are cut in,
 * as a fraction of the box width. One constant for both because they are the
 * same gesture — shave the corners — and because a diagram reads better when
 * its shapes agree about how slanted "slanted" is.
 */
export const BOX_SLANT = 0.25;

/**
 * The height of a cylinder's elliptical rim. Proportional to the box, capped
 * by its width so a tall narrow cylinder does not get a rim it could roll on.
 */
export function cylinderRimRy(rect: Rect): number {
  return Math.min(rect.height / 6, rect.width / 4);
}

/**
 * The vertices of a polygonal box shape, in draw order and NOT closed — this
 * is exactly what `<polygon points>` wants.
 *
 * Every list touches all four edges of the box by construction, which is the
 * whole reason the format can store these as plain polygons and still recover
 * `x/y/width/height` on parse: the bounding box of the points IS the geometry.
 * `cylinder` has no vertex list (it is an arc path) and returns none.
 */
export function boxShapePoints(shape: BoxShapeKind, rect: Rect): Point[] {
  const { x, y, width: w, height: h } = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const slant = w * BOX_SLANT;
  switch (shape) {
    case 'diamond':
      return [
        { x: cx, y },
        { x: x + w, y: cy },
        { x: cx, y: y + h },
        { x, y: cy },
      ];
    case 'triangle':
      return [
        { x: cx, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    case 'parallelogram':
      return [
        { x: x + slant, y },
        { x: x + w, y },
        { x: x + w - slant, y: y + h },
        { x, y: y + h },
      ];
    case 'hexagon':
      return [
        { x: x + slant, y },
        { x: x + w - slant, y },
        { x: x + w, y: cy },
        { x: x + w - slant, y: y + h },
        { x: x + slant, y: y + h },
        { x, y: cy },
      ];
    case 'cylinder':
      return [];
  }
}

/**
 * A box shape's outline as a CLOSED polyline — what hit-testing follows, so a
 * click lands on the drawn edge rather than on the bounding box a diamond
 * barely touches. The cylinder's arcs are sampled; everything else is exact.
 */
export function boxShapeOutline(shape: BoxShapeKind, rect: Rect, steps = 16): Point[] {
  if (shape !== 'cylinder') {
    const points = boxShapePoints(shape, rect);
    return points.length > 0 ? [...points, points[0]!] : [];
  }
  const { x, y, width: w, height: h } = rect;
  const ry = cylinderRimRy(rect);
  const rx = w / 2;
  const cx = x + w / 2;
  const points: Point[] = [];
  // The top rim's upper half, left to right, then down the right side …
  for (let i = 0; i <= steps; i++) {
    const angle = Math.PI - (i / steps) * Math.PI;
    points.push({ x: cx + rx * Math.cos(angle), y: y + ry - ry * Math.sin(angle) });
  }
  // … the bottom's lower half, right to left, then closed up the left side.
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI;
    points.push({ x: cx + rx * Math.cos(angle), y: y + h - ry + ry * Math.sin(angle) });
  }
  points.push(points[0]!);
  return points;
}

/**
 * The box a shape's geometry spans, whatever keys that shape uses — the one
 * place the geom-key convention is decoded. Unpadded: callers add the stroke
 * width themselves, because "what does it cover" and "what can I click" want
 * different amounts of slop.
 */
export function shapeGeomRect(shape: ShapeKind, geom: Readonly<Record<string, number>>): Rect {
  if (shape === 'ellipse') {
    return {
      x: (geom.cx ?? 0) - (geom.rx ?? 0),
      y: (geom.cy ?? 0) - (geom.ry ?? 0),
      width: (geom.rx ?? 0) * 2,
      height: (geom.ry ?? 0) * 2,
    };
  }
  if (shape === 'line' || shape === 'arrow') {
    const x1 = geom.x1 ?? 0;
    const y1 = geom.y1 ?? 0;
    const x2 = geom.x2 ?? 0;
    const y2 = geom.y2 ?? 0;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }
  return {
    x: geom.x ?? 0,
    y: geom.y ?? 0,
    width: geom.width ?? 0,
    height: geom.height ?? 0,
  };
}

/**
 * A shape's outline as a closed polyline, whatever its kind — the one curve
 * hit-testing, connector endpoints and port placement all follow, so a line
 * that ends "on the box" ends on the drawn edge of an ellipse or a diamond and
 * not on the corner of the rectangle around it. `steps` only matters for the
 * curved shapes; connector endpoints ask for a finer sampling than a click.
 */
export function shapeOutline(
  shape: ShapeKind,
  geom: Readonly<Record<string, number>>,
  steps = 48,
): Point[] {
  const rect = shapeGeomRect(shape, geom);
  if (shape === 'ellipse') {
    return ellipseOutline(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      rect.width / 2,
      rect.height / 2,
      steps,
    );
  }
  if (shape === 'rect' || shape === 'line' || shape === 'arrow') {
    return rectOutline(rect);
  }
  return boxShapeOutline(shape, rect, Math.max(8, Math.round(steps / 3)));
}

/**
 * Where a ray from `origin` along `direction` LEAVES a closed outline: the
 * farthest crossing along the ray, which for the convex outlines this format
 * draws is the only one. Null when the ray never crosses (a degenerate shape,
 * or an origin outside it aimed away).
 */
export function rayOutlineHit(
  origin: Point,
  direction: Point,
  outline: readonly Point[],
): Point | null {
  let best: { t: number; point: Point } | null = null;
  for (let i = 1; i < outline.length; i++) {
    const a = outline[i - 1]!;
    const b = outline[i]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denominator = direction.x * ey - direction.y * ex;
    if (Math.abs(denominator) < 1e-12) {
      continue; // parallel
    }
    const wx = a.x - origin.x;
    const wy = a.y - origin.y;
    const t = (wx * ey - wy * ex) / denominator;
    const u = (wx * direction.y - wy * direction.x) / denominator;
    if (t < 0 || u < -1e-9 || u > 1 + 1e-9) {
      continue;
    }
    if (best === null || t > best.t) {
      best = { t, point: { x: origin.x + direction.x * t, y: origin.y + direction.y * t } };
    }
  }
  return best?.point ?? null;
}

/* ------------------------------- connectors ------------------------------- */

/** The axis a connector travels along as it leaves (or arrives at) an end. */
export type ConnectorAxis = 'h' | 'v';

/** The axis a port's normal lies on; null for `c` (and for a free end). */
export function portAxis(port: ConnectorPort | null | undefined): ConnectorAxis | null {
  switch (port) {
    case 'n':
    case 's':
      return 'v';
    case 'e':
    case 'w':
      return 'h';
    default:
      return null;
  }
}

/** The outward unit normal of an axis port, or null for `c`. */
export function portNormal(port: ConnectorPort): Point | null {
  switch (port) {
    case 'n':
      return { x: 0, y: -1 };
    case 'e':
      return { x: 1, y: 0 };
    case 's':
      return { x: 0, y: 1 };
    case 'w':
      return { x: -1, y: 0 };
    case 'c':
      return null;
  }
}

/**
 * An axis-aligned route from `a` to `b` with one or two bends — the elbow
 * connector's polyline, endpoints included.
 *
 * Deterministic and geometry-only, so the serializer can derive it on every
 * save and never has to store a waypoint: the same ends and the same ports
 * always draw the same path. `axisA`/`axisB` are the axes the line leaves
 * `a` and arrives at `b` along (a port's normal); null means "whichever way
 * the other end mostly is", which is what a free end and a `c` port want.
 *
 * - Both horizontal (or both vertical): two bends, turning at the midpoint
 *   between the ends — the classic `⊐⊏` between two boxes side by side.
 * - One of each: a single bend at the corner.
 * - Ends already collinear on the shared axis: no bend at all.
 *
 * The route does NOT add a stub when the target lies BEHIND a port (an `e`
 * port aimed at something on the left runs back across its own host). That
 * costs two more bends per end and a stub length nobody agrees on; the ports
 * a press picks (`nearestPort`) face the pointer, so it takes deliberately
 * choosing the wrong side to reach it.
 */
export function routeElbow(
  a: Point,
  b: Point,
  axisA: ConnectorAxis | null,
  axisB: ConnectorAxis | null,
): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dominant: ConnectorAxis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  const first = axisA ?? dominant;
  const last = axisB ?? dominant;
  let points: Point[];
  if (first === last) {
    if (first === 'h') {
      const mx = a.x + dx / 2;
      points = [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
    } else {
      const my = a.y + dy / 2;
      points = [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
    }
  } else if (first === 'h') {
    points = [a, { x: b.x, y: a.y }, b];
  } else {
    points = [a, { x: a.x, y: b.y }, b];
  }
  return dedupePoints(points);
}

/**
 * Drop consecutive (near-)duplicate points and any bend that does not bend —
 * a waypoint on the straight line between its neighbours — so a route whose
 * ends are already in line is a plain segment.
 */
function dedupePoints(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.y - p.y) > 1e-6) {
      out.push(p);
    }
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    const sameX = Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6;
    const sameY = Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6;
    if (sameX || sameY) {
      out.splice(i, 1);
    }
  }
  return out;
}

/**
 * The polyline a line/arrow draws: its two endpoints, or the elbow route
 * between them. THE geometry of a connector for everything that is not the
 * serializer's attribute list — hit-testing, bounds, label placement.
 */
export function connectorPoints(shape: ShapeElement): Point[] {
  const g = shape.geom;
  const a = { x: g.x1 ?? 0, y: g.y1 ?? 0 };
  const b = { x: g.x2 ?? 0, y: g.y2 ?? 0 };
  if (shape.route !== 'elbow') {
    return [a, b];
  }
  return routeElbow(a, b, portAxis(shape.from?.port), portAxis(shape.to?.port));
}

/** The point halfway along a polyline BY LENGTH — where a connector's label sits. */
export function polylineMidpoint(points: readonly Point[]): Point | null {
  if (points.length === 0) {
    return null;
  }
  if (points.length === 1) {
    return points[0]!;
  }
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = distance(a, b);
    if (length >= remaining) {
      const t = length === 0 ? 0 : remaining / length;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}

/* ----------------------------- path transforming -------------------------- */

/**
 * Parameter roles per SVG path command, in order. `x`/`y` are coordinates
 * (translated AND scaled when absolute, only scaled when relative), `rx`/`ry`
 * are lengths (scaled, never translated), `n` is a number to leave alone
 * (rotation angle, arc flags). A command's list REPEATS for as long as numbers
 * keep coming, which is exactly what the SVG grammar allows.
 */
const PATH_PARAMS: Record<string, readonly string[]> = {
  M: ['x', 'y'],
  L: ['x', 'y'],
  T: ['x', 'y'],
  H: ['x'],
  V: ['y'],
  C: ['x', 'y', 'x', 'y', 'x', 'y'],
  S: ['x', 'y', 'x', 'y'],
  Q: ['x', 'y', 'x', 'y'],
  A: ['rx', 'ry', 'n', 'n', 'n', 'x', 'y'],
  Z: [],
};

function round2(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Rewrite a `<path d>` under the affine `x' = x·sx + tx`, `y' = y·sy + ty`.
 *
 * Select/move/resize BAKE their transform into the element (there are no
 * stacked transforms anywhere in the format — see `scene.ts`), and a stroke's
 * geometry is its `d` string, so this is where baking a stroke happens.
 *
 * Relative commands take the scale but not the translation, which is what keeps
 * a hand-authored `m…l…` path correct. Elliptical arcs are handled by scaling
 * their radii: exact under a uniform scale, an approximation under a
 * non-uniform one (the arc's own rotation would need recomputing). Our own
 * serializer only ever emits absolute `M`/`C`, so that case can only arise for
 * hand-authored ink sitting inside one of our layers.
 */
export function transformPathData(
  d: string,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) {
    return d;
  }
  const out: string[] = [];
  let command = 'M';
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      out.push(token);
      index++;
      continue;
    }
    const params = PATH_PARAMS[command.toUpperCase()];
    if (!params || params.length === 0) {
      // Unknown command: pass its operands through untouched rather than
      // corrupting them. Better a wrong-looking element than a broken file.
      out.push(token);
      index++;
      continue;
    }
    const relative = command === command.toLowerCase();
    for (const role of params) {
      const raw = tokens[index];
      if (raw === undefined || /[a-zA-Z]/.test(raw)) {
        break;
      }
      index++;
      const value = Number.parseFloat(raw);
      if (!Number.isFinite(value)) {
        out.push(raw);
        continue;
      }
      switch (role) {
        case 'x':
          out.push(round2(relative ? value * sx : value * sx + tx));
          break;
        case 'y':
          out.push(round2(relative ? value * sy : value * sy + ty));
          break;
        case 'rx':
          out.push(round2(value * Math.abs(sx)));
          break;
        case 'ry':
          out.push(round2(value * Math.abs(sy)));
          break;
        default:
          out.push(raw);
      }
    }
  }
  return joinPathTokens(out);
}

/** `M 1 2 C …` with commands glued to their first operand — compact but legible. */
function joinPathTokens(tokens: readonly string[]): string {
  let out = '';
  let previousWasCommand = false;
  for (const token of tokens) {
    const isCommand = /[a-zA-Z]/.test(token);
    if (out === '' || isCommand || previousWasCommand) {
      out += token;
    } else {
      out += ` ${token}`;
    }
    previousWasCommand = isCommand;
  }
  return out;
}

/* ------------------------------ path flattening --------------------------- */

/** Cubic Bézier at `t`, one axis. */
function cubicAt(p0: number, c1: number, c2: number, p1: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1;
}

/**
 * `d` → one polyline per subpath.
 *
 * Handles the command set that can actually appear on a whiteboard stroke: the
 * serializer emits absolute `M`/`C` only, but hand-authored and scanned files
 * bring `L`/`H`/`V`/`Z` and the relative forms along, so all of them are
 * supported. Quadratics, arcs and shorthand curves are approximated by their
 * endpoints rather than ignored — a coarse polyline still hit-tests sanely,
 * where dropping the segment would make part of a shape unclickable.
 */
export function flattenPathData(d: string, samplesPerCurve = 12): Point[][] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) {
    return [];
  }
  const subpaths: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let command = '';
  let index = 0;

  const nextNumber = (): number => {
    const value = Number.parseFloat(tokens[index++] ?? '0');
    return Number.isFinite(value) ? value : 0;
  };
  const isNumber = (token: string | undefined): boolean =>
    token !== undefined && !/[a-zA-Z]/.test(token);
  const push = (p: Point): void => {
    current.push(p);
    cursor = p;
  };
  const endSubpath = (): void => {
    if (current.length > 0) {
      subpaths.push(current);
    }
    current = [];
  };

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/[a-zA-Z]/.test(token)) {
      command = token;
      index++;
      if (command === 'Z' || command === 'z') {
        if (current.length > 0) {
          current.push(start);
        }
        endSubpath();
        cursor = start;
        continue;
      }
    } else if (command === 'M') {
      command = 'L'; // repeated moveto coordinates are implicit linetos
    } else if (command === 'm') {
      command = 'l';
    }
    if (!isNumber(tokens[index])) {
      continue; // a command with no operands (or trailing junk)
    }
    const relative = command === command.toLowerCase();
    const base = relative ? cursor : { x: 0, y: 0 };

    switch (command.toUpperCase()) {
      case 'M': {
        endSubpath();
        const p = { x: base.x + nextNumber(), y: base.y + nextNumber() };
        start = p;
        push(p);
        break;
      }
      case 'L': {
        push({ x: base.x + nextNumber(), y: base.y + nextNumber() });
        break;
      }
      case 'H': {
        push({ x: base.x + nextNumber(), y: cursor.y });
        break;
      }
      case 'V': {
        push({ x: cursor.x, y: base.y + nextNumber() });
        break;
      }
      case 'C': {
        const from = cursor;
        const c1 = { x: base.x + nextNumber(), y: base.y + nextNumber() };
        const c2 = { x: base.x + nextNumber(), y: base.y + nextNumber() };
        const to = { x: base.x + nextNumber(), y: base.y + nextNumber() };
        for (let s = 1; s <= samplesPerCurve; s++) {
          const t = s / samplesPerCurve;
          current.push({
            x: cubicAt(from.x, c1.x, c2.x, to.x, t),
            y: cubicAt(from.y, c1.y, c2.y, to.y, t),
          });
        }
        cursor = to;
        break;
      }
      default: {
        // Q/S/T/A and anything else: consume operands, keep the last pair as a
        // straight-line approximation so the segment still exists.
        const operands: number[] = [];
        while (isNumber(tokens[index])) {
          operands.push(nextNumber());
        }
        if (operands.length >= 2) {
          push({
            x: base.x + operands[operands.length - 2]!,
            y: base.y + operands[operands.length - 1]!,
          });
        }
        break;
      }
    }
  }
  endSubpath();
  return subpaths;
}
