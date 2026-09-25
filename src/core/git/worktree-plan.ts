/**
 * New worktree — the plan behind the one-click button: validate the slug and
 * the branch it implies, name the path, and say what `.gitignore` needs.
 * Pure; no DOM, no Tauri, no React.
 *
 * `appendMissingLines` is the `.gitignore` seeding rule Initialize Workspace
 * uses (`workspace-modules.ts`, `ensureLines`), extracted so the store can
 * add `worktrees/` to an existing ignore file the same way.
 */

import { validateBranchName, validateSlug, worktreeTarget } from './refs';

/** The directory linked worktrees live in, under the main root (the directive's convention). */
export const WORKTREES_DIR = 'worktrees';

/** The `.gitignore` line that keeps them out of the index. */
export const WORKTREES_IGNORE_LINE = `${WORKTREES_DIR}/`;

export type NewWorktreeTerminalChoice = 'none' | 'shell' | 'harness';

export interface NewWorktreeInput {
  mainRoot: string;
  slug: string;
  /** Branch prefix, `feat/`. */
  prefix: string;
  /** Start point: a branch name, or `''` for git's default (HEAD of the main checkout). */
  base: string;
  openTerminal: NewWorktreeTerminalChoice;
}

export interface NewWorktreePlan {
  /** Absolute path of the new worktree. */
  path: string;
  /** `worktrees/<slug>`. */
  rel: string;
  branch: string;
  /** `git worktree add`'s start point; null for the default. */
  startPoint: string | null;
  /** The line `.gitignore` must contain. */
  gitignoreLine: string;
  /** Open a terminal there afterwards (never typing into it), or not. */
  terminal: NewWorktreeTerminalChoice;
}

export type NewWorktreeOutcome = { ok: true; plan: NewWorktreePlan } | { ok: false; error: string };

/** Validate, then plan. Every string is checked here before git sees it. */
export function planNewWorktree(input: NewWorktreeInput): NewWorktreeOutcome {
  const slug = input.slug.trim();
  const slugError = validateSlug(slug);
  if (slugError) {
    return { ok: false, error: slugError };
  }
  const target = worktreeTarget(input.mainRoot, slug, { prefix: input.prefix, dir: WORKTREES_DIR });
  const branchError = validateBranchName(target.branch);
  if (branchError) {
    return { ok: false, error: branchError };
  }
  const base = input.base.trim();
  if (base !== '') {
    const baseError = validateBranchName(base);
    if (baseError) {
      return { ok: false, error: `Start point: ${baseError}` };
    }
  }
  return {
    ok: true,
    plan: {
      path: target.path,
      rel: target.rel,
      branch: target.branch,
      startPoint: base === '' ? null : base,
      gitignoreLine: WORKTREES_IGNORE_LINE,
      terminal: input.openTerminal,
    },
  };
}

/**
 * `existing` with the `lines` it lacks appended (compared trimmed, blank
 * lines ignored), ending in a newline; null when nothing is missing. An
 * empty `existing` yields just the lines — no leading blank line.
 */
export function appendMissingLines(existing: string, lines: readonly string[]): string | null {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => l.trim() !== '' && !have.has(l.trim()));
  if (missing.length === 0) {
    return null;
  }
  const tail = `${missing.join('\n')}\n`;
  return existing === '' ? tail : `${existing.replace(/\n*$/, '\n')}${tail}`;
}
