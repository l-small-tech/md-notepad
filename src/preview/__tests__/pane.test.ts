/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDocModel } from '../../core/doc-model';

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

const { renderMermaidBlocksMock } = vi.hoisted(() => ({ renderMermaidBlocksMock: vi.fn() }));
vi.mock('../mermaid', () => ({ renderMermaidBlocks: renderMermaidBlocksMock }));

const { readFileBase64Mock, readTextFileMock } = vi.hoisted(() => ({
  readFileBase64Mock: vi.fn(),
  readTextFileMock: vi.fn(),
}));
vi.mock('../../ipc/commands', () => ({
  ipc: { readFileBase64: readFileBase64Mock, readTextFile: readTextFileMock },
}));

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
  readFileBase64Mock.mockReset().mockResolvedValue('QUJD'); // base64 of "ABC"
  readTextFileMock.mockReset().mockResolvedValue({ text: '', mtimeMs: 0 });
});

function click(link: Element): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  return !link.dispatchEvent(event); // true = default prevented
}

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

  test('a relative image is resolved against docPath and inlined as a data URL', async () => {
    const model = createDocModel('![shot](images/shot.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();

    expect(readFileBase64Mock).toHaveBeenCalledWith('/ws/images/shot.png');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,QUJD');
    pane.dispose();
  });

  test('an http(s) image is left untouched, not read off disk', async () => {
    const model = createDocModel('![a](https://x.test/a.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();

    expect(readFileBase64Mock).not.toHaveBeenCalled();
    expect(el.querySelector('img')!.getAttribute('src')).toBe('https://x.test/a.png');
    pane.dispose();
  });

  test('with no docPath, a relative image is left as-is (unsaved doc)', async () => {
    const model = createDocModel('![shot](images/shot.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false });
    await vi.runOnlyPendingTimersAsync();

    expect(readFileBase64Mock).not.toHaveBeenCalled();
    expect(el.querySelector('img')!.getAttribute('src')).toBe('images/shot.png');
    pane.dispose();
  });

  test('a missing image is left broken rather than throwing', async () => {
    readFileBase64Mock.mockRejectedValue(new Error('NOT_FOUND'));
    const model = createDocModel('![gone](images/gone.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();

    expect(el.querySelector('img')!.getAttribute('src')).toBe('images/gone.png');
    pane.dispose();
  });

  test('setDocPath makes relative images resolve for a note that gets a path later', async () => {
    // An untitled note starts with no path, so its relative image is left as-is.
    const model = createDocModel('![shot](images/shot.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: null });
    await vi.runOnlyPendingTimersAsync();
    expect(readFileBase64Mock).not.toHaveBeenCalled();
    expect(el.querySelector('img')!.getAttribute('src')).toBe('images/shot.png');

    // The flusher assigns a path — the pane re-resolves relative refs against it.
    pane.setDocPath('/ws/note.md');
    await vi.runOnlyPendingTimersAsync();
    expect(readFileBase64Mock).toHaveBeenCalledWith('/ws/images/shot.png');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,QUJD');
    pane.dispose();
  });

  test('setDocPath is a no-op re-render when the directory is unchanged', async () => {
    const model = createDocModel('# Hi');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();
    renderMermaidBlocksMock.mockClear();

    // A sibling rename keeps the same directory — nothing to re-render.
    pane.setDocPath('/ws/renamed.md');
    await vi.runOnlyPendingTimersAsync();
    expect(renderMermaidBlocksMock).not.toHaveBeenCalled();
    pane.dispose();
  });

  test('setDocPath followed links resolve against the new directory after assignment', async () => {
    const model = createDocModel('[go](other.md)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: null });
    await vi.runOnlyPendingTimersAsync();

    pane.setDocPath('/ws/note.md');
    await vi.runOnlyPendingTimersAsync();

    readTextFileMock.mockResolvedValue({ text: '# Linked', mtimeMs: 1 });
    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();
    expect(readTextFileMock).toHaveBeenCalledWith('/ws/other.md');
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

  test('following a local markdown link surfaces the Back affordance', async () => {
    readTextFileMock.mockResolvedValue({ text: '# Linked Page', mtimeMs: 1 });
    const onCanGoBackChange = vi.fn();
    const model = createDocModel('[go](other.md)');
    const el = host();
    const pane = attachPreviewPane(el, model, {
      dark: false,
      docPath: '/ws/note.md',
      onCanGoBackChange,
    });
    await vi.runOnlyPendingTimersAsync();

    expect(click(el.querySelector('a')!)).toBe(true);
    await vi.runOnlyPendingTimersAsync();

    expect(readTextFileMock).toHaveBeenCalledWith('/ws/other.md');
    expect(el.innerHTML).toContain('<h1>Linked Page</h1>');
    expect(onCanGoBackChange).toHaveBeenLastCalledWith(true);
    expect(openUrlMock).not.toHaveBeenCalled();
    pane.dispose();
  });

  test('goBack() returns to the tab document and clears the Back affordance', async () => {
    readTextFileMock.mockResolvedValue({ text: '# Linked Page', mtimeMs: 1 });
    const onCanGoBackChange = vi.fn();
    const model = createDocModel('# Home\n\n[go](other.md)');
    const el = host();
    const pane = attachPreviewPane(el, model, {
      dark: false,
      docPath: '/ws/note.md',
      onCanGoBackChange,
    });
    await vi.runOnlyPendingTimersAsync();

    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();
    expect(el.innerHTML).toContain('Linked Page');

    pane.goBack();
    await vi.runOnlyPendingTimersAsync();
    expect(el.innerHTML).toContain('<h1>Home</h1>');
    expect(onCanGoBackChange).toHaveBeenLastCalledWith(false);
    pane.dispose();
  });

  test('relative links resolve against the current page while browsing', async () => {
    readTextFileMock.mockResolvedValue({ text: '[deeper](../sibling.md)', mtimeMs: 1 });
    const model = createDocModel('[go](sub/child.md)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();

    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();
    expect(readTextFileMock).toHaveBeenLastCalledWith('/ws/sub/child.md');

    click(el.querySelector('a')!); // the "deeper" link, now inside the child page
    await vi.runOnlyPendingTimersAsync();
    expect(readTextFileMock).toHaveBeenLastCalledWith('/ws/sibling.md');
    pane.dispose();
  });

  test('a link to an image opens in a tab instead of the pane', async () => {
    const onOpenFile = vi.fn();
    const onCanGoBackChange = vi.fn();
    const model = createDocModel('[pic](photo.png)');
    const el = host();
    const pane = attachPreviewPane(el, model, {
      dark: false,
      docPath: '/ws/note.md',
      onOpenFile,
      onCanGoBackChange,
    });
    await vi.runOnlyPendingTimersAsync();

    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();
    expect(onOpenFile).toHaveBeenCalledWith('/ws/photo.png');
    expect(readTextFileMock).not.toHaveBeenCalled();
    expect(onCanGoBackChange).not.toHaveBeenCalled(); // no in-pane navigation happened
    pane.dispose();
  });

  test('an unreadable local link falls back to opening in a tab', async () => {
    readTextFileMock.mockRejectedValue(new Error('not text'));
    const onOpenFile = vi.fn();
    const onCanGoBackChange = vi.fn();
    const model = createDocModel('[data](blob.bin)');
    const el = host();
    const pane = attachPreviewPane(el, model, {
      dark: false,
      docPath: '/ws/note.md',
      onOpenFile,
      onCanGoBackChange,
    });
    await vi.runOnlyPendingTimersAsync();

    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();
    expect(onOpenFile).toHaveBeenCalledWith('/ws/blob.bin');
    expect(onCanGoBackChange).not.toHaveBeenCalled();
    pane.dispose();
  });

  test('model edits do not disturb the pane while browsing a followed link', async () => {
    readTextFileMock.mockResolvedValue({ text: '# Linked Page', mtimeMs: 1 });
    const model = createDocModel('[go](other.md)');
    const el = host();
    const pane = attachPreviewPane(el, model, { dark: false, docPath: '/ws/note.md' });
    await vi.runOnlyPendingTimersAsync();

    click(el.querySelector('a')!);
    await vi.runOnlyPendingTimersAsync();

    model.pushText('edited while away', 'cm6');
    await vi.advanceTimersByTimeAsync(500);
    expect(el.innerHTML).toContain('Linked Page');
    expect(el.innerHTML).not.toContain('edited while away');
    pane.dispose();
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
