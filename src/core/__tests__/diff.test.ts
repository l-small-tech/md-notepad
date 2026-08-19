import { describe, expect, test } from 'vitest';
import { buildDiffRows, diffLines, diffStats, type DiffOp } from '../diff';

/** Rebuild both texts from the ops — the round-trip invariant every diff
 *  must satisfy regardless of which edit script it picked. */
function reconstruct(ops: DiffOp[]): { old: string; new: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const op of ops) {
    if (op.type !== 'insert') {
      oldLines.push(...op.lines);
    }
    if (op.type !== 'delete') {
      newLines.push(...op.lines);
    }
  }
  return { old: oldLines.join('\n'), new: newLines.join('\n') };
}

describe('diffLines', () => {
  test('identical texts yield a single equal op', () => {
    const ops = diffLines('a\nb\nc', 'a\nb\nc');
    expect(ops).toEqual([{ type: 'equal', lines: ['a', 'b', 'c'], oldStart: 0, newStart: 0 }]);
  });

  test('a changed line becomes delete + insert between equal context', () => {
    const ops = diffLines('a\nb\nc', 'a\nX\nc');
    expect(ops.map((o) => o.type)).toEqual(['equal', 'delete', 'insert', 'equal']);
    expect(ops[1]!.lines).toEqual(['b']);
    expect(ops[2]!.lines).toEqual(['X']);
    expect(ops[2]!.newStart).toBe(1);
  });

  test('pure insertion and pure deletion', () => {
    expect(diffLines('a\nc', 'a\nb\nc').map((o) => o.type)).toEqual(['equal', 'insert', 'equal']);
    expect(diffLines('a\nb\nc', 'a\nc').map((o) => o.type)).toEqual(['equal', 'delete', 'equal']);
  });

  test('round-trips arbitrary edits', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['', 'a\nb'],
      ['a\nb', ''],
      ['a\nb\nc\nd\ne', 'a\nc\nX\nd\nY\ne\nf'],
      ['x\nx\nx\nx', 'x\nx'],
      ['one\ntwo\nthree', 'THREE\ntwo\none'],
    ];
    for (const [oldText, newText] of cases) {
      const r = reconstruct(diffLines(oldText, newText));
      expect(r.old).toBe(oldText);
      expect(r.new).toBe(newText);
    }
  });

  test('minimality on a classic case (abcabba → cbabac)', () => {
    const ops = diffLines('a\nb\nc\na\nb\nb\na', 'c\nb\na\nb\na\nc');
    const { added, removed } = diffStats(ops);
    expect(added + removed).toBe(5); // Myers' canonical D=5 example
  });

  test('CRLF is significant, not normalized', () => {
    const ops = diffLines('a\r\nb', 'a\nb');
    expect(ops.some((o) => o.type !== 'equal')).toBe(true);
  });

  test('huge pathological inputs fall back to one delete+insert block', () => {
    const oldText = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
    const newText = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
    const ops = diffLines(oldText, newText);
    const r = reconstruct(ops);
    expect(r.old).toBe(oldText);
    expect(r.new).toBe(newText);
  });
});

describe('diffStats', () => {
  test('counts added and removed lines', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nX\nY\nc'))).toEqual({ added: 2, removed: 1 });
    expect(diffStats(diffLines('a', 'a'))).toEqual({ added: 0, removed: 0 });
  });
});

describe('buildDiffRows', () => {
  test('equal lines pair up with matching numbers', () => {
    const rows = buildDiffRows(diffLines('a\nb', 'a\nb'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.left).toMatchObject({ num: 1, text: 'a', changed: false });
    expect(rows[0]!.right).toMatchObject({ num: 1, text: 'a', changed: false });
  });

  test('a modified line is paired on one row with intra-line ranges', () => {
    const rows = buildDiffRows(diffLines('hello world', 'hello there'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.left).toMatchObject({ num: 1, changed: true });
    expect(row.right).toMatchObject({ num: 1, changed: true });
    // The common prefix "hello " is excluded from the changed range.
    expect(row.left!.hi![0]).toBe(6);
    expect(row.right!.hi![0]).toBe(6);
    expect(row.left!.text.slice(...row.left!.hi!)).toBe('world');
    expect(row.right!.text.slice(...row.right!.hi!)).toBe('there');
  });

  test('unbalanced change blocks leave null partners', () => {
    const rows = buildDiffRows(diffLines('a\nb\nc', 'a\nX\nY\nZ\nc'));
    // b→X paired, then Y and Z inserted with no left partner.
    const changed = rows.filter((r) => r.left?.changed || r.right?.changed);
    expect(changed).toHaveLength(3);
    expect(changed[0]!.left).not.toBeNull();
    expect(changed[1]!.left).toBeNull();
    expect(changed[2]!.left).toBeNull();
    expect(changed[2]!.right).toMatchObject({ num: 4, text: 'Z' });
  });

  test('display text strips a trailing \\r, line numbering stays per side', () => {
    const rows = buildDiffRows(diffLines('a\r\nb', 'a\nb\nc'));
    expect(rows.every((r) => !(r.left?.text.includes('\r') || r.right?.text.includes('\r')))).toBe(
      true,
    );
    const last = rows[rows.length - 1]!;
    expect(last.left).toBeNull();
    expect(last.right).toMatchObject({ num: 3, text: 'c' });
  });

  test('whole-line replacement with nothing in common highlights the full line', () => {
    const rows = buildDiffRows(diffLines('abc', 'xyz'));
    expect(rows[0]!.left!.hi).toEqual([0, 3]);
    expect(rows[0]!.right!.hi).toEqual([0, 3]);
  });
});
