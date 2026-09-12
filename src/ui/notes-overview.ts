/**
 * notes-overview.ts — "See all review notes": the store behind the overview
 * panel (`components/NotesOverview.tsx`).
 *
 * Opening the panel walks every workspace root (the default notes dir plus
 * `settings.workspaces[]`, like search does) through the storage provider —
 * so a synced `saf://` workspace is walked the same way — and reads every
 * `*.comments.md` it finds, plus the sidecars of the open tabs' documents
 * (a document outside every workspace still shows up). Each sidecar becomes
 * one `NoteDoc` (`core/notes-overview.ts`). The walk is capped so a huge
 * tree can't stall the panel; what was found by the cap is shown.
 *
 * Edits and deletes go through `voice-comments.ts mutateNotes`, which owns
 * the sidecar writes; the store listens (`onNotesChanged`) rather than
 * updating itself, so a save made anywhere else lands here too. "Go to"
 * opens the document in Review mode with the review-notes toggle armed and
 * asks its pane to reveal the note (`requestReveal`).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { isCommentsPath, notePathFromSidecar, parseCommentsFile } from '../core/comments';
import type { NoteDoc } from '../core/notes-overview';
import { baseName } from '../core/session/plan-flush';
import { pathKey } from '../core/tab-workspaces';
import { currentProvider } from '../ipc/provider';
import { getDefaultWorkspacePath, openNotePath } from './session';
import { settingsStore } from './stores/settings';
import { tabsStore } from './stores/tabs';
import {
  mutateNotes,
  onNotesChanged,
  requestReveal,
  sidecarFor,
  voiceStore,
} from './voice-comments';

/** How the notes are laid out: one stream, newest first, or grouped by document. */
export type OverviewView = 'newest' | 'document';
/** Every document, or only the active tab's. */
export type OverviewScope = 'all' | 'current';

export interface NotesOverviewState {
  open: boolean;
  /** A walk is in flight (the first one shows a skeleton; later ones refresh quietly). */
  loading: boolean;
  /** The walk has completed at least once since the panel opened. */
  loaded: boolean;
  docs: NoteDoc[];
  /** The last walk stopped at a cap — some sidecars may be missing. */
  truncated: boolean;
  query: string;
  view: OverviewView;
  scope: OverviewScope;
}

const initial: NotesOverviewState = {
  open: false,
  loading: false,
  loaded: false,
  docs: [],
  truncated: false,
  query: '',
  view: 'newest',
  scope: 'all',
};

export const notesOverviewStore = createStore<NotesOverviewState>()(() => initial);

export const useNotesOverview = <T>(selector: (s: NotesOverviewState) => T): T =>
  useStore(notesOverviewStore, selector);

/* ---- the walk ---------------------------------------------------------- */

/** Directories visited per walk, and sidecars read — the panel stays quick. */
export const DIR_CAP = 400;
export const SIDECAR_CAP = 200;
const MAX_DEPTH = 12;
/** Directories nobody keeps notes in, and that are large. */
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', '.git']);

/** Every workspace root: default notes dir + settings entries, deduped. */
export function workspaceRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const defaultPath = getDefaultWorkspacePath();
  for (const path of [
    ...(defaultPath ? [defaultPath] : []),
    ...settingsStore.getState().settings.workspaces.map((w) => w.path),
  ]) {
    const key = pathKey(path);
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(path);
    }
  }
  return roots;
}

/**
 * Breadth-first over `roots`, collecting sidecar paths. Dot-directories and
 * the usual build trees are skipped; an unreadable directory is skipped
 * silently. Returns what was found and whether a cap stopped the walk.
 */
async function collectSidecars(
  roots: readonly string[],
): Promise<{ sidecars: string[]; truncated: boolean }> {
  const provider = currentProvider();
  const sidecars: string[] = [];
  const seen = new Set<string>();
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (visited >= DIR_CAP) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift()!;
    const key = pathKey(dir);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    visited++;
    let entries;
    try {
      entries = await provider.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = baseName(entry.path);
      if (entry.isDir) {
        if (depth < MAX_DEPTH && !name.startsWith('.') && !SKIP_DIRS.has(name)) {
          queue.push({ dir: entry.path, depth: depth + 1 });
        }
      } else if (isCommentsPath(entry.path) && !seen.has(pathKey(entry.path))) {
        seen.add(pathKey(entry.path));
        sidecars.push(entry.path);
      }
    }
  }
  return { sidecars, truncated };
}

/** The open tabs' documents' sidecars, per the location setting (may not exist). */
function openTabSidecars(): string[] {
  const out: string[] = [];
  for (const tab of tabsStore.getState().tabs) {
    const path = tab.filePath ?? tab.notePath;
    if (path) {
      out.push(sidecarFor(path));
    }
  }
  return out;
}

/** Read one sidecar into a `NoteDoc`; null when it is missing, empty or unreadable. */
async function readDoc(sidecar: string): Promise<NoteDoc | null> {
  try {
    const { text } = await currentProvider().readTextFile(sidecar);
    const notes = parseCommentsFile(text);
    if (notes.length === 0) {
      return null;
    }
    return { sidecar, notePath: notePathFromSidecar(sidecar, notes[0]?.file ?? ''), notes };
  } catch {
    return null;
  }
}

let walkToken = 0;

/** Walk the workspaces again. A walk superseded by a newer one drops its result. */
export async function refreshOverview(): Promise<void> {
  const token = ++walkToken;
  notesOverviewStore.setState({ loading: true });
  const { sidecars, truncated } = await collectSidecars(workspaceRoots());
  const seen = new Set(sidecars.map(pathKey));
  for (const extra of openTabSidecars()) {
    if (!seen.has(pathKey(extra))) {
      seen.add(pathKey(extra));
      sidecars.push(extra);
    }
  }
  const capped = sidecars.slice(0, SIDECAR_CAP);
  const docs = (await Promise.all(capped.map(readDoc))).filter((d): d is NoteDoc => d !== null);
  if (token !== walkToken) {
    return;
  }
  notesOverviewStore.setState({
    loading: false,
    loaded: true,
    docs,
    truncated: truncated || sidecars.length > capped.length,
  });
}

/* ---- actions ----------------------------------------------------------- */

/** Open the panel (walking afresh each time; the last list shows meanwhile). */
export function openOverview(scope?: OverviewScope): void {
  const { open } = notesOverviewStore.getState();
  notesOverviewStore.setState({ open: true, ...(scope ? { scope } : {}) });
  if (!open) {
    void refreshOverview();
  }
}

export function closeOverview(): void {
  notesOverviewStore.setState({ open: false });
}

export function toggleOverview(): void {
  if (notesOverviewStore.getState().open) {
    closeOverview();
  } else {
    openOverview();
  }
}

export function setOverviewQuery(query: string): void {
  notesOverviewStore.setState({ query });
}

export function setOverviewView(view: OverviewView): void {
  notesOverviewStore.setState({ view });
}

export function setOverviewScope(scope: OverviewScope): void {
  notesOverviewStore.setState({ scope });
}

/** The active tab's document path, for the "This document" scope; null for none. */
export function activeDocPath(): string | null {
  const { tabs, activeTabId } = tabsStore.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab ? (tab.filePath ?? tab.notePath) : null;
}

/** Edit a note's text in its document's sidecar. */
export function editOverviewNote(doc: NoteDoc, id: string, transcript: string): Promise<void> {
  return mutateNotes(doc.notePath, doc.sidecar, (notes) =>
    notes.map((n) => (n.id === id ? { ...n, transcript } : n)),
  ).then(() => {});
}

/** Delete a note from its document's sidecar. */
export function deleteOverviewNote(doc: NoteDoc, id: string): Promise<void> {
  return mutateNotes(doc.notePath, doc.sidecar, (notes) => notes.filter((n) => n.id !== id)).then(
    () => {},
  );
}

/** How long "Go to" waits for the document's tab to appear before giving up. */
const GOTO_TAB_WAIT_MS = 10_000;

/**
 * "Go to": close the panel, open the document (activating its tab if it is
 * already open) in Review mode with review notes armed, and ask the pane to
 * bring the note into view. The tab may not exist yet when the open is
 * asynchronous, so the mode switch waits for it.
 */
export function goToNote(doc: NoteDoc, note: { line: number | null; unit?: string }): void {
  closeOverview();
  if (!voiceStore.getState().armed) {
    voiceStore.setState({ armed: true });
  }
  requestReveal(doc.notePath, note.line ?? 1, note.unit ?? null);
  const key = pathKey(doc.notePath);
  const toReview = (): boolean => {
    const tab = tabsStore.getState().tabs.find((t) => {
      const p = t.filePath ?? t.notePath;
      return p !== null && pathKey(p) === key;
    });
    if (!tab) {
      return false;
    }
    if (tab.mode !== 'read') {
      tabsStore.getState().setMode(tab.id, 'read');
    }
    return true;
  };
  openNotePath(doc.notePath);
  if (toReview()) {
    return;
  }
  const unsubscribe = tabsStore.subscribe(() => {
    if (toReview()) {
      unsubscribe();
    }
  });
  setTimeout(unsubscribe, GOTO_TAB_WAIT_MS);
}

/* ---- keeping the list current ------------------------------------------ */

onNotesChanged((notePath, sidecar, notes) => {
  const { docs, open, loaded } = notesOverviewStore.getState();
  if (!open && !loaded) {
    return;
  }
  const key = pathKey(sidecar);
  const rest = docs.filter((d) => pathKey(d.sidecar) !== key);
  const next = notes.length > 0 ? [...rest, { sidecar, notePath, notes: [...notes] }] : rest;
  notesOverviewStore.setState({ docs: next });
});
