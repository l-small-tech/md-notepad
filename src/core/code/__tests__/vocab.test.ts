import { describe, expect, test } from 'vitest';
import {
  identifierHint,
  MIN_SNAP_LETTERS,
  snapIdentifiers,
  SNAP_STOP_WORDS,
  splitIdentifier,
  undoSnap,
} from '../vocab';

describe('splitIdentifier', () => {
  test('splits camelCase, PascalCase and acronym runs', () => {
    expect(splitIdentifier('showAllFilesState')).toEqual(['show', 'all', 'files', 'state']);
    expect(splitIdentifier('ShowAllFilesState')).toEqual(['show', 'all', 'files', 'state']);
    expect(splitIdentifier('HTTPServer')).toEqual(['http', 'server']);
    expect(splitIdentifier('parseHTML')).toEqual(['parse', 'html']);
  });

  test('splits snake_case, SCREAMING_CASE, kebab and paths', () => {
    expect(splitIdentifier('is_markdown_path')).toEqual(['is', 'markdown', 'path']);
    expect(splitIdentifier('WHISPER_SAMPLE_RATE')).toEqual(['whisper', 'sample', 'rate']);
    expect(splitIdentifier('text-files')).toEqual(['text', 'files']);
    expect(splitIdentifier('crate::commands::fs')).toEqual(['crate', 'commands', 'fs']);
  });

  test('digits are their own word', () => {
    expect(splitIdentifier('utf8Text')).toEqual(['utf', '8', 'text']);
    expect(splitIdentifier('sha256')).toEqual(['sha', '256']);
  });

  test('is empty for nothing pronounceable', () => {
    expect(splitIdentifier('')).toEqual([]);
    expect(splitIdentifier('__')).toEqual([]);
  });
});

describe('identifierHint', () => {
  test('is the spoken words of each identifier, comma separated', () => {
    expect(identifierHint(['showAllFilesState', 'isMarkdownPath'])).toBe(
      'show all files state, is markdown path',
    );
  });

  test('dedupes names that say the same words', () => {
    expect(identifierHint(['isMarkdownPath', 'is_markdown_path', 'IsMarkdownPath'])).toBe(
      'is markdown path',
    );
  });

  test('caps on a phrase boundary rather than mid-word', () => {
    const hint = identifierHint(['showAllFilesState', 'isMarkdownPath', 'dirKey'], 25);
    expect(hint).toBe('show all files state');
    expect(identifierHint(['showAllFilesState'], 5)).toBe('');
  });

  test('is empty for no identifiers', () => {
    expect(identifierHint([])).toBe('');
  });
});

const IDS = [
  'showsAllFiles',
  'showAllFilesState',
  'isMarkdownPath',
  'isAtOrBelow',
  'dirKey',
  'pathKey',
  'name',
  'path',
  'run',
];

describe('snapIdentifiers', () => {
  test('spoken words become the real, backticked name', () => {
    const { text, snaps } = snapIdentifiers('shows all files looks wrong', IDS);
    expect(text).toBe('`showsAllFiles` looks wrong');
    expect(snaps).toEqual([{ from: 'shows all files', to: '`showsAllFiles`', index: 0 }]);
  });

  test('snaps mid-sentence and reports where the replacement landed', () => {
    const { text, snaps } = snapIdentifiers('I think is markdown path is fine.', IDS);
    expect(text).toBe('I think `isMarkdownPath` is fine.');
    expect(snaps).toHaveLength(1);
    expect(text.slice(snaps[0]!.index)).toBe('`isMarkdownPath` is fine.');
  });

  test('prefers the longest match', () => {
    const { text } = snapIdentifiers('show all files state returns two flags', IDS);
    expect(text).toBe('`showAllFilesState` returns two flags');
  });

  test('snaps every occurrence, in text order', () => {
    const { text, snaps } = snapIdentifiers('dir key and path key differ', IDS);
    expect(text).toBe('`dirKey` and `pathKey` differ');
    expect(snaps.map((s) => s.to)).toEqual(['`dirKey`', '`pathKey`']);
    expect(snaps.map((s) => text.slice(s.index, s.index + s.to.length))).toEqual([
      '`dirKey`',
      '`pathKey`',
    ]);
  });

  test('tolerates a mishearing that is still spelled out of the name', () => {
    expect(snapIdentifiers('show all files is the one', IDS).text).toBe(
      '`showsAllFiles` is the one',
    );
  });

  test('near misses are left alone', () => {
    // Wrong letters, not just missing ones: not a subsequence of any name.
    expect(snapIdentifiers('is marked path', IDS).snaps).toEqual([]);
    expect(snapIdentifiers('is below or at', IDS).snaps).toEqual([]);
    // Far too few of the name's letters to be that name.
    expect(snapIdentifiers('all files', IDS).snaps).toEqual([]);
    expect(snapIdentifiers('the state of it', IDS).snaps).toEqual([]);
  });

  test('a single word that is ordinary English is never snapped', () => {
    const english = 'read the name of the next path and run it';
    expect(snapIdentifiers(english, [...IDS, 'read', 'next']).text).toBe(english);
    for (const word of ['name', 'show', 'path', 'file', 'dir', 'key', 'value', 'text', 'line']) {
      expect(SNAP_STOP_WORDS.has(word)).toBe(true);
      expect(snapIdentifiers(`the ${word} matters`, [word]).snaps).toEqual([]);
    }
  });

  test('a multi-word name still snaps even though its words are common', () => {
    expect(snapIdentifiers('path key', ['pathKey', 'path', 'key']).text).toBe('`pathKey`');
  });

  test('a run never crosses punctuation or a line break', () => {
    expect(snapIdentifiers('shows all. Files are gone', IDS).snaps).toEqual([]);
    expect(snapIdentifiers('is markdown\npath', IDS).snaps).toEqual([]);
  });

  test('leaves an already-snapped name alone (running twice is a no-op)', () => {
    const once = snapIdentifiers('shows all files is fine', IDS);
    const twice = snapIdentifiers(once.text, IDS);
    expect(twice.text).toBe(once.text);
    expect(twice.snaps).toEqual([]);
  });

  test('a run below the letter minimum cannot snap', () => {
    expect(MIN_SNAP_LETTERS).toBe(3);
    expect(snapIdentifiers('id', ['id']).snaps).toEqual([]);
  });

  test('no identifiers, or empty text, changes nothing', () => {
    expect(snapIdentifiers('shows all files', [])).toEqual({ text: 'shows all files', snaps: [] });
    expect(snapIdentifiers('', IDS)).toEqual({ text: '', snaps: [] });
  });
});

describe('undoSnap', () => {
  test('puts one replacement back and keeps the others pointing at their text', () => {
    const snapped = snapIdentifiers('dir key and path key differ', IDS);
    const first = undoSnap(snapped.text, snapped.snaps, 0);
    expect(first.text).toBe('dir key and `pathKey` differ');
    expect(first.snaps).toHaveLength(1);
    expect(first.text.slice(first.snaps[0]!.index)).toBe('`pathKey` differ');

    const both = undoSnap(first.text, first.snaps, 0);
    expect(both.text).toBe('dir key and path key differ');
    expect(both.snaps).toEqual([]);
  });

  test('an out-of-range index, or text that moved on, changes nothing', () => {
    const snapped = snapIdentifiers('dir key differs', IDS);
    expect(undoSnap(snapped.text, snapped.snaps, 7)).toEqual(snapped);
    const edited = `edited ${snapped.text}`;
    expect(undoSnap(edited, snapped.snaps, 0)).toEqual({ text: edited, snaps: snapped.snaps });
  });
});
