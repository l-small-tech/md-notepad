import { describe, expect, test } from 'vitest';
import type { VoiceComment } from '../comments';
import { blockLineFor, notesByBlock, notesForUnit, unitNoteLabel } from '../note-marks';

function note(id: string, line: number | null, unit?: string): VoiceComment {
  return {
    id,
    file: 'a.md',
    line,
    quote: '',
    time: '2026-01-01T00:00:00.000Z',
    transcript: id,
    unit,
  };
}

describe('notesByBlock', () => {
  test('a block owns the notes from its first line up to the next block', () => {
    const grouped = notesByBlock(
      [note('a', 1), note('b', 3), note('c', 4), note('d', 9)],
      [1, 4, 8],
    );
    expect([...grouped.keys()]).toEqual([1, 4, 8]);
    expect(grouped.get(1)!.map((n) => n.id)).toEqual(['a', 'b']);
    expect(grouped.get(4)!.map((n) => n.id)).toEqual(['c']);
    expect(grouped.get(8)!.map((n) => n.id)).toEqual(['d']);
  });

  test('a note above the first block belongs to it; unsorted and duplicate block lines are fine', () => {
    const grouped = notesByBlock([note('fm', 1)], [7, 3, 3]);
    expect([...grouped.entries()]).toEqual([[3, [note('fm', 1)]]]);
  });

  test('notes without a line and an empty document produce nothing', () => {
    expect(notesByBlock([note('x', null)], [1]).size).toBe(0);
    expect(notesByBlock([note('x', 1)], []).size).toBe(0);
  });
});

describe('notesForUnit', () => {
  const unit = { name: 'save', kind: 'function', signatureLine: 12 };

  test('matches by the declaration label, and by signature line for label-less notes', () => {
    const notes = [
      note('named', 40, 'save (function)'),
      note('other', 12, 'load (function)'),
      note('bare', 12),
      note('elsewhere', 13),
    ];
    expect(notesForUnit(notes, unit).map((n) => n.id)).toEqual(['named', 'bare']);
  });

  test('the label is what the sheet stores on a code note', () => {
    expect(unitNoteLabel(unit)).toBe('save (function)');
  });
});

describe('blockLineFor', () => {
  test('the block a line falls in, by the same rule the grouping uses', () => {
    expect(blockLineFor(5, [1, 4, 8])).toBe(4);
    expect(blockLineFor(4, [8, 1, 4])).toBe(4);
    expect(blockLineFor(1, [3, 7])).toBe(3); // front matter → the first block
    expect(blockLineFor(20, [3, 7])).toBe(7);
    expect(blockLineFor(2, [])).toBeUndefined();
  });
});
