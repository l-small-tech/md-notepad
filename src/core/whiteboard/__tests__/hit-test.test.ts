/**
 * The eraser's aim. The failure modes worth guarding are both directions of
 * wrong: erasing something the user was nowhere near, and refusing to erase
 * something they clearly touched.
 */

import { describe, expect, it } from 'vitest';
import { elementBounds, hitTest, hitTestElement } from '../hit-test';
import { createLayer, createScene, type SceneElement } from '../scene';

function stroke(d: string, strokeWidth = 4): SceneElement {
  return {
    kind: 'stroke',
    id: null,
    tool: 'pen',
    d,
    stroke: '#1a1a1a',
    strokeWidth,
    opacity: null,
    widths: null,
  };
}

function rect(fill: string): SceneElement {
  return {
    kind: 'shape',
    id: null,
    shape: 'rect',
    geom: { x: 0, y: 0, width: 100, height: 50 },
    stroke: '#1a1a1a',
    strokeWidth: 2,
    fill,
    opacity: null,
  };
}

describe('hitTestElement — strokes', () => {
  const line = stroke('M0 0L100 0');

  it('hits along the ink, including its own half-width', () => {
    expect(hitTestElement(line, { x: 50, y: 0 }, 0)).toBe(true);
    // strokeWidth 4 → 2px of ink either side, plus a 1px nib.
    expect(hitTestElement(line, { x: 50, y: 2.9 }, 1)).toBe(true);
    expect(hitTestElement(line, { x: 50, y: 4 }, 1)).toBe(false);
  });

  it('misses past the end of the stroke', () => {
    expect(hitTestElement(line, { x: 130, y: 0 }, 4)).toBe(false);
  });

  it('follows a curve rather than its chord', () => {
    const curve = stroke('M0 0C0 60 100 60 100 0', 2);
    // The chord runs along y=0; the curve bellies down to about y=45.
    expect(hitTestElement(curve, { x: 50, y: 45 }, 3)).toBe(true);
    expect(hitTestElement(curve, { x: 50, y: 5 }, 3)).toBe(false);
  });

  it('treats each subpath separately', () => {
    const two = stroke('M0 0L10 0 M100 0L110 0', 2);
    expect(hitTestElement(two, { x: 105, y: 0 }, 1)).toBe(true);
    expect(hitTestElement(two, { x: 55, y: 0 }, 1)).toBe(false);
  });
});

describe('hitTestElement — shapes', () => {
  it('hits an UNFILLED rect only on its outline', () => {
    const outline = rect('none');
    expect(hitTestElement(outline, { x: 50, y: 0 }, 1)).toBe(true);
    expect(hitTestElement(outline, { x: 50, y: 25 }, 1)).toBe(false);
  });

  it('hits a FILLED rect anywhere inside it', () => {
    expect(hitTestElement(rect('#eeeeee'), { x: 50, y: 25 }, 1)).toBe(true);
  });

  it('hits an ellipse on its ring, not through its middle', () => {
    const ellipse: SceneElement = {
      kind: 'shape',
      id: null,
      shape: 'ellipse',
      geom: { cx: 100, cy: 100, rx: 50, ry: 25 },
      stroke: '#1a1a1a',
      strokeWidth: 2,
      fill: 'none',
      opacity: null,
    };
    expect(hitTestElement(ellipse, { x: 150, y: 100 }, 1)).toBe(true);
    expect(hitTestElement(ellipse, { x: 100, y: 100 }, 1)).toBe(false);
  });

  it('hits a line along its length', () => {
    const line: SceneElement = {
      kind: 'shape',
      id: null,
      shape: 'arrow',
      geom: { x1: 0, y1: 0, x2: 100, y2: 100 },
      stroke: '#1a1a1a',
      strokeWidth: 2,
      fill: 'none',
      opacity: null,
    };
    expect(hitTestElement(line, { x: 50, y: 50 }, 1)).toBe(true);
    expect(hitTestElement(line, { x: 50, y: 60 }, 1)).toBe(false);
  });
});

describe('hitTestElement — raw content', () => {
  it('never hits: unmodeled content belongs to whoever authored it', () => {
    const raw: SceneElement = { kind: 'raw', xml: '<circle cx="0" cy="0" r="100"/>' };
    expect(hitTestElement(raw, { x: 0, y: 0 }, 100)).toBe(false);
    expect(elementBounds(raw)).toBeNull();
  });
});

describe('elementBounds', () => {
  it('includes the stroke half-width', () => {
    expect(elementBounds(stroke('M0 0L10 0', 4))).toEqual({
      x: -2,
      y: -2,
      width: 14,
      height: 4,
    });
  });

  it('estimates text from its font size and longest line', () => {
    const bounds = elementBounds({
      kind: 'text',
      id: null,
      fontFamily: null,
      boxWidth: null,
      x: 10,
      y: 100,
      fontSize: 20,
      fill: '#000',
      lines: ['hello', 'a longer line'],
    });
    expect(bounds!.x).toBe(10);
    expect(bounds!.y).toBe(80); // the baseline sits one font-size down
    expect(bounds!.width).toBeGreaterThan(100);
    expect(bounds!.height).toBeCloseTo(48);
  });
});

describe('hitTest over a document', () => {
  const doc = createScene({
    layers: [
      createLayer({ id: 'low', elements: [stroke('M0 0L100 0')] }),
      createLayer({ id: 'high', elements: [stroke('M0 0L100 0')] }),
      createLayer({ id: 'hidden', visible: false, elements: [stroke('M0 0L100 0')] }),
      createLayer({ id: 'locked', locked: true, elements: [stroke('M0 0L100 0')] }),
      createLayer({
        id: 'imported',
        kind: 'foreign',
        locked: true,
        elements: [stroke('M0 0L100 0')],
      }),
    ],
  });

  it('reports every hit on an editable layer, topmost first', () => {
    const hits = hitTest(doc, { x: 50, y: 0 }, 2);
    expect(hits.map((h) => h.layerId)).toEqual(['high', 'low']);
  });

  it('skips hidden, locked and imported layers entirely', () => {
    const hits = hitTest(doc, { x: 50, y: 0 }, 2);
    expect(hits.some((h) => ['hidden', 'locked', 'imported'].includes(h.layerId))).toBe(false);
  });

  it('reports nothing on empty board space', () => {
    expect(hitTest(doc, { x: 500, y: 500 }, 2)).toEqual([]);
  });
});
