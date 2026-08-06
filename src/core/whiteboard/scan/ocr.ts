/**
 * S6 — OCR as a PORT. Handwriting recognition in dependency-free TS is not a
 * thing, and this module does not pretend otherwise: engines live behind
 * platform bridges (Android ML Kit, Windows.Media.Ocr), and what is fixed HERE
 * is the representation — so the SVG a consumer reads is identical whether the
 * text came from an ink model, a raster model, or a future cloud engine.
 *
 * The output shape (spec'd in whiteboard-plan.md, golden-tested in
 * roundtrip.test.ts) rides entirely on existing format machinery:
 *
 * - a `<desc>` as the layer's first child — full plain text in reading order,
 *   the first thing any consumer (screen reader, grep, an LLM handed the raw
 *   file) sees, zero custom parsing;
 * - a `<g wb:ocr="text" opacity="0">` of positioned `<text>` lines — the
 *   PDF-scanner trick: renders nothing, stays selectable/copyable in a
 *   browser, and preserves WHICH label sits on WHICH box;
 * - structured detail (per-line confidence, boxes, engine, timestamp, the
 *   `wb:id`s each line came from) in the `wb:doc` metadata under
 *   `ocr[layerId]`. Confidence is not optional in the schema — a consumer
 *   must be able to tell 0.95 from 0.4 — but an engine that does not report
 *   one (Windows) records `null` rather than inventing a number.
 *
 * Both the `<desc>` and the group are emitted as ONE-LINE RawElements: the
 * serializer re-emits raw XML verbatim, so determinism and the round-trip
 * fixed point are this module's responsibility — every interpolated string is
 * escaped here, and re-running OCR replaces the pair wholesale.
 */

import type { Rect } from '../geometry';
import type { RawElement, SceneDoc, SceneElement } from '../scene';
import { num } from '../serialize';
import { escapeText } from '../xml';
import type { LayoutItem, TextLine } from './text-layout';
import type { ScanTransform } from './trace';
import { IDENTITY_TRANSFORM } from './trace';

/** One recognized text line, in rectified-image pixel space. */
export interface OcrLine {
  readonly text: string;
  /** Engine-reported, 0–1; null when the engine reports none (Windows). */
  readonly confidence: number | null;
  /** The ink's bounding box, rectified px. */
  readonly bbox: Rect;
  /** The type-size estimate (median item height, or the engine's line box). */
  readonly height: number;
  /** Element indices (build order) the line was read from — becomes `wb:id`s. */
  readonly items: readonly number[];
}

export type ScanOcrOutcome =
  | {
      readonly status: 'ok';
      /** e.g. 'mlkit-ink', 'mlkit-text', 'windows-ocr'. */
      readonly engine: string;
      /** ISO 8601, injected by the caller — nothing here reads the clock. */
      readonly timestamp: string;
      readonly lines: readonly OcrLine[];
    }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string };

/* ------------------------------ the port itself ---------------------------
 * The recognizer is INJECTED into the scan panel (the engines are platform
 * bridges — ML Kit behind Android IPC, Windows.Media.Ocr behind a Tauri
 * command — and platform dispatch lives in `src/ui/scan-ocr.ts`, above the
 * editor layer). Core owns only the request/response SHAPES, so the panel,
 * the driver and the tests all speak one language. */

/** One text line's ink, ready for a stroke-based engine (ML Kit Digital Ink):
 *  every traced polyline of the line's elements, in rectified pixels. */
export interface ScanInkLine {
  readonly strokes: readonly (readonly (readonly [number, number])[])[];
  /** The writing-area hint — the line's own box. */
  readonly area: { readonly width: number; readonly height: number };
}

export interface ScanRecognizeRequest {
  /** Text lines in reading order (the layout gate's output). */
  readonly lines: readonly ScanInkLine[];
  /** Lazy black-on-white PNG (base64, no `data:` prefix) of the cleaned
   *  board, for raster engines. Null when encoding failed. */
  readonly png: () => Promise<string | null>;
}

export type ScanRecognizeResponse =
  | {
      readonly kind: 'ink';
      readonly engine: string;
      /** One answer per submitted line, positionally. */
      readonly texts: readonly { readonly text: string; readonly confidence: number | null }[];
    }
  | {
      readonly kind: 'raster';
      readonly engine: string;
      readonly lines: readonly RasterEngineLine[];
    }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string };

export type ScanRecognizeFn = (request: ScanRecognizeRequest) => Promise<ScanRecognizeResponse>;

/** What a raster engine hands back, in the pixel space of the image it read. */
export interface RasterEngineLine {
  readonly text: string;
  readonly confidence: number | null;
  readonly bbox: Rect;
}

/**
 * Ink path: the layout's lines were submitted one ink per line in reading
 * order, so the engine's answers zip with them positionally. A line the
 * engine could not read (empty string) is kept — the metadata records the
 * miss — but contributes nothing to the `<desc>` or the hidden group.
 */
export function linesFromLayout(
  lines: readonly TextLine[],
  texts: readonly { readonly text: string; readonly confidence: number | null }[],
): OcrLine[] {
  return lines.map((line, i) => ({
    text: texts[i]?.text.trim() ?? '',
    confidence: texts[i]?.confidence ?? null,
    bbox: line.bbox,
    height: line.height,
    items: line.items,
  }));
}

/**
 * Raster path: the engine read the cleaned image, so its line boxes are
 * already in rectified pixels — each layout item joins the line whose box
 * contains its centre (grown by a third of the line height, since engine
 * boxes hug the glyphs tighter than the ink's true extent). Lines come back
 * in reading order regardless of the engine's own ordering.
 */
export function attachRasterLines(
  engineLines: readonly RasterEngineLine[],
  items: readonly LayoutItem[],
): OcrLine[] {
  const lines = engineLines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => ({
      text: line.text.trim(),
      confidence: line.confidence,
      bbox: line.bbox,
      height: line.bbox.height,
      items: [] as number[],
    }));
  for (const item of items) {
    const cx = item.bbox.x + item.bbox.width / 2;
    const cy = item.bbox.y + item.bbox.height / 2;
    for (const line of lines) {
      const grow = line.bbox.height / 3;
      if (
        cx >= line.bbox.x - grow &&
        cx <= line.bbox.x + line.bbox.width + grow &&
        cy >= line.bbox.y - grow &&
        cy <= line.bbox.y + line.bbox.height + grow
      ) {
        line.items.push(item.index);
        break;
      }
    }
  }
  lines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  return lines;
}

/** The recognized text as plain lines, reading order — the Copy button. */
export function ocrPlainText(lines: readonly OcrLine[]): string {
  return lines
    .map((line) => line.text)
    .filter((text) => text.length > 0)
    .join('\n');
}

/** Escape text for a ONE-LINE raw element: XML entities, then literal
 *  newlines as character references so the line stays a line. */
function inlineText(value: string): string {
  return escapeText(value).replace(/\r?\n/g, '&#10;');
}

/** `<desc>` XML — full recognized text, newline-separated, one source line. */
export function ocrDescXml(lines: readonly OcrLine[]): string {
  return `<desc>${inlineText(ocrPlainText(lines))}</desc>`;
}

/**
 * The hidden positioned-text group, mapped into scene coordinates with the
 * same similarity transform the inserted strokes used. `opacity="0"` renders
 * nothing anywhere while staying selectable; `textLength`/`lengthAdjust` pin
 * each glyph run to the exact width of the ink it came from; the baseline
 * sits at 80% of the ink's box (descenders live below it).
 */
export function ocrGroupXml(
  lines: readonly OcrLine[],
  transform: ScanTransform = IDENTITY_TRANSFORM,
): string {
  const { scale, dx, dy } = transform;
  const texts = lines
    .filter((line) => line.text.length > 0)
    .map((line) => {
      const x = num(line.bbox.x * scale + dx);
      const y = num((line.bbox.y + line.bbox.height * 0.8) * scale + dy);
      const size = num(Math.max(1, line.height) * scale);
      const length = num(Math.max(1, line.bbox.width) * scale);
      return (
        `<text x="${x}" y="${y}" font-size="${size}" textLength="${length}"` +
        ` lengthAdjust="spacingAndGlyphs">${inlineText(line.text)}</text>`
      );
    })
    .join('');
  return `<g wb:ocr="text" opacity="0" font-family="sans-serif">${texts}</g>`;
}

/** True for the two RawElements this module owns (and regenerates wholesale). */
export function isOcrRaw(element: SceneElement): boolean {
  return (
    element.kind === 'raw' &&
    (element.xml.startsWith('<desc>') || element.xml.startsWith('<g wb:ocr='))
  );
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The `ocr[layerId]` metadata entry. Key INSERTION order is deterministic on
 * purpose — nested JSON is emitted in insertion order and the serializer's
 * fixed point depends on it.
 */
export function ocrMetaEntry(
  outcome: ScanOcrOutcome,
  transform: ScanTransform = IDENTITY_TRANSFORM,
): Record<string, unknown> {
  if (outcome.status !== 'ok') {
    return outcome.status === 'error'
      ? { status: 'error', message: outcome.message }
      : { status: 'unavailable' };
  }
  const { scale, dx, dy } = transform;
  return {
    status: 'ok',
    engine: outcome.engine,
    timestamp: outcome.timestamp,
    lines: outcome.lines
      .filter((line) => line.text.length > 0)
      .map((line) => ({
        text: line.text,
        confidence: line.confidence === null ? null : round2(line.confidence),
        box: [
          round2(line.bbox.x * scale + dx),
          round2(line.bbox.y * scale + dy),
          round2(line.bbox.width * scale),
          round2(line.bbox.height * scale),
        ],
        strokes: line.items.map((index) => `s${index + 1}`),
      })),
  };
}

/**
 * Patch a scan layer with a recognition outcome — pure `(doc, …) → doc`.
 *
 * Any previous OCR pair on the layer is removed and the metadata entry
 * replaced (re-running OCR regenerates wholesale, never merges). A successful
 * outcome with recognized text prepends the `<desc>` + hidden group as the
 * layer's first two children; an empty, unavailable or failed outcome records
 * only metadata, so a consumer can tell "no text found" from "never ran".
 * Returns null when the layer no longer exists — the caller (an ASYNC patch
 * by design) must treat that as "the user deleted the scan; drop the result".
 */
export function applyScanOcr(
  doc: SceneDoc,
  layerId: string,
  outcome: ScanOcrOutcome,
  transform: ScanTransform = IDENTITY_TRANSFORM,
): SceneDoc | null {
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) {
    return null;
  }
  const layer = doc.layers[index]!;
  const kept = layer.elements.filter((element) => !isOcrRaw(element));
  const elements: SceneElement[] = [];
  if (outcome.status === 'ok' && ocrPlainText(outcome.lines).length > 0) {
    const desc: RawElement = { kind: 'raw', xml: ocrDescXml(outcome.lines) };
    const group: RawElement = { kind: 'raw', xml: ocrGroupXml(outcome.lines, transform) };
    elements.push(desc, group);
  }
  elements.push(...kept);

  const layers = [...doc.layers];
  layers[index] = { ...layer, elements };
  const ocrMeta = {
    ...(isRecord(doc.meta.ocr) ? doc.meta.ocr : {}),
    [layerId]: ocrMetaEntry(outcome, transform),
  };
  return { ...doc, layers, meta: { ...doc.meta, ocr: ocrMeta } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
