/**
 * OutputDrawer — the bottom of the detail column while a fetch / pull / push
 * exists: git's streamed lines (stderr dimmed — that is where progress goes),
 * the one-line reading of a failure as text (a selectable `<code>`, never a
 * button that would run something), Cancel while it runs, Dismiss after.
 */

import { useEffect, useRef } from 'react';
import { gitStore } from '../../stores/git';
import { Spinner } from './icons';
import { useRepoSlice } from './shared';

const TAIL = 200;

export function OutputDrawer({ root }: { root: string }) {
  const op = useRepoSlice(root, (r) => r.op) ?? null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineCount = op?.lines.length ?? 0;

  // Follow the tail while lines stream in.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lineCount]);

  if (op === null) {
    return null;
  }
  const actions = gitStore.getState();
  const label = op.kind === 'fetch' ? 'Fetch' : op.kind === 'pull' ? 'Pull' : 'Push';
  const outcome = op.running
    ? `${label}…`
    : op.error
      ? `${label} — ${op.error}`
      : op.result?.ok
        ? `${label} done`
        : `${label} failed${op.result?.exitCode != null ? ` (exit ${op.result.exitCode})` : ''}`;
  const failed = !op.running && (op.error !== null || op.result?.ok === false);
  const lines = op.lines.slice(-TAIL);

  return (
    <div className={`git-drawer${failed ? ' is-failed' : ''}`} role="log" aria-live="polite">
      <div className="git-drawer-head">
        {op.running && <Spinner title={outcome} />}
        <span className="git-drawer-title">{outcome}</span>
        <span className="git-header-spacer" />
        {op.running ? (
          <button
            type="button"
            className="git-btn"
            title="Stop git"
            onClick={() => actions.cancelOp(root)}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="git-btn"
            title="Close this output"
            onClick={() => actions.dismissOp(root)}
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="git-drawer-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="git-drawer-line is-err">{op.running ? 'Waiting for git…' : ''}</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`git-drawer-line${line.stream === 'err' ? ' is-err' : ''}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
      {op.hint && (
        <p className="git-drawer-hint">
          <code>{op.hint}</code>
        </p>
      )}
    </div>
  );
}
