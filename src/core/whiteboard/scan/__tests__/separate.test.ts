/**
 * S4.5 — mixed-component separation. The scenario is the phase-7 UAT wiring
 * board: strokes of different markers CROSS, binarize into one 8-connected
 * component, and a single component-level colour vote paints the black wire
 * red. Separation splits such a component along per-pixel colour clusters;
 * a single-marker component passes through IDENTICALLY (same object).
 */

import { describe, expect, it } from 'vitest';
import { extractInk } from '../components';
import { separateColors } from '../separate';
import { assignColors } from '../color';
import type { InkMasks } from '../binarize';
import type { RgbaImage } from '../types';

const W = 160;
const H = 120;

function board(): { image: RgbaImage; masks: InkMasks } {
  const size = W * H;
  const data = new Uint8ClampedArray(size * 4);
  const masks: InkMasks = {
    strong: new Uint8Array(size),
    weak: new Uint8Array(size),
    luminance: new Uint8ClampedArray(size).fill(255),
    chroma: new Uint8ClampedArray(size),
  };
  for (let i = 0; i < size; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const ink = (x: number, y: number, rgb: readonly [number, number, number]) => {
    const i = y * W + x;
    const p = i * 4;
    data[p] = rgb[0];
    data[p + 1] = rgb[1];
    data[p + 2] = rgb[2];
    masks.strong[i] = 1;
    masks.weak[i] = 1;
    masks.luminance[i] = Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]);
    masks.chroma[i] = Math.max(...rgb) - Math.min(...rgb);
  };
  // A red horizontal stroke crossed by a black vertical one — one component.
  for (let x = 20; x <= 140; x++) {
    for (let y = 55; y <= 60; y++) {
      ink(x, y, [208, 42, 42]);
    }
  }
  for (let y = 20; y <= 100; y++) {
    for (let x = 78; x <= 82; x++) {
      ink(x, y, [35, 35, 35]);
    }
  }
  return { image: { width: W, height: H, data }, masks };
}

describe('separateColors', () => {
  it('splits a crossing of two markers into per-marker components', () => {
    const { image, masks } = board();
    const extraction = extractInk(masks, W, H);
    // The premise: the crossing really is ONE component before separation.
    expect(extraction.components.length).toBe(1);
    const separated = separateColors(image, extraction);
    expect(separated.components.length).toBeGreaterThanOrEqual(2);
    const redLabel = separated.labels[57 * W + 30]!;
    const blackLabel = separated.labels[25 * W + 80]!;
    expect(redLabel).not.toBe(0);
    expect(blackLabel).not.toBe(0);
    expect(redLabel).not.toBe(blackLabel);
    // And the votes land where the markers are.
    const colors = assignColors(image, separated);
    expect(colors.byLabel.get(redLabel)!.bucket).toBe('red');
    expect(colors.byLabel.get(blackLabel)!.bucket).toBe('black');
  });

  it('returns the extraction UNCHANGED when nothing is mixed', () => {
    const { image, masks } = board();
    // Erase the black vertical (and repaint the crossing red): one marker.
    for (let y = 20; y <= 100; y++) {
      for (let x = 78; x <= 82; x++) {
        const i = y * W + x;
        const p = i * 4;
        if (y >= 55 && y <= 60) {
          image.data[p] = 208;
          image.data[p + 1] = 42;
          image.data[p + 2] = 42;
          masks.chroma[i] = 208 - 42;
          continue;
        }
        masks.strong[i] = 0;
        masks.weak[i] = 0;
        image.data[p] = 255;
        image.data[p + 1] = 255;
        image.data[p + 2] = 255;
      }
    }
    const extraction = extractInk(masks, W, H);
    const separated = separateColors(image, extraction);
    expect(separated).toBe(extraction);
  });

  it('is deterministic', () => {
    const a = (() => {
      const { image, masks } = board();
      return separateColors(image, extractInk(masks, W, H));
    })();
    const b = (() => {
      const { image, masks } = board();
      return separateColors(image, extractInk(masks, W, H));
    })();
    expect(a.components).toEqual(b.components);
    expect([...a.labels]).toEqual([...b.labels]);
  });
});
