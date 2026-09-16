/**
 * The deck pane — a Marp document rendered as slides, in one live surface
 * with two postures (src/preview/README.md "Marp decks"):
 *
 * - `split`: the preview column of Split mode. Each slide is a 16:9 card at
 *   column width; the slide containing the cursor (`setCursorLine`) carries
 *   an accent border and the column scrolls to keep it in view.
 * - `read`: the Present light table. Full-width slides with their number in
 *   the gutter and the speaker notes (Marp's HTML comments) muted under each.
 *
 * Same attach/dispose shape as `pane.ts`, same 200 ms debounce on model
 * change, same render-sequence guard, same `getTopLine` / `scrollToLine`
 * contract for the mode-switch anchor, and the same review-note markers —
 * every slide is a block stamped with the source line it starts on, so the
 * hold gesture, `setNotes`, the composer slot and `revealNotes` work on
 * slides exactly as they do on paragraphs.
 *
 * Every slide's markup lives in its own shadow root (`mountSlide`) with the
 * theme stylesheet: Marp's `section` rules and the app's monospace-everywhere
 * rules never meet. The wrappers around them are ordinary light DOM, which is
 * what lets the note markers and the scroll anchor treat a slide as a block.
 */

import type { VoiceComment } from '../core/comments';
import { slideIndexForLine, splitSlides, type SlideRange } from '../core/deck';
import type { DocModel } from '../core/doc-model';
import { isExternalHref } from '../core/external-links';
import { stampedLineFor } from '../core/mode-scroll';
import { blockLineFor, notesByBlock } from '../core/note-marks';
import { extractOutline } from '../core/outline';
import { dirName } from '../core/session/plan-flush';
import {
  applyMarpBrowser,
  createImageResolver,
  inlineDeckImages,
  mountSlide,
  renderDeck,
  type DeckRender,
} from './marp';
import {
  buildCallout,
  buildMark,
  CALLOUT_CLASS,
  COMPOSER_CLASS,
  confirmDelete,
  fitNoteBoxes,
  MARK_CLASS,
  noteEditFromEvent,
} from './note-marks';
import { createRenderSequence } from './pipeline';

const RENDER_DEBOUNCE_MS = 200;
/** How long a `scrollToLine` keeps re-pinning its slide (images land late). */
const SCROLL_SETTLE_MS = 1500;
const HOLD_MS = 500;
const HOLD_SLOP_PX = 10;

export interface DeckPaneOptions {
  /** The posture: Split's preview column, or the Present light table. */
  variant: 'split' | 'read';
  /** Path of the document, for relative images and a `theme: ./x.css`. */
  docPath?: string | null;
  /** An `http(s)` link inside a slide was clicked (see `pane.ts`). */
  onOpenExternal?: (url: string) => void;
  /** The press-and-hold gesture on a slide: its first source line. */
  onHoldLine?: (line: number) => void;
  onEditNote?: (id: string, text: string) => void;
  onDeleteNote?: (id: string) => void;
  onOpenAllNotes?: () => void;
}

export interface DeckPane {
  /** The document's path changed (an untitled note was saved). */
  setDocPath(docPath: string | null | undefined): void;
  /**
   * The source editor's caret moved to this line: the slide containing it is
   * marked current and kept in view (Split only; the light table has no
   * cursor). Null clears the mark.
   */
  setCursorLine(line: number | null): void;
  /** The outline panel's jump: the slide holding the nth heading. */
  scrollToHeading(index: number): void;
  /** The 0-based slide at the top of the pane, for the full-screen show. */
  getTopSlide(): number;
  /** Put slide `index` at the top of the pane. */
  scrollToSlide(index: number): void;
  setLineHold(on: boolean): void;
  setNotes(notes: readonly VoiceComment[]): void;
  mountComposer(line: number, slot: HTMLElement): void;
  unmountComposer(): void;
  revealNotes(target: { line: number }): void;
  getTopLine(): number | null;
  scrollToLine(line: number): void;
  dispose(): void;
}

/** One slide wrapper and the pieces the render loop updates in place. */
interface SlideCard {
  wrapper: HTMLDivElement;
  number: HTMLDivElement;
  root: ShadowRoot;
  notes: HTMLDivElement | null;
  stopBrowser: () => void;
}

export function attachDeckPane(
  host: HTMLElement,
  model: DocModel,
  options: DeckPaneOptions,
): DeckPane {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sequence = createRenderSequence();
  let docPath = options.docPath ?? null;
  const resolveImage = createImageResolver();
  const cards: SlideCard[] = [];
  let ranges: SlideRange[] = splitSlides(model.getText());
  let cursorSlide: number | null = null;
  /** Set once the first render has put slides on screen. */
  let rendered = false;

  host.classList.add('deck-pane', `deck-pane-${options.variant}`);
  // The host is React's, and React keeps the same element across a Split ⇄
  // Present switch: whatever the previous pane left behind goes first.
  host.replaceChildren();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function createCard(): SlideCard {
    const doc = host.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'deck-slide';
    const number = doc.createElement('div');
    number.className = 'deck-slide-num';
    number.setAttribute('aria-hidden', 'true');
    const frame = doc.createElement('div');
    frame.className = 'deck-slide-frame';
    const root = frame.attachShadow({ mode: 'open' });
    wrapper.append(number, frame);
    let notes: HTMLDivElement | null = null;
    if (options.variant === 'read') {
      notes = doc.createElement('div');
      notes.className = 'deck-slide-notes';
      wrapper.appendChild(notes);
    }
    return { wrapper, number, root, notes, stopBrowser: applyMarpBrowser(root) };
  }

  /**
   * Bring the cards in line with a render: reuse wrappers by position (an
   * unchanged slide is not touched, so a deck being written slide by slide
   * grows without the earlier slides so much as flickering), drop extras,
   * append new ones.
   */
  function applyRender(deck: DeckRender): void {
    const docDir = docPath ? dirName(docPath) : null;
    while (cards.length > deck.slides.length) {
      const card = cards.pop()!;
      card.stopBrowser();
      card.wrapper.remove();
    }
    deck.slides.forEach((slide, i) => {
      let card = cards[i];
      if (!card) {
        card = createCard();
        cards.push(card);
        host.appendChild(card.wrapper);
      }
      const range = ranges[i] ?? ranges[ranges.length - 1];
      card.wrapper.dataset.line = String(range?.start ?? 1);
      card.wrapper.dataset.slide = String(i);
      card.number.textContent = String(i + 1);
      if (mountSlide(card.root, deck.css, slide.html)) {
        void inlineDeckImages(card.root, docDir, resolveImage);
      }
      if (card.notes) {
        const text = slide.notes.join('\n\n');
        if (card.notes.dataset.text !== text) {
          card.notes.dataset.text = text;
          card.notes.replaceChildren(
            ...slide.notes.map((note) => {
              const p = host.ownerDocument.createElement('p');
              p.textContent = note;
              return p;
            }),
          );
        }
        card.notes.hidden = slide.notes.length === 0;
      }
    });
    rendered = true;
  }

  async function render(): Promise<void> {
    const token = sequence.start();
    const text = model.getText();
    const nextRanges = splitSlides(text);
    let deck: DeckRender;
    try {
      deck = await renderDeck(text, { docPath });
    } catch (error) {
      console.error('[deck] render failed', error);
      return; // keep the last good render on screen (never break mid-edit)
    }
    if (disposed || !sequence.isCurrent(token)) {
      return;
    }
    ranges = nextRanges;
    applyRender(deck);
    applyNotes();
    applyCursor(false);
    applyPendingScroll();
  }

  function scheduleRender(): void {
    clearTimer();
    timer = setTimeout(() => void render(), RENDER_DEBOUNCE_MS);
  }

  /* ---- cursor follows slide (Split) ----------------------------------- */

  function applyCursor(scroll: boolean): void {
    for (const card of cards) {
      card.wrapper.classList.toggle(
        'deck-slide-current',
        cursorSlide !== null && Number(card.wrapper.dataset.slide) === cursorSlide,
      );
    }
    const wrapper = cursorSlide === null ? null : cards[cursorSlide]?.wrapper;
    if (scroll && wrapper && typeof wrapper.scrollIntoView === 'function') {
      wrapper.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /* ---- review-note markers (same shape as pane.ts) --------------------- */
  let notes: readonly VoiceComment[] = [];
  const expandedBlocks = new Set<number>();
  let flashBlock: number | null = null;
  let pendingReveal: number | null = null;
  let composerSlot: HTMLElement | null = null;
  let composerLine: number | null = null;

  function blockLines(): number[] {
    return cards.map((c) => Number(c.wrapper.dataset.line));
  }

  function blockAt(line: number): HTMLElement | null {
    return cards.find((c) => Number(c.wrapper.dataset.line) === line)?.wrapper ?? null;
  }

  function applyNotes(): void {
    for (const el of host.querySelectorAll(`:scope > .vn-mark-row, :scope > .${CALLOUT_CLASS}`)) {
      el.remove();
    }
    const lines = blockLines();
    const grouped = notesByBlock(notes, lines);
    const doc = host.ownerDocument;
    const actions = {
      edit: options.onEditNote !== undefined,
      remove: options.onDeleteNote !== undefined,
      all: options.onOpenAllNotes !== undefined,
    };
    for (const card of cards) {
      const line = Number(card.wrapper.dataset.line);
      const own = grouped.get(line);
      if (!own) {
        continue;
      }
      grouped.delete(line);
      const expanded = expandedBlocks.has(line);
      const row = doc.createElement('div');
      row.className = 'vn-mark-row';
      row.dataset.vnLine = String(line);
      row.appendChild(buildMark(doc, own.length, expanded));
      card.wrapper.before(row);
      if (expanded) {
        const callout = buildCallout(doc, own, actions);
        if (flashBlock === line) {
          callout.classList.add('vn-flash');
          flashBlock = null;
        }
        (composerSlot?.previousElementSibling === card.wrapper ? composerSlot : card.wrapper).after(
          callout,
        );
        fitNoteBoxes(callout);
      }
    }
    if (composerSlot && composerLine !== null) {
      const owner = blockLineFor(composerLine, lines);
      const block = owner === undefined ? null : blockAt(owner);
      if (block) {
        if (composerSlot.previousElementSibling !== block) {
          block.after(composerSlot);
        }
      } else if (composerSlot.parentElement !== host) {
        host.appendChild(composerSlot);
      }
    }
    if (pendingReveal !== null && lines.length > 0) {
      const line = pendingReveal;
      pendingReveal = null;
      revealNotes(line);
    }
  }

  function revealNotes(line: number): void {
    const owner = blockLineFor(line, blockLines());
    if (owner === undefined) {
      pendingReveal = line;
      return;
    }
    expandedBlocks.add(owner);
    flashBlock = owner;
    applyNotes();
    blockAt(owner)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---- mode-switch scroll anchor -------------------------------------- */
  let pendingScroll: number | null = null;
  let pendingScrollUntil = 0;

  function topCard(): SlideCard | null {
    const box = host.getBoundingClientRect();
    if (box.height === 0) {
      return null;
    }
    for (const card of cards) {
      if (card.wrapper.getBoundingClientRect().bottom > box.top + 1) {
        return card;
      }
    }
    return cards[0] ?? null;
  }

  function scrollCardToTop(card: SlideCard): void {
    host.scrollTo({
      top:
        host.scrollTop +
        card.wrapper.getBoundingClientRect().top -
        host.getBoundingClientRect().top,
      behavior: 'instant',
    });
  }

  function applyPendingScroll(): void {
    if (pendingScroll === null) {
      return;
    }
    if (Date.now() > pendingScrollUntil) {
      pendingScroll = null;
      return;
    }
    const target = stampedLineFor(blockLines(), pendingScroll);
    const card =
      target === null ? null : cards.find((c) => Number(c.wrapper.dataset.line) === target);
    if (card) {
      scrollCardToTop(card);
    }
  }

  function dropPendingScroll(): void {
    pendingScroll = null;
  }

  /* ---- events ---------------------------------------------------------- */

  function onNoteClick(el: Element): boolean {
    const mark = el.closest<HTMLElement>(`.${MARK_CLASS}`);
    if (mark) {
      const line = Number(mark.parentElement?.dataset.vnLine);
      if (!Number.isNaN(line)) {
        if (expandedBlocks.has(line)) {
          expandedBlocks.delete(line);
        } else {
          expandedBlocks.add(line);
        }
        applyNotes();
      }
      return true;
    }
    const del = el.closest<HTMLElement>('[data-vn-delete]');
    if (del) {
      if (confirmDelete(del, window) && del.dataset.vnDelete) {
        options.onDeleteNote?.(del.dataset.vnDelete);
      }
      return true;
    }
    if (el.closest('[data-vn-all]')) {
      options.onOpenAllNotes?.();
      return true;
    }
    return false;
  }

  function inNoteUi(target: EventTarget | null): boolean {
    return (
      target instanceof Element && target.closest(`.${COMPOSER_CLASS}, .${CALLOUT_CLASS}`) !== null
    );
  }

  function onClick(event: MouseEvent): void {
    // Inside a slide the event is retargeted to the frame; the composed path
    // still starts at the real element behind the shadow boundary.
    const origin = event.composedPath()[0];
    const el = origin instanceof Element ? origin : (event.target as Element);
    if (onNoteClick(el)) {
      event.preventDefault();
      return;
    }
    if (inNoteUi(el)) {
      return;
    }
    const anchor = el.closest('a');
    if (!anchor) {
      return;
    }
    // The window must never navigate (README "Link policy").
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (isExternalHref(href)) {
      options.onOpenExternal?.(href);
    }
  }

  function onChange(event: Event): void {
    const edit = noteEditFromEvent(event);
    if (edit) {
      options.onEditNote?.(edit.id, edit.text);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey) &&
      event.target instanceof HTMLTextAreaElement &&
      event.target.classList.contains('vn-note-text')
    ) {
      event.preventDefault();
      event.target.blur();
    }
  }

  /* ---- press-and-hold (review notes on a slide) ------------------------ */
  let holdArmed = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdX = 0;
  let holdY = 0;
  let holdTarget: Element | null = null;

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  /** The slide under a press: the wrapper the target sits in, else the nearest above. */
  function lineAtPoint(target: Element | null, y: number): number | null {
    const wrapper = target?.closest<HTMLElement>('.deck-slide');
    if (wrapper && host.contains(wrapper)) {
      return Number(wrapper.dataset.line);
    }
    let best: SlideCard | null = null;
    for (const card of cards) {
      if (card.wrapper.getBoundingClientRect().top <= y) {
        best = card;
      } else {
        break;
      }
    }
    return best ? Number(best.wrapper.dataset.line) : null;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!holdArmed || !options.onHoldLine || inNoteUi(event.target)) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    holdX = event.clientX;
    holdY = event.clientY;
    holdTarget = event.target instanceof Element ? event.target : null;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (disposed) {
        return;
      }
      const line = lineAtPoint(holdTarget, holdY);
      if (line !== null) {
        options.onHoldLine?.(line);
      }
    }, HOLD_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (
      holdTimer !== null &&
      (Math.abs(event.clientX - holdX) > HOLD_SLOP_PX ||
        Math.abs(event.clientY - holdY) > HOLD_SLOP_PX)
    ) {
      clearHold();
    }
  }

  function onContextMenu(event: MouseEvent): void {
    if (holdArmed) {
      event.preventDefault();
    }
  }

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', clearHold);
  host.addEventListener('pointercancel', clearHold);
  host.addEventListener('pointerleave', clearHold);
  host.addEventListener('wheel', dropPendingScroll, { passive: true });
  host.addEventListener('touchmove', dropPendingScroll, { passive: true });
  host.addEventListener('keydown', dropPendingScroll);
  const unsubscribe = model.subscribe(scheduleRender);
  void render();

  return {
    setDocPath(next) {
      const path = next ?? null;
      if (disposed || path === docPath) {
        return;
      }
      docPath = path;
      clearTimer();
      void render();
    },
    setCursorLine(line) {
      if (disposed) {
        return;
      }
      const next = line === null ? null : slideIndexForLine(ranges, line);
      if (next === cursorSlide) {
        return;
      }
      cursorSlide = next;
      applyCursor(true);
    },
    scrollToHeading(index) {
      if (disposed || index < 0) {
        return;
      }
      const heading = extractOutline(model.getText())[index];
      if (heading) {
        cards[slideIndexForLine(ranges, heading.line)]?.wrapper.scrollIntoView({
          block: 'start',
          behavior: 'auto',
        });
      }
    },
    getTopSlide() {
      const card = disposed ? null : topCard();
      return card ? Number(card.wrapper.dataset.slide) : 0;
    },
    scrollToSlide(index) {
      const card = cards[index];
      if (!disposed && card) {
        scrollCardToTop(card);
      }
    },
    setLineHold(on) {
      holdArmed = on;
      clearHold();
      if (on) {
        host.dataset.lineHold = '';
      } else {
        delete host.dataset.lineHold;
      }
    },
    setNotes(next) {
      if (disposed || next === notes) {
        return;
      }
      notes = next;
      applyNotes();
    },
    mountComposer(line, slot) {
      if (disposed || (slot === composerSlot && line === composerLine)) {
        return;
      }
      composerSlot?.remove();
      composerSlot = slot;
      composerLine = line;
      slot.classList.add(COMPOSER_CLASS);
      applyNotes();
    },
    unmountComposer() {
      if (!composerSlot) {
        return;
      }
      composerSlot.remove();
      composerSlot = null;
      composerLine = null;
    },
    revealNotes(target) {
      if (!disposed) {
        revealNotes(target.line);
      }
    },
    getTopLine() {
      if (disposed || !rendered) {
        return null;
      }
      const card = topCard();
      return card ? Number(card.wrapper.dataset.line) : null;
    },
    scrollToLine(line) {
      if (disposed) {
        return;
      }
      pendingScroll = line;
      pendingScrollUntil = Date.now() + SCROLL_SETTLE_MS;
      applyPendingScroll();
    },
    dispose() {
      disposed = true;
      clearTimer();
      clearHold();
      unsubscribe();
      composerSlot?.remove();
      for (const card of cards) {
        card.stopBrowser();
        card.wrapper.remove();
      }
      for (const el of host.querySelectorAll(`:scope > .vn-mark-row, :scope > .${CALLOUT_CLASS}`)) {
        el.remove();
      }
      host.classList.remove('deck-pane', `deck-pane-${options.variant}`);
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', clearHold);
      host.removeEventListener('pointercancel', clearHold);
      host.removeEventListener('pointerleave', clearHold);
      host.removeEventListener('wheel', dropPendingScroll);
      host.removeEventListener('touchmove', dropPendingScroll);
      host.removeEventListener('keydown', dropPendingScroll);
    },
  };
}
