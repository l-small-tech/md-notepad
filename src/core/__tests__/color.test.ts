import { describe, expect, it } from 'vitest';
import {
  adjust,
  contrastRatio,
  ensureContrast,
  formatColor,
  isDarkColor,
  luminance,
  mix,
  parseColor,
} from '../color';

describe('parseColor', () => {
  it('reads both hex forms, case-insensitively', () => {
    expect(parseColor('#abc')).toBe(0xaabbcc);
    expect(parseColor('#AABBCC')).toBe(0xaabbcc);
    expect(parseColor('  #0b0f14 ')).toBe(0x0b0f14);
  });

  it('rejects anything that is not a plain hex color', () => {
    for (const value of ['', 'red', '#abcd', 'rgb(0,0,0)', 'color-mix(in srgb, red, blue)']) {
      expect(parseColor(value)).toBeNull();
    }
  });

  it('round-trips through formatColor', () => {
    expect(formatColor(0x0b0f14)).toBe('#0b0f14');
    expect(formatColor(0x000000)).toBe('#000000');
    expect(parseColor(formatColor(0x123456))).toBe(0x123456);
  });
});

describe('mix and adjust', () => {
  it('interpolates per channel and clamps t', () => {
    expect(mix(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mix(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mix(0x000000, 0xffffff, 5)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, -5)).toBe(0x000000);
  });

  it('moves toward white or black by sign', () => {
    expect(adjust(0x808080, 1)).toBe(0xffffff);
    expect(adjust(0x808080, -1)).toBe(0x000000);
    expect(adjust(0x808080, 0)).toBe(0x808080);
  });
});

describe('luminance and contrast', () => {
  it('puts black and white at the ends', () => {
    expect(luminance(0x000000)).toBeCloseTo(0, 5);
    expect(luminance(0xffffff)).toBeCloseTo(1, 5);
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21, 1);
    expect(contrastRatio(0x808080, 0x808080)).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio(0x102030, 0xf0e0d0)).toBeCloseTo(contrastRatio(0xf0e0d0, 0x102030), 6);
  });

  it('knows which surfaces need light text', () => {
    expect(isDarkColor(0x0b0f14)).toBe(true);
    expect(isDarkColor(0xfbfcfe)).toBe(false);
  });
});

describe('ensureContrast', () => {
  it('leaves a color that already clears the floor alone', () => {
    const color = 0xff6b5e;
    expect(ensureContrast(color, 0x0b0f14, 3)).toBe(color);
  });

  it('lightens against a dark background and darkens against a light one', () => {
    const dim = 0x203040;
    const onDark = ensureContrast(dim, 0x0b0f14, 3);
    expect(luminance(onDark)).toBeGreaterThan(luminance(dim));
    expect(contrastRatio(onDark, 0x0b0f14)).toBeGreaterThanOrEqual(3);

    const pale = 0xdfe6ee;
    const onLight = ensureContrast(pale, 0xfbfcfe, 3);
    expect(luminance(onLight)).toBeLessThan(luminance(pale));
    expect(contrastRatio(onLight, 0xfbfcfe)).toBeGreaterThanOrEqual(3);
  });

  it('returns the best it can when the floor is unreachable', () => {
    // Nothing contrasts 21:1 with mid grey, so this must terminate with the
    // most contrast available rather than loop.
    const result = ensureContrast(0x808080, 0x808080, 21);
    expect(contrastRatio(result, 0x808080)).toBeGreaterThan(1);
  });
});
