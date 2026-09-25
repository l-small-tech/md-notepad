import { describe, expect, test } from 'vitest';
import {
  conflictMarkerLines,
  continueGate,
  countConflictBlocks,
  hasConflictMarkers,
  trackerProgress,
} from '../conflicts';
import type { ConflictTracker } from '../types';

const block = (ours: string, theirs: string, label = 'HEAD') =>
  `<<<<<<< ${label}\n${ours}\n=======\n${theirs}\n>>>>>>> feat/x\n`;

describe('marker scan', () => {
  test('a complete block is found, with its marker lines', () => {
    const text = `line 1\n${block('mine', 'theirs')}line 7\n`;
    expect(hasConflictMarkers(text)).toBe(true);
    expect(countConflictBlocks(text)).toBe(1);
    expect(conflictMarkerLines(text)).toEqual([2, 4, 6]);
  });

  test('CRLF endings and diff3 base markers are tolerated', () => {
    const crlf = `a\r\n<<<<<<< HEAD\r\nx\r\n||||||| merged common ancestors\r\nbase\r\n=======\r\ny\r\n>>>>>>> theirs\r\nb\r\n`;
    expect(hasConflictMarkers(crlf)).toBe(true);
    expect(conflictMarkerLines(crlf)).toEqual([2, 4, 6, 8]);
  });

  test('a lone ======= (a setext heading) is not a conflict', () => {
    expect(hasConflictMarkers('Title\n=======\n\nbody\n')).toBe(false);
    expect(hasConflictMarkers('<<<<<<< HEAD\nunfinished\n')).toBe(false);
    expect(hasConflictMarkers('=======\n>>>>>>> x\n')).toBe(false);
    expect(hasConflictMarkers('resolved text\n')).toBe(false);
    expect(hasConflictMarkers('')).toBe(false);
  });

  test('several blocks count separately; a second opener restarts an unfinished one', () => {
    const text = `${block('a', 'b')}middle\n<<<<<<< HEAD\nlost\n${block('c', 'd')}`;
    expect(countConflictBlocks(text)).toBe(2);
    expect(conflictMarkerLines(text)).toEqual([1, 3, 5, 9, 11, 13]);
  });

  test('markers must start the line', () => {
    expect(hasConflictMarkers(' <<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n')).toBe(false);
    expect(hasConflictMarkers('<<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n')).toBe(false);
  });
});

describe('continueGate', () => {
  const tracker: ConflictTracker = {
    root: 'C:/repo',
    into: 'development',
    from: 'feat/x',
    files: ['a.ts', 'b.ts'],
    markerFree: { 'a.ts': true, 'b.ts': false },
  };

  test('unmerged entries block first, then unscanned or dirty files', () => {
    expect(continueGate(2, tracker)).toEqual({
      enabled: false,
      reason: '2 files are still unmerged',
    });
    expect(continueGate(1, null)).toEqual({ enabled: false, reason: '1 file is still unmerged' });
    expect(continueGate(0, tracker)).toEqual({
      enabled: false,
      reason: 'Conflict markers remain in b.ts',
    });
    expect(continueGate(0, { ...tracker, markerFree: {} })).toEqual({
      enabled: false,
      reason: 'Conflict markers remain in 2 files',
    });
  });

  test('enabled when git and the scan both say clean, or with no tracker', () => {
    expect(continueGate(0, { ...tracker, markerFree: { 'a.ts': true, 'b.ts': true } })).toEqual({
      enabled: true,
      reason: null,
    });
    expect(continueGate(0, null)).toEqual({ enabled: true, reason: null });
  });

  test('trackerProgress counts clean files', () => {
    expect(trackerProgress(tracker)).toEqual({ clean: 1, total: 2 });
  });
});
