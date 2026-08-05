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
