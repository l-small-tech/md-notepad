import { describe, expect, it } from 'vitest';

import { applyChanges, diffToChanges } from '../diff';

function roundTrip(a: string, b: string): void {
  expect(applyChanges(a, diffToChanges(a, b))).toBe(b);
}

describe('diffToChanges', () => {
  it('returns nothing for equal texts', () => {
    expect(diffToChanges('a\nb', 'a\nb')).toEqual([]);
  });

  it('replaces a middle line without touching its neighbours', () => {
    const changes = diffToChanges('a\nb\nc\n', 'a\nB\nc\n');
    expect(changes).toEqual([{ from: 2, to: 4, insert: 'B\n' }]);
  });

  it('inserts lines before an existing one', () => {
    expect(diffToChanges('a\nc\n', 'a\nb\nc\n')).toEqual([{ from: 2, to: 2, insert: 'b\n' }]);
  });

  it('deletes the last line together with the newline before it', () => {
    expect(diffToChanges('a\nb', 'a')).toEqual([{ from: 1, to: 3, insert: '' }]);
    roundTrip('a\nb', 'a');
  });

  it('appends at the end without a trailing newline', () => {
    expect(diffToChanges('a', 'a\nb')).toEqual([{ from: 1, to: 1, insert: '\nb' }]);
    roundTrip('a', 'a\nb');
  });

  it('round-trips assorted edits, including CRLF and empty texts', () => {
    const cases: Array<[string, string]> = [
      ['', 'x'],
      ['x', ''],
      ['a\nb\nc', 'c\nb\na'],
      ['a\r\nb\r\n', 'a\r\nB\r\nc\r\n'],
      ['one\ntwo\nthree\n', 'zero\none\nthree\nfour\n'],
      ['a\n\n\nb', 'a\nb'],
      ['x\n', 'x'],
      ['x', 'x\n'],
    ];
    for (const [a, b] of cases) {
      roundTrip(a, b);
    }
  });

  it('produces changes in ascending, non-overlapping order', () => {
    const changes = diffToChanges('a\nb\nc\nd\ne\n', 'A\nb\nc\nD\ne\n');
    expect(changes).toHaveLength(2);
    expect(changes[0]!.to).toBeLessThanOrEqual(changes[1]!.from);
  });
});
