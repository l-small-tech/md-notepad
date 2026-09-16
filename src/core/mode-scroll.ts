/**
 * Keeping your place across a mode switch.
 *
 * Every mode shows the SAME document through a different surface, and each
 * surface scrolls in its own coordinate space: CM6 in source lines, the
 * preview/Review panes in rendered blocks, the Edit editor in ProseMirror
 * nodes. The one coordinate all three can speak is the **1-based source
 * line**, so a mode switch captures the line at the top of the outgoing
 * surface and asks the incoming one to put that line back on top.
 *
 * This module is the pure half of that: which surface owns a mode's scroll,
 * and the two mappings a surface needs to translate a line into something it
 * can address. The DOM half lives in `ui/mode-scroll.ts` (the per-tab port
 * registry) and in each surface's `getTopLine` / `scrollToLine`.
 */

import type { OutlineHeading } from './outline';
import type { EditorMode } from './types';

/**
 * The surface whose scroll position a mode shows.
 *
 * `split` maps to `source`: both panes are on screen, but the editor is the
 * one the reader drives (the preview is a projection of it), so the editor's
 * position is the authoritative one to carry in and out.
 */
export type ScrollSurface = 'source' | 'rendered' | 'edit';

export function scrollSurfaceFor(mode: EditorMode): ScrollSurface | null {
  switch (mode) {
    case 'raw':
    case 'split':
      return 'source';
    case 'read':
      return 'rendered';
    case 'wysiwyg':
      return 'edit';
    // A whiteboard scrolls in board coordinates and a terminal not at all —
    // neither has a source line to carry.
    case 'draw':
    case 'term':
      return null;
  }
}

/**
 * The stamp to scroll to for source line `line`, given the lines a rendered
 * surface actually has elements for (`data-line` on the preview's blocks, on
 * a Review card's declaration), in document order.
 *
 * The greatest stamp at or before `line` — the block the line lives IN, which
 * is where the reader was looking. Before the first stamp (frontmatter, a
 * preamble above the first card) the first one is the closest thing to the
 * top. Null only when there is nothing rendered yet.
 */
export function stampedLineFor(stamps: readonly number[], line: number): number | null {
  let best: number | null = null;
  for (const stamp of stamps) {
    if (stamp <= line && (best === null || stamp > best)) {
      best = stamp;
    }
  }
  if (best !== null) {
    return best;
  }
  let first: number | null = null;
  for (const stamp of stamps) {
    if (first === null || stamp < first) {
      first = stamp;
    }
  }
  return first;
}

/**
 * The heading whose section contains `line`, as an index into `headings`
 * (document order — the same index `revealHeading` takes). -1 when the line
 * is above the first heading, i.e. "the top of the document".
 *
 * The Edit editor renders markdown as ProseMirror nodes with no line numbers
 * at all, so headings are the finest shared landmark it has. Coarse by
 * design: landing on the right section beats landing on line 1.
 */
export function headingIndexForLine(headings: readonly OutlineHeading[], line: number): number {
  let index = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i]!.line <= line) {
      index = i;
    } else {
      break;
    }
  }
  return index;
}

/** The source line of the nth heading (the inverse of `headingIndexForLine`). */
export function lineForHeadingIndex(
  headings: readonly OutlineHeading[],
  index: number,
): number | null {
  return headings[index]?.line ?? null;
}
