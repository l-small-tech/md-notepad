/**
 * DeckShow — the show itself: a deck in OS full screen (F11).
 *
 * One slide letterboxed on a dark stage, keyboard driven — arrows, Space,
 * PgUp/PgDn, Home/End, a typed number then Enter to jump, P for the presenter
 * view (notes, next slide and a timer in a second window) — with a two-pixel
 * progress bar along the bottom edge. It is NOT a mode and holds no store
 * state of its own: App mounts it while the window is fullscreen and the
 * active tab is a deck, and unmounts it when either changes. Escape is the
 * global keydown listener's (main.tsx) — it leaves full screen, which is the
 * light table (or Split, or Raw) on the slide that was showing: this
 * component reports its slide back to the surface below on the way out.
 *
 * Slides come from the same `renderDeck` the panes use and mount the same
 * way (a shadow root per slide, `mountSlide`), so a deck that changes on
 * disk while it is being shown (Live Edit) re-renders in place, clamped to
 * the slide count.
 */

import { useEffect, useRef, useState } from 'react';
import { splitSlides } from '../../core/deck';
import {
  applyMarpBrowser,
  createImageResolver,
  inlineDeckImages,
  mountSlide,
  renderDeck,
  type DeckRender,
} from '../../preview/marp';
import { dirName } from '../../core/session/plan-flush';
import { scrollSurfaceToLine } from '../mode-scroll';
import { scrollSurfaceFor } from '../../core/mode-scroll';
import { deckKeyFor, openPresenterView, publishSlide, slideStore, startSlide } from '../presenter';
import { deckPaneFor } from '../stores/deck-show';
import { tabsStore } from '../stores/tabs';

const RENDER_DEBOUNCE_MS = 200;
/** How long a typed slide number waits for Enter (or more digits). */
const JUMP_TIMEOUT_MS = 1500;

/** Put the slide that was showing back on top of the surface underneath. */
function landOn(tabId: string, index: number): void {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) {
    return;
  }
  const pane = deckPaneFor(tabId);
  if (pane) {
    pane.scrollToSlide(index);
    return;
  }
  const surface = scrollSurfaceFor(tab.mode);
  const range = splitSlides(tab.model.getText())[index];
  if (surface && range) {
    scrollSurfaceToLine(tabId, surface, range.start);
  }
}

export function DeckShow({ tabId }: { tabId: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [deck, setDeck] = useState<DeckRender | null>(null);
  const [index, setIndex] = useState(() => startSlide(tabId));
  const [jump, setJump] = useState('');
  // The current slide, readable from the unmount cleanup without re-keying it.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  // Presenter view: say which slide is up, and follow a slide change made in
  // the presenter window (or a mirror's show) — ui/presenter.ts. Publishing a
  // slide that came from the store is a no-op there, so this cannot loop.
  const [deckKey] = useState(() => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    return tab ? deckKeyFor(tab) : `tab:${tabId}`;
  });
  useEffect(() => {
    publishSlide(deckKey, index);
  }, [deckKey, index]);
  useEffect(
    () =>
      slideStore.subscribe((s) => {
        const remote = s.byKey[deckKey];
        if (remote !== undefined && remote !== indexRef.current) {
          setIndex(remote);
        }
      }),
    [deckKey],
  );

  // Render the deck now and after every (debounced) model change.
  useEffect(() => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    let disposed = false;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const render = async () => {
      const token = ++seq;
      try {
        const next = await renderDeck(tab.model.getText(), {
          docPath: tab.filePath ?? tab.notePath,
        });
        if (!disposed && token === seq) {
          setDeck(next);
        }
      } catch (error) {
        console.error('[deck] show render failed', error);
      }
    };
    void render();
    const unsubscribe = tab.model.subscribe(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void render(), RENDER_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (timer !== null) {
        clearTimeout(timer);
      }
      // On the way out, the surface below lands on the slide that was showing.
      landOn(tabId, indexRef.current);
    };
  }, [tabId]);

  // Mount the current slide into the stage's shadow root.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !deck) {
      return;
    }
    const root = stage.shadowRoot ?? stage.attachShadow({ mode: 'open' });
    const slide = deck.slides[Math.min(index, deck.slides.length - 1)];
    if (!slide) {
      return;
    }
    if (mountSlide(root, deck.css, slide.html)) {
      const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
      const path = tab ? (tab.filePath ?? tab.notePath) : null;
      void inlineDeckImages(root, path ? dirName(path) : null, resolverRef.current);
    }
  }, [deck, index, tabId]);
  const resolverRef = useRef(createImageResolver());

  // Marp's browser helper (auto-scaling, WebKit polyfill) on the stage root.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const root = stage.shadowRoot ?? stage.attachShadow({ mode: 'open' });
    return applyMarpBrowser(root);
  }, []);

  // Keyboard: the show owns the arrows while it is up. Escape and F11 are
  // left to the global dispatcher (they leave full screen), everything else
  // to the app.
  // The typed number lives in a ref (the listener reads it) and is mirrored
  // into state only for display, so typing never re-subscribes the listener.
  const jumpRef = useRef('');
  useEffect(() => {
    rootRef.current?.focus();
    let jumpTimer: ReturnType<typeof setTimeout> | null = null;
    const clearJump = () => {
      if (jumpTimer !== null) {
        clearTimeout(jumpTimer);
        jumpTimer = null;
      }
      jumpRef.current = '';
      setJump('');
    };
    const count = () => deck?.slides.length ?? 0;
    const go = (to: number) => {
      const n = count();
      if (n > 0) {
        setIndex(Math.max(0, Math.min(n - 1, to)));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          go(indexRef.current + (e.shiftKey && e.key === ' ' ? -1 : 1));
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          go(indexRef.current - 1);
          break;
        case 'Home':
          go(0);
          break;
        case 'End':
          go(count() - 1);
          break;
        case 'Enter':
          if (jumpRef.current.length > 0) {
            go(Number(jumpRef.current) - 1);
            clearJump();
          } else {
            go(indexRef.current + 1);
          }
          break;
        case 'p':
        case 'P':
          void openPresenterView(tabId);
          break;
        default:
          if (/^[0-9]$/.test(e.key)) {
            jumpRef.current += e.key;
            setJump(jumpRef.current);
            if (jumpTimer !== null) {
              clearTimeout(jumpTimer);
            }
            jumpTimer = setTimeout(clearJump, JUMP_TIMEOUT_MS);
            break;
          }
          return; // not ours
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (jumpTimer !== null) {
        clearTimeout(jumpTimer);
      }
    };
  }, [deck, tabId]);

  const total = deck?.slides.length ?? 0;
  const shown = total === 0 ? 0 : Math.min(index, total - 1);
  const aspect = deck ? deck.width / deck.height : 16 / 9;

  return (
    <div
      ref={rootRef}
      className="deck-show"
      role="region"
      aria-label={total ? `Slide ${shown + 1} of ${total}` : 'Slide show'}
      tabIndex={0}
      // A click on the right half advances, on the left half goes back —
      // the two gestures a remote or a trackpad tap can make.
      onClick={(e) => {
        if (total === 0) {
          return;
        }
        const half = e.currentTarget.getBoundingClientRect().width / 2;
        setIndex((i) => Math.max(0, Math.min(total - 1, i + (e.clientX < half ? -1 : 1))));
      }}
    >
      {deck && total === 0 && <div className="deck-show-empty">Nothing to show yet.</div>}
      <div
        ref={stageRef}
        className="deck-show-stage"
        style={{ ['--deck-aspect' as string]: String(aspect) }}
        hidden={total === 0}
      />
      {jump.length > 0 && <div className="deck-show-jump">{jump}</div>}
      <div
        className="deck-show-progress"
        style={{ width: total === 0 ? '0%' : `${((shown + 1) / total) * 100}%` }}
      />
    </div>
  );
}
