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
  let top = 0;
  Object.defineProperties(element, {
    scrollHeight: { value: scrollHeight },
    clientHeight: { value: clientHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.min(scrollHeight - clientHeight, Math.max(0, value));
      },
    },
  });
  document.body.append(element);
  return element;
}

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
    const event = wheel(scroller, 300);

    expect(event.defaultPrevented).toBe(true);
    expect(scroller.scrollTop).toBe(0); // nothing moves before the first frame

    vi.advanceTimersByTime(16);
    const afterOneFrame = scroller.scrollTop;
    expect(afterOneFrame).toBeGreaterThan(0);
    expect(afterOneFrame).toBeLessThan(300);

    settle();
    expect(scroller.scrollTop).toBe(300);
  });

  it('folds a second notch into the flight in progress', () => {
    const scroller = makeScroller();
    wheel(scroller, 200);
    vi.advanceTimersByTime(16);
    wheel(scroller, 200);
    settle();
    expect(scroller.scrollTop).toBe(400);
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
    expect(scroller.scrollTop).toBe(120);
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

  it('stops listening once disposed', () => {
    const scroller = makeScroller();
    controller.dispose();
    const event = wheel(scroller, 300);
    settle();
    expect(event.defaultPrevented).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });
});
