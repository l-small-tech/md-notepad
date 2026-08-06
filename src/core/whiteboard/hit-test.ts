/**
 * "What is under this point" — the eraser's whole implementation, and the base
 * the selection tool will build on in phase 3.
 *
 * Whole-element erasing, never masking. An SVG `<mask>` eraser would look nicer
 * for a moment and then bloat the file with a growing mask path, break the
 * "renders identically in a browser" promise, and make selection meaningless.
 * Deleting the element the user touched is the honest operation — and because
 * scanned ink is made of the same elements, it works there too.
 *
 * Everything here is geometric and DOM-free: strokes are flattened to
 * polylines, shapes to their outlines. {@link RawElement}s are invisible to
 * every tool by design (that is what makes foreign content safe to carry).
 */

import {
  distanceToPolyline,
  ellipseOutline,
  flattenPathData,
  pointInPolygonsEvenOdd,
  pointInRect,
  rectOutline,
  type Point,
  type Rect,
} from './geometry';
import { isEditable, type ElementRef } from './layers';
import type { SceneDoc, SceneElement } from './scene';

/** Rough advance width of a glyph as a fraction of font size — text bounds only. */
const TEXT_ADVANCE = 0.55;
const TEXT_LINE_HEIGHT = 1.2;

/** Axis-aligned bounds of an element, or null when it has none (raw content). */
export function elementBounds(element: SceneElement): Rect | null {
  switch (element.kind) {
    case 'stroke': {
      const points = flattenPathData(element.d).flat();
      if (points.length === 0) {
        return null;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const pad = element.strokeWidth / 2;
      return {
        x: minX - pad,
        y: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
      };
    }
    case 'shape': {
      const g = element.geom;
      const pad = element.strokeWidth / 2;
      if (element.shape === 'rect') {
        return {
          x: (g.x ?? 0) - pad,
          y: (g.y ?? 0) - pad,
          width: (g.width ?? 0) + pad * 2,
          height: (g.height ?? 0) + pad * 2,
        };
      }
      if (element.shape === 'ellipse') {
        return {
          x: (g.cx ?? 0) - (g.rx ?? 0) - pad,
          y: (g.cy ?? 0) - (g.ry ?? 0) - pad,
          width: (g.rx ?? 0) * 2 + pad * 2,
          height: (g.ry ?? 0) * 2 + pad * 2,
        };
      }
      const x1 = g.x1 ?? 0;
      const y1 = g.y1 ?? 0;
      const x2 = g.x2 ?? 0;
      const y2 = g.y2 ?? 0;
      return {
        x: Math.min(x1, x2) - pad,
        y: Math.min(y1, y2) - pad,
        width: Math.abs(x2 - x1) + pad * 2,
        height: Math.abs(y2 - y1) + pad * 2,
      };
    }
    case 'text': {
      // Estimated, not measured — core has no font metrics. Good enough to
      // erase or select by; phase 3's text tool measures for real in the DOM.
      const longest = element.lines.reduce((n, line) => Math.max(n, line.length), 0);
      return {
        x: element.x,
        y: element.y - element.fontSize,
        width: longest * element.fontSize * TEXT_ADVANCE,
        height: Math.max(1, element.lines.length) * element.fontSize * TEXT_LINE_HEIGHT,
      };
    }
    case 'image':
      return { x: element.x, y: element.y, width: element.width, height: element.height };
    case 'raw':
      return null;
  }
}

/** Does `point` touch `element`, allowing `radius` of slop (the nib size)? */
export function hitTestElement(element: SceneElement, point: Point, radius: number): boolean {
  switch (element.kind) {
    case 'stroke': {
      const subpaths = flattenPathData(element.d);
      // A traced blob is FILLED — anywhere inside it (holes excepted) is a
      // hit, exactly like a filled shape.
      if (element.tool === 'scanfill' && pointInPolygonsEvenOdd(point, subpaths)) {
        return true;
      }
      const reach = radius + element.strokeWidth / 2;
      return subpaths.some((sub) => distanceToPolyline(point, sub) <= reach);
    }
    case 'shape': {
      const g = element.geom;
      const reach = radius + element.strokeWidth / 2;
      if (element.shape === 'rect') {
        const rect = {
          x: g.x ?? 0,
          y: g.y ?? 0,
          width: g.width ?? 0,
          height: g.height ?? 0,
        };
        // A filled shape is hit anywhere inside; an outline only on its edge.
        if (element.fill !== 'none' && pointInRect(point, rect)) {
          return true;
        }
        return distanceToPolyline(point, rectOutline(rect)) <= reach;
      }
      if (element.shape === 'ellipse') {
        const cx = g.cx ?? 0;
        const cy = g.cy ?? 0;
        const rx = g.rx ?? 0;
        const ry = g.ry ?? 0;
        if (element.fill !== 'none' && rx > 0 && ry > 0) {
          const nx = (point.x - cx) / rx;
          const ny = (point.y - cy) / ry;
          if (nx * nx + ny * ny <= 1) {
            return true;
          }
        }
        return distanceToPolyline(point, ellipseOutline(cx, cy, rx, ry)) <= reach;
      }
      return (
        distanceToPolyline(point, [
          { x: g.x1 ?? 0, y: g.y1 ?? 0 },
          { x: g.x2 ?? 0, y: g.y2 ?? 0 },
        ]) <= reach
      );
    }
    case 'text':
    case 'image': {
      const bounds = elementBounds(element);
      return bounds !== null && pointInRect(point, bounds);
    }
    case 'raw':
      // Unmodeled content belongs to whoever authored it. Never erasable.
      return false;
  }
}

/**
 * Every element under `point` on an editable layer, TOPMOST FIRST — so an
 * eraser that should take one thing can take `[0]`, while a drag-erase takes
 * them all.
 */
export function hitTest(doc: SceneDoc, point: Point, radius: number): ElementRef[] {
  const hits: ElementRef[] = [];
  for (let l = doc.layers.length - 1; l >= 0; l--) {
    const layer = doc.layers[l]!;
    if (!isEditable(layer)) {
      continue;
    }
    for (let i = layer.elements.length - 1; i >= 0; i--) {
      if (hitTestElement(layer.elements[i]!, point, radius)) {
        hits.push({ layerId: layer.id, index: i });
      }
    }
  }
  return hits;
}
