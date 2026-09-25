/**
 * Checkouts — the main checkout and its linked worktrees as one list, which
 * one the panel opens on, which terminal tabs sit inside one, and which
 * checkout roots the file watcher must cover. Pure; no DOM, no Tauri, no
 * React.
 *
 * Paths are compared with `tab-workspaces.ts`'s `pathKey` (case-folded,
 * forward slashes) and the same "root itself or `<root>/…`" prefix rule the
 * explorer uses, so `C:\repo\worktrees\x` and `c:/repo/worktrees/x/` are one
 * checkout.
 */

import { pathKey } from '../tab-workspaces';
import type { GitCheckout, GitWorktreeSummary } from './types';

/** A checkout's key: its path key without a trailing slash. */
export function checkoutKey(path: string): string {
  return pathKey(path).replace(/\/+$/, '');
}

/** Is `path` the checkout root itself or inside it? */
export function isInsideCheckout(path: string, root: string): boolean {
  const p = pathKey(path).replace(/\/+$/, '');
  const r = checkoutKey(root);
  return p === r || p.startsWith(`${r}/`);
}

/** What `git_repo_info` says about the repository's checkouts. */
export interface CheckoutSource {
  mainRoot: string;
  worktrees: readonly { path: string; branch: string | null; head: string }[];
}

/**
 * The checkout list, main first, the rest in `worktree list` order. Facts
 * come from the dashboard summaries when they have arrived (they carry
 * lock / missing state and the counts), else from `git_repo_info`'s
 * worktree list; a checkout known to either source is listed.
 */
export function buildCheckouts(
  info: CheckoutSource,
  summaries: readonly GitWorktreeSummary[] | null,
): GitCheckout[] {
  const mainKey = checkoutKey(info.mainRoot);
  const byKey = new Map<string, GitCheckout>();
  const add = (
    path: string,
    branch: string | null,
    head: string,
    summary: GitWorktreeSummary | null,
  ) => {
    const key = checkoutKey(path);
    const existing = byKey.get(key);
    if (existing) {
      if (summary && !existing.summary) {
        byKey.set(key, { ...existing, branch, head, summary });
      }
      return;
    }
    byKey.set(key, { path, branch, head, isMain: key === mainKey, summary });
  };
  for (const w of info.worktrees) {
    add(w.path, w.branch, w.head, null);
  }
  for (const s of summaries ?? []) {
    add(s.path, s.branch, s.head, s);
  }
  if (!byKey.has(mainKey)) {
    byKey.set(mainKey, {
      path: info.mainRoot,
      branch: null,
      head: '',
      isMain: true,
      summary: null,
    });
  }
  const all = [...byKey.values()];
  return [...all.filter((c) => c.isMain), ...all.filter((c) => !c.isMain)];
}

/**
 * The checkout the panel shows: the remembered one when it still exists,
 * else the checkout the explorer's active workspace lies in (a tab opened
 * from a worktree workspace opens on that worktree), else the main one.
 * `''` only for an empty list.
 */
export function pickSelected(
  checkouts: readonly GitCheckout[],
  remembered: string | null,
  activeWorkspaceDir: string | null,
): string {
  if (remembered !== null) {
    const kept = checkouts.find((c) => checkoutKey(c.path) === checkoutKey(remembered));
    if (kept) {
      return kept.path;
    }
  }
  if (activeWorkspaceDir !== null) {
    // Longest root wins, so a worktree nested under the main root beats it.
    let best: GitCheckout | null = null;
    for (const c of checkouts) {
      if (
        isInsideCheckout(activeWorkspaceDir, c.path) &&
        (best === null || checkoutKey(c.path).length > checkoutKey(best.path).length)
      ) {
        best = c;
      }
    }
    if (best) {
      return best.path;
    }
  }
  return (checkouts.find((c) => c.isMain) ?? checkouts[0])?.path ?? '';
}

/** A terminal tab as this module sees it. */
export interface TerminalCwd {
  id: string;
  title: string;
  cwd: string | null;
}

/**
 * Terminal tabs whose shell currently sits inside `checkoutPath` — the tabs
 * that hold the directory open and must close before a worktree can be
 * removed on Windows. Tabs inside one of `nested` (other checkouts that lie
 * under this one, e.g. worktrees under the main root) are not counted for it.
 */
export function terminalsInside<T extends TerminalCwd>(
  tabs: readonly T[],
  checkoutPath: string,
  nested: readonly string[] = [],
): T[] {
  return tabs.filter(
    (t) =>
      t.cwd !== null &&
      isInsideCheckout(t.cwd, checkoutPath) &&
      !nested.some(
        (n) =>
          checkoutKey(n) !== checkoutKey(checkoutPath) &&
          isInsideCheckout(n, checkoutPath) &&
          isInsideCheckout(t.cwd!, n),
      ),
  );
}

/** An open repository as the watcher needs it. */
export interface OpenRepo {
  mainRoot: string;
  checkoutPaths: readonly string[];
}

/**
 * Checkout roots (main roots included) that no watched root already covers,
 * deduped — the extra directories the watcher must be armed with so a
 * worktree outside every workspace still refreshes the tab. Same shape as
 * `live-edit.ts`'s `extraLiveWatchDirs`.
 */
export function extraGitWatchDirs(
  repos: readonly OpenRepo[],
  watchedRoots: readonly string[],
): string[] {
  const covered = (path: string) => watchedRoots.some((r) => isInsideCheckout(path, r));
  const out = new Map<string, string>();
  for (const repo of repos) {
    for (const path of [repo.mainRoot, ...repo.checkoutPaths]) {
      if (!covered(path) && !out.has(checkoutKey(path))) {
        out.set(checkoutKey(path), path);
      }
    }
  }
  return [...out.values()];
}
