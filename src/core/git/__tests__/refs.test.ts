import { describe, expect, test } from 'vitest';
import {
  branchForWorktree,
  formatAheadBehind,
  shortSha,
  SLUG_MAX,
  validateBranchName,
  validateSlug,
  worktreeTarget,
} from '../refs';

describe('validateBranchName (check-ref-format --branch)', () => {
  test('accepts ordinary names', () => {
    for (const name of ['main', 'feat/git-tab', 'release-1.2', 'a/b/c', 'UPPER', 'x_y', 'v1.0.0']) {
      expect(validateBranchName(name), name).toBeNull();
    }
  });

  test.each([
    ['', 'Enter a branch name'],
    ['HEAD', "'HEAD' is not a valid branch name"],
    ['@', "'@' is not a valid branch name"],
    ['-x', 'A branch name cannot start with -'],
    ['/x', 'A branch name cannot start or end with /'],
    ['x/', 'A branch name cannot start or end with /'],
    ['x.', 'A branch name cannot end with .'],
    ['a//b', 'A branch name cannot contain //'],
    ['a..b', 'A branch name cannot contain ..'],
    ['a@{b', 'A branch name cannot contain @{'],
    ['a b', 'A branch name cannot contain a space'],
    ['a~b', 'A branch name cannot contain ~'],
    ['a^b', 'A branch name cannot contain ^'],
    ['a:b', 'A branch name cannot contain :'],
    ['a?b', 'A branch name cannot contain ?'],
    ['a*b', 'A branch name cannot contain *'],
    ['a[b', 'A branch name cannot contain ['],
    ['a\\b', 'A branch name cannot contain \\'],
    ['a\u0007b', 'A branch name cannot contain a control character'],
    ['.hidden', 'A path component of a branch name cannot start with .'],
    ['a/.b', 'A path component of a branch name cannot start with .'],
    ['a.lock', 'A path component of a branch name cannot end with .lock'],
    ['a.lock/b', 'A path component of a branch name cannot end with .lock'],
  ])('rejects %j', (name, message) => {
    expect(validateBranchName(name)).toBe(message);
  });
});

describe('validateSlug', () => {
  test('kebab-case up to the limit', () => {
    expect(validateSlug('git-tab')).toBeNull();
    expect(validateSlug('a1-b2-c3')).toBeNull();
    expect(validateSlug('x'.repeat(SLUG_MAX))).toBeNull();
  });

  test('rejects empty, long, cased, spaced and doubled-hyphen slugs', () => {
    expect(validateSlug('')).toBe('Enter a slug');
    expect(validateSlug('x'.repeat(SLUG_MAX + 1))).toBe(`Keep the slug to ${SLUG_MAX} characters`);
    for (const bad of ['Git-Tab', 'git tab', 'git--tab', '-git', 'git-', 'git_tab', 'gît']) {
      expect(validateSlug(bad), bad).toBe(
        'Use lowercase letters, digits and single hyphens (kebab-case)',
      );
    }
  });
});

describe('worktreeTarget', () => {
  test('joins the directive path onto the main root with forward slashes', () => {
    expect(worktreeTarget('C:\\repo\\', 'git-tab', { prefix: 'feat/', dir: 'worktrees' })).toEqual({
      path: 'C:\\repo/worktrees/git-tab',
      rel: 'worktrees/git-tab',
      branch: 'feat/git-tab',
    });
    expect(worktreeTarget('/home/u/repo', 'x', { prefix: '', dir: '/wt/' })).toEqual({
      path: '/home/u/repo/wt/x',
      rel: 'wt/x',
      branch: 'x',
    });
  });
});

describe('small formatters', () => {
  test('shortSha takes seven characters', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
    expect(shortSha('abc')).toBe('abc');
  });

  test('formatAheadBehind drops zero and unknown sides', () => {
    expect(formatAheadBehind(2, 1)).toBe('↑2 ↓1');
    expect(formatAheadBehind(0, 3)).toBe('↓3');
    expect(formatAheadBehind(4, null)).toBe('↑4');
    expect(formatAheadBehind(null, null)).toBe('');
    expect(formatAheadBehind(0, 0)).toBe('');
  });
});

describe('branchForWorktree', () => {
  const checkouts = [
    { path: 'C:/repo', branch: 'development' },
    { path: 'C:/repo/worktrees/x', branch: 'feat/x' },
    { path: 'C:/repo/worktrees/d', branch: null },
  ];

  test('finds the checkout holding the branch, main included', () => {
    expect(branchForWorktree(checkouts, 'feat/x')?.path).toBe('C:/repo/worktrees/x');
    expect(branchForWorktree(checkouts, 'development')?.path).toBe('C:/repo');
    expect(branchForWorktree(checkouts, 'feat/free')).toBeNull();
  });
});
