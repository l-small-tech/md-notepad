/**
 * The tool constructors, and the property that ties phase 2 to the format: an
 * element a tool produces must survive serialize → parse unchanged, so what the
 * pen draws is exactly what the file holds and what a browser renders.
 */

import { describe, expect, it } from 'vitest';
import { makeShape, makeStroke, isShapeTool, PALETTE, STROKE_WIDTHS } from '../tools';
import { parseWhiteboard } from '../parse';
import { ARROW_MARKER_ID, serializeWhiteboard } from '../serialize';
import { createLayer, createScene, type SceneElement } from '../scene';
import { addElement } from '../layers';

const P = (x: number, y: number) => ({ x, y });

describe('tool vocabulary', () => {
  it('classifies shape tools', () => {
    expect(isShapeTool('rect')).toBe(true);
    expect(isShapeTool('arrow')).toBe(true);
    expect(isShapeTool('pen')).toBe(false);
    expect(isShapeTool('eraser')).toBe(false);
  });

  it('offers eight colours and four nib sizes', () => {
    expect(PALETTE).toHaveLength(8);
    expect(new Set(PALETTE).size).toBe(8);
    expect(STROKE_WIDTHS.every((w) => w > 0)).toBe(true);
  });
});

describe('makeStroke', () => {
  it('builds a pen stroke with no id and no opacity', () => {
    const stroke = makeStroke('pen', [P(0, 0), P(10, 0), P(20, 0)], '#1f6fd0', 3)!;
    expect(stroke.kind).toBe('stroke');
    expect(stroke.tool).toBe('pen');
    expect(stroke.id).toBeNull();
    expect(stroke.opacity).toBeNull();
    expect(stroke.strokeWidth).toBe(3);
    expect(stroke.d.startsWith('M')).toBe(true);
  });

  it('makes the highlighter fat and translucent from the same nib size', () => {
    const highlighter = makeStroke('highlighter', [P(0, 0), P(30, 0)], '#c9a400', 3)!;
    expect(highlighter.strokeWidth).toBeGreaterThan(3);
    expect(highlighter.opacity).toBeLessThan(1);
  });

  it('still produces a mark for a single tap', () => {
    expect(makeStroke('pen', [P(5, 5)], '#1a1a1a', 3)!.d).toBe('M5 5L5 5');
  });

  it('is null with nothing to draw', () => {
    expect(makeStroke('pen', [], '#1a1a1a', 3)).toBeNull();
  });
});

describe('makeShape', () => {
  it('normalizes a rect dragged up-and-left', () => {
    const shape = makeShape('rect', P(100, 100), P(40, 60), '#1a1a1a', 2)!;
    expect(shape.geom).toEqual({ x: 40, y: 60, width: 60, height: 40 });
    expect(shape.fill).toBe('none');
  });

  it('centres an ellipse in the dragged box', () => {
    const shape = makeShape('ellipse', P(0, 0), P(100, 50), '#1a1a1a', 2)!;
    expect(shape.geom).toEqual({ cx: 50, cy: 25, rx: 50, ry: 25 });
  });

  it('keeps a line/arrow as its two endpoints, undirected drag included', () => {
    const arrow = makeShape('arrow', P(10, 10), P(0, 0), '#1a1a1a', 2)!;
    expect(arrow.shape).toBe('arrow');
    expect(arrow.geom).toEqual({ x1: 10, y1: 10, x2: 0, y2: 0 });
  });

  it('refuses a degenerate gesture, so a stray click leaves nothing behind', () => {
    expect(makeShape('rect', P(10, 10), P(11, 11), '#1a1a1a', 2)).toBeNull();
    expect(makeShape('line', P(10, 10), P(11, 10), '#1a1a1a', 2)).toBeNull();
  });
});

describe('what the tools produce round-trips through the format', () => {
  function board(element: SceneElement): string {
    return serializeWhiteboard(
      addElement(createScene({ layers: [createLayer({ id: 'a1B2' })] }), 'a1B2', element),
    );
  }

  it('a pen stroke survives serialize → parse byte-for-byte', () => {
    const stroke = makeStroke('pen', [P(0, 0), P(10, 20), P(30, 5)], '#8a3fd1', 6)!;
    const source = board(stroke);
    expect(parseWhiteboard(source).layers[0]!.elements[0]).toEqual(stroke);
    expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
  });

  it('every shape survives, and an arrow brings its marker with it', () => {
    for (const kind of ['rect', 'ellipse', 'line', 'arrow'] as const) {
      const shape = makeShape(kind, P(0, 0), P(100, 60), '#1f9d55', 2)!;
      const source = board(shape);
      expect(parseWhiteboard(source).layers[0]!.elements[0]).toEqual(shape);
      expect(source.includes(ARROW_MARKER_ID)).toBe(kind === 'arrow');
    }
  });

  it('a highlighter keeps its opacity through the round trip', () => {
    const highlighter = makeStroke('highlighter', [P(0, 0), P(50, 0)], '#c9a400', 3)!;
    const parsed = parseWhiteboard(board(highlighter)).layers[0]!.elements[0];
    expect(parsed).toEqual(highlighter);
  });
});
