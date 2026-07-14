/**
 * App — the layout shell: TabBar / editor stack / StatusBar.
 *
 * All EditorHosts stay mounted (I7); only the active one is visible. When the
 * active tab changes, App focuses that tab's editor once its ModeSync has
 * finished its initial/last attach (whenIdle), so launch lands the caret in
 * the editor and tab switches keep focus in the right place.
 */

import { useEffect, useState } from 'react';
import { TabBar } from './components/TabBar';
import { Ribbon } from './components/Ribbon';
import { FileExplorer } from './components/FileExplorer';
import { EditorHost } from './components/EditorHost';
import { ImageView } from './components/ImageView';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { VoiceComments } from './components/VoiceComments';
import { setFullscreen } from './fullscreen';
import { tabsStore, useTabsStore } from './stores/tabs';
import { useUiStore } from './stores/ui';
import { goBackPreview, usePreviewNav } from './stores/preview-nav';
import { isAndroid } from './platform';

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeMode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode);
  const fullscreenView = useUiStore((s) => s.fullscreenView);

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
        <div className="editor-stack">
          {tabs.map((tab) =>
            // A tab's kind never changes to/from 'image', so this branch is
            // stable per key and never remounts an editor (I7 holds).
            tab.kind === 'image' ? (
              <ImageView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : (
              <EditorHost key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ),
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
          first editor lines. */}
      {fullscreenView === 'window' && (
        <div
          className={`fullscreen-drag-strip${activeMode === 'read' ? ' fullscreen-drag-strip-read' : ''}`}
          data-tauri-drag-region=""
        />
      )}
    </div>
  );
}

/**
 * The chrome (with the ribbon's fullscreen button) is hidden in full screen, so
 * this floating cluster is the way back. F11 cycles stages and Esc steps back;
 * the cluster holds the stage toggle for the stage you're NOT in (⛶ = full
 * screen from 'window', ⤢ = full window from 'screen'), an exit ✕, and — when
 * browsing a followed link in the preview — a ← Back that pops the page. Back
 * lives here (not as an in-pane bar) in full screen so it hides with the rest.
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
 *  - Android: a pull-down from the top edge summons it (hover/edge-peek don't
 *    apply on touch); it auto-hides after a few seconds.
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
    const scheduleHide = () => {
      clearHide();
      hideTimer = setTimeout(() => {
        hideTimer = undefined;
        shown = false;
        setRevealed(false);
      }, HIDE_MS);
    };

    if (android) {
      // Pull-down: a touch that starts at the very top edge and drags down far
      // enough reveals the cluster, which then auto-hides.
      const EDGE_Y = 48; // the drag must start within this band of the top
      const PULL = 56; // …and travel down at least this far
      let startY: number | null = null;
      const onStart = (e: TouchEvent) => {
        const t = e.touches[0];
        startY = t && t.clientY <= EDGE_Y ? t.clientY : null;
      };
      const onMove = (e: TouchEvent) => {
        const t = e.touches[0];
        if (startY !== null && t && t.clientY - startY > PULL) {
          startY = null;
          show();
          scheduleHide();
        }
      };
      const onEnd = () => {
        startY = null;
      };
      window.addEventListener('touchstart', onStart, { passive: true });
      window.addEventListener('touchmove', onMove, { passive: true });
      window.addEventListener('touchend', onEnd, { passive: true });
      return () => {
        window.removeEventListener('touchstart', onStart);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
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
      {stage === 'screen' ? (
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
      )}
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
