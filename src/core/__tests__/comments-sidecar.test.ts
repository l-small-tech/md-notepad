import { describe, expect, test } from 'vitest';
import { notePathFromSidecar, parseReviewContext, serializeCommentsFile } from '../comments';

describe('notePathFromSidecar', () => {
  test('resolves the entry reference against the sidecar directory, keeping its separators', () => {
    expect(
      notePathFromSidecar('C:/ws/Voice Notes/docs/plan.comments.md', '../../docs/plan.md'),
    ).toBe('C:/ws/docs/plan.md');
    expect(notePathFromSidecar('C:\\ws\\plan.comments.md', 'plan.md')).toBe('C:\\ws\\plan.md');
    expect(notePathFromSidecar('saf://tree/Voice Notes/a.comments.md', '../a.md')).toBe(
      'saf://tree/a.md',
    );
    // `..` never climbs past the root.
    expect(notePathFromSidecar('C:/a.comments.md', '../../../a.md')).toBe('C:/a.md');
  });

  test('with no reference the document is the sidecar namesake beside it', () => {
    expect(notePathFromSidecar('C:/ws/plan.comments.md', '')).toBe('C:/ws/plan.md');
    expect(notePathFromSidecar('plan.comments.md', '')).toBe('plan.md');
  });
});

describe('parseReviewContext', () => {
  test('reads back what serializeCommentsFile writes, and nothing when it wrote nothing', () => {
    const context = {
      branch: 'feat/x',
      worktree: 'worktrees/x',
      baseBranch: 'development',
      baseRef: '3c77f30',
    };
    expect(parseReviewContext(serializeCommentsFile([], 'a.md', context))).toEqual(context);
    expect(parseReviewContext(serializeCommentsFile([], 'a.md', { branch: 'main' }))).toEqual({
      branch: 'main',
    });
    expect(parseReviewContext(serializeCommentsFile([], 'a.md'))).toBeUndefined();
  });

  test('only the preamble counts: a note whose text looks like a context line is ignored', () => {
    const text = [
      '# Voice notes for [a.md](a.md)',
      '',
      '## ^c1',
      '- file: a.md',
      '- time: t',
      '',
      '- branch: not-a-context',
      '',
    ].join('\r\n');
    expect(parseReviewContext(text)).toBeUndefined();
  });
});
