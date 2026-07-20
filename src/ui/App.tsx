/**
 * App — the layout shell: TabBar / editor stack / StatusBar.
 *
 * All EditorHosts stay mounted (I7); only the active one is visible. When the
 * active tab changes, App focuses that tab's editor once its ModeSync has
 * finished its initial/last attach (whenIdle), so launch lands the caret in
 * the editor and tab switches keep focus in the right place.
 */

import { useEffect, useRef, useState } from 'react';
import { TabBar } from './components/TabBar';
import { Ribbon } from './components/Ribbon';
import { FileExplorer } from './components/FileExplorer';
import { EditorHost } from './components/EditorHost';
import { ImageView } from './components/ImageView';
import { ImportView } from './components/ImportView';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { VoiceComments } from './components/VoiceComments';
import { setFullscreen } from './fullscreen';
import { tabsStore, useTabsStore } from './stores/tabs';
import { useUiStore, type WorkSplit } from './stores/ui';
import { goBackPreview, usePreviewNav } from './stores/preview-nav';
import { isAndroid } from './platform';

/**
 * Work-split divider position, shared by both orientations (module scope, not
 * React state — dragging fires on every pointermove and must never re-render;
 * same pattern as EditorHost's splitRatio). Session-only.
 */
let workSplitRatio = 0.5;
const MIN_WORK_SPLIT = 0.15;
const MAX_WORK_SPLIT = 0.85;

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeMode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode);
  const fullscreenView = useUiStore((s) => s.fullscreenView);
  const workSplit = useUiStore((s) => s.workSplit);
  const stackRef = useRef<HTMLDivElement>(null);
  // The ui-store subscription guarantees the pinned tab is never the active
  // one; the guard here just makes render self-sufficient mid-transition.
  const split = workSplit !== null && workSplit.tabId !== activeTabId ? workSplit : null;

  function paneFor(tabId: string): 'primary' | 'secondary' | null {
    if (tabId === activeTabId) {
      return 'primary';
    }
    return split !== null && tabId === split.tabId ? 'secondary' : null;
  }

  function startWorkSplitDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const stack = stackRef.current;
    if (!stack || split === null) {
      return;
    }
    const vertical = split.orientation === 'down';
    function onMove(moveEvent: PointerEvent): void {
      const rect = stack!.getBoundingClientRect();
      const ratio = vertical
        ? (moveEvent.clientY - rect.top) / rect.height
        : (moveEvent.clientX - rect.left) / rect.width;
      workSplitRatio = Math.min(MAX_WORK_SPLIT, Math.max(MIN_WORK_SPLIT, ratio));
      stack!.style.setProperty('--work-split', `${workSplitRatio * 100}%`);
    }
    function onEnd(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }

  useEffect(() => {
    const sync = tabsStore.getState().tabs.find((t) => t.id === activeTabId)?.modeSync;
    if (!sync) {
      return;
    }
    let cancelled = false;
    void sync.whenIdle().then(() => {
      if (!cancelled && tabsStore.getState().activeTabId === activeTabId) {
        sync.focus();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeTabId]);

  return (
    <div className={fullscreenView === 'normal' ? 'app' : 'app app-fullscreen'}>
      <TabBar />
      <Ribbon />
      <div className="editor-area">
        <FileExplorer />
        <div
          ref={stackRef}
          className="editor-stack"
          data-split={split?.orientation}
          style={
            split !== null
              ? ({ '--work-split': `${workSplitRatio * 100}%` } as React.CSSProperties)
              : undefined
          }
        >
          {tabs.map((tab) =>
            // A tab's kind never changes to/from 'image' or 'import', so each
            // branch is stable per key and never remounts an editor (I7 holds).
            tab.kind === 'image' ? (
              <ImageView key={tab.id} tabId={tab.id} pane={paneFor(tab.id)} />
            ) : tab.kind === 'import' ? (
              <ImportView key={tab.id} tabId={tab.id} pane={paneFor(tab.id)} />
            ) : (
              <EditorHost key={tab.id} tabId={tab.id} pane={paneFor(tab.id)} />
            ),
          )}
          {split !== null && (
            <WorkSplitDivider orientation={split.orientation} onPointerDown={startWorkSplitDrag} />
          )}
        </div>
      </div>
      <StatusBar />
      <SettingsDialog />
      <VoiceComments />
      {fullscreenView !== 'normal' && <FullscreenControls stage={fullscreenView} />}
      {/* The 'window' stage hides all chrome and leaves the OS window in place, so
          there's no titlebar to grab. A strip over the top of the view doubles as
          the grab-to-move handle in every mode. It fires only on itself, so content
          below stays interactive. In Read mode it's tall (~3 lines of top
          whitespace); in edit modes it's titlebar-height so it doesn't swallow the
          first editor lines. Android has no draggable OS window (and the strip would
          sit in the double-tap reveal zone), so it's desktop-only. */}
      {fullscreenView === 'window' && !isAndroid() && (
        <div
          className={`fullscreen-drag-strip${activeMode === 'read' ? ' fullscreen-drag-strip-read' : ''}`}
          data-tauri-drag-region=""
        />
      )}
    </div>
  );
}

/** The draggable boundary between the two work-area panes (see WorkSplit). */
function WorkSplitDivider({
  orientation,
  onPointerDown,
}: {
  orientation: WorkSplit['orientation'];
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="work-split-divider"
      onPointerDown={onPointerDown}
      role="separator"
      // aria-orientation describes the divider line itself: a 'right' split
      // draws a vertical line, a 'down' split a horizontal one.
      aria-orientation={orientation === 'right' ? 'vertical' : 'horizontal'}
    />
  );
}

/**
 * The chrome (with the ribbon's fullscreen button) is hidden in full screen, so
 * this floating cluster is the way back. F11 cycles stages and Esc steps back;
 * the cluster holds the stage toggle for the stage you're NOT in (⛶ = full
 * screen from 'window', ⤢ = full window from 'screen') — desktop-only, since
 * Android has a single stage — an exit ✕, and — when browsing a followed link
 * in the preview — a ← Back that pops the page. Back lives here (not as an
 * in-pane bar) in full screen so it hides with the rest.
 *
 * The cluster is tucked just above the top-CENTER edge and slides down when
 * summoned. Nothing spans the full width (that full-width reveal bar read as
 * cheap/janky). Window dragging in the 'window' stage lives in a separate strip
 * over the top of the view (see App), not here.
 *
 * Reveal is JS-driven (not `:hover`) so the behaviour matches the input:
 *  - Desktop: appears while the pointer is in the top reveal zone; once it drops
 *    below, it lingers briefly then hides. Overshooting the top edge fires no
 *    further movement, so the cluster stays put and stays clickable there.
 *  - Android: a DOUBLE-TAP near the top toggles it (a top-edge swipe would fight
 *    the system notification shade); when shown it auto-hides after a few
 *    seconds. In normal (non-full-screen) mode the ribbon is visible, so this
 *    only matters in full screen.
 * `:focus-within` (CSS) also holds it open so it's reachable by keyboard.
 */
function FullscreenControls({ stage }: { stage: 'window' | 'screen' }) {
  const android = isAndroid();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const HIDE_MS = android ? 3500 : 600; // linger before auto-hiding
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    // Local mirror of the reveal state — lets the desktop listener gate on
    // "currently shown" without a render-time ref read (setRevealed is the only
    // writer, and the effect is keyed on `android`, so this stays in sync).
    let shown = false;
    const clearHide = () => {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };
    const show = () => {
      clearHide();
      shown = true;
      setRevealed(true);
    };
    const hide = () => {
      clearHide();
      shown = false;
      setRevealed(false);
    };
    const scheduleHide = () => {
      clearHide();
      hideTimer = setTimeout(hide, HIDE_MS);
    };

    if (android) {
      // Double-tap near the top toggles the cluster. Two taps in the top band
      // within the double-tap window flip it; showing arms an auto-hide. A
      // top-edge swipe is deliberately NOT used — it collides with Android's
      // notification shade and obscures these very buttons.
      const TOP_ZONE = 140; // px band at the top where the double-tap counts
      const DOUBLE_MS = 300; // max gap between the two taps
      let lastTap = 0;
      const onTap = (e: TouchEvent) => {
        const t = e.changedTouches[0];
        if (!t || t.clientY > TOP_ZONE) {
          lastTap = 0; // a tap outside the zone breaks any pending double-tap
          return;
        }
        if (e.timeStamp - lastTap < DOUBLE_MS) {
          lastTap = 0;
          if (shown) {
            hide();
          } else {
            show();
            scheduleHide();
          }
        } else {
          lastTap = e.timeStamp;
        }
      };
      window.addEventListener('touchend', onTap, { passive: true });
      return () => {
        window.removeEventListener('touchend', onTap);
        clearHide();
      };
    }

    // Desktop: reveal near the top; once the pointer drops below the zone, a
    // single linger timer hides it (continued movement below doesn't reset it,
    // so it hides promptly instead of clinging while the mouse wanders).
    const REVEAL_Y = 72;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= REVEAL_Y) {
        show();
      } else if (shown && hideTimer === undefined) {
        scheduleHide();
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearHide();
    };
  }, [android]);

  const buttons = (
    <>
      {canGoBack && (
        <button
          className="fullscreen-btn"
          aria-label="Back"
          title="Back"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (activeTabId) {
              goBackPreview(activeTabId);
            }
          }}
        >
          ←
        </button>
      )}
      {/* The stage toggle (full window ⇄ full screen) is desktop-only. On Android
          the OS window already fills the screen, so there is a single
          distraction-free stage ('window') and no second stage to switch to. */}
      {!android &&
        (stage === 'screen' ? (
          <button
            className="fullscreen-btn"
            aria-label="Full window"
            title="Full window (Esc)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFullscreen('window')}
          >
            ⤢
          </button>
        ) : (
          <button
            className="fullscreen-btn"
            aria-label="Full screen"
            title="Full screen (F11)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFullscreen('screen')}
          >
            ⛶
          </button>
        ))}
      <button
        className="fullscreen-btn"
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setFullscreen('normal')}
      >
        ✕
      </button>
    </>
  );

  return <div className={`fullscreen-topcenter${revealed ? ' is-revealed' : ''}`}>{buttons}</div>;
}
