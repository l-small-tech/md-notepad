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
 * attributes the OS-drop path in main.tsx uses.
 *
 * The drawer is resizable via the divider on its right edge; the width is
 * session-only (module scope), like EditorHost's split ratio.
 *
 * Data comes through `session`'s module dispatch (listNoteFiles/openNotePath/
 * addWorkspace/removeWorkspace/setWorkspaceColor/savePastedFileInto) so the
 * component never holds a controller reference.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bytesToBase64, isImagePath } from '../../core/images';
import { stripExtension } from '../../core/title';
import { WORKSPACE_COLORS, type WorkspaceColor } from '../../core/types';
import { currentProvider } from '../../ipc/provider';
import {
  addWorkspace,
  appendImagesToMd,
  createNewFileIn,
  createNewFolderIn,
  deleteExplorerEntry,
  getDefaultWorkspacePath,
  listNoteFiles,
  moveExplorerEntryInto,
  openNotePath,
  openNotePathPinned,
  removeWorkspace,
  renameExplorerEntry,
  savePastedFileInto,
  setWorkspaceColor,
  type ExplorerEntry,
} from '../session';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { uiStore, useUiStore } from '../stores/ui';

interface WorkspaceView {
  path: string;
  name: string;
  color: WorkspaceColor | null;
  /** The default (notes dir) workspace can't be removed. */
  removable: boolean;
  /** Read-only workspace (the docs): no create/rename/move/delete/paste/drop. */
  readOnly: boolean;
}

/** Indentation per tree depth; file rows add the caret column's width. */
function dirIndent(depth: number): number {
  return 8 + depth * 12;
}

/** Pointer travel (px, Manhattan) before a press on a file row becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/**
 * Drawer width in px — module scope, not React state: dragging fires on every
 * pointermove and must not re-render; session-only, like the split ratio.
 */
let explorerWidth = 220;
const MIN_EXPLORER_WIDTH = 160;
const MAX_EXPLORER_WIDTH = 480;

function clampExplorerWidth(px: number): number {
  return Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, px));
}

/**
 * Inline rename field for an explorer row — same interaction contract as the
 * TabBar's rename input: Enter/blur commit, Escape cancels (onDone(null)).
 * Rendered in place of the row's button so row clicks can't fire mid-edit.
 */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => onDone(ref.current?.value ?? null);
  return (
    <input
      ref={ref}
      className="explorer-rename-input"
      defaultValue={initial}
      aria-label="Rename"
      onBlur={commit}
      onKeyDown={(e) => {
        // Keep these off the global shortcut listener.
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          onDone(null);
        }
      }}
    />
  );
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

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
  const [collapsedWs, setCollapsedWs] = useState<ReadonlySet<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  /** Entry whose context menu is open (workspace root, subfolder, or file), or null. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Entry being renamed inline (its row shows an input instead), or null. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Paste destination; null = the default workspace. */
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** True for the single click event that trails a completed row drag. */
  const dragConsumedClick = useRef(false);
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
          },
        ]
      : []),
    ...extraWorkspaces.map((w) => ({
      path: w.path,
      name: w.name,
      color: w.color,
      removable: true,
      readOnly: w.readOnly === true,
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
      void listNoteFiles(path)
        .then((list) => {
          if (!cancelled) {
            setEntriesByDir((prev) => ({ ...prev, [path]: list }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setEntriesByDir((prev) => ({ ...prev, [path]: [] }));
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

  function startResizeDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const drawer = rootRef.current;
    if (!drawer) {
      return;
    }
    const left = drawer.getBoundingClientRect().left;
    function onMove(moveEvent: PointerEvent): void {
      explorerWidth = clampExplorerWidth(moveEvent.clientX - left);
      drawer!.style.width = `${explorerWidth}px`;
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

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
      (f) => f.type in MIME_EXT || isImagePath(f.name) || f.name.toLowerCase().endsWith('.md'),
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

  const toggleSet = (set: ReadonlySet<string>, path: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return next;
  };

  /**
   * Pointer-based file move (see the file header for why not HTML5 DnD).
   * A press on a file row becomes a drag once the pointer travels past the
   * threshold; while dragging, the hovered `data-drop-dir` gets the same
   * highlight OS drops use, and releasing over one hands the move to the
   * controller (which confirms, guards collisions, and retargets tabs).
   */
  function startFileDrag(event: React.PointerEvent, sourcePath: string): void {
    if (event.button !== 0) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    function targetDirAt(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y)?.closest('[data-drop-dir]');
      return el?.getAttribute('data-drop-dir') ?? null;
    }
    // An md file row under the pointer, but only relevant when dragging an
    // image — that combination embeds the image instead of moving the file.
    function targetMdFileAt(x: number, y: number): string | null {
      if (!isImagePath(sourcePath)) {
        return null;
      }
      const el = document.elementFromPoint(x, y)?.closest('[data-drop-file]');
      return el?.getAttribute('data-drop-file') ?? null;
    }
    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.body.classList.remove('explorer-dragging');
      uiStore.getState().setDropTarget(null);
    }
    function onMove(e: PointerEvent): void {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        dragging = true;
        document.body.classList.add('explorer-dragging');
      }
      // Prefer the md-file target (image embed) over its containing folder.
      uiStore
        .getState()
        .setDropTarget(targetMdFileAt(e.clientX, e.clientY) ?? targetDirAt(e.clientX, e.clientY));
    }
    function onUp(e: PointerEvent): void {
      const wasDrag = dragging;
      cleanup();
      if (!wasDrag) {
        return; // a plain click — the row's onClick opens the file
      }
      // Swallow the click that fires right after this pointerup when the
      // pointer is released back over the source row; self-reset in case the
      // release happened elsewhere and no click follows.
      dragConsumedClick.current = true;
      setTimeout(() => {
        dragConsumedClick.current = false;
      }, 0);
      // Dropping an image onto an md file embeds it (with confirmation);
      // anything else is an in-workspace move into the hovered folder.
      const mdFile = targetMdFileAt(e.clientX, e.clientY);
      if (mdFile) {
        void appendImagesToMd(mdFile, [sourcePath]);
        return;
      }
      const dir = targetDirAt(e.clientX, e.clientY);
      if (dir) {
        void moveExplorerEntryInto(sourcePath, dir);
      }
    }
    function onCancel(): void {
      cleanup();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

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

  /** Overlay + popover shared by every context menu in the drawer. */
  function menuShell(children: ReactNode): ReactNode {
    return (
      <>
        {/* Click-away layer under the menu. */}
        <div className="context-menu-overlay" onClick={() => setMenuFor(null)} />
        <div className="context-menu" role="menu">
          {children}
        </div>
      </>
    );
  }

  /** "Rename" menu item — starts the inline rename on `entry`'s row. */
  function renderRenameItem(entry: ExplorerEntry): ReactNode {
    return (
      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          setMenuFor(null);
          setRenaming(entry.path);
        }}
      >
        Rename
      </button>
    );
  }

  /** "Delete" menu item — removes a file (the controller confirms first). */
  function renderDeleteItem(entry: ExplorerEntry): ReactNode {
    return (
      <button
        className="context-menu-item is-danger"
        role="menuitem"
        onClick={() => {
          setMenuFor(null);
          void deleteExplorerEntry(entry.path);
        }}
      >
        Delete
      </button>
    );
  }

  /**
   * The right-click menu for a directory: "New file"/"New folder" always;
   * "Rename" for subfolders (`renameTarget` given); the workspace color
   * swatches only at workspace level (`wsColor` given = a workspace); a
   * "Remove workspace" item for removable workspaces (`removableWs`).
   * Workspace roots aren't renamable here — their path anchors settings.
   */
  function renderContextMenu(
    dir: string,
    wsColor?: WorkspaceColor | null,
    renameTarget?: ExplorerEntry,
    removableWs?: boolean,
    readOnly?: boolean,
  ): ReactNode {
    return menuShell(
      <>
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              setMenuFor(null);
              setSelectedDir(dir);
              void createNewFileIn(dir);
            }}
          >
            New file
          </button>
        )}
        {!readOnly && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              setMenuFor(null);
              setSelectedDir(dir);
              void createNewFolderIn(dir);
            }}
          >
            New folder
          </button>
        )}
        {!readOnly && renameTarget !== undefined && renderRenameItem(renameTarget)}
        {wsColor !== undefined && (
          <div className="context-menu-swatches" aria-label="Workspace color">
            <button
              className="color-swatch"
              data-color="none"
              data-active={wsColor === null || undefined}
              aria-label="No color"
              title="None"
              onClick={() => {
                setWorkspaceColor(dir, null);
                setMenuFor(null);
              }}
            />
            {WORKSPACE_COLORS.map((color) => (
              <button
                key={color}
                className="color-swatch"
                data-color={color}
                data-active={wsColor === color || undefined}
                aria-label={color}
                title={color}
                onClick={() => {
                  setWorkspaceColor(dir, color);
                  setMenuFor(null);
                }}
              />
            ))}
          </div>
        )}
        {removableWs && (
          <button
            className="context-menu-item is-danger"
            role="menuitem"
            onClick={() => {
              setMenuFor(null);
              removeWorkspace(dir);
            }}
          >
            Remove workspace
          </button>
        )}
      </>,
    );
  }

  function renderDir(dirPath: string, depth: number, readOnly = false): ReactNode {
    const entries = entriesByDir[dirPath];
    const indent = { paddingLeft: `${dirIndent(depth) + 14}px` };
    if (entries === undefined) {
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
            {renaming === entry.path ? (
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
            {menuFor === entry.path && renderContextMenu(entry.path, undefined, entry)}
          </div>
          {expandedDirs.has(entry.path) && renderDir(entry.path, depth + 1, readOnly)}
        </div>
      ) : (
        <div key={entry.path} className="file-explorer-dir-row">
          {renaming === entry.path ? (
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
                (entry.path === dropTargetDir ? ' is-drop-target' : '')
              }
              style={indent}
              title={
                readOnly
                  ? `${entry.path}\nRead-only`
                  : isImagePath(entry.path)
                    ? `${entry.path}\nDrag into a folder to move · Right-click: rename, delete`
                    : `${entry.path}\nDrag into a folder to move · Drop an image to embed it · Right-click: rename, delete`
              }
              data-drop-dir={readOnly ? undefined : dirPath}
              // md files double as an image-drop target (embed at end of file);
              // main.tsx hit-tests this against OS drags. Images aren't targets.
              data-drop-file={readOnly || isImagePath(entry.path) ? undefined : entry.path}
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
              {entry.name}
            </button>
          )}
          {menuFor === entry.path &&
            menuShell(
              <>
                {renderRenameItem(entry)}
                {renderDeleteItem(entry)}
              </>,
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
          <span className="file-explorer-title">Workspaces</span>
          <div className="file-explorer-actions">
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
          </div>
        </div>
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
                  </button>
                  {menuFor === ws.path &&
                    renderContextMenu(ws.path, ws.color, undefined, ws.removable, ws.readOnly)}
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
