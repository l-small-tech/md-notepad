/**
 * Copy/paste as a document fragment, and the id remapping that keeps links
 * consistent inside a pasted set while cutting every link out of it.
 */

import { describe, expect, it } from 'vitest';
import {
  copyElements,
  parseFragment,
  PASTE_OFFSET,
  pasteElements,
  serializeFragment,
} from '../clipboard';
import { groupElements } from '../groups';
import { attachLabel } from '../labels';
import { parseWhiteboard } from '../parse';
import {
  createLayer,
  createScene,
  freshElementId,
  remapIds,
  usedIds,
  type SceneDoc,
  type SceneElement,
} from '../scene';
import { resolveElement } from '../select';
import { makeShape, makeStroke, makeText } from '../tools';

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

const rect = makeShape('rect', P(0, 0), P(100, 50), { color: INK, width: 2 })!;
const pen = makeStroke('pen', [P(0, 0), P(10, 10)], INK, 2)!;
const words = makeText(P(5, 5), 'hi', INK, 20)!;

describe('ids', () => {
  it('freshElementId avoids every id AND group tag in the document', () => {
    const doc = board({ ...rect, id: 'abcd' }, { ...pen, group: 'efgh' });
    expect(usedIds(doc)).toEqual(new Set(['abcd', 'efgh']));
    // seq() would produce 'abcd' then 'efgh' — both taken.
    expect(freshElementId(doc, seq())).toBe('ijkl');
  });

  it('remapIds maps ids, maps known references and drops unknown ones', () => {
    const mapping = new Map([
      ['host', 'HOST'],
      ['grp', 'GRP'],
    ]);
    const [shape, label, orphan, member] = remapIds(
      [
        { ...rect, id: 'host' },
        { ...words, labelOf: 'host' },
        { ...words, labelOf: 'elsewhere', id: 'keep' },
        { ...pen, group: 'grp' },
      ],
      mapping,
    );
    expect(shape).toMatchObject({ id: 'HOST' });
    expect(label).toMatchObject({ labelOf: 'HOST' });
    expect(orphan).toMatchObject({ labelOf: null, id: 'keep' });
    expect(member).toMatchObject({ group: 'GRP' });
  });
});

describe('the fragment', () => {
  it('is a whiteboard that parses back to the same elements', () => {
    const text = serializeFragment([rect, pen, words]);
    expect(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(parseFragment(text)).toEqual([rect, pen, words]);
    // …and our own file format is a fragment too.
    expect(parseFragment(text.replace('Clipboard', 'Layer 1'))).toHaveLength(3);
  });

  it('keeps a scan stroke’s stored slot across the trip', () => {
    const scanned = { ...pen, stroke: '#123456', slot: 3 };
    expect(parseFragment(serializeFragment([scanned]))).toEqual([scanned]);
  });

  it('is null for prose, for a foreign SVG and for an empty board', () => {
    expect(parseFragment('hello there')).toBeNull();
    expect(parseFragment('<b>bold</b>')).toBeNull();
    expect(
      parseFragment('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>'),
    ).toBeNull();
    expect(parseFragment(serializeFragment([]))).toBeNull();
    expect(parseFragment('   ')).toBeNull();
  });

  it('copies in document order, raw content excluded', () => {
    const doc = board(rect, { kind: 'raw', xml: '<x/>' }, pen);
    expect(copyElements(doc, [REF(2), REF(1), REF(0)])).toEqual([rect, pen]);
  });
});

describe('pasteElements', () => {
  it('lands on the target layer, offset, and returns the refs', () => {
    const doc = board(rect);
    const out = pasteElements(doc, [rect, pen], 'a1B2', PASTE_OFFSET);
    expect(out.layerId).toBe('a1B2');
    expect(out.refs).toEqual([REF(1), REF(2)]);
    expect(resolveElement(out.doc, REF(1))).toMatchObject({
      geom: { x: PASTE_OFFSET, y: PASTE_OFFSET, width: 100, height: 50 },
    });
    expect(resolveElement(out.doc, REF(2))).toMatchObject({ kind: 'stroke' });
  });

  it('creates a layer to land on when none is editable', () => {
    const locked = createScene({ layers: [createLayer({ id: 'x', locked: true })] });
    const out = pasteElements(locked, [rect], null, 0);
    expect(out.doc.layers).toHaveLength(2);
    expect(out.refs[0]!.layerId).toBe(out.layerId);
  });

  it('keeps a label attached to the COPY of its host', () => {
    const source = attachLabel(board(rect), REF(0), words, seq())!.doc;
    const copied = copyElements(source, [REF(0), REF(1)]);
    const out = pasteElements(source, copied, 'a1B2', PASTE_OFFSET, seq());
    const host = resolveElement(out.doc, out.refs[0]!)!;
    const label = resolveElement(out.doc, out.refs[1]!)!;
    expect(host.kind).toBe('shape');
    expect(host.kind !== 'raw' && host.id).not.toBe('abcd'); // fresh
    expect(label).toMatchObject({ kind: 'text', labelOf: host.kind !== 'raw' ? host.id : '' });
    // The original is untouched.
    expect(resolveElement(out.doc, REF(1))).toMatchObject({ labelOf: 'abcd' });
  });

  it('turns a label pasted without its host into plain text', () => {
    const source = attachLabel(board(rect), REF(0), words, seq())!.doc;
    const out = pasteElements(source, copyElements(source, [REF(1)]), 'a1B2', 0);
    expect(resolveElement(out.doc, out.refs[0]!)).toMatchObject({ kind: 'text', labelOf: null });
  });

  it('gives a pasted group a fresh tag and drops a group of one', () => {
    const grouped = groupElements(board(rect, pen, words), [REF(0), REF(1)], seq());
    const whole = pasteElements(grouped, copyElements(grouped, [REF(0), REF(1)]), 'a1B2', 0, seq());
    const [a, b] = whole.refs.map((ref) => resolveElement(whole.doc, ref)!);
    expect(a!.kind !== 'raw' && a!.group).toBeTruthy();
    expect(a!.kind !== 'raw' && b!.kind !== 'raw' && a!.group === b!.group).toBe(true);
    expect(a!.kind !== 'raw' && a!.group).not.toBe('abcd');

    const single = pasteElements(grouped, copyElements(grouped, [REF(0)]), 'a1B2', 0);
    expect(resolveElement(single.doc, single.refs[0]!)).toMatchObject({ group: null });
  });

  it('round-trips through the fragment text with links intact', () => {
    const source = attachLabel(board(rect), REF(0), words, seq())!.doc;
    const text = serializeFragment(copyElements(source, [REF(0), REF(1)]));
    expect(text).toContain('wb:label-of="abcd"');
    const out = pasteElements(createScene(), parseFragment(text)!, null, PASTE_OFFSET);
    const [host, label] = out.refs.map((ref) => resolveElement(out.doc, ref)!);
    expect(label).toMatchObject({ labelOf: host!.kind !== 'raw' ? host!.id : '' });
    expect(parseWhiteboard(text).layers[0]!.name).toBe('Clipboard');
  });

  it('is a no-op for nothing', () => {
    const doc = board(rect);
    expect(pasteElements(doc, [], 'a1B2', 16).doc).toBe(doc);
  });
});
