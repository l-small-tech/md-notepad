import { describe, expect, test } from 'vitest';
import { DEFAULT_GRID, type GridSettings } from '../grid';
import { guideRects, NO_SNAP, snapPoint, snapRect, type SnapContext } from '../snap';
import { createLayer, createScene, type SceneElement } from '../scene';
import { makeShape, makeStroke, makeText } from '../tools';

const GRID_ON: GridSettings = { show: true, size: 20, snap: true };

function context(over: Partial<SnapContext> = {}): SnapContext {
  return { grid: DEFAULT_GRID, guides: [], threshold: 6, enabled: true, ...over };
}

const box = (x: number, y: number, w = 40, h = 40) => ({ x, y, width: w, height: h });

describe('snapPoint', () => {
  test('a disabled context passes everything through — this is what Alt does', () => {
    const at = { x: 23, y: 31 };
    const result = snapPoint(at, { ...context({ grid: GRID_ON }), enabled: false });
    expect(result.point).toEqual(at);
    expect(result.guides).toEqual([]);
    expect(snapPoint(at, NO_SNAP).point).toEqual(at);
  });

  test('without a grid and without guides nothing moves', () => {
    expect(snapPoint({ x: 23, y: 31 }, context()).point).toEqual({ x: 23, y: 31 });
  });

  test('the grid rounds each axis independently', () => {
    expect(snapPoint({ x: 23, y: 31 }, context({ grid: GRID_ON })).point).toEqual({
      x: 20,
      y: 40,
    });
  });

  test('a hidden grid does not snap, however the snap flag is set', () => {
    const grid: GridSettings = { show: false, size: 20, snap: true };
    expect(snapPoint({ x: 23, y: 31 }, context({ grid })).point).toEqual({ x: 23, y: 31 });
  });

  test('a guide edge within the threshold wins over the grid', () => {
    const result = snapPoint(
      { x: 103, y: 31 },
      context({ grid: GRID_ON, guides: [box(100, 200)] }),
    );
    // x took the guide's left edge (100), not the grid's 100 — same number, so
    // check the guide itself; y had no guide and fell back to the grid.
    expect(result.point).toEqual({ x: 100, y: 40 });
    expect(result.guides).toEqual([{ axis: 'x', at: 100, from: 31, to: 240 }]);
  });

  test('a guide outside the threshold is ignored', () => {
    const result = snapPoint({ x: 110, y: 999 }, context({ guides: [box(100, 0)] }));
    expect(result.point.x).toBe(110);
    expect(result.guides).toEqual([]);
  });

  test('centres are candidates, not just edges', () => {
    const result = snapPoint({ x: 118, y: 999 }, context({ guides: [box(100, 0)] }));
    expect(result.point.x).toBe(120); // the box's centre
    expect(result.guides[0]?.at).toBe(120);
  });

  test('the nearest candidate wins when several are in reach', () => {
    const result = snapPoint({ x: 101, y: 999 }, context({ guides: [box(100, 0), box(104, 0)] }));
    expect(result.point.x).toBe(100);
  });
});

describe('snapRect', () => {
  test('all three coordinates of an axis compete, and the whole rect moves', () => {
    // The rect's RIGHT edge (140) is 2 from the guide's left edge (142).
    const result = snapRect(box(100, 300), context({ guides: [box(142, 900)] }));
    expect(result.dx).toBe(2);
    expect(result.dy).toBe(0);
    expect(result.rect.x).toBe(102);
    expect(result.rect.width).toBe(40);
    expect(result.guides).toEqual([{ axis: 'x', at: 142, from: 300, to: 940 }]);
  });

  test('a guide on one axis and the grid on the other', () => {
    const result = snapRect(box(103, 7), context({ grid: GRID_ON, guides: [box(100, 900)] }));
    expect(result.rect.x).toBe(100);
    expect(result.rect.y).toBe(0); // grid: the TOP edge lands on a line
    expect(result.guides.map((g) => g.axis)).toEqual(['x']);
  });

  test('the drawn guide spans both the match and the moving geometry', () => {
    const result = snapRect(box(100, 0, 40, 40), context({ guides: [box(100, 500, 40, 40)] }));
    const guide = result.guides[0]!;
    expect(guide.axis).toBe('x');
    expect(guide.from).toBe(0);
    expect(guide.to).toBe(540);
  });

  test('a disabled context reports a zero delta', () => {
    const result = snapRect(box(103, 7), { ...context({ grid: GRID_ON }), enabled: false });
    expect([result.dx, result.dy]).toEqual([0, 0]);
  });

  test('the threshold is in the caller’s units — a wide one reaches further', () => {
    // Nothing is within 6. At 40 three pairings reach the guide's left edge
    // (130): left +30, centre +10, right −10. The centre and the right edge
    // tie at 10, and a tie keeps the FIRST — the result must not flicker.
    expect(snapRect(box(100, 0), context({ guides: [box(130, 500)] })).dx).toBe(0);
    expect(snapRect(box(100, 0), context({ guides: [box(130, 500)], threshold: 40 })).dx).toBe(10);
  });
});

describe('guideRects', () => {
  const shape = (x: number): SceneElement =>
    makeShape('rect', { x, y: 0 }, { x: x + 40, y: 40 }, { color: '#000', width: 2 })!;

  test('shapes, text and images are candidates; ink and raw content are not', () => {
    const doc = createScene({
      layers: [
        createLayer({
          id: 'a',
          elements: [
            shape(0),
            makeText({ x: 5, y: 5 }, 'hi', '#000', 24)!,
            makeStroke(
              'pen',
              [
                { x: 0, y: 0 },
                { x: 9, y: 9 },
              ],
              '#000',
              2,
            )!,
            { kind: 'raw', xml: '<circle r="1"/>' },
          ],
        }),
      ],
    });
    expect(guideRects(doc)).toHaveLength(2);
  });

  test('hidden, locked and foreign layers offer nothing', () => {
    const doc = createScene({
      layers: [
        createLayer({ id: 'a', elements: [shape(0)], visible: false }),
        createLayer({ id: 'b', elements: [shape(100)], locked: true }),
        createLayer({ id: 'c', elements: [shape(200)], kind: 'foreign' }),
        createLayer({ id: 'd', elements: [shape(300)] }),
      ],
    });
    expect(guideRects(doc)).toHaveLength(1);
  });

  test('the excluded refs (the selection) are left out', () => {
    const doc = createScene({
      layers: [createLayer({ id: 'a', elements: [shape(0), shape(100)] })],
    });
    expect(guideRects(doc)).toHaveLength(2);
    expect(guideRects(doc, [{ layerId: 'a', index: 0 }])).toHaveLength(1);
  });

  test('a bounds includes the stroke width, so edges match what you SEE', () => {
    const doc = createScene({ layers: [createLayer({ id: 'a', elements: [shape(100)] })] });
    expect(guideRects(doc)[0]!.x).toBe(99); // 100 minus half of a 2-unit nib
  });
});
