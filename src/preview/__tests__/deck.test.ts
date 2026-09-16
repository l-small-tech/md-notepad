/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDocModel } from '../../core/doc-model';

// The engine is mocked: these tests are about the pane's DOM and wiring, not
// Marp's output (marp.test.ts covers that). One svg per ruler, the source
// text of each slide as its "markup", so a change is visible in the DOM.
const { renderDeckMock, applyMarpBrowserMock, stopBrowserMock } = vi.hoisted(() => ({
  renderDeckMock: vi.fn(),
  applyMarpBrowserMock: vi.fn(),
  stopBrowserMock: vi.fn(),
}));
vi.mock('../marp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../marp')>();
  return {
    ...actual,
    renderDeck: renderDeckMock,
    applyMarpBrowser: applyMarpBrowserMock,
    createImageResolver: () => async () => null,
  };
});

import { splitSlides } from '../../core/deck';
import { attachDeckPane } from '../deck';

function fakeRender(markdown: string) {
  const lines = markdown.split('\n');
  const slides = splitSlides(markdown).map((r) => ({
    html: `<svg data-marpit-svg="">${lines.slice(r.start - 1, r.end).join('|')}</svg>`,
    notes: lines
      .slice(r.start - 1, r.end)
      .filter((l) => l.startsWith('<!--'))
      .map((l) => l.replace(/<!--\s*|\s*-->/g, '')),
  }));
  return Promise.resolve({ css: '.t{}', slides, width: 1280, height: 720 });
}

const DECK = ['---', 'marp: true', '---', '# One', '<!-- note one -->', '---', '# Two'].join('\n');

function host(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  renderDeckMock.mockReset().mockImplementation((md: string) => fakeRender(md));
  applyMarpBrowserMock.mockReset().mockReturnValue(stopBrowserMock);
  stopBrowserMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('attachDeckPane', () => {
  test('renders one stamped card per slide, numbered, with the slide in a shadow root', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    const cards = el.querySelectorAll<HTMLElement>(':scope > .deck-slide');
    expect(cards).toHaveLength(2);
    expect([...cards].map((c) => c.dataset.line)).toEqual(['4', '6']);
    expect([...cards].map((c) => c.querySelector('.deck-slide-num')!.textContent)).toEqual([
      '1',
      '2',
    ]);
    const frame = cards[0]!.querySelector('.deck-slide-frame')!;
    expect(frame.shadowRoot!.querySelector('div.marpit')!.innerHTML).toContain('# One');
    expect(frame.shadowRoot!.querySelector('style')!.textContent).toContain('.t{}');
    expect(el.classList.contains('deck-pane-read')).toBe(true);
    pane.dispose();
    expect(stopBrowserMock).toHaveBeenCalledTimes(2);
    expect(el.classList.contains('deck-pane')).toBe(false);
  });

  test('shows speaker notes under a slide in Present, and hides the empty ones', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    const notes = el.querySelectorAll<HTMLElement>('.deck-slide-notes');
    expect(notes[0]!.hidden).toBe(false);
    expect(notes[0]!.textContent).toBe('note one');
    expect(notes[1]!.hidden).toBe(true);
    pane.dispose();
  });

  test('Split has no notes element at all', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'split' });
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.deck-slide-notes')).toBeNull();
    pane.dispose();
  });

  test('re-renders 200ms after an edit, reusing the untouched cards and growing by one', async () => {
    const model = createDocModel(DECK);
    const el = host();
    const pane = attachDeckPane(el, model, { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    const before = [...el.querySelectorAll('.deck-slide')];
    const firstStage = before[0]!
      .querySelector('.deck-slide-frame')!
      .shadowRoot!.querySelector('div.marpit')!;

    model.pushText(`${DECK}\n---\n# Three`, 'cm6');
    await vi.advanceTimersByTimeAsync(199);
    expect(el.querySelectorAll('.deck-slide')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    const after = [...el.querySelectorAll('.deck-slide')];
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    // The first slide's markup did not change, so its stage was not rebuilt.
    expect(
      after[0]!.querySelector('.deck-slide-frame')!.shadowRoot!.querySelector('div.marpit'),
    ).toBe(firstStage);
    expect(applyMarpBrowserMock).toHaveBeenCalledTimes(3);
    pane.dispose();
  });

  test('drops cards when slides disappear', async () => {
    const model = createDocModel(DECK);
    const el = host();
    const pane = attachDeckPane(el, model, { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    model.pushText('---\nmarp: true\n---\n# Only', 'cm6');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelectorAll('.deck-slide')).toHaveLength(1);
    expect(stopBrowserMock).toHaveBeenCalledTimes(1);
    pane.dispose();
  });

  test('keeps the last good render when the engine throws', async () => {
    const model = createDocModel(DECK);
    const el = host();
    const pane = attachDeckPane(el, model, { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderDeckMock.mockRejectedValue(new Error('boom'));
    model.pushText('broken', 'cm6');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelectorAll('.deck-slide')).toHaveLength(2);
    spy.mockRestore();
    pane.dispose();
  });

  test('marks the slide under the caret in Split', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'split' });
    await vi.runOnlyPendingTimersAsync();
    const cards = el.querySelectorAll('.deck-slide');
    pane.setCursorLine(7);
    expect(cards[1]!.classList.contains('deck-slide-current')).toBe(true);
    expect(cards[0]!.classList.contains('deck-slide-current')).toBe(false);
    pane.setCursorLine(1); // the frontmatter counts as the first slide
    expect(cards[0]!.classList.contains('deck-slide-current')).toBe(true);
    pane.setCursorLine(null);
    expect(el.querySelector('.deck-slide-current')).toBeNull();
    pane.dispose();
  });

  test('scrollToLine parks the line until the render lands, then maps it to a slide', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'read' });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
    pane.scrollToLine(7); // inside slide 2, before anything rendered
    expect(scrollTo).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // jsdom lays nothing out (every box is empty), so the top line is unknown.
    expect(pane.getTopLine()).toBeNull();
    pane.dispose();
  });

  test('every link click is prevented; http(s) goes to onOpenExternal', async () => {
    const el = host();
    renderDeckMock.mockResolvedValue({
      css: '',
      width: 1280,
      height: 720,
      slides: [
        { html: '<svg data-marpit-svg=""><a href="https://x.test/">x</a></svg>', notes: [] },
      ],
    });
    const onOpenExternal = vi.fn();
    const pane = attachDeckPane(el, createDocModel('---\nmarp: true\n---\n'), {
      variant: 'read',
      onOpenExternal,
    });
    await vi.runOnlyPendingTimersAsync();
    const link = el.querySelector('.deck-slide-frame')!.shadowRoot!.querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    expect(link.dispatchEvent(event)).toBe(false);
    expect(onOpenExternal).toHaveBeenCalledWith('https://x.test/');
    pane.dispose();
  });

  test('review-note markers land on the slide that owns the line', async () => {
    const el = host();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'read' });
    await vi.runOnlyPendingTimersAsync();
    pane.setNotes([
      {
        id: 'n1',
        line: 7,
        text: 'tighten this',
        createdAt: '2026-01-01T00:00:00Z',
      } as unknown as import('../../core/comments').VoiceComment,
    ]);
    const rows = el.querySelectorAll<HTMLElement>('.vn-mark-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset.vnLine).toBe('6');
    expect(rows[0]!.nextElementSibling).toBe(el.querySelectorAll('.deck-slide')[1]);
    pane.dispose();
  });

  test('the hold gesture reports the slide under the pointer while armed', async () => {
    const el = host();
    const onHoldLine = vi.fn();
    const pane = attachDeckPane(el, createDocModel(DECK), { variant: 'read', onHoldLine });
    await vi.runOnlyPendingTimersAsync();
    const second = el.querySelectorAll('.deck-slide')[1]!;
    pane.setLineHold(true);
    second.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(onHoldLine).toHaveBeenCalledWith(6);
    pane.dispose();
  });
});
