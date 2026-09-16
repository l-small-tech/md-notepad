/**
 * Restyling a selection — the pure half of "the ribbon is the style panel".
 *
 * Two properties matter more than any individual mapping: a patch NEVER
 * touches a field it was not given, and every kind ignores what it cannot
 * express rather than growing a field it does not render. Both are what let
 * one click restyle a mixed selection in one undo step.
 */

import { describe, expect, it } from 'vitest';
import { createLayer, createScene, type SceneDoc, type SceneElement } from '../scene';
import { restyleElements, selectionStyle, type StylePatch } from '../style';
import { makeShape, makeStroke, makeText } from '../tools';
import { HIGHLIGHTER_WIDTH_FACTOR, PALETTE, PAPER_FILL } from '../tool-settings';
import { DEFAULT_BACKGROUND } from '../scene';

const P = (x: number, y: number) => ({ x, y });
const INK = '#1a1a1a';
const REF = (index: number) => ({ layerId: 'a1B2', index });

function board(...elements: SceneElement[]): SceneDoc {
  return createScene({ layers: [createLayer({ id: 'a1B2', elements })] });
}

function restyled(elements: SceneElement[], patch: StylePatch): readonly SceneElement[] {
  const refs = elements.map((_, i) => REF(i));
  return restyleElements(board(...elements), refs, patch).layers[0]!.elements;
}

const rect = makeShape('rect', P(0, 0), P(100, 50), { color: INK, width: 2 })!;
const line = makeShape('line', P(0, 0), P(100, 0), { color: INK, width: 2 })!;
const arrow = makeShape('arrow', P(0, 0), P(100, 0), { color: INK, width: 2 })!;
const pen = makeStroke('pen', [P(0, 0), P(10, 10)], INK, 2)!;
const text = makeText(P(0, 0), 'hi', INK, 24)!;

describe('restyleElements', () => {
  it('recolours every kind, mapping a text element to its fill', () => {
    const [shape, stroke, label] = restyled([rect, pen, text], { stroke: PALETTE[5]! });
    expect(shape).toMatchObject({ stroke: PALETTE[5] });
    expect(stroke).toMatchObject({ stroke: PALETTE[5] });
    expect(label).toMatchObject({ fill: PALETTE[5] });
  });

  it('drops a stored palette slot on recolour — it would render the OLD slot', () => {
    const scanned: SceneElement = { ...pen, stroke: '#123456', slot: 3 };
    const [out] = restyled([scanned], { stroke: PALETTE[1]! });
    expect(out).not.toHaveProperty('slot');
  });

  it('fills a closed shape and leaves a line alone — a line has no inside', () => {
    const [shape, open] = restyled([rect, line], { fill: PAPER_FILL });
    expect(shape).toMatchObject({ fill: PAPER_FILL });
    expect(open).toMatchObject({ fill: 'none' });
  });

  it('keeps the highlighter fat when the nib changes', () => {
    const highlighter = makeStroke('highlighter', [P(0, 0), P(10, 0)], INK, 2)!;
    const [out] = restyled([highlighter], { strokeWidth: 4 });
    expect(out).toMatchObject({ strokeWidth: 4 * HIGHLIGHTER_WIDTH_FACTOR });
  });

  it('redraws the dash pattern when the nib changes, so a dashed line stays dashed', () => {
    const dashed = makeShape('rect', P(0, 0), P(100, 50), {
      color: INK,
      width: 2,
      dash: 'dashed',
    })!;
    expect(dashed.dash).toBe('8 5');
    const [out] = restyled([dashed], { strokeWidth: 4 });
    expect(out).toMatchObject({ strokeWidth: 4, dash: '16 10' });
  });

  it('leaves a pattern it did not write alone when the nib changes', () => {
    const custom: SceneElement = { ...rect, dash: '3 1 9' };
    const [out] = restyled([custom], { strokeWidth: 8 });
    expect(out).toMatchObject({ dash: '3 1 9' });
  });

  it('moves the end head by changing the KIND, which is where the format keeps it', () => {
    expect(restyled([line], { markerEnd: true })[0]).toMatchObject({ shape: 'arrow' });
    expect(restyled([arrow], { markerEnd: false })[0]).toMatchObject({ shape: 'line' });
    expect(restyled([arrow], { markerStart: true })[0]).toMatchObject({
      shape: 'arrow',
      markerStart: true,
    });
  });

  it('never touches a field the patch did not mention', () => {
    const [out] = restyled([rect], { stroke: PALETTE[2]! });
    expect(out).toMatchObject({
      fill: rect.fill,
      strokeWidth: rect.strokeWidth,
      dash: rect.dash,
      rx: rect.rx,
    });
  });

  it('leaves raw and image content untouched — it is not ours to restyle', () => {
    const raw: SceneElement = { kind: 'raw', xml: '<circle r="1"/>' };
    const image: SceneElement = {
      kind: 'image',
      id: null,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      href: 'data:,',
      opacity: null,
    };
    const [a, b] = restyled([raw, image], { stroke: PALETTE[1]!, strokeWidth: 9 });
    expect(a).toEqual(raw);
    expect(b).toEqual(image);
  });
});

describe('selectionStyle', () => {
  it('is null with nothing selected — the ribbon then shows the TOOL', () => {
    expect(selectionStyle(board(rect), [])).toBeNull();
  });

  it('reports a single shape in full', () => {
    expect(selectionStyle(board(rect), [REF(0)])).toMatchObject({
      stroke: INK,
      fill: 'none',
      strokeWidth: 2,
      dash: 'solid',
      heads: null,
      hasLine: false,
      hasFill: true,
      hasText: false,
      hasInk: true,
    });
  });

  it('reports null for anything the selection disagrees about', () => {
    const other = makeShape('rect', P(0, 0), P(10, 10), { color: PALETTE[5]!, width: 4 })!;
    const style = selectionStyle(board(rect, other), [REF(0), REF(1)])!;
    expect(style.stroke).toBeNull();
    expect(style.strokeWidth).toBeNull();
    // Both are solid, so THAT they still agree on.
    expect(style.dash).toBe('solid');
  });

  it('reads the heads off a line, and says a shape-only selection has none', () => {
    expect(selectionStyle(board(arrow), [REF(0)])!.heads).toBe('end');
    const both: SceneElement = { ...arrow, markerStart: true };
    expect(selectionStyle(board(both), [REF(0)])!.heads).toBe('both');
    expect(selectionStyle(board(line), [REF(0)])!.heads).toBe('none');
    expect(selectionStyle(board(rect), [REF(0)])!.hasLine).toBe(false);
  });

  it('reports the highlighter’s NIB, not its painted width', () => {
    const highlighter = makeStroke('highlighter', [P(0, 0), P(10, 0)], INK, 3)!;
    expect(selectionStyle(board(highlighter), [REF(0)])!.strokeWidth).toBe(3);
  });

  it('takes a text element’s colour from its fill', () => {
    expect(selectionStyle(board(text, rect), [REF(0), REF(1)])!.stroke).toBe(INK);
  });

  it('says which control rows the ribbon owes a mixed selection', () => {
    const style = selectionStyle(board(text, rect), [REF(0), REF(1)])!;
    // Text AND a nib-drawn outline: the ribbon shows both rows rather than
    // guessing which half of the selection you meant.
    expect(style).toMatchObject({ hasText: true, hasInk: true });
    expect(selectionStyle(board(text), [REF(0)])!).toMatchObject({
      hasText: true,
      hasInk: false,
    });
  });
});

describe('the Paper fill', () => {
  it('is the board’s own background colour, which is what makes it themable', () => {
    // tool-settings is a dependency-free leaf and cannot import this, so the
    // coupling is pinned here instead.
    expect(PAPER_FILL).toBe(DEFAULT_BACKGROUND);
  });
});
