/**
 * BranchesSection — local branches, then remote ones, through a fuzzy
 * filter; the current one bold; a note when a branch is checked out in a
 * worktree (git refuses to switch to or delete it there). Row actions:
 * Switch (a remote branch becomes a tracking local one), Merge into current,
 * Delete. The header's "+" opens an inline New-branch input.
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { rankCandidates } from '../../../core/fuzzy';
import { validateBranchName } from '../../../core/git/refs';
import type { GitBranch } from '../../../core/git/types';
import { gitStore } from '../../stores/git';
import { Icon } from './icons';
import { aheadBehind, checkoutLabel, Empty, IconButton, Section, useRepoSlice } from './shared';

/** The live check under the New-branch input — the same rules the store applies. */
const branchNameError = (name: string): string | null => validateBranchName(name.trim());

function BranchRow({
  root,
  branch,
  checkedOutIn,
}: {
  root: string;
  branch: GitBranch;
  checkedOutIn: string | null;
}) {
  const actions = gitStore.getState();
  const local = branch.kind === 'local';
  const elsewhere = checkedOutIn !== null && !branch.current;
  return (
    <div className={`git-row git-branch-row${branch.current ? ' is-current' : ''}`}>
      <Icon name="branch" />
      <span className="git-branch-label" title={branch.name}>
        {branch.name}
      </span>
      {branch.gone && (
        <span className="git-chip git-chip-warn" title="Its upstream no longer exists">
          gone
        </span>
      )}
      {aheadBehind(branch.ahead, branch.behind) !== '' && (
        <span className="git-ahead-behind" title={`Against ${branch.upstream ?? 'upstream'}`}>
          {aheadBehind(branch.ahead, branch.behind)}
        </span>
      )}
      {elsewhere && (
        <span className="git-note" title={`Checked out in ${checkedOutIn}`}>
          in {checkedOutIn}
        </span>
      )}
      <span className="git-row-actions">
        {!branch.current && (
          <IconButton
            icon="check"
            title={
              elsewhere
                ? `Checked out in ${checkedOutIn} — switch there instead`
                : local
                  ? `Switch to ${branch.name}`
                  : `Check out ${branch.name} as a local tracking branch`
            }
            disabled={elsewhere}
            onClick={() => void actions.switchBranch(root, branch)}
          />
        )}
        {!branch.current && (
          <IconButton
            icon="merge-in"
            title={`Merge ${branch.name} into the current branch`}
            onClick={() => void actions.merge(root, branch.name)}
          />
        )}
        {local && !branch.current && (
          <IconButton
            icon="trash"
            title={elsewhere ? `Checked out in ${checkedOutIn}` : `Delete ${branch.name}`}
            danger
            disabled={elsewhere}
            onClick={() => void actions.deleteBranch(root, branch.name)}
          />
        )}
      </span>
    </div>
  );
}

export function BranchesSection({ root }: { root: string }) {
  const branches = useRepoSlice(root, (r) => r.branches) ?? [];
  const filter = useRepoSlice(root, (r) => r.branchFilter) ?? '';
  const checkouts = useRepoSlice(root, (r) => r.checkouts) ?? [];
  const loading = useRepoSlice(root, (r) => r.loading.branches) ?? false;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const actions = gitStore.getState();

  const shown = filter.trim() === '' ? branches : rankCandidates(filter, branches, (b) => b.name);
  const locals = shown.filter((b) => b.kind === 'local');
  const remotes = shown.filter((b) => b.kind === 'remote');
  const checkedOutIn = (name: string): string | null => {
    const c = checkouts.find((x) => x.branch === name);
    return c ? checkoutLabel(c.path, root) : null;
  };
  const nameError = creating ? branchNameError(newName) : null;

  const submitNew = () => {
    if (nameError !== null) {
      return;
    }
    void actions.createBranch(root, newName.trim(), null, true);
    setCreating(false);
    setNewName('');
  };
  const onNewKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNew();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCreating(false);
      setNewName('');
    }
  };

  return (
    <Section
      title="Branches"
      count={branches.length}
      defaultOpen={false}
      actions={
        <button
          type="button"
          className="git-link-btn"
          title="Create a branch here and switch to it"
          onClick={() => setCreating((v) => !v)}
        >
          <Icon name="plus" />
          New branch
        </button>
      }
    >
      {creating && (
        <div className="git-inline-form">
          <input
            className="git-input"
            type="text"
            placeholder="feat/my-branch"
            value={newName}
            autoFocus
            spellCheck={false}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={onNewKey}
          />
          <button
            type="button"
            className="git-btn git-btn-accent"
            disabled={nameError !== null}
            title={nameError ?? 'git switch -c'}
            onClick={submitNew}
          >
            Create
          </button>
          {nameError !== null && newName !== '' && (
            <span className="git-field-error">{nameError}</span>
          )}
        </div>
      )}
      <input
        className="git-input git-filter"
        type="search"
        placeholder="Filter branches"
        value={filter}
        spellCheck={false}
        onChange={(e) => actions.setBranchFilter(root, e.target.value)}
      />
      {branches.length === 0 ? (
        <Empty>{loading ? 'Listing branches…' : 'No branches'}</Empty>
      ) : (
        <>
          {locals.map((b) => (
            <BranchRow key={b.name} root={root} branch={b} checkedOutIn={checkedOutIn(b.name)} />
          ))}
          {remotes.length > 0 && <div className="git-subhead">Remote</div>}
          {remotes.map((b) => (
            <BranchRow key={b.name} root={root} branch={b} checkedOutIn={null} />
          ))}
          {shown.length === 0 && <Empty>No branch matches</Empty>}
        </>
      )}
    </Section>
  );
}
