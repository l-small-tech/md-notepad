/**
 * S4 — the colour classifier. A table of real-ish marker RGBs (as they read
 * AFTER white balancing), the hue-bin boundaries, and the invariant the whole
 * "themed by default" story rests on: every scan colour is a drawing-palette
 * slot, so scanned ink is themeable exactly like drawn ink.
 */

import { describe, expect, it } from 'vitest';
import {
  assignColors,
  binHue,
  classifyRgb,
  estimateMarkerHues,
  isBlackVote,
  SCAN_PALETTE,
  scanPaletteIsThemeable,
} from '../color';
import { extractInk } from '../components';
import type { InkMasks } from '../binarize';
import type { RgbaImage } from '../types';
import { PALETTE } from '../../tool-settings';

describe('SCAN_PALETTE', () => {
  it('every scan colour is a member of the drawing PALETTE', () => {
    expect(scanPaletteIsThemeable()).toBe(true);
    for (const hex of Object.values(SCAN_PALETTE)) {
      expect(PALETTE).toContain(hex);
    }
  });
});

describe('classifyRgb', () => {
  const table: readonly (readonly [string, number, number, number, string])[] = [
    // Blacks and greys — dying markers must not turn into a hue.
    ['fresh black', 30, 30, 35, 'black'],
    ['soft black', 70, 70, 72, 'black'],
    ['dying grey', 120, 125, 130, 'black'],
    ['pencil grey', 160, 158, 165, 'black'],
    // Warm-cast blacks: residual lighting pushes chroma past the flat cutoff,
    // but the core stays DARK — the 2-D arm must catch these (phase-7 UAT:
    // black wires came back red).
    ['warm-cast black', 80, 55, 45, 'black'],
    ['warm-cast soft black', 70, 60, 40, 'black'],
    // Reds and their neighbours.
    ['classic red', 190, 45, 50, 'red'],
    ['dark red', 140, 30, 35, 'red'],
    ['pink', 230, 70, 120, 'red'],
    ['orange', 230, 120, 20, 'orange'],
    ['light orange', 240, 150, 60, 'orange'],
    ['yellow', 210, 190, 30, 'yellow'],
    ['mustard', 190, 160, 50, 'yellow'],
    // Greens through blues.
    ['classic green', 40, 150, 70, 'green'],
    ['dark green', 25, 110, 45, 'green'],
    ['lime', 130, 190, 40, 'green'],
    ['teal', 20, 150, 150, 'teal'],
    ['cyan', 40, 170, 190, 'teal'],
    ['classic blue', 40, 90, 200, 'blue'],
    ['navy', 25, 45, 130, 'blue'],
    ['sky blue', 90, 140, 220, 'blue'],
    // Purples.
    ['purple', 140, 60, 180, 'purple'],
    ['violet', 100, 40, 160, 'purple'],
    ['magenta', 200, 40, 190, 'purple'],
  ];

  for (const [name, r, g, b, expected] of table) {
    it(`classifies ${name} (${r},${g},${b}) as ${expected}`, () => {
      expect(classifyRgb(r, g, b)).toBe(expected);
    });
  }
});

describe('isBlackVote', () => {
  it('is black on low chroma regardless of luminance', () => {
    expect(isBlackVote(0.05, 0.9)).toBe(true);
  });
  it('is black on moderate chroma only when dark', () => {
    expect(isBlackVote(0.15, 0.25)).toBe(true);
    expect(isBlackVote(0.15, 0.5)).toBe(false);
  });
  it('never blackens a saturated colour, however dark', () => {
    // Navy blue: dark but chroma far above the 2-D arm's ceiling.
    expect(isBlackVote(0.41, 0.2)).toBe(false);
  });
});

describe('estimateMarkerHues', () => {
  it('recovers two well-separated marker hues', () => {
    const votes = [
      ...Array.from({ length: 40 }, (_, i) => ({ hue: 12 + (i % 7), weight: 1 })),
      ...Array.from({ length: 40 }, (_, i) => ({ hue: 127 + (i % 7), weight: 1 })),
    ];
    const peaks = estimateMarkerHues(votes);
    expect(peaks.length).toBe(2);
    expect(Math.abs(peaks[0]! - 15)).toBeLessThanOrEqual(5);
    expect(Math.abs(peaks[1]! - 130)).toBeLessThanOrEqual(5);
  });

  it('merges a jittered cluster straddling a bin edge into ONE peak', () => {
    // Teal ink votes spread across the 165° green/teal boundary.
    const votes = Array.from({ length: 60 }, (_, i) => ({ hue: 158 + (i % 15), weight: 1 }));
    const peaks = estimateMarkerHues(votes);
    expect(peaks.length).toBe(1);
  });

  it('handles wraparound reds as one cluster', () => {
    const votes = [
      ...Array.from({ length: 30 }, (_, i) => ({ hue: 352 + (i % 8), weight: 1 })),
      ...Array.from({ length: 30 }, (_, i) => ({ hue: i % 6, weight: 1 })),
    ];
    const peaks = estimateMarkerHues(votes);
    expect(peaks.length).toBe(1);
  });

  it('is empty on no votes', () => {
    expect(estimateMarkerHues([])).toEqual([]);
  });
});

describe('page-consistent assignment', () => {
  it('one marker straddling a bin edge lands in one bucket page-wide', () => {
    // Two strokes of the SAME teal pen whose measured hues sit on either side
    // of the 165° green/teal bin edge (160 and 172). Independent binning
    // would split them; peak snapping must not.
    const W = 160;
    const H = 80;
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
    const stroke = (y0: number, rgb: readonly [number, number, number]) => {
      for (let y = y0; y < y0 + 5; y++) {
        for (let x = 20; x <= 140; x++) {
          const i = y * W + x;
          const p = i * 4;
          data[p] = rgb[0];
          data[p + 1] = rgb[1];
          data[p + 2] = rgb[2];
          masks.strong[i] = 1;
          masks.weak[i] = 1;
          masks.chroma[i] = Math.max(...rgb) - Math.min(...rgb);
        }
      }
    };
    stroke(20, [40, 200, 147]); // hue 160 — green side of the edge
    stroke(50, [40, 200, 179]); // hue 172 — teal side of the edge
    const image: RgbaImage = { width: W, height: H, data };
    const extraction = extractInk(masks, W, H);
    expect(extraction.components.length).toBe(2);
    const colors = assignColors(image, extraction);
    const buckets = extraction.components.map((c) => colors.byLabel.get(c.label)!.bucket);
    expect(buckets[0]).toBe(buckets[1]);
  });
});

describe('binHue', () => {
  it('honours the plan bin boundaries', () => {
    expect(binHue(0)).toBe('red');
    expect(binHue(350)).toBe('red');
    expect(binHue(30)).toBe('orange');
    expect(binHue(55)).toBe('yellow');
    expect(binHue(120)).toBe('green');
    expect(binHue(180)).toBe('teal');
    expect(binHue(230)).toBe('blue');
    expect(binHue(300)).toBe('purple');
    // Wraparound is normalized, not undefined.
    expect(binHue(-10)).toBe('red');
    expect(binHue(365)).toBe('red');
  });
});
