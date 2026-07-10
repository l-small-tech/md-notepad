/**
 * Clipboard `@`-mention enrichment.
 *
 * The ribbon's "copy raw text" button can append Claude-Code-CLI `@path`
 * mentions for every LOCAL file/image a document links to, so pasting the copy
 * into the CLI pulls those files in. Relative link destinations are auto-
 * resolved to absolute paths (against the document's own directory) to give the
 * CLI the best chance of finding them — `@` mentions resolve from wherever
 * `claude` runs, which is rarely the notes folder.
 *
 * Pure and DOM-free (tested in isolation): the component supplies the text and
 * the document's base directory; this decides what to emit.
 */

import { toAbsolutePath } from './session/plan-flush';

/**
 * Markdown inline link / image: `[label](dest …)` or `![label](dest …)`. Group
 * 1 is the destination — either an angle-bracket form `<a b>` (allows spaces)
 * or a bare token — with any title/trailing text swallowed up to the `)`.
 */
const LINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^()\s]+)[^)]*\)/g;

/**
 * A destination we can turn into a filesystem `@`-mention: not an in-document
 * anchor, and not a URL with a scheme (http:, mailto:, data:, …). A Windows
 * drive path (`C:\…`) reads like a scheme but IS local, so it's allowed first.
 */
export function isLocalLinkTarget(dest: string): boolean {
  if (!dest || dest.startsWith('#')) {
    return false;
  }
  if (/^[a-zA-Z]:[\\/]/.test(dest)) {
    return true; // Windows drive path
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(dest); // reject anything with a URL scheme
}

/**
 * The absolute (or best-effort) `@`-mention paths for every local file/image
 * linked in `text`, deduped case-insensitively, in first-appearance order.
 * Relative destinations resolve against `baseDir`; pass '' for an unsaved
 * document (they stay relative, normalized).
 */
export function collectMentions(text: string, baseDir: string): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    let dest = match[1]!;
    if (dest.startsWith('<') && dest.endsWith('>')) {
      dest = dest.slice(1, -1);
    }
    dest = dest.trim();
    if (!isLocalLinkTarget(dest)) {
      continue;
    }
    // toAbsolutePath forward-slashes and collapses ./.. even with an empty base
    // (an unsaved doc), where it can only return a normalized relative path.
    const resolved = toAbsolutePath(baseDir, dest);
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mentions.push(resolved);
  }
  return mentions;
}

/**
 * Append an `@`-mention block for the document's linked local files to `text`.
 * Returns the (possibly unchanged) text plus the mention count, so the caller
 * can word the clipboard notice. No links → text is returned untouched.
 */
export function appendMentions(text: string, baseDir: string): { text: string; count: number } {
  const mentions = collectMentions(text, baseDir);
  if (mentions.length === 0) {
    return { text, count: 0 };
  }
  const block = mentions.map((path) => `@${path}`).join('\n');
  return { text: `${text}\n\n${block}`, count: mentions.length };
}
