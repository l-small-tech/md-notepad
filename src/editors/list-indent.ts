/**
 * Pure list re-indentation for the raw (CM6) editor.
 *
 * Word-like Tab / Shift+Tab on markdown list items:
 *
 * - Bullets cycle their marker with depth — `*` at column 0, `-` one level in,
 *   `+` two levels in, then repeating. Dedenting a nested `- item` therefore
 *   restores `* item` at column 0.
 * - Ordered items keep valid markdown (no `a.` / `i.` — CommonMark has no
 *   letter numbering) and are renumbered so each sibling run counts from 1.
 * - A moved item takes its descendants with it, so nesting stays intact.
 * - Levels can never be skipped: the first item at a given depth has no
 *   preceding sibling to nest under, so Tab leaves it alone.
 *
 * No DOM and no CodeMirror types — see `src/editors/README.md`, adapters are
 * thin glue and logic lives beside them in pure, tested modules.
 */

/** Bullet markers by depth, repeating every three levels. */
const BULLET_CYCLE = ['*', '-', '+'] as const;

/** A tab counts as this many columns when measuring existing indentation. */
const TAB_WIDTH = 4;

/** `indent`, marker (`-`/`*`/`+` or `12.`/`12)`), the gap, then the content. */
const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)(.*)$/;

/** The parts of a markdown list line, as written. */
export interface ParsedListLine {
  indent: string;
  /** `-`, `*`, `+`, or an ordered marker including its delimiter (`3.`). */
  marker: string;
  /** The gap between marker and content; at least one space. */
  space: string;
  content: string;
  ordered: boolean;
}

/** Parse a list line, or `null` when the line is not a list item. */
export function parseListLine(text: string): ParsedListLine | null {
  const match = LIST_LINE.exec(text);
  if (!match) return null;
  const indent = match[1] ?? '';
  const marker = match[2] ?? '';
  const space = match[3] ?? '';
  const content = match[4] ?? '';
  // `-foo` and `*emphasis*` are not lists: a marker needs a gap after it.
  if (space.length === 0 && content.length > 0) return null;
  return {
    indent,
    marker,
    space: space.length > 0 ? space : ' ',
    content,
    ordered: /\d/.test(marker),
  };
}

/** Visual width of an indent string, expanding tabs. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? TAB_WIDTH : 1;
  return width;
}

interface LineInfo {
  parsed: ParsedListLine;
  level: number;
  width: number;
}

/**
 * Widen `[startLine, endLine]` to the surrounding list block, so ordered
 * renumbering sees the whole sibling run. A single blank line may separate
 * items (loose lists); two blanks or any non-list text ends the block.
 */
function blockBounds(lines: string[], startLine: number, endLine: number): [number, number] {
  const scan = (from: number, step: -1 | 1): number => {
    let last = from;
    let blanks = 0;
    for (let i = from + step; i >= 0 && i < lines.length; i += step) {
      const text = lines[i] ?? '';
      if (parseListLine(text)) {
        last = i;
        blanks = 0;
      } else if (text.trim() === '' && blanks === 0) {
        blanks = 1;
      } else {
        break;
      }
    }
    return last;
  };
  return [scan(startLine, -1), scan(endLine, 1)];
}

/** Assign a nesting level to every line of the block (blank lines get `null`). */
function describeBlock(lines: string[], blockStart: number, blockEnd: number): (LineInfo | null)[] {
  const info: (LineInfo | null)[] = [];
  const stack: number[] = [];
  for (let i = blockStart; i <= blockEnd; i++) {
    const parsed = parseListLine(lines[i] ?? '');
    if (!parsed) {
      info.push(null);
      continue;
    }
    const width = indentWidth(parsed.indent);
    while (stack.length > 0 && (stack[stack.length - 1] ?? 0) > width) stack.pop();
    if (stack.length === 0 || (stack[stack.length - 1] ?? 0) < width) stack.push(width);
    info.push({ parsed, level: stack.length - 1, width });
  }
  return info;
}

/**
 * Re-indent the list lines in `[startLine, endLine]` (0-based, inclusive) by
 * one level in the direction of `delta`, rewriting bullet markers and ordered
 * numbering across the surrounding block.
 *
 * Returns a full replacement `lines` array, or `null` when the range is not
 * entirely list items — the caller should then leave Tab to its default
 * behaviour. The returned array may be unchanged (dedent at column 0, or an
 * indent that would skip a level); callers should diff before dispatching.
 */
export function reindentLists(
  lines: string[],
  startLine: number,
  endLine: number,
  delta: 1 | -1,
): string[] | null {
  if (startLine < 0 || endLine >= lines.length || startLine > endLine) return null;
  for (let i = startLine; i <= endLine; i++) {
    if (!parseListLine(lines[i] ?? '')) return null;
  }

  const [blockStart, blockEnd] = blockBounds(lines, startLine, endLine);
  const info = describeBlock(lines, blockStart, blockEnd);
  const at = (i: number): LineInfo | null => info[i - blockStart] ?? null;

  // Selected lines move; so do their descendants, keeping the subtree together.
  const levelDelta = new Map<number, number>();
  for (let i = startLine; i <= endLine; i++) levelDelta.set(i, delta);
  for (let i = startLine; i <= endLine; i++) {
    const item = at(i);
    if (!item) continue;
    for (let j = i + 1; j <= blockEnd; j++) {
      const child = at(j);
      if (!child) continue;
      if (child.level <= item.level) break;
      levelDelta.set(j, delta);
    }
  }

  const out = lines.slice();
  /** Content column of the most recent emitted item at each level. */
  const parents: number[] = [];
  /** Ordered-item counter per level; `0` once a bullet breaks the run. */
  const counters: number[] = [];

  for (let i = blockStart; i <= blockEnd; i++) {
    const item = at(i);
    if (!item) continue; // blank line inside a loose list — left as is

    // Never skip a level: without a preceding sibling there is nothing to nest under.
    let level = Math.max(0, item.level + (levelDelta.get(i) ?? 0));
    if (level > parents.length) level = parents.length;

    const indent = level === 0 ? 0 : (parents[level - 1] ?? 0);
    parents.length = level;
    counters.length = level + 1;

    let marker: string;
    if (item.parsed.ordered) {
      const n = (counters[level] ?? 0) + 1;
      counters[level] = n;
      marker = `${n}${item.parsed.marker.slice(-1)}`;
    } else {
      counters[level] = 0;
      marker = BULLET_CYCLE[level % BULLET_CYCLE.length] ?? '-';
    }

    const rebuilt = ' '.repeat(indent) + marker + item.parsed.space + item.parsed.content;
    parents[level] = indent + marker.length + item.parsed.space.length;
    out[i] = rebuilt;
  }

  return out;
}
