import { describe, expect, it } from 'vitest';
import {
  DIAGRAM_MAX_SCALE,
  DIAGRAM_MIN_SCALE,
  clampDiagramScale,
  fitDiagramView,
  panDiagram,
  zoomDiagramAt,
} from '../diagram-zoom';

describe('clampDiagramScale', () => {
  it('passes through in-range scales', () => {
    expect(clampDiagramScale(1)).toBe(1);
    expect(clampDiagramScale(2.5)).toBe(2.5);
  });

  it('clamps to the min/max bounds', () => {
    expect(clampDiagramScale(0.01)).toBe(DIAGRAM_MIN_SCALE);
    expect(clampDiagramScale(1000)).toBe(DIAGRAM_MAX_SCALE);
  });

  it('recovers to 1 from degenerate values', () => {
    expect(clampDiagramScale(0)).toBe(1);
    expect(clampDiagramScale(-3)).toBe(1);
    expect(clampDiagramScale(NaN)).toBe(1);
    expect(clampDiagramScale(Infinity)).toBe(1);
  });
});

describe('zoomDiagramAt', () => {
  it('keeps the content under the anchor point fixed', () => {
    const view = { scale: 1, x: 10, y: 20 };
    const cx = 100;
    const cy = 80;
    // Content point currently under the anchor.
    const px = (cx - view.x) / view.scale;
    const py = (cy - view.y) / view.scale;
    const next = zoomDiagramAt(view, 2, cx, cy);
    expect(next.scale).toBe(2);
    expect(px * next.scale + next.x).toBeCloseTo(cx);
    expect(py * next.scale + next.y).toBeCloseTo(cy);
  });

  it('is a no-op translation-wise when the clamp stops the zoom', () => {
    const view = { scale: DIAGRAM_MAX_SCALE, x: -50, y: -30 };
    const next = zoomDiagramAt(view, 4, 200, 100);
    expect(next).toEqual(view);
  });

  it('zooming in then out about the same point round-trips', () => {
    const view = { scale: 1, x: 0, y: 0 };
    const zoomed = zoomDiagramAt(view, 2, 150, 90);
    const back = zoomDiagramAt(zoomed, 0.5, 150, 90);
    expect(back.scale).toBeCloseTo(1);
    expect(back.x).toBeCloseTo(0);
    expect(back.y).toBeCloseTo(0);
  });
});

describe('panDiagram', () => {
  it('shifts the translation and preserves scale', () => {
    expect(panDiagram({ scale: 2, x: 5, y: -3 }, 10, 4)).toEqual({ scale: 2, x: 15, y: 1 });
  });
});

describe('fitDiagramView', () => {
  it('centers a diagram smaller than the stage at 1:1', () => {
    const view = fitDiagramView(200, 100, 800, 600);
    expect(view.scale).toBe(1);
    expect(view.x).toBe(300);
    expect(view.y).toBe(250);
  });

  it('scales an oversized diagram down to fit, preserving aspect', () => {
    const view = fitDiagramView(1600, 600, 800, 600);
    expect(view.scale).toBe(0.5);
    expect(view.x).toBe(0);
    expect(view.y).toBe(150); // (600 - 600*0.5) / 2
  });

  it('never scales below the min clamp', () => {
    const view = fitDiagramView(100000, 100, 800, 600);
    expect(view.scale).toBe(DIAGRAM_MIN_SCALE);
  });

  it('falls back to identity for degenerate measurements', () => {
    expect(fitDiagramView(0, 100, 800, 600)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(fitDiagramView(200, 100, 0, 600)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
