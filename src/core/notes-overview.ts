/**
 * notes-overview.ts — the pure side of "See all review notes": every sidecar
 * the workspaces hold, as one list the overview can search, sort and group.
 *
 * A `NoteDoc` is one document and its notes (one sidecar file). The overview
 * shows them either grouped by document or as one newest-first stream; a
 * query narrows to the notes whose text, quote, declaration or document name
 * contains it. Times are shown relative ("4 min ago") with the exact time on
 * hover — `relativeTime` is here so it is testable against a fixed clock.
 *
 * Pure: no DOM, no I/O, no store. `ui/notes-overview.ts` does the walking.
 */

import { baseName, dirName } from './session/plan-flush';
import { pathKey } from './tab-workspaces';
import type { VoiceComment } from './comments';

/** One document's review notes: the sidecar they came from and the notes. */
export interface NoteDoc {
  /** The sidecar file's path. */
  sidecar: string;
  /** The document the notes are about (resolved from the sidecar). */
  notePath: string;
  notes: VoiceComment[];
}

/** A note with its document, for the newest-first stream. */
export interface OverviewNote {
  doc: NoteDoc;
  note: VoiceComment;
}

/** The document's file name, for headers and chips. */
export function docTitle(doc: NoteDoc): string {
  return baseName(doc.notePath);
}

/**
 * Where the document lives, shortened for a header: its directory relative
 * to the workspace root that contains it (`docs/plans`), `''` at a root, or
 * the full directory when no root contains it.
 */
export function docLocation(doc: NoteDoc, roots: readonly string[]): string {
  const dir = dirName(doc.notePath);
  const dirKey = pathKey(dir);
  let best: string | null = null;
  for (const root of roots) {
    const rootKey = pathKey(root).replace(/\/+$/, '');
    if (dirKey === rootKey) {
      return '';
    }
    if (dirKey.startsWith(`${rootKey}/`) && (best === null || rootKey.length > best.length)) {
      best = rootKey;
    }
  }
  return best === null ? dir : dir.slice(best.length + 1).replaceAll('\\', '/');
}

/** Case-insensitive: does the note (or its document's name) mention `query`? */
export function noteMatches(doc: NoteDoc, note: VoiceComment, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return [note.transcript, note.quote, note.unit ?? '', docTitle(doc)].some((s) =>
    s.toLowerCase().includes(q),
  );
}

/**
 * The documents narrowed to the notes matching `query` (a document with no
 * matching note drops out). With an empty query the list is returned as is.
 */
export function filterDocs(docs: readonly NoteDoc[], query: string): NoteDoc[] {
  if (!query.trim()) {
    return [...docs];
  }
  const out: NoteDoc[] = [];
  for (const doc of docs) {
    const notes = doc.notes.filter((n) => noteMatches(doc, n, query));
    if (notes.length > 0) {
      out.push({ ...doc, notes });
    }
  }
  return out;
}

/**
 * Documents A→Z by name (then by path, so same-named files keep a stable
 * order), each with its notes in document order — by line, notes without
 * one last, then by time — rather than the order they were written in.
 */
export function sortDocs(docs: readonly NoteDoc[]): NoteDoc[] {
  const line = (n: VoiceComment) => n.line ?? Number.POSITIVE_INFINITY;
  return [...docs]
    .sort(
      (a, b) =>
        docTitle(a).localeCompare(docTitle(b), undefined, { sensitivity: 'base' }) ||
        a.notePath.localeCompare(b.notePath),
    )
    .map((doc) => ({
      ...doc,
      notes: [...doc.notes].sort((a, b) => line(a) - line(b) || a.time.localeCompare(b.time)),
    }));
}

/** Every note across the documents, newest first; notes with no readable time last. */
export function newestFirst(docs: readonly NoteDoc[]): OverviewNote[] {
  const all: OverviewNote[] = [];
  for (const doc of docs) {
    for (const note of doc.notes) {
      all.push({ doc, note });
    }
  }
  const stamp = (n: VoiceComment) => {
    const t = Date.parse(n.time);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return all.sort((a, b) => stamp(b.note) - stamp(a.note));
}

/** The number of notes across the documents. */
export function totalNotes(docs: readonly NoteDoc[]): number {
  return docs.reduce((n, d) => n + d.notes.length, 0);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago", then the
 * date. A time in the future (a clock that moved) reads as "just now"; an
 * unreadable one is returned as it is.
 */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return iso;
  }
  const ago = nowMs - t;
  if (ago < MINUTE) {
    return 'just now';
  }
  if (ago < HOUR) {
    return `${Math.floor(ago / MINUTE)} min ago`;
  }
  if (ago < DAY) {
    return `${Math.floor(ago / HOUR)} h ago`;
  }
  const days = Math.floor(ago / DAY);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 14) {
    return `${days} days ago`;
  }
  return new Date(t).toLocaleDateString();
}
