/**
 * Infinite boards: content bounds and the content-fitted viewBox.
 *
 * A board with `background: null` has no page — the serializer refits its
 * viewBox to the drawn content (+ margin) on every save. The property that
 * matters most here is IDEMPOTENCE: parse → serialize must be a fixed point,
 * which is why every case below re-serializes its own output.
 */

import { describe, expect, it } from 'vitest';
import { CONTENT_MARGIN, contentViewBox, elementBounds } from '../bounds';
import { setBackground } from '../layers';
import { parseWhiteboard } from '../parse';
import { createLayer, createScene, type SceneElement } from '../scene';
import { serializeWhiteboard } from '../serialize';

const RECT: SceneElement = {
  kind: 'shape',
  id: null,
  shape: 'rect',
  geom: { x: 500, y: 400, width: 100, height: 50 },
  stroke: '#1a1a1a',
  strokeWidth: 2,
  fill: 'none',
  opacity: null,
};

function infiniteBoard(
  elements: SceneElement[],
  extra: Partial<Parameters<typeof createScene>[0]> = {},
) {
  return createScene({ layers: [createLayer({ id: 'aaaa', elements })], ...extra });
}

describe('elementBounds', () => {
  it('covers a shape including half its stroke width', () => {
    expect(elementBounds(RECT)).toEqual({ x: 499, y: 399, width: 102, height: 52 });
  });

  it('covers a stroke from its flattened path', () => {
    const bounds = elementBounds({
      kind: 'stroke',
      id: null,
      tool: 'pen',
      d: 'M10,20 L110,220',
      stroke: '#1a1a1a',
      strokeWidth: 4,
      opacity: null,
      widths: null,
    })!;
    expect(bounds.x).toBe(8);
    expect(bounds.y).toBe(18);
    expect(bounds.width).toBe(104);
    expect(bounds.height).toBe(204);
  });

  it('returns null for raw content — geometry unknowable without a DOM', () => {
    expect(elementBounds({ kind: 'raw', xml: '<polygon points="0,0 900,900"/>' })).toBeNull();
  });
});

describe('contentViewBox', () => {
  it('fits the content plus the margin, rounded to whole units', () => {
    const [x, y, w, h] = contentViewBox(infiniteBoard([RECT]));
    expect([x, y]).toEqual([499 - CONTENT_MARGIN, 399 - CONTENT_MARGIN]);
    expect([w, h]).toEqual([102 + CONTENT_MARGIN * 2, 52 + CONTENT_MARGIN * 2]);
  });

  it('falls back to the default board when there is nothing to measure', () => {
    expect(contentViewBox(createScene())).toEqual([0, 0, 1600, 1000]);
  });

  it('unions in the stored viewBox when unmeasurable raw content exists', () => {
    const doc = infiniteBoard([RECT, { kind: 'raw', xml: '<polygon points="0,0 1,1"/>' }], {
      viewBox: [0, 0, 3000, 2000],
    });
    // The raw element could be anywhere the last save covered — keep it all.
    expect(contentViewBox(doc)).toEqual([0, 0, 3000, 2000]);
  });
});

describe('infinite boards through the serializer', () => {
  it('saves a content-fitted viewBox and matching width/height', () => {
    const out = serializeWhiteboard(infiniteBoard([RECT]));
    expect(out).toContain('viewBox="451 351 198 148"');
    expect(out).toContain('width="198" height="148"');
    expect(out).not.toContain('wb:role="background"');
  });

  it('is idempotent — the refit reaches a fixed point immediately', () => {
    const first = serializeWhiteboard(infiniteBoard([RECT]));
    const second = serializeWhiteboard(parseWhiteboard(first));
    expect(second).toBe(first);
  });

  it('leaves a page board’s viewBox exactly alone', () => {
    const paged = setBackground(infiniteBoard([RECT]), '#ffffff');
    const out = serializeWhiteboard(paged);
    expect(out).toContain('viewBox="0 0 1600 1000"');
    expect(out).toContain('<rect wb:role="background" class="wb-bg"');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('setBackground(null) turns a page board infinite and back', () => {
    const doc = createScene({ background: '#ffffff' });
    expect(setBackground(doc, null).background).toBeNull();
    expect(setBackground(doc, '#ffffff')).toBe(doc); // no-op keeps identity
  });
});
