/**
 * GitHeader — the checkout picker (main first, then every linked worktree),
 * the branch line with its upstream and ahead/behind, the state chip, and the
 * network buttons. Fetch / Pull / Push stream into the OutputDrawer; a branch
 * with no upstream gets "Publish branch" instead of Push.
 */

import type { GitRepoState } from '../../../core/git/types';
import { gitStore } from '../../stores/git';
import { tabsStore } from '../../stores/tabs';
import { Icon, Spinner } from './icons';
import { aheadBehind, checkoutLabel, shortSha, useRepoSlice } from './shared';

function stateChip(state: GitRepoState): { text: string; hint: string } | null {
  switch (state) {
    case 'merging':
      return { text: 'Merging', hint: 'A merge is in progress — see Merge conflicts below' };
    case 'rebasing':
      return { text: 'Rebasing', hint: 'A rebase is in progress — finish it in a terminal' };
    case 'cherry-picking':
      return { text: 'Cherry-picking', hint: 'Finish it in a terminal' };
    case 'reverting':
      return { text: 'Reverting', hint: 'Finish it in a terminal' };
    case 'bisecting':
      return { text: 'Bisecting', hint: 'Finish it in a terminal' };
    default:
      return null;
  }
}

export function GitHeader({ root, tabId }: { root: string; tabId: string }) {
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const selected = useRepoSlice(root, (r) => r.selectedCheckout) ?? root;
  const status = useRepoSlice(root, (r) => r.status) ?? null;
  const loading = useRepoSlice(root, (r) => r.loading);
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const error = useRepoSlice(root, (r) => r.error) ?? null;

  const busy =
    op?.running === true ||
    (loading !== undefined && (loading.status || loading.branches || loading.worktrees));
  const noUpstream = status !== null && status.upstream === null && !status.unborn;
  const chip = status ? stateChip(status.state) : null;
  const actions = gitStore.getState();

  const branchText =
    status === null
      ? '…'
      : status.unborn
        ? 'no commits yet'
        : (status.branch ?? `${shortSha(status.head)} (detached)`);

  return (
    <header className="git-header">
      <div className="git-header-row">
        <label className="git-checkout">
          <Icon name="folder" />
          <select
            className="git-select"
            value={selected}
            title="Which checkout of this repository the panel shows"
            onChange={(e) => {
              const path = e.target.value;
              tabsStore.getState().setGitCheckout(tabId, path);
              actions.selectCheckout(root, path);
            }}
          >
            {checkouts.length === 0 ? (
              <option value={selected}>{checkoutLabel(selected, root)}</option>
            ) : (
              checkouts.map((c) => (
                <option key={c.path} value={c.path}>
                  {c.isMain
                    ? `${checkoutLabel(c.path, root)} · ${c.branch ?? 'detached'} (main)`
                    : `${checkoutLabel(c.path, root)} · ${c.branch ?? 'detached'}`}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="git-header-spacer" />
        <div className="git-header-actions">
          {busy && <Spinner title="Git is working" />}
          <button
            type="button"
            className="git-btn"
            title="git fetch --all --prune"
            disabled={status === null || op?.running === true}
            onClick={() => void actions.fetch(root, { prune: true })}
          >
            <Icon name="cloud-down" />
            Fetch
          </button>
          <button
            type="button"
            className="git-btn"
            title="git pull (merge, never rebase)"
            disabled={status === null || op?.running === true || noUpstream || status.unborn}
            onClick={() => void actions.pull(root)}
          >
            <Icon name="download" />
            Pull
          </button>
          <button
            type="button"
            className={`git-btn${noUpstream ? ' git-btn-accent' : ''}`}
            title={
              noUpstream ? 'git push -u origin HEAD — publish this branch and track it' : 'git push'
            }
            disabled={status === null || op?.running === true || status.unborn}
            onClick={() => void actions.push(root, noUpstream ? { setUpstream: true } : undefined)}
          >
            <Icon name="upload" />
            {noUpstream ? 'Publish branch' : 'Push'}
          </button>
          <button
            type="button"
            className="git-icon-btn"
            title="Refresh"
            aria-label="Refresh"
            disabled={busy}
            onClick={() => void actions.refresh(root, { force: true })}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="git-header-row git-branch-line">
        <Icon name="branch" />
        <span className="git-branch-name" title="The checked-out branch">
          {branchText}
        </span>
        {status?.upstream && (
          <span className="git-upstream" title="Upstream">
            → {status.upstream}
          </span>
        )}
        {status && aheadBehind(status.ahead, status.behind) !== '' && (
          <span className="git-ahead-behind" title="Commits ahead of / behind the upstream">
            {aheadBehind(status.ahead, status.behind)}
          </span>
        )}
        {chip && (
          <span className="git-chip git-chip-state" title={chip.hint}>
            {chip.text}
          </span>
        )}
        {status && status.branch === null && !status.unborn && (
          <span className="git-chip" title="HEAD points at a commit, not a branch">
            Detached HEAD
          </span>
        )}
        {error && (
          <span className="git-error" title={`${error.code}: ${error.message}`}>
            {error.message}
          </span>
        )}
      </div>
    </header>
  );
}
