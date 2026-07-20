/**
 * FileExplorer — a left-side drawer listing markdown files and images grouped
 * by workspace. A workspace is just a folder: the notes dir is the built-in
 * default; extra folders are added via the native picker and persisted in
 * settings. Subfolders expand in place (listed lazily, one level per
 * `list_dir` call). Each workspace can carry an accent color (a named token
 * from WORKSPACE_COLORS, rendered as a stripe down its section; new
 * workspaces auto-pick an unused color). Right-clicking a workspace header
 * opens its context menu (new file/folder + color swatches, plus "Remove
 * workspace" for added workspaces); folder rows add "Rename" to that menu,
 * file rows get a "Rename"-only menu (inline input in the row; extension
 * preserved). Workspace roots aren't renamable — their path anchors the
 * settings entry. Removing a workspace only forgets it — files are never
 * touched.
 *
 * Getting files IN:
 * - Paste (Ctrl+V with focus in the drawer): clipboard images/files are
 *   written into the SELECTED workspace/folder (click a header or folder row
 *   to select; the default workspace is selected initially).
 * - OS drag-drop: main.tsx hit-tests Tauri's drag-drop events against the
 *   `data-drop-dir` attributes rendered here and copies the dropped md/image
 *   files into the hovered dir (`uiStore.dropTargetDir` drives the highlight).
 *   Dropping image(s) onto an md file row (`data-drop-file`) instead embeds
 *   them into that file (`appendImagesToMd`, which confirms first).
 *
 * Moving files WITHIN the workspace: drag a file/image row onto a folder row
 * or workspace header to MOVE it there via `moveExplorerEntryInto` (the
 * controller confirms first, VSCode-style, unless the user suppressed that in
 * settings). Dragging an IMAGE row onto an md file row embeds it into that file
 * instead of moving it (`appendImagesToMd`). Implemented with raw pointer
 * events, NOT HTML5 drag-and-drop:
 * Tauri's OS drag-drop interception (which the Explorer-to-app drop feature
 * needs) swallows webview-internal HTML5 drags on Windows — `dragstart` never
 * fires and the OS shows a forbidden cursor. Pointer events are untouched by
 * that interception; targets are hit-tested against the same `data-drop-dir`
 * attributes the OS-drop path in main.tsx uses. The drag machinery lives in
 * `file-explorer/useFileDrag.ts`.
 *
 * The drawer is resizable via the divider on its right edge; the width is
 * session-only (module scope), like EditorHost's split ratio.
 *
 * Data comes through `session`'s module dispatch (listNoteFiles/openNotePath/
 * addWorkspace/removeWorkspace/setWorkspaceColor/savePastedFileInto) so the
 * component never holds a controller reference.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { bytesToBase64, isImagePath } from '../../core/images';
import { isImportablePath } from '../../core/import/registry';
import { stripExtension } from '../../core/title';
import { isEditableTextPath, isMarkdownPath } from '../../core/text-files';
import { type WorkspaceColor } from '../../core/types';
import { currentProvider } from '../../ipc/provider';
import { isAndroid } from '../platform';
import {
  addCloudWorkspace,
  addWorkspace,
  createNewFileIn,
  getDefaultWorkspacePath,
  openNotePath,
  openNotePathPinned,
  refreshWorkspaces,
  renameExplorerEntry,
  savePastedFileInto,
  type ExplorerEntry,
} from '../session';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { uiStore, useUiStore } from '../stores/ui';
import { ExplorerContextMenu } from './file-explorer/ContextMenu';
import { dirIndent, fileBadge, listWithTimeout, MIME_EXT } from './file-explorer/helpers';
import { RenameInput } from './file-explorer/RenameInput';
import { useFileDrag } from './file-explorer/useFileDrag';

interface WorkspaceView {
  path: string;
  name: string;
  color: WorkspaceColor | null;
  /** The default (notes dir) workspace can't be removed. */
  removable: boolean;
  /** Read-only workspace (the docs): no create/rename/move/delete/paste/drop. */
  readOnly: boolean;
  /** Synced (SAF) workspace — gets a cloud glyph so it's distinguishable. */
  synced: boolean;
}

export function FileExplorer() {
  const open = useUiStore((s) => s.explorerOpen);
  const dropTargetDir = useUiStore((s) => s.dropTargetDir);
  const explorerRefresh = useUiStore((s) => s.explorerRefresh);
  const extraWorkspaces = useSettingsStore((s) => s.settings.workspaces);
  const defaultColor = useSettingsStore((s) => s.settings.defaultWorkspaceColor);
  // notesDir changes (M6 settings flow) must re-derive the default workspace.
  const notesDirSetting = useSettingsStore((s) => s.settings.notesDir);
  // Missing key = not yet loaded (show "Loading…"); an array = the listing.
  const [entriesByDir, setEntriesByDir] = useState<Record<string, ExplorerEntry[]>>({});
  // Dirs whose last listing failed or timed out — a never-loaded one (no entry
  // in entriesByDir) shows a Retry affordance instead of an endless "Loading…".
  const [failedDirs, setFailedDirs] = useState<ReadonlySet<string>>(new Set());
  const [collapsedWs, setCollapsedWs] = useState<ReadonlySet<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  /** Entry whose context menu is open (workspace root, subfolder, or file), or null. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Entry being renamed inline (its row shows an input instead), or null. */
  // Path of the row being inline-renamed. Matched against rows by key, never by
  // raw string: `createNewFileIn` builds its path with core's joinPath (`/`)
  // while the listing comes back from the backend with `\` on Windows, so a
  // raw compare would silently never match and the rename input would never
  // appear on a freshly created file.
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Paste destination; null = the default workspace. */
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  /** True while a manual refresh is in flight (Drive re-fetch can take seconds). */
  const [refreshing, setRefreshing] = useState(false);
  const { rootRef, dragConsumedClick, explorerWidth, startResizeDrag, startFileDrag } =
    useFileDrag();
  // Re-list whenever the drawer opens, or a tab is added/removed/saved (which
  // may have created or graduated a note file on disk).
  const tabSignature = useTabsStore((s) => s.tabs.map((t) => `${t.notePath ?? t.filePath}`).join());
  // Files open in a tab get a subtle highlight; the active tab's file a bit
  // more. JSON (not join) so a comma in a path can't corrupt the parse.
  const openFilesSignature = useTabsStore((s) =>
    JSON.stringify(s.tabs.map((t) => t.filePath ?? t.notePath).filter((p) => p !== null)),
  );
  const activeFilePath = useTabsStore((s) => {
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    return active ? (active.filePath ?? active.notePath) : null;
  });
  // Case/separator-insensitive keys, same rationale as session.ts's pathKey.
  const fileKey = (p: string) => p.replaceAll('\\', '/').toLowerCase();
  const openFileKeys = new Set((JSON.parse(openFilesSignature) as string[]).map(fileKey));
  const activeFileKey = activeFilePath === null ? null : fileKey(activeFilePath);
  const isRenaming = (p: string) => renaming !== null && fileKey(renaming) === fileKey(p);

  const defaultPath = getDefaultWorkspacePath();
  const workspaces: WorkspaceView[] = [
    ...(defaultPath
      ? [
          {
            path: defaultPath,
            name: 'Notes',
            color: defaultColor,
            removable: false,
            readOnly: false,
            synced: false,
          },
        ]
      : []),
    ...extraWorkspaces.map((w) => ({
      path: w.path,
      name: w.name,
      color: w.color,
      removable: true,
      readOnly: w.readOnly === true,
      synced: w.kind === 'synced',
    })),
  ];
  /** Is `dir` the root of (or inside) a read-only workspace? */
  const readOnlyRoots = workspaces.filter((w) => w.readOnly).map((w) => fileKey(w.path));
  const isReadOnlyDir = (dir: string): boolean => {
    const key = fileKey(dir);
    return readOnlyRoots.some((root) => key === root || key.startsWith(`${root}/`));
  };
  // JSON, not join(): a path may itself contain the separator character.
  const workspaceSignature = JSON.stringify(workspaces.map((w) => w.path));
  const expandedSignature = JSON.stringify([...expandedDirs].sort());

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const roots = JSON.parse(workspaceSignature) as string[];
    const expanded = JSON.parse(expandedSignature) as string[];
    for (const path of [...roots, ...expanded]) {
      void listWithTimeout(path)
        .then((list) => {
          if (!cancelled) {
            setEntriesByDir((prev) => ({ ...prev, [path]: list }));
            // A retry (or a slow load that eventually arrived) succeeded — clear
            // any stale failure flag so the row stops offering Retry.
            setFailedDirs((prev) => {
              if (!prev.has(path)) {
                return prev;
              }
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          }
        })
        .catch(() => {
          // Leave entriesByDir untouched: a never-loaded dir stays undefined so
          // renderDir can tell "failed load" apart from a genuinely empty folder.
          if (!cancelled) {
            setFailedDirs((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, tabSignature, workspaceSignature, expandedSignature, notesDirSetting, explorerRefresh]);

  if (!open) {
    return null;
  }

  const pasteDir = selectedDir ?? defaultPath;

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>): void {
    if (!pasteDir || isReadOnlyDir(pasteDir)) {
      return;
    }
    const files: File[] = [];
    for (const item of event.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    const usable = files.filter(
      (f) => f.type in MIME_EXT || isImagePath(f.name) || isEditableTextPath(f.name),
    );
    if (usable.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of usable) {
      const dot = file.name.lastIndexOf('.');
      const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : (MIME_EXT[file.type] ?? '.png');
      // Clipboard screenshots arrive as a generic "image.png" — those get the
      // timestamped name; genuinely named files keep theirs.
      const base = dot > 0 ? file.name.slice(0, dot) : '';
      const name = base && file.name.toLowerCase() !== 'image.png' ? base : null;
      void file
        .arrayBuffer()
        .then((buf) => savePastedFileInto(pasteDir, { base64: bytesToBase64(buf), ext, name }));
    }
  }

  /**
   * Refresh button: re-fetch every workspace root and expanded subfolder from
   * its backend, then re-list. Synced (Drive) dirs otherwise serve a stale
   * cached listing, so a note added on another device never shows up until this
   * forces the provider to re-sync. Guarded so double-taps don't stack.
   */
  async function handleRefresh(): Promise<void> {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    const dirs = [...workspaces.map((w) => w.path), ...expandedDirs];
    try {
      await refreshWorkspaces(dirs);
    } finally {
      setRefreshing(false);
    }
  }

  const toggleSet = (set: ReadonlySet<string>, path: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return next;
  };

  const rowClass = (base: string, dir: string): string => {
    let cls = base;
    if (dir === pasteDir) {
      cls += ' is-selected';
    }
    if (dir === dropTargetDir) {
      cls += ' is-drop-target';
    }
    return cls;
  };

  /** Commit an inline rename (null = cancelled). No-op when nothing changed. */
  function commitRename(entry: ExplorerEntry, value: string | null): void {
    setRenaming(null);
    const trimmed = value?.trim();
    const current = entry.isDir ? entry.name : stripExtension(entry.name);
    if (trimmed && trimmed !== current) {
      void renameExplorerEntry(entry.path, trimmed, entry.isDir);
    }
  }

  /**
   * Context-menu "New file": create the file, then jump straight into renaming
   * it on its explorer row (default name "untitled" pre-selected). The target
   * dir is revealed first — a collapsed workspace is expanded, a collapsed
   * subfolder opened — so the new row is actually on screen to rename.
   */
  async function startNewFile(dir: string): Promise<void> {
    setSelectedDir(dir);
    const isWorkspaceRoot = workspaces.some((w) => fileKey(w.path) === fileKey(dir));
    if (isWorkspaceRoot) {
      setCollapsedWs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    } else {
      setExpandedDirs((prev) => new Set(prev).add(dir));
    }
    const created = await createNewFileIn(dir);
    if (created) {
      setRenaming(created);
    }
  }

  function retryDir(dirPath: string): void {
    // Drop the failure flag (row returns to "Loading…"), then force a re-fetch
    // + re-list. For a synced dir this re-queries the backend; for a local dir
    // it's a plain re-list. The effect above resolves the row from there.
    setFailedDirs((prev) => {
      if (!prev.has(dirPath)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(dirPath);
      return next;
    });
    void refreshWorkspaces([dirPath]);
  }

  function renderDir(dirPath: string, depth: number, readOnly = false): ReactNode {
    const entries = entriesByDir[dirPath];
    const indent = { paddingLeft: `${dirIndent(depth) + 14}px` };
    if (entries === undefined) {
      // Never loaded: distinguish an in-flight listing from one that failed or
      // timed out (common on an unresponsive cloud folder) — the latter offers
      // a way to try again rather than spinning forever.
      if (failedDirs.has(dirPath)) {
        return (
          <div className="file-explorer-empty" style={indent}>
            Couldn’t load —{' '}
            <button type="button" className="file-explorer-retry" onClick={() => retryDir(dirPath)}>
              Retry
            </button>
          </div>
        );
      }
      return (
        <div className="file-explorer-empty" style={indent}>
          Loading…
        </div>
      );
    }
    if (entries.length === 0) {
      return (
        <div className="file-explorer-empty" style={indent}>
          {depth === 0 ? 'No notes yet' : 'Empty'}
        </div>
      );
    }
    return entries.map((entry) =>
      entry.isDir ? (
        <div key={entry.path}>
          <div className="file-explorer-dir-row">
            {isRenaming(entry.path) ? (
              <div className="file-explorer-dir" style={{ paddingLeft: `${dirIndent(depth)}px` }}>
                <span className="workspace-caret">{expandedDirs.has(entry.path) ? '▾' : '▸'}</span>
                <RenameInput initial={entry.name} onDone={(v) => commitRename(entry, v)} />
              </div>
            ) : (
              <button
                className={rowClass('file-explorer-dir', entry.path)}
                style={{ paddingLeft: `${dirIndent(depth)}px` }}
                title={
                  readOnly
                    ? `${entry.path}\nRead-only`
                    : `${entry.path}\nRight-click: new file, rename`
                }
                data-drop-dir={readOnly ? undefined : entry.path}
                aria-expanded={expandedDirs.has(entry.path)}
                onClick={() => {
                  setSelectedDir(entry.path);
                  setExpandedDirs((prev) => toggleSet(prev, entry.path));
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!readOnly) {
                    setMenuFor(menuFor === entry.path ? null : entry.path);
                  }
                }}
              >
                <span className="workspace-caret">{expandedDirs.has(entry.path) ? '▾' : '▸'}</span>
                <span className="file-explorer-dir-name">{entry.name}</span>
              </button>
            )}
            {menuFor === entry.path && (
              <ExplorerContextMenu
                dir={entry.path}
                renameTarget={entry}
                onClose={() => setMenuFor(null)}
                onRename={setRenaming}
                onNewFile={startNewFile}
                onSelectDir={setSelectedDir}
              />
            )}
          </div>
          {expandedDirs.has(entry.path) && renderDir(entry.path, depth + 1, readOnly)}
        </div>
      ) : (
        <div key={entry.path} className="file-explorer-dir-row">
          {isRenaming(entry.path) ? (
            <div className="file-explorer-item" style={indent}>
              <RenameInput
                initial={stripExtension(entry.name)}
                onDone={(v) => commitRename(entry, v)}
              />
            </div>
          ) : (
            <button
              className={
                'file-explorer-item' +
                (openFileKeys.has(fileKey(entry.path)) ? ' is-open' : '') +
                (fileKey(entry.path) === activeFileKey ? ' is-active' : '') +
                (isImportablePath(entry.path) ? ' is-importable' : '') +
                (entry.path === dropTargetDir ? ' is-drop-target' : '')
              }
              style={indent}
              title={
                readOnly
                  ? `${entry.path}\nRead-only`
                  : isImportablePath(entry.path)
                    ? `${entry.path}\nClick to preview and import as Markdown · Drag into a folder to move · Right-click: rename, delete`
                    : isMarkdownPath(entry.path)
                      ? `${entry.path}\nDrag into a folder to move · Drop an image to embed it · Right-click: rename, delete`
                      : `${entry.path}\nDrag into a folder to move · Right-click: rename, delete`
              }
              data-drop-dir={readOnly ? undefined : dirPath}
              // md files double as an image-drop target (embed at end of file);
              // main.tsx hit-tests this against OS drags. Images, importable
              // documents, and plain .txt hold no markdown, so they aren't
              // embed targets.
              data-drop-file={readOnly || !isMarkdownPath(entry.path) ? undefined : entry.path}
              onPointerDown={readOnly ? undefined : (e) => startFileDrag(e, entry.path)}
              onClick={() => {
                if (dragConsumedClick.current) {
                  dragConsumedClick.current = false;
                  return;
                }
                setSelectedDir(dirPath);
                // Single-click opens (as a preview tab when that setting is on);
                // a double-click below promotes it to a permanent tab.
                openNotePath(entry.path);
              }}
              onDoubleClick={() => {
                setSelectedDir(dirPath);
                openNotePathPinned(entry.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!readOnly) {
                  setMenuFor(menuFor === entry.path ? null : entry.path);
                }
              }}
            >
              {(() => {
                const badge = fileBadge(entry.name);
                return (
                  <>
                    <span className="file-explorer-item-name">
                      {badge ? stripExtension(entry.name) : entry.name}
                    </span>
                    {badge && (
                      <span className="file-badge" data-kind={badge.kind} aria-hidden="true">
                        {badge.label}
                      </span>
                    )}
                  </>
                );
              })()}
            </button>
          )}
          {menuFor === entry.path && (
            <ExplorerContextMenu
              entry={entry}
              onClose={() => setMenuFor(null)}
              onRename={setRenaming}
            />
          )}
        </div>
      ),
    );
  }

  return (
    <>
      <div
        ref={rootRef}
        className="file-explorer"
        style={{ width: `${explorerWidth}px` }}
        aria-label="File explorer"
        onPaste={handlePaste}
      >
        <div className="file-explorer-header">
          {/* Android has no persistent ribbon in reach of the thumb, so give the
              drawer its own way out — a back button that closes it (the ☰ toggle
              is easy to miss). Desktop keeps the ribbon toggle, so it's hidden
              there. */}
          {isAndroid() && (
            <button
              className="file-explorer-action file-explorer-back"
              aria-label="Close file explorer"
              title="Close"
              onClick={() => uiStore.getState().toggleExplorer()}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path
                  d="M8 2.5 4 6.5l4 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          )}
          <span className="file-explorer-title">Workspaces</span>
          <div className="file-explorer-actions">
            {/* Android: pick a synced folder (Drive/OneDrive/SD card) via SAF.
                On desktop the Drive-for-Desktop folder is added with the plain
                "+" below, so this only shows on Android. */}
            {isAndroid() && (
              <button
                className="file-explorer-action"
                aria-label="Add synced folder"
                title="Add synced folder (Google Drive, OneDrive, SD card…)"
                onClick={() => addCloudWorkspace()}
              >
                <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
                  <path
                    d="M4 10.5a2.6 2.6 0 0 1-.2-5.19A3.2 3.2 0 0 1 10 4.7a2.4 2.4 0 0 1 .3 4.79"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                  <path
                    d="M7.5 6.2v4.6M5.7 8.4l1.8-2 1.8 2"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              </button>
            )}
            {currentProvider().capabilities.canPickDir && (
              <button
                className="file-explorer-action"
                aria-label="Add workspace"
                title="Add workspace (pick a folder)"
                onClick={() => addWorkspace()}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                  <path
                    d="M6.5 2v9M2 6.5h9"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </button>
            )}
            {/* Re-fetch every workspace from its backend and re-list. The
                headline case is a synced (Drive) folder whose remote changes the
                provider was serving from cache — see refreshWorkspaces. */}
            <button
              className={
                'file-explorer-action file-explorer-refresh' + (refreshing ? ' is-spinning' : '')
              }
              aria-label="Refresh workspaces"
              aria-busy={refreshing || undefined}
              title="Refresh (re-check synced folders for changes)"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
                <path
                  d="M11 6.5a4.5 4.5 0 1 1-1.32-3.18"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  fill="none"
                />
                <path
                  d="M10.8 1.4v2.4H8.4"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>
        </div>
        {/* A refresh over a synced (Drive) folder can take several seconds; the
            header glyph spins but is easy to miss on a tablet, so surface an
            explicit, unmissable strip while one is in flight. */}
        {refreshing && (
          <div className="file-explorer-refreshing" role="status" aria-live="polite">
            <span className="file-explorer-refreshing-bar" aria-hidden="true" />
            Refreshing…
          </div>
        )}
        <div className="file-explorer-list">
          {workspaces.map((ws) => {
            const isCollapsed = collapsedWs.has(ws.path);
            return (
              <div
                className="workspace-section"
                data-color={ws.color ?? undefined}
                data-drop-dir={ws.readOnly ? undefined : ws.path}
                key={ws.path}
              >
                <div className="workspace-header">
                  <button
                    className={rowClass('workspace-toggle', ws.path)}
                    title={
                      ws.readOnly
                        ? `${ws.path}\nRead-only · Right-click: workspace color, remove`
                        : `${ws.path}\nRight-click: new file, workspace color${ws.removable ? ', remove' : ''}`
                    }
                    aria-expanded={!isCollapsed}
                    onClick={(e) => {
                      // Alt+click also opens the context menu; a plain click
                      // selects the workspace and collapses/expands it.
                      if (e.altKey) {
                        setMenuFor(menuFor === ws.path ? null : ws.path);
                      } else {
                        setSelectedDir(ws.path);
                        setCollapsedWs((prev) => toggleSet(prev, ws.path));
                      }
                    }}
                    onContextMenu={(e) => {
                      // Right-click (the native Windows gesture) opens the
                      // context menu instead of the webview's own.
                      e.preventDefault();
                      setMenuFor(menuFor === ws.path ? null : ws.path);
                    }}
                  >
                    <span className="workspace-caret">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="workspace-name">{ws.name}</span>
                    {ws.synced && (
                      <span
                        className="workspace-badge"
                        title="Synced folder"
                        aria-label="Synced folder"
                      >
                        <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
                          <path
                            d="M3.6 8.5a2.2 2.2 0 0 1-.17-4.4A2.8 2.8 0 0 1 9 3.6a2.1 2.1 0 0 1 .25 4.9z"
                            stroke="currentColor"
                            strokeWidth="1"
                            strokeLinejoin="round"
                            fill="none"
                          />
                        </svg>
                      </span>
                    )}
                  </button>
                  {menuFor === ws.path && (
                    <ExplorerContextMenu
                      dir={ws.path}
                      wsColor={ws.color}
                      removableWs={ws.removable}
                      readOnly={ws.readOnly}
                      onClose={() => setMenuFor(null)}
                      onRename={setRenaming}
                      onNewFile={startNewFile}
                      onSelectDir={setSelectedDir}
                    />
                  )}
                </div>
                {!isCollapsed && renderDir(ws.path, 0, ws.readOnly)}
              </div>
            );
          })}
        </div>
      </div>
      <div
        className="explorer-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize explorer"
        onPointerDown={startResizeDrag}
      />
    </>
  );
}
