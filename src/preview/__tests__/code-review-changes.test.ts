/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { changeMap } from '../../core/code/changes';
import { parseCode } from '../../core/code/parse';
import {
  DEFAULT_REVIEW_STATE,
  reduceReview,
  type ReviewAction,
} from '../../core/code/review-state';
import { diffLines } from '../../core/diff';
import { createDocModel } from '../../core/doc-model';

const { renderMermaidBlocksMock } = vi.hoisted(() => ({ renderMermaidBlocksMock: vi.fn() }));
vi.mock('../mermaid', () => ({ renderMermaidBlocks: renderMermaidBlocksMock }));

import { attachCodeReviewPane } from '../code-review';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', '..', 'core', 'code', '__tests__', 'fixtures', name), 'utf8');

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

function attach(
  text: string,
  path: string,
  extra: Partial<Parameters<typeof attachCodeReviewPane>[2]> = {},
) {
  const el = document.createElement('div');
  el.className = 'preview reader-preview';
  document.body.appendChild(el);
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

const current = fixture('text-files.ts.txt');

/** The fixture with one function dropped, one parameter removed and one extra function. */
function baseline(): string {
  return (
    current
      .replace(/export function isMarkdownPath[\s\S]*?\n}\n/, '')
      .replace('hiddenDirs: readonly string[] = [],\n', '')
      // Between two declarations, so the deletion gap badges neither neighbour.
      .replace(
        '/** Comparable folder key',
        'export function oldHelper(a: number): number {\n  return a;\n}\n\n/** Comparable folder key',
      )
  );
}

function changesFor(base: string | null, text: string) {
  const model = parseCode(text, 'text-files.ts')!;
  return changeMap(
    base === null ? null : parseCode(base, 'text-files.ts'),
    model,
    diffLines(base ?? '', text),
  );
}

describe('what changed', () => {
  test('setGitInfo fills the slot: the picker ("this branch" only with a merge-base), or the hint', async () => {
    const { el, pane, actions } = attach(current, 'text-files.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('#cr-baseline-slot')?.innerHTML).toBe('');
    expect(el.querySelector<HTMLButtonElement>('.cr-chip[data-filter="changed"]')?.title).toBe(
      'Waiting for git',
    );

    pane.setGitInfo({ available: false, hint: 'Git not found' });
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('#cr-baseline-slot .cr-git-hint')?.textContent).toBe('Git not found');
    expect(el.querySelector('.cr-baseline-select')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('.cr-chip[data-filter="changed"]')?.title).toBe(
      'Git not found',
    );

    pane.setGitInfo({
      available: true,
      branch: 'development',
      baseBranch: 'development',
      baseRef: null,
    });
    const noBase = el.querySelector<HTMLSelectElement>('.cr-baseline-select')!;
    expect([...noBase.options].map((o) => o.value)).toEqual(['uncommitted', 'last-commit']);

    pane.setGitInfo({
      available: true,
      branch: 'feat/x',
      baseBranch: 'development',
      baseRef: '3c77f30',
    });
    const select = el.querySelector<HTMLSelectElement>('.cr-baseline-select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'this branch (vs development)',
      'uncommitted',
      'last commit',
    ]);
    select.value = 'last-commit';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions.at(-1)).toEqual({ type: 'baseline', baseline: 'last-commit' });
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector<HTMLSelectElement>('.cr-baseline-select')?.value).toBe('last-commit');
    pane.dispose();
  });

  test('setChanges badges cards, notes the signature change, ghosts removed units, counts the chip', async () => {
    const { el, pane } = attach(current, 'text-files.ts');
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-badge')).toBeNull();
    pane.setChanges(changesFor(baseline(), current), [{ branch: 'feat/other' }]);
    await vi.runOnlyPendingTimersAsync();
    const added = el.querySelector<HTMLElement>('[data-unit-id="function:isMarkdownPath"]')!;
    expect(added.dataset.status).toBe('added');
    expect(added.querySelector('.cr-badges')?.textContent).toBe('added');
    const sig = el.querySelector<HTMLElement>('[data-unit-id="function:showAllFilesState"]')!;
    expect(sig.querySelector('.cr-badges')?.textContent).toBe('changed');
    expect(sig.querySelector('.cr-change-note')?.textContent).toBe('now also takes hiddenDirs');
    expect(sig.querySelector('.cr-radar')?.textContent).toBe('also changed on: feat/other');
    // An untouched card carries no badge and no radar line.
    const same = el.querySelector<HTMLElement>('[data-unit-id="function:dirKey"]')!;
    expect(same.querySelector('.cr-badge')).toBeNull();
    expect(same.querySelector('.cr-radar')).toBeNull();
    // The ghost closes the deck.
    const ghost = el.querySelector<HTMLElement>('.cr-deck > .cr-card-ghost')!;
    expect(ghost.dataset.ghostId).toBe('function:oldHelper');
    expect(ghost.querySelector('.cr-name')?.textContent).toBe('Removed: oldHelper');
    expect(ghost.querySelector('.cr-badge-removed')).not.toBeNull();
    expect(ghost.nextElementSibling).toBeNull();
    // The chip counts added + changed + removed and is live now.
    const chip = el.querySelector<HTMLButtonElement>('.cr-chip[data-filter="changed"]')!;
    expect(chip.textContent).toBe('Changed (3)');
    expect(chip.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('.cr-view[data-view="changes"]')?.disabled).toBe(
      false,
    );

    // The Changed chip floats changed cards first and keeps the ghost.
    click(chip);
    await vi.runOnlyPendingTimersAsync();
    const ids = () =>
      [...el.querySelectorAll<HTMLElement>('.cr-deck > .cr-card')].map(
        (c) => c.dataset.unitId ?? c.dataset.ghostId,
      );
    expect(ids()).toEqual([
      'function:isMarkdownPath',
      'function:showAllFilesState',
      'function:oldHelper',
    ]);

    // The Changes view is the same deck without the chip row.
    click(el.querySelector('.cr-view[data-view="changes"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-chips')).toBeNull();
    expect(ids()).toHaveLength(3);

    // The Calls view rings changed units.
    click(el.querySelector('.cr-view[data-view="calls"]')!);
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-calls code')?.textContent).toMatch(
      /class [\w,]*showAllFilesState[\w,]* (changed|exportedChanged)/,
    );

    // Clearing drops badges and ghosts and disables the chip again.
    click(el.querySelector('.cr-view[data-view="cards"]')!);
    await vi.runOnlyPendingTimersAsync();
    pane.setChanges(null, null);
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-badge')).toBeNull();
    expect(el.querySelector('.cr-card-ghost')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('.cr-chip[data-filter="changed"]')?.disabled).toBe(
      true,
    );
    pane.dispose();
  });

  test('a new file badges every card added; onModelChange reports each re-parse once', async () => {
    const onModelChange = vi.fn();
    const { el, pane, model } = attach('export function a() {}\n', 'x.ts', { onModelChange });
    await vi.runOnlyPendingTimersAsync();
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange.mock.calls[0]![1]).toBe('export function a() {}\n');
    pane.setChanges(changesFor(null, 'export function a() {}\n'), null);
    await vi.runOnlyPendingTimersAsync();
    expect(el.querySelector('.cr-badge-added')).not.toBeNull();
    // A theme flip re-renders without a re-parse notification.
    pane.setDark(true);
    await vi.runOnlyPendingTimersAsync();
    expect(onModelChange).toHaveBeenCalledTimes(1);
    model.pushText('export function a() {}\nexport function b() {}\n', 'cm6');
    await vi.advanceTimersByTimeAsync(250);
    expect(onModelChange).toHaveBeenCalledTimes(2);
    pane.dispose();
  });
});
