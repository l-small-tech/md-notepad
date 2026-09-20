/**
 * Pointing at the same element from both halves of Split mode.
 *
 * An `.svg` tab's Split shows the SOURCE and the BOARD at once, over one
 * DocModel. Both panes address elements, but in different currencies: the
 * board in `ElementRef`s (layer id + index), the source editor in character
 * offsets. This module is the exchange rate — pure, so it is Vitest-covered
 * without a DOM, and thin, because the hard part (which node became element
 * `n` of layer `l`) is answered by `parseWhiteboardWithSpans` rather than
 * re-derived here. A second walk of the XML would be a second opinion, and
 * the first time the two disagreed the link would point at the wrong shape.
 *
 * Everything here degrades to null/empty rather than throwing: the source
 * editor spends a good part of its life holding text that is not valid XML
 * yet (halfway through typing an attribute), and a link that simply goes
 * quiet is the right answer there.
 */

import type { ElementRef } from './layers';
import { parseWhiteboardWithSpans, type ElementSpan } from './parse';

/** A half-open `[start, end)` slice of the source text. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Every element's source range, or null when the text is not parseable as
 * SVG at all. Callers hold onto the result for as long as the text is
 * unchanged — it is one parse, and both directions of the link read it.
 */
export function sourceSpans(source: string): readonly ElementSpan[] | null {
  try {
    return parseWhiteboardWithSpans(source).spans;
  } catch {
    return null;
  }
}

function sameRef(a: ElementRef, b: ElementRef): boolean {
  return a.layerId === b.layerId && a.index === b.index;
}

export function rangeForRef(spans: readonly ElementSpan[], ref: ElementRef): SourceRange | null {
  const span = spans.find((s) => sameRef(s, ref));
  return span ? { start: span.start, end: span.end } : null;
}

/** The ranges of `refs` that exist, in SOURCE order (not selection order). */
export function rangesForRefs(
  spans: readonly ElementSpan[],
  refs: readonly ElementRef[],
): SourceRange[] {
  return spans
    .filter((span) => refs.some((ref) => sameRef(span, ref)))
    .map((span) => ({ start: span.start, end: span.end }));
}

/**
 * The element `offset` is pointing at, or null.
 *
 * Containment wins: an element whose span holds the offset is the answer, so
 * a hand-authored file with two shapes on one line still answers per-shape.
 * Failing that the whole LINE is searched, and that is the part worth stating
 * out loud — the serializer writes one element per line, so "the caret is
 * somewhere on this line" is what a person means by "this element", including
 * when it sits in the indentation before the `<` or just past the closing `>`.
 */
export function refAtOffset(
  text: string,
  spans: readonly ElementSpan[],
  offset: number,
): ElementRef | null {
  const line = lineRangeAt(text, offset);
  let onLine: ElementSpan | null = null;
  for (const span of spans) {
    if (span.start <= offset && offset < span.end) {
      return { layerId: span.layerId, index: span.index };
    }
    if (onLine === null && span.start < line.end && line.start < span.end) {
      onLine = span;
    }
  }
  return onLine === null ? null : { layerId: onLine.layerId, index: onLine.index };
}

/**
 * The line `offset` falls on, as a range. The line break itself is excluded,
 * so a caret at the very end of a line does not reach the next element.
 */
export function lineRangeAt(text: string, offset: number): SourceRange {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const end = text.indexOf('\n', at);
  return { start, end: end < 0 ? text.length : end };
}

/** Whether two range lists are the same — the link's "nothing moved" test. */
export function sameRanges(a: readonly SourceRange[], b: readonly SourceRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.start === b[i]!.start && r.end === b[i]!.end);
}
