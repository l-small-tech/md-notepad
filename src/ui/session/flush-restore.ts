/**
 * Flush + restore — the crash-safety core of the session controller: view
 * assembly → planFlush → executeFlushPlan on the debounced cadence, manifest
 * restore (or self-heal) at boot, and the Ctrl+S file-tab save the flush's
 * live-save pass reuses. See index.ts for the flush lifecycle overview.
 */

import { createDebouncedFlusher, type DebouncedFlusher } from '../../core/session/debounce';
import {
  baseName,
  bufferPathFor,
  executeFlushPlan,
  joinPath,
  parseManifest,
  planFlush,
  type AppSessionView,
  type PersistedTab,
  type SessionManifest,
} from '../../core/session/plan-flush';
import { nanoid } from 'nanoid';
import { isCommentsPath } from '../../core/comments';
import { setFlushRequester } from '../stores/flush-signal';
import { settingsStore } from '../stores/settings';
import { tabsStore, type RestoredTabInit } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { cursorByTab, pathKey, persistedToInit } from './facade';

export function createFlushRestore(ctx: SessionCtx) {
  async function flushSession(): Promise<void> {
    // Multi-window: another window's flusher may have created note files since
    // our last flush; re-list so planFlush's clobber guard sees them. (Cheap —
    // one readdir — and it also keeps the single-window cache honest.)
    await ctx.refreshNoteListing();

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

    const { tabs, groups, activeTabId, closedNotePaths, obsoleteBufferTabIds } =
      tabsStore.getState();

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
      [...ctx.renameFailures].filter(([, count]) => count >= 3).map(([from]) => from),
    );

    const view: AppSessionView = {
      notesDir: ctx.notesDir,
      sessionDir: ctx.sessionDir,
      manifestName: ctx.deps.manifestName,
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
        groupId: t.groupId,
      })),
      groups,
      existingNoteFiles: ctx.existingNoteFiles,
      closedNotePaths,
      obsoleteBufferPaths: obsoleteBufferTabIds.map((id) => bufferPathFor(ctx.sessionDir, id)),
      suppressedRenamePaths,
    };

    const plan = planFlush(view);
    const result = await executeFlushPlan(plan, ctx.io);

    // Sort renames into succeeded / failed and update the strike counters.
    const failed = new Set(result.renameFailures.map((r) => r.from));
    const renamedPaths: Record<string, string> = {};
    for (const rename of plan.noteRenames) {
      if (failed.has(rename.from)) {
        ctx.renameFailures.set(rename.from, (ctx.renameFailures.get(rename.from) ?? 0) + 1);
      } else {
        ctx.renameFailures.delete(rename.from);
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

    await ctx.refreshNoteListing();
  }

  const flusher: DebouncedFlusher = createDebouncedFlusher({
    idleMs: 1000,
    maxWaitMs: 5000,
    run: flushSession,
    onError: (error) => {
      console.error('[session] flush failed', error);
      uiStore.getState().showNotice('Could not save session — will retry.');
      ctx.deps.onError?.(error);
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
      if (pt.kind === 'image' || pt.kind === 'import') {
        // Image and import tabs hold no text; just confirm the file still exists.
        if (!pt.filePath) {
          continue;
        }
        try {
          const stat = await ctx.ipc.statPath(pt.filePath);
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
          const { text } = await ctx.ipc.readTextFile(pt.notePath);
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
            text = (await ctx.ipc.readTextFile(bufferPathFor(ctx.sessionDir, pt.id))).text;
            dirty = true;
          } catch {
            text = null;
          }
        }
        if (text === null && pt.filePath) {
          try {
            text = (await ctx.ipc.readTextFile(pt.filePath)).text;
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
        await ctx.ipc.renamePath(ctx.manifestPath, `${ctx.manifestPath}.bad-${ctx.now()}`);
      } catch {
        // Best effort; a failed quarantine must not block startup.
      }
    }
    let recent: RestoredTabInit[];
    try {
      const notes = (await ctx.ipc.listNotes(ctx.notesDir)).filter((n) => !isCommentsPath(n.path));
      const reads = await Promise.all(
        notes.slice(0, 20).map(async (n) => {
          try {
            const { text } = await ctx.ipc.readTextFile(n.path);
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
    const docsDir = ctx.deps.docsDir ?? null;
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
    const docsDir = ctx.deps.docsDir;
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
    await ctx.refreshNoteListing();

    // A tear-off window receives its manifest from the spawning window (via
    // deps) instead of reading it from disk; the flush at the end of restore
    // then persists it as this window's own manifest file.
    let raw: string | null = null;
    let manifest: SessionManifest | null = ctx.deps.initialManifest ?? null;
    if (manifest === null) {
      try {
        raw = (await ctx.ipc.readTextFile(ctx.manifestPath)).text;
      } catch {
        // NOT_FOUND (first launch) or unreadable — either way, no manifest.
        raw = null;
      }
      manifest = raw !== null ? parseManifest(raw) : null;
    }

    const staleDocsRoots = reconcileDocsWorkspaces();
    if (manifest !== null && staleDocsRoots.length > 0) {
      for (const t of manifest.tabs) {
        t.filePath = remapDocsPath(t.filePath, staleDocsRoots);
      }
    }

    if (manifest === null) {
      if (!ctx.isMain) {
        // A secondary window never reopens recent notes — that would duplicate
        // tabs the main window owns. It just starts fresh (one Untitled).
        tabsStore.getState().restoreSession({ tabs: [], activeTabId: null });
      } else {
        // A file that existed but wouldn't parse is corrupt → quarantine it.
        await selfHeal(raw !== null);
      }
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
      tabsStore.getState().restoreSession({ tabs, activeTabId, groups: manifest.groups ?? [] });
      if (missing.length > 0) {
        uiStore
          .getState()
          .showNotice(`${missing.length} file(s) could not be found — those tabs were skipped.`);
      }
      // File tab restore honors hasBuffer (above); this catches the OTHER
      // half — the on-disk file itself changing while the app was closed.
      await ctx.checkAllFileConflicts();
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
      const stat = await ctx.ipc.statPath(filePath);
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
      await ctx.ipc.atomicWriteText(filePath, tab.model.getText());
      const after = await ctx.ipc.statPath(filePath);
      tabsStore.getState().markSaved(id, after.mtimeMs ?? ctx.now());
      return true;
    } catch (error) {
      uiStore.getState().showNotice(`Could not save "${tab.title}".`);
      ctx.deps.onError?.(error);
      return false;
    }
  }

  return { flusher, restore, saveFileTab, readNoteTabs };
}
