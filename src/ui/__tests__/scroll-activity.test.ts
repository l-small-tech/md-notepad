import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchScrollActivity } from '../scroll-activity';

class FakeEl {
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
}

function fakeRoot() {
  let handler: ((e: Event) => void) | null = null;
  const scrollingElement = new FakeEl();
  const root = {
    scrollingElement,
    addEventListener: (_: string, h: (e: Event) => void) => {
      handler = h;
    },
    removeEventListener: () => {
      handler = null;
    },
  };
  const fire = (target: unknown) => handler?.({ target } as unknown as Event);
  return { root: root as unknown as Document, scrollingElement, fire, attached: () => !!handler };
}

describe('watchScrollActivity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks the scrolled element and clears it after the idle delay', () => {
    const { root, fire } = fakeRoot();
    const el = new FakeEl();
    watchScrollActivity(root, 100);
    fire(el);
    expect(el.attrs.get('data-scrolling')).toBe('on');
    vi.advanceTimersByTime(99);
    expect(el.attrs.get('data-scrolling')).toBe('on');
    vi.advanceTimersByTime(1);
    expect(el.attrs.get('data-scrolling')).toBe('idle');
  });

  it('keeps the mark while scrolling continues', () => {
    const { root, fire } = fakeRoot();
    const el = new FakeEl();
    watchScrollActivity(root, 100);
    fire(el);
    vi.advanceTimersByTime(80);
    fire(el);
    vi.advanceTimersByTime(80);
    expect(el.attrs.get('data-scrolling')).toBe('on');
    vi.advanceTimersByTime(20);
    expect(el.attrs.get('data-scrolling')).toBe('idle');
  });

  it('maps a document scroll to the scrolling element', () => {
    const { root, scrollingElement, fire } = fakeRoot();
    watchScrollActivity(root, 100);
    fire(root);
    expect(scrollingElement.attrs.get('data-scrolling')).toBe('on');
  });

  it('ignores targets that are not elements', () => {
    const { root, fire } = fakeRoot();
    watchScrollActivity(root, 100);
    expect(() => fire({})).not.toThrow();
  });

  it('dispose detaches and clears pending marks', () => {
    const { root, fire, attached } = fakeRoot();
    const el = new FakeEl();
    const dispose = watchScrollActivity(root, 100);
    fire(el);
    dispose();
    expect(attached()).toBe(false);
    expect(el.attrs.get('data-scrolling')).toBe('idle');
  });
});
