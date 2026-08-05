/**
 * Word wrapping for the text box.
 *
 * SVG `<text>` does NOT wrap — every line in the file is a `<tspan>` that was
 * decided when the text was written. So a box the user drags out is a wrapping
 * hint for the EDITOR, and this is where the hint becomes lines. The result is
 * what a browser renders, on any machine, forever; nothing re-flows later.
 *
 * Measurement is injected because the only honest measure of a glyph run is the
 * font engine's, which lives in the DOM (the adapter hands us a canvas
 * `measureText`). That keeps this module pure, testable, and DOM-free like the
 * rest of core.
 */

/**
 * Wrap `text` to `maxWidth`, in whatever unit `measure` returns.
 *
 * Explicit newlines are paragraph breaks and always survive — the user pressed
 * Enter and meant it. Within a paragraph the wrap is greedy on whitespace, and
 * a single word too long for the box is broken by character rather than allowed
 * to run out of it (a URL in a narrow box has to go somewhere).
 *
 * Trailing space is kept on the line it wrapped from, so committing and
 * re-editing round-trips the user's spacing instead of quietly eating it.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: (run: string) => number,
): string[] {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  if (!(maxWidth > 0)) {
    return paragraphs;
  }
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    out.push(...wrapParagraph(paragraph, maxWidth, measure));
  }
  return out;
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  measure: (run: string) => number,
): string[] {
  // Chunks alternate word / whitespace, so a break can land on the whitespace
  // and keep it with the line above.
  const chunks = paragraph.match(/\s+|\S+/g) ?? [];
  const lines: string[] = [];
  let line = '';
  for (const chunk of chunks) {
    const candidate = line + chunk;
    if (line !== '' && measure(candidate) > maxWidth) {
      lines.push(line);
      // A break swallows the whitespace that caused it — a line must not start
      // with the space the previous one ended before.
      line = /^\s+$/.test(chunk) ? '' : chunk;
    } else {
      line = candidate;
    }
    // The word itself may still overflow; break it by character.
    while (measure(line) > maxWidth && line.length > 1) {
      const head = longestFitting(line, maxWidth, measure);
      lines.push(head);
      line = line.slice(head.length);
    }
  }
  if (line !== '' || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

/** The longest prefix of `run` that fits, never empty (progress must happen). */
function longestFitting(run: string, maxWidth: number, measure: (r: string) => number): string {
  let fit = 1;
  for (let n = 2; n <= run.length; n++) {
    if (measure(run.slice(0, n)) > maxWidth) {
      break;
    }
    fit = n;
  }
  return run.slice(0, fit);
}
