/**
 * Git store — every decision the git tab makes lives here (rule I5: Rust only
 * runs git; policy is TypeScript's), computed with the pure `core/git`
 * modules and carried out through an injected `GitStoreDeps`, so the whole
 * store runs under Vitest against a scripted fake.
 *
 * Keyed by the repository's MAIN root (`pathKey(mainRoot)`): one entry per
 * repository, however many workspaces or tabs point at it. Within an entry,
 * `selectedCheckout` is the checkout (main or a linked worktree) whose
 * status, branches, log and changes the panel shows; worktree actions name
 * their checkout explicitly.
 *
 * Two rules every action keeps:
 * - Nothing here types into a terminal. `deps.openTerminalAt(cwd, harness)`
 *   opens a shell or the harness IN a directory and that is all; conflicts
 *   are handed to the user's agent by putting a prompt on the CLIPBOARD
 *   (`copyConflictPrompt`), never by driving a pty.
 * - A stale answer is dropped. Every async refresh carries a sequence number
 *   (the `code-review-git.ts` pattern); a response for an older request, or
 *   for a checkout no longer selected, is ignored.
 *
 * This file's CONTRACT (types + `installGitDeps`) is fixed; the
 * implementation below is the stub slice C renders against until slice B
 * lands the real store and its tests (`__tests__/git.test.ts`).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { ClipboardProvider } from '../../ipc/clipboard';
import type { Ipc } from '../../ipc/commands';
import type { GitNetRunner } from '../../ipc/git-ops';
import type {
  ConflictTracker,
  FinishState,
  GitBranch,
  GitCheckout,
  GitCommit,
  GitFileDelta,
  GitNetKind,
  GitNetResult,
  GitOutputLine,
  GitStatus,
  SelectedItem,
  StatusGroups,
} from '../../core/git/types';
import type { GitRepoInfo } from '../../ipc/commands';

/* ------------------------------ dependencies ----------------------------- */

/** The slice of `Ipc` the store calls — a test fake implements just these. */
export type GitIpc = Pick<
  Ipc,
  | 'gitRepoInfo'
  | 'gitShowFile'
  | 'gitStatus'
  | 'gitBranches'
  | 'gitLog'
  | 'gitCommitFiles'
  | 'gitDiffNames'
  | 'gitWorktrees'
  | 'gitCheckIgnore'
  | 'gitStage'
  | 'gitUnstage'
  | 'gitDiscard'
  | 'gitCommit'
  | 'gitSwitch'
  | 'gitCreateBranch'
  | 'gitDeleteBranch'
  | 'gitMerge'
  | 'gitMergeAbort'
  | 'gitWorktreeAdd'
  | 'gitWorktreeRemove'
  | 'readTextFile'
  | 'atomicWriteText'
>;

/** A terminal tab as the worktree dashboard sees it (for "a shell is open here"). */
export interface GitTerminalTab {
  id: string;
  title: string;
  /** The shell's current directory (OSC 7), or null before the first report. */
  cwd: string | null;
}

export interface GitStoreDeps {
  ipc: GitIpc;
  /** fetch / pull / push, streamed (src/ipc/git-ops.ts). */
  net: GitNetRunner;
  now?: () => number;
  /** The `reviewBaseBranch` setting ('' = auto-detect). */
  baseBranchSetting: () => string;
  /** The explorer's active directory, to pick the checkout a tab opens on. */
  activeWorkspaceDir: () => string | null;
  /** This window's terminal tabs. */
  terminalTabs: () => GitTerminalTab[];
  /** Native confirm (session ctx). Resolves true to proceed. */
  confirm: (message: string, title: string) => Promise<boolean>;
  /** Status-bar notice. */
  notice: (message: string) => void;
  clipboard: () => ClipboardProvider;
  /**
   * Open a shell (`harness === false`) or the configured harness (`true`) as
   * a terminal tab whose cwd is `cwd`. Nothing is typed into it — by design
   * there is no third argument.
   */
  openTerminalAt: (cwd: string, harness: boolean) => void;
  /** Open a file as an ordinary file tab (a conflicted file, a changed file). */
  openFile: (absPath: string) => void;
  /** Save the tab holding `absPath` if it is dirty (before `git add`). */
  saveTabAt: (absPath: string) => Promise<void>;
  /** Add a folder as a workspace (a new worktree) / forget one (a removed worktree). */
  addWorkspace: (path: string) => void;
  removeWorkspace: (path: string) => void;
  /** Close tabs (terminals inside a worktree about to be removed). */
  closeTabs: (ids: string[]) => Promise<void>;
  /**
   * Re-arm the file watcher from current state. Awaited BEFORE
   * `gitWorktreeRemove` so the watcher's handle on the directory is gone
   * (Windows refuses to delete a watched directory).
   */
  refreshWatchedDirs: () => Promise<void>;
}

/* ---------------------------------- state --------------------------------- */

export interface GitDiffView {
  path: string;
  /** null = the file did not exist on that side (added / deleted). */
  leftText: string | null;
  rightText: string | null;
  leftLabel: string;
  rightLabel: string;
  binary: boolean;
  /** The two sides differ only in line endings. */
  eolOnly: boolean;
}

export interface GitOpState {
  kind: GitNetKind;
  /** Streamed output, oldest first, capped (the drawer shows the tail). */
  lines: GitOutputLine[];
  running: boolean;
  result: GitNetResult | null;
  /** A one-line reading of a failure's stderr (core/git/hints.ts), or null. */
  hint: string | null;
  /** Rejected outright (`GIT_BUSY`, `GIT_CANCELLED`, …): the error text. */
  error: string | null;
}

export type NewWorktreeTerminal = 'none' | 'shell' | 'harness';

export interface NewWorktreeDraft {
  open: boolean;
  slug: string;
  /** Branch prefix, e.g. `feat/`. */
  prefix: string;
  /** Start point: a local branch name; '' = the base branch. */
  base: string;
  openTerminal: NewWorktreeTerminal;
  /** Validation or git error to show under the field. */
  error: string | null;
  busy: boolean;
}

export type RepoUnavailable = 'no-git' | 'not-a-repo';

export type RefreshPart = 'status' | 'branches' | 'log' | 'worktrees';

export interface RepoState {
  mainRoot: string;
  info: GitRepoInfo | null;
  checkouts: GitCheckout[];
  /** Absolute path of the checkout shown; `mainRoot` until the user picks. */
  selectedCheckout: string;
  status: GitStatus | null;
  /** `status.entries` grouped for the four change sections (core/git/status.ts `groupStatus`). */
  groups: StatusGroups;
  branches: GitBranch[];
  log: GitCommit[];
  logExhausted: boolean;
  /** sha → the commit's files, once fetched. */
  commitFiles: Record<string, GitFileDelta[]>;
  /** worktree path → its files vs the base branch, once fetched. */
  worktreeDiffs: Record<string, GitFileDelta[]>;
  selected: SelectedItem | null;
  diff: GitDiffView | null;
  diffLoading: boolean;
  commitDraft: string;
  amend: boolean;
  branchFilter: string;
  loading: Record<RefreshPart, boolean>;
  /** The last failed call, for the header's error line. */
  error: { code: string; message: string } | null;
  unavailable: RepoUnavailable | null;
  op: GitOpState | null;
  conflictTracker: ConflictTracker | null;
  finish: FinishState | null;
  newWorktree: NewWorktreeDraft;
}

export interface GitState {
  /** `pathKey(mainRoot)` → the repository's state. */
  repos: Record<string, RepoState>;

  /* lifecycle */
  /** Start tracking a repository (idempotent); `checkout` preselects a worktree. */
  ensureRepo: (mainRoot: string, checkout?: string | null) => void;
  /** The last git tab for this repository closed. */
  forget: (mainRoot: string) => void;
  /** Re-ask git; throttled per repository unless `force`. */
  refresh: (mainRoot: string, opts?: { force?: boolean; parts?: RefreshPart[] }) => Promise<void>;
  /** Watcher / focus entry points (main.tsx). */
  onRepoChanged: (roots: string[]) => void;
  onFocus: () => void;
  /** Checkout roots the watcher should cover (core/git/checkouts.ts `extraGitWatchDirs`). */
  watchRoots: () => { mainRoot: string; checkoutPaths: string[] }[];

  /* selection */
  selectCheckout: (mainRoot: string, path: string) => void;
  select: (mainRoot: string, item: SelectedItem | null) => void;
  loadMoreLog: (mainRoot: string) => Promise<void>;
  setBranchFilter: (mainRoot: string, text: string) => void;

  /* changes + commit (in the selected checkout) */
  stage: (mainRoot: string, paths: string[]) => Promise<void>;
  unstage: (mainRoot: string, paths: string[]) => Promise<void>;
  /** Confirms, then restores tracked paths and deletes untracked ones. */
  discard: (mainRoot: string, paths: string[]) => Promise<void>;
  setCommitDraft: (mainRoot: string, text: string) => void;
  toggleAmend: (mainRoot: string) => void;
  commit: (mainRoot: string) => Promise<void>;

  /* branches (in the selected checkout) */
  switchBranch: (mainRoot: string, branch: GitBranch) => Promise<void>;
  createBranch: (
    mainRoot: string,
    name: string,
    startPoint: string | null,
    switchTo: boolean,
  ) => Promise<void>;
  deleteBranch: (mainRoot: string, name: string, opts?: { force?: boolean }) => Promise<void>;
  /** Merge `target` into the checkout at `root` (default: the selected one). */
  merge: (mainRoot: string, target: string, opts?: { root?: string }) => Promise<void>;

  /* conflicts (of the checkout the tracker names, else the selected one) */
  abortMerge: (mainRoot: string) => Promise<void>;
  /** `commit --no-edit`; only enabled once the tracker says every file is clean and staged. */
  continueMerge: (mainRoot: string) => Promise<void>;
  markResolved: (mainRoot: string, path: string) => Promise<void>;
  /** Put the agent-ready conflict prompt on the clipboard. */
  copyConflictPrompt: (mainRoot: string) => Promise<void>;

  /* network (in the selected checkout) */
  fetch: (mainRoot: string, opts?: { remote?: string | null; prune?: boolean }) => Promise<void>;
  pull: (mainRoot: string) => Promise<void>;
  push: (
    mainRoot: string,
    opts?: { remote?: string | null; setUpstream?: boolean },
  ) => Promise<void>;
  cancelOp: (mainRoot: string) => void;
  dismissOp: (mainRoot: string) => void;

  /* worktrees */
  openNewWorktree: (mainRoot: string) => void;
  closeNewWorktree: (mainRoot: string) => void;
  setNewWorktreeField: (
    mainRoot: string,
    patch: Partial<Pick<NewWorktreeDraft, 'slug' | 'prefix' | 'base' | 'openTerminal'>>,
  ) => void;
  createWorktree: (mainRoot: string) => Promise<void>;
  removeWorktree: (mainRoot: string, path: string, opts?: { force?: boolean }) => Promise<void>;
  openWorktreeAsWorkspace: (mainRoot: string, path: string) => void;
  openTerminalIn: (mainRoot: string, path: string, harness: boolean) => void;

  /* finish-worktree flow (one per repository at a time) */
  startFinish: (mainRoot: string, worktreePath: string) => Promise<void>;
  continueFinish: (mainRoot: string) => Promise<void>;
  skipFinishStep: (mainRoot: string) => Promise<void>;
  retryFinishStep: (mainRoot: string) => Promise<void>;
  abortFinish: (mainRoot: string) => Promise<void>;
  dismissFinish: (mainRoot: string) => void;
}

/* ------------------------------- construction ----------------------------- */

/** Case-folded, forward-slashed key — the same rule `core/tab-workspaces.ts` uses. */
export function repoKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export const EMPTY_NEW_WORKTREE: NewWorktreeDraft = {
  open: false,
  slug: '',
  prefix: 'feat/',
  base: '',
  openTerminal: 'harness',
  error: null,
  busy: false,
};

export function emptyRepoState(mainRoot: string, checkout?: string | null): RepoState {
  return {
    mainRoot,
    info: null,
    checkouts: [],
    selectedCheckout: checkout ?? mainRoot,
    status: null,
    groups: { staged: [], unstaged: [], untracked: [], conflicted: [] },
    branches: [],
    log: [],
    logExhausted: false,
    commitFiles: {},
    worktreeDiffs: {},
    selected: null,
    diff: null,
    diffLoading: false,
    commitDraft: '',
    amend: false,
    branchFilter: '',
    loading: { status: false, branches: false, log: false, worktrees: false },
    error: null,
    unavailable: null,
    op: null,
    conflictTracker: null,
    finish: null,
    newWorktree: EMPTY_NEW_WORKTREE,
  };
}

/**
 * Build a store over `deps`. The app installs its real deps once at bootstrap
 * (`installGitDeps`, from ui code that may import the session facade, the
 * tabs store and the terminal opener — this module cannot without a cycle);
 * tests pass a fake directly.
 */
export function createGitStore(getDeps: () => GitStoreDeps) {
  // The stub: state bookkeeping only. Slice B replaces the body of every
  // action that talks to git; the shapes above are what it fills.
  void getDeps;
  const noopAsync = async () => {};
  return createStore<GitState>()((set, get) => {
    const patch = (mainRoot: string, update: (repo: RepoState) => Partial<RepoState>) => {
      const key = repoKey(mainRoot);
      const repo = get().repos[key];
      if (!repo) {
        return;
      }
      set({ repos: { ...get().repos, [key]: { ...repo, ...update(repo) } } });
    };
    return {
      repos: {},

      ensureRepo(mainRoot, checkout) {
        const key = repoKey(mainRoot);
        if (get().repos[key]) {
          return;
        }
        set({ repos: { ...get().repos, [key]: emptyRepoState(mainRoot, checkout) } });
      },
      forget(mainRoot) {
        const key = repoKey(mainRoot);
        if (!get().repos[key]) {
          return;
        }
        const repos = { ...get().repos };
        delete repos[key];
        set({ repos });
      },
      refresh: noopAsync,
      onRepoChanged() {},
      onFocus() {},
      watchRoots() {
        return Object.values(get().repos).map((r) => ({
          mainRoot: r.mainRoot,
          checkoutPaths: r.checkouts.map((c) => c.path),
        }));
      },

      selectCheckout(mainRoot, path) {
        patch(mainRoot, () => ({ selectedCheckout: path, selected: null, diff: null }));
      },
      select(mainRoot, item) {
        patch(mainRoot, () => ({ selected: item }));
      },
      loadMoreLog: noopAsync,
      setBranchFilter(mainRoot, text) {
        patch(mainRoot, () => ({ branchFilter: text }));
      },

      stage: noopAsync,
      unstage: noopAsync,
      discard: noopAsync,
      setCommitDraft(mainRoot, text) {
        patch(mainRoot, () => ({ commitDraft: text }));
      },
      toggleAmend(mainRoot) {
        patch(mainRoot, (r) => ({ amend: !r.amend }));
      },
      commit: noopAsync,

      switchBranch: noopAsync,
      createBranch: noopAsync,
      deleteBranch: noopAsync,
      merge: noopAsync,

      abortMerge: noopAsync,
      continueMerge: noopAsync,
      markResolved: noopAsync,
      copyConflictPrompt: noopAsync,

      fetch: noopAsync,
      pull: noopAsync,
      push: noopAsync,
      cancelOp() {},
      dismissOp(mainRoot) {
        patch(mainRoot, () => ({ op: null }));
      },

      openNewWorktree(mainRoot) {
        patch(mainRoot, (r) => ({ newWorktree: { ...r.newWorktree, open: true, error: null } }));
      },
      closeNewWorktree(mainRoot) {
        patch(mainRoot, () => ({ newWorktree: EMPTY_NEW_WORKTREE }));
      },
      setNewWorktreeField(mainRoot, fields) {
        patch(mainRoot, (r) => ({ newWorktree: { ...r.newWorktree, ...fields, error: null } }));
      },
      createWorktree: noopAsync,
      removeWorktree: noopAsync,
      openWorktreeAsWorkspace() {},
      openTerminalIn() {},

      startFinish: noopAsync,
      continueFinish: noopAsync,
      skipFinishStep: noopAsync,
      retryFinishStep: noopAsync,
      abortFinish: noopAsync,
      dismissFinish(mainRoot) {
        patch(mainRoot, () => ({ finish: null }));
      },
    };
  });
}

/* -------------------------------- singleton ------------------------------- */

let installedDeps: GitStoreDeps | null = null;

/**
 * Wire the app's real dependencies. Called once at bootstrap by ui code
 * (`src/ui/git-deps.ts`); an action reached before that is a startup-order
 * bug and says so.
 */
export function installGitDeps(deps: GitStoreDeps): void {
  installedDeps = deps;
}

function requireDeps(): GitStoreDeps {
  if (!installedDeps) {
    throw new Error('git store used before installGitDeps()');
  }
  return installedDeps;
}

export const gitStore = createGitStore(requireDeps);

export const useGitStore = <T>(selector: (s: GitState) => T): T => useStore(gitStore, selector);
