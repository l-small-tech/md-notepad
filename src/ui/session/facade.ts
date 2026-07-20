/**
 * The session facade — everything module-scoped that components and the
 * keyboard dispatcher reach without holding a reference to the controller
 * built during boot: the per-tab caret map, path helpers, the shared exported
 * types, and the `*Dispatch` pointer indirections (with setters mirroring
 * `src/ui/stores/flush-signal.ts`'s `setFlushRequester`) that
 * `createSessionController` wires to the real implementations.
 */

import type { DocSource } from '../../core/export/doc-source';
import { dirName } from '../../core/session/plan-flush';
import type { PersistedTab } from '../../core/session/plan-flush';
import { appendMentions } from '../../core/link-mentions';
import type { CursorPos, WorkspaceColor } from '../../core/types';
import { getSourceAdapter } from '../editor-registry';
import { settingsStore } from '../stores/settings';
import { tabsStore, type RestoredTabInit } from '../stores/tabs';
import { uiStore } from '../stores/ui';

/** Native confirm dialog (plugin-dialog in the app; a stub in tests). */
export type ConfirmDialog = (message: string, title: string) => Promise<boolean>;
/** Native open-file dialog. Returns the selected path(s), or null if cancelled. */
export type OpenFilesDialog = () => Promise<string[] | null>;
/** One native-dialog file filter: a label plus bare extensions (no dots). */
export interface FileDialogFilter {
  name: string;
  extensions: string[];
}
/** Native save-file dialog. Returns the chosen path, or null if cancelled.
 *  `filters` narrows the type dropdown (default: the markdown filters). */
export type SaveFileDialog = (
  suggestedName?: string,
  filters?: FileDialogFilter[],
) => Promise<string | null>;
/** Three-way "unsaved changes" dialog for closing a dirty file tab (M3). */
export type SaveDiscardCancelDialog = (
  message: string,
  title: string,
) => Promise<'save' | 'discard' | 'cancel'>;
/** Native folder-picker for the M6 notes-dir change flow. Null if cancelled. */
export type PickDirectoryDialog = () => Promise<string | null>;
/** Native single-file picker for link insertion. `image` narrows the filter
 *  to image types, `import` to convertible document types (registry.ts). */
export type PickFileDialog = (kind: 'any' | 'image' | 'import') => Promise<string | null>;

/**
 * Per-tab caret positions, module-scoped because both the session controller
 * (reads them at flush time) and EditorHost (seeds/reports them per editor)
 * need them, and there is only ever one controller. Kept off the tabs array on
 * purpose — see the file header.
 */
export const cursorByTab = new Map<string, CursorPos>();

/**
 * Canonical key for "is this the same file?" comparisons. Paths reach us with
 * mixed separators on Windows — Tauri's `join`/dialogs/argv produce `\` while
 * core's `joinPath` produces `/` — and NTFS/APFS are case-insensitive, so a
 * raw string compare would let two tabs own one file (and the flusher and
 * Ctrl+S would then clobber each other's writes). Compare keys, never raw
 * paths; the raw path is still what gets stored and written.
 */
export function pathKey(path: string): string {
  // Synced (SAF) identifiers (`saf://<token>/<relPath>`) are opaque and
  // case-sensitive — the token encodes a case-sensitive document URI, so
  // lowercasing it would corrupt the id and could collide two distinct trees.
  // Return them verbatim; local paths keep the separator/case normalization.
  if (path.startsWith('saf://')) {
    return path;
  }
  return path.replaceAll('\\', '/').toLowerCase();
}

/**
 * Whether `path` lies inside a read-only workspace (the bundled docs). Tabs
 * opened on such files are pinned to read mode and refuse save/rename; the
 * flag is recomputed from here at every open/restore, never persisted.
 */
export function isReadOnlyPath(path: string | null): boolean {
  if (!path) {
    return false;
  }
  const key = pathKey(path);
  return settingsStore
    .getState()
    .settings.workspaces.some(
      (w) =>
        w.readOnly === true && (key === pathKey(w.path) || key.startsWith(`${pathKey(w.path)}/`)),
    );
}

/** EditorHost → here: the editor reported a new caret position for this tab. */
export function noteCursor(tabId: string, cursor: CursorPos): void {
  cursorByTab.set(tabId, cursor);
}

/** EditorHost ← here: the caret to restore when this tab's editor first attaches. */
export function getCursor(tabId: string): CursorPos | null {
  return cursorByTab.get(tabId) ?? null;
}

/**
 * Interactive close indirection, so the TabBar and keyboard dispatcher can
 * close a tab (confirming first when that discards content) without holding a
 * reference to the controller built during boot. Falls back to a plain store
 * close until {@link createSessionController} registers the confirming variant.
 */
let interactiveCloser: (id: string) => void = (id) => tabsStore.getState().closeTab(id);

export function setInteractiveCloser(fn: (id: string) => void): void {
  interactiveCloser = fn;
}

export function closeTab(id: string): void {
  interactiveCloser(id);
}

/** TabBar "Close all" → controller: close every tab (confirming per-tab). */
let closeAllTabsDispatch: () => void = () => {};
export function setCloseAllTabsDispatch(fn: () => void): void {
  closeAllTabsDispatch = fn;
}
export function closeAllTabs(): void {
  closeAllTabsDispatch();
}

/**
 * TabBar → controller: move a tab into its own window (M8 tear-off), at `pos`
 * (screen CSS px, from the drag release) or OS-placed when null (the
 * context-menu fallback). No-ops until the controller registers (and outside
 * the desktop app, where no window spawner exists).
 */
let moveTabToNewWindowDispatch: (
  id: string,
  pos: { x: number; y: number } | null,
) => void = () => {};
export function setMoveTabToNewWindowDispatch(
  fn: (id: string, pos: { x: number; y: number } | null) => void,
): void {
  moveTabToNewWindowDispatch = fn;
}
export function moveTabToNewWindow(id: string, pos: { x: number; y: number } | null): void {
  moveTabToNewWindowDispatch(id, pos);
}

/**
 * Same indirection pattern as {@link closeTab} for the M3 file actions the
 * keyboard dispatcher (mod+O/S/Shift+S) and ConflictBanner need, before any
 * controller exists. No-ops until {@link createSessionController} registers
 * the real implementations.
 */
let openFileDispatch: () => void = () => {};
let saveDispatch: () => void = () => {};
let saveAsDispatch: () => void = () => {};
let reloadDispatch: (id: string) => void = () => {};
let keepMineDispatch: (id: string) => void = () => {};
let changeNotesDirDispatch: () => void = () => {};

let openExportPreviewDispatch: () => void = () => {};
let openExportPreviewForFileDispatch: (path: string) => void = () => {};
let runExportFromPreviewDispatch: () => Promise<void> = async () => {};
let buildExportPreviewHtmlDispatch: (
  source: DocSource,
  themeId: string,
  dark: boolean,
) => Promise<string> = async () => {
  throw new Error('not booted');
};

export function setOpenFileDispatch(fn: () => void): void {
  openFileDispatch = fn;
}
export function setOpenExportPreviewDispatch(fn: () => void): void {
  openExportPreviewDispatch = fn;
}
export function setOpenExportPreviewForFileDispatch(fn: (path: string) => void): void {
  openExportPreviewForFileDispatch = fn;
}
export function setRunExportFromPreviewDispatch(fn: () => Promise<void>): void {
  runExportFromPreviewDispatch = fn;
}
export function setBuildExportPreviewHtmlDispatch(
  fn: (source: DocSource, themeId: string, dark: boolean) => Promise<string>,
): void {
  buildExportPreviewHtmlDispatch = fn;
}
export function setSaveDispatch(fn: () => void): void {
  saveDispatch = fn;
}
export function setSaveAsDispatch(fn: () => void): void {
  saveAsDispatch = fn;
}
export function setReloadDispatch(fn: (id: string) => void): void {
  reloadDispatch = fn;
}
export function setKeepMineDispatch(fn: (id: string) => void): void {
  keepMineDispatch = fn;
}
export function setChangeNotesDirDispatch(fn: () => void): void {
  changeNotesDirDispatch = fn;
}

/** One entry in the file-explorer listing: a subfolder, .md file, or image. */
export interface ExplorerEntry {
  path: string;
  name: string;
  isDir: boolean;
  mtimeMs: number;
}

let listNotesDispatch: (dir?: string) => Promise<ExplorerEntry[]> = async () => [];
let readImageDispatch: (path: string) => Promise<string> = async () => {
  throw new Error('not booted');
};
let importFilesDispatch: (dir: string, paths: string[]) => Promise<void> = async () => {};
let importDocumentDispatch: (
  dir: string,
  srcPath?: string,
  options?: { allowDuplicate?: boolean },
) => Promise<void> = async () => {};
let importStatusDispatch: (
  srcPath: string,
) => Promise<{ mdPath: string; imported: boolean }> = async (srcPath) => ({
  mdPath: srcPath,
  imported: false,
});
let appendImagesDispatch: (mdPath: string, paths: string[]) => Promise<void> = async () => {};
let savePastedImageDispatch: (
  tabId: string,
  file: { base64: string; ext: string; name: string | null },
) => Promise<ImageRef | null> = async () => null;
let savePastedFileDispatch: (dir: string, file: PastedFile) => Promise<void> = async () => {};
let createNewFileDispatch: (dir: string) => Promise<string | null> = async () => null;
let createNewFolderDispatch: (dir: string) => Promise<string | null> = async () => null;
let renameEntryDispatch: (
  path: string,
  newName: string,
  isDir: boolean,
) => Promise<void> = async () => {};
let moveEntryDispatch: (sourcePath: string, destDir: string) => Promise<void> = async () => {};
let deleteEntryDispatch: (path: string) => Promise<void> = async () => {};
let refreshWorkspacesDispatch: (dirs: string[]) => Promise<void> = async () => {};

export function setListNotesDispatch(fn: (dir?: string) => Promise<ExplorerEntry[]>): void {
  listNotesDispatch = fn;
}
export function setReadImageDispatch(fn: (path: string) => Promise<string>): void {
  readImageDispatch = fn;
}
export function setImportFilesDispatch(fn: (dir: string, paths: string[]) => Promise<void>): void {
  importFilesDispatch = fn;
}
export function setImportDocumentDispatch(
  fn: (dir: string, srcPath?: string, options?: { allowDuplicate?: boolean }) => Promise<void>,
): void {
  importDocumentDispatch = fn;
}
export function setImportStatusDispatch(
  fn: (srcPath: string) => Promise<{ mdPath: string; imported: boolean }>,
): void {
  importStatusDispatch = fn;
}
export function setAppendImagesDispatch(
  fn: (mdPath: string, paths: string[]) => Promise<void>,
): void {
  appendImagesDispatch = fn;
}
export function setSavePastedImageDispatch(
  fn: (
    tabId: string,
    file: { base64: string; ext: string; name: string | null },
  ) => Promise<ImageRef | null>,
): void {
  savePastedImageDispatch = fn;
}
export function setSavePastedFileDispatch(
  fn: (dir: string, file: PastedFile) => Promise<void>,
): void {
  savePastedFileDispatch = fn;
}
export function setCreateNewFileDispatch(fn: (dir: string) => Promise<string | null>): void {
  createNewFileDispatch = fn;
}
export function setCreateNewFolderDispatch(fn: (dir: string) => Promise<string | null>): void {
  createNewFolderDispatch = fn;
}
export function setRenameEntryDispatch(
  fn: (path: string, newName: string, isDir: boolean) => Promise<void>,
): void {
  renameEntryDispatch = fn;
}
export function setMoveEntryDispatch(
  fn: (sourcePath: string, destDir: string) => Promise<void>,
): void {
  moveEntryDispatch = fn;
}
export function setDeleteEntryDispatch(fn: (path: string) => Promise<void>): void {
  deleteEntryDispatch = fn;
}
export function setRefreshWorkspacesDispatch(fn: (dirs: string[]) => Promise<void>): void {
  refreshWorkspacesDispatch = fn;
}

/** A saved image, ready for the editor to reference: markdown alt text + a
 *  destination path relative to (or absolute from) the document. */
export interface ImageRef {
  alt: string;
  src: string;
}

/** A file lifted off the clipboard: content plus how to name it on disk. */
export interface PastedFile {
  base64: string;
  /** Extension including the dot (`.png`). */
  ext: string;
  /** Basename to use (no extension), or null for a timestamped default. */
  name: string | null;
}
let openNotePathDispatch: (path: string) => void = () => {};
let openNotePathPinnedDispatch: (path: string) => void = () => {};
// The resolved notes dir (the default workspace). Null until the controller
// registers — the explorer just shows no default section pre-boot.
let defaultWorkspaceDispatch: () => string | null = () => null;
let addWorkspaceDispatch: () => void = () => {};
let addCloudWorkspaceDispatch: () => void = () => {};
let removeSyncedWorkspaceDispatch: (path: string) => void = () => {};
let openDocsDispatch: (page?: string) => void = () => {};
let insertFileLinkDispatch: (opts: { image: boolean; absolute: boolean }) => void = () => {};
// Default (pre-boot / tests): a plain label change. The controller swaps in
// the file-aware variant that also renames a file tab's file on disk.
let renameTabDispatch: (id: string, newName: string) => void = (id, newName) =>
  tabsStore.getState().renameTab(id, newName);

export function setOpenNotePathDispatch(fn: (path: string) => void): void {
  openNotePathDispatch = fn;
}
export function setOpenNotePathPinnedDispatch(fn: (path: string) => void): void {
  openNotePathPinnedDispatch = fn;
}
export function setDefaultWorkspaceDispatch(fn: () => string | null): void {
  defaultWorkspaceDispatch = fn;
}
export function setAddWorkspaceDispatch(fn: () => void): void {
  addWorkspaceDispatch = fn;
}
export function setAddCloudWorkspaceDispatch(fn: () => void): void {
  addCloudWorkspaceDispatch = fn;
}
export function setRemoveSyncedWorkspaceDispatch(fn: (path: string) => void): void {
  removeSyncedWorkspaceDispatch = fn;
}
export function setOpenDocsDispatch(fn: (page?: string) => void): void {
  openDocsDispatch = fn;
}
export function setInsertFileLinkDispatch(
  fn: (opts: { image: boolean; absolute: boolean }) => void,
): void {
  insertFileLinkDispatch = fn;
}
export function setRenameTabDispatch(fn: (id: string, newName: string) => void): void {
  renameTabDispatch = fn;
}

export function openFile(): void {
  openFileDispatch();
}
/** Ribbon / palette → controller: open the export preview on the active tab. */
export function openExportPreview(): void {
  openExportPreviewDispatch();
}
/** FileExplorer context menu → controller: open the export preview on a .md
 *  file by path (an open tab's live text wins over the on-disk content). */
export function openExportPreviewForFile(path: string): void {
  openExportPreviewForFileDispatch(path);
}
/** ExportPreviewDialog → controller: run the dialog's current selection.
 *  Resolves when the export finished (the dialog closes itself on success). */
export function runExportFromPreview(): Promise<void> {
  return runExportFromPreviewDispatch();
}
/** ExportPreviewDialog → controller: the themed standalone HTML for the
 *  preview iframe. */
export function buildExportPreviewHtml(
  source: DocSource,
  themeId: string,
  dark: boolean,
): Promise<string> {
  return buildExportPreviewHtmlDispatch(source, themeId, dark);
}
export function saveActiveTab(): void {
  saveDispatch();
}
export function saveActiveTabAs(): void {
  saveAsDispatch();
}
export function reloadTab(id: string): void {
  reloadDispatch(id);
}
export function keepMineTab(id: string): void {
  keepMineDispatch(id);
}
/** SettingsDialog → controller: run the notes-dir change flow. */
export function requestChangeNotesDir(): void {
  changeNotesDirDispatch();
}
/** FileExplorer → controller: one level of `dir` (default: notes dir) —
 *  subfolders plus markdown/image files. */
export function listNoteFiles(dir?: string): Promise<ExplorerEntry[]> {
  return listNotesDispatch(dir);
}
/**
 * FileExplorer refresh button → controller: ask each of `dirs` (workspace roots
 * and any expanded subfolders) to re-fetch from its backend, then bump the
 * explorer so it re-lists. Synced (Drive/OneDrive) dirs serve cached listings,
 * so without the re-fetch a note added elsewhere never appears; local dirs
 * refresh as a no-op and just re-list. Best-effort — a backend that can't
 * refresh still re-lists.
 */
export async function refreshWorkspaces(dirs: string[]): Promise<void> {
  await refreshWorkspacesDispatch(dirs);
  uiStore.getState().refreshExplorer();
}
/** ImageView → controller: an image file as a ready-to-use data: URL. */
export function loadImageDataUrl(path: string): Promise<string> {
  return readImageDispatch(path);
}
/** Drag-drop (main.tsx) → controller: copy dropped files into a workspace dir
 *  (non-md/image paths are skipped). */
export function importFilesInto(dir: string, paths: string[]): Promise<void> {
  return importFilesDispatch(dir, paths);
}
/**
 * FileExplorer context menu / open flow → controller: convert a foreign
 * document (e.g. a PDF) into a new .md in `dir`. Without `srcPath` a native
 * picker filtered to importable formats asks for the source file.
 */
export function importDocumentInto(
  dir: string,
  srcPath?: string,
  options?: { allowDuplicate?: boolean },
): Promise<void> {
  return importDocumentDispatch(dir, srcPath, options);
}
/**
 * ImportView → controller: whether `srcPath` has already been imported, plus
 * the note path it maps to (so the card can link to the result rather than
 * offering the conversion again).
 */
export function checkImportStatus(srcPath: string): Promise<{ mdPath: string; imported: boolean }> {
  return importStatusDispatch(srcPath);
}
/**
 * Drag-drop (main.tsx) → controller: embed dropped image files into an existing
 * markdown file, appended to its end. Non-image paths are ignored; images not
 * already beside the note are copied in first.
 */
export function appendImagesToMd(mdPath: string, paths: string[]): Promise<void> {
  return appendImagesDispatch(mdPath, paths);
}
/**
 * Editor paste → controller: save one clipboard image into the configured
 * images location for `tabId`'s document and return how to reference it (alt +
 * absolute src), or null on failure. The editor adapter does the actual
 * caret insertion — this only touches disk.
 */
export function savePastedImageForTab(
  tabId: string,
  file: { base64: string; ext: string; name: string | null },
): Promise<ImageRef | null> {
  return savePastedImageDispatch(tabId, file);
}
/** FileExplorer paste → controller: write one clipboard file into `dir`. */
export function savePastedFileInto(dir: string, file: PastedFile): Promise<void> {
  return savePastedFileDispatch(dir, file);
}
/**
 * Editor Ctrl/Cmd+C → clipboard enrichment: append Claude-Code-CLI `@path`
 * mentions for every local file/image the copied selection links to — the
 * same treatment the ribbon's copy-raw-text button gives the whole document.
 * Relative destinations resolve against the tab's own directory. A selection
 * with no local links is returned unchanged (and the editor's native copy
 * proceeds silently).
 */
export function enrichCopiedText(tabId: string, selection: string): string {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return selection;
  }
  const baseDir = dirName(tab.filePath ?? tab.notePath ?? '');
  const { text, count } = appendMentions(selection, baseDir);
  if (count > 0) {
    uiStore
      .getState()
      .showNotice(`Copied + ${count} file ${count === 1 ? 'mention' : 'mentions'} (@paths).`);
  }
  return text;
}
/** FileExplorer context menu → controller: create a new .md file in `dir` and
 *  open it. Resolves with the created file's path (null on failure) so the
 *  caller can start the inline rename on its explorer row. */
export function createNewFileIn(dir: string): Promise<string | null> {
  return createNewFileDispatch(dir);
}
/** FileExplorer context menu → controller: create a new subfolder in `dir`. */
export function createNewFolderIn(dir: string): Promise<string | null> {
  return createNewFolderDispatch(dir);
}
/** FileExplorer context menu → controller: rename a file or folder on disk
 *  (extension preserved for files; open tabs are retargeted). */
export function renameExplorerEntry(path: string, newName: string, isDir: boolean): Promise<void> {
  return renameEntryDispatch(path, newName, isDir);
}
/**
 * FileExplorer drag-drop → controller: move a file/image into `destDir`,
 * confirming first (VSCode-style) unless the user has suppressed that prompt.
 * Open tabs owning the file are retargeted; collisions and no-ops are refused.
 */
export function moveExplorerEntryInto(sourcePath: string, destDir: string): Promise<void> {
  return moveEntryDispatch(sourcePath, destDir);
}
/**
 * FileExplorer context menu → controller: delete a file/image, confirming
 * first. Any tab that owns it is closed so it can't write the bytes back.
 */
export function deleteExplorerEntry(path: string): Promise<void> {
  return deleteEntryDispatch(path);
}
/** FileExplorer → controller: the resolved notes dir (the default workspace). */
export function getDefaultWorkspacePath(): string | null {
  return defaultWorkspaceDispatch();
}
/** FileExplorer → controller: pick a folder and add it as a workspace. */
export function addWorkspace(): void {
  addWorkspaceDispatch();
}
/**
 * FileExplorer (Android) → controller: pick a synced folder (Google Drive,
 * OneDrive, SD card, …) via the system picker and add it as a workspace whose
 * ops route through the SafProvider.
 */
export function addCloudWorkspace(): void {
  addCloudWorkspaceDispatch();
}
/**
 * Settings / Themes menu → controller: open the bundled docs as a read-only
 * workspace. `page` opens one guide directly (e.g. 'themes.md' for the Themes
 * submenu's Help); omitted, it lands on the start page.
 */
export function openDocs(page?: string): void {
  openDocsDispatch(page);
}
/**
 * FileExplorer → settings: forget a workspace. For a local workspace this is
 * pure settings surgery (the folder and its files are untouched). A synced
 * (`saf://`) workspace needs a controller round trip — open tabs under it must
 * be closed and the persisted folder permission released first — so it routes
 * to {@link removeSyncedWorkspace} via the controller dispatch.
 */
export function removeWorkspace(path: string): void {
  if (path.startsWith('saf://')) {
    removeSyncedWorkspaceDispatch(path);
    return;
  }
  const { settings, update } = settingsStore.getState();
  update({ workspaces: settings.workspaces.filter((w) => pathKey(w.path) !== pathKey(path)) });
}
/**
 * FileExplorer → settings: set a workspace's accent color. The default
 * workspace has no WorkspaceEntry, so its color lives in its own setting.
 */
export function setWorkspaceColor(path: string, color: WorkspaceColor | null): void {
  const { settings, update } = settingsStore.getState();
  const defaultPath = defaultWorkspaceDispatch();
  if (defaultPath !== null && pathKey(path) === pathKey(defaultPath)) {
    update({ defaultWorkspaceColor: color });
    return;
  }
  update({
    workspaces: settings.workspaces.map((w) =>
      pathKey(w.path) === pathKey(path) ? { ...w, color } : w,
    ),
  });
}
/**
 * FileExplorer single-click → controller: open a note file (activates it if
 * already open). Opens as a reusable preview tab when the setting is on.
 */
export function openNotePath(path: string): void {
  openNotePathDispatch(path);
}
/**
 * FileExplorer double-click → controller: open a note file as a PERMANENT tab,
 * promoting it if it is currently the preview tab.
 */
export function openNotePathPinned(path: string): void {
  openNotePathPinnedDispatch(path);
}

/**
 * Line reveals waiting for their tab's source editor to mount, keyed by
 * pathKey. Search opens a file BEFORE its CM6 adapter exists (the open is
 * async and the editor mounts later), so the target line parks here and
 * EditorHost consumes it (via {@link takePendingReveal}) once the tab mounts.
 * Entries expire after {@link PENDING_REVEAL_TTL_MS} — checked at consume time
 * — so a reveal whose open failed can't fire on an unrelated open later.
 */
const pendingReveals = new Map<string, { line: number; at: number }>();
const PENDING_REVEAL_TTL_MS = 10_000;

/**
 * SearchPanel → controller: open a note file and scroll its source editor to
 * `line` (1-based). If the file's tab is already open with a live CM6 adapter
 * (raw/split), the reveal happens immediately; otherwise the line is parked
 * for the mounting editor to pick up. A tab that opens in wysiwyg/read mode
 * has no source lines to reveal — it just opens (accepted degrade).
 */
export function openNotePathAtLine(path: string, line: number): void {
  const key = pathKey(path);
  const tab = tabsStore.getState().tabs.find((t) => {
    const p = t.filePath ?? t.notePath;
    return p !== null && pathKey(p) === key;
  });
  const adapter = tab ? getSourceAdapter(tab.id) : undefined;
  openNotePathDispatch(path);
  if (adapter) {
    adapter.revealLine(line);
    return;
  }
  pendingReveals.set(key, { line, at: Date.now() });
}

/**
 * EditorHost ← here: the parked reveal line for `path`, or null (none pending,
 * or the entry expired). Consuming removes the entry either way.
 */
export function takePendingReveal(path: string | null): number | null {
  if (path === null) {
    return null;
  }
  const key = pathKey(path);
  const entry = pendingReveals.get(key);
  if (!entry) {
    return null;
  }
  pendingReveals.delete(key);
  return Date.now() - entry.at <= PENDING_REVEAL_TTL_MS ? entry.line : null;
}
/**
 * TabBar → controller: commit a tab rename. For a file tab this renames the
 * file on disk so the tab and filename stay matched; for a note tab it sets
 * the title (the flush renames the note file to the new slug).
 */
export function renameTab(id: string, newName: string): void {
  renameTabDispatch(id, newName);
}
/**
 * Ribbon → controller: browse for a file (or image) and insert a markdown link
 * to it into the active tab's source editor. The path is absolute by default
 * (so agent CLIs and other tools can resolve it from anywhere); passing
 * `absolute: false` (the ribbon's Alt-click) asks for a path relative to the
 * current document instead, when one exists.
 */
export function insertFileLink(opts: { image: boolean; absolute: boolean }): void {
  insertFileLinkDispatch(opts);
}

export function persistedToInit(tab: PersistedTab, text: string, dirty = false): RestoredTabInit {
  return {
    id: tab.id,
    kind: tab.kind,
    notePath: tab.notePath,
    filePath: tab.filePath,
    customTitle: tab.customTitle,
    mode: tab.mode,
    savedMtimeMs: tab.savedMtimeMs,
    text,
    dirty,
    // Recomputed (not persisted): settings are loaded before restore runs.
    readOnly: isReadOnlyPath(tab.filePath),
  };
}
