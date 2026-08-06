/**
 * The layout gate: handwriting rows become lines in reading order, boxes and
 * arrows are classified diagram-ish (never submitted to an engine), i-dots
 * attach to the word below them, and columns split. The classifier must fail
 * TOWARD diagram — the tests assert the obvious cases, not perfection.
 */

import { describe, expect, it } from 'vitest';
import type { Rect } from '../../geometry';
import { elementInk, groupTextLines, layoutItemsFromTrace, type LayoutItem } from '../text-layout';
import type { TraceResult } from '../trace';

let counter = 0;
function item(x: number, y: number, width: number, height: number): LayoutItem {
  return { index: counter++, bbox: { x, y, width, height } };
}

function items(...rects: Rect[]): LayoutItem[] {
  counter = 0;
  return rects.map((r) => ({ index: counter++, bbox: r }));
}

/** A row of word-ish boxes at a given baseline. */
function row(y: number, count: number, height = 30): Rect[] {
  const rects: Rect[] = [];
  let x = 20;
  for (let i = 0; i < count; i++) {
    const width = 40 + (i % 3) * 15;
    rects.push({ x, y, width, height });
    x += width + 12;
  }
  return rects;
}

describe('groupTextLines', () => {
  it('groups two handwriting rows into two lines in reading order', () => {
    const layout = groupTextLines(items(...row(50, 4), ...row(120, 3)), 4);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]!.items).toEqual([0, 1, 2, 3]);
    expect(layout.lines[1]!.items).toEqual([4, 5, 6]);
    expect(layout.diagram).toEqual([]);
  });

  it('classifies a big box and a long arrow as diagram', () => {
    const layout = groupTextLines(
      items(
        ...row(50, 4),
        { x: 10, y: 100, width: 300, height: 200 },
        { x: 20, y: 350, width: 400, height: 12 },
      ),
      4,
    );
    expect(layout.lines).toHaveLength(1);
    expect(layout.diagram).toEqual([4, 5]);
  });

  it('absorbs an i-dot floating above its line', () => {
    const rects = row(50, 3);
    // A 6×6 dot just above the first word's x-height.
    const layout = groupTextLines(items(...rects, { x: 30, y: 38, width: 6, height: 6 }), 4);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.items).toContain(3);
    expect(layout.diagram).toEqual([]);
  });

  it('drops an isolated speck as diagram, not text', () => {
    const layout = groupTextLines(items(...row(50, 3), { x: 400, y: 300, width: 6, height: 6 }), 4);
    expect(layout.lines).toHaveLength(1);
    expect(layout.diagram).toEqual([3]);
  });

  it('splits one band into two lines across a column gap', () => {
    const left = row(50, 3);
    const right = row(50, 3).map((r) => ({ ...r, x: r.x + 600 }));
    const layout = groupTextLines(items(...left, ...right), 4);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0]!.items).toEqual([0, 1, 2]);
    expect(layout.lines[1]!.items).toEqual([3, 4, 5]);
  });

  it('lets a lone word-shaped item stand as its own line', () => {
    const layout = groupTextLines(
      items(...row(50, 4), { x: 30, y: 120, width: 90, height: 32 }),
      4,
    );
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[1]!.items).toEqual([4]);
  });

  it('refuses a lone tall vertical mark as text', () => {
    const layout = groupTextLines(
      items(...row(50, 4), { x: 30, y: 120, width: 10, height: 60 }),
      4,
    );
    expect(layout.lines).toHaveLength(1);
    expect(layout.diagram).toEqual([4]);
  });

  it('keeps mixed-height marks on one row together when consistent enough', () => {
    // Ascenders and x-height letters: 30 vs 45 tall, same baseline band.
    const layout = groupTextLines(
      items(
        { x: 20, y: 65, width: 40, height: 30 },
        { x: 70, y: 50, width: 45, height: 45 },
        { x: 125, y: 65, width: 38, height: 30 },
      ),
      4,
    );
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0]!.items).toEqual([0, 1, 2]);
  });

  it('returns everything as diagram when there is nothing measurable', () => {
    counter = 0;
    const layout = groupTextLines([item(10, 10, 1, 1)], 4);
    expect(layout.lines).toHaveLength(0);
  });

  it('handles an empty board', () => {
    expect(groupTextLines([], 4)).toEqual({ lines: [], diagram: [] });
  });
});

describe('layoutItemsFromTrace / elementInk', () => {
  const trace: TraceResult = {
    strokeWidth: 4,
    width: 200,
    height: 100,
    components: [
      {
        kind: 'stroke',
        label: 1,
        paths: [
          [
            { x: 10, y: 20 },
            { x: 50, y: 20 },
          ],
          [
            { x: 60, y: 20 },
            { x: 61, y: 40 },
          ],
        ],
        widths: [
          [4, 4],
          [4, 4],
        ],
        pathWidths: [4, 6],
        strokeWidth: 4,
      },
      {
        kind: 'fill',
        label: 2,
        loops: [
          [
            { x: 100, y: 10 },
            { x: 120, y: 10 },
            { x: 120, y: 30 },
            { x: 100, y: 30 },
          ],
        ],
      },
    ],
  };

  it('emits one item per built element, in build order, width-padded', () => {
    const items = layoutItemsFromTrace(trace);
    expect(items.map((i) => i.index)).toEqual([0, 1, 2]);
    // First stroke path, padded by half its own path width (4/2 = 2).
    expect(items[0]!.bbox).toEqual({ x: 8, y: 18, width: 44, height: 4 });
    // Second path pads by 3.
    expect(items[1]!.bbox.x).toBeCloseTo(57);
    // The fill is its loops' bounds, unpadded.
    expect(items[2]!.bbox).toEqual({ x: 100, y: 10, width: 20, height: 20 });
  });

  it('aligns ink with the same indices', () => {
    const ink = elementInk(trace);
    expect(ink).toHaveLength(3);
    expect(ink[0]![0]).toHaveLength(2);
    expect(ink[2]![0]).toHaveLength(4);
  });
});
