/**
 * The `wb:tool="scanfill"` element — phase 6's contour fallback. It must
 * round-trip as a first-class stroke (colour in `fill`, painted evenodd),
 * hit-test anywhere inside its area (holes excepted), and never gain a
 * palette-slot class (the palette block's stroke rule would outline it).
 */

import { describe, expect, it } from 'vitest';
import { parseWhiteboard } from '../parse';
import { serializeElement, serializeWhiteboard } from '../serialize';
import { createLayer, createScene, type StrokeElement } from '../scene';
import { hitTestElement } from '../hit-test';

const DONUT: StrokeElement = {
  kind: 'stroke',
  id: null,
  tool: 'scanfill',
  d: 'M10 10L90 10L90 90L10 90ZM40 40L60 40L60 60L40 60Z',
  stroke: '#1a1a1a',
  strokeWidth: 0,
  opacity: null,
  widths: null,
};

function boardWith(element: StrokeElement): string {
  return serializeWhiteboard(
    createScene({
      layers: [createLayer({ id: 'a1B2', name: 'Scan 1', kind: 'scan', elements: [element] })],
    }),
  );
}

describe('scanfill serialization', () => {
  it('paints with fill, not stroke, and takes no slot class', () => {
    const markup = serializeElement(DONUT);
    expect(markup).toContain('wb:tool="scanfill"');
    expect(markup).toContain('fill="#1a1a1a"');
    expect(markup).toContain('fill-rule="evenodd"');
    expect(markup).toContain('stroke="none"');
    expect(markup).not.toContain('class=');
    expect(markup).not.toContain('stroke-width');
  });

  it('round-trips as a fixed point with its colour intact', () => {
    const first = boardWith(DONUT);
    const doc = parseWhiteboard(first);
    const back = doc.layers[0]!.elements[0]!;
    expect(back).toEqual(DONUT);
    expect(serializeWhiteboard(doc)).toBe(first);
  });

  it('keeps its wb:id inside a scan layer', () => {
    const withId = { ...DONUT, id: 's7' };
    const doc = parseWhiteboard(boardWith(withId));
    expect(doc.layers[0]!.elements[0]).toEqual(withId);
  });
});

describe('scanfill hit-testing', () => {
  it('hits anywhere in the filled area', () => {
    expect(hitTestElement(DONUT, { x: 20, y: 20 }, 0)).toBe(true);
  });

  it('misses the hole (evenodd)', () => {
    expect(hitTestElement(DONUT, { x: 50, y: 50 }, 0)).toBe(false);
  });

  it('misses well outside', () => {
    expect(hitTestElement(DONUT, { x: 200, y: 200 }, 0)).toBe(false);
  });
});
