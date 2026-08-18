import { describe, expect, it } from 'vitest';
import { fitGrid, sameGrid } from '../geometry';

const CELL = { width: 8, height: 17 };

describe('fitGrid', () => {
  it('counts whole cells only', () => {
    expect(fitGrid(804, 349, CELL)).toEqual({ cols: 100, rows: 20 });
  });

  it('removes padding from both edges', () => {
    expect(fitGrid(800 + 24, 340 + 24, CELL, 12)).toEqual({ cols: 100, rows: 20 });
  });

  it('never returns a zero-sized grid for a collapsed pane', () => {
    expect(fitGrid(0, 0, CELL)).toEqual({ cols: 1, rows: 1 });
    expect(fitGrid(-50, -50, CELL, 12)).toEqual({ cols: 1, rows: 1 });
  });

  it('survives unmeasured cell metrics', () => {
    expect(fitGrid(800, 600, { width: 0, height: 0 })).toEqual({ cols: 1, rows: 1 });
  });
});

describe('sameGrid', () => {
  it('compares by value', () => {
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });
});
