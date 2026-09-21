/**
 * Doc sync wiring — binds the pure hub (core/doc-sync.ts) to the tabs store.
 *
 * Every FILE tab is attached under its path key, so mirrors of one file (two
 * tabs here, or a tab in another window) type into each other live. Note tabs
 * stay out: a note's file follows its one tab (renamed with the title, deleted
 * on close), which a second owner would break.
 *
 * Saves are detected rather than hooked: a clean tab whose on-disk baseline
 * (mtime or 'file' snapshot) just moved has been saved or reloaded, and its
 * mirrors adopt that baseline — so a sibling's write never reads as an
 * external change. The transport is injected by main.tsx (Tauri events);
 * without one (tests, Android's single window) sync stays window-local.
 */

import { createDocSyncHub, type DocSyncMessage } from '../core/doc-sync';
import { pathKey } from '../core/tab-workspaces';
import { tabsStore } from './stores/tabs';

let transport: ((message: DocSyncMessage) => void) | null = null;

export const docSync = createDocSyncHub({ send: (message) => transport?.(message) });

/** Was `text` recently held by a mirror of the file at `path`? (conflict probe) */
export function mirrorKnowsText(path: string, text: string): boolean {
  return docSync.knows(pathKey(path), text);
}

interface Attachment {
  key: string;
  detach: () => void;
  savedMtimeMs: number | null;
  persisted: string;
}

const attachments = new Map<string, Attachment>();
let reconciling = false;
let reconcileAgain = false;

/** Store changes made while reconciling (a mirror adopting a save) rerun it
 *  afterwards instead of nesting, so the loop never works on a stale list. */
function reconcile(): void {
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      reconcileOnce();
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}

function reconcileOnce(): void {
  const saves: Array<{ id: string; text: string; mtimeMs: number }> = [];
  const tabs = tabsStore.getState().tabs;
  const live = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind !== 'file' || tab.filePath === null) {
      continue;
    }
    live.add(tab.id);
    const key = pathKey(tab.filePath);
    let at = attachments.get(tab.id);
    if (at && at.key !== key) {
      at.detach(); // renamed / Save As: now a different file
      at = undefined;
    }
    const persisted = tab.model.getPersisted('file');
    if (!at) {
      const id = tab.id;
      attachments.set(id, {
        key,
        savedMtimeMs: tab.savedMtimeMs,
        persisted,
        detach: docSync.attach({
          id,
          key,
          model: tab.model,
          onSaved: (text, mtimeMs) => {
            // Record the baseline first: adopting a mirror's save is not a
            // save of our own, and must not be announced back.
            const own = attachments.get(id);
            if (own) {
              own.savedMtimeMs = mtimeMs;
              own.persisted = text;
            }
            tabsStore.getState().adoptMergedText(id, { diskText: text, mtimeMs });
          },
        }),
      });
      continue;
    }
    const moved = at.savedMtimeMs !== tab.savedMtimeMs || at.persisted !== persisted;
    at.savedMtimeMs = tab.savedMtimeMs;
    at.persisted = persisted;
    if (moved && tab.savedMtimeMs !== null && !tab.model.isDirty('file')) {
      saves.push({ id: tab.id, text: persisted, mtimeMs: tab.savedMtimeMs });
    }
  }
  for (const [id, at] of attachments) {
    if (!live.has(id)) {
      at.detach();
      attachments.delete(id);
    }
  }
  for (const save of saves) {
    docSync.notifySaved(save.id, save.text, save.mtimeMs);
  }
}

let started = false;

/** Begin syncing (idempotent). `send` broadcasts to the other windows. */
export function startDocSync(send?: (message: DocSyncMessage) => void): void {
  transport = send ?? null;
  if (started) {
    return;
  }
  started = true;
  reconcile();
  tabsStore.subscribe(reconcile);
}
