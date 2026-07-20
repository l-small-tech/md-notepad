/**
 * Windows + interactive close — the confirming close flows and the M8
 * multi-window machinery: tab tear-off into a new OS window, adopting tabs
 * handed over by a closing window, the window-close handoff export, and the
 * last-window-standing manifest fold-back into main.
 */

import {
  joinPath,
  parseManifest,
  type PersistedTab,
  type SessionManifest,
} from '../../core/session/plan-flush';
import { tabsStore, type RestoredTabInit, type TabEntry } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { cursorByTab, pathKey } from './facade';

export function createWindows(
  ctx: SessionCtx,
  saveFileTab: (id: string) => Promise<boolean>,
  readNoteTabs: (
    persisted: PersistedTab[],
  ) => Promise<{ tabs: RestoredTabInit[]; missing: string[] }>,
) {
  async function closeTabInteractive(id: string): Promise<void> {
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    const text = tab.model.getText();
    if (tab.kind === 'note' && text.trim().length > 0) {
      const ok = await ctx.confirm(`Close "${tab.title}"? Its note will be deleted.`, 'Close note');
      if (!ok) {
        return;
      }
    } else if (tab.kind === 'file' && tab.model.isDirty('file')) {
      const choice = await ctx.saveDiscardCancel(
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

  /* ---- M8: multi-window tab tear-off ---------------------------------- */

  /** Serializable manifest entry for `tab`, exactly as a flush would write it.
   *  Only meaningful AFTER a flushNow(): the note file / session buffer it
   *  references must already exist on disk. */
  function persistedDescriptor(tab: TabEntry): PersistedTab {
    return {
      id: tab.id,
      kind: tab.kind,
      notePath: tab.notePath,
      filePath: tab.filePath,
      customTitle: tab.customTitle,
      mode: tab.mode,
      savedMtimeMs: tab.savedMtimeMs,
      hasBuffer: tab.kind === 'file' && tab.model.isDirty('file'),
      cursor: cursorByTab.get(tab.id) ?? null,
    };
  }

  /**
   * Adopt tabs handed over by another window (a tear-off landing here at boot
   * goes through restore() instead; this serves a closing secondary window
   * returning its tabs to main). Files some tab here already owns are skipped —
   * the one-owner-per-file invariant, applied across windows.
   */
  async function adoptPersistedTabs(persisted: PersistedTab[]): Promise<void> {
    const fresh = persisted.filter((pt) => {
      const path = pt.filePath ?? pt.notePath;
      return path === null || !ctx.tabOwning(pathKey(path));
    });
    if (fresh.length === 0) {
      return;
    }
    const { tabs, missing } = await readNoteTabs(fresh);
    for (const t of tabs) {
      const cursor = fresh.find((pt) => pt.id === t.id)?.cursor;
      if (cursor) {
        cursorByTab.set(t.id, cursor);
      }
    }
    tabsStore.getState().adoptTabs(tabs);
    if (missing.length > 0) {
      uiStore
        .getState()
        .showNotice(`${missing.length} file(s) could not be found — those tabs were skipped.`);
    }
    ctx.flusher.request();
  }

  /**
   * Tear a tab off into its own OS window. Ownership handoff order is the
   * whole trick:
   *   1. flush — the note file / session buffer the descriptor references
   *      must exist before anything else happens;
   *   2. detach + flush — THIS window's manifest stops claiming the tab
   *      before the new window ever writes its own, so a crash in between
   *      can't restore the tab in two windows at once (worst case it's in
   *      neither manifest, but its files are safely on disk);
   *   3. spawn the window with the descriptor. If that fails, adopt the tab
   *      right back rather than losing it.
   */
  async function moveTabOut(id: string, pos: { x: number; y: number } | null): Promise<void> {
    const spawn = ctx.deps.spawnTabWindow;
    if (!spawn) {
      return;
    }
    await ctx.flusher.flushNow();
    const tab = tabsStore.getState().tabs.find((t) => t.id === id);
    if (!tab) {
      return;
    }
    const descriptor = persistedDescriptor(tab);
    tabsStore.getState().detachTab(id);
    await ctx.flusher.flushNow();
    try {
      await spawn({ schema: 1, activeTabId: descriptor.id, tabs: [descriptor] }, pos);
    } catch (error) {
      await adoptPersistedTabs([descriptor]);
      uiStore.getState().showNotice('Could not open a new window.');
      ctx.deps.onError?.(error);
    }
  }

  /**
   * Window-close handoff (secondary windows): flush everything, then describe
   * each tab worth keeping. A pristine never-flushed Untitled is dropped —
   * handing an empty placeholder back to main would just add noise.
   */
  async function exportTabsForHandoff(): Promise<PersistedTab[]> {
    await ctx.flusher.flushNow();
    return tabsStore
      .getState()
      .tabs.filter(
        (t) =>
          !(
            t.kind === 'note' &&
            t.notePath === null &&
            t.customTitle === null &&
            t.model.getText().length === 0
          ),
      )
      .map(persistedDescriptor);
  }

  /**
   * Last-window-standing close (secondary windows): fold this window's tabs
   * into MAIN's manifest and delete our own, so the next launch opens a
   * single main window holding everything instead of resurrecting this
   * window alongside it. Manifest-file surgery rather than an adopt event —
   * there is no window left alive to adopt the tabs.
   *
   * Our manifest is deleted BEFORE session.json is written (same order as
   * moveTabOut): a crash in between leaves the tabs in neither manifest —
   * their note files / buffers are safely on disk — never in both, which
   * would restore duplicate owners of the same file.
   */
  async function bequeathTabsToMain(tabs: PersistedTab[]): Promise<void> {
    const mainManifestPath = joinPath(ctx.sessionDir, 'session.json');
    // Missing/corrupt session.json → null: these tabs become the whole session.
    const main: SessionManifest | null = await ctx.ipc
      .readTextFile(mainManifestPath)
      .then((r) => parseManifest(r.text))
      .catch(() => null);
    // One-owner-per-file across manifests, mirroring adoptTabs.
    const taken = new Set(
      (main?.tabs ?? [])
        .map((t) => t.filePath ?? t.notePath)
        .filter((p): p is string => p !== null)
        .map(pathKey),
    );
    const fresh = tabs.filter((t) => {
      const path = t.filePath ?? t.notePath;
      return path === null || !taken.has(pathKey(path));
    });
    const activeTabId = tabsStore.getState().activeTabId;
    const merged: SessionManifest = {
      schema: 1,
      // This window's active tab is what the user last touched; fall back to
      // main's remembered one when dedupe dropped ours.
      activeTabId: fresh.some((t) => t.id === activeTabId)
        ? activeTabId
        : (main?.activeTabId ?? fresh[0]?.id ?? null),
      tabs: [...(main?.tabs ?? []), ...fresh],
    };
    await ctx.ipc.deletePath(ctx.manifestPath);
    await ctx.ipc.atomicWriteText(mainManifestPath, JSON.stringify(merged, null, 2));
  }

  return {
    closeTabInteractive,
    closeAllTabsInteractive,
    adoptPersistedTabs,
    moveTabOut,
    exportTabsForHandoff,
    bequeathTabsToMain,
  };
}
