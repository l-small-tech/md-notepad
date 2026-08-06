/**
 * The OCR representation: one-line raw XML that survives the round trip as a
 * fixed point, a metadata entry with deterministic key order, and the pure
 * patch that lands both on a scan layer — including the wholesale replacement
 * on a re-run and the null on a deleted layer (the async-arrival contract).
 */

import { describe, expect, it } from 'vitest';
import { parseWhiteboard } from '../../parse';
import { serializeWhiteboard } from '../../serialize';
import {
  applyScanOcr,
  attachRasterLines,
  isOcrRaw,
  linesFromLayout,
  ocrDescXml,
  ocrGroupXml,
  ocrMetaEntry,
  ocrPlainText,
  type OcrLine,
  type ScanOcrOutcome,
} from '../ocr';
import type { LayoutItem, TextLine } from '../text-layout';

const LINE_A: OcrLine = {
  text: 'ARCHITECTURE',
  confidence: 0.93,
  bbox: { x: 120, y: 52, width: 212, height: 34 },
  height: 34,
  items: [0, 1],
};
const LINE_B: OcrLine = {
  text: 'api gateway -> auth',
  confidence: null,
  bbox: { x: 118, y: 120, width: 300, height: 30 },
  height: 30,
  items: [2, 3, 4],
};
const EMPTY_LINE: OcrLine = {
  text: '',
  confidence: null,
  bbox: { x: 0, y: 300, width: 40, height: 20 },
  height: 20,
  items: [5],
};

const OK: ScanOcrOutcome = {
  status: 'ok',
  engine: 'test-engine',
  timestamp: '2026-08-06T00:00:00Z',
  lines: [LINE_A, LINE_B, EMPTY_LINE],
};

describe('text builders', () => {
  it('joins recognized lines, skipping unreadable ones', () => {
    expect(ocrPlainText([LINE_A, EMPTY_LINE, LINE_B])).toBe('ARCHITECTURE\napi gateway -> auth');
  });

  it('emits a one-line <desc> with escaped text and encoded newlines', () => {
    const desc = ocrDescXml([LINE_A, { ...LINE_B, text: 'a < b & c' }]);
    expect(desc).toBe('<desc>ARCHITECTURE&#10;a &lt; b &amp; c</desc>');
    expect(desc).not.toContain('\n');
  });

  it('emits positioned hidden text through the scene transform', () => {
    const group = ocrGroupXml([LINE_A], { scale: 0.5, dx: 10, dy: 20 });
    expect(group).toBe(
      '<g wb:ocr="text" opacity="0" font-family="sans-serif">' +
        '<text x="70" y="59.6" font-size="17" textLength="106"' +
        ' lengthAdjust="spacingAndGlyphs">ARCHITECTURE</text></g>',
    );
    expect(group).not.toContain('\n');
  });

  it('recognizes its own raw elements and nothing else', () => {
    expect(isOcrRaw({ kind: 'raw', xml: ocrDescXml([LINE_A]) })).toBe(true);
    expect(isOcrRaw({ kind: 'raw', xml: ocrGroupXml([LINE_A]) })).toBe(true);
    expect(isOcrRaw({ kind: 'raw', xml: '<polygon points="0,0"/>' })).toBe(false);
  });
});

describe('metadata entry', () => {
  it('records engine, timestamp, boxes in scene units, and stroke ids', () => {
    const entry = ocrMetaEntry(OK, { scale: 2, dx: 1, dy: 1 });
    expect(entry).toEqual({
      status: 'ok',
      engine: 'test-engine',
      timestamp: '2026-08-06T00:00:00Z',
      lines: [
        {
          text: 'ARCHITECTURE',
          confidence: 0.93,
          box: [241, 105, 424, 68],
          strokes: ['s1', 's2'],
        },
        {
          text: 'api gateway -> auth',
          confidence: null,
          box: [237, 241, 600, 60],
          strokes: ['s3', 's4', 's5'],
        },
      ],
    });
  });

  it('records unavailable and error outcomes without lines', () => {
    expect(ocrMetaEntry({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(ocrMetaEntry({ status: 'error', message: 'boom' })).toEqual({
      status: 'error',
      message: 'boom',
    });
  });
});

describe('engine glue', () => {
  it('zips ink answers with layout lines positionally', () => {
    const lines: TextLine[] = [
      { items: [0, 1], bbox: { x: 0, y: 0, width: 100, height: 30 }, height: 30 },
      { items: [2], bbox: { x: 0, y: 50, width: 60, height: 28 }, height: 28 },
    ];
    const out = linesFromLayout(lines, [
      { text: ' hello ', confidence: 0.8 },
      { text: '', confidence: null },
    ]);
    expect(out[0]).toMatchObject({ text: 'hello', confidence: 0.8, items: [0, 1] });
    expect(out[1]).toMatchObject({ text: '', items: [2] });
  });

  it('attaches items to raster lines by centre containment, in reading order', () => {
    const items: LayoutItem[] = [
      { index: 0, bbox: { x: 10, y: 100, width: 30, height: 30 } },
      { index: 1, bbox: { x: 50, y: 100, width: 30, height: 30 } },
      { index: 2, bbox: { x: 10, y: 10, width: 30, height: 30 } },
      { index: 3, bbox: { x: 500, y: 500, width: 10, height: 10 } },
    ];
    const out = attachRasterLines(
      [
        { text: 'below', confidence: 0.5, bbox: { x: 5, y: 95, width: 90, height: 40 } },
        { text: 'above', confidence: 0.9, bbox: { x: 5, y: 5, width: 40, height: 40 } },
        { text: '  ', confidence: null, bbox: { x: 0, y: 0, width: 5, height: 5 } },
      ],
      items,
    );
    expect(out.map((l) => l.text)).toEqual(['above', 'below']);
    expect(out[0]!.items).toEqual([2]);
    expect(out[1]!.items).toEqual([0, 1]);
  });
});

describe('applyScanOcr', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <g wb:layer="e5F6" wb:name="Scan 1" wb:kind="scan"><path wb:id="s1" wb:tool="pen" d="M1 1" stroke="#1f6fd0" stroke-width="4"/></g>
</svg>`;

  it('prepends desc + hidden group, records metadata, and stays a fixed point', () => {
    const doc = parseWhiteboard(source);
    const patched = applyScanOcr(doc, 'e5F6', OK);
    expect(patched).not.toBeNull();
    const layer = patched!.layers[0]!;
    expect(layer.elements).toHaveLength(3);
    expect(layer.elements[0]).toMatchObject({ kind: 'raw' });
    expect(layer.elements[1]).toMatchObject({ kind: 'raw' });
    expect(layer.elements[2]).toMatchObject({ kind: 'stroke', id: 's1' });
    expect((patched!.meta.ocr as Record<string, unknown>).e5F6).toMatchObject({
      status: 'ok',
      engine: 'test-engine',
    });

    const out = serializeWhiteboard(patched!);
    expect(out).toContain('<desc>ARCHITECTURE&#10;api gateway -&gt; auth</desc>');
    expect(out).toContain('wb:ocr="text"');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('replaces a previous result wholesale on a re-run', () => {
    const doc = parseWhiteboard(source);
    const once = applyScanOcr(doc, 'e5F6', OK)!;
    const again = applyScanOcr(once, 'e5F6', {
      ...OK,
      lines: [{ ...LINE_A, text: 'REVISED' }],
    })!;
    const layer = again.layers[0]!;
    expect(layer.elements).toHaveLength(3);
    const out = serializeWhiteboard(again);
    expect(out).toContain('<desc>REVISED</desc>');
    expect(out).not.toContain('ARCHITECTURE');
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('records unavailable as metadata only, no elements', () => {
    const doc = parseWhiteboard(source);
    const patched = applyScanOcr(doc, 'e5F6', { status: 'unavailable' })!;
    expect(patched.layers[0]!.elements).toHaveLength(1);
    expect((patched.meta.ocr as Record<string, unknown>).e5F6).toEqual({
      status: 'unavailable',
    });
    const out = serializeWhiteboard(patched);
    expect(serializeWhiteboard(parseWhiteboard(out))).toBe(out);
  });

  it('records an all-empty recognition as metadata only', () => {
    const doc = parseWhiteboard(source);
    const patched = applyScanOcr(doc, 'e5F6', { ...OK, lines: [EMPTY_LINE] })!;
    expect(patched.layers[0]!.elements).toHaveLength(1);
    expect((patched.meta.ocr as Record<string, unknown>).e5F6).toMatchObject({
      status: 'ok',
      lines: [],
    });
  });

  it('returns null when the layer is gone (async arrival after delete)', () => {
    const doc = parseWhiteboard(source);
    expect(applyScanOcr(doc, 'nope', OK)).toBeNull();
  });
});
