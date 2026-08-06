/**
 * Platform dispatch for the whiteboard scan's text recognition (S6) — the
 * concrete `ScanRecognizeFn` the EditorHost injects into the draw adapter.
 * Lives here for the same reason `scan-photo.ts` does: the engines are native
 * bridges behind `ipc`, selected per platform, and an editor module must not
 * know which platform it is on (the layering contract is `editors → core,
 * ipc`; platform detection lives above it).
 *
 * The chain, per the plan's S6 table:
 * - Android: ML Kit Digital Ink (a HANDWRITING model, fed the traced strokes
 *   line by line) with ML Kit Text Recognition — the printed-text raster
 *   model — as the fallback when no ink model exists for the device language
 *   or the ink pass reads nothing.
 * - Windows: `Windows.Media.Ocr` over the cleaned raster — on-device,
 *   offline, ships with the OS. A printed-text engine, so block capitals do
 *   far better than cursive; the metadata names the engine so a consumer can
 *   weigh that.
 * - macOS/Linux: null — the scan records `"status": "unavailable"` honestly
 *   instead of shipping a multi-MB WASM engine that reads handwriting badly.
 */

import type {
  RasterEngineLine,
  ScanRecognizeFn,
  ScanRecognizeRequest,
  ScanRecognizeResponse,
} from '../core/whiteboard/scan/ocr';
import { ipc } from '../ipc/commands';
import { isAndroid, isWindows } from './platform';

/** The recognizer for this platform, or null where none exists. */
export function scanTextRecognizer(): ScanRecognizeFn | null {
  if (isAndroid()) {
    return recognizeAndroid;
  }
  if (isWindows()) {
    return recognizeWindows;
  }
  return null;
}

function toRasterLines(
  lines: readonly {
    text: string;
    confidence: number | null;
    x: number;
    y: number;
    width: number;
    height: number;
  }[],
): RasterEngineLine[] {
  return lines.map((line) => ({
    text: line.text,
    confidence: line.confidence,
    bbox: { x: line.x, y: line.y, width: line.width, height: line.height },
  }));
}

function errorResponse(error: unknown): ScanRecognizeResponse {
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
}

async function recognizeAndroid(request: ScanRecognizeRequest): Promise<ScanRecognizeResponse> {
  if (request.lines.length > 0) {
    try {
      const result = await ipc.inkRecognize(JSON.stringify({ lines: request.lines }));
      if (result.lines.some((line) => line.text.trim().length > 0)) {
        return { kind: 'ink', engine: 'mlkit-ink', texts: result.lines };
      }
      // The ink model ran and read nothing — let the raster model try; it
      // fails differently (plan risk 7: traced strokes lack written order).
    } catch {
      // INK_UNAVAILABLE (no model for this language) or INK_FAILED — the
      // raster fallback below is the designed answer to both.
    }
  }
  const png = await request.png();
  if (!png) {
    return { kind: 'error', message: 'the board image could not be encoded' };
  }
  try {
    const result = await ipc.textRecognize(png);
    return { kind: 'raster', engine: 'mlkit-text', lines: toRasterLines(result.lines) };
  } catch (error) {
    return errorResponse(error);
  }
}

// Windows deliberately has NO ink engine. InkAnalyzer (the OS handwriting
// recognizer) was built, probed against a real board's traced strokes, and
// REJECTED: skeleton centerlines carry none of the pen dynamics it depends
// on, and it returned confident junk ("x-", "5 7", "ace" for "Box 1 → Other
// Place") at every scale, isolated or whole-board, auto or forced-writing.
// Junk in a `<desc>` is worse than an honest empty result. Evidence and
// probe scripts are recorded in whiteboard-plan.md phase 7.
async function recognizeWindows(request: ScanRecognizeRequest): Promise<ScanRecognizeResponse> {
  try {
    // No engine means no OCR language pack is installed — that is
    // "unavailable", not an error.
    if (!(await ipc.ocrImageAvailable())) {
      return { kind: 'unavailable' };
    }
  } catch {
    return { kind: 'unavailable' };
  }
  const png = await request.png();
  if (!png) {
    return { kind: 'error', message: 'the board image could not be encoded' };
  }
  try {
    const result = await ipc.ocrImageRecognize(png);
    return { kind: 'raster', engine: result.engine, lines: toRasterLines(result.lines) };
  } catch (error) {
    return errorResponse(error);
  }
}
