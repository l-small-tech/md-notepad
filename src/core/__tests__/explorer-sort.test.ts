import { describe, expect, test } from 'vitest';
import { compareEntryNames, sortExplorerEntries } from '../explorer-sort';

function dir(name: string) {
  return { name, isDir: true };
}
function file(name: string) {
  return { name, isDir: false };
}
function names(entries: readonly { name: string }[]): string[] {
  return entries.map((e) => e.name);
}

describe('compareEntryNames', () => {
  test('plain A→Z', () => {
    expect(compareEntryNames('alpha.md', 'beta.md')).toBeLessThan(0);
    expect(compareEntryNames('beta.md', 'alpha.md')).toBeGreaterThan(0);
  });

  test('digit runs compare as numbers, not text', () => {
    expect(compareEntryNames('note2.md', 'note10.md')).toBeLessThan(0);
    expect(compareEntryNames('chapter 9', 'chapter 11')).toBeLessThan(0);
  });

  test('case is ignored for ordering', () => {
    expect(compareEntryNames('apple.md', 'Banana.md')).toBeLessThan(0);
    expect(compareEntryNames('Banana.md', 'cherry.md')).toBeLessThan(0);
  });

  test('names differing only in case still order deterministically', () => {
    expect(compareEntryNames('notes.md', 'Notes.md')).not.toBe(0);
    expect(compareEntryNames('notes.md', 'Notes.md')).toBe(
      -compareEntryNames('Notes.md', 'notes.md'),
    );
  });

  test('identical names compare equal', () => {
    expect(compareEntryNames('notes.md', 'notes.md')).toBe(0);
  });
});

describe('sortExplorerEntries', () => {
  test('folders first, then files, each A→Z', () => {
    const sorted = sortExplorerEntries([
      file('zebra.md'),
      dir('src'),
      file('apple.md'),
      dir('Assets'),
    ]);
    expect(names(sorted)).toEqual(['Assets', 'src', 'apple.md', 'zebra.md']);
  });

  test('files are ordered by name, not by mtime', () => {
    const sorted = sortExplorerEntries([
      { name: 'b.md', isDir: false, mtimeMs: 900 },
      { name: 'a.md', isDir: false, mtimeMs: 100 },
    ]);
    expect(names(sorted)).toEqual(['a.md', 'b.md']);
  });

  test('numeric runs sort naturally within each group', () => {
    const sorted = sortExplorerEntries([
      file('note10.md'),
      file('note2.md'),
      dir('week10'),
      dir('week2'),
    ]);
    expect(names(sorted)).toEqual(['week2', 'week10', 'note2.md', 'note10.md']);
  });

  test('does not mutate the input', () => {
    const input = [file('b.md'), file('a.md')];
    sortExplorerEntries(input);
    expect(names(input)).toEqual(['b.md', 'a.md']);
  });
});
