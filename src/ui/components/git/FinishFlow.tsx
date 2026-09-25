/**
 * FinishFlow — the guided end of a worktree, as a stepper over
 * `repo.finish.steps`: merge the base in, verify (paused: open a terminal in
 * the worktree, then Continue or Skip), merge into the base, remove the
 * worktree, delete the branch, clean up (the workspace entry, the terminals
 * inside). A merge that conflicts pauses on the agent-first conflict actions
 * and resumes once the tracker is clean; a failed step shows git's message
 * with Retry / Abort. State is the store's, per window, never persisted.
 */

import type { FinishStep, FinishStepId, FinishStepStatus } from '../../../core/git/types';
import { pathKey } from '../../../core/tab-workspaces';
import { gitStore } from '../../stores/git';
import { tabDisplayTitle, useTabsStore } from '../../stores/tabs';
import { useSettingsStore } from '../../stores/settings';
import { ConflictActions } from './ConflictsSection';
import { Icon, Spinner } from './icons';
import { checkoutLabel, useRepoSlice } from './shared';

const STEP_LABELS: Record<FinishStepId, string> = {
  'merge-base-in': 'Merge the base branch into the worktree',
  verify: 'Verify the result',
  'merge-into-base': 'Merge the branch into the base',
  'remove-worktree': 'Remove the worktree',
  'delete-branch': 'Delete the branch',
  cleanup: 'Clean up',
};

function StepGlyph({ status }: { status: FinishStepStatus }) {
  switch (status) {
    case 'done':
      return (
        <span className="git-step-glyph is-done">
          <Icon name="check" />
        </span>
      );
    case 'running':
      return (
        <span className="git-step-glyph">
          <Spinner />
        </span>
      );
    case 'failed':
      return (
        <span className="git-step-glyph is-failed">
          <Icon name="close" />
        </span>
      );
    case 'conflicts':
      return <span className="git-step-glyph is-warn">!</span>;
    case 'paused':
      return <span className="git-step-glyph is-paused">‖</span>;
    case 'skipped':
      return <span className="git-step-glyph is-skipped">–</span>;
    default:
      return <span className="git-step-glyph is-pending">·</span>;
  }
}

function stepText(step: FinishStep, branch: string, base: string): string {
  switch (step.id) {
    case 'merge-base-in':
      return `git merge ${base} — in the worktree, so conflicts are settled on ${branch} first`;
    case 'verify':
      return 'Run the tests or look it over — in a terminal opened here, if you like';
    case 'merge-into-base':
      return `git merge ${branch} — in the main checkout, on ${base}`;
    case 'remove-worktree':
      return 'git worktree remove — its terminals close first, then the folder goes';
    case 'delete-branch':
      return `git branch -d ${branch}`;
    case 'cleanup':
      return 'Forget the worktree workspace';
  }
}

export function FinishFlow({ root }: { root: string }) {
  const finish = useRepoSlice(root, (r) => r.finish) ?? null;
  const tracker = useRepoSlice(root, (r) => r.conflictTracker) ?? null;
  const conflicted = useRepoSlice(root, (r) => r.groups.conflicted) ?? [];
  const tabs = useTabsStore((s) => s.tabs);
  const workspaces = useSettingsStore((s) => s.settings.workspaces);
  const actions = gitStore.getState();

  if (finish === null) {
    return <div className="git-detail-hint">No finish flow is running.</div>;
  }
  const current = finish.steps[finish.current];
  const label = checkoutLabel(finish.worktree, root);
  const wtKey = pathKey(finish.worktree);
  const terminalsInside = tabs
    .filter(
      (t) =>
        t.kind === 'terminal' &&
        t.terminalCwd !== null &&
        (pathKey(t.terminalCwd) === wtKey || pathKey(t.terminalCwd).startsWith(`${wtKey}/`)),
    )
    .map(tabDisplayTitle);
  const workspaceEntry = workspaces.find((w) => pathKey(w.path) === wtKey) ?? null;

  const cleanCount = tracker ? tracker.files.filter((f) => tracker.markerFree[f]).length : 0;
  const trackerClean =
    conflicted.length === 0 && (tracker === null || cleanCount === tracker.files.length);

  return (
    <div className="git-detail-scroll git-finish">
      <div className="git-commit-head">
        <div className="git-commit-title">
          <Icon name="flag" />
          <span className="git-commit-subject">
            Finish {label} · {finish.branch} → {finish.base}
          </span>
        </div>
        <div className="git-commit-byline">
          {finish.finished
            ? finish.aborted
              ? 'Aborted — nothing more will run.'
              : 'Done.'
            : 'Each step runs in turn; the flow pauses where you are needed.'}
        </div>
      </div>

      <ol className="git-steps">
        {finish.steps.map((step, i) => (
          <li
            key={step.id}
            className={`git-step is-${step.status}${i === finish.current ? ' is-current' : ''}`}
          >
            <StepGlyph status={step.status} />
            <div className="git-step-text">
              <div className="git-step-title">{STEP_LABELS[step.id]}</div>
              <div className="git-step-sub">{stepText(step, finish.branch, finish.base)}</div>
              {step.status === 'failed' && step.error && (
                <pre className="git-step-error">{step.error}</pre>
              )}
            </div>
          </li>
        ))}
      </ol>

      {!finish.finished && current && (
        <div className="git-finish-actions">
          {current.status === 'paused' && current.id === 'verify' && (
            <>
              <span
                className="git-btn-group"
                title="Open a terminal in the worktree (nothing is typed)"
              >
                <button
                  type="button"
                  className="git-btn"
                  onClick={() => actions.openTerminalIn(root, finish.worktree, false)}
                >
                  <Icon name="terminal" />
                  Terminal here
                </button>
                <button
                  type="button"
                  className="git-btn"
                  onClick={() => actions.openTerminalIn(root, finish.worktree, true)}
                >
                  <Icon name="sparkle" />
                  Harness here
                </button>
              </span>
              <span className="git-header-spacer" />
              <button
                type="button"
                className="git-btn"
                onClick={() => void actions.skipFinishStep(root)}
              >
                Skip
              </button>
              <button
                type="button"
                className="git-btn git-btn-accent"
                onClick={() => void actions.continueFinish(root)}
              >
                Continue
              </button>
            </>
          )}
          {current.status === 'paused' &&
            (current.id === 'remove-worktree' || current.id === 'cleanup') && (
              <>
                <p className="git-finish-confirm">
                  {current.id === 'remove-worktree' ? (
                    <>
                      This removes <code>{finish.worktree}</code>.
                      {terminalsInside.length > 0 && (
                        <>
                          {' '}
                          {terminalsInside.length === 1 ? 'The terminal' : 'The terminals'}{' '}
                          <b>{terminalsInside.join(', ')}</b> will be closed first.
                        </>
                      )}
                      {workspaceEntry && (
                        <>
                          {' '}
                          The workspace <b>{workspaceEntry.name}</b> will be removed from the
                          sidebar (no files elsewhere are touched).
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Forget the worktree's workspace entry
                      {workspaceEntry ? (
                        <>
                          {' '}
                          (<b>{workspaceEntry.name}</b>)
                        </>
                      ) : null}
                      .
                    </>
                  )}
                </p>
                <span className="git-header-spacer" />
                <button
                  type="button"
                  className="git-btn"
                  onClick={() => void actions.skipFinishStep(root)}
                >
                  Skip
                </button>
                <button
                  type="button"
                  className="git-btn git-btn-accent"
                  onClick={() => void actions.continueFinish(root)}
                >
                  Continue
                </button>
              </>
            )}
          {current.status === 'conflicts' && (
            <>
              <p className="git-tracker-line" role="status">
                {trackerClean
                  ? 'Every file is clean — continue when you have reviewed the merge.'
                  : `Waiting for your agent — ${cleanCount} of ${tracker?.files.length ?? finish.conflicts?.length ?? 0} files clean`}
              </p>
              <ConflictActions
                root={root}
                checkout={current.id === 'merge-into-base' ? root : finish.worktree}
              />
              <span className="git-header-spacer" />
              <button
                type="button"
                className="git-btn is-danger"
                title="git merge --abort, and stop the flow"
                onClick={() => void actions.abortFinish(root)}
              >
                Abort
              </button>
              <button
                type="button"
                className="git-btn git-btn-accent"
                disabled={!trackerClean}
                title={trackerClean ? 'Commit the merge and go on' : 'Files are still unmerged'}
                onClick={() => void actions.continueFinish(root)}
              >
                Continue
              </button>
            </>
          )}
          {current.status === 'failed' && (
            <>
              <span className="git-header-spacer" />
              <button
                type="button"
                className="git-btn is-danger"
                onClick={() => void actions.abortFinish(root)}
              >
                Abort
              </button>
              <button
                type="button"
                className="git-btn"
                onClick={() => void actions.skipFinishStep(root)}
              >
                Skip step
              </button>
              <button
                type="button"
                className="git-btn git-btn-accent"
                onClick={() => void actions.retryFinishStep(root)}
              >
                Retry
              </button>
            </>
          )}
          {(current.status === 'running' || current.status === 'pending') && (
            <>
              <span className="git-header-spacer" />
              <button
                type="button"
                className="git-btn is-danger"
                onClick={() => void actions.abortFinish(root)}
              >
                Abort
              </button>
            </>
          )}
        </div>
      )}
      {finish.finished && (
        <div className="git-finish-actions">
          <span className="git-header-spacer" />
          <button
            type="button"
            className="git-btn"
            onClick={() => {
              actions.dismissFinish(root);
              actions.select(root, null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
