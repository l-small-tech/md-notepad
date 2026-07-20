import { describe, expect, test } from 'vitest';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { highlightTree, tags } from '@lezer/highlight';
import type { MarkdownParser } from '@lezer/markdown';
import { highlightStyle, LIST_MARK_TAG, listMarkStyling } from '../markdown-highlight';

/**
 * Raw mode must color the SAME things Read does (the user-visible rule since
 * the raw/read parity work): body paragraphs and bullet text stay the plain
 * foreground; only the bullet/number glyph carries the theme's list color.
 * @lezer/markdown tags whole subtrees (`Paragraph` → content, `BulletList/...`
 * → list), so these tests pin that neither broad tag is colored and that the
 * marker-only custom tag wins on the ListMark span.
 */

/** Highlight `doc` with the same parser config cm6.ts uses; returns spans. */
function highlight(doc: string): { text: string; classes: string }[] {
  // The language exposes its parser as the base `Parser` type; it is in fact
  // the (configurable) MarkdownParser — same object cm6.ts hands to markdown().
  const tree = (markdownLanguage.parser as MarkdownParser).configure(listMarkStyling).parse(doc);
  const spans: { text: string; classes: string }[] = [];
  highlightTree(tree, highlightStyle, (from, to, classes) => {
    spans.push({ text: doc.slice(from, to), classes });
  });
  return spans;
}

function classOf(spans: ReturnType<typeof highlight>, text: string): string | null {
  return spans.find((s) => s.text === text)?.classes ?? null;
}

describe('raw-mode markdown highlighting', () => {
  test('plain paragraph text gets no color class at all', () => {
    const spans = highlight('Just an ordinary sentence.\n\nAnother one.');
    expect(spans).toEqual([]);
  });

  test('bullet text is uncolored; only the marker gets the list class', () => {
    const spans = highlight('- first point\n- second point\n');
    const markerClass = highlightStyle.style([LIST_MARK_TAG])!;
    // The `-` markers are highlighted…
    const markers = spans.filter((s) => s.text === '-');
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      // …and OUR rule comes after the shared mark rule, so its color wins.
      expect(marker.classes).toContain(markerClass);
      expect(marker.classes.indexOf(markerClass)).toBeGreaterThan(
        marker.classes.indexOf(highlightStyle.style([tags.processingInstruction])!),
      );
    }
    // …while the item text itself is not.
    expect(spans.filter((s) => s.text.includes('point'))).toEqual([]);
  });

  test('ordered-list numbers get the list class, their text stays plain', () => {
    const spans = highlight('1. one\n2. two\n');
    const markerClass = highlightStyle.style([LIST_MARK_TAG])!;
    expect(classOf(spans, '1.')).toContain(markerClass);
    expect(spans.filter((s) => s.text === 'one' || s.text === 'two')).toEqual([]);
  });

  test('inline code keeps the code color; surrounding prose stays plain', () => {
    const spans = highlight('Use `npm i` to install.');
    const codeClass = highlightStyle.style([tags.monospace])!;
    expect(classOf(spans, 'npm i')).toBe(codeClass);
    expect(spans.filter((s) => s.text.includes('install'))).toEqual([]);
  });

  test('blockquote text keeps the quote color', () => {
    const spans = highlight('> quoted words\n');
    const quoteClass = highlightStyle.style([tags.quote])!;
    const quoted = spans.find((s) => s.text.includes('quoted words'));
    expect(quoted?.classes).toContain(quoteClass);
  });
});
