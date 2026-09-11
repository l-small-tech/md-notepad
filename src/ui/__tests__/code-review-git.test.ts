import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReviewBaseline } from '../../core/code/review-state';
import { IpcError, type GitRepoInfo } from '../../ipc/commands';
import {
  baselineRev,
  createReviewGit,
  defaultBaseline,
  GIT_REFRESH_THROTTLE_MS,
  gitHint,
  radarBranches,
  reviewContextFor,
  type ReviewGitIpc,
} from '../code-review-git';

const worktreeInfo: GitRepoInfo = {
  root: 'C:/repo/worktrees/explorer',
  rel: 'src/core/text-files.ts',
  branch: 'feat/explorer',
  head: 'abc1234abc',
  isWorktree: true,
  baseBranch: 'development',
  baseRef: '3c77f30aaaa',
  worktrees: [
    { path: 'C:/repo', branch: 'development', head: '3c77f30aaaa' },
    { path: 'C:/repo/worktrees/explorer', branch: 'feat/explorer', head: 'abc1234abc' },
    { path: 'C:/repo/worktrees/other', branch: 'feat/other', head: 'def5678' },
    { path: 'C:/repo/worktrees/detached', branch: null, head: '9999999' },
    { path: 'C:/repo/worktrees/other-2', branch: 'feat/other', head: 'def5678' },
  ],
};

const mainInfo: GitRepoInfo = {
  ...worktreeInfo,
  root: 'C:/repo',
  branch: 'development',
  isWorktree: false,
  baseRef: null,
  worktrees: worktreeInfo.worktrees.slice(0, 3),
};

describe('defaultBaseline', () => {
  test('a worktree branch with a merge base compares against the branch', () => {
    expect(defaultBaseline(worktreeInfo)).toBe('branch');
  });

  test('HEAD on the base branch (no merge base) compares against HEAD', () => {
    expect(defaultBaseline(mainInfo)).toBe('uncommitted');
  });

  test('a merge base without a distinct branch still means uncommitted', () => {
    expect(defaultBaseline({ ...worktreeInfo, branch: 'development' })).toBe('uncommitted');
  });
});

describe('baselineRev', () => {
  test('branch → the merge base, uncommitted → HEAD, last commit → HEAD~1', () => {
    expect(baselineRev('branch', worktreeInfo)).toBe('3c77f30aaaa');
    expect(baselineRev('uncommitted', worktreeInfo)).toBe('HEAD');
    expect(baselineRev('last-commit', worktreeInfo)).toBe('HEAD~1');
  });

  test('null when the branch has no merge base, or the repo has no commits', () => {
    expect(baselineRev('branch', mainInfo)).toBeNull();
    expect(baselineRev('uncommitted', { ...mainInfo, head: '' })).toBeNull();
    expect(baselineRev('last-commit', { ...mainInfo, head: '' })).toBeNull();
  });
});

describe('radarBranches', () => {
  test('every other worktree branch, without detached heads or duplicates', () => {
    expect(radarBranches(worktreeInfo)).toEqual(['development', 'feat/other']);
    expect(radarBranches(mainInfo)).toEqual(['feat/explorer', 'feat/other']);
  });
});

describe('reviewContextFor', () => {
  test('branch + worktree root + baseline branch with the short merge base', () => {
    expect(reviewContextFor(worktreeInfo, 'branch')).toEqual({
      branch: 'feat/explorer',
      worktree: 'C:/repo/worktrees/explorer',
      baseBranch: 'development',
      baseRef: '3c77f30',
    });
  });

  test('the main checkout against HEAD carries only the branch', () => {
    expect(reviewContextFor(mainInfo, 'uncommitted')).toEqual({ branch: 'development' });
  });

  test('nothing without git', () => {
    expect(reviewContextFor(null, 'branch')).toBeUndefined();
    expect(
      reviewContextFor({ ...mainInfo, branch: null, isWorktree: false }, null),
    ).toBeUndefined();
  });
});

describe('gitHint', () => {
  test('names the reason git is out', () => {
    expect(gitHint(new IpcError('GIT_NOT_FOUND', 'x'))).toBe('Git not found');
    expect(gitHint(new IpcError('GIT_NOT_A_REPO', 'x'))).toBe('Not a git repository');
    expect(gitHint(new IpcError('GIT_TIMEOUT', 'x'))).toBe('Git timed out');
    expect(gitHint(new IpcError('GIT_FAILED', 'x'))).toBe('Git unavailable');
    expect(gitHint(new Error('boom'))).toBe('Git unavailable');
  });
});

/* ---- the orchestration ------------------------------------------------- */

const BASE = 'export function a(x: number) {}\nexport function old() {}\n';
const CURRENT = 'export function a(x: number, y: string) {}\nexport function fresh() {}\n';

function fakeGit(info: GitRepoInfo | Error = worktreeInfo) {
  const git: { [K in keyof ReviewGitIpc]: ReturnType<typeof vi.fn> } = {
    gitRepoInfo: vi.fn(() =>
      info instanceof Error ? Promise.reject(info) : Promise.resolve(info),
    ),
    gitShowFile: vi.fn(() => Promise.resolve(BASE)),
    gitFileChanges: vi.fn((_root: string, _rel: string, _rev: string, branches: string[]) =>
      Promise.resolve(branches.map((branch) => ({ branch, differs: branch === 'feat/other' }))),
    ),
  };
  return git;
}

function harness(git: ReturnType<typeof fakeGit>, opts: { baseline?: ReviewBaseline | null } = {}) {
  let baseline: ReviewBaseline | null = opts.baseline ?? null;
  let clock = 1000;
  const onGitInfo = vi.fn();
  const onChanges = vi.fn();
  const setBaseline = vi.fn((b: ReviewBaseline) => {
    baseline = b;
  });
  const rg = createReviewGit({
    path: 'C:/repo/worktrees/explorer/src/core/text-files.ts',
    baseBranchSetting: () => '',
    getBaseline: () => baseline,
    setBaseline,
    onGitInfo,
    onChanges,
    git: git as unknown as ReviewGitIpc,
    now: () => clock,
  });
  return {
    rg,
    onGitInfo,
    onChanges,
    setBaseline,
    setClock: (t: number) => {
      clock = t;
    },
    pick: (b: ReviewBaseline) => {
      baseline = b;
      rg.baselineChanged();
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createReviewGit', () => {
  test('refresh → git info, the default baseline, then a change map and the radar', async () => {
    const git = fakeGit();
    const h = harness(git);
    const model = (await import('../../core/code/parse')).parseCode(CURRENT, 'x.ts');
    h.rg.modelChanged(model, CURRENT);
    await flush();
    // No git yet: nothing to badge, and nothing was asked of git.
    expect(h.onChanges).toHaveBeenLastCalledWith(null, null);
    expect(git.gitShowFile).not.toHaveBeenCalled();

    h.rg.refresh();
    await flush();
    await flush();
    expect(git.gitRepoInfo).toHaveBeenCalledWith(
      'C:/repo/worktrees/explorer/src/core/text-files.ts',
      undefined,
    );
    expect(h.onGitInfo).toHaveBeenCalledWith({
      available: true,
      branch: 'feat/explorer',
      baseBranch: 'development',
      baseRef: '3c77f30aaaa',
    });
    expect(h.setBaseline).toHaveBeenCalledWith('branch');
    expect(git.gitShowFile).toHaveBeenCalledWith(
      'C:/repo/worktrees/explorer',
      '3c77f30aaaa',
      'src/core/text-files.ts',
    );
    expect(git.gitFileChanges).toHaveBeenCalledWith(
      'C:/repo/worktrees/explorer',
      'src/core/text-files.ts',
      '3c77f30aaaa',
      ['development', 'feat/other'],
    );
    // Badges first (radar null), then the radar.
    const calls = h.onChanges.mock.calls.filter(([c]) => c !== null);
    expect(calls).toHaveLength(2);
    const [changes, radarBefore] = calls[0]!;
    expect(radarBefore).toBeNull();
    expect(changes.units.get('function:a')).toEqual({
      status: 'signature-changed',
      signatureNote: 'now also takes y',
    });
    expect(changes.units.get('function:fresh')).toEqual({ status: 'added' });
    expect(changes.removed.map((u: { name: string }) => u.name)).toEqual(['old']);
    expect(calls[1]![1]).toEqual([{ branch: 'feat/other' }]);
    expect(h.rg.context()).toEqual({
      branch: 'feat/explorer',
      worktree: 'C:/repo/worktrees/explorer',
      baseBranch: 'development',
      baseRef: '3c77f30',
    });

    // A second refresh inside the throttle window is dropped; after it, asked again.
    h.rg.refresh();
    expect(git.gitRepoInfo).toHaveBeenCalledTimes(1);
    h.setClock(1000 + GIT_REFRESH_THROTTLE_MS);
    h.rg.refresh();
    expect(git.gitRepoInfo).toHaveBeenCalledTimes(2);
    await flush();
    await flush();
    // Same HEAD and merge base → the baseline text is served from the cache.
    expect(git.gitShowFile).toHaveBeenCalledTimes(1);

    // Picking another baseline fetches that revision once.
    h.pick('uncommitted');
    await flush();
    expect(git.gitShowFile).toHaveBeenLastCalledWith(
      'C:/repo/worktrees/explorer',
      'HEAD',
      'src/core/text-files.ts',
    );
    h.pick('branch');
    await flush();
    expect(git.gitShowFile).toHaveBeenCalledTimes(2);
    h.rg.dispose();
  });

  test('a chosen baseline is kept; a model change recomputes without asking git again', async () => {
    const git = fakeGit();
    const h = harness(git, { baseline: 'last-commit' });
    h.rg.refresh();
    await flush();
    expect(h.setBaseline).not.toHaveBeenCalled();
    const { parseCode } = await import('../../core/code/parse');
    h.rg.modelChanged(parseCode(CURRENT, 'x.ts'), CURRENT);
    await flush();
    await flush();
    expect(git.gitShowFile).toHaveBeenCalledWith(
      'C:/repo/worktrees/explorer',
      'HEAD~1',
      'src/core/text-files.ts',
    );
    h.onChanges.mockClear();
    h.rg.modelChanged(parseCode(BASE, 'x.ts'), BASE);
    await flush();
    await flush();
    expect(git.gitShowFile).toHaveBeenCalledTimes(1);
    const [same] = h.onChanges.mock.calls[0]!;
    expect([...same.units.values()].every((i: { status: string }) => i.status === 'same')).toBe(
      true,
    );
    h.rg.dispose();
  });

  test('a new file (no text at the baseline) badges everything added', async () => {
    const git = fakeGit();
    git.gitShowFile.mockResolvedValue(null);
    const h = harness(git);
    const { parseCode } = await import('../../core/code/parse');
    h.rg.modelChanged(parseCode(CURRENT, 'x.ts'), CURRENT);
    h.rg.refresh();
    await flush();
    await flush();
    const [changes] = h.onChanges.mock.calls.find(([c]) => c !== null)!;
    expect([...changes.units.values()].map((i: { status: string }) => i.status)).toEqual([
      'added',
      'added',
    ]);
    h.rg.dispose();
  });

  test('without git the header gets the hint and the deck stays unbadged', async () => {
    const git = fakeGit(new IpcError('GIT_NOT_FOUND', 'no git'));
    const h = harness(git);
    h.rg.refresh();
    await flush();
    expect(h.onGitInfo).toHaveBeenCalledWith({ available: false, hint: 'Git not found' });
    expect(h.onChanges).toHaveBeenLastCalledWith(null, null);
    expect(h.setBaseline).not.toHaveBeenCalled();
    expect(h.rg.context()).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();

    const outside = fakeGit(new IpcError('GIT_NOT_A_REPO', 'nope'));
    const h2 = harness(outside);
    h2.rg.refresh();
    await flush();
    expect(h2.onGitInfo).toHaveBeenCalledWith({ available: false, hint: 'Not a git repository' });

    // Any other failure is logged and hides the picker the same way.
    const broken = fakeGit(new IpcError('GIT_FAILED', 'fatal'));
    const h3 = harness(broken);
    h3.rg.refresh();
    await flush();
    expect(h3.onGitInfo).toHaveBeenCalledWith({ available: false, hint: 'Git unavailable' });
    expect(console.warn).toHaveBeenCalled();
  });

  test('a git show failure clears the badges and is retried on the next compute', async () => {
    const git = fakeGit();
    git.gitShowFile.mockRejectedValueOnce(new IpcError('GIT_TIMEOUT', 'slow'));
    const h = harness(git);
    const { parseCode } = await import('../../core/code/parse');
    h.rg.modelChanged(parseCode(CURRENT, 'x.ts'), CURRENT);
    h.rg.refresh();
    await flush();
    await flush();
    expect(h.onChanges).toHaveBeenLastCalledWith(null, null);
    h.rg.baselineChanged();
    await flush();
    await flush();
    expect(git.gitShowFile).toHaveBeenCalledTimes(2);
    expect(h.onChanges.mock.calls.at(-1)![0]).not.toBeNull();
  });

  test('nothing lands after dispose', async () => {
    const git = fakeGit();
    const h = harness(git);
    h.rg.refresh();
    h.rg.dispose();
    await flush();
    await flush();
    expect(h.onGitInfo).not.toHaveBeenCalled();
    expect(h.onChanges).not.toHaveBeenCalled();
  });
});
