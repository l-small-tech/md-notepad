/**
 * The drawing tools, as pure element constructors.
 *
 * A tool is nothing but "given a gesture, produce a {@link SceneElement}" —
 * keeping that here (rather than in the adapter) means the adapter's pointer
 * handling and, later, the scan tracer agree on what a pen stroke IS, and every
 * constructor is unit-tested without a DOM.
 *
 * The vocabulary itself (tool ids, palette, nib sizes) lives in the dependency-
 * free `tool-settings.ts` so the ribbon can import it without dragging this
 * module's transitive weight into the entry bundle. It is re-exported here so
 * whiteboard code has one import to reach for.
 */

import type { Point } from './geometry';
import { rectFromCorners } from './geometry';
import { buildStrokePath } from './smoothing';
import type { ShapeElement, ShapeKind, StrokeElement, TextElement } from './scene';
import { HIGHLIGHTER_OPACITY, HIGHLIGHTER_WIDTH_FACTOR } from './tool-settings';

export * from './tool-settings';

export function makeStroke(
  tool: 'pen' | 'highlighter',
  points: readonly Point[],
  color: string,
  width: number,
): StrokeElement | null {
  const d = buildStrokePath(points);
  if (d === '') {
    return null;
  }
  return {
    kind: 'stroke',
    // Drawn strokes stay id-free: ids exist so a scan layer's OCR metadata can
    // point at the ink it read, and every byte counts in a dense file.
    id: null,
    tool,
    d,
    stroke: color,
    strokeWidth: tool === 'highlighter' ? width * HIGHLIGHTER_WIDTH_FACTOR : width,
    opacity: tool === 'highlighter' ? HIGHLIGHTER_OPACITY : null,
    widths: null,
  };
}

/**
 * A text element from what the user typed. `at` is the BASELINE of the first
 * line, which is what `<text y>` means — the adapter's textarea overlay is
 * positioned to match, so the caret sits where the glyphs will land.
 *
 * Returns null for empty input (including a box that only ever held spaces):
 * tapping the text tool and tapping away again must leave nothing behind.
 * Trailing blank lines go the same way; interior ones are the user's.
 */
export function makeText(
  at: Point,
  text: string,
  color: string,
  fontSize: number,
  fontFamily: string | null = null,
  boxWidth: number | null = null,
): TextElement | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  while (lines.length > 0 && lines[0]!.trim() === '') {
    lines.shift();
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    kind: 'text',
    id: null,
    x: at.x,
    y: at.y,
    fontSize,
    fontFamily,
    fill: color,
    lines,
    // `lines` is already wrapped by the caller; this only records the box the
    // wrapping came from, so reopening the text rewraps to the same width.
    boxWidth: boxWidth !== null && boxWidth > 0 ? boxWidth : null,
  };
}

/**
 * A shape from its drag. Returns null for a degenerate gesture (a click that
 * never moved) so a stray tap can't litter the board with zero-size elements.
 */
export function makeShape(
  kind: ShapeKind,
  start: Point,
  end: Point,
  color: string,
  width: number,
): ShapeElement | null {
  const base = { kind: 'shape', id: null, stroke: color, strokeWidth: width } as const;
  if (kind === 'line' || kind === 'arrow') {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2) {
      return null;
    }
    return {
      ...base,
      shape: kind,
      geom: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
      fill: 'none',
      opacity: null,
    };
  }
  const rect = rectFromCorners(start, end);
  if (rect.width < 2 && rect.height < 2) {
    return null;
  }
  if (kind === 'rect') {
    return {
      ...base,
      shape: 'rect',
      geom: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      fill: 'none',
      opacity: null,
    };
  }
  return {
    ...base,
    shape: 'ellipse',
    geom: {
      cx: rect.x + rect.width / 2,
      cy: rect.y + rect.height / 2,
      rx: rect.width / 2,
      ry: rect.height / 2,
    },
    fill: 'none',
    opacity: null,
  };
}
