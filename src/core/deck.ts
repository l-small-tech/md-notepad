/**
 * deck.ts — what makes a markdown file a Marp slide deck, and the line ↔
 * slide map every deck surface leans on.
 *
 * A deck is not a new kind of tab: it is a markdown document whose YAML
 * frontmatter says `marp: true` (the same convention Marp CLI and Marp for VS
 * Code use). `isMarpDocument` is the entire detection story. It is content-
 * keyed, unlike the rest of `doc-family.ts`, so it only ever looks at the
 * frontmatter — cheap enough to run on every keystroke.
 *
 * `splitSlides` is a LINE SCANNER in the mould of `outline.ts`: slides are
 * separated by thematic-break rulers (`---`, `***`, `___`) outside fenced
 * code, after the frontmatter. Marp's own splitter is the markdown-it `hr`
 * token, which this mirrors for the cases that matter in real decks,
 * including the one that bites: a `---` right under a paragraph line is a
 * setext heading, not a ruler. CRLF-safe.
 */

/** One slide's 1-based, inclusive line range in the source. */
export interface SlideRange {
  start: number;
  end: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A thematic break (`---`, `***`, `- - -`, …); `$1` is the character used. */
const THEMATIC_BREAK = /^ {0,3}(?:([-_*])[ \t]*)(?:\1[ \t]*){2,}$/;
/** A list item or blockquote line — never the paragraph of a setext heading. */
const LIST_OR_QUOTE = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)/;
/** An ATX heading line — a heading already, so never a setext paragraph. */
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** An HTML block line (Marp's directive and note comments above all). */
const HTML_LINE = /^ {0,3}</;
const FRONTMATTER_CLOSE = /^(-{3,}|\.{3})[ \t]*$/;
const MARP_TRUE = /^marp[ \t]*:[ \t]*true[ \t]*$/;

function splitLines(markdown: string): string[] {
  return markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * The 0-based index of the line AFTER a leading YAML frontmatter block, or 0
 * when there is none. An unclosed opener is just text (as in `outline.ts`).
 */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== '---') {
    return 0;
  }
  const close = lines.findIndex((l, n) => n > 0 && FRONTMATTER_CLOSE.test(l));
  return close > 0 ? close + 1 : 0;
}

/** True when the document's frontmatter declares `marp: true`. */
export function isMarpDocument(markdown: string): boolean {
  if (!markdown.startsWith('---')) {
    return false; // the cheap exit for every ordinary note
  }
  const lines = splitLines(markdown);
  const end = frontmatterEnd(lines);
  for (let i = 1; i < end - 1; i++) {
    if (MARP_TRUE.test(lines[i]!)) {
      return true;
    }
  }
  return false;
}

/**
 * The value of a top-level `key:` in the frontmatter (quotes stripped), or
 * null. Enough YAML for Marp's own directives (`theme: gaia`), no more.
 */
export function frontmatterValue(markdown: string, key: string): string | null {
  if (!markdown.startsWith('---')) {
    return null;
  }
  const lines = splitLines(markdown);
  const end = frontmatterEnd(lines);
  const prefix = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`);
  for (let i = 1; i < end - 1; i++) {
    const m = prefix.exec(lines[i]!);
    if (m) {
      return m[1]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return null;
}

/**
 * Each slide's line range, in order. Always at least one slide (an empty
 * document is one empty slide, which is what Marp renders). A ruler line
 * belongs to the slide it OPENS, so a cursor sitting on `---` already counts
 * as being on the next slide — the way the editor feels when you type one.
 */
export function splitSlides(markdown: string): SlideRange[] {
  const lines = splitLines(markdown);
  const first = frontmatterEnd(lines);
  const starts: number[] = [first];
  let fence: { char: string; len: number } | null = null;
  /** Whether the previous line could be the paragraph of a setext heading. */
  let paragraph = false;

  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      paragraph = false;
      continue;
    }
    const brk = THEMATIC_BREAK.exec(line);
    // `---` under a paragraph is a setext h2; `***` / `___` never are.
    if (brk && !(brk[1] === '-' && paragraph)) {
      starts.push(i);
      paragraph = false;
      continue;
    }
    paragraph =
      line.trim() !== '' && !LIST_OR_QUOTE.test(line) && !ATX.test(line) && !HTML_LINE.test(line);
  }

  const total = Math.max(lines.length, 1);
  return starts.map((start, n) => ({
    start: start + 1,
    end: n + 1 < starts.length ? starts[n + 1]! : total,
  }));
}

/**
 * The 0-based slide that contains source `line`. A line above the first
 * slide (the frontmatter) is the first slide; one past the end is the last.
 */
export function slideIndexForLine(slides: readonly SlideRange[], line: number): number {
  let index = 0;
  for (let i = 0; i < slides.length; i++) {
    if (slides[i]!.start <= line) {
      index = i;
    } else {
      break;
    }
  }
  return index;
}

/** Words a presenter speaks per minute — a middling conference pace. */
export const SPEAKING_WPM = 130;

/**
 * A rough talk length for a deck of `words` words, in whole minutes, never
 * below one for a deck with any words at all.
 */
export function speakingMinutes(words: number): number {
  return words <= 0 ? 0 : Math.max(1, Math.round(words / SPEAKING_WPM));
}

/** The status-bar summary for a deck: `12 slides · ~9 min`. */
export function deckSummary(slideCount: number, words: number): string {
  const slides = `${slideCount} ${slideCount === 1 ? 'slide' : 'slides'}`;
  const minutes = speakingMinutes(words);
  return minutes === 0 ? slides : `${slides} · ~${minutes} min`;
}

/**
 * Speaker notes: Marp keeps HTML comments per slide, but a directive comment
 * (`<!-- _class: lead -->`) is an instruction, not a note. Marp has already
 * filtered directives out of the comments it reports; this trims and drops
 * the blanks so a slide with nothing to say has no notes at all.
 */
export function cleanNotes(comments: readonly string[]): string[] {
  return comments.map((c) => c.trim()).filter((c) => c.length > 0);
}
