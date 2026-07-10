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
import { sanitizeFileBaseName, slugifyTitle, stripExtension } from '../core/title';
import { planNoteMoves } from '../core/notes-move';
import { getSourceAdapter } from './editor-registry';
import type { CursorPos } from '../core/types';
import { ipc as realIpc, type Ipc } from '../ipc/commands';
import type { SessionPaths } from '../ipc/paths';
import { setFlushRequester } from './stores/flush-signal';
import { settingsStore } from './stores/settings';
import { tabsStore, type RestoredTabInit } from './stores/tabs';
import { uiStore } from './stores/ui';

/** The slice of `ipc` the controller uses — narrowed so tests fake less. */
type SessionIpc = Pick<
  Ipc,
  'atomicWriteText' | 'renamePath' | 'deletePath' | 'listNotes' | 'readTextFile' | 'statPath'
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
  /** Ctrl+O: native open dialog, then {@link openPaths}. */
  openFileDialog(): Promise<void>;
  /** Open each path as a file tab; focuses the existing tab if already open. */
  openPaths(paths: string[]): Promise<void>;
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

/** One entry in the file-explorer listing (a markdown file in the notes dir). */
export interface ExplorerEntry {
  path: string;
  name: string;
  mtimeMs: number;
}

let listNotesDispatch: () => Promise<ExplorerEntry[]> = async () => [];
let openNotePathDispatch: (path: string) => void = () => {};
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
/** FileExplorer → controller: current markdown files in the notes directory. */
export function listNoteFiles(): Promise<ExplorerEntry[]> {
  return listNotesDispatch();
}
/** FileExplorer → controller: open a note file (activates it if already open). */
export function openNotePath(path: string): void {
  openNotePathDispatch(path);
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
 * to it into the active tab's source editor. The path is relative to the
 * current document by default; `absolute` (the ribbon's Alt-click) forces an
 * absolute path, as does an unsaved document with no directory to be relative to.
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
  // the current value through this closure (plan.md M6 — "next flush writes
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
   * of the close-tab prompt). Re-stats first — "before every save" (plan.md
   * M3) — so a real external change is never silently clobbered: the save is
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
    if (tab.kind === 'note') {
      // Save on a note tab behaves as Save As (plan.md M3).
      await saveAsActive();
      return;
    }
    await saveFileTab(tab.id);
  }

  async function saveAsActive(): Promise<void> {
    const tab = tabsStore.getState().activeTab();
    if (!tab) {
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

  async function openPaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      const lower = pathKey(path);
      // Already open (as a file OR a note tab) → just focus it.
      const existing = tabOwning(lower);
      if (existing) {
        tabsStore.getState().activateTab(existing.id);
        continue;
      }
      // A concurrent request is already opening this exact path — a rapid
      // double-click in the file browser fires two opens before the first has
      // created its tab, so the pre-await check above misses. Let the in-flight
      // open win rather than reading the file and creating a second tab.
      if (openingPaths.has(lower)) {
        continue;
      }
      openingPaths.add(lower);
      try {
        const { text, mtimeMs } = await ipc.readTextFile(path);
        // Re-check after the await: a tab for this path may have appeared while
        // we were reading (e.g. a note tab the flusher just assigned a path).
        const now = tabOwning(lower);
        if (now) {
          tabsStore.getState().activateTab(now.id);
        } else {
          const id = tabsStore
            .getState()
            .openFileTab({ filePath: path, text, savedMtimeMs: mtimeMs });
          tabsStore.getState().activateTab(id);
        }
      } catch (error) {
        uiStore.getState().showNotice(`Could not open "${baseName(path)}".`);
        deps.onError?.(error);
      } finally {
        openingPaths.delete(lower);
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
    if (!tab || tab.kind !== 'file' || !tab.filePath) {
      return;
    }
    const oldPath = tab.filePath;
    const safeBase = sanitizeFileBaseName(newName);
    if (!safeBase) {
      uiStore.getState().showNotice('That name can’t be used for a file.');
      return;
    }
    const newPath = joinPath(dirName(oldPath), `${safeBase}${extName(oldPath)}`);
    if (pathKey(newPath) === pathKey(oldPath)) {
      return; // no change (or case-only on a case-insensitive FS)
    }
    try {
      const existing = await ipc.statPath(newPath);
      if (existing.exists) {
        uiStore
          .getState()
          .showNotice(`A file named "${safeBase}${extName(oldPath)}" already exists.`);
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
   * of the active tab's source editor. Prefers a path relative to the current
   * document; falls back to (or is forced to, via `absolute`) an absolute path
   * when the document is unsaved or the target lives on another drive/root.
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

  interactiveCloser = (id) => void closeTabInteractive(id);
  openFileDispatch = () => void openFileDialog();
  saveDispatch = () => void saveActive();
  saveAsDispatch = () => void saveAsActive();
  reloadDispatch = (id) => void reloadFromDisk(id);
  keepMineDispatch = (id) => void keepMine(id);
  changeNotesDirDispatch = () => void changeNotesDir();
  listNotesDispatch = async () => {
    const notes = await ipc.listNotes(notesDir);
    return notes.map((n) => ({ path: n.path, name: baseName(n.path), mtimeMs: n.mtimeMs }));
  };
  renameTabDispatch = (id, newName) => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (tab && tab.kind === 'file' && tab.filePath) {
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
    // files reuse the tested file-tab open path.
    const existing = tabOwning(pathKey(path));
    if (existing) {
      tabsStore.getState().activateTab(existing.id);
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
