/**
 * FileExplorer — a left-side drawer listing the markdown files in the notes
 * directory. Toggled from the ribbon; clicking an entry opens it (or focuses
 * the tab already editing it). Deliberately basic: it lists, it opens, it
 * refreshes when reopened — no rename/delete/move (those live elsewhere).
 *
 * Data comes through `session`'s module dispatch (listNoteFiles/openNotePath)
 * so the component never holds a controller reference.
 */

import { useEffect, useState } from 'react';
import { listNoteFiles, openNotePath, type ExplorerEntry } from '../session';
import { useTabsStore } from '../stores/tabs';
import { uiStore, useUiStore } from '../stores/ui';

export function FileExplorer() {
  const open = useUiStore((s) => s.explorerOpen);
  // null = not yet loaded (show "Loading…"); an array = the current listing.
  const [entries, setEntries] = useState<ExplorerEntry[] | null>(null);
  // Re-list whenever the drawer opens, or a tab is added/removed/saved (which
  // may have created or graduated a note file on disk).
  const tabSignature = useTabsStore((s) => s.tabs.map((t) => `${t.notePath ?? t.filePath}`).join());

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void listNoteFiles()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tabSignature]);

  if (!open) {
    return null;
  }

  return (
    <div className="file-explorer" aria-label="File explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-title">Notes</span>
        <button
          className="file-explorer-close"
          aria-label="Close explorer"
          title="Close"
          onClick={() => uiStore.getState().toggleExplorer()}
        >
          ×
        </button>
      </div>
      <div className="file-explorer-list">
        {entries === null ? (
          <div className="file-explorer-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="file-explorer-empty">No notes yet</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              className="file-explorer-item"
              title={entry.path}
              onClick={() => openNotePath(entry.path)}
            >
              {entry.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
