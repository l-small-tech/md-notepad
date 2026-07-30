/**
 * Pure zoom/pan math for the fullscreen diagram viewer. The view transform is
 * `translate(x, y) scale(scale)` with transform-origin 0 0, so a content point
 * p renders at screen position `p * scale + (x, y)` (screen coords are relative
 * to the stage's top-left corner). All functions are pure — the UI component
 * keeps the current view in a ref and applies it as a CSS transform.
 */

export interface DiagramView {
  scale: number;
  x: number;
  y: number;
}

export const DIAGRAM_MIN_SCALE = 0.2;
export const DIAGRAM_MAX_SCALE = 10;

/** Multiplicative step used by the zoom buttons and one wheel notch. */
export const DIAGRAM_ZOOM_STEP = 1.25;

export function clampDiagramScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1;
  }
  return Math.min(DIAGRAM_MAX_SCALE, Math.max(DIAGRAM_MIN_SCALE, scale));
}

/**
 * Zoom by `factor` about the screen point (cx, cy) — the content under the
 * pointer stays fixed under the pointer. Derivation: the fixed point maps from
 * content point `(c - t) / s`, so the new translation is `c - (c - t) * s'/s`.
 */
export function zoomDiagramAt(
  view: DiagramView,
  factor: number,
  cx: number,
  cy: number,
): DiagramView {
  const scale = clampDiagramScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: cx - (cx - view.x) * ratio,
    y: cy - (cy - view.y) * ratio,
  };
}

export function panDiagram(view: DiagramView, dx: number, dy: number): DiagramView {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}

/**
 * The view that shows the whole diagram centered in a stage of the given size:
 * scaled down to fit if it overflows, never scaled UP past 1:1 (a small
 * diagram blown up to fill the screen just looks blurry). Falls back to an
 * identity view when a measurement is degenerate (zero/negative size).
 */
export function fitDiagramView(
  contentWidth: number,
  contentHeight: number,
  stageWidth: number,
  stageHeight: number,
): DiagramView {
  if (contentWidth <= 0 || contentHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) {
    return { scale: 1, x: 0, y: 0 };
  }
  const scale = clampDiagramScale(
    Math.min(1, stageWidth / contentWidth, stageHeight / contentHeight),
  );
  return {
    scale,
    x: (stageWidth - contentWidth * scale) / 2,
    y: (stageHeight - contentHeight * scale) / 2,
  };
}
