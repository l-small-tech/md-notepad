import { describe, expect, test } from 'vitest';
import { findMatchesInText } from '../search';

const P = '/notes/a.md';

describe('findMatchesInText — basics', () => {
  test('finds a single hit with 1-based line and col', () => {
    const matches = findMatchesInText(P, 'alpha\nbravo charlie\n', 'charlie', 100);
    expect(matches).toEqual([{ path: P, line: 2, col: 7, lineText: 'bravo charlie' }]);
  });

  test('is case-insensitive against the text', () => {
    const matches = findMatchesInText(P, 'Hello WORLD', 'world', 100);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.col).toBe(7);
    expect(matches[0]!.lineText).toBe('Hello WORLD');
  });

  test('multiple hits on one line yield one match per occurrence', () => {
    const matches = findMatchesInText(P, 'ab xx ab yy ab', 'ab', 100);
    expect(matches.map((m) => m.col)).toEqual([1, 7, 13]);
    expect(matches.every((m) => m.line === 1)).toBe(true);
  });

  test('occurrences are non-overlapping (scan resumes after each hit)', () => {
    const matches = findMatchesInText(P, 'aaaa', 'aa', 100);
    expect(matches.map((m) => m.col)).toEqual([1, 3]);
  });

  test('hits across several lines carry their own line numbers', () => {
    const matches = findMatchesInText(P, 'x\nfoo\n\nfoo bar\n', 'foo', 100);
    expect(matches.map((m) => m.line)).toEqual([2, 4]);
  });
});

describe('findMatchesInText — CRLF', () => {
  test('CRLF line endings do not shift lines or leak \\r into lineText', () => {
    const matches = findMatchesInText(P, 'one\r\ntwo\r\nthree\r\n', 'two', 100);
    expect(matches).toEqual([{ path: P, line: 2, col: 1, lineText: 'two' }]);
  });

  test('a query ending at the line end still matches under CRLF', () => {
    const matches = findMatchesInText(P, 'end\r\n', 'end', 100);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.lineText).toBe('end');
  });
});

describe('findMatchesInText — cap', () => {
  test('stops at the cap, mid-line if necessary', () => {
    const matches = findMatchesInText(P, 'ab ab ab\nab ab\n', 'ab', 4);
    expect(matches).toHaveLength(4);
    expect(matches[3]).toMatchObject({ line: 2, col: 1 });
  });

  test('a non-positive cap yields no matches', () => {
    expect(findMatchesInText(P, 'abc', 'a', 0)).toEqual([]);
    expect(findMatchesInText(P, 'abc', 'a', -1)).toEqual([]);
  });
});

describe('findMatchesInText — clipping', () => {
  test('trims leading whitespace without an ellipsis', () => {
    const matches = findMatchesInText(P, '    indented hit', 'hit', 100);
    expect(matches[0]!.lineText).toBe('indented hit');
    // col still counts from the original (untrimmed) line start.
    expect(matches[0]!.col).toBe(14);
  });

  test('long lines are clipped to ~200 chars centered on the hit', () => {
    const line = 'x'.repeat(300) + 'NEEDLE' + 'y'.repeat(300);
    const matches = findMatchesInText(P, line, 'needle', 100);
    const text = matches[0]!.lineText;
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text).toContain('NEEDLE');
    expect(text.length).toBeLessThanOrEqual(202); // 200 + two ellipses
  });

  test('a hit near the start clips only the tail', () => {
    const line = 'NEEDLE' + 'y'.repeat(400);
    const matches = findMatchesInText(P, line, 'needle', 100);
    expect(matches[0]!.lineText.startsWith('NEEDLE')).toBe(true);
    expect(matches[0]!.lineText.endsWith('…')).toBe(true);
  });

  test('a hit near the end clips only the head', () => {
    const line = 'y'.repeat(400) + 'NEEDLE';
    const matches = findMatchesInText(P, line, 'needle', 100);
    expect(matches[0]!.lineText.startsWith('…')).toBe(true);
    expect(matches[0]!.lineText.endsWith('NEEDLE')).toBe(true);
  });
});

describe('findMatchesInText — unicode and empties', () => {
  test('unicode lowercasing matches across cases', () => {
    const matches = findMatchesInText(P, 'ÜBER straße', 'über', 100);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.col).toBe(1);
  });

  test('empty query yields no matches (defined behavior)', () => {
    expect(findMatchesInText(P, 'anything at all', '', 100)).toEqual([]);
  });

  test('empty text yields no matches', () => {
    expect(findMatchesInText(P, '', 'x', 100)).toEqual([]);
  });
});
