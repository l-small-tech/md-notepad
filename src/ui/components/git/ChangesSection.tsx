/**
 * ChangesSection — Staged / Changes / Untracked, each a collapsible group
 * with a count, plus the commit box. Rows are the store's pre-grouped
 * `repo.groups`; every action is a store call.
 *
 * mod+Enter in the message box commits. Handled on the textarea itself (and
 * stopped there) so the global shortcut listener never sees it.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { GitStatusEntry, StatusGroup } from '../../../core/git/types';
import { gitStore } from '../../stores/git';
import { Empty, IconButton, PathLabel, Section, StatusGlyph, useRepoSlice } from './shared';

function ChangeRow({
  root,
  group,
  entry,
  selected,
}: {
  root: string;
  group: StatusGroup;
  entry: GitStatusEntry;
  selected: boolean;
}) {
  const actions = gitStore.getState();
  const letter = group === 'untracked' ? '?' : group === 'staged' ? entry.index : entry.worktree;
  return (
    <div
      className={`git-row git-change-row${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => actions.select(root, { kind: 'file', group, path: entry.path })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          actions.select(root, { kind: 'file', group, path: entry.path });
        }
      }}
    >
      <StatusGlyph letter={letter} title={`git status: ${letter}`} />
      <PathLabel path={entry.path} origPath={entry.origPath} />
      <span className="git-row-actions">
        {group === 'staged' ? (
          <IconButton
            icon="minus"
            title="Unstage"
            onClick={() => void actions.unstage(root, [entry.path])}
          />
        ) : (
          <IconButton
            icon="plus"
            title="Stage"
            onClick={() => void actions.stage(root, [entry.path])}
          />
        )}
        {group !== 'staged' && (
          <IconButton
            icon={group === 'untracked' ? 'trash' : 'undo'}
            title={group === 'untracked' ? 'Delete this untracked file' : 'Discard changes'}
            danger
            onClick={() => void actions.discard(root, [entry.path])}
          />
        )}
      </span>
    </div>
  );
}

function Group({
  root,
  group,
  title,
  entries,
  selectedPath,
  action,
  defaultOpen,
}: {
  root: string;
  group: StatusGroup;
  title: string;
  entries: GitStatusEntry[];
  selectedPath: string | null;
  action?: { label: string; title: string; run: () => void };
  defaultOpen?: boolean;
}) {
  return (
    <Section
      title={title}
      count={entries.length}
      defaultOpen={defaultOpen}
      actions={
        action && entries.length > 0 ? (
          <button type="button" className="git-link-btn" title={action.title} onClick={action.run}>
            {action.label}
          </button>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <Empty>Nothing here</Empty>
      ) : (
        entries.map((entry) => (
          <ChangeRow
            key={`${group}:${entry.path}`}
            root={root}
            group={group}
            entry={entry}
            selected={selectedPath === entry.path}
          />
        ))
      )}
    </Section>
  );
}

export function ChangesSection({ root }: { root: string }) {
  const groups = useRepoSlice(root, (r) => r.groups);
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const draft = useRepoSlice(root, (r) => r.commitDraft) ?? '';
  const amend = useRepoSlice(root, (r) => r.amend) ?? false;
  const status = useRepoSlice(root, (r) => r.status) ?? null;
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const actions = gitStore.getState();

  const staged = groups?.staged ?? [];
  const unstaged = groups?.unstaged ?? [];
  const untracked = groups?.untracked ?? [];
  const selectedIn = (group: StatusGroup) =>
    selected?.kind === 'file' && selected.group === group ? selected.path : null;

  const merging = status?.state === 'merging';
  const reason =
    status === null
      ? 'Waiting for git'
      : op?.running
        ? 'Wait for the running operation'
        : staged.length === 0 && !amend && !merging
          ? 'Stage something to commit'
          : draft.trim() === '' && !amend && !merging
            ? 'Write a commit message'
            : null;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (reason === null) {
        void actions.commit(root);
      }
    }
  };

  return (
    <div className="git-changes">
      <Group
        root={root}
        group="staged"
        title="Staged"
        entries={staged}
        selectedPath={selectedIn('staged')}
        action={{
          label: 'Unstage all',
          title: 'git restore --staged .',
          run: () =>
            void actions.unstage(
              root,
              staged.map((e) => e.path),
            ),
        }}
      />
      <Group
        root={root}
        group="unstaged"
        title="Changes"
        entries={unstaged}
        selectedPath={selectedIn('unstaged')}
        action={{
          label: 'Stage all',
          title: 'git add -A on these files',
          run: () =>
            void actions.stage(
              root,
              unstaged.map((e) => e.path),
            ),
        }}
      />
      <Group
        root={root}
        group="untracked"
        title="Untracked"
        entries={untracked}
        selectedPath={selectedIn('untracked')}
        defaultOpen={untracked.length <= 20}
        action={{
          label: 'Stage all',
          title: 'git add these files',
          run: () =>
            void actions.stage(
              root,
              untracked.map((e) => e.path),
            ),
        }}
      />
      <div className="git-commit">
        <textarea
          className="git-commit-message"
          rows={3}
          placeholder={
            merging
              ? 'Merge message (git prepared one; leave empty to keep it)'
              : amend
                ? 'New message (leave empty to keep the last one)'
                : 'Commit message  (Ctrl/Cmd+Enter to commit)'
          }
          value={draft}
          spellCheck={false}
          onChange={(e) => actions.setCommitDraft(root, e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="git-commit-row">
          <label className="git-check" title="git commit --amend — fold into the last commit">
            <input
              type="checkbox"
              checked={amend}
              disabled={status === null || status.unborn}
              onChange={() => actions.toggleAmend(root)}
            />
            Amend
          </label>
          <span className="git-header-spacer" />
          <button
            type="button"
            className="git-btn git-btn-accent"
            disabled={reason !== null}
            title={reason ?? (amend ? 'git commit --amend' : 'git commit')}
            onClick={() => void actions.commit(root)}
          >
            {merging ? 'Commit merge' : amend ? 'Amend' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  );
}
