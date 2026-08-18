/**
 * Smooth wheel scrolling for every DOM surface.
 *
 * One window-level `wheel` listener, installed once at boot (main.tsx), that
 * finds the scroller the event would have moved and animates `scrollTop`
 * toward the new target instead of letting the web view step it. That covers
 * every scrollable tab type and panel at once — source editor, preview and
 * read mode, wysiwyg, whiteboard/image panes, the explorer, dialogs — without
 * each host having to opt in, which is why it lives here rather than in the
 * editors.
 *
 * The terminal is deliberately NOT handled here: `renderer/input.ts` swallows
 * its wheel events (the pane never scrolls like a document) and the canvas
 * eases its own viewport — see `renderer/view.ts`.
 *
 * Rules that keep it out of the way:
 *   - a defaultPrevented event was already handled by someone (the terminal,
 *     a diagram's zoom-pan surface) and is left alone;
 *   - a zoom gesture (ctrl/meta + wheel) is not scrolling;
 *   - a mostly-horizontal wheel is left to the browser;
 *   - a scroller already pinned at the edge in the wheel's direction is left
 *     alone too, so the parent surface scrolls exactly as it natively would.
 */

import { MAX_FRAME_MS, approach, clamp, wheelPixels } from '../core/smooth-scroll';

/** Below this the animation is not worth starting — just jump. */
const MIN_ANIMATED_PX = 2;
/**
 * Where the glide stops chasing its target. `scrollTop` is fractional but
 * paints at device pixels, so a sub-pixel tail is not motion — it is several
 * frames of the surface rounding to the same place, which reads as a stutter
 * at the end of every scroll. Ending a pixel out is invisible; crawling there
 * is not.
 */
const EPSILON_PX = 1.5;
/** deltaMode 1 (line-wise wheels) when the scroller reports no usable line box. */
const FALLBACK_LINE_PX = 16;

export interface SmoothScrollController {
  setEnabled: (enabled: boolean) => void;
  dispose: () => void;
}

/** True for an element that can actually scroll vertically right now. */
function scrollsVertically(element: Element, view: Window): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.scrollHeight - element.clientHeight <= 1) {
    return false;
  }
  const overflowY = view.getComputedStyle(element).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

/** The element the wheel would scroll: the nearest scrollable ancestor. */
function scrollerFor(target: EventTarget | null, view: Window, delta: number): HTMLElement | null {
  let node: Element | null =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  while (node) {
    if (scrollsVertically(node, view)) {
      const element = node as HTMLElement;
      const max = element.scrollHeight - element.clientHeight;
      // Pinned at the edge the wheel pushes toward: this scroller has nothing
      // to give, so the search continues outward exactly as the browser's own
      // scroll chaining would (unless the element opted out of chaining).
      const atEdge = delta < 0 ? element.scrollTop <= 0 : element.scrollTop >= max - 0.5;
      const contained = view.getComputedStyle(element).overscrollBehaviorY !== 'auto';
      if (!atEdge || contained) {
        return element;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Install the animator. Starts disabled; `setEnabled` follows the setting, and
 * turning it off stops any glide in progress on the spot.
 */
export function installSmoothScroll(view: Window = window): SmoothScrollController {
  let enabled = false;
  let element: HTMLElement | null = null;
  let target = 0;
  let position = 0;
  let frame = 0;
  let lastFrameAt = 0;
  /** What we last wrote, so a scroll from anywhere else cancels the glide. */
  let applied = -1;

  function stop(): void {
    if (frame !== 0) {
      view.cancelAnimationFrame(frame);
      frame = 0;
    }
    element = null;
    applied = -1;
  }

  const step = (now: number): void => {
    frame = 0;
    const scroller = element;
    if (!scroller || !scroller.isConnected) {
      stop();
      return;
    }
    // Something else moved this scroller (a scrollIntoView, a search jump, the
    // user dragging the scrollbar). It wins; the glide is abandoned.
    if (applied >= 0 && Math.abs(scroller.scrollTop - applied) > 1) {
      stop();
      return;
    }
    const dt = lastFrameAt === 0 ? MAX_FRAME_MS : now - lastFrameAt;
    lastFrameAt = now;
    position = approach(position, target, dt, EPSILON_PX);
    scroller.scrollTop = position;
    // Read back: hitting the end of the document (or a layout change) clamps
    // the write, and the target has to follow or the rest of the glide is
    // spent animating a distance that no longer exists.
    applied = scroller.scrollTop;
    if (Math.abs(applied - position) > 1) {
      stop();
      return;
    }
    if (position === target) {
      stop();
      return;
    }
    frame = view.requestAnimationFrame(step);
  };

  const onWheel = (event: WheelEvent): void => {
    if (!enabled || event.defaultPrevented || event.ctrlKey || event.metaKey) {
      return;
    }
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    const scroller = scrollerFor(event.target, view, event.deltaY);
    if (!scroller) {
      return;
    }
    const lineHeight = Number.parseFloat(view.getComputedStyle(scroller).lineHeight);
    const delta = wheelPixels(
      event.deltaY,
      event.deltaMode,
      Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : FALLBACK_LINE_PX,
      scroller.clientHeight,
    );
    if (delta === 0) {
      return;
    }
    event.preventDefault();

    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    // A notch on a different scroller (or after the last glide ended) starts
    // from where that scroller actually is; one on the same scroller extends
    // the flight, which is what makes a fast run of notches read as one glide.
    const continuing = scroller === element && frame !== 0;
    if (!continuing) {
      element = scroller;
      position = scroller.scrollTop;
      target = scroller.scrollTop;
      applied = -1;
    }
    target = clamp(target + delta, 0, max);
    if (Math.abs(target - position) < MIN_ANIMATED_PX) {
      scroller.scrollTop = target;
      stop();
      return;
    }
    if (frame === 0) {
      lastFrameAt = 0;
      frame = view.requestAnimationFrame(step);
    }
  };

  // Not passive: the whole point is to preventDefault and drive the scroll.
  // Bubble phase, deliberately: a surface that owns the wheel itself (the
  // terminal pane, a diagram's zoom-pan stage) has already preventDefaulted by
  // the time the event reaches the window, and the check above skips it.
  view.addEventListener('wheel', onWheel, { passive: false });

  return {
    setEnabled(next) {
      enabled = next;
      if (!next) {
        stop();
      }
    },
    dispose() {
      stop();
      view.removeEventListener('wheel', onWheel);
    },
  };
}
