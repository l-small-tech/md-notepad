/**
 * Labels: centred text that follows its host.
 *
 * The contract under test is geometric and structural, not typographic — core
 * has no font metrics. What matters: the block centres on the host's centre
 * (a line's midpoint), re-centring is a fixed point, an orphan is left alone,
 * and attaching gives the host an id without renaming one it already has.
 */

import { describe, expect, it } from 'vitest';
import {
  attachLabel,
  canHostLabel,
  hostOf,
  labelBaseline,
  labelCentreY,
  labelPosition,
  labelsOf,
  relayoutLabels,
  withLabels,
  LABEL_LINE_HEIGHT,
  LABEL_CAP_CENTRE,
} from '../labels';
import { createLayer, createScene, type SceneDoc, type SceneElement } from '../scene';
import { makeShape, makeText } from '../tools';
import { resolveElement, translateElements } from '../select';
import { elementBounds, hitTestElement } from '../hit-test';

const P = (x: number, y: number) => ({ x, y });
const INK = '#1a1a1a';
const REF = (index: number, layerId = 'a1B2') => ({ layerId, index });

function board(...elements: SceneElement[]): SceneDoc {
  return createScene({ layers: [createLayer({ id: 'a1B2', elements })] });
}

/** Deterministic ids: 'abcd', 'efgh', … */
function seq(): () => number {
  let n = 0;
  return () => (n++ % 62) / 62;
}

const rect = makeShape('rect', P(100, 100), P(300, 200), { color: INK, width: 2 })!;
const line = makeShape('line', P(0, 0), P(100, 50), { color: INK, width: 2 })!;
const words = makeText(P(0, 0), 'hi', INK, 20)!;

describe('labelBaseline', () => {
  it('puts a single line’s cap centre on the centre', () => {
    expect(labelBaseline(100, 20, 1)).toBe(100 + LABEL_CAP_CENTRE * 20);
  });

  it('stacks lines symmetrically around the centre at 1.2 line height', () => {
    const y = labelBaseline(100, 20, 3);
    const last = y + 2 * LABEL_LINE_HEIGHT * 20;
    // The middle line's baseline is exactly one line down and sits where a
    // single line would.
    expect(y + LABEL_LINE_HEIGHT * 20).toBeCloseTo(labelBaseline(100, 20, 1));
    expect((y + last) / 2).toBeCloseTo(labelBaseline(100, 20, 1));
  });

  it('inverts through labelCentreY', () => {
    for (const lines of [1, 2, 5]) {
      expect(labelCentreY(labelBaseline(73, 24, lines), 24, lines)).toBeCloseTo(73);
    }
  });
});

describe('labelPosition', () => {
  it('centres on a box shape', () => {
    expect(labelPosition(rect, 20, 1)).toEqual({ x: 200, y: labelBaseline(150, 20, 1) });
  });

  it('centres on a line’s midpoint', () => {
    expect(labelPosition(line, 20, 1)).toEqual({ x: 50, y: labelBaseline(25, 20, 1) });
  });

  it('only shapes and pictures can host', () => {
    expect(canHostLabel(rect)).toBe(true);
    expect(canHostLabel(words)).toBe(false);
    expect(canHostLabel({ kind: 'raw', xml: '<x/>' })).toBe(false);
  });
});

describe('attachLabel', () => {
  it('gives the host a fresh id, links the text and inserts it just above the host', () => {
    const doc = board(rect, line);
    const out = attachLabel(doc, REF(0), words, seq())!;
    const host = resolveElement(out.doc, REF(0))!;
    const label = resolveElement(out.doc, out.ref)!;
    expect(host).toMatchObject({ kind: 'shape', id: 'abcd' });
    expect(out.ref).toEqual(REF(1));
    expect(label).toMatchObject({ kind: 'text', labelOf: 'abcd', x: 200 });
    expect(out.doc.layers[0]!.elements).toHaveLength(3);
    expect(labelsOf(out.doc, 'abcd')).toEqual([REF(1)]);
    expect(hostOf(out.doc, label as never)).toEqual(REF(0));
  });

  it('keeps an id the host already has', () => {
    const doc = board({ ...rect, id: 'box1' });
    const out = attachLabel(doc, REF(0), words)!;
    expect(resolveElement(out.doc, out.ref)).toMatchObject({ labelOf: 'box1' });
  });

  it('refuses a host that cannot carry a label', () => {
    expect(attachLabel(board(words), REF(0), words)).toBeNull();
  });
});

describe('relayoutLabels', () => {
  const labelled = attachLabel(board(rect), REF(0), words, seq())!.doc;

  it('is a fixed point on a document whose labels are centred', () => {
    expect(relayoutLabels(labelled)).toBe(labelled);
  });

  it('re-centres a label after its host moved', () => {
    const moved = translateElements(labelled, [REF(0)], 40, -10);
    const out = relayoutLabels(moved);
    expect(out).not.toBe(moved);
    expect(resolveElement(out, REF(1))).toMatchObject({
      x: 240,
      y: labelBaseline(140, 20, 1),
    });
  });

  it('leaves an orphan where it is', () => {
    const orphan = board({ ...words, labelOf: 'gone', x: 7, y: 9 });
    expect(relayoutLabels(orphan)).toBe(orphan);
  });

  it('re-centres a multi-line label from its line count', () => {
    const multi = { ...words, lines: ['a', 'b', 'c'] };
    const doc = attachLabel(board(rect), REF(0), multi)!.doc;
    expect(resolveElement(doc, REF(1))).toMatchObject({ y: labelBaseline(150, 20, 3) });
  });
});

describe('a label’s box', () => {
  it('straddles its x, because the text is middle-anchored', () => {
    const doc = attachLabel(board(rect), REF(0), words, seq())!.doc;
    const label = resolveElement(doc, REF(1))!;
    const box = elementBounds(label)!;
    expect(box.x + box.width / 2).toBeCloseTo(200);
    // …and so a click just left of the centre hits it.
    expect(hitTestElement(label, P(195, 150), 0)).toBe(true);
  });
});

describe('withLabels', () => {
  it('adds the labels of every host in the set, once', () => {
    const doc = attachLabel(board(rect), REF(0), words, seq())!.doc;
    expect(withLabels(doc, [REF(0)])).toEqual([REF(0), REF(1)]);
    expect(withLabels(doc, [REF(0), REF(1)])).toEqual([REF(0), REF(1)]);
    expect(withLabels(doc, [REF(1)])).toEqual([REF(1)]);
  });
});
