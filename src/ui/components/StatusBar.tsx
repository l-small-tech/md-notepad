/**
 * StatusBar — mode segment control, caret position, word count, and the
 * transient notice area (editor errors now; flush errors / hints later).
 *
 * Reads the active tab's mode + word count from the tabs store and the caret
 * readout from the ui store (kept separate so caret moves don't re-render the
 * TabBar). The three-segment control switches raw ⇄ split ⇄ wysiwyg via the
 * store's `setMode`, which drives the tab's ModeSync.
 */

import type { MouseEvent as ReactMouseEvent } from 'react';

import { allowedModesFor, docFamilyFor } from '../../core/doc-family';
import type { EditorMode } from '../../core/types';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { useUiStore } from '../stores/ui';
import { downloadAndInstall, useUpdateStore } from '../update';

/** Label + tooltip per mode; WHICH ones a tab offers comes from its doc family. */
const MODE_META: Record<EditorMode, { label: string; hint: string }> = {
  raw: { label: 'Raw', hint: 'Source (Ctrl/Cmd+1)' },
  split: { label: 'Split', hint: 'Source + preview (Ctrl/Cmd+2)' },
  wysiwyg: { label: 'Rich', hint: 'WYSIWYG (Ctrl/Cmd+3)' },
  read: { label: 'Read', hint: 'Reader — read-only (Ctrl/Cmd+4)' },
  draw: { label: 'Draw', hint: 'Vector graphics (Ctrl/Cmd+1)' },
  // Never rendered: the status bar is hidden entirely on a terminal tab, and
  // 'term' is the only mode its family allows so there is nothing to pick.
  term: { label: 'Terminal', hint: 'Shell' },
};

function ModeSegments({
  activeMode,
  tabId,
  modes,
}: {
  activeMode: EditorMode;
  tabId: string;
  modes: readonly EditorMode[];
}) {
  return (
    <div className="mode-segments" role="group" aria-label="Edit mode">
      {modes.map((mode) => (
        <button
          key={mode}
          className={`mode-segment${mode === activeMode ? ' mode-segment-active' : ''}`}
          aria-pressed={mode === activeMode}
          title={MODE_META[mode].hint}
          onClick={() => tabsStore.getState().setMode(tabId, mode)}
        >
          {MODE_META[mode].label}
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

  // Right-click anywhere on the bar: nothing here has a menu of its own, so
  // swallow the event rather than let the webview default (Back / Reload /
  // Inspect) through. Mirrors the same guard in Ribbon.
  const swallowContextMenu = (e: ReactMouseEvent) => e.preventDefault();

  if (!active) {
    return <div className="statusbar" onContextMenu={swallowContextMenu} />;
  }

  const words = active.wordCount;
  const chars = active.charCount;
  const caret = cursor ? `Ln ${cursor.line}, Col ${cursor.col}` : 'Ln 1, Col 1';

  return (
    <div className="statusbar" onContextMenu={swallowContextMenu}>
      {active.readOnly ? (
        <span className="statusbar-readonly" title="This document can be read but not edited">
          Read-only
        </span>
      ) : (
        <ModeSegments
          activeMode={active.mode}
          tabId={active.id}
          modes={allowedModesFor(docFamilyFor(active.filePath ?? active.notePath))}
        />
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
