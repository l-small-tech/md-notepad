import { describe, expect, test } from 'vitest';
import { skeletonMaxDepth, xrayLines, type SkeletonLine } from '../model';

const line = (n: number, depth: number, text = `L${n}`): SkeletonLine => ({
  line: n,
  depth,
  text,
  hiddenLines: 0,
});

const skeleton: SkeletonLine[] = [
  line(1, 0, 'fn f() {'),
  line(2, 2, '  a();'),
  line(3, 2, '  b();'),
  line(4, 1, '  if (x) {'),
  line(5, 3, '    c();'),
  line(6, 2, '    for (…) {'),
  line(7, 4, '      d();'),
  line(8, 2, '    }'),
  line(9, 1, '  }'),
  line(10, 1, '  return y;'),
  line(11, 0, '}'),
];

describe('xrayLines', () => {
  test('depth 0 keeps only the signature and folds the whole body', () => {
    expect(xrayLines(skeleton, 0)).toEqual([
      skeleton[0],
      { line: 2, depth: 1, text: '⋯ 9 lines', hiddenLines: 9 },
      skeleton[10],
    ]);
  });

  test('depth 1 keeps top-level control flow; each deeper run is one marker', () => {
    expect(xrayLines(skeleton, 1).map((l) => l.text)).toEqual([
      'fn f() {',
      '⋯ 2 lines',
      '  if (x) {',
      '⋯ 4 lines',
      '  }',
      '  return y;',
      '}',
    ]);
  });

  test('a single hidden line reads "1 line"', () => {
    expect(xrayLines(skeleton, 3).map((l) => l.text)).toContain('⋯ 1 line');
  });

  test('opening one marker raises the depth for that run only', () => {
    const opened = new Map([[5, 2]]);
    expect(xrayLines(skeleton, 1, opened).map((l) => l.text)).toEqual([
      'fn f() {',
      '⋯ 2 lines',
      '  if (x) {',
      '⋯ 1 line',
      '    for (…) {',
      '⋯ 1 line',
      '    }',
      '  }',
      '  return y;',
      '}',
    ]);
    // Opening a run to a depth not deeper than the view is a no-op.
    expect(xrayLines(skeleton, 1, new Map([[5, 1]]))).toEqual(xrayLines(skeleton, 1));
  });

  test('at the max depth nothing is folded', () => {
    expect(skeletonMaxDepth(skeleton)).toBe(4);
    expect(xrayLines(skeleton, 4)).toEqual(skeleton);
    expect(xrayLines([], 1)).toEqual([]);
  });
});
