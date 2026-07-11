/**
 * Tabs store — the app's central model of open documents.
 *
 * A vanilla Zustand store (src/README "Store conventions"): non-React code
 * (the session flusher, the keyboard dispatcher) subscribes to `tabsStore`
 * directly; components use `useTabsStore` with narrow selectors.
 *
 * Each tab owns two non-serializable objects that must never leak into
 * anything persisted (planFlush receives a serializable view in M2):
 *   - `model`    — the canonical DocModel (invariant I1).
 *   - `modeSync` — the mode-switch state machine, registered by EditorHost
 *     once the editor is mounted (I7: attached exactly once per tab).
 *
 * Derived, cached-in-entry fields kept in sync with the model:
 *   - `title`     = customTitle ?? deriveTitle(text)  (recomputed on change)
 *   - `wordCount` = words in the current text          (for the status bar)
 * Both update inside a single model subscription so a keystroke re-renders
 * the TabBar exactly once.
 *
 * Session persistence (M2) lives at the edges of this store:
 *   - Every user-driven change calls `requestFlush()` (see flush-signal.ts).
 *     Caret moves are the exception — those persist opportunistically at the
 *     next flush, captured by the session controller, not routed through here.
 *   - Discarding a note tab records its file in `closedNotePaths`; closing a
 *     file tab records its id in `obsoleteBufferTabIds`. The next flush deletes
 *     them and calls `applyFlushResult` to consume the tombstones.
 *   - `restoreSession` rebuilds the whole tab set from a parsed manifest at
 *     boot; the initial auto-created tab is replaced wholesale.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { nanoid } from 'nanoid';
import { createDocModel, type DocModel } from '../../core/doc-model';
import { deriveTitle, slugifyTitle, stripExtension } from '../../core/title';
import { baseName } from '../../core/session/plan-flush';
import type { ModeSync } from '../../core/mode-sync';
import type { EditorMode, TabKind, TabState } from '../../core/types';
import { settingsStore } from './settings';
import { requestFlush } from './flush-signal';

/**
 * A tab entry = the serializable {@link TabState} plus the live objects and
 * derived display fields. Only the TabState-shaped subset is ever persisted.
 */
export interface TabEntry extends TabState {
  model: DocModel;
  /** Null until EditorHost mounts and calls `registerModeSync`. */
  modeSync: ModeSync | null;
  /** Displayed tab label: customTitle ?? deriveTitle(text). */
  title: string;
  wordCount: number;
  /** Character count of the current text (status bar); kept live with wordCount. */
  charCount: number;
  /** kind='file' only: model.isDirty('file'), cached for the TabBar dot (M3). */
  dirty: boolean;
  /** kind='file' only: the file changed on disk since savedMtimeMs (M3 ConflictBanner). */
  conflict: boolean;
  /**
   * VSCode-style preview tab: opened by a single explorer click, shown in
   * italic, and reused (replaced) when another file is previewed. Cleared —
   * promoted to a permanent tab — on the first user edit, an explorer
   * double-click, or "Keep open". Never persisted (restore yields permanent
   * tabs); a session-only display flag like `title`/`dirty`.
   */
  preview: boolean;
  /**
   * The file lives in a read-only workspace (the bundled docs): the mode is
   * pinned to 'read' and save/rename are refused. Not persisted — recomputed
   * from the file's path against settings at open/restore time (session.ts).
   */
  readOnly: boolean;
}

/** Everything needed to rebuild one tab at restore time (content already read). */
export interface RestoredTabInit {
  id: string;
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  mode: EditorMode;
  savedMtimeMs: number | null;
  text: string;
  /**
   * kind='file' restored from its session buffer (unsaved edits survived a
   * kill): the model's clean-by-construction snapshot would otherwise hide
   * this, so the caller (session.ts) says so explicitly. Default false.
   */
  dirty?: boolean;
  /** The file lies in a read-only workspace (see TabEntry.readOnly). Default false. */
  readOnly?: boolean;
}

/** What the session controller applies back after a flush completes. */
export interface FlushResultPatch {
  /** New note tabs → the path this flush assigned them. */
  assignedNotePaths: Record<string, string>;
  /** Successful renames as { [oldPath]: newPath }. */
  renamedPaths: Record<string, string>;
  /** Closed-note tombstones this flush handled (removed from the store). */
  consumedClosedNotePaths: string[];
  /** Obsolete-buffer tombstones this flush handled. */
  consumedObsoleteBufferTabIds: string[];
}

export interface TabsState {
  tabs: TabEntry[];
  activeTabId: string;
  /** The tab whose label is being edited inline, or null. */
  renamingTabId: string | null;
  /** Note files discarded since the last flush; the flusher deletes them. */
  closedNotePaths: string[];
  /** File tabs closed since the last flush; their session buffers are stale. */
  obsoleteBufferTabIds: string[];
  /**
   * The mode the user most recently switched to, seeded from
   * settings.defaultMode. Newly opened file tabs adopt it instead of always
   * reverting to the default — so reading in 'read' mode and flipping through
   * files keeps each new preview in read mode. Session-only (not persisted).
   */
  lastFileMode: EditorMode;

  newTab: () => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  activateAdjacent: (direction: 1 | -1) => void;
  reorderTab: (id: string, toIndex: number) => void;
  /** Commit an inline rename. Empty/whitespace reverts to auto-derived title. */
  renameTab: (id: string, title: string) => void;
  beginRename: (id: string) => void;
  cancelRename: () => void;
  setMode: (id: string, mode: EditorMode) => void;
  registerModeSync: (id: string, sync: ModeSync) => void;
  activeTab: () => TabEntry | undefined;
  /**
   * Remove a tab WITHOUT the close-tab tombstones — its note file and session
   * buffer stay on disk because another window is adopting them (tab tear-off,
   * M8). Behaves like closeTab otherwise: neighbor activation, and the last
   * tab leaves one fresh Untitled.
   */
  detachTab: (id: string) => void;
  /**
   * Append already-read tabs from another window (tear-off adoption / a
   * closing secondary window handing its tabs back). Ids are preserved so
   * session buffers and caret bookkeeping keyed by id line up; the last
   * adopted tab is activated.
   */
  adoptTabs: (tabs: RestoredTabInit[]) => void;
  /** Replace all tabs from a restored session (boot only). */
  restoreSession: (payload: { tabs: RestoredTabInit[]; activeTabId: string | null }) => void;
  /** Apply the outcome of a completed flush. Never re-requests a flush. */
  applyFlushResult: (patch: FlushResultPatch) => void;

  /**
   * M3 — Ctrl+O: append a new file tab from already-read disk content. Returns
   * its id. When `preview` is set, it opens as a preview tab (reusing/replacing
   * any current preview tab) instead of appending a persistent one.
   */
  openFileTab: (input: {
    filePath: string;
    text: string;
    savedMtimeMs: number;
    preview?: boolean;
    readOnly?: boolean;
  }) => string;
  /** Image viewer tab — read-only, never flushed beyond the manifest. Returns its id. */
  openImageTab: (input: {
    filePath: string;
    savedMtimeMs: number | null;
    preview?: boolean;
    readOnly?: boolean;
  }) => string;
  /** Promote a preview tab to a permanent one (idempotent; no-op otherwise). */
  promoteTab: (id: string) => void;
  /**
   * M3 — Save (existing file tab, same path): the model text was just written
   * to `filePath` at `mtimeMs`. Clears the dirty dot and any conflict banner,
   * and marks any leftover session buffer stale (obsoleteBufferTabIds).
   */
  markSaved: (id: string, mtimeMs: number) => void;
  /**
   * M3 — Save As: write succeeded at a new `filePath`. Converts a note tab to
   * a file tab (queuing its old note file for deletion — "the note graduated")
   * or simply retargets an existing file tab to the new path.
   */
  saveToPath: (id: string, input: { filePath: string; mtimeMs: number }) => void;
  /**
   * Rename-on-disk: a file tab's file was just renamed to `filePath` at
   * `mtimeMs`. Only retargets the path + mtime baseline — content and dirty
   * state are untouched (the rename moved the bytes, it didn't save them).
   */
  retargetFilePath: (id: string, input: { filePath: string; mtimeMs: number }) => void;
  /** M3 — external-change detection: show/hide the per-tab ConflictBanner. */
  setConflict: (id: string, conflict: boolean) => void;
  /**
   * M3 — "Keep mine": dismiss the conflict banner and adopt `mtimeMs` as the
   * new baseline so the next save proceeds instead of re-flagging a conflict.
   * Deliberately does NOT touch the model or the dirty flag.
   */
  acknowledgeConflict: (id: string, mtimeMs: number) => void;
}

/**
 * The name shown on a tab. It mirrors the file the tab maps to, minus the
 * extension (the user's rule: "tab name and .md file name should match"):
 *   - file tab  → its filename without extension, casing/spaces preserved
 *     ("Budget Q3.md" → "Budget Q3").
 *   - note tab  → the slug that is (or will be) its note filename
 *     ("My Report" → "my-report"), so the label matches the on-disk file
 *     without waiting for a flush. A brand-new empty note reads "Untitled".
 */
export function tabDisplayTitle(tab: {
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  title: string;
  charCount: number;
}): string {
  if ((tab.kind === 'file' || tab.kind === 'image') && tab.filePath) {
    return stripExtension(baseName(tab.filePath));
  }
  if (!tab.customTitle && tab.charCount === 0) {
    return 'Untitled';
  }
  return slugifyTitle(tab.title);
}

/** Word count = whitespace-delimited tokens; empty text is zero. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export const tabsStore = createStore<TabsState>()((set, get) => {
  /**
   * Build a tab entry and wire its title/word-count subscription. With no
   * argument it is a fresh empty note; with `init` it restores one from the
   * manifest (id preserved so cursor bookkeeping keyed by id lines up). The
   * subscription closes over `id` (not the entry) so it survives the immutable
   * array replacements every action performs.
   */
  function makeTab(init?: RestoredTabInit): TabEntry {
    const id = init?.id ?? nanoid();
    const text = init?.text ?? '';
    const model = createDocModel(text);
    const customTitle = init?.customTitle ?? null;
    const entry: TabEntry = {
      id,
      kind: init?.kind ?? ('note' satisfies TabKind),
      notePath: init?.notePath ?? null,
      filePath: init?.filePath ?? null,
      customTitle,
      // A read-only tab is pinned to read mode regardless of what the
      // manifest recorded (the flag itself is recomputed by the caller).
      mode: init?.readOnly ? 'read' : (init?.mode ?? settingsStore.getState().settings.defaultMode),
      savedMtimeMs: init?.savedMtimeMs ?? null,
      model,
      modeSync: null,
      title: customTitle ?? deriveTitle(text),
      wordCount: countWords(text),
      charCount: text.length,
      dirty: init?.dirty ?? false,
      conflict: false,
      preview: false,
      readOnly: init?.readOnly ?? false,
    };

    model.subscribe((change) => {
      const state = get();
      const tab = state.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      // Every text change must survive a crash — request a flush before the
      // title/word-count short-circuit (an intra-line edit changes neither).
      requestFlush();
      const title = tab.customTitle ?? deriveTitle(change.text);
      const wordCount = countWords(change.text);
      const charCount = change.text.length;
      // file tabs only: the TabBar dirty dot. Note tabs have no save concept.
      const dirty = tab.kind === 'file' && tab.model.isDirty('file');
      // A genuine user edit (from an editor, not a programmatic/file-load push)
      // promotes a preview tab to a permanent one — VSCode behavior.
      const preview =
        tab.preview && (change.source === 'cm6' || change.source === 'milkdown')
          ? false
          : tab.preview;
      if (
        title === tab.title &&
        wordCount === tab.wordCount &&
        charCount === tab.charCount &&
        dirty === tab.dirty &&
        preview === tab.preview
      ) {
        return;
      }
      set({
        tabs: state.tabs.map((t) =>
          t.id === id ? { ...t, title, wordCount, charCount, dirty, preview } : t,
        ),
      });
    });

    return entry;
  }

  /**
   * Insert a freshly built tab and activate it. A `preview` tab REPLACES the
   * current preview tab (if any) in place — reusing the single preview slot and
   * its position, VSCode-style — recording the displaced tab's tombstones the
   * same way `closeTab` does (a note's file is discarded, a file's buffer goes
   * stale). Any other open is a plain append.
   */
  function addTab(tab: TabEntry, preview: boolean): void {
    set((s) => {
      const idx = preview ? s.tabs.findIndex((t) => t.preview) : -1;
      if (idx < 0) {
        return { tabs: [...s.tabs, tab], activeTabId: tab.id };
      }
      const displaced = s.tabs[idx]!;
      const tabs = [...s.tabs];
      tabs[idx] = tab;
      return {
        tabs,
        activeTabId: tab.id,
        closedNotePaths:
          displaced.kind === 'note' && displaced.notePath
            ? [...s.closedNotePaths, displaced.notePath]
            : s.closedNotePaths,
        obsoleteBufferTabIds:
          displaced.kind === 'file'
            ? [...s.obsoleteBufferTabIds, displaced.id]
            : s.obsoleteBufferTabIds,
      };
    });
  }

  const first = makeTab();

  return {
    tabs: [first],
    activeTabId: first.id,
    renamingTabId: null,
    closedNotePaths: [],
    obsoleteBufferTabIds: [],
    lastFileMode: settingsStore.getState().settings.defaultMode,

    newTab() {
      const tab = makeTab();
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      requestFlush();
    },

    closeTab(id) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) {
        return;
      }
      const closing = s.tabs[idx]!;
      // Deliberate Notepad semantics: closing a note
      // tab DISCARDS its file; closing a file tab makes its session buffer
      // stale. Both are recorded here and swept by the next flush.
      const closedNotePaths =
        closing.kind === 'note' && closing.notePath
          ? [...s.closedNotePaths, closing.notePath]
          : s.closedNotePaths;
      const obsoleteBufferTabIds =
        closing.kind === 'file' ? [...s.obsoleteBufferTabIds, closing.id] : s.obsoleteBufferTabIds;

      const remaining = s.tabs.filter((t) => t.id !== id);
      // Notepad behavior: closing the last tab leaves one fresh Untitled.
      if (remaining.length === 0) {
        const fresh = makeTab();
        set({
          tabs: [fresh],
          activeTabId: fresh.id,
          renamingTabId: null,
          closedNotePaths,
          obsoleteBufferTabIds,
        });
        requestFlush();
        return;
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        // Prefer the right neighbor, else the left (browser-tab behavior).
        // After removal the old right neighbor sits at `idx` in `remaining`;
        // clamp so closing the last tab falls back to the left neighbor.
        activeTabId = remaining[Math.min(idx, remaining.length - 1)]!.id;
      }
      set({
        tabs: remaining,
        activeTabId,
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
        closedNotePaths,
        obsoleteBufferTabIds,
      });
      requestFlush();
    },

    detachTab(id) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) {
        return;
      }
      // No closedNotePaths / obsoleteBufferTabIds entries: the tab's files are
      // being handed to another window, not discarded.
      const remaining = s.tabs.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        const fresh = makeTab();
        set({ tabs: [fresh], activeTabId: fresh.id, renamingTabId: null });
        requestFlush();
        return;
      }
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        activeTabId = remaining[Math.min(idx, remaining.length - 1)]!.id;
      }
      set({
        tabs: remaining,
        activeTabId,
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
      });
      requestFlush();
    },

    adoptTabs(inits) {
      if (inits.length === 0) {
        return;
      }
      const entries = inits.map((t) => makeTab(t));
      set((s) => {
        // A pristine window (exactly one never-flushed empty Untitled) yields
        // its placeholder to the adopted tabs instead of keeping a stray note.
        const only = s.tabs.length === 1 ? s.tabs[0]! : null;
        const pristine =
          only !== null &&
          only.kind === 'note' &&
          only.notePath === null &&
          only.charCount === 0 &&
          !only.customTitle;
        return {
          tabs: [...(pristine ? [] : s.tabs), ...entries],
          activeTabId: entries[entries.length - 1]!.id,
        };
      });
      requestFlush();
    },

    activateTab(id) {
      const s = get();
      if (s.activeTabId === id || !s.tabs.some((t) => t.id === id)) {
        return;
      }
      set({ activeTabId: id });
      requestFlush();
    },

    activateAdjacent(direction) {
      const s = get();
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      if (idx < 0 || s.tabs.length < 2) {
        return;
      }
      const nextIdx = (idx + direction + s.tabs.length) % s.tabs.length;
      set({ activeTabId: s.tabs[nextIdx]!.id });
      requestFlush();
    },

    reorderTab(id, toIndex) {
      const s = get();
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from < 0) {
        return;
      }
      const arr = [...s.tabs];
      const [moved] = arr.splice(from, 1);
      if (!moved) {
        return;
      }
      const clamped = Math.max(0, Math.min(toIndex, arr.length));
      arr.splice(clamped, 0, moved);
      set({ tabs: arr });
      requestFlush();
    },

    renameTab(id, rawTitle) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      const trimmed = rawTitle.trim();
      const customTitle = trimmed.length > 0 ? trimmed : null;
      const title = customTitle ?? deriveTitle(tab.model.getText());
      set({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, customTitle, title } : t)),
        renamingTabId: s.renamingTabId === id ? null : s.renamingTabId,
      });
      requestFlush();
    },

    beginRename(id) {
      if (get().tabs.some((t) => t.id === id)) {
        set({ renamingTabId: id });
      }
    },

    cancelRename() {
      set({ renamingTabId: null });
    },

    setMode(id, mode) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      // Read-only tabs are pinned to read mode (the status bar shows a
      // "Read-only" badge instead of the mode segments).
      if (!tab || tab.mode === mode || tab.readOnly) {
        return;
      }
      // Remember this choice so the next file opened adopts it (see lastFileMode).
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, mode } : t)), lastFileMode: mode });
      void tab.modeSync?.setMode(mode);
      requestFlush();
    },

    registerModeSync(id, sync) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, modeSync: sync } : t)),
      }));
    },

    activeTab() {
      const s = get();
      return s.tabs.find((t) => t.id === s.activeTabId);
    },

    restoreSession({ tabs, activeTabId }) {
      const entries = tabs.length > 0 ? tabs.map((t) => makeTab(t)) : [makeTab()];
      const active =
        activeTabId && entries.some((e) => e.id === activeTabId) ? activeTabId : entries[0]!.id;
      // Continue flipping in whatever mode the restored active tab was in, so a
      // read-mode session stays read-mode across a restart. Read-only tabs are
      // pinned to 'read' regardless, so fall back to the default for those.
      const activeEntry = entries.find((e) => e.id === active)!;
      set({
        tabs: entries,
        activeTabId: active,
        renamingTabId: null,
        closedNotePaths: [],
        obsoleteBufferTabIds: [],
        lastFileMode: activeEntry.readOnly
          ? settingsStore.getState().settings.defaultMode
          : activeEntry.mode,
      });
    },

    applyFlushResult(patch) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          const assigned = patch.assignedNotePaths[t.id];
          const renamed = t.notePath !== null ? patch.renamedPaths[t.notePath] : undefined;
          const notePath = assigned ?? renamed;
          return notePath && notePath !== t.notePath ? { ...t, notePath } : t;
        }),
        closedNotePaths: s.closedNotePaths.filter(
          (p) => !patch.consumedClosedNotePaths.includes(p),
        ),
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.filter(
          (id) => !patch.consumedObsoleteBufferTabIds.includes(id),
        ),
      }));
    },

    openFileTab({ filePath, text, savedMtimeMs, preview = false, readOnly = false }) {
      // Content already came straight from disk (session.ts's openPaths) — the
      // model's clean-by-construction snapshot is exactly right here.
      const tab: TabEntry = {
        ...makeTab({
          id: nanoid(),
          kind: 'file',
          notePath: null,
          filePath,
          customTitle: null,
          // Adopt the last mode the user switched to, not the static default,
          // so flipping through files preserves e.g. read mode.
          mode: get().lastFileMode,
          savedMtimeMs,
          text,
          readOnly,
        }),
        preview,
      };
      addTab(tab, preview);
      requestFlush();
      return tab.id;
    },

    openImageTab({ filePath, savedMtimeMs, preview = false, readOnly = false }) {
      const tab: TabEntry = {
        ...makeTab({
          id: nanoid(),
          kind: 'image',
          notePath: null,
          filePath,
          customTitle: null,
          // Semantically closest mode (read-only viewer); no editor is created.
          mode: 'read',
          savedMtimeMs,
          text: '',
          readOnly,
        }),
        preview,
      };
      addTab(tab, preview);
      requestFlush();
      return tab.id;
    },

    promoteTab(id) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || !tab.preview) {
        return;
      }
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, preview: false } : t)) });
    },

    markSaved(id, mtimeMs) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      // The write (or reload-read) just made file and session content agree.
      tab.model.markPersisted('file');
      tab.model.markPersisted('session');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, dirty: false, conflict: false } : t,
        ),
        // Any session buffer from prior unsaved edits is now stale; delete_path
        // is idempotent so this is harmless when no buffer ever existed.
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.includes(id)
          ? s.obsoleteBufferTabIds
          : [...s.obsoleteBufferTabIds, id],
      });
      requestFlush();
    },

    saveToPath(id, { filePath, mtimeMs }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) {
        return;
      }
      // Save-As on a note tab converts it to a file tab; the note file is
      // queued for deletion the same way a closed note tab's file is (the
      // note graduated — one source of truth per document).
      const closedNotePaths =
        tab.kind === 'note' && tab.notePath
          ? [...s.closedNotePaths, tab.notePath]
          : s.closedNotePaths;
      tab.model.markPersisted('file');
      tab.model.markPersisted('session');
      set({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                kind: 'file',
                notePath: null,
                filePath,
                savedMtimeMs: mtimeMs,
                dirty: false,
                conflict: false,
              }
            : t,
        ),
        closedNotePaths,
        obsoleteBufferTabIds: s.obsoleteBufferTabIds.includes(id)
          ? s.obsoleteBufferTabIds
          : [...s.obsoleteBufferTabIds, id],
      });
      requestFlush();
    },

    retargetFilePath(id, { filePath, mtimeMs }) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || (tab.kind !== 'file' && tab.kind !== 'image')) {
        return;
      }
      set({
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, filePath, savedMtimeMs: mtimeMs } : t)),
      });
      requestFlush();
    },

    setConflict(id, conflict) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.conflict === conflict) {
        return;
      }
      set({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, conflict } : t)) });
    },

    acknowledgeConflict(id, mtimeMs) {
      const s = get();
      if (!s.tabs.some((t) => t.id === id)) {
        return;
      }
      // Deliberately does not touch the model or the dirty flag: "keep mine"
      // means the local edits stay unsaved until the user explicitly saves.
      set({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, savedMtimeMs: mtimeMs, conflict: false } : t,
        ),
      });
      requestFlush();
    },
  };
});

export const useTabsStore = <T>(selector: (s: TabsState) => T): T => useStore(tabsStore, selector);
