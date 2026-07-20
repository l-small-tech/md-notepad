/**
 * Standalone HTML export — turns a markdown document into one self-contained
 * HTML5 file (inline stylesheet, images inlined as data: URLs, mermaid
 * diagrams rendered to SVG) suitable for sharing or printing to PDF.
 *
 * Reuses the exact preview pipeline (`renderMarkdownToHtml`), including its
 * sanitizer — which means raw HTML in the source markdown is dropped from
 * exports too. That is intentional: the export must never render anything the
 * in-app preview refuses (invariant I6), so what you export is precisely what
 * you preview.
 */

import { renderMermaidBlocks } from './mermaid';
import { renderMarkdownToHtml } from './pipeline';

export interface ExportOptions {
  /** Document title — used (escaped) for the <title> element. */
  title: string;
  /** Full standalone stylesheet, embedded verbatim into the <style> element. */
  css: string;
  /** Pick the dark variable set: adds `class="dark"` to <body>. */
  dark?: boolean;
  /**
   * Resolve an <img> src to a data: URL, or null to leave the src exactly
   * as-is (external URLs, unresolvable paths). Omit to skip image inlining.
   */
  resolveImage?: (src: string) => Promise<string | null>;
}

/** Minimal HTML text/attribute escaping for interpolated strings (the title). */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Build a complete standalone HTML document from `markdown`.
 *
 * Pipeline: preview render (sanitized) → detached DOMParser document →
 * mermaid diagrams rendered in place (in the app's live WebView mermaid has
 * the layout it needs even for a detached target; a diagram that fails to
 * render degrades to its fenced source + message, exactly like the preview) →
 * image inlining via `opts.resolveImage` → serialized HTML5 document.
 */
export async function buildStandaloneHtml(markdown: string, opts: ExportOptions): Promise<string> {
  const html = await renderMarkdownToHtml(markdown);

  // A detached document keeps the transform steps (mermaid, image inlining)
  // off the live DOM — nothing the exporter does can flash in the app UI.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;

  await renderMermaidBlocks(root, { dark: opts.dark === true });

  if (opts.resolveImage) {
    for (const img of [...root.querySelectorAll('img')]) {
      const src = img.getAttribute('src');
      if (!src) {
        continue;
      }
      const resolved = await opts.resolveImage(src);
      if (resolved !== null) {
        img.setAttribute('src', resolved);
      }
    }
  }

  const bodyClass = opts.dark === true ? ' class="dark"' : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(opts.title)}</title>`,
    '<style>',
    opts.css,
    '</style>',
    '</head>',
    `<body${bodyClass}>`,
    // The container div matches the stylesheet's reading-column rules.
    `<div class="export-body">${root.innerHTML}</div>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
