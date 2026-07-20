/**
 * outline.ts — extract a document outline (headings) from markdown.
 *
 * A deliberate LINE SCANNER, not a unified/mdast parse: the outline panel
 * recomputes this on a typing debounce, so it must be cheap, and headings are
 * a line-level construct. Handles the cases that matter for real notes:
 * ATX (`# title`, up to 3 leading spaces, optional closing `#` run), setext
 * (`===`/`---` under a paragraph line), fenced code blocks (``` and ~~~,
 * closed by a same-char fence of at least the opening length) whose contents
 * never count, and a leading YAML frontmatter block. CRLF-safe.
 */

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 1-based line number of the heading text line. */
  line: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** A list item or blockquote line — never a setext paragraph line. */
const LIST_OR_QUOTE = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)/;
/** A thematic break (`---`, `***`, `- - -`, …) — also never a paragraph. */
const THEMATIC_BREAK = /^ {0,3}(?:[-_*][ \t]*){3,}$/;

export function extractOutline(markdown: string): OutlineHeading[] {
  const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const headings: OutlineHeading[] = [];
  let start = 0;

  // YAML frontmatter: `---` on the very first line, skipped only when a
  // closing `---`/`...` delimiter exists (an unclosed opener is just text).
  if (lines[0] === '---') {
    const close = lines.findIndex((l, n) => n > 0 && /^(-{3,}|\.{3})[ \t]*$/.test(l));
    if (close > 0) {
      start = close + 1;
    }
  }

  /** The open fence we are inside, or null. */
  let fence: { char: string; len: number } | null = null;
  /** The previous line, when it could be the paragraph of a setext heading. */
  let candidate: { text: string; line: number } | null = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        fence = null;
      }
      continue; // everything inside (and the fences themselves) is ignored
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1]![0]!, len: open[1]!.length };
      candidate = null;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      // Strip a trailing closing sequence (` ###`); a "text" that is only #s
      // was itself the closing sequence of an empty heading (`# #`).
      let text = (atx[2] ?? '').replace(/[ \t]+#+$/, '').trim();
      if (/^#+$/.test(text)) {
        text = '';
      }
      headings.push({ level: atx[1]!.length as OutlineHeading['level'], text, line: i + 1 });
      candidate = null;
      continue;
    }

    const setext = SETEXT.exec(line);
    if (setext && candidate) {
      const level = setext[1]![0] === '=' ? 1 : 2;
      headings.push({ level, text: candidate.text.trim(), line: candidate.line });
      candidate = null;
      continue;
    }

    // Track whether THIS line could head a setext underline on the next one:
    // it must be non-blank and not a list/quote/thematic-break line.
    candidate =
      line.trim() === '' || LIST_OR_QUOTE.test(line) || THEMATIC_BREAK.test(line)
        ? null
        : { text: line, line: i + 1 };
  }

  return headings;
}
