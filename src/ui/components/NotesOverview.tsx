/**
 * NotesOverview — "See all review notes".
 *
 * A projection of `notes-overview.ts`: a panel that slides in from the right
 * on desktop and fills the screen on a phone, listing every review note the
 * workspaces hold. One stream newest-first, or grouped by document; a search
 * box narrows it; "This document" keeps to the active tab. Each note is a
 * card — where it is (line, declaration), the quoted line, the text (editable
 * in place, committed on blur), when it was made — with Go to (opens the
 * document in Review mode and reveals the note) and a two-step Delete.
 *
 * Mounted once at the app root; renders nothing while closed (it stays in
 * the tree for the closing slide). Escape closes it (main.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import { pathKey } from '../../core/tab-workspaces';
import type { VoiceComment } from '../../core/comments';
import {
  docLocation,
  docTitle,
  filterDocs,
  newestFirst,
  relativeTime,
  sortDocs,
  totalNotes,
  type NoteDoc,
} from '../../core/notes-overview';
import {
  activeDocPath,
  closeOverview,
  deleteOverviewNote,
  editOverviewNote,
  goToNote,
  refreshOverview,
  setOverviewQuery,
  setOverviewScope,
  setOverviewView,
  useNotesOverview,
  workspaceRoots,
} from '../notes-overview';
import { useTabsStore } from '../stores/tabs';

/**
 * Always in the tree so the open/close slide is one CSS transition driven by
 * `[data-open]` (an unmounted panel can't animate out); while closed it is
 * invisible and inert (`visibility`, `pointer-events` — see the CSS).
 */
export function NotesOverview() {
  const open = useNotesOverview((s) => s.open);
  return (
    <div
      className="rn-backdrop"
      data-open={open || undefined}
      aria-hidden={!open}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeOverview();
        }
      }}
    >
      <Panel open={open} />
    </div>
  );
}

function Panel({ open }: { open: boolean }) {
  const docs = useNotesOverview((s) => s.docs);
  const loading = useNotesOverview((s) => s.loading);
  const loaded = useNotesOverview((s) => s.loaded);
  const truncated = useNotesOverview((s) => s.truncated);
  const query = useNotesOverview((s) => s.query);
  const view = useNotesOverview((s) => s.view);
  const scope = useNotesOverview((s) => s.scope);
  // Re-render on tab changes so "This document" follows the active tab.
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const current = activeDocPath();
  const currentKey = current ? pathKey(current) : null;
  const scoped =
    scope === 'current'
      ? docs.filter((d) => currentKey !== null && pathKey(d.notePath) === currentKey)
      : docs;
  const shown = filterDocs(scoped, query);
  const total = totalNotes(docs);
  const roots = workspaceRoots();
  const now = useClock();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    }
  }, [open]);
  void activeTabId;
  return (
    <div className="rn-panel" role="dialog" aria-label="All review notes">
      <div className="rn-head">
        <div className="rn-title">
          <span className="rn-title-icon" aria-hidden="true">
            💬
          </span>
          <h2>Review notes</h2>
          {loaded && <span className="rn-count">{total}</span>}
        </div>
        <button
          className="rn-icon-btn"
          onClick={() => void refreshOverview()}
          aria-label="Refresh"
          title="Look for notes again"
          disabled={loading}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M15.6 3.6v3.2h-3.2" />
          </svg>
        </button>
        <button
          className="rn-icon-btn"
          onClick={closeOverview}
          aria-label="Close"
          title="Close (Esc)"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>
      </div>
      <div className="rn-tools">
        <label className="rn-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5" />
            <path d="M12.5 12.5L17 17" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search notes…"
            aria-label="Search review notes"
            onChange={(e) => setOverviewQuery(e.target.value)}
          />
        </label>
        <div className="rn-segments" role="group" aria-label="Layout">
          <button
            className="rn-segment"
            data-active={view === 'newest' || undefined}
            aria-pressed={view === 'newest'}
            onClick={() => setOverviewView('newest')}
          >
            Newest
          </button>
          <button
            className="rn-segment"
            data-active={view === 'document' || undefined}
            aria-pressed={view === 'document'}
            onClick={() => setOverviewView('document')}
          >
            By document
          </button>
        </div>
        <div className="rn-segments" role="group" aria-label="Scope">
          <button
            className="rn-segment"
            data-active={scope === 'all' || undefined}
            aria-pressed={scope === 'all'}
            onClick={() => setOverviewScope('all')}
          >
            All
          </button>
          <button
            className="rn-segment"
            data-active={scope === 'current' || undefined}
            aria-pressed={scope === 'current'}
            onClick={() => setOverviewScope('current')}
            disabled={current === null}
            title={current === null ? 'The active tab has no file' : undefined}
          >
            This document
          </button>
        </div>
      </div>
      <div className="rn-body">
        {loading && !loaded ? (
          <Skeleton />
        ) : shown.length === 0 ? (
          <Empty total={total} filtered={docs.length > 0} scope={scope} />
        ) : view === 'newest' ? (
          <div className="rn-list">
            {newestFirst(shown).map(({ doc, note }) => (
              <NoteCard key={`${doc.sidecar}:${note.id}`} doc={doc} note={note} showDoc now={now} />
            ))}
          </div>
        ) : (
          sortDocs(shown).map((doc) => (
            <section className="rn-group" key={doc.sidecar}>
              <header className="rn-group-head">
                <button
                  className="rn-group-title"
                  onClick={() => goToNote(doc, doc.notes[0] ?? { line: 1 })}
                  title="Open in Review mode"
                >
                  {docTitle(doc)}
                </button>
                {docLocation(doc, roots) && (
                  <span className="rn-group-dir">{docLocation(doc, roots)}</span>
                )}
                <span className="rn-group-count">
                  {doc.notes.length} {doc.notes.length === 1 ? 'note' : 'notes'}
                </span>
              </header>
              <div className="rn-list">
                {doc.notes.map((note) => (
                  <NoteCard key={note.id} doc={doc} note={note} showDoc={false} now={now} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {(truncated || (loading && loaded)) && (
        <div className="rn-foot" role="status">
          {loading ? 'Looking for notes…' : 'Some folders were not searched (too many to walk).'}
        </div>
      )}
    </div>
  );
}

/** A minute tick so "4 min ago" stays true while the panel is open. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Skeleton() {
  return (
    <div className="rn-list" aria-busy="true" aria-label="Loading review notes">
      {[0, 1, 2].map((i) => (
        <div className="rn-card rn-skeleton" key={i}>
          <div className="rn-sk-line rn-sk-short" />
          <div className="rn-sk-line" />
          <div className="rn-sk-line rn-sk-mid" />
        </div>
      ))}
    </div>
  );
}

function Empty({ total, filtered, scope }: { total: number; filtered: boolean; scope: string }) {
  return (
    <div className="rn-empty">
      <div className="rn-empty-glyph" aria-hidden="true">
        💬
      </div>
      {total === 0 ? (
        <>
          <div className="rn-empty-title">No review notes yet</div>
          <div className="rn-empty-hint">
            In Review mode, turn on Review notes and press and hold a line to add one.
          </div>
        </>
      ) : (
        <>
          <div className="rn-empty-title">
            {filtered && scope === 'current' ? 'None on this document' : 'No matching notes'}
          </div>
          <div className="rn-empty-hint">Try another search, or widen the scope to All.</div>
        </>
      )}
    </div>
  );
}

function NoteCard({
  doc,
  note,
  showDoc,
  now,
}: {
  doc: NoteDoc;
  note: VoiceComment;
  showDoc: boolean;
  now: number;
}) {
  const exact = new Date(note.time);
  return (
    <article className="rn-card">
      <header className="rn-card-meta">
        {note.line !== null && <span className="rn-chip rn-chip-line">Line {note.line}</span>}
        {note.unit && <span className="rn-chip rn-chip-unit">{note.unit}</span>}
        {showDoc && (
          <button className="rn-doc-link" onClick={() => goToNote(doc, note)} title={doc.notePath}>
            {docTitle(doc)}
          </button>
        )}
        <time
          className="rn-when"
          dateTime={note.time}
          title={Number.isNaN(exact.getTime()) ? note.time : exact.toLocaleString()}
        >
          {relativeTime(note.time, now)}
        </time>
      </header>
      {note.quote && <blockquote className="rn-quote">{note.quote}</blockquote>}
      <NoteText doc={doc} note={note} />
      <footer className="rn-card-actions">
        <button className="rn-btn rn-goto" onClick={() => goToNote(doc, note)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10h11M11 5.5l4.5 4.5-4.5 4.5" />
          </svg>
          Go to
        </button>
        <DeleteButton onConfirm={() => void deleteOverviewNote(doc, note.id)} />
      </footer>
    </article>
  );
}

/** The note's text, edited in place; committed when the box loses focus (or Ctrl+Enter). */
function NoteText({ doc, note }: { doc: NoteDoc; note: VoiceComment }) {
  const [text, setText] = useState(note.transcript);
  // A save from elsewhere (a callout, another card) replaces the text: adopt
  // it when the stored transcript changes (the "adjust state on prop change"
  // pattern — no effect, no extra paint).
  const [seen, setSeen] = useState(note.transcript);
  if (seen !== note.transcript) {
    setSeen(note.transcript);
    setText(note.transcript);
  }
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (box) {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight}px`;
    }
  }, [text]);
  const commit = () => {
    if (text !== note.transcript) {
      void editOverviewNote(doc, note.id, text);
    }
  };
  return (
    <textarea
      ref={ref}
      className="rn-text"
      value={text}
      rows={1}
      placeholder="Empty note"
      aria-label="Review note text"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Delete asks twice: the first tap turns into "Delete?" for a few seconds. */
function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) {
      return;
    }
    const timer = setTimeout(() => setAsking(false), 3000);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <button
      className={`rn-btn rn-delete${asking ? ' rn-delete-asking' : ''}`}
      onClick={() => {
        if (asking) {
          onConfirm();
        } else {
          setAsking(true);
        }
      }}
      aria-label={asking ? 'Tap again to delete this review note' : 'Delete review note'}
    >
      {asking ? 'Delete?' : 'Delete'}
    </button>
  );
}
