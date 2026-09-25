/**
 * ConflictsSection — shown only while the selected checkout has unmerged
 * files or an armed conflict tracker. Conflicts are the user's AGENT's job:
 * the primary action puts an agent-ready prompt on the clipboard, the
 * secondary ones open a shell or the harness IN the checkout (nothing is
 * typed), and Continue stays disabled until the tracker says every file is
 * marker-free and staged. Clicking a file opens it as plain text; Mark
 * resolved stages it.
 */

import { joinPath } from '../../../core/session/plan-flush';
import { openNotePath } from '../../session';
import { gitStore } from '../../stores/git';
import { Icon } from './icons';
import { IconButton, PathLabel, Section, StatusGlyph, useRepoSlice } from './shared';

/** The three actions a conflict offers, shared with the finish flow's conflicts step. */
export function ConflictActions({ root, checkout }: { root: string; checkout: string }) {
  const actions = gitStore.getState();
  return (
    <div className="git-conflict-actions">
      <button
        type="button"
        className="git-btn git-btn-accent"
        title="Copy a prompt describing this merge and its files — paste it into your AI agent"
        onClick={() => void actions.copyConflictPrompt(root)}
      >
        <Icon name="copy" />
        Copy conflict prompt
      </button>
      <span className="git-btn-group" title="Open a terminal in this checkout (nothing is typed)">
        <button
          type="button"
          className="git-btn"
          onClick={() => actions.openTerminalIn(root, checkout, false)}
        >
          <Icon name="terminal" />
          Terminal here
        </button>
        <button
          type="button"
          className="git-btn"
          onClick={() => actions.openTerminalIn(root, checkout, true)}
        >
          <Icon name="sparkle" />
          Harness here
        </button>
      </span>
    </div>
  );
}

export function ConflictsSection({ root }: { root: string }) {
  const conflicted = useRepoSlice(root, (r) => r.groups.conflicted) ?? [];
  const tracker = useRepoSlice(root, (r) => r.conflictTracker) ?? null;
  const status = useRepoSlice(root, (r) => r.status) ?? null;
  const checkout = useRepoSlice(root, (r) => r.selectedCheckout) ?? root;
  const finish = useRepoSlice(root, (r) => r.finish) ?? null;
  const actions = gitStore.getState();

  const merging = status?.state === 'merging';
  if (conflicted.length === 0 && tracker === null && !merging) {
    return null;
  }
  // The finish flow's conflicts step renders these same actions in the
  // detail pane; the side keeps the file list and the tracker line only.
  const inFinish = finish !== null && !finish.finished && finish.conflicts !== null;

  const markerFree = (path: string) => tracker?.markerFree[path] === true;
  const cleanCount = tracker ? tracker.files.filter(markerFree).length : 0;
  const markersLeft = tracker ? tracker.files.length - cleanCount : 0;
  const reason =
    conflicted.length > 0
      ? `${conflicted.length} file${conflicted.length === 1 ? '' : 's'} still unmerged`
      : markersLeft > 0
        ? `Conflict markers remain in ${markersLeft} file${markersLeft === 1 ? '' : 's'}`
        : null;

  return (
    <Section
      title="Merge conflicts"
      count={conflicted.length}
      tone="danger"
      className="git-conflicts"
    >
      {tracker && (
        <p className="git-conflict-lead">
          Merging <code>{tracker.from}</code> into <code>{tracker.into}</code>
        </p>
      )}
      {conflicted.length === 0 ? (
        <div className="git-empty">No unmerged files — review the result, then continue.</div>
      ) : (
        conflicted.map((entry) => (
          <div
            key={entry.path}
            className="git-row git-change-row"
            role="button"
            tabIndex={0}
            title="Open as plain text"
            onClick={() => openNotePath(joinPath(checkout, entry.path))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                openNotePath(joinPath(checkout, entry.path));
              }
            }}
          >
            <StatusGlyph letter="U" title="Unmerged" />
            <PathLabel path={entry.path} />
            {tracker && (
              <span
                className={`git-chip ${markerFree(entry.path) ? 'git-chip-ok' : 'git-chip-warn'}`}
                title={
                  markerFree(entry.path)
                    ? 'No conflict markers left in this file'
                    : 'Conflict markers still present'
                }
              >
                {markerFree(entry.path) ? 'clean' : 'markers'}
              </span>
            )}
            <span className="git-row-actions">
              <IconButton
                icon="check"
                title="Mark resolved — save it if open, then git add"
                onClick={() => void actions.markResolved(root, entry.path)}
              />
            </span>
          </div>
        ))
      )}
      {tracker && (
        <p className="git-tracker-line" role="status">
          {reason === null
            ? 'Every file is clean — continue the merge when you have reviewed it.'
            : `Waiting for your agent — ${cleanCount} of ${tracker.files.length} file${tracker.files.length === 1 ? '' : 's'} clean`}
        </p>
      )}
      {!inFinish && (
        <>
          <ConflictActions root={root} checkout={checkout} />
          <div className="git-conflict-actions">
            <button
              type="button"
              className="git-btn is-danger"
              title="git merge --abort — back to before the merge"
              onClick={() => void actions.abortMerge(root)}
            >
              Abort merge
            </button>
            <button
              type="button"
              className="git-btn git-btn-accent"
              disabled={reason !== null}
              title={reason ?? 'git commit --no-edit — finish the merge'}
              onClick={() => void actions.continueMerge(root)}
            >
              Continue merge
            </button>
          </div>
        </>
      )}
    </Section>
  );
}
