/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_REVIEW_STATE,
  reduceReview,
  type ReviewAction,
} from '../../core/code/review-state';
import { createDocModel } from '../../core/doc-model';

const { renderMermaidBlocksMock } = vi.hoisted(() => ({ renderMermaidBlocksMock: vi.fn() }));
vi.mock('../mermaid', () => ({ renderMermaidBlocks: renderMermaidBlocksMock }));

import { attachCodeReviewPane, highlightLines } from '../code-review';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', '..', 'core', 'code', '__tests__', 'fixtures', name), 'utf8');

function host(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'preview reader-preview';
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  renderMermaidBlocksMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** Attach with a store-like loop: every action is reduced and pushed back. */
function attach(
  text: string,
  path: string,
  extra: Partial<Parameters<typeof attachCodeReviewPane>[2]> = {},
) {
  const el = host();
  const model = createDocModel(text);
  let state = DEFAULT_REVIEW_STATE;
  const actions: ReviewAction[] = [];
  const pane = attachCodeReviewPane(el, model, {
    dark: false,
    path,
    onAction: (a) => {
      actions.push(a);
      state = reduceReview(state, a);
      pane.setState(state);
    },
    ...extra,
  });
  return { el, model, pane, actions, state: () => state };
}

describe('attachCodeReviewPane', () => {
  test('renders the header, chips, imports card and one card per unit for text-files.ts', async () => {
    const { el, pane } = attach(fixture('text-files.ts.txt'), 'C:\\proj\\src\\core\\text-files.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-file')?.textContent).toBe('text-files.ts');
    expect([...el.querySelectorAll('.cr-view')].map((b) => b.textContent)).toEqual([
      'Cards',
      'Calls',
      'Changes',
    ]);
    expect(el.querySelector('#cr-baseline-slot')).not.toBeNull();
    expect([...el.querySelectorAll('.cr-chip')].map((b) => b.textContent)).toEqual([
      'All',
      'Exported',
      'Changed',
      'Functions',
      'Types',
    ]);
    // Changes / Changed wait for a baseline (the later step).
    expect(el.querySelector<HTMLButtonElement>('.cr-chip[data-filter="changed"]')?.disabled).toBe(
      true,
    );
    expect(el.querySelector<HTMLButtonElement>('.cr-view[data-view="changes"]')?.disabled).toBe(
      true,
    );
    expect(el.querySelector('.cr-imports')?.textContent).toContain(
      'Uses 1 thing from this app (./tab-workspaces: pathKey).',
    );
    const cards = [...el.querySelectorAll<HTMLElement>('.cr-deck > .cr-card')];
    expect(cards.map((c) => c.dataset.unitId)).toEqual([
      'function:isMarkdownPath',
      'function:isEditableTextPath',
      'function:dirKey',
      'function:isAtOrBelow',
      'function:showAllFilesState',
      'function:showsAllFiles',
      'function:toggleShowAllFiles',
    ]);
    // Hold-gesture anchors: the signature line, not the doc comment's.
    expect(cards[0]!.dataset.line).toBe('13');
    const first = cards[0]!;
    expect(first.querySelector('.cr-glyph')?.textContent).toBe('ƒ');
    expect(first.querySelector('.cr-tag-exported')).not.toBeNull();
    expect(first.querySelector('.cr-sentence')?.textContent).toBe(
      'isMarkdownPath takes a file name, and gives back yes or no.',
    );
    expect(first.querySelector('.cr-signature')?.textContent).toBe(
      'export function isMarkdownPath(name: string): boolean',
    );
    expect(first.querySelector('.cr-doc')?.innerHTML).toContain('True for markdown files');
    expect(first.querySelector('.cr-facts')?.textContent).toBe('used by isEditableTextPath');
    expect(cards[4]!.querySelector('.cr-facts')?.textContent).toBe(
      'calls dirKey, isAtOrBelow · used by showsAllFiles',
    );
    // Size dots: the heaviest unit fills all four.
    expect(cards[4]!.querySelector('.cr-size')?.textContent).toBe('▪▪▪▪');
    // Flow only where there is a branch or loop.
    expect(cards[0]!.querySelector('[data-expander="flow"]')).toBeNull();
    expect(cards[4]!.querySelector('[data-expander="flow"]')).not.toBeNull();
    expect(el.querySelector('.cr-warn')).toBeNull();
    pane.dispose();
  });

  test('the Code expander opens the x-ray for a long unit; a fold opens one level; short units show everything', async () => {
    const { el, pane, actions } = attach(fixture('text-files.ts.txt'), 'text-files.ts');
    await vi.runOnlyPendingTimersAsync();
    const card = el.querySelector<HTMLElement>('[data-unit-id="function:showAllFilesState"]')!;
    click(card.querySelector('[data-expander="code"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(actions[0]).toEqual({
      type: 'toggle-expander',
      unitId: 'function:showAllFilesState',
      expander: 'code',
    });
    const source = card.querySelector('.cr-source')!;
    expect(source.querySelectorAll('.cr-line').length).toBeGreaterThan(3);
    const folds = source.querySelectorAll<HTMLElement>('.cr-xray-fold');
    expect(folds.length).toBeGreaterThan(0);
    expect(folds[0]!.textContent).toMatch(/^⋯ \d+ lines$/);
    // Highlighted, with the shared token classes.
    expect(source.querySelector('.cr-tok-keyword')).not.toBeNull();
    click(folds[0]!);
    await vi.runOnlyPendingTimersAsync();
    expect(actions[1]).toMatchObject({ type: 'open-xray', unitId: 'function:showAllFilesState' });
    const after = card.querySelectorAll('.cr-xray-fold').length;
    expect(card.querySelectorAll('.cr-line').length).toBeGreaterThan(3);
    expect(after).toBeLessThanOrEqual(folds.length + 3); // opened one level, not everything
    click(card.querySelector('[data-xray-all]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(card.querySelector('.cr-xray-fold')).toBeNull();
    expect(card.querySelector('[data-xray-all]')).toBeNull();

    // A short unit skips the x-ray entirely.
    const short = el.querySelector<HTMLElement>('[data-unit-id="function:isMarkdownPath"]')!;
    click(short.querySelector('[data-expander="code"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(short.querySelector('.cr-xray-fold')).toBeNull();
    expect(short.querySelectorAll('.cr-line')).toHaveLength(5);
    // Tapping the open pill closes it.
    click(short.querySelector('[data-expander="code"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(short.querySelector('.cr-source')).toBeNull();
    pane.dispose();
  });

  test('the Flow expander renders mermaid; the Calls view draws the call graph and node taps scroll to cards', async () => {
    const { el, pane, state } = attach(fixture('text-files.ts.txt'), 'text-files.ts');
    await vi.runOnlyPendingTimersAsync();
    const card = el.querySelector<HTMLElement>('[data-unit-id="function:showAllFilesState"]')!;
    click(card.querySelector('[data-expander="flow"]')!);
    await vi.runOnlyPendingTimersAsync();
    const flow = card.querySelector('.cr-flow code.language-mermaid')!;
    expect(flow.textContent).toContain('flowchart TD');
    expect(flow.textContent).toContain('subgraph sg0["consider (inner)"]');
    expect(renderMermaidBlocksMock).toHaveBeenCalled();

    click(el.querySelector('.cr-view[data-view="calls"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(state().view).toBe('calls');
    const calls = el.querySelector('.cr-calls code.language-mermaid')!;
    expect(calls.textContent).toContain('showAllFilesState --> dirKey');
    expect(el.querySelector('.cr-deck')).toBeNull();

    // Simulate mermaid's output: a diagram with a node whose id carries ours.
    const pre = calls.parentElement!;
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-diagram';
    wrap.innerHTML =
      '<svg><g class="node" id="mermaid-3-flowchart-showAllFilesState-7"><rect></rect></g><rect id="bg"></rect></svg>';
    pre.replaceWith(wrap);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    click(wrap.querySelector('#mermaid-3-flowchart-showAllFilesState-7 rect')!);
    await vi.advanceTimersByTimeAsync(10); // the render lands; the 1.2 s flash timer does not
    expect(state().view).toBe('cards');
    expect(scrollIntoView).toHaveBeenCalled();
    expect(
      el
        .querySelector('[data-unit-id="function:showAllFilesState"]')
        ?.classList.contains('cr-card-flash'),
    ).toBe(true);
    pane.dispose();
  });

  test('a tap on a diagram background hands the SVG to onOpenDiagram', async () => {
    const onOpenDiagram = vi.fn();
    const { el, pane } = attach(fixture('text-files.ts.txt'), 'text-files.ts', { onOpenDiagram });
    await vi.runOnlyPendingTimersAsync();
    click(el.querySelector('.cr-view[data-view="calls"]')!);
    await vi.runOnlyPendingTimersAsync();
    const pre = el.querySelector('.cr-calls pre')!;
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-diagram';
    wrap.innerHTML = '<svg id="s"><rect id="bg"></rect></svg>';
    pre.replaceWith(wrap);
    click(wrap.querySelector('#bg')!);
    expect(onOpenDiagram).toHaveBeenCalledWith('<svg id="s"><rect id="bg"></rect></svg>');
    pane.dispose();
  });

  test('filter chips narrow the deck; containers survive when a child matches', async () => {
    const src = `export class Box {\n  grow() {}\n}\nexport interface Shape { id: string }\nfunction helper() {}\n`;
    const { el, pane } = attach(src, 'x.ts');
    await vi.runOnlyPendingTimersAsync();
    const ids = () =>
      [...el.querySelectorAll<HTMLElement>('.cr-card[data-unit-id]')].map((c) => c.dataset.unitId);
    expect(ids()).toEqual(['class:Box', 'method:Box.grow', 'interface:Shape', 'function:helper']);
    click(el.querySelector('.cr-chip[data-filter="functions"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(ids()).toEqual(['class:Box', 'method:Box.grow', 'function:helper']);
    click(el.querySelector('.cr-chip[data-filter="types"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(ids()).toEqual(['class:Box', 'interface:Shape']);
    click(el.querySelector('.cr-chip[data-filter="exported"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(ids()).toEqual(['class:Box', 'method:Box.grow', 'interface:Shape']);
    // A form for the interface.
    const form = el.querySelector('[data-unit-id="interface:Shape"] .cr-form')!;
    expect(form.textContent).toContain('id');
    expect(form.textContent).toContain('text'); // `id: string` — the type rule
    pane.dispose();
  });

  test('re-parses on model change after the 200 ms debounce, keeping the state', async () => {
    const { el, model, pane } = attach('export function a() {}\n', 'x.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelectorAll('.cr-card[data-unit-id]')).toHaveLength(1);
    model.pushText('export function a() {}\nexport function b() { a(); }\n', 'cm6');
    await vi.advanceTimersByTimeAsync(150);
    expect(el.querySelectorAll('.cr-card[data-unit-id]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(el.querySelectorAll('.cr-card[data-unit-id]')).toHaveLength(2);
    expect(el.querySelector('[data-unit-id="function:a"] .cr-facts')?.textContent).toBe(
      'used by b',
    );
    pane.dispose();
  });

  test('a file Review cannot read gets a note; parse errors get a soft warning; a huge file an outline', async () => {
    const { el, pane } = attach('{ "a": 1 }', 'x.json');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-empty')?.textContent).toContain('only has a source view');
    expect(el.querySelector('.cr-chips')).toBeNull();
    pane.dispose();

    const broken = attach('export function (: {\nexport function ok() {}', 'y.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(broken.el.querySelector('.cr-warn')?.textContent).toContain('did not parse cleanly');
    broken.pane.dispose();

    const huge = `export function a() {}\nfunction b() {}\n${'\n'.repeat(5100)}`;
    const big = attach(huge, 'z.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(big.el.querySelector('.cr-note-large')?.textContent).toContain('Large file');
    const ids = [...big.el.querySelectorAll<HTMLElement>('.cr-card[data-unit-id]')].map(
      (c) => c.dataset.unitId,
    );
    expect(ids).toEqual(['function:a']);
    expect(big.el.querySelector('.cr-expanders')).toBeNull();
    big.pane.dispose();
  });

  test('press-and-hold on a card fires onHoldUnit only while armed, with the unit and model', async () => {
    const onHoldUnit = vi.fn();
    const { el, pane } = attach(fixture('text-files.ts.txt'), 'text-files.ts', { onHoldUnit });
    await vi.runOnlyPendingTimersAsync();
    const name = el.querySelector('[data-unit-id="function:dirKey"] .cr-name')!;
    const press = () => {
      name.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }),
      );
      vi.advanceTimersByTime(600);
    };
    press();
    expect(onHoldUnit).not.toHaveBeenCalled();
    pane.setLineHold(true);
    expect(el.dataset.lineHold).toBe('');
    press();
    expect(onHoldUnit).toHaveBeenCalledTimes(1);
    const [unit, model] = onHoldUnit.mock.calls[0]!;
    expect(unit.name).toBe('dirKey');
    expect(unit.signatureLine).toBe(24);
    expect(model.identifiers).toContain('showAllFilesState');
    // Drift cancels; release cancels.
    name.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }),
    );
    name.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 }),
    );
    vi.advanceTimersByTime(600);
    expect(onHoldUnit).toHaveBeenCalledTimes(1);
    // Armed, the context menu is swallowed.
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(name.dispatchEvent(ctx)).toBe(false);
    pane.setLineHold(false);
    expect(el.dataset.lineHold).toBeUndefined();
    pane.dispose();
    expect(el.classList.contains('cr-host')).toBe(false);
  });

  test('without onAction the pane keeps its own state', async () => {
    const el = host();
    const pane = attachCodeReviewPane(
      el,
      createDocModel('export function a() { if (x) { y(); } }'),
      {
        dark: false,
        path: 'x.ts',
      },
    );
    await vi.runOnlyPendingTimersAsync();
    click(el.querySelector('[data-expander="flow"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-flow')).not.toBeNull();
    pane.setDark(true);
    await vi.runOnlyPendingTimersAsync();
    expect(renderMermaidBlocksMock).toHaveBeenLastCalledWith(expect.anything(), { dark: true });
    pane.dispose();
  });
});

describe('highlightLines', () => {
  test('one HTML string per source line, tokens split at newlines, text escaped', () => {
    const lines = highlightLines('/* a\n b */ const x = "<y>";\n', 'x.ts');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('<span class="cr-tok-comment">/* a</span>');
    expect(lines[1]).toContain('<span class="cr-tok-comment"> b */</span>');
    expect(lines[1]).toContain('<span class="cr-tok-keyword">const</span>');
    expect(lines[1]).toContain('<span class="cr-tok-string">&quot;&lt;y&gt;&quot;</span>');
    expect(lines[2]).toBe('');
  });

  test('Rust files use the Rust grammar', () => {
    const [line] = highlightLines('pub fn main() {}', 'm.rs');
    expect(line).toContain('<span class="cr-tok-keyword">fn</span>');
    expect(line).toContain('<span class="cr-tok-def">main</span>');
  });
});

describe('review-note markers on cards', () => {
  const notes = [
    {
      id: 'n1',
      file: 'text-files.ts',
      line: 24,
      quote: '',
      time: '2026-01-01T00:00:00.000Z',
      transcript: 'rename <me>',
      unit: 'dirKey (function)',
    },
    {
      id: 'n2',
      file: 'text-files.ts',
      line: 24,
      quote: '',
      time: '2026-01-01T00:00:00.000Z',
      transcript: 'elsewhere',
      unit: 'other (function)',
    },
  ];

  test('a card whose declaration has notes gets a marker; a tap expands them without toggling the card', async () => {
    const onOpenUnitNotes = vi.fn();
    const { el, pane, actions, model } = attach(fixture('text-files.ts.txt'), 'text-files.ts', {
      onOpenUnitNotes,
    });
    await vi.runOnlyPendingTimersAsync();
    pane.setNotes(notes);
    const marks = el.querySelectorAll('.vn-mark');
    expect(marks).toHaveLength(1);
    const card = el.querySelector('[data-unit-id="function:dirKey"]')!;
    expect(marks[0]!.closest('.cr-card')).toBe(card);
    expect(marks[0]!.closest('.cr-card-head')).not.toBeNull();
    expect(marks[0]!.querySelector('.vn-mark-count')?.textContent).toBe('1');

    click(marks[0]!);
    expect(actions).toEqual([]); // the head's own toggle did not fire
    const callout = card.querySelector(':scope > .vn-callout')!;
    expect(callout.querySelector('.vn-note-text')?.textContent).toBe('rename <me>');
    expect(callout.previousElementSibling?.classList.contains('cr-card-head')).toBe(true);

    click(callout.querySelector('[data-vn-open]')!);
    expect(onOpenUnitNotes).toHaveBeenCalledTimes(1);
    expect(onOpenUnitNotes.mock.calls[0]![0].name).toBe('dirKey');

    // Still open after a re-parse; gone once the list is empty.
    model.pushText(model.getText() + '\n', 'cm6');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.vn-callout')).not.toBeNull();
    pane.setNotes([]);
    expect(el.querySelector('.vn-mark, .vn-callout')).toBeNull();
  });
});
