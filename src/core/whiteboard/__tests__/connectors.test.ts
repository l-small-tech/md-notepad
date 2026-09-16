/**
 * Live connectors: ends that land on the OUTLINE of their host and follow it.
 *
 * The properties that matter: an endpoint sits on the drawn edge (not the
 * bounding box) of every shape; the elbow router is deterministic; `reconnect`
 * is a fixed point when nothing moved and re-aims when something did; deleting
 * a host detaches rather than deletes; a paste keeps a pair attached only when
 * both travelled together.
 */

import { describe, expect, it } from 'vitest';
import {
  attachConnector,
  canDetach,
  canHostConnector,
  connectorTarget,
  detachElements,
  detachFrom,
  endpointOn,
  nearestPort,
  portPoints,
  reconnect,
  removeAndDetach,
  routeElbow,
  setConnectorEnd,
} from '../connectors';
import { connectorPoints } from '../geometry';
import { pasteElements, copyElements } from '../clipboard';
import { alignElements } from '../arrange';
import { translateElements, scaleElements, resolveElement } from '../select';
import {
  createLayer,
  createScene,
  remapIds,
  usedIds,
  type SceneDoc,
  type SceneElement,
  type ShapeElement,
} from '../scene';
import { makeShape } from '../tools';

const INK = '#1a1a1a';
const P = (x: number, y: number) => ({ x, y });
const REF = (index: number, layerId = 'a1B2') => ({ layerId, index });

function board(...elements: SceneElement[]): SceneDoc {
  return createScene({ layers: [createLayer({ id: 'a1B2', elements })] });
}

function shape(kind: ShapeElement['shape'], x: number, y: number, w: number, h: number) {
  return {
    ...makeShape(kind === 'ellipse' ? 'ellipse' : kind, P(x, y), P(x + w, y + h), {
      color: INK,
      width: 2,
    })!,
  };
}

const box = (id: string, x: number, y: number, w = 100, h = 60): ShapeElement => ({
  ...shape('rect', x, y, w, h),
  id,
});

function line(from: string | null, to: string | null, a = P(0, 0), b = P(10, 10)): ShapeElement {
  return {
    ...makeShape('arrow', a, b, { color: INK, width: 2 })!,
    from: from === null ? null : { id: from, port: 'c' },
    to: to === null ? null : { id: to, port: 'c' },
  };
}

const el = (doc: SceneDoc, index: number): ShapeElement =>
  resolveElement(doc, REF(index)) as ShapeElement;

/** A sequence of "random" numbers, so fresh ids are reproducible. */
const fixed = (): (() => number) => {
  let n = 0;
  return () => (n += 0.137) % 1;
};

describe('endpointOn', () => {
  it('puts the axis ports of a rect on the midpoints of its sides', () => {
    const host = box('b', 100, 100, 200, 100);
    expect(endpointOn(host, 'n', P(0, 0))).toEqual(P(200, 100));
    expect(endpointOn(host, 'e', P(0, 0))).toEqual(P(300, 150));
    expect(endpointOn(host, 's', P(0, 0))).toEqual(P(200, 200));
    expect(endpointOn(host, 'w', P(0, 0))).toEqual(P(100, 150));
  });

  it('lands a `c` port on an ELLIPSE’s edge, not its bounding box', () => {
    const host = shape('ellipse', 0, 0, 200, 100); // centre (100,50), rx 100, ry 50
    const at = endpointOn(host, 'c', P(300, 250))!;
    // On the ellipse: ((x-100)/100)² + ((y-50)/50)² = 1.
    const k = ((at.x - 100) / 100) ** 2 + ((at.y - 50) / 50) ** 2;
    expect(k).toBeCloseTo(1, 6);
    // And well inside the box's corner, which is empty space.
    expect(at.x).toBeLessThan(200);
    expect(at.y).toBeLessThan(100);
    // Aimed the right way.
    expect(at.x).toBeGreaterThan(100);
    expect(at.y).toBeGreaterThan(50);
  });

  it('lands a `c` port on a DIAMOND’s slanted edge', () => {
    const host = shape('diamond', 0, 0, 200, 100); // vertices (100,0) (200,50) (100,100) (0,50)
    const at = endpointOn(host, 'c', P(200, 100))!;
    // The lower-right edge runs from (200,50) to (100,100): x/200 + y/100 = 1.5 … i.e. y = 150 - x/2.
    expect(at.y).toBeCloseTo(150 - at.x / 2, 6);
    expect(at.x).toBeGreaterThan(100);
    expect(at.x).toBeLessThan(200);
  });

  it('puts a diamond’s and a triangle’s axis ports on their vertices', () => {
    expect(endpointOn(shape('diamond', 0, 0, 200, 100), 'n', P(0, 0))).toEqual(P(100, 0));
    expect(endpointOn(shape('diamond', 0, 0, 200, 100), 'e', P(0, 0))).toEqual(P(200, 50));
    expect(endpointOn(shape('triangle', 0, 0, 200, 100), 'n', P(0, 0))).toEqual(P(100, 0));
    // A triangle's `e` port is on the sloped right edge, level with the centre.
    const e = endpointOn(shape('triangle', 0, 0, 200, 100), 'e', P(0, 0))!;
    expect(e.y).toBeCloseTo(50);
    expect(e.x).toBeCloseTo(150);
  });

  it('aims a `c` port at the centre when the target IS the centre', () => {
    const host = box('b', 0, 0, 100, 60);
    expect(endpointOn(host, 'c', P(50, 30))).toEqual(P(100, 30));
  });

  it('works on an image, and refuses text', () => {
    const image: SceneElement = {
      kind: 'image',
      id: 'im',
      group: null,
      x: 10,
      y: 10,
      width: 80,
      height: 40,
      href: 'data:,',
      opacity: null,
    };
    expect(endpointOn(image, 's', P(0, 0))).toEqual(P(50, 50));
    expect(canHostConnector(image)).toBe(true);
    expect(canHostConnector(line(null, null))).toBe(false);
  });
});

describe('portPoints and nearestPort', () => {
  const host = box('b', 100, 100, 200, 100);

  it('lists the four axis ports', () => {
    expect(portPoints(host)).toEqual({
      n: P(200, 100),
      e: P(300, 150),
      s: P(200, 200),
      w: P(100, 150),
    });
    expect(portPoints(line(null, null))).toBeNull();
  });

  it('picks the side a press is near, on the box normalised to a square', () => {
    expect(nearestPort(host, P(300, 150))).toBe('e');
    expect(nearestPort(host, P(300, 165))).toBe('e'); // 15 of a 50 half-height: within 30°
    expect(nearestPort(host, P(200, 100))).toBe('n');
    expect(nearestPort(host, P(100, 145))).toBe('w');
    expect(nearestPort(host, P(210, 200))).toBe('s');
  });

  it('is `c` toward a corner', () => {
    expect(nearestPort(host, P(300, 200))).toBe('c');
    expect(nearestPort(host, P(100, 100))).toBe('c');
  });
});

describe('routeElbow', () => {
  it('bends once when the ends leave on different axes', () => {
    expect(routeElbow(P(0, 0), P(100, 50), 'h', 'v')).toEqual([P(0, 0), P(100, 0), P(100, 50)]);
    expect(routeElbow(P(0, 0), P(100, 50), 'v', 'h')).toEqual([P(0, 0), P(0, 50), P(100, 50)]);
  });

  it('bends twice at the midpoint when both ends share an axis', () => {
    expect(routeElbow(P(0, 0), P(100, 50), 'h', 'h')).toEqual([
      P(0, 0),
      P(50, 0),
      P(50, 50),
      P(100, 50),
    ]);
    expect(routeElbow(P(0, 0), P(100, 50), 'v', 'v')).toEqual([
      P(0, 0),
      P(0, 25),
      P(100, 25),
      P(100, 50),
    ]);
  });

  it('is a plain segment when the ends are already in line', () => {
    expect(routeElbow(P(0, 10), P(100, 10), 'h', 'h')).toEqual([P(0, 10), P(100, 10)]);
    expect(routeElbow(P(5, 0), P(5, 80), null, null)).toEqual([P(5, 0), P(5, 80)]);
  });

  it('takes the dominant direction for a free end, and is deterministic', () => {
    // Mostly horizontal → leaves horizontally.
    const a = routeElbow(P(0, 0), P(100, 20), null, null);
    expect(a).toEqual([P(0, 0), P(50, 0), P(50, 20), P(100, 20)]);
    expect(routeElbow(P(0, 0), P(100, 20), null, null)).toEqual(a);
    // Mostly vertical → leaves vertically.
    expect(routeElbow(P(0, 0), P(20, 100), null, null)).toEqual([
      P(0, 0),
      P(0, 50),
      P(20, 50),
      P(20, 100),
    ]);
  });

  it('routes a connector by its ports through connectorPoints', () => {
    const elbow: ShapeElement = {
      ...line('a', 'b', P(100, 50), P(300, 150)),
      route: 'elbow',
      from: { id: 'a', port: 'e' },
      to: { id: 'b', port: 'w' },
    };
    expect(connectorPoints(elbow)).toEqual([P(100, 50), P(200, 50), P(200, 150), P(300, 150)]);
    expect(connectorPoints({ ...elbow, route: 'straight' })).toEqual([P(100, 50), P(300, 150)]);
  });
});

describe('reconnect', () => {
  const a = box('a', 0, 0, 100, 60); // centre (50,30)
  const b = box('b', 300, 0, 100, 60); // centre (350,30)

  it('aims both ends at the hosts’ outlines, then is a fixed point', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    expect(el(doc, 2).geom).toEqual({ x1: 100, y1: 30, x2: 300, y2: 30 });
    expect(reconnect(doc)).toBe(doc);
  });

  it('is the SAME document when nothing is attached', () => {
    const doc = board(a, b, line(null, null));
    expect(reconnect(doc)).toBe(doc);
  });

  it('follows a moved host, and an aligned one', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    const movedDoc = reconnect(translateElements(doc, [REF(1)], 0, 200));
    // b is now at y 200–260 (centre 350,230); the `c` ends aim at each other's
    // centres: a's end leaves through its bottom edge, b's through its top.
    expect(el(movedDoc, 2).geom).toEqual({ x1: 95, y1: 60, x2: 305, y2: 200 });
    // Align the two boxes back onto one row and the line is horizontal again.
    const aligned = reconnect(alignElements(movedDoc, [REF(0), REF(1)], 'top'));
    expect(el(aligned, 2).geom).toEqual({ x1: 100, y1: 30, x2: 300, y2: 30 });
  });

  it('follows a resized host onto its new edge', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    const from = { x: 0, y: 0, width: 100, height: 60 };
    const grown = reconnect(scaleElements(doc, [REF(0)], from, { ...from, width: 150 }));
    expect(el(grown, 2).geom).toEqual({ x1: 150, y1: 30, x2: 300, y2: 30 });
  });

  it('honours axis ports: an `s` port leaves the bottom, whatever the other end does', () => {
    const doc = reconnect(
      board(a, b, { ...line('a', 'b'), from: { id: 'a', port: 's' }, to: { id: 'b', port: 'n' } }),
    );
    expect(el(doc, 2).geom).toEqual({ x1: 50, y1: 60, x2: 350, y2: 0 });
  });

  it('leaves an end whose host is gone exactly where it was', () => {
    const doc = board(a, { ...line('a', 'zzz', P(0, 0), P(500, 500)) });
    const out = reconnect(doc);
    // The `a` end moved onto a's outline aimed at (500,500); the other stayed.
    expect(el(out, 1).geom.x2).toBe(500);
    expect(el(out, 1).geom.y2).toBe(500);
    expect(el(out, 1).from).toEqual({ id: 'a', port: 'c' });
    expect(el(out, 1).to).toEqual({ id: 'zzz', port: 'c' });
  });

  it('rounds to the two decimals the file keeps, so a parsed document is already settled', () => {
    const tilted = reconnect(board(shape('ellipse', 0, 0, 100, 60), { ...line(null, null) }));
    expect(reconnect(tilted)).toBe(tilted);
    const hosted = reconnect(
      board({ ...shape('ellipse', 0, 0, 100, 60), id: 'e' }, line('e', null, P(0, 0), P(333, 217))),
    );
    for (const value of Object.values(el(hosted, 1).geom)) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
    expect(reconnect(hosted)).toBe(hosted);
  });
});

describe('detaching', () => {
  const a = box('a', 0, 0);
  const b = box('b', 300, 0);

  it('detachFrom cuts only the ends that point at the named hosts', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    const out = detachFrom(doc, new Set(['a']));
    expect(el(out, 2)).toMatchObject({ from: null, to: { id: 'b', port: 'c' } });
    expect(el(out, 2).geom).toEqual(el(doc, 2).geom); // coordinates kept
    expect(detachFrom(doc, new Set(['nobody']))).toBe(doc);
  });

  it('removeAndDetach deletes the host and leaves its arrows, detached, in place', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    const out = removeAndDetach(doc, [REF(0)]);
    expect(out.layers[0]!.elements).toHaveLength(2);
    const arrow = el(out, 1);
    expect(arrow.from).toBeNull();
    expect(arrow.to).toEqual({ id: 'b', port: 'c' });
    expect(arrow.geom).toEqual({ x1: 100, y1: 30, x2: 300, y2: 30 });
    // And nothing later hands out the freed id while a stale reference could exist.
    expect(usedIds(reconnect(board(a, line('gone', null))))).toContain('gone');
  });

  it('detachElements cuts a selected connector loose at both ends', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    expect(canDetach(doc, [REF(2)])).toBe(true);
    expect(canDetach(doc, [REF(0)])).toBe(false);
    const out = detachElements(doc, [REF(2)]);
    expect(el(out, 2)).toMatchObject({ from: null, to: null });
    expect(detachElements(out, [REF(2)])).toBe(out);
  });
});

describe('connectorTarget', () => {
  const a = box('a', 100, 100, 200, 100);
  const doc = board(a, line(null, null, P(500, 500), P(600, 600)));

  it('takes a port within reach over the body under the pointer', () => {
    const hit = connectorTarget(doc, P(304, 152), 10, P(0, 0));
    expect(hit).toEqual({ ref: REF(0), port: 'e', point: P(300, 150) });
  });

  it('attaches to the body of an UNFILLED box, with the nearest port', () => {
    const inside = connectorTarget(doc, P(120, 150), 4, P(0, 0));
    expect(inside).toMatchObject({ ref: REF(0), port: 'w' });
    const corner = connectorTarget(doc, P(290, 190), 4, P(400, 300));
    expect(corner).toMatchObject({ ref: REF(0), port: 'c' });
    // A `c` target's point is on the outline, aimed at `toward` — here the
    // bottom edge, on the way from the centre (200,150) to (400,300).
    expect(corner!.point.y).toBe(200);
    expect(corner!.point.x).toBeCloseTo(266.67, 1);
  });

  it('is null over open board, over a line, and over the excluded element', () => {
    expect(connectorTarget(doc, P(50, 50), 4, P(0, 0))).toBeNull();
    expect(connectorTarget(doc, P(550, 550), 4, P(0, 0))).toBeNull();
    expect(connectorTarget(doc, P(150, 150), 4, P(0, 0), [REF(0)])).toBeNull();
  });
});

describe('attaching', () => {
  it('attachConnector gives hosts ids, links the ends and aims them', () => {
    const a = shape('rect', 0, 0, 100, 60);
    const b = shape('rect', 300, 0, 100, 60);
    const doc = board(a, b);
    const drawn = makeShape('arrow', P(90, 30), P(310, 30), { color: INK, width: 2 })!;
    const out = attachConnector(
      doc,
      'a1B2',
      drawn,
      { ref: REF(0), port: 'e', point: P(100, 30) },
      { ref: REF(1), port: 'c', point: P(300, 30) },
      fixed(),
    );
    const [hostA, hostB, arrow] = out.layers[0]!.elements as ShapeElement[];
    expect(hostA!.id).not.toBeNull();
    expect(hostB!.id).not.toBeNull();
    expect(hostA!.id).not.toBe(hostB!.id);
    expect(arrow!.from).toEqual({ id: hostA!.id, port: 'e' });
    expect(arrow!.to).toEqual({ id: hostB!.id, port: 'c' });
    expect(arrow!.geom).toEqual({ x1: 100, y1: 30, x2: 300, y2: 30 });
  });

  it('setConnectorEnd re-attaches one end and detaches it again', () => {
    const a = box('a', 0, 0);
    const b = shape('rect', 300, 0, 100, 60);
    const doc = reconnect(board(a, b, line('a', null, P(0, 0), P(200, 200))));
    const attached = setConnectorEnd(
      doc,
      REF(2),
      'to',
      { ref: REF(1), port: 'w', point: P(300, 30) },
      fixed(),
    );
    const hostB = el(attached, 1);
    expect(hostB.id).not.toBeNull();
    expect(el(attached, 2).to).toEqual({ id: hostB.id, port: 'w' });
    expect(el(attached, 2).geom).toMatchObject({ x2: 300, y2: 30 });
    // The `c` end on `a` re-aimed at b's centre: a horizontal line again.
    expect(el(attached, 2).geom).toMatchObject({ x1: 100, y1: 30 });

    const freed = setConnectorEnd(attached, REF(2), 'to', P(500, 30));
    expect(el(freed, 2).to).toBeNull();
    expect(el(freed, 2).geom).toMatchObject({ x2: 500, y2: 30 });
  });
});

describe('copy and paste', () => {
  const a = box('a', 0, 0);
  const b = box('b', 300, 0);

  it('keeps a pair attached when host and arrow travel together, with fresh ids', () => {
    const doc = reconnect(board(a, b, line('a', 'b')));
    const pasted = pasteElements(doc, copyElements(doc, [REF(0), REF(2)]), 'a1B2', 16, fixed());
    const [hostCopy, arrowCopy] = pasted.refs.map((ref) => resolveElement(pasted.doc, ref)) as [
      ShapeElement,
      ShapeElement,
    ];
    expect(hostCopy.id).not.toBe('a');
    expect(arrowCopy.from).toEqual({ id: hostCopy.id, port: 'c' });
    // The `b` end did not come along: cut, not left pointing at the original.
    expect(arrowCopy.to).toBeNull();
  });

  it('remapIds drops a reference the mapping does not name and keeps the coordinates', () => {
    const [out] = remapIds([line('a', 'b', P(1, 2), P(3, 4))], new Map([['a', 'x']])) as [
      ShapeElement,
    ];
    expect(out.from).toEqual({ id: 'x', port: 'c' });
    expect(out.to).toBeNull();
    expect(out.geom).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 });
  });
});
