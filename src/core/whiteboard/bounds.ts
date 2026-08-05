/**
 * Content bounds — what an INFINITE board's viewBox must cover.
 *
 * An infinite board (`background: null`) has no page; on every save the
 * serializer refits the root viewBox to `contentViewBox`, so a foreign
 * renderer sees exactly the drawn content plus a margin. The maths must be
 * IDEMPOTENT — parse → serialize → parse must reach a fixed point — which is
 * why bounds derive purely from element geometry (plus the stored viewBox
 * only when unmeasurable raw/foreign content exists) and round outward to
 * whole units.
 */

import { boundsOfPoints, flattenPathData, type Rect } from './geometry';
import {
  DEFAULT_BOARD_HEIGHT,
  DEFAULT_BOARD_WIDTH,
  type SceneDoc,
  type SceneElement,
} from './scene';

/** Breathing room around the content in an infinite board's viewBox. */
export const CONTENT_MARGIN = 48;

/**
 * Axis-aligned bounds of one element, or null when it has none — a raw
 * element's geometry is unknowable without a DOM, and a degenerate element
 * covers nothing.
 */
export function elementBounds(element: SceneElement): Rect | null {
  switch (element.kind) {
    case 'stroke': {
      const points = flattenPathData(element.d).flat();
      const bounds = boundsOfPoints(points);
      return bounds === null ? null : padded(bounds, element.strokeWidth / 2);
    }
    case 'shape': {
      const g = element.geom;
      const rect =
        element.shape === 'rect'
          ? { x: g.x ?? 0, y: g.y ?? 0, width: g.width ?? 0, height: g.height ?? 0 }
          : element.shape === 'ellipse'
            ? {
                x: (g.cx ?? 0) - (g.rx ?? 0),
                y: (g.cy ?? 0) - (g.ry ?? 0),
                width: (g.rx ?? 0) * 2,
                height: (g.ry ?? 0) * 2,
              }
            : rectFromSegment(g.x1 ?? 0, g.y1 ?? 0, g.x2 ?? 0, g.y2 ?? 0);
      return padded(rect, element.strokeWidth / 2);
    }
    case 'text': {
      // No DOM, so estimate: line height ≈ 1.2em, width ≈ 0.6em per character.
      // The content margin absorbs the error; exactness is not required here.
      const longest = element.lines.reduce((max, line) => Math.max(max, line.length), 0);
      return {
        x: element.x,
        y: element.y - element.fontSize,
        width: Math.max(1, longest * element.fontSize * 0.6),
        height: Math.max(1, element.lines.length * element.fontSize * 1.2),
      };
    }
    case 'image':
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    case 'raw':
      return null;
  }
}

/**
 * The viewBox an infinite board serializes with: the union of every layer's
 * element bounds plus {@link CONTENT_MARGIN}, rounded outward to integers.
 * Unmeasurable content (raw elements, foreign layers) unions in the STORED
 * viewBox so nothing an earlier save covered can ever get clipped. An empty
 * board falls back to the default size.
 */
export function contentViewBox(doc: SceneDoc): [number, number, number, number] {
  let bounds: Rect | null = null;
  let unmeasurable = false;
  for (const layer of doc.layers) {
    for (const element of layer.elements) {
      const rect = elementBounds(element);
      if (rect === null) {
        unmeasurable = element.kind === 'raw' || unmeasurable;
        continue;
      }
      bounds = bounds === null ? rect : union(bounds, rect);
    }
  }
  if (bounds !== null) {
    bounds = padded(bounds, CONTENT_MARGIN);
  }
  if (unmeasurable) {
    const stored: Rect = {
      x: doc.viewBox[0],
      y: doc.viewBox[1],
      width: doc.viewBox[2],
      height: doc.viewBox[3],
    };
    bounds = bounds === null ? stored : union(bounds, stored);
  }
  if (bounds === null) {
    return [0, 0, DEFAULT_BOARD_WIDTH, DEFAULT_BOARD_HEIGHT];
  }
  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);
  return [
    x,
    y,
    Math.max(1, Math.ceil(bounds.x + bounds.width) - x),
    Math.max(1, Math.ceil(bounds.y + bounds.height) - y),
  ];
}

function padded(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function rectFromSegment(x1: number, y1: number, x2: number, y2: number): Rect {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
