/**
 * The border filter's SPLIT RESCUE (UAT, a real board): a diffuse glare streak
 * runs from a drawn box to the frame edge and welds them into one oversized
 * border-touching component. The whole component is still removed — but strong
 * dark ink inside it that does not itself touch the border comes back as new
 * components, while the streak and the frame stay gone.
 *
 * These tests build InkMasks by hand: the geometry under test is exactly the
 * connectivity, and synthetic photos put binarization's noise between the test
 * and the claim.
 */

import { describe, expect, it } from 'vitest';
import { extractInk } from '../components';
import type { InkMasks } from '../binarize';

const W = 200;
const H = 150;

interface Painted {
  masks: InkMasks;
}

function blank(): Painted {
  const size = W * H;
  return {
    masks: {
      strong: new Uint8Array(size),
      weak: new Uint8Array(size),
      luminance: new Uint8ClampedArray(size).fill(255),
      chroma: new Uint8ClampedArray(size),
    },
  };
}

/** Paint a filled rect. Strong implies weak, per the binarize contract. */
function paint(
  p: Painted,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: { strong?: boolean; lum: number; chroma?: number },
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      p.masks.weak[i] = 1;
      if (opts.strong) {
        p.masks.strong[i] = 1;
      }
      p.masks.luminance[i] = opts.lum;
      p.masks.chroma[i] = opts.chroma ?? 0;
    }
  }
}

/** A 3px-thick rectangle outline, strong and dark — unmistakably ink. */
function paintBox(p: Painted, x0: number, y0: number, x1: number, y1: number): void {
  paint(p, x0, y0, x1, y0 + 2, { strong: true, lum: 100 });
  paint(p, x0, y1 - 2, x1, y1, { strong: true, lum: 100 });
  paint(p, x0, y0, x0 + 2, y1, { strong: true, lum: 100 });
  paint(p, x1 - 2, y0, x1, y1, { strong: true, lum: 100 });
}

describe('border removal split rescue', () => {
  /**
   * Frame band on the left edge (strong, dark, touches border), a BRIGHT
   * chromatic glare streak (strong — it passes the chroma gate — but at
   * reflection luminance) bridging it to a drawn box. One weak component,
   * touches the border, oversized → border filter fires. The box must
   * come back; the streak and frame must not.
   */
  function bridgedBoard(): Painted {
    const p = blank();
    paint(p, 0, 0, 2, H - 1, { strong: true, lum: 60 }); // the frame
    paint(p, 0, 60, 89, 90, { strong: true, lum: 210, chroma: 75 }); // glare streak
    paintBox(p, 90, 40, 140, 110); // the box, streak touches its left edge
    return p;
  }

  it('rescues strong dark ink welded to the frame by a bright streak', () => {
    const { masks } = bridgedBoard();
    const result = extractInk(masks, W, H);
    expect(result.removed.border).toBe(1);
    // The box outline survives…
    expect(result.labels[42 * W + 115]).not.toBe(0); // top edge
    expect(result.labels[75 * W + 139]).not.toBe(0); // right edge
    // …under a NEW label, not the removed component's.
    const removedLabel = result.removedComponents.find((r) => r.reason === 'border')!.component
      .label;
    expect(result.labels[42 * W + 115]).not.toBe(removedLabel);
    // The streak's middle (far from any rescued ink) and the frame are gone.
    expect(result.labels[75 * W + 40]).toBe(0);
    expect(result.labels[75 * W + 1]).toBe(0);
  });

  it('records the whole component as border-removed for the debug artifact', () => {
    const { masks } = bridgedBoard();
    const result = extractInk(masks, W, H);
    const border = result.removedComponents.filter((r) => r.reason === 'border');
    expect(border.length).toBe(1);
    expect(border[0]!.component.touchesBorder).toBe(true);
  });

  it('never resurrects a frame whose own strong pixels touch the border', () => {
    const p = blank();
    // A dark frame along all four borders, oversized as one component…
    paint(p, 0, 0, 4, H - 1, { strong: true, lum: 60 });
    paint(p, W - 5, 0, W - 1, H - 1, { strong: true, lum: 60 });
    paint(p, 0, 0, W - 1, 4, { strong: true, lum: 60 });
    paint(p, 0, H - 5, W - 1, H - 1, { strong: true, lum: 60 });
    // …and enough free-standing strokes that the frame's ridge (whose
    // distance values are inflated at the image edge) cannot drag the page
    // stroke-width median up — like a real board full of writing.
    for (let s = 0; s < 15; s++) {
      const y = 12 + s * 9;
      paint(p, 30, y, 160, y + 2, { strong: true, lum: 100 });
    }
    const result = extractInk(p.masks, W, H);
    expect(result.removed.border).toBe(1);
    for (let y = 0; y < H; y++) {
      expect(result.labels[y * W + 1]).toBe(0);
    }
    // The free-standing strokes are untouched.
    expect(result.labels[13 * W + 100]).not.toBe(0);
  });

  it('counters equal the removedComponents histogram', () => {
    const { masks } = bridgedBoard();
    const result = extractInk(masks, W, H);
    const histogram = { ghost: 0, speckle: 0, faint: 0, blob: 0, border: 0, glare: 0 };
    for (const { reason } of result.removedComponents) {
      histogram[reason]++;
    }
    expect(histogram).toEqual(result.removed);
  });
});
