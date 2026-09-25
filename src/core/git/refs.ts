/**
 * Ref names and worktree naming — every user-typed string the git tab hands
 * to git is checked HERE first, before any IPC call (Rust's `safe_arg` is the
 * second line, not the first). Pure; no DOM, no Tauri, no React.
 *
 * `validateBranchName` follows `git check-ref-format --branch`: the rules in
 * git-check-ref-format(1) plus the `--branch` extras (no leading `-`, not
 * `HEAD`). `validateSlug` is the worktree directive's "short kebab-case
 * slug" (`workspace-module-texts.ts`, `WORKTREES_DIRECTIVE`).
 */

/** The longest slug the New worktree dialog accepts. */
export const SLUG_MAX = 64;

/** Reason a branch name is invalid, in the user's terms; null when it is fine. */
export function validateBranchName(name: string): string | null {
  if (name === '') {
    return 'Enter a branch name';
  }
  if (name === '@' || name === 'HEAD') {
    return `'${name}' is not a valid branch name`;
  }
  if (name.startsWith('-')) {
    return 'A branch name cannot start with -';
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return 'A branch name cannot start or end with /';
  }
  if (name.endsWith('.')) {
    return 'A branch name cannot end with .';
  }
  if (name.includes('//')) {
    return 'A branch name cannot contain //';
  }
  if (name.includes('..')) {
    return 'A branch name cannot contain ..';
  }
  if (name.includes('@{')) {
    return 'A branch name cannot contain @{';
  }
  // ASCII control characters, DEL, space and git's own metacharacters.
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u001f\u007f ~^:?*[\\]/.exec(name);
  if (bad) {
    const ch = bad[0];
    const shown = ch === ' ' ? 'a space' : ch < ' ' || ch === '\u007f' ? 'a control character' : ch;
    return `A branch name cannot contain ${shown}`;
  }
  for (const component of name.split('/')) {
    if (component.startsWith('.')) {
      return 'A path component of a branch name cannot start with .';
    }
    if (component.endsWith('.lock')) {
      return 'A path component of a branch name cannot end with .lock';
    }
  }
  return null;
}

/** Reason a worktree slug is invalid (kebab-case, ≤ {@link SLUG_MAX}); null when fine. */
export function validateSlug(slug: string): string | null {
  if (slug === '') {
    return 'Enter a slug';
  }
  if (slug.length > SLUG_MAX) {
    return `Keep the slug to ${SLUG_MAX} characters`;
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return 'Use lowercase letters, digits and single hyphens (kebab-case)';
  }
  return null;
}

export interface WorktreeTarget {
  /** Absolute path of the new worktree, forward-slash joined onto `mainRoot`. */
  path: string;
  /** `worktrees/<slug>` — relative to the main root. */
  rel: string;
  /** `<prefix><slug>`. */
  branch: string;
}

/**
 * Where a new worktree goes and what its branch is called, per the
 * directive's convention (`worktrees/<slug>` on `feat/<slug>`). Does not
 * validate — callers run `validateSlug` / `validateBranchName` first.
 */
export function worktreeTarget(
  mainRoot: string,
  slug: string,
  opts: { prefix: string; dir: string },
): WorktreeTarget {
  const dir = opts.dir.replace(/^\/+|\/+$/g, '');
  const rel = `${dir}/${slug}`;
  const root = mainRoot.replace(/[\\/]+$/, '');
  return { path: `${root}/${rel}`, rel, branch: `${opts.prefix}${slug}` };
}

/** The first seven characters — what git itself abbreviates to. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `↑2 ↓1`; either side dropped when zero; `''` when there is nothing to say. */
export function formatAheadBehind(ahead: number | null, behind: number | null): string {
  const parts: string[] = [];
  if (ahead !== null && ahead > 0) {
    parts.push(`↑${ahead}`);
  }
  if (behind !== null && behind > 0) {
    parts.push(`↓${behind}`);
  }
  return parts.join(' ');
}

/**
 * The checkout that has `branch` checked out, or null when none has — git
 * refuses to delete or switch to a branch another worktree holds, so the
 * store asks this before calling.
 */
export function branchForWorktree<T extends { path: string; branch: string | null }>(
  checkouts: readonly T[],
  branch: string,
): T | null {
  return checkouts.find((c) => c.branch === branch) ?? null;
}
