/**
 * Live connectors — a line or arrow whose ends are ATTACHED to other elements
 * and follow them around.
 *
 * The model is two nullable fields on a `line`/`arrow` (`from`, `to`), each
 * naming a host's `wb:id` and a port on it; `reconnect` recomputes the
 * attached endpoints from the hosts' current outlines. That is the whole
 * mechanism, and it is deliberately NOT selection expansion (the phase-B
 * machinery behind groups and labels): an arrow is not part of the box it
 * points at. Selecting a box does not select its arrows, deleting a box does
 * not delete them — it DETACHES them, leaving the line where it was — and
 * moving a box moves only the arrow ends that touch it. What the selection
 * does is move hosts; what `reconnect` does is keep every arrow honest about
 * where those hosts now are. Every path that changes geometry runs it (the
 * adapter's `settle`), and it is a fixed point on a document with nothing to
 * do, so it costs nothing when nothing moved.
 *
 * Endpoints land on the OUTLINE, never the bounding box: the phase-A outlines
 * in `geometry.ts` are what a ray from the host's centre is intersected with,
 * so an arrow into an ellipse or a diamond ends on the drawn edge. Ports
 * `n`/`e`/`s`/`w` are where the axes cross that outline; `c` aims at the
 * centre and slides around the outline to face the other end.
 *
 * The coordinates stay in the file. A connector is still a `<line>` (or an
 * elbow `<path>`) with real numbers in it that any renderer draws; the
 * attachment is a `wb:` note only this editor reads. A host that no longer
 * exists — deleted in Raw mode, or the reference in a hand-authored file —
 * simply leaves the end where the file says it is.
 */

import {
  connectorPoints,
  distance,
  distanceToPolyline,
  pointInPolygonsEvenOdd,
  portNormal,
  rayOutlineHit,
  shapeGeomRect,
  shapeOutline,
  type Point,
  type Rect,
} from './geometry';
import { addElement, isEditable, removeElements, type ElementRef } from './layers';
import { findElementById } from './labels';
import {
  freshElementId,
  isLineShape,
  type ConnectorEnd,
  type ConnectorPort,
  type SceneDoc,
  type SceneElement,
  type ShapeElement,
} from './scene';
import { mapElements, replaceElement, resolveElement } from './select';

export { routeElbow } from './geometry';

/** The four axis ports — what a selected shape shows, and what snapping offers. */
export const AXIS_PORTS: readonly Exclude<ConnectorPort, 'c'>[] = ['n', 'e', 's', 'w'];

/**
 * How far off an axis a press may land and still pick that axis's port, as
 * the angle from the axis in degrees (measured on the host's box normalised to
 * a square, so a wide box's `e` port is not a sliver). Outside every sector
 * the port is `c`.
 */
export const PORT_SECTOR_DEGREES = 30;

/**
 * Elements a connector may attach to: anything with a body — a closed shape
 * or a picture. Not a line (a connector on a connector has no outline to land
 * on), not text (its box is an estimate), never ink.
 */
export function canHostConnector(element: SceneElement): boolean {
  if (element.kind === 'image') {
    return true;
  }
  return element.kind === 'shape' && element.shape !== 'line' && element.shape !== 'arrow';
}

/** True when either end of a line/arrow is attached. */
export function isAttached(shape: ShapeElement): boolean {
  return shape.from !== null || shape.to !== null;
}

/** The host's box, unpadded — the frame ports and the centre are measured on. */
function hostRect(host: SceneElement): Rect | null {
  if (host.kind === 'image') {
    return { x: host.x, y: host.y, width: host.width, height: host.height };
  }
  if (host.kind === 'shape') {
    return shapeGeomRect(host.shape, host.geom);
  }
  return null;
}

/** The point a `c` port aims at, and the origin of every port ray. */
export function hostCentreOf(host: SceneElement): Point | null {
  const rect = hostRect(host);
  return rect === null ? null : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The host's closed outline, sampled finely enough for an endpoint to sit on it. */
export function hostOutline(host: SceneElement): Point[] | null {
  if (host.kind === 'image') {
    const r = hostRect(host)!;
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height },
      { x: r.x, y: r.y + r.height },
      { x: r.x, y: r.y },
    ];
  }
  if (host.kind === 'shape') {
    return shapeOutline(host.shape, host.geom, 96);
  }
  return null;
}

/**
 * Where a connector end attached to `host` at `port` sits: on the outline,
 * where the port's axis (or, for `c`, the direction of `toward`) leaves it.
 * An ellipse is solved exactly rather than sampled — its ports are the one
 * case where a chord's sag would be visible against the curve.
 */
export function endpointOn(host: SceneElement, port: ConnectorPort, toward: Point): Point | null {
  const centre = hostCentreOf(host);
  if (centre === null) {
    return null;
  }
  let direction = portNormal(port);
  if (direction === null) {
    const dx = toward.x - centre.x;
    const dy = toward.y - centre.y;
    direction = Math.hypot(dx, dy) < 1e-9 ? { x: 1, y: 0 } : { x: dx, y: dy };
  }
  if (host.kind === 'shape' && host.shape === 'ellipse') {
    const rx = host.geom.rx ?? 0;
    const ry = host.geom.ry ?? 0;
    if (rx <= 0 || ry <= 0) {
      return centre;
    }
    // Normalise to the unit circle, find the angle, map back.
    const angle = Math.atan2(direction.y / ry, direction.x / rx);
    return { x: centre.x + rx * Math.cos(angle), y: centre.y + ry * Math.sin(angle) };
  }
  const outline = hostOutline(host);
  if (outline === null) {
    return null;
  }
  return rayOutlineHit(centre, direction, outline) ?? centre;
}

/** The four axis ports of a host, or null for an element with no body. */
export function portPoints(host: SceneElement): Record<Exclude<ConnectorPort, 'c'>, Point> | null {
  const centre = hostCentreOf(host);
  if (centre === null || !canHostConnector(host)) {
    return null;
  }
  const at = (port: Exclude<ConnectorPort, 'c'>): Point => endpointOn(host, port, centre) ?? centre;
  return { n: at('n'), e: at('e'), s: at('s'), w: at('w') };
}

/**
 * Which port a press at `point` means. Near one of the host's axes it is that
 * axis's port — the line will leave the box squarely from the middle of that
 * side, which is what a diagram wants; anywhere else it is `c`, and the end
 * slides around the outline to face the other end.
 */
export function nearestPort(host: SceneElement, point: Point): ConnectorPort {
  const rect = hostRect(host);
  if (rect === null || rect.width <= 0 || rect.height <= 0) {
    return 'c';
  }
  const nx = (point.x - (rect.x + rect.width / 2)) / (rect.width / 2);
  const ny = (point.y - (rect.y + rect.height / 2)) / (rect.height / 2);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9) {
    return 'c';
  }
  const degrees = (Math.atan2(Math.abs(ny), Math.abs(nx)) * 180) / Math.PI;
  if (degrees <= PORT_SECTOR_DEGREES) {
    return nx >= 0 ? 'e' : 'w';
  }
  if (degrees >= 90 - PORT_SECTOR_DEGREES) {
    return ny >= 0 ? 's' : 'n';
  }
  return 'c';
}

/** What a connector end is about to attach to, and where it will land. */
export interface ConnectorTarget {
  readonly ref: ElementRef;
  readonly port: ConnectorPort;
  /** The endpoint for this target, aimed at `toward` when the port is `c`. */
  readonly point: Point;
}

/**
 * The host a connector end at `point` should attach to, or null for open
 * board. Two passes, in order of intent:
 *
 * 1. A PORT within `radius` wins, on whichever host — ports are strong
 *    guides, so a line dragged near the middle of a side lands exactly there.
 * 2. Otherwise the topmost host whose BODY is under the point (inside its
 *    outline or on it — an unfilled box counts, because the box is what the
 *    user sees), with the port `nearestPort` picks.
 *
 * `exclude` is the connector itself and anything it must not attach to.
 * `toward` aims a `c` port at the other end so the returned point is the one
 * the preview will draw.
 */
export function connectorTarget(
  doc: SceneDoc,
  point: Point,
  radius: number,
  toward: Point,
  exclude: readonly ElementRef[] = [],
): ConnectorTarget | null {
  const skip = new Set(exclude.map((ref) => `${ref.layerId}:${ref.index}`));
  let best: { ref: ElementRef; port: ConnectorPort; point: Point; d: number } | null = null;
  let body: ConnectorTarget | null = null;
  for (let l = doc.layers.length - 1; l >= 0; l--) {
    const layer = doc.layers[l]!;
    if (!isEditable(layer)) {
      continue;
    }
    for (let i = layer.elements.length - 1; i >= 0; i--) {
      const element = layer.elements[i]!;
      if (!canHostConnector(element) || skip.has(`${layer.id}:${i}`)) {
        continue;
      }
      const ref = { layerId: layer.id, index: i };
      const ports = portPoints(element);
      if (ports) {
        for (const port of AXIS_PORTS) {
          const d = distance(point, ports[port]);
          if (d <= radius && (best === null || d < best.d)) {
            best = { ref, port, point: ports[port], d };
          }
        }
      }
      if (body === null) {
        const outline = hostOutline(element);
        const reach = radius + (element.kind === 'shape' ? element.strokeWidth / 2 : 0);
        if (
          outline &&
          (pointInPolygonsEvenOdd(point, [outline]) || distanceToPolyline(point, outline) <= reach)
        ) {
          const port = nearestPort(element, point);
          body = { ref, port, point: endpointOn(element, port, toward) ?? point };
        }
      }
    }
  }
  if (best !== null) {
    return { ref: best.ref, port: best.port, point: best.point };
  }
  return body;
}

/* ------------------------------- following -------------------------------- */

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Re-aim every attached connector end at its host's current outline. Returns
 * the SAME document when nothing moved — the coordinates are rounded to the
 * two decimals the file keeps, so a parsed document is already at the fixed
 * point and a commit that moved no host costs no new snapshot.
 */
export function reconnect(doc: SceneDoc): SceneDoc {
  const hosts = new Map<string, SceneElement | null>();
  const hostFor = (end: ConnectorEnd | null): SceneElement | null => {
    if (end === null) {
      return null;
    }
    let host = hosts.get(end.id);
    if (host === undefined) {
      const ref = findElementById(doc, end.id);
      const element = ref === null ? null : resolveElement(doc, ref);
      host = element !== null && canHostConnector(element) ? element : null;
      hosts.set(end.id, host);
    }
    return host;
  };
  let changed = false;
  const layers = doc.layers.map((layer) => {
    let touched = false;
    const elements = layer.elements.map((element) => {
      if (!isLineShape(element) || !isAttached(element)) {
        return element;
      }
      const fromHost = hostFor(element.from);
      const toHost = hostFor(element.to);
      if (fromHost === null && toHost === null) {
        return element; // both hosts gone: the line stays where it was
      }
      const g = element.geom;
      const a = { x: g.x1 ?? 0, y: g.y1 ?? 0 };
      const b = { x: g.x2 ?? 0, y: g.y2 ?? 0 };
      // A `c` port aims at the other end — its host's centre when it has one,
      // else the free endpoint itself.
      const aimA = (fromHost && hostCentreOf(fromHost)) ?? a;
      const aimB = (toHost && hostCentreOf(toHost)) ?? b;
      const nextA = fromHost ? (endpointOn(fromHost, element.from!.port, aimB) ?? a) : a;
      const nextB = toHost ? (endpointOn(toHost, element.to!.port, aimA) ?? b) : b;
      const geom = {
        x1: round2(nextA.x),
        y1: round2(nextA.y),
        x2: round2(nextB.x),
        y2: round2(nextB.y),
      };
      if (geom.x1 === a.x && geom.y1 === a.y && geom.x2 === b.x && geom.y2 === b.y) {
        return element;
      }
      touched = true;
      return { ...element, geom };
    });
    if (!touched) {
      return layer;
    }
    changed = true;
    return { ...layer, elements };
  });
  return changed ? { ...doc, layers } : doc;
}

/* -------------------------------- detaching ------------------------------- */

/**
 * Cut every connector end that points at one of `hostIds`. The line keeps
 * its coordinates — the last place its host was — which is what deleting a
 * box should do to the arrows into it: leave them, not take them.
 */
export function detachFrom(doc: SceneDoc, hostIds: ReadonlySet<string>): SceneDoc {
  if (hostIds.size === 0) {
    return doc;
  }
  let changed = false;
  const layers = doc.layers.map((layer) => {
    let touched = false;
    const elements = layer.elements.map((element) => {
      if (!isLineShape(element)) {
        return element;
      }
      const from = element.from !== null && hostIds.has(element.from.id) ? null : element.from;
      const to = element.to !== null && hostIds.has(element.to.id) ? null : element.to;
      if (from === element.from && to === element.to) {
        return element;
      }
      touched = true;
      return { ...element, from, to };
    });
    if (!touched) {
      return layer;
    }
    changed = true;
    return { ...layer, elements };
  });
  return changed ? { ...doc, layers } : doc;
}

/**
 * Delete `refs`, detaching every connector that pointed at one of them first.
 * The detach replaces elements in place, so the refs are still good when the
 * removal runs — one document, one undo step.
 */
export function removeAndDetach(doc: SceneDoc, refs: readonly ElementRef[]): SceneDoc {
  const ids = new Set<string>();
  for (const ref of refs) {
    const element = resolveElement(doc, ref);
    if (element && element.kind !== 'raw' && element.id !== null) {
      ids.add(element.id);
    }
  }
  return removeElements(detachFrom(doc, ids), refs);
}

/** Whether "Detach" makes sense: the selection holds an attached connector. */
export function canDetach(doc: SceneDoc, refs: readonly ElementRef[]): boolean {
  return refs.some((ref) => {
    const element = resolveElement(doc, ref);
    return element !== null && isLineShape(element) && isAttached(element);
  });
}

/** Cut both ends of every connector in `refs`; the lines stay put. */
export function detachElements(doc: SceneDoc, refs: readonly ElementRef[]): SceneDoc {
  if (!canDetach(doc, refs)) {
    return doc;
  }
  return mapElements(doc, refs, (element) =>
    isLineShape(element) && isAttached(element) ? { ...element, from: null, to: null } : element,
  );
}

/* -------------------------------- attaching ------------------------------- */

/** Give the host at `ref` a `wb:id` if it has none. Null when it cannot host. */
function ensureHostId(
  doc: SceneDoc,
  ref: ElementRef,
  random?: () => number,
): { doc: SceneDoc; id: string } | null {
  const host = resolveElement(doc, ref);
  if (!host || host.kind === 'raw' || !canHostConnector(host)) {
    return null;
  }
  if (host.id !== null) {
    return { doc, id: host.id };
  }
  const id = freshElementId(doc, random);
  return {
    doc: mapElements(doc, [ref], (e) => (e.kind === 'raw' ? e : { ...e, id })),
    id,
  };
}

/**
 * Add a freshly drawn line/arrow to `layerId`, attached at whichever ends
 * landed on a host. Hosts gain a `wb:id` when they need one (the same
 * `freshElementId` labels use); the endpoints are then re-aimed by
 * `reconnect`, so what lands is exactly what the preview showed.
 */
export function attachConnector(
  doc: SceneDoc,
  layerId: string,
  element: ShapeElement,
  from: ConnectorTarget | null,
  to: ConnectorTarget | null,
  random?: () => number,
): SceneDoc {
  let next = doc;
  const ends: (ConnectorEnd | null)[] = [];
  for (const target of [from, to]) {
    if (target === null) {
      ends.push(null);
      continue;
    }
    const host = ensureHostId(next, target.ref, random);
    if (host === null) {
      ends.push(null);
      continue;
    }
    next = host.doc;
    ends.push({ id: host.id, port: target.port });
  }
  const placed = addElement(next, layerId, { ...element, from: ends[0]!, to: ends[1]! });
  return reconnect(placed);
}

/**
 * Move one end of the connector at `ref`: onto a host (attached, the host
 * gaining an id if it needs one, the endpoint re-aimed) or to a bare point
 * (detached, the coordinate taken verbatim). What the endpoint-handle drag
 * runs every frame and commits once.
 */
export function setConnectorEnd(
  doc: SceneDoc,
  ref: ElementRef,
  end: 'from' | 'to',
  target: ConnectorTarget | Point,
  random?: () => number,
): SceneDoc {
  const element = resolveElement(doc, ref);
  if (!element || !isLineShape(element)) {
    return doc;
  }
  const keys = end === 'from' ? (['x1', 'y1'] as const) : (['x2', 'y2'] as const);
  if (!('ref' in target)) {
    const geom = { ...element.geom, [keys[0]]: target.x, [keys[1]]: target.y };
    // Reconnect even so: a `c` port on the OTHER end aims at this one.
    return reconnect(replaceElement(doc, ref, { ...element, geom, [end]: null }));
  }
  const host = ensureHostId(doc, target.ref, random);
  if (host === null) {
    return setConnectorEnd(doc, ref, end, target.point);
  }
  const attached: ShapeElement = { ...element, [end]: { id: host.id, port: target.port } };
  return reconnect(replaceElement(host.doc, ref, attached));
}

/** The polyline a connector draws — re-exported so the adapter has one import. */
export { connectorPoints };
