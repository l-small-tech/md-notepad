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

/**
 * The URL under grid column `col`, given the row's per-column graphemes
 * (`Row.columnChars()`). Detection still runs on the joined string, but the
 * hit test and the returned `start`/`end` are COLUMNS — string indices drift
 * one per wide char (spacer columns are '') and per combining mark, which is
 * why `urlAt(row.text(), col)` underlines the wrong cells after any CJK/emoji.
 */
export function urlAtColumn(chars: readonly string[], col: number): DetectedLink | null {
  if (col < 0 || col >= chars.length) return null;
  const offsets = new Array<number>(chars.length);
  let length = 0;
  for (let i = 0; i < chars.length; i++) {
    offsets[i] = length;
    length += chars[i]!.length;
  }
  // A spacer counts as its lead glyph, so hovering either half is the same.
  const offsetAt = (c: number) => (chars[c] === '' && c > 0 ? offsets[c - 1]! : offsets[c]!);
  const link = urlAt(chars.join(''), offsetAt(col));
  if (!link) return null;
  const startCol = offsets.findIndex((offset, i) => chars[i] !== '' && offset >= link.start);
  const endAt = offsets.findIndex((offset, i) => chars[i] !== '' && offset >= link.end);
  return { uri: link.uri, start: startCol, end: endAt === -1 ? chars.length : endAt };
}
