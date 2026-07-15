import { describe, expect, test } from 'vitest';

import { pagesToMarkdown, pageToMarkdown, type PdfTextItem } from '../pdf-text';
import { imagePlaceholder } from '../registry';

/** A body-text line at `y` (size 10), split into one item per word-ish run. */
function line(y: number, text: string, size = 10, x = 50): PdfTextItem {
  return { str: text, x, y, size };
}

describe('pageToMarkdown', () => {
  test('empty page yields empty string', () => {
    expect(pageToMarkdown([])).toBe('');
  });

  test('assembles a line from x-sorted runs and inserts gap spaces', () => {
    const items: PdfTextItem[] = [
      { str: 'world', x: 100, y: 700, size: 10 },
      { str: 'Hello', x: 50, y: 700, size: 10 },
    ];
    expect(pageToMarkdown(items)).toBe('Hello world');
  });

  test('merges wrapped lines into one paragraph and breaks on big gaps', () => {
    const items = [
      line(700, 'First paragraph line one'),
      line(688, 'and line two.'),
      line(640, 'Second paragraph.'), // 48pt gap >> 12pt line gap
      line(628, 'more of it.'),
    ];
    expect(pageToMarkdown(items)).toBe(
      'First paragraph line one and line two.\n\nSecond paragraph. more of it.',
    );
  });

  test('de-hyphenates wrapped words', () => {
    const items = [line(700, 'a beautiful hyphen-'), line(688, 'ated word')];
    expect(pageToMarkdown(items)).toBe('a beautiful hyphenated word');
  });

  test('detects headings by relative size', () => {
    const items = [
      line(700, 'Big Title', 18),
      line(670, 'Sub heading', 12),
      ...[640, 628, 616, 604].map((y) => line(y, 'body text that fills the page nicely', 10)),
    ];
    const md = pageToMarkdown(items);
    expect(md).toContain('# Big Title');
    expect(md).toContain('## Sub heading');
  });

  test('turns bullet glyphs into markdown list items', () => {
    const items = [
      line(700, 'Intro text before the list on the page'),
      line(688, '• first point'),
      line(676, '• second point'),
    ];
    const md = pageToMarkdown(items);
    expect(md).toContain('- first point');
    expect(md).toContain('- second point');
  });

  test('escapes leading markdown-significant characters', () => {
    expect(pageToMarkdown([line(700, '# not a heading')])).toBe('\\# not a heading');
  });

  test('interleaves image placeholders at their y position', () => {
    const items = [line(700, 'Above the image.'), line(600, 'Below the image.')];
    const md = pageToMarkdown(items, [{ imageIndex: 0, y: 650 }]);
    expect(md).toBe(`Above the image.\n\n${imagePlaceholder(0)}\n\nBelow the image.`);
  });
});

describe('pagesToMarkdown', () => {
  test('joins pages with a blank line and drops empty pages', () => {
    expect(pagesToMarkdown(['one', '', 'two'])).toBe('one\n\ntwo\n');
  });
});
