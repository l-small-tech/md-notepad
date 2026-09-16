/**
 * Flat groups and the selection expansion that makes groups and labels move
 * as one. The property that matters most: expansion is a CLOSURE — idempotent,
 * two-way for labels, and blind to locked layers.
 */

import { describe, expect, it } from 'vitest';
import {
  canGroup,
  canUngroup,
  docOrder,
  expandSelection,
  groupElements,
  groupOf,
  membersOf,
  selectionUnits,
  ungroupElements,
  withoutRefs,
} from '../groups';
import { attachLabel } from '../labels';
import { createLayer, createScene, type Layer, type SceneDoc, type SceneElement } from '../scene';
import { makeShape, makeText } from '../tools';

const P = (x: number, y: number) => ({ x, y });
const INK = '#1a1a1a';
const REF = (index: number, layerId = 'a1B2') => ({ layerId, index });

function board(...elements: SceneElement[]): SceneDoc {
  return createScene({ layers: [createLayer({ id: 'a1B2', elements })] });
}

function seq(): () => number {
  let n = 0;
  return () => (n++ % 62) / 62;
}

const box = (x: number) => makeShape('rect', P(x, 0), P(x + 50, 50), { color: INK, width: 2 })!;
const words = makeText(P(0, 0), 'hi', INK, 20)!;

describe('groupElements', () => {
  it('tags every member with one fresh id and leaves the rest alone', () => {
    const doc = groupElements(board(box(0), box(100), box(200)), [REF(0), REF(2)], seq());
    expect(groupOf(doc, REF(0))).toBe('abcd');
    expect(groupOf(doc, REF(2))).toBe('abcd');
    expect(groupOf(doc, REF(1))).toBeNull();
    expect(membersOf(doc, 'abcd')).toEqual([REF(0), REF(2)]);
  });

  it('is a no-op for fewer than two elements — a group of one is no group', () => {
    const doc = board(box(0), box(100));
    expect(groupElements(doc, [REF(0)])).toBe(doc);
    expect(canGroup([REF(0)])).toBe(false);
    expect(canGroup([REF(0), REF(1)])).toBe(true);
  });

  it('merges rather than nests: regrouping over an existing group retags it', () => {
    const first = groupElements(board(box(0), box(100), box(200)), [REF(0), REF(1)], seq());
    const merged = groupElements(first, [REF(0), REF(1), REF(2)], seq());
    const tags = new Set([0, 1, 2].map((i) => groupOf(merged, REF(i))));
    expect(tags.size).toBe(1);
    expect(tags.has('abcd')).toBe(false); // not the old tag
  });

  it('ungroups by clearing the tag', () => {
    const grouped = groupElements(board(box(0), box(100)), [REF(0), REF(1)], seq());
    expect(canUngroup(grouped, [REF(0)])).toBe(true);
    const out = ungroupElements(grouped, [REF(0), REF(1)]);
    expect(groupOf(out, REF(0))).toBeNull();
    expect(groupOf(out, REF(1))).toBeNull();
    expect(canUngroup(out, [REF(0)])).toBe(false);
    expect(ungroupElements(out, [REF(0)])).toBe(out);
  });
});

describe('expandSelection', () => {
  const grouped = groupElements(board(box(0), box(100), box(200)), [REF(0), REF(2)], seq());

  it('pulls in the whole group from any member, in document order', () => {
    expect(expandSelection(grouped, [REF(2)])).toEqual([REF(0), REF(2)]);
  });

  it('is idempotent', () => {
    const once = expandSelection(grouped, [REF(2)]);
    expect(expandSelection(grouped, once)).toEqual(once);
  });

  it('welds a label to its host in both directions', () => {
    const doc = attachLabel(board(box(0), box(100)), REF(0), words, seq())!.doc;
    // Layer is now [host, label, box(100)].
    expect(expandSelection(doc, [REF(0)])).toEqual([REF(0), REF(1)]);
    expect(expandSelection(doc, [REF(1)])).toEqual([REF(0), REF(1)]);
    expect(expandSelection(doc, [REF(2)])).toEqual([REF(2)]);
  });

  it('follows a group into a label and a label into a group', () => {
    const labelled = attachLabel(board(box(0), box(100)), REF(0), words, seq())!.doc;
    // Group the host with the other box; the label is neither tagged nor selected.
    const doc = groupElements(labelled, [REF(0), REF(2)], seq());
    expect(expandSelection(doc, [REF(2)])).toEqual([REF(0), REF(1), REF(2)]);
    expect(expandSelection(doc, [REF(1)])).toEqual([REF(0), REF(1), REF(2)]);
  });

  it('ignores members on a locked or hidden layer', () => {
    const shared: Layer = createLayer({
      id: 'lock',
      locked: true,
      elements: [{ ...box(300), group: 'abcd' }],
    });
    const doc: SceneDoc = { ...grouped, layers: [...grouped.layers, shared] };
    expect(expandSelection(doc, [REF(0)])).toEqual([REF(0), REF(2)]);
    expect(expandSelection(doc, [REF(0, 'lock')])).toEqual([]);
  });

  it('drops raw refs and refs to nothing', () => {
    const doc = board(box(0), { kind: 'raw', xml: '<x/>' });
    expect(expandSelection(doc, [REF(1), REF(7)])).toEqual([]);
  });
});

describe('selectionUnits', () => {
  it('partitions a selection into groups, label+host pairs and singles', () => {
    const labelled = attachLabel(
      board(box(0), box(100), box(200), box(300)),
      REF(0),
      words,
      seq(),
    )!.doc; // [host, label, b100, b200, b300]
    const doc = groupElements(labelled, [REF(2), REF(3)], seq());
    const units = selectionUnits(doc, [REF(4), REF(3), REF(2), REF(1), REF(0)]);
    expect(units).toEqual([[REF(0), REF(1)], [REF(2), REF(3)], [REF(4)]]);
  });

  it('keeps an orphan label as its own unit', () => {
    const doc = board(box(0), { ...words, labelOf: 'gone' });
    expect(selectionUnits(doc, [REF(0), REF(1)])).toEqual([[REF(0)], [REF(1)]]);
  });
});

describe('helpers', () => {
  it('docOrder sorts by layer then index and drops unknown refs', () => {
    const doc: SceneDoc = createScene({
      layers: [
        createLayer({ id: 'a', elements: [box(0), box(1)] }),
        createLayer({ id: 'b', elements: [box(2)] }),
      ],
    });
    expect(docOrder(doc, [REF(0, 'b'), REF(1, 'a'), REF(0, 'a'), REF(9, 'a')])).toEqual([
      REF(0, 'a'),
      REF(1, 'a'),
      REF(0, 'b'),
    ]);
  });

  it('withoutRefs removes a whole unit from the set', () => {
    expect(withoutRefs([REF(0), REF(1), REF(2)], [REF(1), REF(0)])).toEqual([REF(2)]);
  });
});
