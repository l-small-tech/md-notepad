/**
 * Z-order, align and distribute. Every operation is a pure permutation or
 * translation — nothing is resized, nothing crosses a layer — and each
 * returns the SAME document when it has nothing to do.
 */

import { describe, expect, it } from 'vitest';
import {
  alignElements,
  canAlign,
  canDistribute,
  distributeElements,
  reorderElements,
} from '../arrange';
import { elementBounds } from '../hit-test';
import { groupElements } from '../groups';
import { attachLabel } from '../labels';
import { createLayer, createScene, type SceneDoc, type SceneElement } from '../scene';
import { resolveElement } from '../select';
import { makeShape, makeText } from '../tools';

const P = (x: number, y: number) => ({ x, y });
const INK = '#1a1a1a';
const REF = (index: number, layerId = 'a1B2') => ({ layerId, index });

function board(...elements: SceneElement[]): SceneDoc {
  return createScene({ layers: [createLayer({ id: 'a1B2', elements })] });
}

/** A tagged rect so tests can follow elements through a reorder. */
const box = (id: string, x = 0, y = 0, w = 50, h = 50): SceneElement => ({
  ...makeShape('rect', P(x, y), P(x + w, y + h), { color: INK, width: 0 })!,
  id,
});

const ids = (doc: SceneDoc): string[] =>
  doc.layers[0]!.elements.map((e) => (e.kind === 'raw' ? 'raw' : (e.id ?? '?')));

function seq(): () => number {
  let n = 0;
  return () => (n++ % 62) / 62;
}

describe('reorderElements', () => {
  const doc = board(box('a'), box('b'), box('c'), box('d'));

  it('brings to front and sends to back, keeping relative order', () => {
    const front = reorderElements(doc, [REF(0), REF(2)], 'front');
    expect(ids(front.doc)).toEqual(['b', 'd', 'a', 'c']);
    expect(front.refs).toEqual([REF(2), REF(3)]);
    const back = reorderElements(doc, [REF(1), REF(3)], 'back');
    expect(ids(back.doc)).toEqual(['b', 'd', 'a', 'c']);
    expect(back.refs).toEqual([REF(0), REF(1)]);
  });

  it('steps forward and backward one element at a time, as a block', () => {
    const fwd = reorderElements(doc, [REF(0), REF(1)], 'forward');
    expect(ids(fwd.doc)).toEqual(['c', 'a', 'b', 'd']);
    expect(fwd.refs).toEqual([REF(1), REF(2)]);
    const bwd = reorderElements(doc, [REF(2), REF(3)], 'backward');
    expect(ids(bwd.doc)).toEqual(['a', 'c', 'd', 'b']);
    expect(bwd.refs).toEqual([REF(1), REF(2)]);
  });

  it('returns the same document at the top or bottom of the stack', () => {
    expect(reorderElements(doc, [REF(3)], 'forward').doc).toBe(doc);
    expect(reorderElements(doc, [REF(3)], 'front').doc).toBe(doc);
    expect(reorderElements(doc, [REF(0)], 'backward').doc).toBe(doc);
    expect(reorderElements(doc, [], 'front').doc).toBe(doc);
  });

  it('restacks within each layer independently', () => {
    const two: SceneDoc = createScene({
      layers: [
        createLayer({ id: 'a1B2', elements: [box('a'), box('b')] }),
        createLayer({ id: 'c3D4', elements: [box('c'), box('d')] }),
      ],
    });
    const out = reorderElements(two, [REF(0), REF(0, 'c3D4')], 'front');
    expect(ids(out.doc)).toEqual(['b', 'a']);
    expect(out.doc.layers[1]!.elements.map((e) => (e.kind === 'shape' ? e.id : ''))).toEqual([
      'd',
      'c',
    ]);
    expect(out.refs).toEqual([REF(1), REF(1, 'c3D4')]);
  });

  it('steps over raw content like any other element', () => {
    const withRaw = board(box('a'), { kind: 'raw', xml: '<x/>' }, box('c'));
    expect(ids(reorderElements(withRaw, [REF(0)], 'forward').doc)).toEqual(['raw', 'a', 'c']);
  });
});

describe('alignElements', () => {
  const doc = board(box('a', 0, 0, 50, 50), box('b', 100, 100, 20, 20), box('c', 40, 200, 80, 10));
  const boxOf = (out: SceneDoc, i: number) => elementBounds(resolveElement(out, REF(i))!)!;

  it('needs two units', () => {
    expect(canAlign(doc, [REF(0)])).toBe(false);
    expect(canAlign(doc, [REF(0), REF(1)])).toBe(true);
    expect(alignElements(doc, [REF(0)], 'left')).toBe(doc);
  });

  it.each([
    ['left', (b: { x: number }) => b.x, 0],
    ['center', (b: { x: number; width: number }) => b.x + b.width / 2, 60],
    ['right', (b: { x: number; width: number }) => b.x + b.width, 120],
    ['top', (b: { y: number }) => b.y, 0],
    ['middle', (b: { y: number; height: number }) => b.y + b.height / 2, 105],
    ['bottom', (b: { y: number; height: number }) => b.y + b.height, 210],
  ] as const)('%s lines every element up on the selection box', (edge, measure, expected) => {
    const out = alignElements(doc, [REF(0), REF(1), REF(2)], edge);
    for (const i of [0, 1, 2]) {
      expect(measure(boxOf(out, i))).toBeCloseTo(expected);
    }
  });

  it('only translates — sizes never change', () => {
    const out = alignElements(doc, [REF(0), REF(1), REF(2)], 'center');
    expect(boxOf(out, 2)).toMatchObject({ width: 80, height: 10 });
  });

  it('moves a group as one unit and a label with its host', () => {
    const grouped = groupElements(doc, [REF(0), REF(1)], seq());
    const out = alignElements(grouped, [REF(0), REF(1), REF(2)], 'left');
    // The group's own box starts at x=0; it stays, and c moves to 0.
    expect(boxOf(out, 0).x).toBe(0);
    expect(boxOf(out, 1).x).toBe(100);
    expect(boxOf(out, 2).x).toBe(0);

    const labelled = attachLabel(doc, REF(1), makeText(P(0, 0), 'b', INK, 8)!, seq())!.doc;
    // Layer is [a, b, label, c]; align a with b+label on the right edge
    // (b's, at 120 — the label sits inside b, so it adds nothing).
    const aligned = alignElements(labelled, [REF(0), REF(1), REF(2)], 'right');
    const a = boxOf(aligned, 0);
    const b = boxOf(aligned, 1);
    const label = resolveElement(aligned, REF(2))!;
    expect(b.x + b.width).toBe(120);
    expect(a.x + a.width).toBe(120);
    expect(label).toMatchObject({ kind: 'text', x: b.x + b.width / 2 });
  });
});

describe('distributeElements', () => {
  it('needs three units', () => {
    const doc = board(box('a'), box('b', 100));
    expect(canDistribute(doc, [REF(0), REF(1)])).toBe(false);
    expect(distributeElements(doc, [REF(0), REF(1)], 'horizontal')).toBe(doc);
  });

  it('equalises the gaps and keeps the outer two where they are', () => {
    const doc = board(box('a', 0, 0, 20, 20), box('b', 30, 0, 40, 20), box('c', 200, 0, 20, 20));
    const out = distributeElements(doc, [REF(0), REF(1), REF(2)], 'horizontal');
    const at = (i: number) => elementBounds(resolveElement(out, REF(i))!)!;
    expect(at(0).x).toBe(0);
    expect(at(2).x).toBe(200);
    // span 220 − widths 80 = 140 over two gaps → 70 each.
    expect(at(1).x).toBeCloseTo(90);
    expect(canDistribute(doc, [REF(0), REF(1), REF(2)])).toBe(true);
  });

  it('falls back to even centres when the units overlap', () => {
    const doc = board(box('a', 0, 0, 100, 10), box('b', 10, 0, 100, 10), box('c', 50, 0, 100, 10));
    const out = distributeElements(doc, [REF(0), REF(1), REF(2)], 'horizontal');
    const centre = (i: number) => {
      const b = elementBounds(resolveElement(out, REF(i))!)!;
      return b.x + b.width / 2;
    };
    expect(centre(0)).toBe(50);
    expect(centre(2)).toBe(100);
    expect(centre(1)).toBeCloseTo(75);
  });

  it('works vertically too', () => {
    const doc = board(box('a', 0, 0, 10, 10), box('b', 0, 15, 10, 10), box('c', 0, 100, 10, 10));
    const out = distributeElements(doc, [REF(0), REF(1), REF(2)], 'vertical');
    expect(elementBounds(resolveElement(out, REF(1))!)!.y).toBeCloseTo(50);
  });
});
