/**
 * The markdown → sanitized HTML pipeline for the split-mode preview pane
 * (src/preview/README.md). unified/remark/rehype are stateless once
 * configured, so the processor is built ONCE at module scope and reused for
 * every render.
 *
 * `remark-rehype` runs with no `allowDangerousHtml` — raw HTML in the source
 * markdown is dropped before it ever reaches the sanitizer (invariant I6).
 * `rehype-sanitize` is the second, belt-and-suspenders layer: even if a
 * future remark plugin ever re-introduces raw HTML nodes, nothing renders
 * without passing this schema.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import type { Schema } from 'hast-util-sanitize';

/** A single letter, upper- and lower-case, for every possible Windows drive
 *  (`C:`, `D:`, …) — the "schemes" an absolute drive path otherwise trips over. */
const DRIVE_LETTER_SCHEMES: string[] = Array.from({ length: 26 }, (_, i) => [
  String.fromCharCode(65 + i),
  String.fromCharCode(97 + i),
]).flat();

/** Extends `defaultSchema` by exactly what GFM output needs (README §Sanitize schema). */
const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Fenced code blocks keep their language class for mermaid detection
    // (mermaid.ts looks for `code.language-mermaid`) and future highlighting.
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-./]],
    // GFM task lists render as checkboxes; keep them disabled (I6 — toggling
    // belongs to wysiwyg mode, not the read-only preview).
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      ['type', 'checkbox'],
      ['checked'],
      ['disabled'],
    ],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
  // `defaultSchema.protocols.src` allows only http(s), so it strips the `src`
  // off a local image whose destination is an absolute Windows path — the
  // drive letter reads as a protocol (`C:/…` → scheme `c`). That left Read/Split
  // mode showing broken images (the pane inlines local images off disk AFTER
  // this render — see pane.ts `inlineLocalImages` — but only if the src
  // survives sanitizing to be read). Allow every single-letter scheme, in both
  // cases (the sanitizer matches protocols case-sensitively and drive letters
  // are usually upper-case), so drive paths pass through; genuinely dangerous
  // schemes (javascript:, …) are longer and stay blocked, and an <img> src
  // can't execute script regardless.
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), ...DRIVE_LETTER_SCHEMES],
  },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

/** Parse `text` as GFM and return sanitized HTML, safe to assign to `innerHTML`. */
export async function renderMarkdownToHtml(text: string): Promise<string> {
  const file = await processor.process(text);
  return String(file);
}

/**
 * Guards against out-of-order async render completions (README "Render
 * loop"): each call to `start()` returns a token; `isCurrent` is true only
 * for the most recently started render. A pane keeps one guard for its
 * lifetime and discards any completion that isn't current instead of
 * touching the DOM with stale content.
 */
export interface RenderSequence {
  start(): number;
  isCurrent(token: number): boolean;
}

export function createRenderSequence(): RenderSequence {
  let latest = 0;
  return {
    start() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return token === latest;
    },
  };
}
