import { describe, expect, test } from 'vitest';

import { htmlToMarkdown } from '../docx-html';

describe('htmlToMarkdown', () => {
  test('maps headings and paragraphs', async () => {
    const md = await htmlToMarkdown('<h1>Title</h1><h2>Sub</h2><p>Body text.</p>');
    expect(md).toBe('# Title\n\n## Sub\n\nBody text.');
  });

  test('renders emphasis as distinct markers', async () => {
    const md = await htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(md).toBe('**bold** and _italic_');
  });

  test('renders unordered and ordered lists', async () => {
    const md = await htmlToMarkdown('<ul><li>one</li><li>two</li></ul>');
    expect(md).toBe('- one\n- two');
    const ol = await htmlToMarkdown('<ol><li>first</li><li>second</li></ol>');
    expect(ol).toBe('1. first\n2. second');
  });

  test('renders links', async () => {
    const md = await htmlToMarkdown('<p>See <a href="https://example.com">the site</a>.</p>');
    expect(md).toBe('See [the site](https://example.com).');
  });

  test('renders GFM tables', async () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const md = await htmlToMarkdown(html);
    expect(md).toContain('| A | B |');
    expect(md).toContain('| 1 | 2 |');
    expect(md).toMatch(/\| -+ \| -+ \|/);
  });

  test('keeps an image link intact for later placeholder swapping', async () => {
    const md = await htmlToMarkdown('<p><img src="import-img-0" /></p>');
    expect(md).toBe('![](import-img-0)');
  });

  test('collapses empty markup to an empty string', async () => {
    expect(await htmlToMarkdown('<p></p>\n  \n')).toBe('');
  });
});
