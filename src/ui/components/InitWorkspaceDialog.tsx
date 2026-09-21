/**
 * InitWorkspaceDialog — "Initialize workspace…" / "Workspace directives…".
 *
 * Pick (or create) a folder, tick the directives its AGENTS.md should carry,
 * choose which harness entry files point at it, Create. Re-run on an
 * existing workspace it starts from what AGENTS.md already has; unticking a
 * directive removes its section, and files agents have filled in are never
 * overwritten. State and effects: `ui/workspace-init.ts`.
 */

import { HARNESS_STUBS } from '../../core/workspace-modules';
import {
  applyWorkspaceInit,
  closeWorkspaceInit,
  openModulesFolder,
  pickInitFolder,
  toggleInitModule,
  toggleInitStub,
  useWorkspaceInit,
} from '../workspace-init';

export function InitWorkspaceDialog() {
  const open = useWorkspaceInit((s) => s.open);
  const root = useWorkspaceInit((s) => s.root);
  const rerun = useWorkspaceInit((s) => s.rerun);
  const modules = useWorkspaceInit((s) => s.modules);
  const selected = useWorkspaceInit((s) => s.selected);
  const installed = useWorkspaceInit((s) => s.installed);
  const stubs = useWorkspaceInit((s) => s.stubs);
  const modulesDir = useWorkspaceInit((s) => s.modulesDir);
  const busy = useWorkspaceInit((s) => s.busy);
  const error = useWorkspaceInit((s) => s.error);
  if (!open) {
    return null;
  }
  const removing = installed.filter(
    (id) => !selected.includes(id) && modules.some((m) => m.id === id),
  );

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeWorkspaceInit();
        }
      }}
    >
      <div
        className="settings-dialog init-ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Initialize workspace"
      >
        <header className="settings-header">
          <h2 className="settings-title">
            {rerun ? 'Workspace directives' : 'Initialize workspace'}
          </h2>
          <button className="settings-close" aria-label="Close" onClick={closeWorkspaceInit}>
            ×
          </button>
        </header>

        <div className="init-ws-body">
          <p className="init-ws-lead">
            Sets a folder up for working with AI agents: an <code>AGENTS.md</code> built from the
            directives you tick. Agents you run in your own terminal read it on their own.
          </p>

          <div className="init-ws-folder">
            <span className="init-ws-path" title={root ?? undefined}>
              {root ?? 'No folder chosen'}
            </span>
            {!rerun && (
              <button className="settings-button" onClick={() => void pickInitFolder()}>
                {root ? 'Change…' : 'Choose or create folder…'}
              </button>
            )}
          </div>

          <h3 className="init-ws-heading">Directives</h3>
          <ul className="init-ws-list">
            {modules.map((m) => (
              <li key={m.id}>
                <label className="init-ws-item">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={() => toggleInitModule(m.id)}
                  />
                  <span className="init-ws-item-text">
                    <span className="init-ws-item-title">
                      {m.title}
                      {m.source === 'user' && <span className="init-ws-tag">yours</span>}
                      {installed.includes(m.id) && <span className="init-ws-tag">installed</span>}
                    </span>
                    <span className="init-ws-item-desc">{m.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {modulesDir && (
            <p className="init-ws-hint">
              Add your own: any <code>.md</code> file in{' '}
              <button
                className="init-ws-link"
                title={modulesDir}
                onClick={() => void openModulesFolder()}
              >
                your directives folder
              </button>{' '}
              shows up in this list.
            </p>
          )}

          <h3 className="init-ws-heading">Also point these at AGENTS.md</h3>
          <div className="init-ws-stubs">
            {HARNESS_STUBS.map((s) => (
              <label key={s.path} className="init-ws-stub">
                <input
                  type="checkbox"
                  checked={stubs.includes(s.path)}
                  onChange={() => toggleInitStub(s.path)}
                />
                {s.label} <code>{s.path}</code>
              </label>
            ))}
          </div>

          {removing.length > 0 && (
            <p className="init-ws-hint">
              Removes {removing.length} section{removing.length === 1 ? '' : 's'} from AGENTS.md.
              Files stay where they are.
            </p>
          )}
          {error && (
            <p className="init-ws-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="init-ws-footer">
          <button className="settings-button" onClick={closeWorkspaceInit}>
            Cancel
          </button>
          <button
            className="settings-button settings-button-primary"
            disabled={!root || busy}
            onClick={() => void applyWorkspaceInit()}
          >
            {busy ? 'Writing…' : installed.length > 0 ? 'Update' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}
