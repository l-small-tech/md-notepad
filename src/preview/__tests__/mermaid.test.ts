/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderMermaidBlocks, resetMermaidForTests } from '../mermaid';

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: { render: renderMock, initialize: initializeMock },
}));

function container(html: string): HTMLElement {
  document.body.innerHTML = `<div id="preview">${html}</div>`;
  return document.getElementById('preview') as HTMLElement;
}

beforeEach(() => {
  resetMermaidForTests();
  renderMock.mockReset();
  initializeMock.mockReset();
});

describe('renderMermaidBlocks', () => {
  test('a document without mermaid blocks never touches the mermaid module', async () => {
    const el = container('<pre><code class="language-js">let x = 1;</code></pre>');
    await renderMermaidBlocks(el, { dark: false });
    expect(initializeMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  test('replaces each mermaid block with the rendered SVG', async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-ok="1"></svg>' });
    const el = container(
      '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>' +
        '<pre><code class="language-mermaid">graph LR; C-->D;</code></pre>',
    );

    await renderMermaidBlocks(el, { dark: false });

    expect(el.querySelectorAll('.mermaid-diagram')).toHaveLength(2);
    expect(el.querySelectorAll('pre')).toHaveLength(0);
    expect(el.querySelector('.mermaid-diagram svg')).not.toBeNull();
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  test('a broken diagram degrades to source + message and cleans up the orphan node', async () => {
    renderMock.mockRejectedValue(new Error('Parse error on line 1'));
    // Simulate the orphan element mermaid leaves behind on parse failure.
    const orphan = document.createElement('div');
    orphan.id = 'mermaid-0';
    document.body.append(orphan);

    const el = container('<pre><code class="language-mermaid">graph TD broken</code></pre>');
    await renderMermaidBlocks(el, { dark: false });

    const errorBox = el.querySelector('.mermaid-error');
    expect(errorBox).not.toBeNull();
    expect(errorBox?.querySelector('.mermaid-error-message')?.textContent).toContain('Parse error');
    expect(errorBox?.querySelector('pre')?.textContent).toBe('graph TD broken');
    expect(document.getElementById('mermaid-0')).toBeNull();
  });

  test('one failed diagram does not stop the others from rendering', async () => {
    renderMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ svg: '<svg></svg>' });
    const el = container(
      '<pre><code class="language-mermaid">broken</code></pre>' +
        '<pre><code class="language-mermaid">graph TD; A;</code></pre>',
    );

    await renderMermaidBlocks(el, { dark: false });

    expect(el.querySelectorAll('.mermaid-error')).toHaveLength(1);
    expect(el.querySelectorAll('.mermaid-diagram')).toHaveLength(1);
  });

  test('re-initializes mermaid only when the theme actually changes', async () => {
    renderMock.mockResolvedValue({ svg: '<svg></svg>' });
    const block = '<pre><code class="language-mermaid">graph TD; A;</code></pre>';

    await renderMermaidBlocks(container(block), { dark: false });
    await renderMermaidBlocks(container(block), { dark: false });
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'default', securityLevel: 'strict' }),
    );

    await renderMermaidBlocks(container(block), { dark: true });
    expect(initializeMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
  });
});
