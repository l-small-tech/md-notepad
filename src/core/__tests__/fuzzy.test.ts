import { describe, expect, test } from 'vitest';
import { fuzzyScore, rankCandidates } from '../fuzzy';

describe('fuzzyScore', () => {
  test('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'New tab')).toBeNull();
    expect(fuzzyScore('tba', 'tab')).toBeNull(); // order matters
  });

  test('matches a scattered subsequence', () => {
    expect(fuzzyScore('nta', 'New tab')).not.toBeNull();
    expect(fuzzyScore('svas', 'Save as')).not.toBeNull();
  });

  test('is case-insensitive both ways', () => {
    expect(fuzzyScore('NEW', 'new tab')).not.toBeNull();
    expect(fuzzyScore('new', 'NEW TAB')).not.toBeNull();
    expect(fuzzyScore('NeW', 'nEw tab')).toEqual(fuzzyScore('new', 'new tab'));
  });

  test('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('', '')).toBe(0);
  });

  test('word-start matches beat scattered mid-word matches', () => {
    // 'nt' hits both word starts of "New tab" but is buried inside "notation".
    expect(fuzzyScore('nt', 'New tab')!).toBeGreaterThan(fuzzyScore('nt', 'notation')!);
  });

  test('contiguous runs beat scattered matches', () => {
    // 'tab' is one run in "New tab" but scattered across "xtxaxb".
    const scattered = fuzzyScore('tab', 'xtxaxb');
    expect(scattered).not.toBeNull();
    expect(fuzzyScore('tab', 'New tab')!).toBeGreaterThan(scattered!);
  });

  test('unicode characters match case-insensitively', () => {
    expect(fuzzyScore('É', 'café')).not.toBeNull();
    expect(fuzzyScore('ß', 'straße')).not.toBeNull();
    expect(fuzzyScore('ö', 'plain')).toBeNull();
  });
});

describe('rankCandidates', () => {
  const titles = (items: { title: string }[]) => items.map((i) => i.title);

  test('filters out non-matches', () => {
    const items = [{ title: 'New tab' }, { title: 'Save' }, { title: 'Close tab' }];
    expect(titles(rankCandidates('tab', items, (i) => i.title))).toEqual(['New tab', 'Close tab']);
  });

  test('sorts by score descending (word-start match outranks a buried one)', () => {
    const items = [{ title: 'notation' }, { title: 'New tab' }];
    expect(titles(rankCandidates('nt', items, (i) => i.title))).toEqual(['New tab', 'notation']);
  });

  test('the best-scoring candidate ranks first regardless of input order', () => {
    const items = [{ title: 'xtxaxb' }, { title: 'New tab' }];
    expect(titles(rankCandidates('tab', items, (i) => i.title))).toEqual(['New tab', 'xtxaxb']);
  });

  test('empty query returns everything in original order', () => {
    const items = [{ title: 'b' }, { title: 'a' }, { title: 'c' }];
    expect(titles(rankCandidates('', items, (i) => i.title))).toEqual(['b', 'a', 'c']);
  });

  test('ties keep the original order (stable)', () => {
    const items = [{ title: 'alpha one' }, { title: 'alpha two' }, { title: 'alpha born' }];
    // 'al' scores identically on all three (same prefix), so order is preserved.
    expect(titles(rankCandidates('al', items, (i) => i.title))).toEqual([
      'alpha one',
      'alpha two',
      'alpha born',
    ]);
  });
});
