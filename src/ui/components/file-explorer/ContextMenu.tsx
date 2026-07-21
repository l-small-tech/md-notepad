/**
 * The FileExplorer's right-click menus, unified into one component. Two
 * variants, selected by which props are given:
 * - `entry` — a file row's menu (Rename / Reveal in explorer / Delete);
 * - `dir` — a directory or workspace-root menu (see DirMenuProps).
 * Session-level actions (delete, import, workspace color/remove) are imported
 * directly — same module dispatch the container used; only the callbacks that
 * touch the container's state arrive as props (new file/folder among them, so
 * the created row can jump straight into an inline rename).
 */

import { type ReactNode } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { isMarkdownPath } from '../../../core/text-files';
import { WORKSPACE_COLORS, type WorkspaceColor } from '../../../core/types';
import { isAndroid } from '../../platform';
import {
  deleteExplorerEntry,
  deleteExplorerFolder,
  importDocumentInto,
  openExportPreviewForFile,
  removeWorkspace,
  setWorkspaceColor,
  type ExplorerEntry,
} from '../../session';

interface CommonProps {
  /** Close the menu (clears the container's `menuFor`). */
  onClose: () => void;
  /** Start the inline rename on the row for this path. */
  onRename: (path: string) => void;
}

/** File-row menu: rename / reveal / delete for `entry`. */
interface FileMenuProps extends CommonProps {
  entry: ExplorerEntry;
}

/**
 * The right-click menu for a directory: "New file"/"New folder" always;
 * "Rename" + "Delete folder" for subfolders (`renameTarget` given); the
 * workspace color swatches only at workspace level (`wsColor` given = a
 * workspace); a "Remove workspace" item for removable workspaces
 * (`removableWs`). Workspace roots are neither renamable nor deletable here —
 * their path anchors settings, so removal goes through "Remove workspace".
 */
interface DirMenuProps extends CommonProps {
  dir: string;
  wsColor?: WorkspaceColor | null;
  renameTarget?: ExplorerEntry;
  removableWs?: boolean;
  readOnly?: boolean;
  /** Create a file in `dir` and jump into renaming it (container's startNewFile). */
  onNewFile: (dir: string) => Promise<void>;
  /** Create a subfolder in `dir` and jump into renaming it (container's startNewFolder). */
  onNewFolder: (dir: string) => Promise<void>;
  /** Select `dir` as the paste destination (container's setSelectedDir). */
  onSelectDir: (dir: string) => void;
}

export type ExplorerContextMenuProps = FileMenuProps | DirMenuProps;

export function ExplorerContextMenu(props: ExplorerContextMenuProps) {
  const { onClose, onRename } = props;

  /** Overlay + popover shared by every context menu in the drawer. */
  function menuShell(children: ReactNode): ReactNode {
    return (
      <>
        {/* Click-away layer under the menu. */}
        <div className="context-menu-overlay" onClick={onClose} />
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
          onClose();
          onRename(entry.path);
        }}
      >
        Rename
      </button>
    );
  }

  /**
   * "Reveal in explorer" menu item — shows the file in the OS file manager.
   * Desktop, real-filesystem paths only: Android has no file manager to target
   * and `saf://` ids aren't OS paths, so those rows just omit the item.
   */
  function renderRevealItem(entry: ExplorerEntry): ReactNode {
    if (isAndroid() || entry.path.startsWith('saf://')) {
      return null;
    }
    return (
      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          void revealItemInDir(entry.path).catch(() => {});
        }}
      >
        Reveal in explorer
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
          onClose();
          void deleteExplorerEntry(entry.path);
        }}
      >
        Delete
      </button>
    );
  }

  if ('entry' in props) {
    return menuShell(
      <>
        {renderRenameItem(props.entry)}
        {renderRevealItem(props.entry)}
        {/* Export works on markdown only — other rows (.txt, images) omit it.
            Opens the preview dialog (format + theme picked there); the file
            need not be open — an open tab's live text wins over disk. */}
        {isMarkdownPath(props.entry.name) && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => {
              onClose();
              openExportPreviewForFile(props.entry.path);
            }}
          >
            Export…
          </button>
        )}
        {renderDeleteItem(props.entry)}
      </>,
    );
  }

  const { dir, wsColor, renameTarget, removableWs, readOnly, onNewFile, onNewFolder, onSelectDir } =
    props;
  return menuShell(
    <>
      {!readOnly && (
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            void onNewFile(dir);
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
            onClose();
            void onNewFolder(dir);
          }}
        >
          New folder
        </button>
      )}
      {!readOnly && (
        <button
          className="context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onSelectDir(dir);
            void importDocumentInto(dir);
          }}
        >
          Import document…
        </button>
      )}
      {!readOnly && renameTarget !== undefined && renderRenameItem(renameTarget)}
      {/* Delete a subfolder (recursive). Workspace roots omit this — they carry
          "Remove workspace" instead — so it's gated on a rename target. */}
      {!readOnly && renameTarget !== undefined && (
        <button
          className="context-menu-item is-danger"
          role="menuitem"
          onClick={() => {
            onClose();
            void deleteExplorerFolder(dir);
          }}
        >
          Delete folder
        </button>
      )}
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
              onClose();
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
                onClose();
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
            onClose();
            removeWorkspace(dir);
          }}
        >
          Remove workspace
        </button>
      )}
    </>,
  );
}
