/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDocModel } from '../../core/doc-model';

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

const { renderMermaidBlocksMock } = vi.hoisted(() => ({ renderMermaidBlocksMock: vi.fn() }));
vi.mock('../mermaid', () => ({ renderMermaidBlocks: renderMermaidBlocksMock }));

import { attachPreviewPane } from '../pane';

function host(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  openUrlMock.mockReset();
  renderMermaidBlocksMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('attachPreviewPane', () => {
  test('renders the initial text immediately, without waiting for the debounce', async () => {
    const model = createDocModel('# Hello');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();
    expect(el.innerHTML).toContain('<h1>Hello</h1>');
    pane.dispose();
  });

  test('debounces 200ms after the last model change before re-rendering', async () => {
    const model = createDocModel('one');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    model.pushText('two', 'cm6');
    await vi.advanceTimersByTimeAsync(199);
    expect(el.innerHTML).toContain('one');

    await vi.advanceTimersByTimeAsync(1);
    expect(el.innerHTML).toContain('two');
    pane.dispose();
  });

  test('rapid edits collapse into a single render of the latest text', async () => {
    const model = createDocModel('a');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    model.pushText('ab', 'cm6');
    await vi.advanceTimersByTimeAsync(50);
    model.pushText('abc', 'cm6');
    await vi.advanceTimersByTimeAsync(199);
    expect(el.innerHTML).not.toContain('abc');
    await vi.advanceTimersByTimeAsync(1);
    expect(el.innerHTML).toContain('abc');
    pane.dispose();
  });

  test('setDark triggers an immediate re-render (mermaid bakes colors at render time)', async () => {
    const model = createDocModel('# Hi');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();
    renderMermaidBlocksMock.mockClear();

    pane.setDark(true);
    await vi.runOnlyPendingTimersAsync();
    expect(renderMermaidBlocksMock).toHaveBeenCalledWith(el, { dark: true });
    pane.dispose();
  });

  test('setDark is a no-op when the theme did not actually change', async () => {
    const model = createDocModel('# Hi');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();
    renderMermaidBlocksMock.mockClear();

    pane.setDark(false);
    await vi.runOnlyPendingTimersAsync();
    expect(renderMermaidBlocksMock).not.toHaveBeenCalled();
    pane.dispose();
  });

  test('clicking an http(s) link opens the system browser and never navigates', async () => {
    const model = createDocModel('[docs](https://example.com)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    const link = el.querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const prevented = !link.dispatchEvent(event);

    expect(prevented).toBe(true);
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com');
    pane.dispose();
  });

  test('clicking a non-http link is inert: prevented, but never opened', async () => {
    const model = createDocModel('[mail](mailto:a@b.com)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    const link = el.querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const prevented = !link.dispatchEvent(event);

    expect(prevented).toBe(true);
    expect(openUrlMock).not.toHaveBeenCalled();
    pane.dispose();
  });

  test('dispose stops further renders and removes the click listener', async () => {
    const model = createDocModel('one');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    pane.dispose();
    model.pushText('two', 'cm6');
    await vi.advanceTimersByTimeAsync(500);
    expect(el.innerHTML).not.toContain('two');
  });

  test('a stale in-flight render is discarded so it never clobbers newer content', async () => {
    const model = createDocModel('first');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();
    expect(el.innerHTML).toContain('first');

    model.pushText('second', 'cm6');
    await vi.advanceTimersByTimeAsync(200); // render #2 starts
    model.pushText('third', 'cm6');
    await vi.advanceTimersByTimeAsync(200); // render #3 starts and finishes after #2 would

    expect(el.innerHTML).toContain('third');
    expect(el.innerHTML).not.toContain('second');
    pane.dispose();
  });
});
