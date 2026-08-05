/**
 * The format contract: parse → serialize → parse.
 *
 * Two different promises are tested here and they must not be confused:
 *
 * - **Byte-identity on an untouched file** is NOT this file's job — it belongs
 *   to the adapter's write-back guard (serialize only after a real edit), the
 *   same contract Milkdown has. What IS tested here is that serializing our own
 *   output is a fixed point, and that nothing is ever dropped.
 * - **Nothing dropped**: foreign SVGs (Inkscape, hand-authored) keep every
 *   element, attribute and comment through a full round trip.
 */

import { describe, expect, it } from 'vitest';
import { parseWhiteboard, WhiteboardParseError } from '../parse';
import {
  createLayer,
  createScene,
  DEFAULT_BOARD_HEIGHT,
  DEFAULT_BOARD_WIDTH,
  elementCount,
  type SceneDoc,
} from '../scene';
import { ARROW_MARKER_ID, num, serializeWhiteboard } from '../serialize';

/** parse → serialize → parse; the second serialization must equal the first. */
function stabilize(source: string): { first: string; second: string; doc: SceneDoc } {
  const doc = parseWhiteboard(source);
  const first = serializeWhiteboard(doc);
  const second = serializeWhiteboard(parseWhiteboard(first));
  return { first, second, doc };
}

const BOARD = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-notepad:whiteboard" viewBox="0 0 1600 1000" width="1600" height="1000">
  <metadata><wb:doc>{"schema":1,"background":"#ffffff","view":{"scale":1.5}}</wb:doc></metadata>
  <rect wb:role="background" x="0" y="0" width="1600" height="1000" fill="#ffffff"/>
  <g wb:layer="a1B2" wb:name="Layer 1">
    <path wb:tool="pen" d="M10,10 C20,20 30,30 40,40" fill="none" stroke="#1f6fd0" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="100" y="120" width="80" height="40" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="300" cy="200" rx="50" ry="25" fill="#eeeeee" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/>
    <line x1="0" y1="0" x2="10" y2="10" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round" marker-end="url(#wb-arrow)"/>
    <text x="40" y="400" font-size="24" fill="#1a1a1a"><tspan x="40" dy="0">hello</tspan><tspan x="40" dy="1.2em">world</tspan></text>
  </g>
  <g wb:layer="c3D4" wb:name="Photo" wb:locked="true" display="none">
    <image x="0" y="0" width="100" height="100" href="data:image/png;base64,AAAA"/>
  </g>
</svg>
`;

describe('a whiteboard we wrote', () => {
  it('is a fixed point of serialization', () => {
    const { first, second } = stabilize(BOARD);
    expect(second).toBe(first);
  });

  it('reads back every element with its geometry and style', () => {
    const doc = parseWhiteboard(BOARD);
    expect(doc.width).toBe(1600);
    expect(doc.viewBox).toEqual([0, 0, 1600, 1000]);
    expect(doc.background).toBe('#ffffff');
    expect(doc.layers.map((l) => l.id)).toEqual(['a1B2', 'c3D4']);
    expect(elementCount(doc)).toBe(6);

    const [ink, photo] = doc.layers;
    expect(ink!.name).toBe('Layer 1');
    expect(ink!.visible).toBe(true);
    expect(ink!.locked).toBe(false);
    expect(photo!.visible).toBe(false);
    expect(photo!.locked).toBe(true);

    const stroke = ink!.elements[0]!;
    expect(stroke).toMatchObject({
      kind: 'stroke',
      tool: 'pen',
      stroke: '#1f6fd0',
      strokeWidth: 4.2,
      d: 'M10,10 C20,20 30,30 40,40',
    });
    expect(ink!.elements[1]).toMatchObject({
      kind: 'shape',
      shape: 'rect',
      geom: { x: 100, y: 120, width: 80, height: 40 },
    });
    expect(ink!.elements[2]).toMatchObject({ kind: 'shape', shape: 'ellipse', fill: '#eeeeee' });
    // marker-end is what distinguishes an arrow from a plain line.
    expect(ink!.elements[3]).toMatchObject({ kind: 'shape', shape: 'arrow' });
    expect(ink!.elements[4]).toMatchObject({ kind: 'text', lines: ['hello', 'world'] });
    expect(photo!.elements[0]).toMatchObject({
      kind: 'image',
      href: 'data:image/png;base64,AAAA',
    });
  });

  it('preserves unknown metadata keys but regenerates schema and background', () => {
    const { first, doc } = stabilize(BOARD);
    expect(doc.meta).toEqual({ view: { scale: 1.5 } });
    expect(first).toContain('{"schema":1,"background":"#ffffff","view":{"scale":1.5}}');
  });

  it('does not emit a second arrow marker when the file already carries one', () => {
    const withDefs = BOARD.replace(
      '<g wb:layer="a1B2"',
      `<defs><marker id="${ARROW_MARKER_ID}"/></defs>\n  <g wb:layer="a1B2"`,
    );
    const out = serializeWhiteboard(parseWhiteboard(withDefs));
    expect(out.match(new RegExp(`id="${ARROW_MARKER_ID}"`, 'g'))).toHaveLength(1);
  });

  it('emits the arrow marker when an arrow exists and the file has no defs', () => {
    const out = serializeWhiteboard(parseWhiteboard(BOARD));
    expect(out).toContain(`<marker id="${ARROW_MARKER_ID}"`);
  });
});

describe('foreign SVGs', () => {
  // Shaped after a real Inkscape save: xml declaration, comment, its own
  // namespaces on the root, a namedview element and a transformed group.
  const INKSCAPE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg5" inkscape:version="1.1">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="0.7"/>
  <defs id="defs2"><linearGradient id="grad"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" transform="translate(3,4)">
    <path style="fill:#ff0000" d="M 10,10 20,20 Z" id="path846"/>
  </g>
</svg>
`;

  it('opens as one locked "Imported" layer instead of failing', () => {
    const doc = parseWhiteboard(INKSCAPE);
    expect(doc.layers).toHaveLength(1);
    const imported = doc.layers[0]!;
    expect(imported.kind).toBe('foreign');
    expect(imported.locked).toBe(true);
    expect(imported.name).toBe('Imported');
    // The namedview and the drawing group both landed there, in order.
    expect(imported.elements).toHaveLength(2);
  });

  it('keeps every foreign element, attribute and comment through a round trip', () => {
    const { first, second } = stabilize(INKSCAPE);
    expect(second).toBe(first);
    // Verbatim body, including the transform we deliberately never bake.
    expect(first).toContain('transform="translate(3,4)"');
    expect(first).toContain('<path style="fill:#ff0000" d="M 10,10 20,20 Z" id="path846"/>');
    expect(first).toContain('<sodipodi:namedview id="namedview7"');
    // Non-layer top-level content is prelude, not a layer.
    expect(first).toContain('<linearGradient id="grad">');
    // Foreign root attributes (namespaces, version, id) survive.
    expect(first).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(first).toContain('id="svg5"');
    expect(first).toContain('version="1.1"');
  });

  it('takes the board size from the viewBox when width/height carry units', () => {
    const doc = parseWhiteboard(INKSCAPE);
    // '210mm' parses to 210, which matches the viewBox — the units are dropped
    // deliberately: scene coordinates are unitless user units.
    expect(doc.width).toBe(210);
    expect(doc.viewBox).toEqual([0, 0, 210, 297]);
  });

  it('keeps foreign content in z-order relative to our own layers', () => {
    const mixed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <g wb:layer="aaaa" wb:name="Under"/>
  <circle cx="1" cy="1" r="1"/>
  <g wb:layer="bbbb" wb:name="Over"/>
</svg>`;
    const doc = parseWhiteboard(mixed);
    expect(doc.layers.map((l) => l.id)).toEqual(['aaaa', 'imported', 'bbbb']);
  });

  it('normalizes a circle to an ellipse inside one of OUR layers', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><circle cx="1" cy="2" r="3" stroke="#000"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toMatchObject({
      kind: 'shape',
      shape: 'ellipse',
      geom: { cx: 1, cy: 2, rx: 3, ry: 3 },
    });
  });

  it('preserves an unmodeled element inside our own layer verbatim', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g wb:layer="aaaa" wb:name="L"><polygon points="0,0 1,1"/></g></svg>`,
    );
    expect(doc.layers[0]!.elements[0]).toEqual({
      kind: 'raw',
      xml: '<polygon points="0,0 1,1"/>',
    });
    expect(serializeWhiteboard(doc)).toContain('<polygon points="0,0 1,1"/>');
  });

  it("preserves a scan layer's hidden OCR group and its wb:kind", () => {
    const scan = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <g wb:layer="e5F6" wb:name="Scan 1" wb:kind="scan"><desc>ARCHITECTURE</desc><g wb:ocr="text" opacity="0"><text x="1" y="2">ARCHITECTURE</text></g><path wb:id="s1" wb:tool="pen" d="M1 1" stroke="#1f6fd0" stroke-width="4"/></g>
</svg>`;
    const doc = parseWhiteboard(scan);
    const layer = doc.layers[0]!;
    expect(layer.kind).toBe('scan');
    expect(layer.elements[1]).toMatchObject({ kind: 'raw' });
    expect(layer.elements[2]).toMatchObject({ kind: 'stroke', id: 's1' });
    const out = serializeWhiteboard(doc);
    expect(out).toContain('wb:kind="scan"');
    expect(out).toContain('<g wb:ocr="text" opacity="0"><text x="1" y="2">ARCHITECTURE</text></g>');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });
});

describe('degenerate input', () => {
  it('throws WhiteboardParseError on malformed XML', () => {
    expect(() => parseWhiteboard('<svg><g></svg>')).toThrow(WhiteboardParseError);
    expect(() => parseWhiteboard('')).toThrow(WhiteboardParseError);
  });

  it('throws when the root is not <svg>', () => {
    expect(() => parseWhiteboard('<html/>')).toThrow(/expected <svg>/);
  });

  it('survives corrupt editor metadata — the strokes are in the SVG body', () => {
    const doc = parseWhiteboard(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><metadata><wb:doc>{not json</wb:doc></metadata><g wb:layer="aaaa" wb:name="L"><path wb:tool="pen" d="M1 1" stroke="#000" stroke-width="2"/></g></svg>`,
    );
    expect(doc.meta).toEqual({});
    expect(elementCount(doc)).toBe(1);
  });

  it('falls back to a default board when the viewBox is missing or degenerate', () => {
    const doc = parseWhiteboard('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(doc.viewBox).toEqual([0, 0, DEFAULT_BOARD_WIDTH, DEFAULT_BOARD_HEIGHT]);
    // No background rect and no metadata background = an infinite board.
    expect(doc.background).toBeNull();
  });

  it('escapes text and attribute content that would otherwise break the file', () => {
    const doc = createScene({
      layers: [
        createLayer({
          id: 'aaaa',
          name: 'a & b <c>',
          elements: [
            {
              kind: 'text',
              id: null,
              fontFamily: null,
              boxWidth: null,
              x: 0,
              y: 0,
              fontSize: 12,
              fill: '#000',
              lines: ['x < y & z'],
            },
          ],
        }),
      ],
    });
    const out = serializeWhiteboard(doc);
    // '>' needs no escaping inside an attribute value; '&' and '<' do.
    expect(out).toContain('wb:name="a &amp; b &lt;c>"');
    expect(out).toContain('x &lt; y &amp; z');
    const back = parseWhiteboard(out);
    expect(back.layers[0]!.name).toBe('a & b <c>');
    expect(back.layers[0]!.elements[0]).toMatchObject({ lines: ['x < y & z'] });
  });
});

describe('num', () => {
  it('rounds to two decimals and normalizes -0', () => {
    expect(num(1.23456)).toBe('1.23');
    expect(num(2)).toBe('2');
    expect(num(-0.001)).toBe('0');
    expect(num(Number.NaN)).toBe('0');
  });
});

describe('createScene', () => {
  it('produces a blank board that round-trips', () => {
    const source = serializeWhiteboard(createScene());
    expect(serializeWhiteboard(parseWhiteboard(source))).toBe(source);
    expect(parseWhiteboard(source).layers).toHaveLength(1);
  });
});
