/**
 * Selection, and the thing that makes it safe: transforms are BAKED into the
 * elements. The invariants worth guarding are that a moved element is still the
 * same KIND of element (a stroke stays a stroke with the same command
 * structure), that the format round-trips it, and that a resize cannot flip a
 * selection inside-out.
 */

import { describe, expect, it } from 'vitest';
import {
  allSelectable,
  elementsInRect,
  handleAt,
  handlePoint,
  marqueeRect,
  rectTransform,
  replaceElement,
  resizeRect,
  scaleElements,
  selectionBounds,
  toggleRef,
  transformElement,
  translateElements,
  validRefs,
} from '../select';
import { createLayer, createScene, type SceneDoc, type SceneElement } from '../scene';
import { makeShape, makeStroke, makeText } from '../tools';
import { parseWhiteboard } from '../parse';
import { serializeWhiteboard } from '../serialize';
import { transformPathData } from '../geometry';

const P = (x: number, y: number) => ({ x, y });
const REF = (index: number, layerId = 'a1B2') => ({ layerId, index });

function board(elements: readonly SceneElement[], over: Partial<SceneDoc> = {}): SceneDoc {
  return createScene({
    layers: [createLayer({ id: 'a1B2', elements: [...elements] })],
    ...over,
  });
}

const rect = makeShape('rect', P(10, 10), P(50, 30), '#1a1a1a', 2)!;
const stroke = makeStroke('pen', [P(100, 100), P(140, 120), P(180, 100)], '#1a1a1a', 4)!;

/* ------------------------------- the set ---------------------------------- */

describe('the selected set', () => {
  it('toggles a ref in and out', () => {
    expect(toggleRef([], REF(0))).toEqual([REF(0)]);
    expect(toggleRef([REF(0), REF(1)], REF(0))).toEqual([REF(1)]);
  });

  it('drops refs that no longer point at a selectable element', () => {
    const doc = board([rect]);
    expect(validRefs(doc, [REF(0), REF(1), REF(0, 'gone')])).toEqual([REF(0)]);
  });

  it('never selects raw content or content on a locked layer', () => {
    const doc = createScene({
      layers: [
        createLayer({ id: 'a1B2', elements: [rect, { kind: 'raw', xml: '<circle r="1"/>' }] }),
        createLayer({ id: 'c3D4', locked: true, elements: [stroke] }),
        createLayer({ id: 'e5F6', kind: 'foreign', elements: [stroke] }),
      ],
    });
    expect(allSelectable(doc)).toEqual([REF(0)]);
  });
});

describe('marquee', () => {
  const doc = board([rect, stroke]);

  it('takes what it fully contains and leaves what it grazes', () => {
    expect(elementsInRect(doc, { x: 0, y: 0, width: 60, height: 60 })).toEqual([REF(0)]);
    // Clips the stroke's right end — containment means it is NOT taken.
    expect(elementsInRect(doc, { x: 90, y: 90, width: 60, height: 60 })).toEqual([]);
    expect(elementsInRect(doc, { x: 0, y: 0, width: 400, height: 400 })).toEqual([REF(0), REF(1)]);
  });

  it('normalizes a box dragged up-and-left', () => {
    expect(marqueeRect(P(100, 80), P(40, 20))).toEqual({ x: 40, y: 20, width: 60, height: 60 });
  });
});

describe('selectionBounds', () => {
  it('unions the members and ignores refs that resolve to nothing', () => {
    const doc = board([rect, stroke]);
    const box = selectionBounds(doc, [REF(0), REF(1), REF(9)])!;
    expect(box.x).toBeCloseTo(9, 5); // 10 minus half the 2px stroke
    expect(box.x + box.width).toBeCloseTo(182, 5);
  });

  it('is null for an empty selection', () => {
    expect(selectionBounds(board([rect]), [])).toBeNull();
  });
});

/* ------------------------------- handles ---------------------------------- */

describe('resize handles', () => {
  const box = { x: 0, y: 0, width: 100, height: 40 };

  it('places all eight around the box', () => {
    expect(handlePoint(box, 'nw')).toEqual(P(0, 0));
    expect(handlePoint(box, 'se')).toEqual(P(100, 40));
    expect(handlePoint(box, 'n')).toEqual(P(50, 0));
    expect(handlePoint(box, 'w')).toEqual(P(0, 20));
  });

  it('finds the handle under a sloppy touch, and none when there is none', () => {
    expect(handleAt(box, P(3, 3), 10)).toBe('nw');
    expect(handleAt(box, P(50, 20), 10)).toBeNull();
  });

  it('anchors the opposite edge while dragging', () => {
    expect(resizeRect(box, 'se', 20, 10, 4)).toEqual({ x: 0, y: 0, width: 120, height: 50 });
    expect(resizeRect(box, 'nw', 20, 10, 4)).toEqual({ x: 20, y: 10, width: 80, height: 30 });
    // An edge handle moves one axis only.
    expect(resizeRect(box, 'e', 20, 999, 4)).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });

  it('clamps instead of flipping inside-out', () => {
    const squashed = resizeRect(box, 'se', -500, -500, 4);
    expect(squashed.width).toBe(4);
    expect(squashed.height).toBe(4);
    const pulled = resizeRect(box, 'nw', 500, 500, 4);
    expect(pulled.width).toBe(4);
    expect(pulled.x).toBe(96); // still anchored to the east edge
  });

  it('derives the affine that maps one box onto another', () => {
    const t = rectTransform(
      { x: 0, y: 0, width: 100, height: 40 },
      { x: 10, y: 5, width: 200, height: 20 },
    );
    expect(t).toEqual({ sx: 2, sy: 0.5, tx: 10, ty: 5 });
  });
});

/* -------------------------------- baking ---------------------------------- */

describe('transformPathData', () => {
  it('moves absolute coordinates and scales relative ones', () => {
    expect(transformPathData('M10 10L20 30', 1, 1, 5, -5)).toBe('M15 5L25 25');
    expect(transformPathData('m10 10l20 30', 2, 2, 100, 100)).toBe('m20 20l40 60');
  });

  it('scales about the origin with the translation folded in', () => {
    expect(transformPathData('M10 20', 2, 3, 0, 0)).toBe('M20 60');
  });

  it('keeps arc flags and rotation intact while scaling the radii', () => {
    expect(transformPathData('M0 0A10 20 45 1 0 30 40', 2, 2, 0, 0)).toBe(
      'M0 0A20 40 45 1 0 60 80',
    );
  });

  it('handles H and V, which carry only one axis', () => {
    expect(transformPathData('M0 0H50V60', 2, 2, 10, 10)).toBe('M10 10H110V130');
  });

  it('leaves a path it cannot parse alone rather than corrupting it', () => {
    expect(transformPathData('', 2, 2, 1, 1)).toBe('');
  });
});

describe('transformElement', () => {
  it('bakes a translation into a stroke and keeps it a stroke', () => {
    const moved = transformElement(stroke, 1, 1, 10, -10);
    expect(moved.kind).toBe('stroke');
    expect(moved).toMatchObject({ strokeWidth: stroke.strokeWidth });
    expect((moved as typeof stroke).d).toBe(transformPathData(stroke.d, 1, 1, 10, -10));
  });

  it('scales stroke width by the geometric mean of the two axes', () => {
    const scaled = transformElement(stroke, 4, 1, 0, 0);
    expect((scaled as typeof stroke).strokeWidth).toBeCloseTo(8, 5); // 4 × √(4·1)
  });

  it('bakes rect, ellipse and line geometry', () => {
    expect(transformElement(rect, 2, 2, 0, 0)).toMatchObject({
      geom: { x: 20, y: 20, width: 80, height: 40 },
    });
    const ellipse = makeShape('ellipse', P(0, 0), P(100, 50), '#1a1a1a', 2)!;
    expect(transformElement(ellipse, 2, 1, 5, 0)).toMatchObject({
      geom: { cx: 105, cy: 25, rx: 100, ry: 25 },
    });
    const line = makeShape('line', P(0, 0), P(10, 10), '#1a1a1a', 2)!;
    expect(transformElement(line, 1, 1, 3, 4)).toMatchObject({
      geom: { x1: 3, y1: 4, x2: 13, y2: 14 },
    });
  });

  it('moves text by its baseline and scales its type size', () => {
    const text = makeText(P(10, 20), 'hello', '#1a1a1a', 24)!;
    expect(transformElement(text, 2, 2, 0, 0)).toMatchObject({ x: 20, y: 40, fontSize: 48 });
  });

  it("carries a text box's width on the HORIZONTAL scale, not the mean", () => {
    const boxed = makeText(P(0, 0), 'hello', '#1a1a1a', 24, null, 100)!;
    // A width is a width: stretched 3× across and 1× down it is 300, even
    // though the type size follows the geometric mean of the two.
    expect(transformElement(boxed, 3, 1, 0, 0)).toMatchObject({ boxWidth: 300 });
    expect(transformElement(makeText(P(0, 0), 'x', '#1a1a1a', 24)!, 3, 1, 0, 0)).toMatchObject({
      boxWidth: null,
    });
  });

  it('never touches raw content', () => {
    const raw: SceneElement = { kind: 'raw', xml: '<circle cx="1" cy="1" r="1"/>' };
    expect(transformElement(raw, 5, 5, 5, 5)).toBe(raw);
  });
});

describe('document-level moves', () => {
  it('moves only the selected elements and preserves their indices', () => {
    const doc = board([rect, stroke]);
    const moved = translateElements(doc, [REF(1)], 10, 10);
    expect(moved.layers[0]!.elements[0]).toBe(rect);
    expect(moved.layers[0]!.elements[1]).not.toBe(stroke);
    expect(moved.layers[0]!.elements).toHaveLength(2);
  });

  it('is a no-op for a zero move, so a click never dirties the file', () => {
    const doc = board([rect]);
    expect(translateElements(doc, [REF(0)], 0, 0)).toBe(doc);
  });

  it('does not mutate the document it was given', () => {
    const doc = board([rect]);
    const before = JSON.stringify(doc);
    translateElements(doc, [REF(0)], 25, 25);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('resizes a selection so its box lands on the target', () => {
    const doc = board([rect]);
    const from = selectionBounds(doc, [REF(0)])!;
    const to = { x: 100, y: 200, width: from.width * 2, height: from.height * 2 };
    const after = selectionBounds(scaleElements(doc, [REF(0)], from, to), [REF(0)])!;
    expect(after).toMatchObject({ x: 100, y: 200, width: to.width, height: to.height });
  });

  it('lands within a stroke width under a NON-uniform resize', () => {
    // The box includes half the stroke width on each side, and a single
    // stroke-width cannot follow two different axis scales — it takes the
    // geometric mean, so a stretched box is off by that much and no more.
    const doc = board([rect]);
    const from = selectionBounds(doc, [REF(0)])!;
    const to = { ...from, width: from.width * 2 };
    const after = selectionBounds(scaleElements(doc, [REF(0)], from, to), [REF(0)])!;
    expect(Math.abs(after.width - to.width)).toBeLessThanOrEqual(rect.strokeWidth * 2);
  });

  it('replaces one element in place', () => {
    const doc = board([rect, stroke]);
    const text = makeText(P(0, 0), 'x', '#1a1a1a', 16)!;
    const next = replaceElement(doc, REF(0), text);
    expect(next.layers[0]!.elements[0]).toBe(text);
    expect(next.layers[0]!.elements[1]).toBe(stroke);
  });
});

describe('a moved element still round-trips through the format', () => {
  it('survives serialize → parse unchanged', () => {
    const doc = translateElements(board([rect, stroke]), [REF(0), REF(1)], 12.5, -7.25);
    const source = serializeWhiteboard(doc);
    expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
    expect(parseWhiteboard(source).layers[0]!.elements).toEqual(doc.layers[0]!.elements);
  });

  it('survives a resize too', () => {
    const base = board([stroke]);
    const from = selectionBounds(base, [REF(0)])!;
    const doc = scaleElements(base, [REF(0)], from, { ...from, width: from.width * 1.5 });
    const source = serializeWhiteboard(doc);
    expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
  });
});
