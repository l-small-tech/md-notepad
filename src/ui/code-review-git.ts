/**
 * "What changed" orchestration for a code tab in Review mode (review_plan.md
 * §6): asks git where the file sits, picks the default baseline, turns the
 * chosen baseline into a revision, fetches the file's text there, and hands
 * the pane a change map plus the worktree radar. Pure decisions are exported
 * on their own (`defaultBaseline`, `baselineRev`, `radarBranches`,
 * `reviewContextFor`) and tested; `createReviewGit` sequences the IPC.
 *
 * Never blocks the deck: every git call is awaited off the render path and a
 * stale answer (the model or baseline moved on) is dropped. Git being absent
 * (`isGitUnavailable`) is a hint, not an error; any other failure is logged
 * and hides the picker the same way.
 */

import { changeMap, type ChangeMap } from '../core/code/changes';
import type { CodeModel } from '../core/code/model';
import { parseCode } from '../core/code/parse';
import type { ReviewBaseline } from '../core/code/review-state';
import type { ReviewContext } from '../core/comments';
import { diffLines } from '../core/diff';
import { ipc, IpcError, isGitUnavailable, type GitRepoInfo } from '../ipc/commands';
import type { RadarEntry, ReviewGitInfo } from '../preview/code-review';

/** Git info is re-asked on focus at most this often. */
export const GIT_REFRESH_THROTTLE_MS = 5000;

/**
 * The baseline a fresh tab starts on: the branch (merge-base with the base
 * branch) whenever HEAD is not the base branch — every worktree — else the
 * uncommitted edits against HEAD. "Last commit" is only ever chosen by hand.
 */
export function defaultBaseline(info: GitRepoInfo): ReviewBaseline {
  return info.baseRef !== null && info.branch !== info.baseBranch ? 'branch' : 'uncommitted';
}

/**
 * The revision a baseline compares against, or null when it cannot be
 * resolved here (This branch without a merge base, a repo with no commits).
 */
export function baselineRev(baseline: ReviewBaseline, info: GitRepoInfo): string | null {
  switch (baseline) {
    case 'branch':
      return info.baseRef;
    case 'uncommitted':
      return info.head === '' ? null : 'HEAD';
    case 'last-commit':
      return info.head === '' ? null : 'HEAD~1';
  }
}

/** The other worktrees' branches — what the radar asks about — deduped, in order. */
export function radarBranches(info: GitRepoInfo): string[] {
  const out: string[] = [];
  for (const w of info.worktrees) {
    if (w.branch !== null && w.branch !== info.branch && !out.includes(w.branch)) {
      out.push(w.branch);
    }
  }
  return out;
}

/** The sidecar preamble for notes taken on this tab (`core/comments.ts`). */
export function reviewContextFor(
  info: GitRepoInfo | null,
  baseline: ReviewBaseline | null,
): ReviewContext | undefined {
  if (!info) {
    return undefined;
  }
  const context: ReviewContext = {};
  if (info.branch) {
    context.branch = info.branch;
  }
  if (info.isWorktree) {
    context.worktree = info.root;
  }
  if (baseline === 'branch' && info.baseBranch) {
    context.baseBranch = info.baseBranch;
    if (info.baseRef) {
      context.baseRef = info.baseRef.slice(0, 7);
    }
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

/** The header hint for a git failure. */
export function gitHint(err: unknown): string {
  if (err instanceof IpcError) {
    switch (err.code) {
      case 'GIT_NOT_FOUND':
        return 'Git not found';
      case 'GIT_NOT_A_REPO':
        return 'Not a git repository';
      case 'GIT_TIMEOUT':
        return 'Git timed out';
      default:
        break;
    }
  }
  return 'Git unavailable';
}

/** The IPC surface `createReviewGit` uses — injectable for tests. */
export type ReviewGitIpc = Pick<typeof ipc, 'gitRepoInfo' | 'gitShowFile' | 'gitFileChanges'>;

export interface ReviewGitOptions {
  /** The tab's absolute file path. */
  path: string;
  /** The `reviewBaseBranch` setting, read at each refresh ('' = auto). */
  baseBranchSetting: () => string;
  /** The tab's current baseline (from the review store). */
  getBaseline: () => ReviewBaseline | null;
  /** Set the tab's baseline (the default, once git answers and none is chosen). */
  setBaseline: (baseline: ReviewBaseline) => void;
  /** Push the header slot state to the pane. */
  onGitInfo: (info: ReviewGitInfo) => void;
  /** Push a change map (or null while loading / unavailable) to the pane. */
  onChanges: (changes: ChangeMap | null, radar: RadarEntry[] | null) => void;
  git?: ReviewGitIpc;
  now?: () => number;
}

export interface ReviewGit {
  /** Ask git again (throttled to once per {@link GIT_REFRESH_THROTTLE_MS}); `force` skips the throttle. */
  refresh(force?: boolean): void;
  /** The pane re-parsed: recompute the change map against the cached baseline text. */
  modelChanged(model: CodeModel | null, text: string): void;
  /** The reader picked another baseline. */
  baselineChanged(): void;
  /** The last repo info (for the sidecar context), null before git answered. */
  info(): GitRepoInfo | null;
  /** The review context for a note taken now. */
  context(): ReviewContext | undefined;
  dispose(): void;
}

export function createReviewGit(options: ReviewGitOptions): ReviewGit {
  const git = options.git ?? ipc;
  const now = options.now ?? (() => Date.now());
  let disposed = false;
  let info: GitRepoInfo | null = null;
  let unavailable = false;
  let lastRefresh = -Infinity;
  let model: CodeModel | null = null;
  let text = '';
  // rev → the file's text there (null = did not exist). One `git show` per rev.
  const baseText = new Map<string, Promise<string | null>>();
  // rev → the radar answer for it.
  const radarFor = new Map<string, Promise<RadarEntry[]>>();
  let computeSeq = 0;

  async function refreshNow(): Promise<void> {
    lastRefresh = now();
    const setting = options.baseBranchSetting().trim();
    let next: GitRepoInfo;
    try {
      next = await git.gitRepoInfo(options.path, setting === '' ? undefined : setting);
    } catch (err) {
      if (disposed) {
        return;
      }
      if (!isGitUnavailable(err)) {
        console.warn('[review] git info failed', err);
      }
      info = null;
      unavailable = true;
      baseText.clear();
      radarFor.clear();
      options.onGitInfo({ available: false, hint: gitHint(err) });
      options.onChanges(null, null);
      return;
    }
    if (disposed) {
      return;
    }
    // A new HEAD or merge base invalidates every cached revision text.
    if (info === null || info.head !== next.head || info.baseRef !== next.baseRef) {
      baseText.clear();
      radarFor.clear();
    }
    info = next;
    unavailable = false;
    options.onGitInfo({
      available: true,
      branch: next.branch,
      baseBranch: next.baseBranch,
      baseRef: next.baseRef,
    });
    if (options.getBaseline() === null) {
      options.setBaseline(defaultBaseline(next));
    }
    void compute();
  }

  /** Recompute the change map for the current model, baseline and repo info. */
  async function compute(): Promise<void> {
    const seq = ++computeSeq;
    const baseline = options.getBaseline();
    if (disposed || info === null || unavailable || model === null || baseline === null) {
      if (!disposed && (unavailable || info === null || model === null)) {
        options.onChanges(null, null);
      }
      return;
    }
    const rev = baselineRev(baseline, info);
    if (rev === null) {
      options.onChanges(null, null);
      return;
    }
    const { root, rel } = info;
    let base = baseText.get(rev);
    if (base === undefined) {
      base = git.gitShowFile(root, rev, rel);
      baseText.set(rev, base);
    }
    let baseString: string | null;
    try {
      baseString = await base;
    } catch (err) {
      baseText.delete(rev);
      if (!disposed && seq === computeSeq) {
        console.warn('[review] git show failed', err);
        options.onChanges(null, null);
      }
      return;
    }
    if (disposed || seq !== computeSeq) {
      return;
    }
    const current = model;
    const changes = changeMap(
      baseString === null ? null : parseCode(baseString, options.path),
      current,
      diffLines(baseString ?? '', text),
    );
    // Cards first, badges now; the radar lands when it lands.
    options.onChanges(changes, null);
    const branches = radarBranches(info);
    if (branches.length === 0) {
      return;
    }
    let radar = radarFor.get(rev);
    if (radar === undefined) {
      radar = git
        .gitFileChanges(root, rel, rev, branches)
        .then((rows) => rows.filter((r) => r.differs).map((r) => ({ branch: r.branch })));
      radarFor.set(rev, radar);
    }
    let entries: RadarEntry[];
    try {
      entries = await radar;
    } catch (err) {
      radarFor.delete(rev);
      console.warn('[review] worktree radar failed', err);
      return;
    }
    if (disposed || seq !== computeSeq) {
      return;
    }
    options.onChanges(changes, entries);
  }

  return {
    refresh(force = false) {
      if (disposed) {
        return;
      }
      if (force || now() - lastRefresh >= GIT_REFRESH_THROTTLE_MS) {
        void refreshNow();
      }
    },
    modelChanged(nextModel, nextText) {
      model = nextModel;
      text = nextText;
      void compute();
    },
    baselineChanged() {
      void compute();
    },
    info: () => info,
    context: () => reviewContextFor(info, options.getBaseline()),
    dispose() {
      disposed = true;
    },
  };
}
