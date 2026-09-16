import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureScrollAnchor,
  clearScrollAnchor,
  peekScrollAnchor,
  registerScrollAnchor,
  scrollSurfaceToLine,
  takeScrollAnchor,
  unregisterScrollAnchor,
  type ScrollAnchorPort,
} from '../mode-scroll';

function port(topLine: number | null) {
  const scrollToLine = vi.fn<(line: number) => void>();
  const value: ScrollAnchorPort = { getTopLine: () => topLine, scrollToLine };
  return { ...value, scrollToLine };
}

describe('mode-scroll registry', () => {
  beforeEach(() => {
    for (const surface of ['source', 'rendered', 'rich'] as const) {
      unregisterScrollAnchor('t1', surface);
    }
    clearScrollAnchor('t1');
  });

  it('carries the outgoing surface’s line to the incoming one', () => {
    registerScrollAnchor('t1', 'rendered', port(42));
    const source = port(1);
    registerScrollAnchor('t1', 'source', source);

    captureScrollAnchor('t1', 'read'); // leaving Review…
    expect(takeScrollAnchor('t1')).toBe(42); // …arriving in Raw
    expect(takeScrollAnchor('t1')).toBeNull(); // spent
  });

  it('peeking leaves the anchor for the surface that owns it', () => {
    registerScrollAnchor('t1', 'source', port(7));
    captureScrollAnchor('t1', 'raw');
    expect(peekScrollAnchor('t1')).toBe(7);
    expect(takeScrollAnchor('t1')).toBe(7);
  });

  it('keeps the previous anchor when the surface cannot measure itself', () => {
    registerScrollAnchor('t1', 'source', port(7));
    captureScrollAnchor('t1', 'raw');
    // A hidden or not-yet-rendered surface reports null — better to restore a
    // slightly stale line than to reset the reader to the top.
    registerScrollAnchor('t1', 'rendered', port(null));
    captureScrollAnchor('t1', 'read');
    expect(peekScrollAnchor('t1')).toBe(7);
  });

  it('captures nothing for a mode with no source lines', () => {
    registerScrollAnchor('t1', 'source', port(7));
    captureScrollAnchor('t1', 'draw');
    captureScrollAnchor('t1', 'term');
    expect(peekScrollAnchor('t1')).toBeNull();
  });

  it('keeps anchors and ports per tab', () => {
    registerScrollAnchor('t1', 'source', port(3));
    registerScrollAnchor('t2', 'source', port(90));
    captureScrollAnchor('t1', 'raw');
    captureScrollAnchor('t2', 'raw');
    expect(takeScrollAnchor('t1')).toBe(3);
    expect(takeScrollAnchor('t2')).toBe(90);
    unregisterScrollAnchor('t2', 'source');
    clearScrollAnchor('t2');
  });

  it('scrolls only the surface asked for, and no-ops once it is gone', () => {
    const source = port(1);
    const rendered = port(1);
    registerScrollAnchor('t1', 'source', source);
    registerScrollAnchor('t1', 'rendered', rendered);

    scrollSurfaceToLine('t1', 'rendered', 12);
    expect(rendered.scrollToLine).toHaveBeenCalledWith(12);
    expect(source.scrollToLine).not.toHaveBeenCalled();

    unregisterScrollAnchor('t1', 'rendered');
    expect(() => scrollSurfaceToLine('t1', 'rendered', 15)).not.toThrow();
    expect(rendered.scrollToLine).toHaveBeenCalledTimes(1);
  });
});
