/**
 * StatusPanel — "Workspace status": every prompt an agent has reported on,
 * across the workspaces that keep a `prompts/STATUSES.md`, grouped by status with
 * what needs the user first (`core/prompt-status.ts groupByStatus`). A row
 * opens its note. Same slide-in shell as the review-notes overview.
 *
 * Mounted once at the app root; Escape closes it (main.tsx).
 */

import { STATUS_LABELS, groupByStatus, splitPromptKey } from '../../core/prompt-status';
import { baseName, joinPath } from '../../core/session/plan-flush';
import { promptStatus, usePromptStatus } from '../prompt-status';
import { openNotePath } from '../session';

export function StatusPanel() {
  const open = usePromptStatus((s) => s.panelOpen);
  const byRoot = usePromptStatus((s) => s.byRoot);
  const close = () => promptStatus().setPanelOpen(false);
  const workspaces = Object.values(byRoot);

  return (
    <div
      className="rn-backdrop"
      data-open={open || undefined}
      aria-hidden={!open}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div className="rn-panel" role="dialog" aria-label="Workspace status">
        <div className="rn-head">
          <div className="rn-title">
            <h2>Workspace status</h2>
          </div>
          <button
            className="rn-icon-btn"
            onClick={() => void promptStatus().refresh()}
            aria-label="Refresh"
            title="Read STATUSES.md again"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9" />
              <path d="M15.6 3.6v3.2h-3.2" />
            </svg>
          </button>
          <button className="rn-icon-btn" onClick={close} aria-label="Close" title="Close (Esc)">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <div className="prompt-panel-body">
          {workspaces.length === 0 && (
            <p className="prompt-panel-empty">
              No workspace is tracking prompts yet. Run “Initialize workspace…” with the Prompt
              status directive to start.
            </p>
          )}
          {workspaces.map((ws) => (
            <section key={ws.root} className="prompt-panel-ws">
              <h3 className="prompt-panel-ws-name" title={ws.root}>
                {baseName(ws.root) || ws.root}
              </h3>
              {ws.rows.length === 0 && (
                <p className="prompt-panel-empty">
                  Nothing yet — open a note and press Copy as prompt.
                </p>
              )}
              {groupByStatus(ws.rows).map((group) => (
                <div key={group.status} className="prompt-panel-group">
                  <div className="prompt-chip prompt-panel-group-head" data-status={group.status}>
                    <span className="prompt-chip-dot" aria-hidden="true" />
                    <span className="prompt-chip-status">{STATUS_LABELS[group.status]}</span>
                    <span className="prompt-panel-count">{group.rows.length}</span>
                  </div>
                  {group.rows.map((row) => {
                    const { note, slug } = splitPromptKey(row.key);
                    return (
                      <button
                        key={row.key}
                        className="prompt-panel-row"
                        title={`Open ${note}`}
                        onClick={() => {
                          openNotePath(joinPath(ws.root, note));
                          close();
                        }}
                      >
                        <span className="prompt-panel-row-title">
                          {baseName(note)}
                          {slug && <span className="prompt-panel-row-slug"> #{slug}</span>}
                        </span>
                        {row.summary && (
                          <span className="prompt-panel-row-summary">{row.summary}</span>
                        )}
                        <span className="prompt-panel-row-time">{row.updated}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
