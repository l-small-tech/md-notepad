/**
 * Geometry primitives, and in particular the path flattener — which is the one
 * piece here with real parsing in it, and the thing the eraser's correctness
 * rests on.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsOfPoints,
  boxShapeOutline,
  boxShapePoints,
  distanceToPolyline,
  distanceToSegment,
  ellipseOutline,
  flattenPathData,
  padRect,
  pointInRect,
  rectFromCorners,
  rectOutline,
  shapeGeomRect,
} from '../geometry';

describe('distanceToSegment', () => {
  it('measures to the nearest point ON the segment, not the infinite line', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3);
    // Beyond the end: the distance is to the endpoint, not the projection.
    expect(distanceToSegment({ x: 20, y: 0 }, a, b)).toBeCloseTo(10);
    expect(distanceToSegment({ x: -3, y: 4 }, a, b)).toBeCloseTo(5);
  });

  it('handles a zero-length segment (a tap, which is a legal stroke)', () => {
    const a = { x: 2, y: 2 };
    expect(distanceToSegment({ x: 5, y: 6 }, a, a)).toBeCloseTo(5);
  });
});

describe('distanceToPolyline', () => {
  it('takes the minimum over every segment', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distanceToPolyline({ x: 11, y: 5 }, line)).toBeCloseTo(1);
    expect(distanceToPolyline({ x: 5, y: -2 }, line)).toBeCloseTo(2);
  });

  it('is Infinity for an empty polyline', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity);
  });
});

describe('rects', () => {
  it('builds from corners in any order', () => {
    expect(rectFromCorners({ x: 10, y: 20 }, { x: 4, y: 5 })).toEqual({
      x: 4,
      y: 5,
      width: 6,
      height: 15,
    });
  });

  it('pads on all four sides', () => {
    expect(padRect({ x: 10, y: 10, width: 4, height: 4 }, 2)).toEqual({
      x: 8,
      y: 8,
      width: 8,
      height: 8,
    });
  });

  it('tests containment inclusively on the edge', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(pointInRect({ x: 0, y: 10 }, rect)).toBe(true);
    expect(pointInRect({ x: 10.1, y: 5 }, rect)).toBe(false);
  });

  it('outlines close back to the first corner', () => {
    const outline = rectOutline({ x: 0, y: 0, width: 2, height: 2 });
    expect(outline).toHaveLength(5);
    expect(outline[4]).toEqual(outline[0]);
  });

  it('bounds a point set', () => {
    expect(
      boundsOfPoints([
        { x: 3, y: -1 },
        { x: -2, y: 8 },
        { x: 0, y: 0 },
      ]),
    ).toEqual({ x: -2, y: -1, width: 5, height: 9 });
    expect(boundsOfPoints([])).toBeNull();
  });
});

describe('ellipseOutline', () => {
  it('samples a closed ring on the ellipse', () => {
    const points = ellipseOutline(10, 20, 5, 3, 8);
    expect(points).toHaveLength(9);
    expect(points[0]).toEqual({ x: 15, y: 20 });
    for (const p of points) {
      const nx = (p.x - 10) / 5;
      const ny = (p.y - 20) / 3;
      expect(nx * nx + ny * ny).toBeCloseTo(1);
    }
  });
});

describe('flattenPathData', () => {
  it('reads the absolute M/L form the serializer emits', () => {
    expect(flattenPathData('M10 10L20 30')).toEqual([
      [
        { x: 10, y: 10 },
        { x: 20, y: 30 },
      ],
    ]);
  });

  it('accepts comma separators and repeated implicit linetos', () => {
    const [sub] = flattenPathData('M0,0 L1,1 2,2');
    expect(sub).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it('samples cubics along the curve, ending exactly on the endpoint', () => {
    const [sub] = flattenPathData('M0 0C0 10 10 10 10 0', 4);
    expect(sub).toHaveLength(5); // the start plus four samples
    expect(sub![0]).toEqual({ x: 0, y: 0 });
    expect(sub![4]!.x).toBeCloseTo(10);
    expect(sub![4]!.y).toBeCloseTo(0);
    // The curve bulges downward between the endpoints — not a straight line.
    expect(sub![2]!.y).toBeGreaterThan(1);
  });

  it('handles relative commands, H/V, and closes on Z', () => {
    const [sub] = flattenPathData('M10 10 h10 v10 z');
    expect(sub).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 10 },
    ]);
  });

  it('splits subpaths at each moveto', () => {
    const subs = flattenPathData('M0 0L1 0 M5 5L6 5');
    expect(subs).toHaveLength(2);
    expect(subs[1]![0]).toEqual({ x: 5, y: 5 });
  });

  it('approximates unsupported commands by their endpoint rather than dropping them', () => {
    // A quadratic: the segment must still exist, or part of a foreign shape
    // would silently become unclickable.
    const [sub] = flattenPathData('M0 0Q5 10 10 0');
    expect(sub![sub!.length - 1]).toEqual({ x: 10, y: 0 });
  });

  it('returns nothing for junk', () => {
    expect(flattenPathData('')).toEqual([]);
    expect(flattenPathData('nonsense')).toEqual([]);
  });
});

describe('box shapes', () => {
  const BOX = { x: 10, y: 20, width: 100, height: 60 };

  it('puts every polygon vertex ON the box, which is how parse recovers it', () => {
    for (const shape of ['diamond', 'triangle', 'parallelogram', 'hexagon'] as const) {
      const points = boxShapePoints(shape, BOX);
      expect(points.length).toBeGreaterThanOrEqual(3);
      expect(boundsOfPoints(points)).toEqual(BOX);
    }
  });

  it('samples the cylinder into a closed outline that fills its box', () => {
    const outline = boxShapeOutline('cylinder', BOX);
    expect(outline[0]).toEqual(outline[outline.length - 1]);
    const bounds = boundsOfPoints(outline)!;
    expect(bounds.x).toBeCloseTo(BOX.x);
    expect(bounds.width).toBeCloseTo(BOX.width);
    expect(bounds.y).toBeCloseTo(BOX.y);
    expect(bounds.height).toBeCloseTo(BOX.height);
  });

  it('closes a polygon outline back to its first vertex', () => {
    const outline = boxShapeOutline('diamond', BOX);
    expect(outline).toHaveLength(5);
    expect(outline[4]).toEqual(outline[0]);
  });

  it('decodes every shape family’s geom keys to the same kind of box', () => {
    expect(shapeGeomRect('rect', BOX)).toEqual(BOX);
    expect(shapeGeomRect('hexagon', BOX)).toEqual(BOX);
    expect(shapeGeomRect('ellipse', { cx: 60, cy: 50, rx: 50, ry: 30 })).toEqual(BOX);
    expect(shapeGeomRect('line', { x1: 110, y1: 80, x2: 10, y2: 20 })).toEqual(BOX);
  });
});
