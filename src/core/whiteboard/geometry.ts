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
