import { describe, expect, test } from 'vitest';
import type { VoiceComment } from '../comments';
import {
  docLocation,
  docTitle,
  filterDocs,
  newestFirst,
  relativeTime,
  sortDocs,
  totalNotes,
  type NoteDoc,
} from '../notes-overview';

function note(id: string, transcript: string, time = '2026-09-10T10:00:00.000Z'): VoiceComment {
  return { id, file: 'a.md', line: 1, quote: `quote ${id}`, time, transcript };
}

const plan: NoteDoc = {
  sidecar: 'C:/ws/Voice Notes/docs/plan.comments.md',
  notePath: 'C:/ws/docs/plan.md',
  notes: [
    note('c1', 'Tighten the intro', '2026-09-10T10:00:00.000Z'),
    { ...note('c2', 'rename it', '2026-09-11T09:00:00.000Z'), unit: 'dirKey (function)' },
  ],
};
const alpha: NoteDoc = {
  sidecar: 'C:/ws/alpha.comments.md',
  notePath: 'C:/ws/alpha.md',
  notes: [note('c3', 'Looks fine', 'not a time')],
};

describe('titles and locations', () => {
  test('the title is the file name; the location is the directory under its root', () => {
    expect(docTitle(plan)).toBe('plan.md');
    expect(docLocation(plan, ['C:/ws'])).toBe('docs');
    expect(docLocation(alpha, ['C:/ws/'])).toBe('');
    // Not under any root: the full directory.
    expect(docLocation(plan, ['D:/other'])).toBe('C:/ws/docs');
    // The deepest containing root wins.
    expect(docLocation(plan, ['C:/ws', 'C:/ws/docs'])).toBe('');
  });
});

describe('filtering and ordering', () => {
  test('a query matches text, quote, declaration or document name; empty docs drop out', () => {
    expect(filterDocs([plan, alpha], 'TIGHTEN').map((d) => d.notes.map((n) => n.id))).toEqual([
      ['c1'],
    ]);
    expect(filterDocs([plan, alpha], 'quote c3')).toHaveLength(1);
    expect(filterDocs([plan, alpha], 'dirkey')[0]?.notes.map((n) => n.id)).toEqual(['c2']);
    expect(filterDocs([plan, alpha], 'alpha').map(docTitle)).toEqual(['alpha.md']);
    expect(filterDocs([plan, alpha], '   ')).toHaveLength(2);
    expect(filterDocs([plan, alpha], 'nothing here')).toEqual([]);
  });

  test('documents sort by name with notes in line order; the stream is newest first with unreadable times last', () => {
    expect(sortDocs([plan, alpha]).map(docTitle)).toEqual(['alpha.md', 'plan.md']);
    const scrambled = {
      ...plan,
      notes: [
        { ...note('z', 'late', '2026-01-02T00:00:00.000Z'), line: null },
        { ...note('b', 'nine'), line: 9 },
        { ...note('a2', 'four, later', '2026-01-02T00:00:00.000Z'), line: 4 },
        { ...note('a1', 'four, earlier', '2026-01-01T00:00:00.000Z'), line: 4 },
      ],
    };
    expect(sortDocs([scrambled])[0]?.notes.map((n) => n.id)).toEqual(['a1', 'a2', 'b', 'z']);
    expect(scrambled.notes[0]?.id).toBe('z'); // the input is left alone
    expect(newestFirst([plan, alpha]).map((n) => n.note.id)).toEqual(['c2', 'c1', 'c3']);
    expect(totalNotes([plan, alpha])).toBe(3);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');
  const at = (iso: string) => relativeTime(iso, now);

  test('reads like a person would say it', () => {
    expect(at('2026-09-11T11:59:30.000Z')).toBe('just now');
    expect(at('2026-09-11T12:00:30.000Z')).toBe('just now'); // a clock that moved
    expect(at('2026-09-11T11:56:00.000Z')).toBe('4 min ago');
    expect(at('2026-09-11T09:00:00.000Z')).toBe('3 h ago');
    expect(at('2026-09-10T11:00:00.000Z')).toBe('yesterday');
    expect(at('2026-09-06T12:00:00.000Z')).toBe('5 days ago');
    expect(at('2026-08-01T12:00:00.000Z')).toBe(
      new Date('2026-08-01T12:00:00.000Z').toLocaleDateString(),
    );
    expect(at('garbage')).toBe('garbage');
  });
});
