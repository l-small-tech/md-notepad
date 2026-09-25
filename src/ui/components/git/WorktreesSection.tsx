/**
 * WorktreesSection — the dashboard of every checkout: branch, dirty count,
 * ahead/behind against the base branch, a dot when one of this window's
 * terminals is standing inside it, missing / locked chips, and the row
 * actions (open as workspace, a shell or the harness in it, its diff against
 * the base, merges either way, the guided Finish flow, Remove). The main
 * checkout has no Remove or Finish. "New worktree" opens the dialog.
 */

import { terminalsInside as terminalsIn } from '../../../core/git/checkouts';
import type { GitCheckout } from '../../../core/git/types';
import { gitStore } from '../../stores/git';
import { tabDisplayTitle, useTabsStore, type TabEntry } from '../../stores/tabs';
import { Icon } from './icons';
import { aheadBehind, checkoutLabel, Empty, IconButton, Section, useRepoSlice } from './shared';

/** Titles of the terminal tabs whose shell is inside `path` (core's containment rule). */
function terminalsInside(tabs: readonly TabEntry[], path: string): string[] {
  const shells = tabs
    .filter((t) => t.kind === 'terminal')
    .map((t) => ({ id: t.id, title: tabDisplayTitle(t), cwd: t.terminalCwd }));
  return terminalsIn(shells, path).map((s) => s.title);
}

function WorktreeRow({
  root,
  checkout,
  base,
  selected,
  terminals,
}: {
  root: string;
  checkout: GitCheckout;
  base: string | null;
  selected: boolean;
  terminals: string[];
}) {
  const actions = gitStore.getState();
  const s = checkout.summary;
  const dirty = s ? s.staged + s.unstaged + s.untracked + s.conflicted : 0;
  const isMain = checkout.isMain;
  const onBase = base !== null && checkout.branch === base;
  const select = () => {
    if (!isMain) {
      actions.select(root, { kind: 'worktree-diff', path: checkout.path });
    }
  };
  return (
    <div
      className={`git-row git-worktree-row${selected ? ' is-selected' : ''}${s?.missing ? ' is-missing' : ''}`}
      role={isMain ? undefined : 'button'}
      tabIndex={isMain ? undefined : 0}
      title={checkout.path}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          select();
        }
      }}
    >
      <div className="git-worktree-main">
        <span className="git-worktree-name">
          {checkoutLabel(checkout.path, root)}
          {isMain && <span className="git-chip">main</span>}
        </span>
        <span className="git-worktree-branch">
          <Icon name="branch" />
          {checkout.branch ?? 'detached'}
        </span>
        {s && dirty > 0 && (
          <span
            className="git-badge git-tone-modified"
            title={`${s.staged} staged · ${s.unstaged} changed · ${s.untracked} untracked${s.conflicted ? ` · ${s.conflicted} conflicted` : ''}`}
          >
            {dirty}
          </span>
        )}
        {s && s.conflicted > 0 && (
          <span className="git-chip git-chip-warn" title="Unmerged files">
            conflicts
          </span>
        )}
        {s && aheadBehind(s.ahead, s.behind) !== '' && (
          <span className="git-ahead-behind" title={`Against ${base ?? 'the base branch'}`}>
            {aheadBehind(s.ahead, s.behind)}
          </span>
        )}
        {s && s.state !== 'clean' && <span className="git-chip git-chip-state">{s.state}</span>}
        {s?.missing && (
          <span
            className="git-chip git-chip-warn"
            title="The folder is gone (git calls it prunable)"
          >
            missing
          </span>
        )}
        {s?.locked && (
          <span className="git-chip" title="Locked — git will not prune it">
            locked
          </span>
        )}
        {terminals.length > 0 && (
          <span
            className="git-terminal-dot"
            title={`Terminal open here: ${terminals.join(', ')}`}
            aria-label={`${terminals.length} terminal(s) open here`}
          />
        )}
      </div>
      <span className="git-row-actions git-worktree-actions">
        <IconButton
          icon="folder"
          title="Open as workspace"
          disabled={s?.missing === true}
          onClick={() => actions.openWorktreeAsWorkspace(root, checkout.path)}
        />
        <IconButton
          icon="terminal"
          title="Terminal here"
          disabled={s?.missing === true}
          onClick={() => actions.openTerminalIn(root, checkout.path, false)}
        />
        <IconButton
          icon="sparkle"
          title="Harness here"
          disabled={s?.missing === true}
          onClick={() => actions.openTerminalIn(root, checkout.path, true)}
        />
        {!onBase && base !== null && (
          <IconButton
            icon="diff"
            title={`Files changed against ${base}`}
            onClick={() => actions.select(root, { kind: 'worktree-diff', path: checkout.path })}
          />
        )}
        {!onBase && base !== null && checkout.branch !== null && (
          <>
            <IconButton
              icon="merge-in"
              title={`Merge ${base} into ${checkout.branch} (here)`}
              disabled={s?.missing === true}
              onClick={() =>
                void actions.merge(root, base, { root: checkout.path, into: checkout.branch ?? '' })
              }
            />
            <IconButton
              icon="merge-out"
              title={`Merge ${checkout.branch} into ${base} (in the main checkout)`}
              onClick={() => void actions.merge(root, checkout.branch ?? '', { root, into: base })}
            />
          </>
        )}
        {!isMain && (
          <>
            <IconButton
              icon="flag"
              title="Finish… — merge into the base branch, remove the worktree, delete the branch"
              onClick={() => void actions.startFinish(root, checkout.path)}
            />
            <IconButton
              icon="trash"
              title="Remove this worktree"
              danger
              onClick={() => void actions.removeWorktree(root, checkout.path)}
            />
          </>
        )}
      </span>
    </div>
  );
}

export function WorktreesSection({ root }: { root: string }) {
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const base = useRepoSlice(root, (r) => r.info?.baseBranch ?? null) ?? null;
  const loading = useRepoSlice(root, (r) => r.loading.worktrees) ?? false;
  const tabs = useTabsStore((s) => s.tabs);
  const actions = gitStore.getState();

  return (
    <Section
      title="Worktrees"
      count={checkouts.length}
      actions={
        <button
          type="button"
          className="git-link-btn"
          title="Create a linked worktree on a new branch"
          onClick={() => actions.openNewWorktree(root)}
        >
          <Icon name="plus" />
          New worktree
        </button>
      }
    >
      {checkouts.length === 0 ? (
        <Empty>{loading ? 'Listing worktrees…' : 'No worktrees listed yet'}</Empty>
      ) : (
        checkouts.map((c) => (
          <WorktreeRow
            key={c.path}
            root={root}
            checkout={c}
            base={base}
            selected={selected?.kind === 'worktree-diff' && selected.path === c.path}
            terminals={terminalsInside(tabs, c.path)}
          />
        ))
      )}
    </Section>
  );
}
