/**
 * S4 — the colour classifier. A table of real-ish marker RGBs (as they read
 * AFTER white balancing), the hue-bin boundaries, and the invariant the whole
 * "themed by default" story rests on: every scan colour is a drawing-palette
 * slot, so scanned ink is themeable exactly like drawn ink.
 */

import { describe, expect, it } from 'vitest';
import { binHue, classifyRgb, SCAN_PALETTE, scanPaletteIsThemeable } from '../color';
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
