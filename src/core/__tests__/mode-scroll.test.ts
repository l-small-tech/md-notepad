import { describe, expect, it } from 'vitest';
import {
  headingIndexForLine,
  lineForHeadingIndex,
  scrollSurfaceFor,
  stampedLineFor,
} from '../mode-scroll';
import { extractOutline } from '../outline';

describe('scrollSurfaceFor', () => {
  it('routes each mode to the surface that owns its scroll', () => {
    expect(scrollSurfaceFor('raw')).toBe('source');
    // Split shows both, but the editor is what the reader drives.
    expect(scrollSurfaceFor('split')).toBe('source');
    expect(scrollSurfaceFor('read')).toBe('rendered');
    expect(scrollSurfaceFor('wysiwyg')).toBe('edit');
  });

  it('has no anchor for the modes without source lines', () => {
    expect(scrollSurfaceFor('draw')).toBeNull();
    expect(scrollSurfaceFor('term')).toBeNull();
  });
});

describe('stampedLineFor', () => {
  const stamps = [1, 4, 9, 20];

  it('picks the block the line lives in', () => {
    expect(stampedLineFor(stamps, 9)).toBe(9);
    expect(stampedLineFor(stamps, 12)).toBe(9);
    expect(stampedLineFor(stamps, 19)).toBe(9);
    expect(stampedLineFor(stamps, 20)).toBe(20);
    expect(stampedLineFor(stamps, 999)).toBe(20);
  });

  it('falls back to the first block above the first stamp', () => {
    expect(stampedLineFor([4, 9], 1)).toBe(4);
  });

  it('is null when nothing is rendered', () => {
    expect(stampedLineFor([], 7)).toBeNull();
  });

  it('does not assume the stamps are sorted', () => {
    expect(stampedLineFor([20, 1, 9, 4], 12)).toBe(9);
    expect(stampedLineFor([20, 9, 4], 1)).toBe(4);
  });
});

describe('heading mapping (the Edit editor has no source lines)', () => {
  const headings = extractOutline(
    ['# One', '', 'body', '', '## Two', '', 'body', '', '# Three'].join('\n'),
  );

  it('maps a line to the section it is in', () => {
    expect(headingIndexForLine(headings, 1)).toBe(0);
    expect(headingIndexForLine(headings, 3)).toBe(0);
    expect(headingIndexForLine(headings, 5)).toBe(1);
    expect(headingIndexForLine(headings, 8)).toBe(1);
    expect(headingIndexForLine(headings, 9)).toBe(2);
  });

  it('reports -1 above the first heading', () => {
    const withPreamble = extractOutline(['intro', '', '# One'].join('\n'));
    expect(headingIndexForLine(withPreamble, 1)).toBe(-1);
    expect(headingIndexForLine([], 5)).toBe(-1);
  });

  it('round-trips through the heading index', () => {
    for (const line of [1, 5, 9]) {
      const index = headingIndexForLine(headings, line);
      expect(lineForHeadingIndex(headings, index)).toBe(line);
    }
  });

  it('has no line for an out-of-range index', () => {
    expect(lineForHeadingIndex(headings, -1)).toBeNull();
    expect(lineForHeadingIndex(headings, 99)).toBeNull();
  });
});
