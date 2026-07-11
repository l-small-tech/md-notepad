/**
 * The session controller — the app-wide glue that keeps every tab crash-safe.
 *
 * It owns the debounced flusher and the two pieces of state planFlush needs
 * that don't live in the tabs store: the cached `existingNoteFiles` listing
 * (so a new note never clobbers a file no tab owns) and the per-tab caret
 * positions (kept OUT of the tabs array so caret moves don't re-render the
 * TabBar — same rationale as uiStore's cursor readout).
 *
 * Everything is assembled behind a factory so tests can inject a fake ipc and
 * confirm dialog; `main.tsx` builds the one real instance at boot. The factory
 * is intentionally Tauri-import-free: window/close wiring stays in main.tsx,
 * the confirm dialog arrives as a dependency.
 *
 * Flush lifecycle (see src/core/README.md "how the pieces compose"):
 *   change → requestFlush() → (idle 1s / maxWait 5s) → flushSession()
 *     assemble AppSessionView → planFlush → executeFlushPlan (manifest last)
 *     → apply assigned paths + successful renames → markPersisted('session')
 *     → refresh existingNoteFiles from disk.
 */

import { createDebouncedFlusher, type DebouncedFlusher } from '../core/session/debounce';
import {
  baseName,
  bufferPathFor,
  dirName,
  executeFlushPlan,
  extName,
  joinPath,
  parseManifest,
  planFlush,
  relativePath,
  type AppSessionView,
  type FlushIo,
  type PersistedTab,
  type SessionManifest,
} from '../core/session/plan-flush';
import { nanoid } from 'nanoid';
import { imageMimeType, isImagePath } from '../core/images';
import { appendMentions } from '../core/link-mentions';
import { imageTargetDir } from '../core/image-insert';
import { pickUnusedColor } from '../core/settings';
import {
  dropTrailingExtension,
  sanitizeFileBaseName,
  slugifyTitle,
  stripExtension,
} from '../core/title';
import { planNoteMoves } from '../core/notes-move';
import { getSourceAdapter } from './editor-registry';
import type { CursorPos, WorkspaceColor } from '../core/types';
import { ipc as realIpc, type Ipc } from '../ipc/commands';
import type { SessionPaths } from '../ipc/paths';
import { setFlushRequester } from './stores/flush-signal';
import { settingsStore } from './stores/settings';
import { tabsStore, type RestoredTabInit } from './stores/tabs';
import { uiStore } from './stores/ui';

/** The slice of `ipc` the controller uses — narrowed so tests fake less. */
type SessionIpc = Pick<
  Ipc,
  | 'atomicWriteText'
  | 'renamePath'
  | 'deletePath'
  | 'listNotes'
  | 'readTextFile'
  | 'statPath'
  | 'listDir'
  | 'readFileBase64'
  | 'writeFileBase64'
  | 'copyPath'
  | 'createDir'
>;

/** Native confirm dialog (plugin-dialog in the app; a stub in tests). */
export type ConfirmDialog = (message: string, title: string) => Promise<boolean>;
/** Native open-file dialog. Returns the selected path(s), or null if cancelled. */
export type OpenFilesDialog = () => Promise<string[] | null>;
/** Native save-file dialog. Returns the chosen path, or null if cancelled. */
export type SaveFileDialog = (suggestedName?: string) => Promise<string | null>;
/** Three-way "unsaved changes" dialog for closing a dirty file tab (M3). */
export type SaveDiscardCancelDialog = (
  message: string,
  title: string,
) => Promise<'save' | 'discard' | 'cancel'>;
/** Native folder-picker for the M6 notes-dir change flow. Null if cancelled. */
export type PickDirectoryDialog = () => Promise<string | null>;
/** Native single-file picker for link insertion. `image` narrows the filter. */
export type PickFileDialog = (kind: 'any' | 'image') => Promise<string | null>;

export interface SessionControllerDeps {
  paths: SessionPaths;
  /** The bundled documentation folder (a Tauri resource), or null if unresolvable. */
  docsDir?: string | null;
  ipc?: SessionIpc;
  confirm?: ConfirmDialog;
  openDialog?: OpenFilesDialog;
  saveDialog?: SaveFileDialog;
  saveDiscardCancel?: SaveDiscardCancelDialog;
  pickDirectory?: PickDirectoryDialog;
  pickFile?: PickFileDialog;
  /** Injectable clock so `.bad-<timestamp>` naming is deterministic in tests. */
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface SessionController {
  /** Read the manifest and rebuild the tab set (or self-heal). Boot only. */
  restore(): Promise<void>;
  /** Debounced flush request; cheap, call on every change. */
  request(): void;
  /** Drain: resolves once everything requested so far has been flushed. */
  flushNow(): Promise<void>;
  /** Cancel timers and wait out any in-flight flush (does not flush pending). */
  dispose(): Promise<void>;
  /** Close a tab, confirming first when that would discard user content. */
  closeTabInteractive(id: string): Promise<void>;
  /** Close every tab, confirming per-tab where that discards content. */
  closeAllTabsInteractive(): Promise<void>;
  /** Ctrl+O: native open dialog, then {@link openPaths}. */
  openFileDialog(): Promise<void>;
  /**
   * Open each path as a file tab; focuses the existing tab if already open.
   * `preview` opens a reusable italic preview tab (explorer single-click).
   */
  openPaths(paths: string[], opts?: { preview?: boolean }): Promise<void>;
  /** Ctrl+S: save the active tab (Save As if it's a note tab). */
  saveActive(): Promise<void>;
  /** Ctrl+Shift+S: native save dialog, then write + retarget the active tab. */
  saveAsActive(): Promise<void>;
  /** Stat one file tab against its baseline mtime; sets/clears its ConflictBanner. */
  checkConflict(tabId: string): Promise<void>;
  /** {@link checkConflict} for every open file tab (window focus, restore). */
  checkAllFileConflicts(): Promise<void>;
  /** ConflictBanner "Reload": replace the model with the on-disk content. */
  reloadFromDisk(tabId: string): Promise<void>;
  /** ConflictBanner "Keep mine": dismiss the banner, next save overwrites. */
  keepMine(tabId: string): Promise<void>;
  /** M6 settings: pick a new notes folder, optionally moving existing notes. */
  changeNotesDir(): Promise<void>;
}

/**
 * Per-tab caret positions, module-scoped because both the session controller
 * (reads them at flush time) and EditorHost (seeds/reports them per editor)
 * need them, and there is only ever one controller. Kept off the tabs array on
 * purpose — see the file header.
 */
const cursorByTab = new Map<string, CursorPos>();

/**
 * Canonical key for "is this the same file?" comparisons. Paths reach us with
 * mixed separators on Windows — Tauri's `join`/dialogs/argv produce `\` while
 * core's `joinPath` produces `/` — and NTFS/APFS are case-insensitive, so a
 * raw string compare would let two tabs own one file (and the flusher and
 * Ctrl+S would then clobber each other's writes). Compare keys, never raw
 * paths; the raw path is still what gets stored and written.
 */
function pathKey(path: string): string {
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

export function closeTab(id: string): void {
  interactiveCloser(id);
}

/** TabBar "Close all" → controller: close every tab (confirming per-tab). */
let closeAllTabsDispatch: () => void = () => {};
export function closeAllTabs(): void {
  closeAllTabsDispatch();
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
let appendImagesDispatch: (mdPath: string, paths: string[]) => Promise<void> = async () => {};
let savePastedImageDispatch: (
  tabId: string,
  file: { base64: string; ext: string; name: string | null },
) => Promise<ImageRef | null> = async () => null;
let savePastedFileDispatch: (dir: string, file: PastedFile) => Promise<void> = async () => {};
let createNewFileDispatch: (dir: string) => Promise<void> = async () => {};
let createNewFolderDispatch: (dir: string) => Promise<void> = async () => {};
let renameEntryDispatch: (
  path: string,
  newName: string,
  isDir: boolean,
) => Promise<void> = async () => {};
let moveEntryDispatch: (sourcePath: string, destDir: string) => Promise<void> = async () => {};
let deleteEntryDispatch: (path: string) => Promise<void> = async () => {};

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
let openDocsDispatch: () => void = () => {};
let insertFileLinkDispatch: (opts: { image: boolean; absolute: boolean }) => void = () => {};
// Default (pre-boot / tests): a plain label change. The controller swaps in
// the file-aware variant that also renames a file tab's file on disk.
let renameTabDispatch: (id: string, newName: string) => void = (id, newName) =>
  tabsStore.getState().renameTab(id, newName);

export function openFile(): void {
  openFileDispatch();
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
/** FileExplorer context menu → controller: create a new .md file in `dir`,
 *  open it, and start the tab rename so it can be named immediately. */
export function createNewFileIn(dir: string): Promise<void> {
  return createNewFileDispatch(dir);
}
/** FileExplorer context menu → controller: create a new subfolder in `dir`. */
export function createNewFolderIn(dir: string): Promise<void> {
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
/** SettingsDialog → controller: open the bundled docs as a read-only workspace. */
export function openDocs(): void {
  openDocsDispatch();
}
/**
 * FileExplorer → settings: forget a workspace. Pure settings surgery (the
 * folder and its files are untouched), so no controller round trip is needed.
 */
export function removeWorkspace(path: string): void {
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

function persistedToInit(tab: PersistedTab, text: string, dirty = false): RestoredTabInit {
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

export function createSessionController(deps: SessionControllerDeps): SessionController {
  const ipc = deps.ipc ?? realIpc;
  const confirm = deps.confirm ?? (async () => true);
  // Safe defaults for when a dependency is never injected (e.g. a test that
  // doesn't exercise file dialogs): open/save do nothing rather than guess a
  // destination; the close prompt refuses rather than risk silent data loss.
  const openDialog = deps.openDialog ?? (async () => null);
  const saveDialog = deps.saveDialog ?? (async () => null);
  const saveDiscardCancel = deps.saveDiscardCancel ?? (async () => 'cancel' as const);
  const pickDirectory = deps.pickDirectory ?? (async () => null);
  const pickFile = deps.pickFile ?? (async () => null);
  const now = deps.now ?? (() => Date.now());
  // Mutable: the M6 notes-dir change flow repoints it live; every flush reads
  // the current value through this closure ("next flush writes
  // there"). sessionDir is fixed (never user-configurable).
  let notesDir = deps.paths.notesDir;
  const { sessionDir } = deps.paths;
  const manifestPath = joinPath(sessionDir, 'session.json');

  const io: FlushIo = {
    atomicWriteText: (path, text) => ipc.atomicWriteText(path, text),
    renamePath: (from, to) => ipc.renamePath(from, to),
    deletePath: (path) => ipc.deletePath(path),
  };

  /** Basenames on disk in notesDir; refreshed at restore and after each flush. */
  let existingNoteFiles: string[] = [];
  /** Lowercased paths currently being opened — dedupes concurrent open requests
   *  (e.g. a double-click in the file explorer) so no two tabs race onto one file. */
  const openingPaths = new Set<string>();
  /** Lowercased paths a pinned open requested while a preview open was still in
   *  flight — the creator promotes the tab once it exists (explorer dbl-click). */
  const pinOnOpen = new Set<string>();
  /** `from` path → consecutive rename-failure count (3-strikes suppression). */
  const renameFailures = new Map<string, number>();

  async function refreshNoteListing(): Promise<void> {
    try {
      const notes = await ipc.listNotes(notesDir);
      existingNoteFiles = notes.map((n) => baseName(n.path));
    } catch {
      // Missing/unreadable notes dir → keep the last good cache; the next
      // successful flush recreates the dir and re-lists.
    }
  }

  async function flushSession(): Promise<void> {
    // Live save (settings.liveSave): write dirty FILE tabs straight to their
    // own path at the flush cadence, so no explicit Ctrl+S is needed. Runs
    // before view assembly so a saved tab is no longer fileDirty and gets no
    // session buffer (markSaved also queues any stale buffer for deletion by
    // THIS flush). Conflicted tabs are skipped — the banner must be resolved
    // first — and a save that fails or newly detects an on-disk change falls
    // back to the buffer path below, keeping the edits crash-safe either way.
    if (settingsStore.getState().settings.liveSave) {
      for (const t of tabsStore.getState().tabs) {
        if (t.kind === 'file' && t.filePath && !t.conflict && t.model.isDirty('file')) {
          await saveFileTab(t.id);
        }
      }
    }

    const { tabs, activeTabId, closedNotePaths, obsoleteBufferTabIds } = tabsStore.getState();

    // Snapshot the text we are about to write per tab, so we only advance the
    // "session-persisted" baseline for tabs the user did NOT edit during the
    // async write (otherwise a mid-flush keystroke would be marked clean).
    const assemblyTexts = new Map(tabs.map((t) => [t.id, t.model.getText()]));

    // Prune caret entries for tabs that no longer exist.
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of [...cursorByTab.keys()]) {
      if (!liveIds.has(id)) {
        cursorByTab.delete(id);
      }
    }

    const suppressedRenamePaths = new Set(
      [...renameFailures].filter(([, count]) => count >= 3).map(([from]) => from),
    );

    const view: AppSessionView = {
      notesDir,
      sessionDir,
      activeTabId,
      tabs: tabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        notePath: t.notePath,
        filePath: t.filePath,
        customTitle: t.customTitle,
        title: t.title,
        text: assemblyTexts.get(t.id)!,
        mode: t.mode,
        sessionDirty: t.model.isDirty('session'),
        fileDirty: t.model.isDirty('file'),
        savedMtimeMs: t.savedMtimeMs,
        cursor: cursorByTab.get(t.id) ?? null,
      })),
      existingNoteFiles,
      closedNotePaths,
      obsoleteBufferPaths: obsoleteBufferTabIds.map((id) => bufferPathFor(sessionDir, id)),
      suppressedRenamePaths,
    };

    const plan = planFlush(view);
    const result = await executeFlushPlan(plan, io);

    // Sort renames into succeeded / failed and update the strike counters.
    const failed = new Set(result.renameFailures.map((r) => r.from));
    const renamedPaths: Record<string, string> = {};
    for (const rename of plan.noteRenames) {
      if (failed.has(rename.from)) {
        renameFailures.set(rename.from, (renameFailures.get(rename.from) ?? 0) + 1);
      } else {
        renameFailures.delete(rename.from);
        renamedPaths[rename.from] = rename.to;
      }
    }

    tabsStore.getState().applyFlushResult({
      assignedNotePaths: result.assignedNotePaths,
      renamedPaths,
      consumedClosedNotePaths: closedNotePaths,
      consumedObsoleteBufferTabIds: obsoleteBufferTabIds,
    });

    // Advance the session baseline only for tabs untouched since assembly.
    for (const t of tabsStore.getState().tabs) {
      const written = assemblyTexts.get(t.id);
      if (written !== undefined && t.model.getText() === written) {
        t.model.markPersisted('session');
      }
    }

    await refreshNoteListing();
  }

  const flusher: DebouncedFlusher = createDebouncedFlusher({
    idleMs: 1000,
    maxWaitMs: 5000,
    run: flushSession,
    onError: (error) => {
      console.error('[session] flush failed', error);
      uiStore.getState().showNotice('Could not save session — will retry.');
      deps.onError?.(error);
    },
  });

  setFlushRequester(() => flusher.request());

  async function readNoteTabs(persisted: PersistedTab[]): Promise<{
    tabs: RestoredTabInit[];
    missing: string[];
  }> {
    const restored: RestoredTabInit[] = [];
    const missing: string[] = [];
    for (const pt of persisted) {
      if (pt.kind === 'image') {
        // Image tabs hold no text; just confirm the file still exists.
        if (!pt.filePath) {
          continue;
        }
        try {
          const stat = await ipc.statPath(pt.filePath);
          if (stat.exists) {
            restored.push(persistedToInit(pt, ''));
          } else {
            missing.push(baseName(pt.filePath));
          }
        } catch {
          // A transient stat failure shouldn't drop the tab; restore it and
          // let the viewer surface a load error if the file is really gone.
          restored.push(persistedToInit(pt, ''));
        }
        continue;
      }
      if (pt.kind === 'note') {
        if (pt.notePath === null) {
          // A never-flushed empty note: no file, restore it empty.
          restored.push(persistedToInit(pt, ''));
          continue;
        }
        try {
          const { text } = await ipc.readTextFile(pt.notePath);
          restored.push(persistedToInit(pt, text));
        } catch {
          missing.push(baseName(pt.notePath));
        }
      } else {
        // File tabs: the buffer (unsaved edits) wins over the on-disk file
        // when present — that's exactly what "restore edits after a kill"
        // means. Falling back to the file itself makes the tab dirty=false;
        // reading the buffer makes it dirty=true (the write to filePath never
        // happened). checkAllFileConflicts (called after restoreSession)
        // separately catches an on-disk change while the app was closed.
        let text: string | null = null;
        let dirty = false;
        if (pt.hasBuffer) {
          try {
            text = (await ipc.readTextFile(bufferPathFor(sessionDir, pt.id))).text;
            dirty = true;
          } catch {
            text = null;
          }
        }
        if (text === null && pt.filePath) {
          try {
            text = (await ipc.readTextFile(pt.filePath)).text;
            dirty = false;
          } catch {
            text = null;
          }
        }
        if (text === null) {
          if (pt.filePath) {
            missing.push(baseName(pt.filePath));
          }
          continue;
        }
        restored.push(persistedToInit(pt, text, dirty));
      }
    }
    return { tabs: restored, missing };
  }

  /** Self-heal: reopen the 20 most recent notes as fresh tabs. */
  async function selfHeal(hadCorruptManifest: boolean): Promise<void> {
    if (hadCorruptManifest) {
      try {
        await ipc.renamePath(manifestPath, `${manifestPath}.bad-${now()}`);
      } catch {
        // Best effort; a failed quarantine must not block startup.
      }
    }
    let recent: RestoredTabInit[];
    try {
      const notes = await ipc.listNotes(notesDir);
      const reads = await Promise.all(
        notes.slice(0, 20).map(async (n) => {
          try {
            const { text } = await ipc.readTextFile(n.path);
            return { path: n.path, text };
          } catch {
            return null;
          }
        }),
      );
      recent = reads
        .filter((r): r is { path: string; text: string } => r !== null)
        .map((r) => ({
          id: nanoid(),
          kind: 'note' as const,
          notePath: r.path,
          filePath: null,
          customTitle: null,
          mode: 'raw' as const,
          savedMtimeMs: null,
          text: r.text,
        }));
    } catch {
      recent = [];
    }
    tabsStore.getState().restoreSession({ tabs: recent, activeTabId: recent[0]?.id ?? null });
  }

  /**
   * The bundled docs live inside the install location, which can move between
   * launches (an AppImage mounts at a fresh path every run; installers may
   * relocate resources on update). Settings persist the docs workspace path,
   * so before restore, retarget every read-only workspace entry to the current
   * docs dir (dropping duplicates and, in builds without docs, dead entries).
   * Returns the stale roots so manifest tab paths can be remapped too.
   */
  function reconcileDocsWorkspaces(): string[] {
    const docsDir = deps.docsDir ?? null;
    const { settings, update } = settingsStore.getState();
    const stale = settings.workspaces.filter(
      (w) => w.readOnly === true && (docsDir === null || pathKey(w.path) !== pathKey(docsDir)),
    );
    if (stale.length === 0) {
      return [];
    }
    if (docsDir === null) {
      update({ workspaces: settings.workspaces.filter((w) => w.readOnly !== true) });
      return [];
    }
    const seen = new Set<string>();
    const next = [];
    for (const w of settings.workspaces) {
      const entry = w.readOnly === true ? { ...w, path: docsDir } : w;
      const key = pathKey(entry.path);
      if (!seen.has(key)) {
        seen.add(key);
        next.push(entry);
      }
    }
    update({ workspaces: next });
    return stale.map((w) => w.path);
  }

  /** Remap a path under one of the stale docs roots onto the current docs dir. */
  function remapDocsPath(path: string | null, staleRoots: string[]): string | null {
    const docsDir = deps.docsDir;
    if (path === null || !docsDir) {
      return path;
    }
    const key = pathKey(path);
    for (const root of staleRoots) {
      const rootKey = pathKey(root);
      if (key.startsWith(`${rootKey}/`)) {
        return joinPath(docsDir, path.slice(root.length + 1));
      }
    }
    return path;
  }

  async function restore(): Promise<void> {
    await refreshNoteListing();

    let raw: string | null;
    try {
      raw = (await ipc.readTextFile(manifestPath)).text;
    } catch {
      // NOT_FOUND (first launch) or unreadable — either way, no manifest.
      raw = null;
    }

    const manifest: SessionManifest | null = raw !== null ? parseManifest(raw) : null;

    const staleDocsRoots = reconcileDocsWorkspaces();
    if (manifest !== null && staleDocsRoots.length > 0) {
      for (const t of manifest.tabs) {
        t.filePath = remapDocsPath(t.filePath, staleDocsRoots);
      }
    }

    if (manifest === null) {
      // A file that existed but wouldn't parse is corrupt → quarantine it.
      await selfHeal(raw !== null);
    } else {
      const { tabs, missing } = await readNoteTabs(manifest.tabs);
      for (const t of tabs) {
        const cursor = manifest.tabs.find((pt) => pt.id === t.id)?.cursor;
        if (cursor) {
          cursorByTab.set(t.id, cursor);
        }
      }
      const activeTabId = tabs.some((t) => t.id === manifest.activeTabId)
        ? manifest.activeTabId
        : (tabs[0]?.id ?? null);
      tabsStore.getState().restoreSession({ tabs, activeTabId });
      if (missing.length > 0) {
        uiStore
          .getState()
          .showNotice(`${missing.length} file(s) could not be found — those tabs were skipped.`);
      }
      // File tab restore honors hasBuffer (above); this catches the OTHER
      // half — the on-disk file itself changing while the app was closed.
      await checkAllFileConflicts();
    }

    // Persist a fresh manifest once at boot: a self-heal has a new tab set to
    // record, and even a clean restore benefits from re-anchoring the manifest.
    flusher.request();
  }

  /**
   * Save an existing FILE tab to its own path (Ctrl+S; also the "save" branch
   * of the close-tab prompt). Re-stats first — "before every save"
   * — so a real external change is never silently clobbered: the save is
   * refused and the ConflictBanner takes over instead. Returns whether the
   * tab ended up clean (false = failed or blocked by a conflict).
   */
  async function saveFileTab(id: string): Promise<boolean> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return false;
    }
    const filePath = tab.filePath;
    try {
      const stat = await ipc.statPath(filePath);
      if (stat.exists && stat.mtimeMs !== null && stat.mtimeMs !== tab.savedMtimeMs) {
        tabsStore.getState().setConflict(id, true);
        uiStore.getState().showNotice(`"${tab.title}" changed on disk — resolve it before saving.`);
        return false;
      }
      // A missing file (deleted while open) is not a conflict: atomic_write_text
      // below simply recreates it.
    } catch {
      // A transient stat failure must not block the save.
    }
    try {
      await ipc.atomicWriteText(filePath, tab.model.getText());
      const after = await ipc.statPath(filePath);
      tabsStore.getState().markSaved(id, after.mtimeMs ?? now());
      return true;
    } catch (error) {
      uiStore.getState().showNotice(`Could not save "${tab.title}".`);
      deps.onError?.(error);
      return false;
    }
  }

  async function saveActive(): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab) {
      return;
    }
    if (tab.readOnly) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    if (tab.kind === 'note') {
      // Save on a note tab behaves as Save As.
      await saveAsActive();
      return;
    }
    await saveFileTab(tab.id);
  }

  async function saveAsActive(): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab || tab.kind === 'image') {
      return; // an image viewer has no text to save
    }
    if (tab.readOnly) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    const suggested =
      tab.kind === 'file' ? (tab.filePath ?? undefined) : `${slugifyTitle(tab.title)}.md`;
    const target = await saveDialog(suggested);
    if (!target) {
      return; // user cancelled
    }
    try {
      await ipc.atomicWriteText(target, tab.model.getText());
      const stat = await ipc.statPath(target);
      tabsStore.getState().saveToPath(tab.id, { filePath: target, mtimeMs: stat.mtimeMs ?? now() });
    } catch (error) {
      uiStore.getState().showNotice(`Could not save "${tab.title}".`);
      deps.onError?.(error);
    }
  }

  /** Finds an open tab (file OR note) that already owns the path (by key). */
  function tabOwning(key: string) {
    return tabsStore
      .getState()
      .tabs.find(
        (t) =>
          (t.filePath && pathKey(t.filePath) === key) ||
          (t.notePath && pathKey(t.notePath) === key),
      );
  }

  /**
   * Open each path as a tab (focusing an existing one). `preview` (explorer
   * single-click) opens a reusable italic preview tab; a non-preview open of an
   * already-preview tab PROMOTES it to permanent (explorer double-click / Ctrl+O).
   */
  async function openPaths(paths: string[], opts: { preview?: boolean } = {}): Promise<void> {
    const preview = opts.preview ?? false;
    for (const path of paths) {
      const lower = pathKey(path);
      // Focus the created/existing tab, and pin it when this open wasn't a
      // preview (or a concurrent pinned request asked for it while it opened).
      const settle = (id: string): void => {
        tabsStore.getState().activateTab(id);
        if (!preview || pinOnOpen.delete(lower)) {
          tabsStore.getState().promoteTab(id);
        }
      };
      // Already open (as a file OR a note tab) → just focus (and maybe pin) it.
      const existing = tabOwning(lower);
      if (existing) {
        settle(existing.id);
        continue;
      }
      // A concurrent request is already opening this exact path — a rapid
      // double-click in the file browser fires two opens before the first has
      // created its tab, so the pre-await check above misses. Let the in-flight
      // open win rather than reading the file and creating a second tab; if THIS
      // is the pinning (double-click) open, leave a note so the creator pins it.
      if (openingPaths.has(lower)) {
        if (!preview) {
          pinOnOpen.add(lower);
        }
        continue;
      }
      openingPaths.add(lower);
      try {
        if (isImagePath(path)) {
          // Images open as a read-only viewer tab; existence check up front so
          // a bad path errors here (like a failed read) instead of in the view.
          const stat = await ipc.statPath(path);
          if (!stat.exists) {
            throw new Error(`not found: ${path}`);
          }
          const owner = tabOwning(lower);
          if (owner) {
            settle(owner.id);
          } else {
            settle(
              tabsStore.getState().openImageTab({
                filePath: path,
                savedMtimeMs: stat.mtimeMs,
                preview,
                readOnly: isReadOnlyPath(path),
              }),
            );
          }
          continue;
        }
        const { text, mtimeMs } = await ipc.readTextFile(path);
        // Re-check after the await: a tab for this path may have appeared while
        // we were reading (e.g. a note tab the flusher just assigned a path).
        const now = tabOwning(lower);
        if (now) {
          settle(now.id);
        } else {
          settle(
            tabsStore.getState().openFileTab({
              filePath: path,
              text,
              savedMtimeMs: mtimeMs,
              preview,
              readOnly: isReadOnlyPath(path),
            }),
          );
        }
      } catch (error) {
        uiStore.getState().showNotice(`Could not open "${baseName(path)}".`);
        deps.onError?.(error);
      } finally {
        openingPaths.delete(lower);
        pinOnOpen.delete(lower);
      }
    }
  }

  async function openFileDialog(): Promise<void> {
    const selected = await openDialog();
    if (!selected || selected.length === 0) {
      return;
    }
    await openPaths(selected);
  }

  /**
   * Rename a FILE tab's file on disk, preserving its extension and the user's
   * casing/spacing. Guards against clobbering an existing file; content and
   * dirty state are untouched (the bytes moved, they weren't saved).
   */
  async function renameFileTab(id: string, newName: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || (tab.kind !== 'file' && tab.kind !== 'image') || !tab.filePath) {
      return;
    }
    if (tab.readOnly || isReadOnlyPath(tab.filePath)) {
      uiStore.getState().showNotice('This document is read-only.');
      return;
    }
    const oldPath = tab.filePath;
    const ext = extName(oldPath);
    // If the user typed the extension too ("notes.md"), don't double it.
    const safeBase = sanitizeFileBaseName(dropTrailingExtension(newName.trim(), ext));
    if (!safeBase) {
      uiStore.getState().showNotice('That name can’t be used for a file.');
      return;
    }
    const newPath = joinPath(dirName(oldPath), `${safeBase}${ext}`);
    if (pathKey(newPath) === pathKey(oldPath)) {
      return; // no change (or case-only on a case-insensitive FS)
    }
    try {
      const existing = await ipc.statPath(newPath);
      if (existing.exists) {
        uiStore.getState().showNotice(`A file named "${safeBase}${ext}" already exists.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the rename; renamePath below
      // will surface a real problem.
    }
    try {
      await ipc.renamePath(oldPath, newPath);
      let mtimeMs = tab.savedMtimeMs ?? now();
      try {
        const after = await ipc.statPath(newPath);
        mtimeMs = after.mtimeMs ?? mtimeMs;
      } catch {
        // Keep the prior baseline; the next save re-stats anyway.
      }
      tabsStore.getState().retargetFilePath(id, { filePath: newPath, mtimeMs });
    } catch (error) {
      uiStore.getState().showNotice(`Could not rename "${tab.title}".`);
      deps.onError?.(error);
    }
  }

  /**
   * Browse for a file/image and insert a markdown reference to it at the caret
   * of the active tab's source editor. Inserts an absolute path by default;
   * `absolute: false` (Alt-click) prefers a path relative to the current
   * document, falling back to absolute when the document is unsaved or the
   * target lives on another drive/root.
   */
  async function insertLinkFromDialog({
    image,
    absolute,
  }: {
    image: boolean;
    absolute: boolean;
  }): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab) {
      return;
    }
    if (tab.mode === 'wysiwyg') {
      uiStore.getState().showNotice('Link controls work in Markdown and Split modes.');
      return;
    }
    const adapter = getSourceAdapter(tab.id);
    if (!adapter) {
      return;
    }
    const picked = await pickFile(image ? 'image' : 'any');
    if (!picked) {
      return; // cancelled
    }
    const docPath = tab.filePath ?? tab.notePath;
    let url: string | null = null;
    if (!absolute && docPath) {
      url = relativePath(dirName(docPath), picked);
      if (url === null) {
        uiStore.getState().showNotice('No relative path to that location — used an absolute path.');
      }
    }
    if (url === null) {
      // Absolute (requested, unsaved doc, or cross-root): forward-slash it so
      // the markdown destination is uniform and valid on every OS.
      url = picked.replace(/\\/g, '/');
    }
    adapter.insertLinkTo(stripExtension(baseName(picked)), url, image);
  }

  async function checkConflict(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return;
    }
    try {
      const stat = await ipc.statPath(tab.filePath);
      const conflicted = stat.exists && stat.mtimeMs !== null && stat.mtimeMs !== tab.savedMtimeMs;
      tabsStore.getState().setConflict(id, conflicted);
    } catch {
      // A transient stat failure is not itself a conflict signal.
    }
  }

  async function checkAllFileConflicts(): Promise<void> {
    const fileTabIds = tabsStore
      .getState()
      .tabs.filter((t) => t.kind === 'file')
      .map((t) => t.id);
    await Promise.all(fileTabIds.map((id) => checkConflict(id)));
  }

  async function reloadFromDisk(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return;
    }
    try {
      const { text, mtimeMs } = await ipc.readTextFile(tab.filePath);
      tab.model.pushText(text, 'file-load');
      tabsStore.getState().markSaved(id, mtimeMs);
    } catch (error) {
      uiStore.getState().showNotice(`Could not reload "${tab.title}".`);
      deps.onError?.(error);
    }
  }

  async function keepMine(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return;
    }
    let mtimeMs = tab.savedMtimeMs ?? now();
    try {
      const stat = await ipc.statPath(tab.filePath);
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // Keep the previous baseline; the next save will re-stat anyway.
    }
    tabsStore.getState().acknowledgeConflict(id, mtimeMs);
  }

  /**
   * M6 — repoint the notes directory. Picks a folder, optionally moves the
   * existing note files (default yes), then updates the setting + the live
   * `notesDir` so the next flush writes to the new location. Files that can't
   * be moved (locked, name collision) are left in the old dir and reported;
   * successfully-moved notes have their tabs' `notePath` retargeted so restore
   * and the next flush stay consistent.
   */
  async function changeNotesDir(): Promise<void> {
    const picked = await pickDirectory();
    if (!picked || picked === notesDir) {
      return;
    }
    const moves = planNoteMoves(existingNoteFiles, notesDir, picked);

    let proceed = true;
    if (moves.length > 0) {
      proceed = await confirm(
        `Move ${moves.length} existing note(s) to the new folder?`,
        'Change notes folder',
      );
    }

    const failures: string[] = [];
    const renamedPaths: Record<string, string> = {};
    if (proceed && moves.length > 0) {
      let done = 0;
      for (const move of moves) {
        try {
          await ipc.renamePath(move.from, move.to);
          renamedPaths[move.from] = move.to;
        } catch (error) {
          failures.push(baseName(move.from));
          deps.onError?.(error);
        }
        done += 1;
        uiStore.getState().showNotice(`Moving notes… ${done}/${moves.length}`);
      }
      // Retarget the tabs of notes that actually moved (M2's applyFlushResult
      // already knows how to remap notePath by old→new path).
      if (Object.keys(renamedPaths).length > 0) {
        tabsStore.getState().applyFlushResult({
          assignedNotePaths: {},
          renamedPaths,
          consumedClosedNotePaths: [],
          consumedObsoleteBufferTabIds: [],
        });
      }
    }

    // Point the app at the new dir regardless of the move outcome; a fresh
    // listing seeds the clobber-guard for the new location.
    notesDir = picked;
    settingsStore.getState().update({ notesDir: picked });
    await refreshNoteListing();

    if (failures.length > 0) {
      uiStore
        .getState()
        .showNotice(
          `Left ${failures.length} note(s) in the old folder (couldn't move): ${failures.join(', ')}`,
        );
    } else if (proceed && moves.length > 0) {
      uiStore.getState().showNotice(`Moved ${moves.length} note(s) to the new folder.`);
    }

    flusher.request();
  }

  /**
   * Add-workspace flow: pick a folder (the native picker doubles as "create a
   * new folder"), reject duplicates of the default workspace or an existing
   * entry, then persist it to settings. Removal never deletes files, so the
   * whole feature is non-destructive.
   */
  async function addWorkspaceFromDialog(): Promise<void> {
    const picked = await pickDirectory();
    if (!picked) {
      return;
    }
    const key = pathKey(picked);
    const { settings, update } = settingsStore.getState();
    if (key === pathKey(notesDir) || settings.workspaces.some((w) => pathKey(w.path) === key)) {
      uiStore.getState().showNotice('That folder is already a workspace.');
      return;
    }
    const name = baseName(picked) || picked;
    // Auto-assign a color not already in use (the default workspace's color
    // counts as used too); the user can change or clear it afterwards.
    const color = pickUnusedColor([
      settings.defaultWorkspaceColor,
      ...settings.workspaces.map((w) => w.color),
    ]);
    update({ workspaces: [...settings.workspaces, { name, path: picked, color }] });
  }

  /**
   * Settings "Open docs": register the bundled documentation folder as a
   * read-only workspace (idempotent — an existing entry for that path is
   * upgraded to read-only rather than duplicated), reveal it in the explorer,
   * and open its start page pinned to read mode.
   */
  async function openDocsWorkspace(): Promise<void> {
    const docsDir = deps.docsDir ?? null;
    if (!docsDir) {
      uiStore.getState().showNotice('Documentation is not available in this build.');
      return;
    }
    try {
      if (!(await ipc.statPath(docsDir)).exists) {
        uiStore.getState().showNotice('The documentation folder could not be found.');
        return;
      }
    } catch {
      // A transient stat failure shouldn't block the flow; list_dir will
      // surface a real problem as an empty workspace.
    }
    const key = pathKey(docsDir);
    const { settings, update } = settingsStore.getState();
    const existing = settings.workspaces.find((w) => pathKey(w.path) === key);
    if (existing) {
      if (existing.readOnly !== true) {
        update({
          workspaces: settings.workspaces.map((w) =>
            pathKey(w.path) === key ? { ...w, readOnly: true } : w,
          ),
        });
      }
    } else {
      const color = pickUnusedColor([
        settings.defaultWorkspaceColor,
        ...settings.workspaces.map((w) => w.color),
      ]);
      update({
        workspaces: [
          ...settings.workspaces,
          { name: 'Documentation', path: docsDir, color, readOnly: true },
        ],
      });
    }
    if (!uiStore.getState().explorerOpen) {
      uiStore.getState().toggleExplorer();
    }
    // The guide's start page; opened AFTER the workspace exists so
    // isReadOnlyPath pins the tab to read mode.
    await openPaths([joinPath(docsDir, 'README.md')]);
  }

  /** First free `base.ext`, `base-2.ext`, … inside `dir` (case handled by FS). */
  async function uniquePathIn(dir: string, base: string, ext: string): Promise<string> {
    let candidate = joinPath(dir, `${base}${ext}`);
    for (let i = 2; ; i++) {
      try {
        if (!(await ipc.statPath(candidate)).exists) {
          return candidate;
        }
      } catch {
        // Can't stat → let the write/copy itself report the real problem.
        return candidate;
      }
      candidate = joinPath(dir, `${base}-${i}${ext}`);
    }
  }

  /**
   * Drag-drop import: COPY (never move) each markdown/image file into `dir`,
   * suffixing collisions. Other file types are skipped, mirroring what the
   * explorer lists. One summary notice at the end.
   */
  /** Shared refusal for writes aimed at a read-only workspace (the docs). */
  function refuseReadOnly(path: string): boolean {
    if (isReadOnlyPath(path)) {
      uiStore.getState().showNotice('The documentation is read-only.');
      return true;
    }
    return false;
  }

  async function importFiles(dir: string, paths: string[]): Promise<void> {
    if (refuseReadOnly(dir)) {
      return;
    }
    let copied = 0;
    let skipped = 0;
    let failed = 0;
    for (const path of paths) {
      const ext = extName(path);
      if (ext.toLowerCase() !== '.md' && !isImagePath(path)) {
        skipped += 1;
        continue;
      }
      if (pathKey(dirName(path)) === pathKey(dir)) {
        continue; // already exactly there; a copy would only make "x-2.md"
      }
      try {
        const target = await uniquePathIn(dir, stripExtension(baseName(path)), ext);
        await ipc.copyPath(path, target);
        copied += 1;
      } catch (error) {
        failed += 1;
        deps.onError?.(error);
      }
    }
    const parts: string[] = [];
    if (copied > 0) {
      parts.push(`Added ${copied} file(s)`);
    }
    if (skipped > 0) {
      parts.push(`skipped ${skipped} unsupported`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (parts.length > 0) {
      uiStore.getState().showNotice(`${parts.join(', ')}.`);
    }
    if (copied > 0) {
      uiStore.getState().refreshExplorer();
    }
  }

  /** The workspace root containing `path` (longest matching root), or its own
   *  directory when it lies outside every known workspace. */
  function workspaceRootFor(path: string): string {
    const roots = [notesDir, ...settingsStore.getState().settings.workspaces.map((w) => w.path)];
    const key = pathKey(path);
    let best: string | null = null;
    for (const root of roots) {
      const rootKey = pathKey(root);
      if (key === rootKey || key.startsWith(`${rootKey}/`)) {
        if (best === null || rootKey.length > pathKey(best).length) {
          best = root;
        }
      }
    }
    return best ?? dirName(path);
  }

  /** The directory a `mdPath`'s images go in, per the user's image settings. */
  function imagesDirFor(mdPath: string): string {
    const mdDir = mdPath ? dirName(mdPath) : notesDir;
    const { imagePasteLocation, imageFolderName } = settingsStore.getState().settings;
    return imageTargetDir({
      mdDir,
      workspaceRoot: workspaceRootFor(mdPath || mdDir),
      location: imagePasteLocation,
      // Sanitize so a hand-edited setting can't escape the folder or add separators.
      folderName: sanitizeFileBaseName(imageFolderName),
      join: joinPath,
    });
  }

  /** A markdown destination — angle-wrapped when it contains whitespace, the
   *  same convention the editor's link insertion uses (cm6.ts). */
  function markdownDest(src: string): string {
    return /\s/.test(src) ? `<${src}>` : src;
  }

  /** `pasted-YYYYMMDD-HHMMSS` from the injected clock; the fallback image name. */
  function timestampBase(): string {
    const stamp = new Date(now());
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `pasted-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
      `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
    );
  }

  /**
   * Save/relocate one image for `mdPath` and return how to reference it (alt +
   * an absolute forward-slashed path — absolute refs are the app default so
   * agent CLIs can resolve them from anywhere). `source` is either an existing
   * file to place (drag) or raw bytes to write (paste). Returns null on failure.
   *
   * A dragged file that ALREADY lives in the markdown file's workspace is left
   * exactly where it is and referenced in place — only images coming from
   * outside that workspace (or already in the target images dir) are copied
   * into the configured images location. Pasted bytes always go there.
   */
  async function placeImage(
    mdPath: string,
    source: { copyFrom: string } | { base64: string; ext: string; name: string | null },
  ): Promise<ImageRef | null> {
    const mdDir = mdPath ? dirName(mdPath) : notesDir;
    const targetDir = imagesDirFor(mdPath);
    try {
      let savedPath: string;
      if ('copyFrom' in source) {
        const from = source.copyFrom;
        const sameWorkspace =
          pathKey(workspaceRootFor(from)) === pathKey(workspaceRootFor(mdPath || mdDir));
        if (sameWorkspace || pathKey(dirName(from)) === pathKey(targetDir)) {
          // In the same workspace (or already in the images dir) — reference it
          // where it lives, don't duplicate it into the images folder.
          savedPath = from;
        } else {
          savedPath = await uniquePathIn(targetDir, stripExtension(baseName(from)), extName(from));
          await ipc.copyPath(from, savedPath);
        }
      } else {
        const base = (source.name ? sanitizeFileBaseName(source.name) : '') || timestampBase();
        savedPath = await uniquePathIn(targetDir, base, source.ext);
        await ipc.writeFileBase64(savedPath, source.base64);
      }
      const src = savedPath.replace(/\\/g, '/');
      return { alt: stripExtension(baseName(savedPath)), src };
    } catch (error) {
      deps.onError?.(error);
      return null;
    }
  }

  /**
   * Drag-drop onto an md file row: embed the dropped image(s) at the END of that
   * markdown file, after a confirmation prompt. Each image is saved into the
   * configured images location (referenced in place if already there). When a
   * tab already owns the file the append goes through its live model — so the
   * user sees it immediately and the flusher/live-save persists it — rather than
   * writing under the open editor and provoking a conflict.
   */
  async function appendImagesToMarkdown(mdPath: string, paths: string[]): Promise<void> {
    if (refuseReadOnly(mdPath)) {
      return;
    }
    const images = paths.filter((p) => isImagePath(p));
    if (images.length === 0) {
      return;
    }
    const ok = await confirm(
      images.length === 1
        ? `Insert this image into "${baseName(mdPath)}"?`
        : `Insert ${images.length} images into "${baseName(mdPath)}"?`,
      'Insert image',
    );
    if (!ok) {
      return;
    }
    const refs: string[] = [];
    let failed = 0;
    for (const img of images) {
      const ref = await placeImage(mdPath, { copyFrom: img });
      if (ref) {
        refs.push(`![${ref.alt}](${markdownDest(ref.src)})`);
      } else {
        failed += 1;
      }
    }
    if (refs.length === 0) {
      uiStore.getState().showNotice('Could not add the image(s).');
      return;
    }
    const block = refs.join('\n\n');
    const appended = (text: string): string =>
      text.trim().length === 0 ? `${block}\n` : `${text.replace(/\s*$/, '')}\n\n${block}\n`;

    const owner = tabOwning(pathKey(mdPath));
    if (owner && owner.kind !== 'image') {
      owner.model.pushText(appended(owner.model.getText()), 'programmatic');
      flusher.request();
    } else {
      let existing = '';
      try {
        existing = (await ipc.readTextFile(mdPath)).text;
      } catch {
        // Unreadable/missing — start fresh; atomicWriteText recreates the file.
      }
      try {
        await ipc.atomicWriteText(mdPath, appended(existing));
      } catch (error) {
        uiStore.getState().showNotice(`Could not update "${baseName(mdPath)}".`);
        deps.onError?.(error);
        return;
      }
    }
    uiStore.getState().refreshExplorer();
    const suffix = failed > 0 ? ` (${failed} failed)` : '';
    uiStore
      .getState()
      .showNotice(`Added ${refs.length} image(s) to "${baseName(mdPath)}"${suffix}.`);
  }

  /**
   * Editor paste: save one clipboard image into the configured images location
   * for `tabId`'s document and return its reference for the editor to insert at
   * the caret. Note tabs with no file yet resolve against the notes dir.
   */
  async function savePastedImage(
    tabId: string,
    file: { base64: string; ext: string; name: string | null },
  ): Promise<ImageRef | null> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.kind === 'image') {
      return null;
    }
    const ref = await placeImage(tab.notePath ?? tab.filePath ?? '', file);
    if (ref) {
      uiStore.getState().refreshExplorer();
    } else {
      uiStore.getState().showNotice('Could not save the pasted image.');
    }
    return ref;
  }

  /** Clipboard paste: write one file's bytes into `dir` under a safe name. */
  async function savePastedFile(dir: string, file: PastedFile): Promise<void> {
    if (refuseReadOnly(dir)) {
      return;
    }
    const base = (file.name !== null ? sanitizeFileBaseName(file.name) : '') || timestampBase();
    try {
      const target = await uniquePathIn(dir, base, file.ext);
      await ipc.writeFileBase64(target, file.base64);
      uiStore.getState().showNotice(`Saved "${baseName(target)}".`);
      uiStore.getState().refreshExplorer();
    } catch (error) {
      uiStore.getState().showNotice('Could not save the pasted image.');
      deps.onError?.(error);
    }
  }

  /**
   * Context-menu "New file": create an empty, uniquely-named .md file in
   * `dir`, open it as a file tab, and begin the inline tab rename so the user
   * can name it in one motion (the rename also renames the file on disk).
   */
  async function createNewFile(dir: string): Promise<void> {
    if (refuseReadOnly(dir)) {
      return;
    }
    try {
      const target = await uniquePathIn(dir, 'untitled', '.md');
      await ipc.atomicWriteText(target, '');
      uiStore.getState().refreshExplorer();
      await openPaths([target]);
      const tab = tabOwning(pathKey(target));
      if (tab) {
        tabsStore.getState().beginRename(tab.id);
      }
    } catch (error) {
      uiStore.getState().showNotice('Could not create a new file there.');
      deps.onError?.(error);
    }
  }

  /** Context-menu "New folder": create a uniquely-named subfolder in `dir`. */
  async function createNewFolder(dir: string): Promise<void> {
    if (refuseReadOnly(dir)) {
      return;
    }
    try {
      const target = await uniquePathIn(dir, 'new-folder', '');
      await ipc.createDir(target);
      uiStore.getState().refreshExplorer();
    } catch (error) {
      uiStore.getState().showNotice('Could not create a folder there.');
      deps.onError?.(error);
    }
  }

  /**
   * Context-menu "Rename" for an explorer entry. A file some tab already owns
   * goes through the tab-rename flow instead of a raw disk rename — one code
   * path for the clobber guard and tab retarget (file/image tabs) or the
   * title-drives-the-filename flush machinery (note tabs). Renaming a folder
   * retargets every open tab whose file lives under it.
   */
  async function renameEntry(path: string, newName: string, isDir: boolean): Promise<void> {
    if (refuseReadOnly(path)) {
      return;
    }
    const owner = isDir ? undefined : tabOwning(pathKey(path));
    if (owner && (owner.kind === 'file' || owner.kind === 'image')) {
      await renameFileTab(owner.id, newName);
      uiStore.getState().refreshExplorer();
      return;
    }
    if (owner) {
      // A note tab: its filename follows the tab title (slugged) at the next
      // flush — renaming the file out from under the flusher would fight it.
      tabsStore.getState().renameTab(owner.id, newName);
      return;
    }
    const ext = isDir ? '' : extName(path);
    // If the user typed the extension too ("notes.md"), don't double it.
    const safeBase = sanitizeFileBaseName(dropTrailingExtension(newName.trim(), ext));
    if (!safeBase) {
      uiStore.getState().showNotice('That name can’t be used.');
      return;
    }
    const newPath = joinPath(dirName(path), `${safeBase}${ext}`);
    if (pathKey(newPath) === pathKey(path)) {
      return; // no change (or case-only on a case-insensitive FS)
    }
    try {
      if ((await ipc.statPath(newPath)).exists) {
        uiStore.getState().showNotice(`"${baseName(newPath)}" already exists.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the rename; renamePath below
      // will surface a real problem.
    }
    try {
      await ipc.renamePath(path, newPath);
    } catch (error) {
      uiStore.getState().showNotice(`Could not rename "${baseName(path)}".`);
      deps.onError?.(error);
      return;
    }
    if (isDir) {
      // Retarget open tabs whose files lived under the renamed folder. Key
      // comparison for the prefix match, raw-path surgery for the new value
      // (pathKey preserves length, so slicing by `path.length` is safe).
      const oldPrefix = `${pathKey(path)}/`;
      const renamedNotePaths: Record<string, string> = {};
      for (const t of tabsStore.getState().tabs) {
        if (t.filePath && pathKey(t.filePath).startsWith(oldPrefix)) {
          tabsStore.getState().retargetFilePath(t.id, {
            filePath: newPath + t.filePath.slice(path.length),
            mtimeMs: t.savedMtimeMs ?? now(),
          });
        } else if (t.notePath && pathKey(t.notePath).startsWith(oldPrefix)) {
          renamedNotePaths[t.notePath] = newPath + t.notePath.slice(path.length);
        }
      }
      if (Object.keys(renamedNotePaths).length > 0) {
        tabsStore.getState().applyFlushResult({
          assignedNotePaths: {},
          renamedPaths: renamedNotePaths,
          consumedClosedNotePaths: [],
          consumedObsoleteBufferTabIds: [],
        });
      }
    }
    uiStore.getState().refreshExplorer();
  }

  /**
   * Drag-drop move: relocate a single file/image from the explorer into
   * `destDir`, keeping its basename. Confirms first (VSCode-style) unless the
   * user turned that prompt off in settings. No-ops when it's already there;
   * refuses a name collision. A tab that owns the file is retargeted so the
   * flusher and restore stay consistent — file/image tabs via retargetFilePath,
   * note tabs via applyFlushResult (same remap changeNotesDir uses).
   */
  async function moveEntry(sourcePath: string, destDir: string): Promise<void> {
    if (refuseReadOnly(sourcePath) || refuseReadOnly(destDir)) {
      return;
    }
    if (pathKey(dirName(sourcePath)) === pathKey(destDir)) {
      return; // already in this folder
    }
    const newPath = joinPath(destDir, baseName(sourcePath));
    if (pathKey(newPath) === pathKey(sourcePath)) {
      return;
    }
    try {
      if ((await ipc.statPath(newPath)).exists) {
        uiStore.getState().showNotice(`"${baseName(newPath)}" already exists in that folder.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the move; renamePath surfaces
      // any real problem below.
    }
    if (settingsStore.getState().settings.confirmFileMove) {
      const ok = await confirm(
        `Move "${baseName(sourcePath)}" to "${baseName(destDir)}"?`,
        'Move file',
      );
      if (!ok) {
        return;
      }
    }
    const owner = tabOwning(pathKey(sourcePath));
    try {
      await ipc.renamePath(sourcePath, newPath);
    } catch (error) {
      uiStore.getState().showNotice(`Could not move "${baseName(sourcePath)}".`);
      deps.onError?.(error);
      return;
    }
    if (owner && (owner.kind === 'file' || owner.kind === 'image')) {
      let mtimeMs = owner.savedMtimeMs ?? now();
      try {
        const after = await ipc.statPath(newPath);
        mtimeMs = after.mtimeMs ?? mtimeMs;
      } catch {
        // Keep the prior baseline; the next save re-stats anyway.
      }
      tabsStore.getState().retargetFilePath(owner.id, { filePath: newPath, mtimeMs });
    } else if (owner && owner.kind === 'note') {
      tabsStore.getState().applyFlushResult({
        assignedNotePaths: {},
        renamedPaths: { [sourcePath]: newPath },
        consumedClosedNotePaths: [],
        consumedObsoleteBufferTabIds: [],
      });
    }
    uiStore.getState().refreshExplorer();
  }

  /**
   * Context-menu "Delete" for a file/image entry. Deletion is unrecoverable
   * (there is no trash), so it confirms first. A tab that owns the file is
   * closed BEFORE the delete so neither Ctrl+S nor the flusher can recreate the
   * file from the still-open editor. Folders aren't deletable here — delete_path
   * removes files only.
   */
  async function deleteEntry(path: string): Promise<void> {
    if (refuseReadOnly(path)) {
      return;
    }
    const ok = await confirm(`Delete "${baseName(path)}"? This can’t be undone.`, 'Delete file');
    if (!ok) {
      return;
    }
    const owner = tabOwning(pathKey(path));
    if (owner) {
      tabsStore.getState().closeTab(owner.id);
    }
    try {
      await ipc.deletePath(path);
    } catch (error) {
      uiStore.getState().showNotice(`Could not delete "${baseName(path)}".`);
      deps.onError?.(error);
      return;
    }
    uiStore.getState().showNotice(`Deleted "${baseName(path)}".`);
    uiStore.getState().refreshExplorer();
  }

  async function closeTabInteractive(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    const text = tab.model.getText();
    if (tab.kind === 'note' && text.trim().length > 0) {
      const ok = await confirm(`Close "${tab.title}"? Its note will be deleted.`, 'Close note');
      if (!ok) {
        return;
      }
    } else if (tab.kind === 'file' && tab.model.isDirty('file')) {
      const choice = await saveDiscardCancel(
        `Save changes to "${tab.title}" before closing?`,
        'Close file',
      );
      if (choice === 'cancel') {
        return;
      }
      if (choice === 'save') {
        const saved = await saveFileTab(id);
        if (!saved) {
          return; // save failed, or a conflict banner is now blocking it — keep the tab open
        }
      }
    }
    tabsStore.getState().closeTab(id);
  }

  /**
   * Close every open tab, oldest-first, each through {@link closeTabInteractive}
   * so unsaved file edits and non-empty notes still prompt. A cancel on any tab
   * stops the sweep (VSCode-style) rather than silently skipping it. The last
   * close leaves one fresh Untitled tab (the store's Notepad invariant).
   */
  async function closeAllTabsInteractive(): Promise<void> {
    for (const id of tabsStore.getState().tabs.map((t) => t.id)) {
      await closeTabInteractive(id);
      if (tabsStore.getState().tabs.some((t) => t.id === id)) {
        return; // the user cancelled this tab's close — stop here
      }
    }
  }

  interactiveCloser = (id) => void closeTabInteractive(id);
  closeAllTabsDispatch = () => void closeAllTabsInteractive();
  openFileDispatch = () => void openFileDialog();
  saveDispatch = () => void saveActive();
  saveAsDispatch = () => void saveAsActive();
  reloadDispatch = (id) => void reloadFromDisk(id);
  keepMineDispatch = (id) => void keepMine(id);
  changeNotesDirDispatch = () => void changeNotesDir();
  listNotesDispatch = async (dir?: string) => {
    const entries = await ipc.listDir(dir ?? notesDir);
    return entries.map((e) => ({
      path: e.path,
      name: baseName(e.path),
      isDir: e.isDir,
      mtimeMs: e.mtimeMs,
    }));
  };
  readImageDispatch = async (path: string) =>
    `data:${imageMimeType(path)};base64,${await ipc.readFileBase64(path)}`;
  defaultWorkspaceDispatch = () => notesDir;
  addWorkspaceDispatch = () => void addWorkspaceFromDialog();
  openDocsDispatch = () => void openDocsWorkspace();
  importFilesDispatch = importFiles;
  appendImagesDispatch = appendImagesToMarkdown;
  savePastedImageDispatch = savePastedImage;
  savePastedFileDispatch = savePastedFile;
  createNewFileDispatch = createNewFile;
  createNewFolderDispatch = createNewFolder;
  renameEntryDispatch = renameEntry;
  moveEntryDispatch = moveEntry;
  deleteEntryDispatch = deleteEntry;
  renameTabDispatch = (id, newName) => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (tab && (tab.kind === 'file' || tab.kind === 'image') && tab.filePath) {
      void renameFileTab(id, newName);
    } else {
      // Note tab: set the title; the flush renames the note file to the new
      // slug. The tab label (a slug of the title) updates immediately.
      tabsStore.getState().renameTab(id, newName);
    }
  };
  insertFileLinkDispatch = (opts) => void insertLinkFromDialog(opts);
  openNotePathDispatch = (path) => {
    // Never open a second editor over a file some tab already owns (would let
    // two tabs write the same path) — focus the existing one instead. New
    // files reuse the tested file-tab open path. Preview-tab behavior is opt-in
    // via settings; openPaths handles the reuse/replace of the preview slot.
    const existing = tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      return;
    }
    void openPaths([path], { preview: settingsStore.getState().settings.previewTabs });
  };
  openNotePathPinnedDispatch = (path) => {
    // Explorer double-click: open (or promote) the file as a PERMANENT tab.
    const existing = tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      tabsStore.getState().promoteTab(existing.id);
      return;
    }
    void openPaths([path]);
  };

  return {
    restore,
    request: () => flusher.request(),
    flushNow: () => flusher.flushNow(),
    dispose: () => flusher.dispose(),
    closeTabInteractive,
    closeAllTabsInteractive,
    openFileDialog,
    openPaths,
    saveActive,
    saveAsActive,
    checkConflict,
    checkAllFileConflicts,
    reloadFromDisk,
    keepMine,
    changeNotesDir,
  };
}
