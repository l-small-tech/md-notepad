/**
 * The raw-mode markdown highlight style (used by cm6.ts), in its own module so
 * tests can exercise it without importing @codemirror/view.
 *
 * Colors come from CSS variables so themes switch without touching CM6. The
 * markdown elements a theme plugin can recolor read a `--md-*` var (core/
 * theme-plugins.ts) with a fallback to their previous palette color, so an
 * unset key looks exactly as before. Per-level headings cascade
 * `--md-heading{n}` → `--md-heading` → `--fg`; the base `tags.heading` rule
 * keeps the bold weight and colors the `#` marker. Every fallback here matches
 * the Read pane's (preview.css) so raw and read stay the same colors even for
 * a theme with no `syntax` block.
 *
 * Two @lezer/markdown tags are deliberately NOT colored, because they cover
 * whole subtrees where Read colors nothing:
 *  - `tags.content` is every Paragraph — coloring it painted ALL body text
 *    with the theme's code color;
 *  - `tags.list` is the entire BulletList/OrderedList subtree, text included —
 *    coloring it painted every list line with the theme's list color.
 * Read colors only the bullet/number glyph (`li::marker`), so raw mirrors
 * that with `LIST_MARK_TAG`, a custom tag pinned to just the ListMark node.
 */

import { HighlightStyle } from '@codemirror/language';
import { styleTags, Tag, tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

export const LIST_MARK_TAG = Tag.define();

/** Markdown-parser extension attaching LIST_MARK_TAG to ListMark nodes. */
export const listMarkStyling: MarkdownConfig = {
  props: [styleTags({ ListMark: LIST_MARK_TAG })],
};

const HEADING_TAGS = [
  tags.heading1,
  tags.heading2,
  tags.heading3,
  tags.heading4,
  tags.heading5,
  tags.heading6,
];

export const highlightStyle = HighlightStyle.define([
  // heading1..6 inherit `heading`, and CM6 applies only the most-specific
  // matching rule — so each level must carry `fontWeight` itself (a bare
  // `heading` rule wouldn't reach them). The base rule stays for any generic
  // heading token and to document intent.
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--md-heading, var(--fg))' },
  ...HEADING_TAGS.map((tag, i) => ({
    tag,
    fontWeight: 'bold',
    color: `var(--md-heading${i + 1}, var(--md-heading, var(--fg)))`,
  })),
  { tag: tags.strong, fontWeight: 'bold', color: 'var(--md-bold, var(--fg))' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'var(--md-italic, var(--fg))' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--md-strike, var(--fg))' },
  { tag: tags.monospace, color: 'var(--md-code, var(--fg))' },
  { tag: tags.link, color: 'var(--md-link, var(--accent))', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-link, var(--accent))' },
  { tag: tags.quote, color: 'var(--md-quote, var(--fg-muted))' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--fg-muted)' },
  // AFTER processingInstruction: a ListMark span carries both classes (the
  // stock tag plus ours), and the later stylesheet rule must win. Fallback
  // matches Read's `li::marker` (inherits the text color).
  { tag: LIST_MARK_TAG, color: 'var(--md-list, var(--fg))' },
  { tag: tags.keyword, color: 'var(--accent)' },
]);
