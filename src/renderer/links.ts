/**
 * Link detection.
 *
 * Two kinds of link can be under the pointer:
 *   - an **explicit** OSC 8 hyperlink, which the engine already recorded on
 *     each cell as a link id, and
 *   - an **implicit** URL, which we find by scanning the row's text.
 *
 * Both resolve to a column range plus a URI so the renderer can underline the
 * whole link on hover and the host can open it.
 */

const URL_PATTERN = /\b(?:https?|ftp|file):\/\/[^\s<>"'`{}|\\^[\]]+/g;

/** Characters a URL is unlikely to actually end with (sentence punctuation). */
const TRAILING = new Set([...'.,;:!?)]}\'"']);

export interface DetectedLink {
  /** Column of the first character (inclusive). */
  start: number;
  /** Column just past the last character. */
  end: number;
  uri: string;
}

/**
 * URLs in a line of text. Columns are character indices, which equal grid
 * columns for the ASCII URLs are made of; a wide character earlier in the line
 * shifts them, so callers pass text built from the same row they render.
 */
export function detectUrls(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    let uri = match[0];
    // A URL at the end of a sentence swallows the punctuation; give it back,
    // and balance a closing paren only when the URL has no opening one.
    while (uri.length > 0 && TRAILING.has(uri[uri.length - 1]!)) {
      const last = uri[uri.length - 1]!;
      if (last === ')' && uri.includes('(')) break;
      uri = uri.slice(0, -1);
    }
    if (uri.length === 0) continue;
    links.push({ start: match.index, end: match.index + uri.length, uri });
  }
  return links;
}

/** The URL under `col`, if any. */
export function urlAt(text: string, col: number): DetectedLink | null {
  return detectUrls(text).find((link) => col >= link.start && col < link.end) ?? null;
}
