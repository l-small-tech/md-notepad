/**
 * deck-edit.ts — every change the deck editor (Edit mode on a Marp deck,
 * `editors/deck-editor.ts`) makes to the source, as pure string → string
 * functions.
 *
 * The rule that shapes all of it: a visual tweak touches ONLY the lines it is
 * about. A deck is written by an agent and tweaked by a person, and the file
 * stays the agent's markdown — no re-serialisation, no normalised list
 * markers, directive comments and `![bg]` alt syntax exactly as they were.
 * That is why Milkdown is not the deck's Edit mode (`doc-family.ts`), and why
 * everything here is a line scanner over `splitSlides` ranges rather than a
 * parse → print round trip.
 *
 * Line numbers are 1-based and inclusive throughout, matching `SlideRange`
 * and the `data-line` stamps the editor's render carries (`preview/marp.ts`).
 * CRLF documents stay CRLF: lines are handled bare and re-joined with the
 * document's own ending.
 */

import { frontmatterEnd, splitSlides } from './deck';

/* ---- lines in, lines out ------------------------------------------------- */

interface Doc {
  lines: string[];
  crlf: boolean;
}

function open(markdown: string): Doc {
  const raw = markdown.split('\n');
  const crlf = raw.length > 1 && raw.slice(0, -1).every((l) => l.endsWith('\r'));
  return { lines: crlf ? raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) : raw, crlf };
}

function close(doc: Doc): string {
  return doc.lines.join(doc.crlf ? '\r\n' : '\n');
}

const isBlank = (line: string | undefined): boolean => line === undefined || line.trim() === '';

/** Two blank lines left where something was removed become one. */
function collapseBlankAt(lines: string[], index: number): void {
  if (index > 0 && index < lines.length && isBlank(lines[index]) && isBlank(lines[index - 1])) {
    lines.splice(index, 1);
  }
}

/* ---- blocks (click-to-edit) ---------------------------------------------- */

export interface LineRange {
  start: number;
  end: number;
}

/**
 * A stamped range made safe to edit: clamped to the document, and with the
 * trailing blank lines markdown-it's `map` swallows (the line after a list)
 * given back.
 */
export function blockRange(markdown: string, start: number, end: number): LineRange {
  const { lines } = open(markdown);
  const first = Math.min(Math.max(1, start), lines.length);
  let last = Math.min(Math.max(first, end), lines.length);
  while (last > first && isBlank(lines[last - 1])) {
    last--;
  }
  return { start: first, end: last };
}

/** The source of lines `start..end`, `\n`-joined whatever the document uses. */
export function getLines(markdown: string, start: number, end: number): string {
  return open(markdown)
    .lines.slice(start - 1, end)
    .join('\n');
}

/**
 * Replace lines `start..end` with `text` (any line ending). Empty text removes
 * the block, and the blank line that separated it goes with it.
 */
export function replaceLines(markdown: string, start: number, end: number, text: string): string {
  const doc = open(markdown);
  const next = text === '' ? [] : text.split(/\r?\n/);
  doc.lines.splice(start - 1, end - start + 1, ...next);
  if (next.length === 0) {
    collapseBlankAt(doc.lines, start - 1);
  }
  return close(doc);
}

/* ---- slides as movable bodies -------------------------------------------- */

interface Parts {
  /** The frontmatter block, untouched. */
  head: string[];
  /** Ruler `n` opens slide `n + 1`. Rulers stay put; bodies move between them. */
  rulers: string[];
  /** Each slide's lines WITHOUT the ruler that opens it. */
  bodies: string[][];
}

function takeApart(doc: Doc, markdown: string): Parts {
  const ranges = splitSlides(markdown);
  const headEnd = ranges[0]!.start - 1;
  const parts: Parts = { head: doc.lines.slice(0, headEnd), rulers: [], bodies: [] };
  ranges.forEach((range, n) => {
    if (n === 0) {
      parts.bodies.push(doc.lines.slice(range.start - 1, range.end));
    } else {
      parts.rulers.push(doc.lines[range.start - 1]!);
      parts.bodies.push(doc.lines.slice(range.start, range.end));
    }
  });
  return parts;
}

function putTogether(parts: Parts, crlf: boolean): string {
  const lines = [...parts.head];
  parts.bodies.forEach((body, n) => {
    if (n > 0) {
      // A `---` right under a text line is a setext heading, not a ruler — a
      // body that used to END the file has no blank line of its own to give.
      if (lines.length > parts.head.length && !isBlank(lines[lines.length - 1])) {
        lines.push('');
      }
      lines.push(parts.rulers[n - 1] ?? '---');
    }
    lines.push(...body);
  });
  return close({ lines, crlf });
}

/** How many slides the document has (always at least one). */
export function slideCount(markdown: string): number {
  return splitSlides(markdown).length;
}

/** Move slide `from` so it sits at index `to` (both 0-based). */
export function moveSlide(markdown: string, from: number, to: number): string {
  const doc = open(markdown);
  const parts = takeApart(doc, markdown);
  const count = parts.bodies.length;
  if (from < 0 || from >= count || to < 0 || to >= count || from === to) {
    return markdown;
  }
  const [body] = parts.bodies.splice(from, 1);
  parts.bodies.splice(to, 0, body!);
  return putTogether(parts, doc.crlf);
}

/** A copy of slide `index`, right after it. */
export function duplicateSlide(markdown: string, index: number): string {
  const doc = open(markdown);
  const parts = takeApart(doc, markdown);
  const body = parts.bodies[index];
  if (!body) {
    return markdown;
  }
  parts.bodies.splice(index + 1, 0, [...body]);
  parts.rulers.splice(index, 0, '---');
  return putTogether(parts, doc.crlf);
}

/** Remove slide `index`. The last remaining slide is emptied, never removed. */
export function deleteSlide(markdown: string, index: number): string {
  const doc = open(markdown);
  const parts = takeApart(doc, markdown);
  if (index < 0 || index >= parts.bodies.length) {
    return markdown;
  }
  if (parts.bodies.length === 1) {
    parts.bodies[0] = [''];
    return putTogether(parts, doc.crlf);
  }
  parts.bodies.splice(index, 1);
  parts.rulers.splice(Math.max(index - 1, 0), 1);
  return putTogether(parts, doc.crlf);
}

/** The body a new slide starts with. */
export const NEW_SLIDE_BODY: readonly string[] = ['', '# New slide', ''];

/** A fresh slide after slide `after` (0-based); -1 puts it first. */
export function insertSlide(markdown: string, after: number): string {
  const doc = open(markdown);
  const parts = takeApart(doc, markdown);
  const at = Math.min(Math.max(after + 1, 0), parts.bodies.length);
  parts.bodies.splice(at, 0, [...NEW_SLIDE_BODY]);
  parts.rulers.splice(Math.max(at - 1, 0), 0, '---');
  return putTogether(parts, doc.crlf);
}

/* ---- comments: directives and speaker notes ------------------------------ */

/** Marpit's and Marp Core's directive keys; a comment naming one is not a note. */
const DIRECTIVE_KEYS = [
  'backgroundColor',
  'backgroundImage',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundSize',
  'class',
  'color',
  'footer',
  'header',
  'headingDivider',
  'lang',
  'marp',
  'math',
  'paginate',
  'size',
  'style',
  'theme',
  'title',
  'author',
  'description',
  'keywords',
  'url',
  'image',
];
const DIRECTIVE_LINE = new RegExp(`^\\s*(?:<!--\\s*)?_?(?:${DIRECTIVE_KEYS.join('|')})\\s*:`);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface Comment {
  /** 0-based line indexes, inclusive. */
  start: number;
  end: number;
  directive: boolean;
  /** The text between `<!--` and `-->`. */
  inner: string;
}

/** The whole-line HTML comments of lines `[from, to)`, outside fenced code. */
function commentsIn(lines: readonly string[], from: number, to: number): Comment[] {
  const found: Comment[] = [];
  let fence: string | null = null;
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (!/^ {0,3}<!--/.test(line)) {
      continue;
    }
    let end = i;
    while (
      end < to &&
      !lines[end]!.slice(end === i ? line.indexOf('<!--') + 4 : 0).includes('-->')
    ) {
      end++;
    }
    if (end >= to || lines[end]!.slice(lines[end]!.lastIndexOf('-->') + 3).trim() !== '') {
      continue; // unclosed, or text after the comment: not a comment of its own
    }
    const body = lines.slice(i, end + 1);
    const inner = body
      .join('\n')
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '');
    found.push({ start: i, end, inner, directive: body.some((l) => DIRECTIVE_LINE.test(l)) });
    i = end;
  }
  return found;
}

/** Slide `index`'s body as 0-based `[from, to)` line indexes (ruler excluded). */
function bodySpan(markdown: string, index: number): { from: number; to: number } | null {
  const ranges = splitSlides(markdown);
  const range = ranges[index];
  if (!range) {
    return null;
  }
  return { from: index === 0 ? range.start - 1 : range.start, to: range.end };
}

/** A scalar Marp's (loose) YAML reads back as exactly `value`. */
function yamlScalar(value: string): string {
  const plain =
    value !== '' &&
    value === value.trim() &&
    !/^["'[\]{}|>~&*!%@`,?-]/.test(value) &&
    !/: | #|:$/.test(value);
  return plain ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function keyLine(key: string): RegExp {
  return new RegExp(`^(\\s*(?:<!--\\s*)?)(_${key}[ \\t]*:)[ \\t]*(.*?)([ \\t]*(?:-->[ \\t]*)?)$`);
}

/**
 * This slide's OWN value for a directive — the spot form, `_class`, which is
 * the one the inspector writes. An inherited value (`class:` on an earlier
 * slide, the frontmatter) is not this slide's to show or clear.
 */
export function getSlideDirective(markdown: string, index: number, key: string): string | null {
  const span = bodySpan(markdown, index);
  if (!span) {
    return null;
  }
  const { lines } = open(markdown);
  const pattern = keyLine(key);
  for (const comment of commentsIn(lines, span.from, span.to)) {
    for (let i = comment.start; i <= comment.end; i++) {
      const m = pattern.exec(lines[i]!);
      if (m) {
        return unquote(m[3]!);
      }
    }
  }
  return null;
}

/** Where new slide-level lines go: under the body's leading directive comments. */
function bodyInsertPoint(lines: readonly string[], from: number, to: number): number {
  const comments = commentsIn(lines, from, to);
  let at = from;
  for (;;) {
    while (at < to && isBlank(lines[at])) {
      at++;
    }
    const comment = comments.find((c) => c.start === at && c.directive);
    if (!comment) {
      return at;
    }
    at = comment.end + 1;
  }
}

/** Insert `block` at `at`, keeping a blank line between it and a text neighbour. */
function insertBlock(lines: string[], at: number, block: readonly string[], floor: number): void {
  const out = [...block];
  if (at < lines.length && !isBlank(lines[at])) {
    out.push('');
  }
  if (at > floor && !isBlank(lines[at - 1])) {
    out.unshift('');
  }
  lines.splice(at, 0, ...out);
}

/**
 * Set (or with `null`/empty, clear) this slide's spot directive `_key`. An
 * existing line is rewritten in place — inside whatever comment holds it — and
 * a new one becomes a one-line comment at the top of the slide.
 */
export function setSlideDirective(
  markdown: string,
  index: number,
  key: string,
  value: string | null,
): string {
  const span = bodySpan(markdown, index);
  if (!span) {
    return markdown;
  }
  const doc = open(markdown);
  const { lines } = doc;
  const pattern = keyLine(key);
  const wanted = value === null || value === '' ? null : yamlScalar(value);
  for (const comment of commentsIn(lines, span.from, span.to)) {
    for (let i = comment.start; i <= comment.end; i++) {
      const m = pattern.exec(lines[i]!);
      if (!m) {
        continue;
      }
      if (wanted !== null) {
        lines[i] = `${m[1]}${m[2]} ${wanted}${m[4] || ''}`;
        return close(doc);
      }
      const rest = `${m[1]}${m[4]}`;
      if (rest.trim() === '' || /^\s*<!--\s*-->\s*$/.test(rest)) {
        lines.splice(i, 1);
        comment.end--;
      } else {
        lines[i] = rest;
      }
      // A comment left holding nothing goes entirely.
      const left = lines.slice(comment.start, comment.end + 1).join('\n');
      if (comment.end >= comment.start && /^\s*<!--\s*-->\s*$/.test(left)) {
        lines.splice(comment.start, comment.end - comment.start + 1);
      }
      collapseBlankAt(lines, Math.min(i, comment.start));
      return close(doc);
    }
  }
  if (wanted === null) {
    return markdown;
  }
  const at = bodyInsertPoint(lines, span.from, span.to);
  insertBlock(lines, at, [`<!-- _${key}: ${wanted} -->`], span.from);
  return close(doc);
}

/** The slide's speaker notes: its non-directive comments, blank-line joined. */
export function getSlideNotes(markdown: string, index: number): string {
  const span = bodySpan(markdown, index);
  if (!span) {
    return '';
  }
  return commentsIn(open(markdown).lines, span.from, span.to)
    .filter((c) => !c.directive)
    .map((c) => c.inner.trim())
    .filter((text) => text !== '')
    .join('\n\n');
}

function noteComment(text: string): string[] {
  const safe = text.trim().replace(/-->/g, '-- >');
  return safe.includes('\n') ? ['<!--', ...safe.split(/\r?\n/), '-->'] : [`<!-- ${safe} -->`];
}

/**
 * Write the slide's speaker notes as ONE comment: the first note comment is
 * replaced where it stands (a new one goes to the end of the slide), any other
 * note comments are folded into it. Empty text removes the notes.
 */
export function setSlideNotes(markdown: string, index: number, text: string): string {
  if (getSlideNotes(markdown, index) === text.trim()) {
    return markdown;
  }
  const span = bodySpan(markdown, index);
  if (!span) {
    return markdown;
  }
  const doc = open(markdown);
  const { lines } = doc;
  const notes = commentsIn(lines, span.from, span.to).filter((c) => !c.directive);
  const block = text.trim() === '' ? [] : noteComment(text);
  let to = span.to;
  for (const comment of [...notes].reverse()) {
    const size = comment.end - comment.start + 1;
    const replacement = comment === notes[0] ? block : [];
    lines.splice(comment.start, size, ...replacement);
    to += replacement.length - size;
    if (replacement.length === 0) {
      const before = lines.length;
      collapseBlankAt(lines, comment.start);
      to -= before - lines.length;
    }
  }
  if (notes.length === 0 && block.length > 0) {
    let at = to;
    while (at > span.from && isBlank(lines[at - 1])) {
      at--;
    }
    insertBlock(lines, at, block, span.from);
  }
  return close(doc);
}

/** Add `text` as a new block at the end of the slide's content (above its notes). */
export function appendBlock(markdown: string, index: number, text: string): string {
  const span = bodySpan(markdown, index);
  if (!span) {
    return markdown;
  }
  const doc = open(markdown);
  const { lines } = doc;
  const comments = commentsIn(lines, span.from, span.to);
  let at = span.to;
  for (;;) {
    while (at > span.from && isBlank(lines[at - 1])) {
      at--;
    }
    const trailing = comments.find((c) => c.end === at - 1 && !c.directive);
    if (!trailing) {
      break;
    }
    at = trailing.start;
  }
  insertBlock(lines, at, text.split(/\r?\n/), span.from);
  return close(doc);
}

/** The 1-based line range `appendBlock` would give `text` — for opening it to edit. */
export function appendedBlockRange(before: string, after: string): LineRange | null {
  const a = open(before).lines;
  const b = open(after).lines;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) {
    tail++;
  }
  let start = head;
  let end = b.length - tail - 1;
  while (start <= end && isBlank(b[start])) {
    start++;
  }
  while (end >= start && isBlank(b[end])) {
    end--;
  }
  return start <= end ? { start: start + 1, end: end + 1 } : null;
}

/* ---- background image ---------------------------------------------------- */

export type BackgroundSide = 'full' | 'left' | 'right';
export type BackgroundFit = 'cover' | 'contain' | 'fit' | 'auto';

export interface SlideBackground {
  src: string;
  /** `left` / `right` make it a split background beside the content. */
  side: BackgroundSide;
  /** The split's share of the slide, e.g. `40%`; null for Marp's half. */
  sideSize: string | null;
  fit: BackgroundFit | null;
  /** Keywords this editor does not manage (`blur`, `opacity:.4`…), kept verbatim. */
  extra: string[];
}

const IMAGE_LINE = /^(\s*)!\[([^\]]*)\]\((<[^>]*>|[^)\s]*)((?:\s+"[^"]*")?)\)\s*$/;
const FITS: readonly string[] = ['cover', 'contain', 'fit', 'auto'];

function parseBackground(line: string): SlideBackground | null {
  const m = IMAGE_LINE.exec(line);
  const words = m ? m[2]!.split(/\s+/).filter(Boolean) : [];
  if (!m || !words.includes('bg')) {
    return null;
  }
  const bg: SlideBackground = {
    src: m[3]!.replace(/^<(.*)>$/, '$1'),
    side: 'full',
    sideSize: null,
    fit: null,
    extra: [],
  };
  for (const word of words) {
    const side = /^(left|right)(?::(.+))?$/.exec(word);
    if (word === 'bg') {
      continue;
    } else if (side) {
      bg.side = side[1] as BackgroundSide;
      bg.sideSize = side[2] ?? null;
    } else if (FITS.includes(word)) {
      bg.fit = word as BackgroundFit;
    } else {
      bg.extra.push(word);
    }
  }
  return bg;
}

function backgroundLine(lines: readonly string[], from: number, to: number): number {
  let fence: string | null = null;
  for (let i = from; i < to; i++) {
    const mark = FENCE.exec(lines[i]!)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) {
        fence = null;
      }
    } else if (mark) {
      fence = mark;
    } else if (parseBackground(lines[i]!)) {
      return i;
    }
  }
  return -1;
}

/** The slide's (first) `![bg](…)` image, or null. */
export function getSlideBackground(markdown: string, index: number): SlideBackground | null {
  const span = bodySpan(markdown, index);
  if (!span) {
    return null;
  }
  const { lines } = open(markdown);
  const at = backgroundLine(lines, span.from, span.to);
  return at < 0 ? null : parseBackground(lines[at]!);
}

function formatBackground(bg: SlideBackground, indent: string, title: string): string {
  const words = ['bg'];
  if (bg.side !== 'full') {
    words.push(bg.sideSize ? `${bg.side}:${bg.sideSize}` : bg.side);
  }
  if (bg.fit) {
    words.push(bg.fit);
  }
  words.push(...bg.extra);
  const src = /[\s()]/.test(bg.src) ? `<${bg.src}>` : bg.src;
  return `${indent}![${words.join(' ')}](${src}${title})`;
}

/** Set, change or (with null) remove the slide's background image line. */
export function setSlideBackground(
  markdown: string,
  index: number,
  bg: SlideBackground | null,
): string {
  const span = bodySpan(markdown, index);
  if (!span) {
    return markdown;
  }
  const doc = open(markdown);
  const { lines } = doc;
  const at = backgroundLine(lines, span.from, span.to);
  if (at >= 0) {
    if (bg === null || bg.src.trim() === '') {
      lines.splice(at, 1);
      collapseBlankAt(lines, at);
    } else {
      const m = IMAGE_LINE.exec(lines[at]!)!;
      lines[at] = formatBackground(bg, m[1]!, m[4]!);
    }
    return close(doc);
  }
  if (bg === null || bg.src.trim() === '') {
    return markdown;
  }
  insertBlock(
    lines,
    bodyInsertPoint(lines, span.from, span.to),
    [formatBackground(bg, '', '')],
    span.from,
  );
  return close(doc);
}

/* ---- inline image width --------------------------------------------------- */

const INLINE_IMAGE = /!\[([^\]]*)\]\(/g;
const WIDTH_WORD = /^(?:w|width):(.+)$/;

/** The `w:` / `width:` keyword of the `n`th image in a block's source, or null. */
export function getImageWidth(blockText: string, n: number): string | null {
  const alt = [...blockText.matchAll(INLINE_IMAGE)][n]?.[1];
  if (alt === undefined) {
    return null;
  }
  for (const word of alt.split(/\s+/)) {
    const m = WIDTH_WORD.exec(word);
    if (m) {
      return m[1]!;
    }
  }
  return null;
}

/** Set (`300px`, `50%`) or clear the width keyword of the block's `n`th image. */
export function setImageWidth(blockText: string, n: number, width: string | null): string {
  const match = [...blockText.matchAll(INLINE_IMAGE)][n];
  if (!match) {
    return blockText;
  }
  const words = match[1]!.split(/\s+/).filter((w) => w !== '' && !WIDTH_WORD.test(w));
  const value = width?.trim().replace(/\s+/g, '') ?? '';
  if (value !== '') {
    words.push(`w:${/^\d+(\.\d+)?$/.test(value) ? `${value}px` : value}`);
  }
  const start = match.index + 2;
  return blockText.slice(0, start) + words.join(' ') + blockText.slice(start + match[1]!.length);
}

/* ---- deck-wide settings (frontmatter) ------------------------------------ */

/** Set or (with null/empty) remove a top-level frontmatter key. */
export function setFrontmatterValue(markdown: string, key: string, value: string | null): string {
  const doc = open(markdown);
  const { lines } = doc;
  const end = frontmatterEnd(lines);
  if (end === 0) {
    return markdown; // not a deck: nothing of ours to write into
  }
  const pattern = new RegExp(`^${key}[ \\t]*:`);
  const wanted = value === null || value === '' ? null : `${key}: ${yamlScalar(value)}`;
  for (let i = 1; i < end - 1; i++) {
    if (pattern.test(lines[i]!)) {
      if (wanted === null) {
        lines.splice(i, 1);
      } else {
        lines[i] = wanted;
      }
      return close(doc);
    }
  }
  if (wanted !== null) {
    lines.splice(end - 1, 0, wanted);
  }
  return close(doc);
}
