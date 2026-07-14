import { describe, expect, test } from 'vitest';
import { createRenderSequence, renderMarkdownToHtml } from '../pipeline';

describe('renderMarkdownToHtml — GFM constructs', () => {
  test('tables', async () => {
    const html = await renderMarkdownToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  test('task lists render checkbox inputs, checked state preserved, always disabled', async () => {
    const html = await renderMarkdownToHtml('- [x] done\n- [ ] todo\n');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('disabled');
    // The unchecked item must not carry a stray checked attribute.
    const items = html.split('<li');
    const todoItem = items.find((item) => item.includes('todo'));
    expect(todoItem).toBeDefined();
    expect(todoItem).not.toContain('checked');
  });

  test('strikethrough', async () => {
    const html = await renderMarkdownToHtml('~~gone~~\n');
    expect(html).toContain('<del>gone</del>');
  });

  test('autolinks', async () => {
    const html = await renderMarkdownToHtml('See https://example.com for more.\n');
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  test('fenced code keeps its language class', async () => {
    const html = await renderMarkdownToHtml('```js\nlet x = 1;\n```\n');
    expect(html).toContain('<code class="language-js">');
  });

  test('mermaid fences keep the language-mermaid class the renderer looks for', async () => {
    const html = await renderMarkdownToHtml('```mermaid\ngraph TD; A-->B;\n```\n');
    expect(html).toContain('<code class="language-mermaid">');
  });
});

describe('renderMarkdownToHtml — sanitize policy (invariant I6)', () => {
  test('script tags never reach the output', async () => {
    const html = await renderMarkdownToHtml('<script>alert(1)</script>\n\nHello\n');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  test('raw iframes are dropped', async () => {
    const html = await renderMarkdownToHtml('<iframe src="https://evil.example"></iframe>\n');
    expect(html).not.toContain('<iframe');
  });

  test('inline event handler attributes are stripped', async () => {
    const html = await renderMarkdownToHtml('<img src="x.png" onerror="alert(1)">\n');
    expect(html).not.toContain('onerror');
  });

  test('javascript: links are stripped of their href', async () => {
    const html = await renderMarkdownToHtml('[click me](javascript:alert(1))\n');
    expect(html).not.toContain('javascript:');
  });

  test('http(s) links pass through untouched', async () => {
    const html = await renderMarkdownToHtml('[docs](https://example.com/docs)\n');
    expect(html).toContain('href="https://example.com/docs"');
  });

  // Image refs are stored as absolute forward-slashed paths; on Windows those
  // carry a drive letter (`C:/…`) that the default sanitize schema mistakes for
  // a protocol and strips, leaving the pane with no src to inline off disk.
  test('absolute local image src survives sanitizing so the pane can inline it', async () => {
    const html = await renderMarkdownToHtml('![shot](C:/Users/me/notes/images/pasted-1.png)\n');
    expect(html).toContain('src="C:/Users/me/notes/images/pasted-1.png"');
  });

  test('a POSIX-absolute image src also survives', async () => {
    const html = await renderMarkdownToHtml('![shot](/home/me/notes/images/pasted-1.png)\n');
    expect(html).toContain('src="/home/me/notes/images/pasted-1.png"');
  });

  test('javascript: image src is still stripped', async () => {
    const html = await renderMarkdownToHtml('![x](javascript:alert(1))\n');
    expect(html).not.toContain('javascript:');
  });

  // Voice-comment anchor tokens are invisible HTML comments; the preview must
  // render nothing for them (the feature relies on this — see src/core/comments.ts).
  test('voice-comment anchor tokens are stripped from the rendered output', async () => {
    const html = await renderMarkdownToHtml('## Setup <!-- ^c1a2 -->\n\nBody text.\n');
    expect(html).toContain('Setup');
    expect(html).toContain('Body text.');
    expect(html).not.toContain('c1a2');
    expect(html).not.toContain('<!--');
  });
});

describe('createRenderSequence', () => {
  test('only the most recently started token is current', () => {
    const seq = createRenderSequence();
    const first = seq.start();
    const second = seq.start();
    expect(seq.isCurrent(first)).toBe(false);
    expect(seq.isCurrent(second)).toBe(true);
  });
});
