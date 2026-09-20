import { describe, expect, it } from 'vitest';
import { clampSlide, formatElapsed, stopwatchElapsed, toggleStopwatch } from '../presenter';

describe('presenter core', () => {
  it('clamps a slide index into the deck', () => {
    expect(clampSlide(-1, 5)).toBe(0);
    expect(clampSlide(9, 5)).toBe(4);
    expect(clampSlide(2.7, 5)).toBe(2);
    expect(clampSlide(3, 0)).toBe(0);
    expect(clampSlide(Number.NaN, 5)).toBe(0);
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('runs, pauses and resumes a stopwatch', () => {
    let watch = toggleStopwatch({ elapsedMs: 0, startedAt: null }, 1000);
    expect(stopwatchElapsed(watch, 4000)).toBe(3000);
    watch = toggleStopwatch(watch, 4000);
    expect(watch).toEqual({ elapsedMs: 3000, startedAt: null });
    expect(stopwatchElapsed(watch, 9000)).toBe(3000);
    watch = toggleStopwatch(watch, 10_000);
    expect(stopwatchElapsed(watch, 11_000)).toBe(4000);
  });
});
