/**
 * StatusBar — mode segment control, caret position, word count, and the
 * transient notice area (editor errors now; flush errors / hints later).
 *
 * Reads the active tab's mode + word count from the tabs store and the caret
 * readout from the ui store (kept separate so caret moves don't re-render the
 * TabBar). The three-segment control switches raw ⇄ split ⇄ wysiwyg via the
 * store's `setMode`, which drives the tab's ModeSync.
 */

import type { EditorMode } from '../../core/types';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { useUiStore } from '../stores/ui';
import { downloadAndInstall, useUpdateStore } from '../update';

const MODES: { mode: EditorMode; label: string; hint: string }[] = [
  { mode: 'raw', label: 'Raw', hint: 'Source (Ctrl/Cmd+1)' },
  { mode: 'split', label: 'Split', hint: 'Source + preview (Ctrl/Cmd+2)' },
  { mode: 'wysiwyg', label: 'Rich', hint: 'WYSIWYG (Ctrl/Cmd+3)' },
  { mode: 'read', label: 'Read', hint: 'Reader — read-only (Ctrl/Cmd+4)' },
];

function ModeSegments({ activeMode, tabId }: { activeMode: EditorMode; tabId: string }) {
  return (
    <div className="mode-segments" role="group" aria-label="Edit mode">
      {MODES.map(({ mode, label, hint }) => (
        <button
          key={mode}
          className={`mode-segment${mode === activeMode ? ' mode-segment-active' : ''}`}
          aria-pressed={mode === activeMode}
          title={hint}
          onClick={() => tabsStore.getState().setMode(tabId, mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Unobtrusive update chip: appears only when a newer release is
 * known; one click downloads, installs, and relaunches. Never a dialog.
 */
function UpdateChip() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  if (phase !== 'available' && phase !== 'downloading') {
    return null;
  }
  const busy = phase === 'downloading';
  return (
    <button
      className="statusbar-update-chip"
      disabled={busy}
      title={busy ? 'Downloading update…' : `Update to v${version} and restart`}
      onClick={() => void downloadAndInstall()}
    >
      {busy ? 'Updating…' : `Update available: v${version}`}
    </button>
  );
}

export function StatusBar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const cursor = useUiStore((s) => s.cursor);
  const notice = useUiStore((s) => s.notice);

  if (!active) {
    return <div className="statusbar" />;
  }

  const words = active.wordCount;
  const chars = active.charCount;
  const caret = cursor ? `Ln ${cursor.line}, Col ${cursor.col}` : 'Ln 1, Col 1';

  return (
    <div className="statusbar">
      {active.readOnly ? (
        <span className="statusbar-readonly" title="This document can be read but not edited">
          Read-only
        </span>
      ) : (
        <ModeSegments activeMode={active.mode} tabId={active.id} />
      )}
      {import.meta.env.DEV && (
        <span className="statusbar-dev" title="Running from a development build (tauri dev)">
          dev
        </span>
      )}
      <div className="statusbar-notice" role="status">
        {notice}
      </div>
      <UpdateChip />
      <div className="statusbar-meta">
        <span className="statusbar-caret">{caret}</span>
        <span className="statusbar-words">
          {words} {words === 1 ? 'word' : 'words'}
        </span>
        <span className="statusbar-chars">
          {chars} {chars === 1 ? 'char' : 'chars'}
        </span>
      </div>
    </div>
  );
}
