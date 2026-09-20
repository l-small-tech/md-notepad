/**
 * PresenterView — the whole UI of the presenter window (`?presenter=1`).
 *
 * The current slide large, the next one small, the current slide's speaker
 * notes (Marp's `<!-- comment -->` notes, `DeckSlide.notes`), a wall clock, a
 * stopwatch and "Slide n / N". It owns no tab and no document: the window
 * that opened it sends the deck as text (`presenter-deck`) and this renders
 * it with the same `renderDeck` the panes use. Navigation here — the same
 * keys as the show, or the buttons — is published as `deck-slide`, which the
 * full-screen show follows; a slide change made in the show arrives the same
 * way. See ui/presenter.ts.
 */

import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import {
  clampSlide,
  formatElapsed,
  stopwatchElapsed,
  toggleStopwatch,
  type PresenterDeck,
  type SlideMessage,
  type Stopwatch,
} from '../../core/presenter';
import { dirName } from '../../core/session/plan-flush';
import {
  applyMarpBrowser,
  createImageResolver,
  inlineDeckImages,
  mountSlide,
  renderDeck,
  type DeckRender,
} from '../../preview/marp';
import { DECK_EVENT, PRESENTER_LABEL, READY_EVENT, SLIDE_EVENT } from '../presenter';

const NOTES_SIZE_KEY = 'presenter-notes-size';
const NOTES_SIZES = [14, 16, 18, 22, 26, 32] as const;

type Resolver = (absPath: string) => Promise<string | null>;

/** One slide in its own shadow root, exactly as the show mounts it. */
function SlideFrame({
  deck,
  index,
  docPath,
  resolver,
  className,
}: {
  deck: DeckRender;
  index: number;
  docPath: string | null;
  resolver: Resolver;
  className: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    return applyMarpBrowser(root);
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    const slide = deck.slides[index];
    if (!host || !slide) {
      return;
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    if (mountSlide(root, deck.css, slide.html)) {
      void inlineDeckImages(root, docPath ? dirName(docPath) : null, resolver);
    }
  }, [deck, index, docPath, resolver]);
  return (
    <div
      ref={hostRef}
      className={className}
      style={{ ['--deck-aspect' as string]: String(deck.width / deck.height) }}
    />
  );
}

function readNotesSize(): number {
  try {
    const saved = Number(localStorage.getItem(NOTES_SIZE_KEY));
    return NOTES_SIZES.includes(saved as (typeof NOTES_SIZES)[number]) ? saved : 18;
  } catch {
    return 18;
  }
}

export function PresenterView() {
  const [source, setSource] = useState<PresenterDeck | null>(null);
  const [deck, setDeck] = useState<DeckRender | null>(null);
  const [index, setIndex] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [watch, setWatch] = useState<Stopwatch>(() => ({ elapsedMs: 0, startedAt: Date.now() }));
  const [notesSize, setNotesSize] = useState(readNotesSize);
  const [resolver] = useState<Resolver>(() => createImageResolver());
  const keyRef = useRef<string | null>(null);
  const indexRef = useRef(0);
  const totalRef = useRef(0);

  // The deck arrives (and re-arrives after every edit) from the window that
  // opened this one; `presenter-ready` asks for it once we can hear the answer.
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const offDeck = await listen<PresenterDeck>(DECK_EVENT, (event) => {
        const next = event.payload;
        // A different deck starts from the slide its window is on; an edit to
        // the same deck must not yank the presenter off the slide it is on.
        if (keyRef.current !== next.key) {
          keyRef.current = next.key;
          indexRef.current = next.index;
          setIndex(next.index);
        }
        setSource(next);
      });
      const offSlide = await listen<SlideMessage>(SLIDE_EVENT, (event) => {
        const { from, key, index: to } = event.payload;
        if (from !== PRESENTER_LABEL && key === keyRef.current) {
          indexRef.current = to;
          setIndex(to);
        }
      });
      if (disposed) {
        offDeck();
        offSlide();
        return;
      }
      unlisten.push(offDeck, offSlide);
      void emit(READY_EVENT).catch(() => {});
    })().catch(() => {});
    return () => {
      disposed = true;
      unlisten.forEach((off) => off());
    };
  }, []);

  // Render the deck whenever its text changes.
  useEffect(() => {
    if (!source) {
      return;
    }
    let stale = false;
    renderDeck(source.text, { docPath: source.docPath })
      .then((next) => {
        if (!stale) {
          totalRef.current = next.slides.length;
          setDeck(next);
        }
      })
      .catch((error: unknown) => console.error('[presenter] render failed', error));
    return () => {
      stale = true;
    };
  }, [source]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const go = (to: number): void => {
    const key = keyRef.current;
    if (key === null || totalRef.current === 0) {
      return;
    }
    const next = clampSlide(to, totalRef.current);
    if (next === indexRef.current) {
      return;
    }
    indexRef.current = next;
    setIndex(next);
    const message: SlideMessage = { from: PRESENTER_LABEL, key, index: next };
    void emit(SLIDE_EVENT, message).catch(() => {});
  };
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });

  // The same keys as the show, so a clicker works whichever window has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case 'Enter':
        case ' ':
          goRef.current(indexRef.current + (e.shiftKey && e.key === ' ' ? -1 : 1));
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          goRef.current(indexRef.current - 1);
          break;
        case 'Home':
          goRef.current(0);
          break;
        case 'End':
          goRef.current(totalRef.current - 1);
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resizeNotes = (step: 1 | -1): void => {
    const at = NOTES_SIZES.indexOf(notesSize as (typeof NOTES_SIZES)[number]);
    const next = NOTES_SIZES[Math.max(0, Math.min(NOTES_SIZES.length - 1, at + step))] ?? 18;
    setNotesSize(next);
    try {
      localStorage.setItem(NOTES_SIZE_KEY, String(next));
    } catch {
      // Storage unavailable — the size just won't be remembered.
    }
  };

  const total = deck?.slides.length ?? 0;
  if (!source || !deck || total === 0) {
    return (
      <div className="presenter presenter-empty">
        {source && deck ? 'This deck has no slides yet.' : 'Waiting for a deck…'}
      </div>
    );
  }
  const shown = clampSlide(index, total);
  const notes = deck.slides[shown]?.notes ?? [];
  const hasNext = shown + 1 < total;

  return (
    <div className="presenter">
      <header className="presenter-bar">
        <span className="presenter-title" title={source.docPath ?? undefined}>
          {source.title}
        </span>
        <span className="presenter-count">
          Slide {shown + 1} / {total}
        </span>
        <span className="presenter-spacer" />
        <button
          className="presenter-timer"
          title={watch.startedAt === null ? 'Resume the timer' : 'Pause the timer'}
          onClick={() => setWatch((w) => toggleStopwatch(w, Date.now()))}
        >
          {watch.startedAt === null ? '▶' : '⏸'} {formatElapsed(stopwatchElapsed(watch, now))}
        </button>
        <button
          className="presenter-button"
          title="Reset the timer"
          onClick={() =>
            setWatch((w) => ({
              elapsedMs: 0,
              startedAt: w.startedAt === null ? null : Date.now(),
            }))
          }
        >
          Reset
        </button>
        <span className="presenter-clock">
          {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>
      <main className="presenter-body">
        <section className="presenter-current">
          <SlideFrame
            deck={deck}
            index={shown}
            docPath={source.docPath}
            resolver={resolver}
            className="presenter-slide"
          />
          <nav className="presenter-nav">
            <button
              className="presenter-button"
              disabled={shown === 0}
              onClick={() => go(shown - 1)}
            >
              ‹ Previous
            </button>
            <button className="presenter-button" disabled={!hasNext} onClick={() => go(shown + 1)}>
              Next ›
            </button>
          </nav>
        </section>
        <aside className="presenter-side">
          <div className="presenter-label">Next</div>
          {hasNext ? (
            <SlideFrame
              deck={deck}
              index={shown + 1}
              docPath={source.docPath}
              resolver={resolver}
              className="presenter-slide presenter-next"
            />
          ) : (
            <div className="presenter-slide presenter-next presenter-end">End of deck</div>
          )}
          <div className="presenter-label presenter-notes-head">
            <span>Notes</span>
            <span className="presenter-spacer" />
            <button
              className="presenter-button"
              title="Smaller notes"
              onClick={() => resizeNotes(-1)}
            >
              A−
            </button>
            <button
              className="presenter-button"
              title="Larger notes"
              onClick={() => resizeNotes(1)}
            >
              A+
            </button>
          </div>
          <div className="presenter-notes" style={{ fontSize: notesSize }}>
            {notes.length === 0 ? (
              <p className="presenter-notes-none">
                No notes for this slide. Add them in the deck as an HTML comment:{' '}
                <code>&lt;!-- say this --&gt;</code>
              </p>
            ) : (
              notes.map((note, i) => <p key={i}>{note}</p>)
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
