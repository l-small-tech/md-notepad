/**
 * The full-screen tap-and-hold menu.
 *
 * Full screen hides every piece of chrome, so on a touch device there is no
 * button left to press. A long press anywhere in the view summons this small
 * menu instead: exit full screen, open the workspaces panel, open the outline
 * (plus Back while a followed preview link is open). Deliberately short — it
 * is an escape hatch, not a second ribbon.
 *
 * Two things make it work where the older double-tap-the-edge gesture did not:
 *
 *  - The listeners are installed on `window` in the CAPTURE phase, so they run
 *    before any editor's own handlers and cannot be swallowed by an element
 *    that claims the pointer. The whiteboard captures every pointer on its
 *    stage and `preventDefault()`s it, which is exactly why draw mode had no
 *    way out of full screen.
 *  - It is a press, not a tap rhythm — nothing to time, and it works the same
 *    over an editor, a preview or a board.
 *
 * Touch and pen only. A mouse gets the hover-revealed cluster (App.tsx) plus
 * F11/Escape, and a 550 ms mouse hold is how you drag-select text — turning
 * that into a menu would fight the editor on every desktop selection.
 *
 * On a board a long press IS a stroke, so opening the menu aborts the gesture
 * in flight (`WhiteboardAdapter.abortGesture`) and the board is left exactly as
 * the last commit had it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { uiStore, useUiStore, type MenuPoint } from '../stores/ui';
import { useTabsStore, tabsStore } from '../stores/tabs';
import { getWhiteboardAdapter } from '../stores/whiteboard';
import { goBackPreview, usePreviewNav } from '../stores/preview-nav';
import { setFullscreen } from '../fullscreen';

/** How long the press has to be held before the menu opens. */
const HOLD_MS = 550;
/** How far the contact may wander and still count as a press, not a drag. */
const SLOP_PX = 12;
/** Keep the menu this far from the viewport edges. */
const EDGE_MARGIN = 8;

/**
 * Install the long-press watcher for as long as the view is full screen.
 * Exported as a hook so App owns exactly one call site and the listeners are
 * torn down the moment full screen ends.
 */
export function useFullscreenLongPress(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let origin: MenuPoint | null = null;
    let pointerId = -1;

    const cancel = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      origin = null;
      pointerId = -1;
    };

    const onDown = (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
      }
      // A press that starts on the menu (or on the desktop exit cluster) is
      // aimed at a button, not at summoning anything.
      const target = event.target;
      if (target instanceof Element && target.closest('.fullscreen-menu, .fullscreen-topcenter')) {
        return;
      }
      origin = { x: event.clientX, y: event.clientY };
      pointerId = event.pointerId;
      timer = setTimeout(() => {
        const at = origin;
        cancel();
        if (!at) {
          return;
        }
        // The board has been drawing under the finger for the whole hold.
        const tabId = tabsStore.getState().activeTabId;
        if (tabId) {
          getWhiteboardAdapter(tabId)?.abortGesture();
        }
        uiStore.getState().openFullscreenMenu(at);
      }, HOLD_MS);
    };

    const onMove = (event: PointerEvent) => {
      if (!origin || event.pointerId !== pointerId) {
        return;
      }
      if (
        Math.abs(event.clientX - origin.x) > SLOP_PX ||
        Math.abs(event.clientY - origin.y) > SLOP_PX
      ) {
        cancel();
      }
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        cancel();
      }
    };

    const options = { capture: true } as const;
    window.addEventListener('pointerdown', onDown, options);
    window.addEventListener('pointermove', onMove, options);
    window.addEventListener('pointerup', onUp, options);
    window.addEventListener('pointercancel', onUp, options);
    return () => {
      window.removeEventListener('pointerdown', onDown, options);
      window.removeEventListener('pointermove', onMove, options);
      window.removeEventListener('pointerup', onUp, options);
      window.removeEventListener('pointercancel', onUp, options);
      cancel();
    };
  }, [active]);
}

export function FullscreenMenu() {
  const at = useUiStore((s) => s.fullscreenMenu);
  if (!at) {
    return null;
  }
  return <FullscreenMenuBody at={at} />;
}

function FullscreenMenuBody({ at }: { at: MenuPoint }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<MenuPoint | null>(null);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode);
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );

  // Clamp inside the viewport before the first paint, so a press near an edge
  // never shows the menu hanging off it.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPlaced({
      x: Math.max(EDGE_MARGIN, Math.min(at.x, window.innerWidth - box.width - EDGE_MARGIN)),
      y: Math.max(EDGE_MARGIN, Math.min(at.y, window.innerHeight - box.height - EDGE_MARGIN)),
    });
  }, [at.x, at.y]);

  // A press anywhere else dismisses. Capture phase for the same reason the
  // opening gesture uses it: an editor must not be able to eat the dismiss.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.fullscreen-menu')) {
        return;
      }
      uiStore.getState().closeFullscreenMenu();
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, []);

  const close = () => uiStore.getState().closeFullscreenMenu();

  return (
    <div
      ref={ref}
      className="tab-menu fullscreen-menu"
      role="menu"
      aria-label="Full screen menu"
      style={{
        left: (placed ?? at).x,
        top: (placed ?? at).y,
        // Invisible for the one frame it takes to measure and clamp.
        visibility: placed ? undefined : 'hidden',
      }}
    >
      {canGoBack && (
        <MenuItem
          label="Back"
          onSelect={() => {
            close();
            if (activeTabId) {
              goBackPreview(activeTabId);
            }
          }}
        />
      )}
      <MenuItem
        label="Exit full screen"
        onSelect={() => {
          close();
          setFullscreen('normal');
        }}
      />
      <MenuItem
        label="Workspaces"
        onSelect={() => {
          close();
          uiStore.getState().openExplorer();
        }}
      />
      {/* A whiteboard has no headings — the same reason the ribbon hides its
          outline toggle in draw mode. */}
      {mode !== 'draw' && (
        <MenuItem
          label="Outline"
          onSelect={() => {
            close();
            uiStore.getState().openOutline();
          }}
        />
      )}
    </div>
  );
}

function MenuItem({ label, onSelect }: { label: ReactNode; onSelect: () => void }) {
  return (
    <button
      className="tab-menu-item fullscreen-menu-item"
      role="menuitem"
      type="button"
      onClick={onSelect}
    >
      {label}
    </button>
  );
}
