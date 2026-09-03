/**
 * A saved board's colour mode as seen from OUTSIDE the draw editor — the
 * markdown preview and the rich editor show boards through `<img>`, and their
 * right-click "theme colours / true colours" toggle needs two things without
 * mounting a scene: read the mode off the file text, and write the flipped
 * mode back.
 *
 * Reading is root-tag string surgery (same span scanner as theme-inject.ts),
 * so it is cheap enough to run on every inline. Writing goes through the real
 * parse → `setColorMode` → serialize route — the exact edit the board's own
 * `◐` control makes — so the file the toggle produces is byte-identical to
 * what the draw editor would have saved (README "Serializer determinism").
 */

import { setColorMode } from './layers';
import { parseWhiteboard } from './parse';
import type { BoardColorMode } from './scene';
import { colorModeOf, isThemed, serializeWhiteboard } from './serialize';

/** The root `<svg …>` tag's class tokens, or null when there is no root tag. */
function rootClassTokens(source: string): string[] | null {
  const start = source.search(/<svg[\s>]/);
  if (start < 0) {
    return null;
  }
  let quote: string | null = null;
  let end = -1;
  for (let i = start + 4; i < source.length; i++) {
    const ch = source[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return null;
  }
  const match = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(start, end + 1));
  return (match ? (match[2] ?? match[3] ?? '') : '').split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The colour mode a saved board renders in, read off its root tag: `'fixed'`
 * when the serializer's `wb-fixed` token is present, `'themed'` for any other
 * `wb-board`, and null for everything that has no dual representation to
 * switch between — foreign SVGs, `themed:false` boards, non-SVG text.
 */
export function boardColorModeOf(source: string): BoardColorMode | null {
  const tokens = rootClassTokens(source);
  if (!tokens || !tokens.includes('wb-board')) {
    return null;
  }
  return tokens.includes('wb-fixed') ? 'fixed' : 'themed';
}

/**
 * The board's source with its colour mode set to `mode`. Returns the input
 * untouched when the file is not a themable board or already renders in that
 * mode — so a caller can compare by identity to skip a no-op write, and a
 * hand-authored file is never rewritten by a toggle that changes nothing.
 * Throws `WhiteboardParseError` on malformed XML, like any board open.
 */
export function withBoardColorMode(source: string, mode: BoardColorMode): string {
  if (boardColorModeOf(source) === null) {
    return source;
  }
  const doc = parseWhiteboard(source);
  if (!isThemed(doc) || colorModeOf(doc) === mode) {
    return source;
  }
  return serializeWhiteboard(setColorMode(doc, mode));
}

/**
 * Every `.svg` image reference in a markdown document, as written (raw src,
 * document order, duplicates removed). Covers the markdown image form —
 * `![alt](src "title")`, with or without `<…>` around the destination — and
 * inline `<img src="…">` HTML. Resolution against the document's directory is
 * the caller's job (`images.ts` `localImageToInline`), as is filtering out
 * anything that isn't a board.
 */
export function svgImageSources(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (src: string): void => {
    const trimmed = src.trim();
    if (/\.svg$/i.test(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  const image = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))/g;
  for (let m = image.exec(markdown); m !== null; m = image.exec(markdown)) {
    add(m[1] ?? m[2] ?? '');
  }
  const html = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = html.exec(markdown); m !== null; m = html.exec(markdown)) {
    add(m[1] ?? m[2] ?? '');
  }
  return out;
}
