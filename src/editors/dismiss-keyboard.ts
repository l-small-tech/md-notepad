/**
 * dismiss-keyboard.ts — a mobile-only CodeMirror gesture that hides the Android
 * soft keyboard on a double-tap inside the editor.
 *
 * On a touch device the only way to retract the soft keyboard from web content
 * is to blur the focused editable element; there is no imperative "hide
 * keyboard" API in the WebView. So a quick double-tap on the text collapses any
 * selection and blurs `view.contentDOM`, and the keyboard slides away — leaving
 * the whole document visible for reading/scrolling. Tapping the text again
 * refocuses and brings the keyboard back, the browser's normal behaviour.
 *
 * Like voice-gutter.ts's long-press, this is strictly input-only: it never
 * dispatches a document change (the selection-collapse is a no-op selection
 * move), so it cannot desync the DocModel projection (invariant I1) and is safe
 * to spread into the CM6 `attach` extension list.
 *
 * The double-tap decision lives in the pure `isDoubleTap` predicate so it can be
 * unit-tested without a DOM (per src/editors/README "Testing expectations").
 */

import { EditorView } from '@codemirror/view';

/** A single tap: when it lifted (ms, from the event timeStamp) and where. */
export interface Tap {
  time: number;
  x: number;
  y: number;
}

/** Max gap between the two taps of a double-tap. Matches the platform ~300ms. */
export const DOUBLE_TAP_MS = 300;
/**
 * Max movement between the two taps. Generous enough for imprecise thumbs, but
 * small enough that a tap-then-tap on a different word isn't treated as one
 * gesture (and a drag/scroll, which moves much further, never qualifies).
 */
export const DOUBLE_TAP_MOVE_PX = 30;

/**
 * Is `curr` the second tap of a double-tap that started at `prev`? True when
 * the two taps are close enough in both time and space. `prev` is null when
 * there is no pending first tap (so the first tap of any pair is never one).
 */
export function isDoubleTap(
  prev: Tap | null,
  curr: Tap,
  maxMs: number = DOUBLE_TAP_MS,
  maxPx: number = DOUBLE_TAP_MOVE_PX,
): boolean {
  if (!prev) {
    return false;
  }
  return (
    curr.time - prev.time <= maxMs &&
    Math.abs(curr.x - prev.x) <= maxPx &&
    Math.abs(curr.y - prev.y) <= maxPx
  );
}

/**
 * The CM6 extension. Tracks touch taps (`pointerup`) and, on a detected
 * double-tap, collapses the selection and blurs the content DOM to dismiss the
 * Android soft keyboard. Non-touch input (mouse/pen) is ignored so desktop
 * double-click word-selection is untouched.
 */
export function createKeyboardDismissGesture(opts: { maxMs?: number; maxPx?: number } = {}) {
  let last: Tap | null = null;

  return EditorView.domEventHandlers({
    pointerup(event, view) {
      if (event.pointerType !== 'touch') {
        return false;
      }
      const tap: Tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      if (isDoubleTap(last, tap, opts.maxMs, opts.maxPx)) {
        last = null;
        // Collapse whatever the native double-tap may have word-selected to a
        // bare caret, then drop focus so the soft keyboard retracts. Ordering:
        // dispatch (does not focus) before blur.
        view.dispatch({ selection: { anchor: view.state.selection.main.head } });
        view.contentDOM.blur();
        return true;
      }
      last = tap;
      return false;
    },
    // A scroll/drag between taps invalidates the pending first tap: the pointer
    // travelled, so the next lift shouldn't pair with it.
    pointercancel() {
      last = null;
      return false;
    },
  });
}
