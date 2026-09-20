/**
 * The raw ⇄ draw link that makes Split mode on an `.svg` tab worth having.
 *
 * Both panes already show the same document — they share one DocModel, so an
 * edit on either side arrives on the other without anyone arranging it. What
 * they do NOT share is a way to point: the board knows `ElementRef`s, the
 * source editor knows character offsets. `core/whiteboard/locate.ts` converts
 * between the two; this module is the plumbing around it.
 *
 * Two directions, deliberately asymmetric:
 *
 * - **Board → source** highlights the selection's markup and scrolls it into
 *   view if it is off screen. It does NOT move the caret or take focus:
 *   clicking a shape must never interrupt a sentence being typed in the other
 *   pane. "Reveal in source" (the board's right-click menu) is the explicit
 *   version that does move the caret, because there you asked for it.
 * - **Source → board** selects the element the caret is in and pans to it if
 *   it is off screen. Selecting it — rather than drawing a read-only "you are
 *   here" outline — is the point: from there the ribbon's colour, nib and
 *   arrange controls act on the thing you just found in the text.
 *
 * There is no echo to break: the board→source direction never moves the caret,
 * so it cannot provoke the source→board one. Two things are less obvious and
 * both are load-bearing:
 *
 * - **Every write into the source editor is deferred by a microtask.** Both
 *   directions can be reached from inside a CodeMirror update listener (the
 *   editor pushes into the model, the board clears its selection, we react),
 *   and dispatching a transaction while an update is in progress is exactly
 *   what CM6 forbids.
 * - **A document change forgets where the caret last pointed.** The board
 *   drops its selection on every external change, so the caret has to assert
 *   itself again — without the reset, typing inside the selected shape would
 *   leave the board with nothing selected.
 */

import type { DocModel } from '../core/doc-model';
import type { ElementRef } from '../core/whiteboard/layers';
import type { ElementSpan } from '../core/whiteboard/parse';
import {
  rangesForRefs,
  refAtOffset,
  sameRanges,
  sourceSpans,
  type SourceRange,
} from '../core/whiteboard/locate';
import type { Cm6Adapter } from '../editors/cm6';
import type { WhiteboardAdapter } from '../editors/whiteboard';

export interface SvgSplitLink {
  /** The board's selection changed (its `onSelectionChange`). */
  boardSelection(refs: readonly ElementRef[]): void;
  /** The board's "Reveal in source" was chosen. */
  revealInSource(refs: readonly ElementRef[]): void;
  dispose(): void;
}

export interface SvgSplitLinkOptions {
  model: DocModel;
  source: Cm6Adapter;
  board: WhiteboardAdapter;
}

function sameRef(a: ElementRef | null, b: ElementRef | null): boolean {
  return a === b || (a !== null && b !== null && a.layerId === b.layerId && a.index === b.index);
}

export function linkSvgSplit({ model, source, board }: SvgSplitLinkOptions): SvgSplitLink {
  let disposed = false;

  /**
   * One parse per version of the text, shared by both directions — a keystroke
   * would otherwise walk the file once for the caret lookup and again for the
   * highlight, on top of the board's own re-render.
   */
  let memo: { text: string; spans: readonly ElementSpan[] | null } | null = null;

  function spansNow(): { text: string; spans: readonly ElementSpan[] | null } {
    const text = model.getText();
    if (memo === null || memo.text !== text) {
      memo = { text, spans: sourceSpans(text) };
    }
    return memo;
  }

  /** The ranges currently marked in the source pane — the no-op test. */
  let shownRanges: readonly SourceRange[] = [];
  /** Scheduled marks, coalesced; see the microtask note in the header. */
  let queued: readonly SourceRange[] | null = null;

  function showRanges(ranges: readonly SourceRange[]): void {
    const first = queued === null;
    queued = ranges;
    if (!first) {
      return;
    }
    queueMicrotask(() => {
      const next = queued;
      queued = null;
      if (disposed || next === null) {
        return;
      }
      source.setLinkedRanges(
        next.map((r) => ({ from: r.start, to: r.end })),
        true,
      );
    });
  }

  /** `force` re-issues the marks even when the set is unchanged — after a
   *  document change the offsets they were computed against are gone. */
  function highlight(refs: readonly ElementRef[], force = false): void {
    // The empty case is the common one while someone types (a change clears
    // the board's selection), and it needs no parse at all.
    const spans = refs.length === 0 ? [] : spansNow().spans;
    const ranges = spans === null ? [] : rangesForRefs(spans, refs);
    if (!force && sameRanges(ranges, shownRanges)) {
      return;
    }
    shownRanges = ranges;
    showRanges(ranges);
  }

  /** The element the caret last put on the board — see the header. */
  let caretRef: ElementRef | null = null;

  function onCaret(head: number): void {
    const { text, spans } = spansNow();
    // Unparseable text means the board is showing its last good picture and
    // is inert; there is nothing honest to point at until it parses again.
    if (spans === null) {
      return;
    }
    const ref = refAtOffset(text, spans, head);
    if (sameRef(ref, caretRef)) {
      return;
    }
    caretRef = ref;
    // Reveal, never focus: the caret is what moved, and it is not over here.
    board.selectRefs(ref === null ? [] : [ref], true);
  }

  const unsubscribeCaret = source.subscribeSelection((pos) => onCaret(pos.head));
  const unsubscribeModel = model.subscribe(() => {
    caretRef = null;
    highlight(board.getSelection(), true);
  });

  return {
    boardSelection(refs) {
      highlight(refs);
    },
    revealInSource(refs) {
      const { spans } = spansNow();
      const range = spans === null ? undefined : rangesForRefs(spans, refs)[0];
      if (range) {
        source.revealRange(range.start, range.end);
      }
    },
    dispose() {
      disposed = true;
      unsubscribeCaret();
      unsubscribeModel();
      source.setLinkedRanges([]);
      shownRanges = [];
      memo = null;
    },
  };
}
