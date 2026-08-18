import { describe, expect, it } from 'vitest';
import { MAX_FRAME_MS, SCROLL_HALF_LIFE_MS, approach, clamp, wheelPixels } from '../smooth-scroll';

describe('approach', () => {
  it('covers half the distance in one half-life', () => {
    expect(approach(0, 100, SCROLL_HALF_LIFE_MS, 0.5)).toBeCloseTo(50, 6);
  });

  it('moves toward the target from either side', () => {
    expect(approach(100, 0, 16, 0.5)).toBeLessThan(100);
    expect(approach(100, 0, 16, 0.5)).toBeGreaterThan(0);
    expect(approach(0, -100, 16, 0.5)).toBeLessThan(0);
  });

  it('snaps to the target inside epsilon rather than crawling forever', () => {
    expect(approach(99.9, 100, 16, 0.5)).toBe(100);
  });

  it('reaches the target after enough steps', () => {
    let value = 0;
    for (let i = 0; i < 200 && value !== 500; i++) {
      value = approach(value, 500, 16, 0.5);
    }
    expect(value).toBe(500);
  });

  it('clamps a stalled frame so waking up does not teleport', () => {
    expect(approach(0, 100, 10_000, 0.5)).toBe(approach(0, 100, MAX_FRAME_MS, 0.5));
  });

  it('stands still for a non-positive or invalid frame time', () => {
    expect(approach(10, 100, 0, 0.5)).toBe(10);
    expect(approach(10, 100, -5, 0.5)).toBe(10);
    expect(approach(10, 100, Number.NaN, 0.5)).toBe(10);
  });
});

describe('wheelPixels', () => {
  it('passes pixel deltas through', () => {
    expect(wheelPixels(120, 0, 16, 400)).toBe(120);
  });

  it('scales line and page deltas', () => {
    expect(wheelPixels(3, 1, 16, 400)).toBe(48);
    expect(wheelPixels(-1, 2, 16, 400)).toBe(-400);
  });

  it('treats a non-finite delta as no movement', () => {
    expect(wheelPixels(Number.NaN, 0, 16, 400)).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds a value both ways', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
