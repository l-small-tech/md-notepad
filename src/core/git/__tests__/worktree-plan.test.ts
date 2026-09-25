import { describe, expect, test } from 'vitest';
import { appendMissingLines, planNewWorktree, WORKTREES_IGNORE_LINE } from '../worktree-plan';

describe('planNewWorktree', () => {
  const input = {
    mainRoot: 'C:/repo',
    slug: 'git-tab',
    prefix: 'feat/',
    base: '',
    openTerminal: 'harness' as const,
  };

  test('the directive convention: worktrees/<slug> on <prefix><slug>', () => {
    expect(planNewWorktree(input)).toEqual({
      ok: true,
      plan: {
        path: 'C:/repo/worktrees/git-tab',
        rel: 'worktrees/git-tab',
        branch: 'feat/git-tab',
        startPoint: null,
        gitignoreLine: WORKTREES_IGNORE_LINE,
        terminal: 'harness',
      },
    });
    expect(
      planNewWorktree({ ...input, base: ' development ', openTerminal: 'none' }),
    ).toMatchObject({
      ok: true,
      plan: { startPoint: 'development', terminal: 'none' },
    });
  });

  test('a bad slug, a bad prefix or a bad start point is an error before any git call', () => {
    expect(planNewWorktree({ ...input, slug: 'Git Tab' })).toEqual({
      ok: false,
      error: 'Use lowercase letters, digits and single hyphens (kebab-case)',
    });
    expect(planNewWorktree({ ...input, slug: '' })).toEqual({ ok: false, error: 'Enter a slug' });
    expect(planNewWorktree({ ...input, prefix: 'feat..' })).toEqual({
      ok: false,
      error: 'A branch name cannot contain ..',
    });
    expect(planNewWorktree({ ...input, base: '-x' })).toEqual({
      ok: false,
      error: 'Start point: A branch name cannot start with -',
    });
  });
});

describe('appendMissingLines', () => {
  test('appends the lines the file lacks, ending in a newline', () => {
    expect(appendMissingLines('node_modules/\r\n', ['worktrees/'])).toBe(
      'node_modules/\r\nworktrees/\n',
    );
    expect(appendMissingLines('a\n\n\n', ['b', 'c'])).toBe('a\nb\nc\n');
    expect(appendMissingLines('no newline', ['x'])).toBe('no newline\nx\n');
  });

  test('null when every line is present (trimmed); blank lines are never appended', () => {
    expect(appendMissingLines('  worktrees/  \n', ['worktrees/', ''])).toBeNull();
    expect(appendMissingLines('', ['', '  '])).toBeNull();
  });

  test('an empty file gets just the lines', () => {
    expect(appendMissingLines('', ['worktrees/'])).toBe('worktrees/\n');
  });
});
