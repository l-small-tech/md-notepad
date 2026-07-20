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
 *
 * Split across src/ui/session/ by section: `facade.ts` (module-level dispatch
 * indirections + shared types), `context.ts` (SessionCtx, the shared closure
 * state), and one factory per section — `flush-restore`, `open-save`,
 * `workspaces`, `import-images`, `explorer-ops`, `windows`. This index wires
 * them together and re-exports the whole former `src/ui/session.ts` surface.
 */

import { baseName, dirName, joinPath, type FlushIo } from '../../core/session/plan-flush';
import type { DebouncedFlusher } from '../../core/session/debounce';
import { imageMimeType } from '../../core/images';
import { isCommentsPath } from '../../core/comments';
import { currentProvider } from '../../ipc/provider';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionController, SessionControllerDeps, SessionCtx } from './context';
import {
  isReadOnlyPath,
  pathKey,
  setAddCloudWorkspaceDispatch,
  setAddWorkspaceDispatch,
  setAppendImagesDispatch,
  setBuildExportPreviewHtmlDispatch,
  setChangeNotesDirDispatch,
  setCloseAllTabsDispatch,
  setCreateNewFileDispatch,
  setCreateNewFolderDispatch,
  setDefaultWorkspaceDispatch,
  setDeleteEntryDispatch,
  setImportDocumentDispatch,
  setImportFilesDispatch,
  setImportStatusDispatch,
  setInsertFileLinkDispatch,
  setInteractiveCloser,
  setKeepMineDispatch,
  setListNotesDispatch,
  setMoveEntryDispatch,
  setMoveTabToNewWindowDispatch,
  setOpenDocsDispatch,
  setOpenExportPreviewDispatch,
  setOpenExportPreviewForFileDispatch,
  setOpenFileDispatch,
  setOpenNotePathDispatch,
  setOpenNotePathPinnedDispatch,
  setReadImageDispatch,
  setReloadDispatch,
  setRefreshWorkspacesDispatch,
  setRemoveSyncedWorkspaceDispatch,
  setRenameEntryDispatch,
  setRenameTabDispatch,
  setRunExportFromPreviewDispatch,
  setSaveAsDispatch,
  setSaveDispatch,
  setSavePastedFileDispatch,
  setSavePastedImageDispatch,
} from './facade';
import { createExplorerOps } from './explorer-ops';
import { createExport } from './export';
import { createFlushRestore } from './flush-restore';
import { createImportImages } from './import-images';
import { createOpenSave } from './open-save';
import { createWindows } from './windows';
import { createWorkspaces } from './workspaces';

export {
  addCloudWorkspace,
  addWorkspace,
  appendImagesToMd,
  checkImportStatus,
  closeAllTabs,
  closeTab,
  createNewFileIn,
  createNewFolderIn,
  deleteExplorerEntry,
  buildExportPreviewHtml,
  enrichCopiedText,
  getCursor,
  getDefaultWorkspacePath,
  importDocumentInto,
  importFilesInto,
  insertFileLink,
  isReadOnlyPath,
  keepMineTab,
  listNoteFiles,
  loadImageDataUrl,
  moveExplorerEntryInto,
  moveTabToNewWindow,
  noteCursor,
  openDocs,
  openExportPreview,
  openExportPreviewForFile,
  openFile,
  openNotePath,
  openNotePathAtLine,
  openNotePathPinned,
  pathKey,
  refreshWorkspaces,
  reloadTab,
  removeWorkspace,
  renameExplorerEntry,
  renameTab,
  requestChangeNotesDir,
  runExportFromPreview,
  saveActiveTab,
  saveActiveTabAs,
  savePastedFileInto,
  savePastedImageForTab,
  setWorkspaceColor,
  takePendingReveal,
} from './facade';
export type {
  ConfirmDialog,
  ExplorerEntry,
  ImageRef,
  OpenFilesDialog,
  PastedFile,
  PickDirectoryDialog,
  PickFileDialog,
  SaveDiscardCancelDialog,
  SaveFileDialog,
} from './facade';
export type { SessionController, SessionControllerDeps } from './context';

export function createSessionController(deps: SessionControllerDeps): SessionController {
  // Route all fs I/O through the active storage provider (local FS today; a
  // future cloud drive swaps in via setProvider). Tests still inject deps.ipc.
  const ipc = deps.ipc ?? currentProvider();
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
  const { sessionDir } = deps.paths;
  const manifestPath = joinPath(sessionDir, deps.manifestName ?? 'session.json');

  const io: FlushIo = {
    atomicWriteText: (path, text) => ipc.atomicWriteText(path, text),
    renamePath: (from, to) => ipc.renamePath(from, to),
    deletePath: (path) => ipc.deletePath(path),
  };

  const ctx: SessionCtx = {
    deps,
    ipc,
    confirm,
    openDialog,
    saveDialog,
    saveDiscardCancel,
    pickDirectory,
    pickFile,
    now,
    // Mutable: the M6 notes-dir change flow repoints it live; every flush reads
    // the current value through the ctx ("next flush writes
    // there"). sessionDir is fixed (never user-configurable).
    notesDir: deps.paths.notesDir,
    sessionDir,
    isMain: deps.isMain ?? true,
    manifestPath,
    io,
    existingNoteFiles: [],
    openingPaths: new Set<string>(),
    pinOnOpen: new Set<string>(),
    renameFailures: new Map<string, number>(),

    async refreshNoteListing(): Promise<void> {
      try {
        const notes = await ipc.listNotes(ctx.notesDir);
        ctx.existingNoteFiles = notes.map((n) => baseName(n.path));
      } catch {
        // Missing/unreadable notes dir → keep the last good cache; the next
        // successful flush recreates the dir and re-lists.
      }
    },

    /** First free `base.ext`, `base-2.ext`, … inside `dir` (case handled by FS). */
    async uniquePathIn(dir: string, base: string, ext: string): Promise<string> {
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
    },

    /** Shared refusal for writes aimed at a read-only workspace (the docs). */
    refuseReadOnly(path: string): boolean {
      if (isReadOnlyPath(path)) {
        uiStore.getState().showNotice('The documentation is read-only.');
        return true;
      }
      return false;
    },

    /** The workspace root containing `path` (longest matching root), or its own
     *  directory when it lies outside every known workspace. */
    workspaceRootFor(path: string): string {
      const roots = [
        ctx.notesDir,
        ...settingsStore.getState().settings.workspaces.map((w) => w.path),
      ];
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
    },

    /** Finds an open tab (file OR note) that already owns the path (by key). */
    tabOwning(key: string) {
      return tabsStore
        .getState()
        .tabs.find(
          (t) =>
            (t.filePath && pathKey(t.filePath) === key) ||
            (t.notePath && pathKey(t.notePath) === key),
        );
    },

    // Late-wired below, in factory order — see each factory's doc.
    flusher: null as unknown as DebouncedFlusher,
    checkAllFileConflicts: async () => {},
    importDocumentBytes: async () => {},
  };

  const flushRestore = createFlushRestore(ctx);
  ctx.flusher = flushRestore.flusher;
  const openSave = createOpenSave(ctx, flushRestore.saveFileTab);
  ctx.checkAllFileConflicts = openSave.checkAllFileConflicts;
  const workspaces = createWorkspaces(ctx, openSave.openPaths);
  const importImages = createImportImages(ctx, openSave.openPaths);
  ctx.importDocumentBytes = importImages.importDocumentBytes;
  const explorerOps = createExplorerOps(ctx, openSave.openPaths, openSave.renameFileTab);
  const windows = createWindows(ctx, flushRestore.saveFileTab, flushRestore.readNoteTabs);
  const exporter = createExport(ctx);

  setInteractiveCloser((id) => void windows.closeTabInteractive(id));
  setCloseAllTabsDispatch(() => void windows.closeAllTabsInteractive());
  if (deps.spawnTabWindow) {
    setMoveTabToNewWindowDispatch((id, pos) => void windows.moveTabOut(id, pos));
  }
  setOpenFileDispatch(() => void openSave.openFileDialog());
  setOpenExportPreviewDispatch(() => exporter.openExportPreview());
  setOpenExportPreviewForFileDispatch((path) => void exporter.openExportPreviewForFile(path));
  setRunExportFromPreviewDispatch(exporter.runExportFromPreview);
  setBuildExportPreviewHtmlDispatch(exporter.buildPreviewHtml);
  setSaveDispatch(() => void openSave.saveActive());
  setSaveAsDispatch(() => void openSave.saveAsActive());
  setReloadDispatch((id) => void openSave.reloadFromDisk(id));
  setKeepMineDispatch((id) => void openSave.keepMine(id));
  setChangeNotesDirDispatch(() => void workspaces.changeNotesDir());
  setListNotesDispatch(async (dir?: string) => {
    const entries = await ipc.listDir(dir ?? ctx.notesDir);
    return (
      entries
        // Hide voice-comment sidecar files (`*.comments.md`) from the explorer —
        // they're managed alongside their note, not opened directly.
        .filter((e) => e.isDir || !isCommentsPath(e.path))
        .map((e) => ({
          path: e.path,
          name: baseName(e.path),
          isDir: e.isDir,
          mtimeMs: e.mtimeMs,
        }))
    );
  });
  setReadImageDispatch(
    async (path: string) => `data:${imageMimeType(path)};base64,${await ipc.readFileBase64(path)}`,
  );
  setDefaultWorkspaceDispatch(() => ctx.notesDir);
  setAddWorkspaceDispatch(() => void workspaces.addWorkspaceFromDialog());
  setAddCloudWorkspaceDispatch(() => void workspaces.addCloudWorkspaceFromDialog());
  setRemoveSyncedWorkspaceDispatch((path) => void workspaces.removeSyncedWorkspace(path));
  setOpenDocsDispatch((page) => void workspaces.openDocsWorkspace(page));
  setImportFilesDispatch(importImages.importFiles);
  setImportDocumentDispatch(importImages.importDocument);
  setImportStatusDispatch(importImages.importStatusFor);
  setAppendImagesDispatch(importImages.appendImagesToMarkdown);
  setSavePastedImageDispatch(importImages.savePastedImage);
  setSavePastedFileDispatch(importImages.savePastedFile);
  setCreateNewFileDispatch(explorerOps.createNewFile);
  setCreateNewFolderDispatch(explorerOps.createNewFolder);
  setRenameEntryDispatch(explorerOps.renameEntry);
  setMoveEntryDispatch(explorerOps.moveEntry);
  setDeleteEntryDispatch(explorerOps.deleteEntry);
  setRefreshWorkspacesDispatch(async (dirs) => {
    // Best-effort: refresh every dir in parallel; a backend that can't refresh
    // (local FS) or one dir that fails must not block the others or the re-list.
    await Promise.all(dirs.map((dir) => Promise.resolve(ipc.refresh?.(dir)).catch(() => {})));
  });
  setRenameTabDispatch((id, newName) => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (
      tab &&
      (tab.kind === 'file' || tab.kind === 'image' || tab.kind === 'import') &&
      tab.filePath
    ) {
      void openSave.renameFileTab(id, newName);
    } else {
      // Note tab: set the title; the flush renames the note file to the new
      // slug. The tab label (a slug of the title) updates immediately.
      tabsStore.getState().renameTab(id, newName);
    }
  });
  setInsertFileLinkDispatch((opts) => void openSave.insertLinkFromDialog(opts));
  setOpenNotePathDispatch((path) => {
    // Never open a second editor over a file some tab already owns (would let
    // two tabs write the same path) — focus the existing one instead. New
    // files reuse the tested file-tab open path. Preview-tab behavior is opt-in
    // via settings; openPaths handles the reuse/replace of the preview slot.
    const existing = ctx.tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      return;
    }
    void openSave.openPaths([path], { preview: settingsStore.getState().settings.previewTabs });
  });
  setOpenNotePathPinnedDispatch((path) => {
    // Explorer double-click: open (or promote) the file as a PERMANENT tab.
    const existing = ctx.tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
      tabsStore.getState().promoteTab(existing.id);
      return;
    }
    void openSave.openPaths([path]);
  });

  return {
    restore: flushRestore.restore,
    request: () => flushRestore.flusher.request(),
    flushNow: () => flushRestore.flusher.flushNow(),
    dispose: () => flushRestore.flusher.dispose(),
    closeTabInteractive: windows.closeTabInteractive,
    closeAllTabsInteractive: windows.closeAllTabsInteractive,
    openFileDialog: openSave.openFileDialog,
    openIncoming: openSave.copyInExternal,
    openPaths: openSave.openPaths,
    saveActive: openSave.saveActive,
    saveAsActive: openSave.saveAsActive,
    checkConflict: openSave.checkConflict,
    checkAllFileConflicts: openSave.checkAllFileConflicts,
    reloadFromDisk: openSave.reloadFromDisk,
    keepMine: openSave.keepMine,
    changeNotesDir: workspaces.changeNotesDir,
    moveTabToNewWindow: windows.moveTabOut,
    adoptTabs: windows.adoptPersistedTabs,
    exportTabsForHandoff: windows.exportTabsForHandoff,
    discardManifest: () => ipc.deletePath(manifestPath),
    bequeathTabsToMain: windows.bequeathTabsToMain,
  };
}
