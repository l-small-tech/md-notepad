/**
 * Scroll activity → `data-scrolling="on"` on the scrolled element, so base.css
 * can show that pane's scrollbar while it moves and fade it out once it goes
 * idle (Windows Terminal style). Idle is `data-scrolling="idle"`, not a removed
 * attribute: base.css hangs the fade-out transition on the attribute's presence.
 *
 * One capturing listener on the document catches every scroll region,
 * including ones mounted later; `scroll` does not bubble, but capture still
 * sees it.
 */

/** The slice of an element this module touches (kept narrow for tests). */
export interface ScrollMarkable {
  setAttribute(name: string, value: string): unknown;
}

export const SCROLL_IDLE_MS = 900;

export function watchScrollActivity(
  root: Pick<Document, 'addEventListener' | 'removeEventListener' | 'scrollingElement'>,
  idleMs: number = SCROLL_IDLE_MS,
): () => void {
  const timers = new Map<ScrollMarkable, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event): void => {
    // A document-level scroll targets the Document itself; its bar belongs to
    // the scrolling element.
    const raw = event.target === (root as unknown) ? root.scrollingElement : event.target;
    if (raw === null || typeof (raw as Partial<ScrollMarkable>).setAttribute !== 'function') {
      return;
    }
    const el = raw as unknown as ScrollMarkable;
    const pending = timers.get(el);
    if (pending === undefined) el.setAttribute('data-scrolling', 'on');
    else clearTimeout(pending);
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el);
        el.setAttribute('data-scrolling', 'idle');
      }, idleMs),
    );
  };

  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    root.removeEventListener('scroll', onScroll, { capture: true });
    for (const [el, t] of timers) {
      clearTimeout(t);
      el.setAttribute('data-scrolling', 'idle');
    }
    timers.clear();
  };
}
