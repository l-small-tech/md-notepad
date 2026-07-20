/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Real mermaid can't render in jsdom (it needs browser layout); the transform
// is mocked so tests can (a) assert it runs against the detached export root
// and (b) exercise the fallback shape — an untouched block stays styled code.
const { renderMermaidBlocksMock } = vi.hoisted(() => ({ renderMermaidBlocksMock: vi.fn() }));
vi.mock('../mermaid', () => ({ renderMermaidBlocks: renderMermaidBlocksMock }));

import { buildStandaloneHtml } from '../export';

const CSS = '.export-body { max-width: 88ch; }';

function build(markdown: string, opts: Partial<Parameters<typeof buildStandaloneHtml>[1]> = {}) {
  return buildStandaloneHtml(markdown, { title: 'Doc', css: CSS, ...opts });
}

beforeEach(() => {
  renderMermaidBlocksMock.mockReset().mockResolvedValue(undefined);
});

describe('buildStandaloneHtml', () => {
  test('produces a complete HTML5 document: doctype, lang, charset, title, style', async () => {
    const html = await build('# Hello');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<title>Doc</title>');
    expect(html).toContain(CSS);
    expect(html).toContain('<div class="export-body"><h1>Hello</h1></div>');
    expect(html).toContain('</html>');
  });

  test('escapes the title', async () => {
    const html = await build('x', { title: '<script>alert("hi")</script> & more' });
    expect(html).toContain('<title>&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp; more</title>');
    expect(html).not.toContain('<title><script>');
  });

  test('raw HTML in the markdown is dropped by the sanitized pipeline', async () => {
    const html = await build('before\n\n<script>alert(1)</script>\n\n<iframe src="x"></iframe>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('before');
  });

  test('inlines images the resolver can produce a data: URL for', async () => {
    const html = await build('![pic](./pic.png)', {
      resolveImage: async (src) => (src === './pic.png' ? 'data:image/png;base64,QUJD' : null),
    });
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).not.toContain('src="./pic.png"');
  });

  test('a null from the resolver leaves the src exactly as-is', async () => {
    const resolveImage = vi.fn(async () => null);
    const html = await build('![pic](https://example.com/pic.png)', { resolveImage });
    expect(resolveImage).toHaveBeenCalledWith('https://example.com/pic.png');
    expect(html).toContain('src="https://example.com/pic.png"');
  });

  test('without a resolver, image srcs pass through untouched', async () => {
    const html = await build('![pic](./local.png)');
    expect(html).toContain('src="./local.png"');
  });

  test('dark adds the dark class to <body>; the default is light', async () => {
    expect(await build('x', { dark: true })).toContain('<body class="dark">');
    expect(await build('x')).toContain('<body>');
    expect(await build('x')).not.toContain('class="dark"');
  });

  test('runs the mermaid transform against the detached root with the dark flag', async () => {
    await build('```mermaid\ngraph TD; A-->B;\n```', { dark: true });
    expect(renderMermaidBlocksMock).toHaveBeenCalledTimes(1);
    const [root, options] = renderMermaidBlocksMock.mock.calls[0]!;
    expect(options).toEqual({ dark: true });
    // The root passed is the detached document's body, already holding the block.
    expect((root as HTMLElement).querySelector('code.language-mermaid')).not.toBeNull();
    expect((root as HTMLElement).ownerDocument).not.toBe(document);
  });

  test('a mermaid block the transform leaves alone exports as styled code', async () => {
    // The fallback shape: if mermaid cannot render (or degrades), the fenced
    // source survives as a language-tagged code block the stylesheet styles.
    const html = await build('```mermaid\ngraph TD; A-->B;\n```');
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).toContain('graph TD; A--&gt;B;');
  });
});
