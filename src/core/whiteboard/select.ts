/**
 * Selection: what is picked, where its box is, and what moving or resizing it
 * does to the elements underneath.
 *
 * Every transform is BAKED into the element's own coordinates — a stroke's `d`
 * is rewritten, a rect's `x`/`width` are rewritten. The format has no stacked
 * transforms (see `scene.ts`), which is what keeps hit-testing, the "renders
 * identically in a browser" promise and the scan pipeline's coordinate mapping
 * all simple. The price is paid here, once.
 *
 * A selection is a list of {@link ElementRef}s — layer id plus index. Refs stay
 * valid across move and resize (those REPLACE elements in place) and are
 * invalidated by anything that adds or removes elements, which is why the
 * adapter clears the selection on undo, redo and external document changes.
 */

import {
  boundsOfPoints,
  rectContainsRect,
  transformPathData,
  unionRect,
  type Point,
  type Rect,
} from './geometry';
import { elementBounds } from './hit-test';
import { isEditable, type ElementRef } from './layers';
import type { SceneDoc, SceneElement } from './scene';

/* -------------------------------- the set --------------------------------- */

export function sameRef(a: ElementRef, b: ElementRef): boolean {
  return a.layerId === b.layerId && a.index === b.index;
}

export function hasRef(refs: readonly ElementRef[], ref: ElementRef): boolean {
  return refs.some((r) => sameRef(r, ref));
}

/** Shift-click semantics: in the set → out of it, out → in. */
export function toggleRef(refs: readonly ElementRef[], ref: ElementRef): ElementRef[] {
  return hasRef(refs, ref) ? refs.filter((r) => !sameRef(r, ref)) : [...refs, ref];
}

export function resolveElement(doc: SceneDoc, ref: ElementRef): SceneElement | null {
  const layer = doc.layers.find((l) => l.id === ref.layerId);
  return layer?.elements[ref.index] ?? null;
}

/** Drop refs that no longer point at a selectable element (post-undo hygiene). */
export function validRefs(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[] {
  return refs.filter((ref) => {
    const layer = doc.layers.find((l) => l.id === ref.layerId);
    if (!layer || !isEditable(layer)) {
      return false;
    }
    const element = layer.elements[ref.index];
    return element !== undefined && element.kind !== 'raw';
  });
}

/**
 * Everything whose bounds sit entirely inside `rect`, on editable layers.
 *
 * CONTAINMENT, not intersection: a marquee that grabbed everything it merely
 * grazed would make it impossible to select one stroke out of a dense sketch,
 * and "drag a box around it" is the gesture people already know from every
 * other editor.
 */
export function elementsInRect(doc: SceneDoc, rect: Rect): ElementRef[] {
  const refs: ElementRef[] = [];
  for (const layer of doc.layers) {
    if (!isEditable(layer)) {
      continue;
    }
    layer.elements.forEach((element, index) => {
      const bounds = elementBounds(element);
      if (bounds && rectContainsRect(rect, bounds)) {
        refs.push({ layerId: layer.id, index });
      }
    });
  }
  return refs;
}

/** Every selectable element in the document — Ctrl/Cmd+A. */
export function allSelectable(doc: SceneDoc): ElementRef[] {
  const refs: ElementRef[] = [];
  for (const layer of doc.layers) {
    if (!isEditable(layer)) {
      continue;
    }
    layer.elements.forEach((element, index) => {
      if (element.kind !== 'raw') {
        refs.push({ layerId: layer.id, index });
      }
    });
  }
  return refs;
}

/** The selection box: the union of the members' bounds, or null when empty. */
export function selectionBounds(doc: SceneDoc, refs: readonly ElementRef[]): Rect | null {
  let box: Rect | null = null;
  for (const ref of refs) {
    const element = resolveElement(doc, ref);
    if (element) {
      box = unionRect(box, elementBounds(element));
    }
  }
  return box;
}

/* ------------------------------- the handles ------------------------------- */

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Where each handle sits on a selection box. */
export function handlePoint(rect: Rect, handle: ResizeHandle): Point {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  switch (handle) {
    case 'nw':
      return { x: rect.x, y: rect.y };
    case 'n':
      return { x: midX, y: rect.y };
    case 'ne':
      return { x: right, y: rect.y };
    case 'e':
      return { x: right, y: midY };
    case 'se':
      return { x: right, y: bottom };
    case 's':
      return { x: midX, y: bottom };
    case 'sw':
      return { x: rect.x, y: bottom };
    case 'w':
      return { x: rect.x, y: midY };
  }
}

/** The handle within `radius` of `point`, nearest first. Null when none is. */
export function handleAt(rect: Rect, point: Point, radius: number): ResizeHandle | null {
  let best: ResizeHandle | null = null;
  let bestDistance = radius;
  for (const handle of RESIZE_HANDLES) {
    const p = handlePoint(rect, handle);
    const d = Math.hypot(point.x - p.x, point.y - p.y);
    if (d <= bestDistance) {
      best = handle;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * The box `handle` would produce after being dragged by (dx, dy).
 *
 * The opposite edge is the anchor and never moves. Each axis is clamped at
 * `minSize` rather than being allowed through zero: a selection that can flip
 * inside-out means negative scale factors, mirrored text and a resize the user
 * cannot undo by dragging back. Clamping costs one line and removes the whole
 * class of problem.
 */
export function resizeRect(
  base: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  minSize: number,
): Rect {
  const west = handle === 'nw' || handle === 'w' || handle === 'sw';
  const east = handle === 'ne' || handle === 'e' || handle === 'se';
  const north = handle === 'nw' || handle === 'n' || handle === 'ne';
  const south = handle === 'sw' || handle === 's' || handle === 'se';

  let { x, y, width, height } = base;
  if (east) {
    width = Math.max(minSize, base.width + dx);
  } else if (west) {
    width = Math.max(minSize, base.width - dx);
    x = base.x + base.width - width;
  }
  if (south) {
    height = Math.max(minSize, base.height + dy);
  } else if (north) {
    height = Math.max(minSize, base.height - dy);
    y = base.y + base.height - height;
  }
  return { x, y, width, height };
}

/** The affine that maps `from` onto `to`. Degenerate axes scale by 1. */
export function rectTransform(
  from: Rect,
  to: Rect,
): { sx: number; sy: number; tx: number; ty: number } {
  const sx = from.width > 1e-6 ? to.width / from.width : 1;
  const sy = from.height > 1e-6 ? to.height / from.height : 1;
  return { sx, sy, tx: to.x - from.x * sx, ty: to.y - from.y * sy };
}

/* ------------------------------ baking it in ------------------------------- */

/**
 * `element` under `x' = x·sx + tx`, `y' = y·sy + ty`.
 *
 * Stroke widths and font sizes take the GEOMETRIC MEAN of the two scales: a
 * single number has to stand in for a two-axis stretch, and √(sx·sy) is the one
 * that preserves area — it degrades gracefully instead of leaving a hairline
 * when a shape is squashed flat on one axis. {@link RawElement}s come back
 * untouched; unmodeled content is never selectable, so this can only be reached
 * defensively.
 */
export function transformElement(
  element: SceneElement,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): SceneElement {
  const scale = Math.sqrt(Math.abs(sx * sy)) || 1;
  switch (element.kind) {
    case 'stroke':
      return {
        ...element,
        d: transformPathData(element.d, sx, sy, tx, ty),
        strokeWidth: element.strokeWidth * scale,
      };
    case 'shape': {
      const g = element.geom;
      const geom: Record<string, number> =
        element.shape === 'rect'
          ? {
              x: (g.x ?? 0) * sx + tx,
              y: (g.y ?? 0) * sy + ty,
              width: (g.width ?? 0) * sx,
              height: (g.height ?? 0) * sy,
            }
          : element.shape === 'ellipse'
            ? {
                cx: (g.cx ?? 0) * sx + tx,
                cy: (g.cy ?? 0) * sy + ty,
                rx: (g.rx ?? 0) * Math.abs(sx),
                ry: (g.ry ?? 0) * Math.abs(sy),
              }
            : {
                x1: (g.x1 ?? 0) * sx + tx,
                y1: (g.y1 ?? 0) * sy + ty,
                x2: (g.x2 ?? 0) * sx + tx,
                y2: (g.y2 ?? 0) * sy + ty,
              };
      return { ...element, geom, strokeWidth: element.strokeWidth * scale };
    }
    case 'text':
      return {
        ...element,
        x: element.x * sx + tx,
        y: element.y * sy + ty,
        fontSize: element.fontSize * scale,
        // The box follows the horizontal scale, not the geometric mean: it is
        // a width, and the already-wrapped lines beside it are the truth for
        // how the text reads. Rewrapping happens when the box is reopened.
        boxWidth: element.boxWidth === null ? null : element.boxWidth * Math.abs(sx),
      };
    case 'image':
      return {
        ...element,
        x: element.x * sx + tx,
        y: element.y * sy + ty,
        width: element.width * sx,
        height: element.height * sy,
      };
    case 'raw':
      return element;
  }
}

/**
 * Apply `update` to every referenced element, in one pass over the document.
 * Indices are preserved, so the caller's refs survive the edit — that is what
 * lets a drag keep transforming the SAME selection frame after frame.
 */
export function mapElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  update: (element: SceneElement) => SceneElement,
): SceneDoc {
  if (refs.length === 0) {
    return doc;
  }
  const byLayer = new Map<string, Set<number>>();
  for (const ref of refs) {
    let set = byLayer.get(ref.layerId);
    if (!set) {
      set = new Set();
      byLayer.set(ref.layerId, set);
    }
    set.add(ref.index);
  }
  let changed = false;
  const layers = doc.layers.map((layer) => {
    const indices = byLayer.get(layer.id);
    if (!indices || indices.size === 0) {
      return layer;
    }
    changed = true;
    return {
      ...layer,
      elements: layer.elements.map((element, index) =>
        indices.has(index) ? update(element) : element,
      ),
    };
  });
  return changed ? { ...doc, layers } : doc;
}

/** Move a selection by (dx, dy), baked. */
export function translateElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  dx: number,
  dy: number,
): SceneDoc {
  if (dx === 0 && dy === 0) {
    return doc;
  }
  return mapElements(doc, refs, (element) => transformElement(element, 1, 1, dx, dy));
}

/** Resize a selection so its box goes from `from` to `to`, baked. */
export function scaleElements(
  doc: SceneDoc,
  refs: readonly ElementRef[],
  from: Rect,
  to: Rect,
): SceneDoc {
  const { sx, sy, tx, ty } = rectTransform(from, to);
  if (sx === 1 && sy === 1 && tx === 0 && ty === 0) {
    return doc;
  }
  return mapElements(doc, refs, (element) => transformElement(element, sx, sy, tx, ty));
}

/** Replace one element outright — the text tool re-committing an edit. */
export function replaceElement(doc: SceneDoc, ref: ElementRef, element: SceneElement): SceneDoc {
  return mapElements(doc, [ref], () => element);
}

/** The marquee rect from its two drag corners. */
export function marqueeRect(a: Point, b: Point): Rect {
  return boundsOfPoints([a, b]) ?? { x: a.x, y: a.y, width: 0, height: 0 };
}
