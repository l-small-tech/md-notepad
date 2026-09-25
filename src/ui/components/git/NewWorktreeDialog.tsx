/**
 * NewWorktreeDialog — one worktree in one click: a slug, a branch prefix, a
 * base branch, and whether to open a shell or the harness in it afterwards
 * (in it — nothing is typed). The preview line says exactly what Create will
 * do. Settings-dialog chrome; Escape closes (the host's keydown handler).
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { validateSlug } from '../../../core/git/refs';
import { gitStore } from '../../stores/git';
import { useRepoSlice } from './shared';

const PREFIXES = ['feat/', 'fix/', 'chore/'] as const;

/** The live check under the slug field — the same rule the store applies on Create. */
const slugError = validateSlug;

export function NewWorktreeDialog({ root }: { root: string }) {
  const draft = useRepoSlice(root, (r) => r.newWorktree);
  const branches = useRepoSlice(root, (r) => r.branches) ?? [];
  const baseBranch = useRepoSlice(root, (r) => r.info?.baseBranch ?? null) ?? null;
  const actions = gitStore.getState();
  if (!draft || !draft.open) {
    return null;
  }
  const customPrefix = !(PREFIXES as readonly string[]).includes(draft.prefix);
  const error = draft.error ?? (draft.slug === '' ? null : slugError(draft.slug));
  const canCreate = !draft.busy && slugError(draft.slug) === null;
  const base = draft.base === '' ? (baseBranch ?? 'the base branch') : draft.base;
  const locals = branches.filter((b) => b.kind === 'local');

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && canCreate && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      void actions.createWorktree(root);
    }
  };

  return (
    <div
      className="settings-backdrop git-dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          actions.closeNewWorktree(root);
        }
      }}
    >
      <div
        className="settings-dialog git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New worktree"
        onKeyDown={onKeyDown}
      >
        <header className="settings-header">
          <h2 className="settings-title">New worktree</h2>
          <button
            className="settings-close"
            aria-label="Close"
            onClick={() => actions.closeNewWorktree(root)}
          >
            ×
          </button>
        </header>
        <div className="git-dialog-body">
          <label className="git-field">
            <span className="git-field-label">Name</span>
            <input
              className="git-input"
              type="text"
              value={draft.slug}
              autoFocus
              spellCheck={false}
              placeholder="my-feature"
              disabled={draft.busy}
              onChange={(e) =>
                actions.setNewWorktreeField(root, { slug: e.target.value.trim().toLowerCase() })
              }
            />
          </label>
          <div className="git-field">
            <span className="git-field-label">Branch</span>
            <div className="git-field-row">
              <select
                className="git-select"
                value={customPrefix ? 'custom' : draft.prefix}
                disabled={draft.busy}
                onChange={(e) =>
                  actions.setNewWorktreeField(root, {
                    prefix: e.target.value === 'custom' ? '' : e.target.value,
                  })
                }
              >
                {PREFIXES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="custom">custom…</option>
              </select>
              {customPrefix && (
                <input
                  className="git-input"
                  type="text"
                  value={draft.prefix}
                  placeholder="prefix/ (or empty)"
                  spellCheck={false}
                  disabled={draft.busy}
                  onChange={(e) => actions.setNewWorktreeField(root, { prefix: e.target.value })}
                />
              )}
              <code className="git-preview-branch">
                {draft.prefix}
                {draft.slug || 'my-feature'}
              </code>
            </div>
          </div>
          <label className="git-field">
            <span className="git-field-label">From</span>
            <select
              className="git-select"
              value={draft.base}
              disabled={draft.busy}
              onChange={(e) => actions.setNewWorktreeField(root, { base: e.target.value })}
            >
              <option value="">{baseBranch ? `${baseBranch} (base branch)` : 'base branch'}</option>
              {locals
                .filter((b) => b.name !== baseBranch)
                .map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="git-field">
            <span className="git-field-label">Then open</span>
            <select
              className="git-select"
              value={draft.openTerminal}
              disabled={draft.busy}
              onChange={(e) =>
                actions.setNewWorktreeField(root, {
                  openTerminal: e.target.value as 'none' | 'shell' | 'harness',
                })
              }
            >
              <option value="harness">the harness, in the worktree</option>
              <option value="shell">a shell, in the worktree</option>
              <option value="none">nothing</option>
            </select>
          </label>
          <p className="git-dialog-preview">
            Creates <code>worktrees/{draft.slug || 'my-feature'}</code> on{' '}
            <code>
              {draft.prefix}
              {draft.slug || 'my-feature'}
            </code>{' '}
            from <code>{base}</code>
            {draft.openTerminal !== 'none' &&
              ` and opens ${draft.openTerminal === 'harness' ? 'the harness' : 'a shell'} there`}
            .
          </p>
          {error && <p className="git-field-error">{error}</p>}
        </div>
        <footer className="git-dialog-footer">
          <button
            type="button"
            className="git-btn"
            disabled={draft.busy}
            onClick={() => actions.closeNewWorktree(root)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="git-btn git-btn-accent"
            disabled={!canCreate}
            title={slugError(draft.slug) ?? 'git worktree add'}
            onClick={() => void actions.createWorktree(root)}
          >
            {draft.busy ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}
