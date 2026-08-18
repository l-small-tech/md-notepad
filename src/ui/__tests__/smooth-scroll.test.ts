// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSmoothScroll, type SmoothScrollController } from '../smooth-scroll';

/**
 * jsdom lays nothing out: `scrollHeight`/`clientHeight` are always 0 and
 * `scrollTop` never moves. A scroller stub supplies the three numbers the
 * animator reads and stores what it writes — which is exactly its contract.
 */
function makeScroller(scrollHeight = 1000, clientHeight = 200): HTMLElement {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  // One notch = NOTCH_LINES × line-height = 60px with this, whatever pixel
  // convention the fake wheel event uses — that is the point of the feature.
  element.style.lineHeight = '20px';
  let top = 0;
  let height = scrollHeight;
  Object.defineProperties(element, {
    scrollHeight: {
      get: () => height,
      set: (value: number) => {
        height = value;
      },
    },
    clientHeight: { value: clientHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(height - clientHeight, Math.max(0, value));
      },
    },
  });
  document.body.append(element);
  return element;
}

/** One notch's travel with makeScroller's 20px line box: NOTCH_LINES × 20. */
const NOTCH_PX = 60;

function wheel(target: EventTarget, deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    deltaY,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** Run the animation to a stop (or until it clearly is not going to). */
function settle(): void {
  for (let i = 0; i < 200; i++) vi.advanceTimersByTime(16);
}

describe('installSmoothScroll', () => {
  let controller: SmoothScrollController;

  beforeEach(() => {
    vi.useFakeTimers();
    controller = installSmoothScroll(window);
    controller.setEnabled(true);
  });

  afterEach(() => {
    controller.dispose();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('animates the scroller toward the wheel target instead of jumping', () => {
    const scroller = makeScroller();
    const event = wheel(scroller, 120);

    expect(event.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(0); // nothing moves before the first frame

    vi.advanceTimersByTime(16);
    const afterOneFrame = scroller.scrollTop;
    expect(afterOneFrame).toBeGreaterThan(0);
    expect(afterOneFrame).toBeLessThan(NOTCH_PX);

    settle();
    expect(scroller.scrollTop).toBe(NOTCH_PX);
  });

  it('scrolls a notch the same distance whatever the platform pixel step', () => {
    // The same wheel notch arrives as ~40px on WebKitGTK, ~53 on Chromium/X11
    // and 120 on WebView2; each must travel NOTCH_LINES lines, not its pixels.
    for (const platformStep of [40, 53, 120]) {
      controller.dispose();
      controller = installSmoothScroll(window);
      controller.setEnabled(true);
      const scroller = makeScroller();
      wheel(scroller, platformStep);
      settle();
      expect(scroller.scrollTop).toBe(NOTCH_PX);
    }
  });

  it('folds a second notch into the flight in progress', () => {
    const scroller = makeScroller();
    wheel(scroller, 120);
    vi.advanceTimersByTime(16);
    wheel(scroller, 120);
    settle();
    expect(scroller.scrollTop).toBe(2 * NOTCH_PX);
  });

  it('clamps the target to the scrollable range', () => {
    const scroller = makeScroller(1000, 200);
    wheel(scroller, 5000);
    settle();
    expect(scroller.scrollTop).toBe(800);
  });

  it('scrolls the nearest scrollable ancestor of the event target', () => {
    const scroller = makeScroller();
    const child = document.createElement('p');
    scroller.append(child);
    wheel(child, 120);
    settle();
    expect(scroller.scrollTop).toBe(NOTCH_PX);
  });

  it('leaves a scroller pinned at the edge to the browser', () => {
    const scroller = makeScroller();
    const event = wheel(scroller, -120);
    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it('ignores zoom gestures, horizontal wheels and handled events', () => {
    const scroller = makeScroller();
    expect(wheel(scroller, 120, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(scroller, 10, { deltaX: 120 }).defaultPrevented).toBe(false);

    scroller.addEventListener('wheel', (event) => event.preventDefault());
    wheel(scroller, 120);
    settle();
    expect(scroller.scrollTop).toBe(0);
  });

  it('scales line-wise wheel deltas by the line height', () => {
    const scroller = makeScroller();
    scroller.style.lineHeight = '20px';
    wheel(scroller, 3, { deltaMode: 1 });
    settle();
    expect(scroller.scrollTop).toBe(60);
  });

  it('does nothing at all while the setting is off', () => {
    const scroller = makeScroller();
    controller.setEnabled(false);
    const event = wheel(scroller, 300);
    settle();
    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it('abandons the glide when something else scrolls the element', () => {
    const scroller = makeScroller();
    wheel(scroller, 400);
    vi.advanceTimersByTime(16);
    scroller.scrollTop = 900; // a search jump, a scrollIntoView, a scrollbar drag
    settle();
    expect(scroller.scrollTop).toBe(800);
  });

  it('holds a compositor hint on the scroller for exactly the glide', () => {
    const scroller = makeScroller();
    wheel(scroller, 300);
    vi.advanceTimersByTime(16);
    expect(scroller.style.willChange).toBe('scroll-position');
    settle();
    expect(scroller.style.willChange).toBe('');
  });

  it('gathers speed across a run of notches instead of restarting the curve', () => {
    const scroller = makeScroller();
    wheel(scroller, 100);
    vi.advanceTimersByTime(48);
    const soloSpeed = scroller.scrollTop;
    settle();

    const second = makeScroller();
    // The same three frames, but with two more notches folded into the flight.
    wheel(second, 100);
    vi.advanceTimersByTime(16);
    wheel(second, 100);
    vi.advanceTimersByTime(16);
    wheel(second, 100);
    vi.advanceTimersByTime(16);
    expect(second.scrollTop).toBeGreaterThan(soloSpeed);
    settle();
    expect(second.scrollTop).toBe(3 * NOTCH_PX);
  });

  it('follows a virtualized re-anchor (scrollHeight change) instead of aborting', () => {
    const scroller = makeScroller(1000, 200);
    wheel(scroller, 120);
    vi.advanceTimersByTime(32);
    const inFlight = scroller.scrollTop;
    expect(inFlight).toBeGreaterThan(0);
    expect(inFlight).toBeLessThan(NOTCH_PX);

    // CM6 measures blocks revealed by the glide: content above the viewport
    // grows and the editor shifts scrollTop to keep the view anchored.
    (scroller as { scrollHeight: number }).scrollHeight = 1500;
    scroller.scrollTop = inFlight + 30;

    settle();
    // The glide kept flying, with spring and target shifted by the re-anchor.
    expect(scroller.scrollTop).toBe(NOTCH_PX + 30);
  });

  it('leaves a touchpad stream (fractional deltas) to the browser, 1:1', () => {
    const scroller = makeScroller();
    const event = wheel(scroller, 8.25);
    expect(event.defaultPrevented).toBe(false);
    settle();
    expect(scroller.scrollTop).toBe(0); // native handling, which jsdom has none of
  });

  it('drops a glide the moment a touchpad stream lands on the surface', () => {
    const scroller = makeScroller();
    wheel(scroller, 400);
    vi.advanceTimersByTime(32);
    const inFlight = scroller.scrollTop;
    expect(inFlight).toBeGreaterThan(0);

    const stream = wheel(scroller, 8.25);
    expect(stream.defaultPrevented).toBe(false);
    expect(scroller.style.willChange).toBe(''); // hint released with the glide
    settle();
    expect(scroller.scrollTop).toBe(inFlight); // the spring stopped writing
  });

  it('stops listening once disposed', () => {
    const scroller = makeScroller();
    controller.dispose();
    const event = wheel(scroller, 300);
    settle();
    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });
});
