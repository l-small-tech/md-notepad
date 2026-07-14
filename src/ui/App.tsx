/**
 * App — the layout shell: TabBar / editor stack / StatusBar.
 *
 * All EditorHosts stay mounted (I7); only the active one is visible. When the
 * active tab changes, App focuses that tab's editor once its ModeSync has
 * finished its initial/last attach (whenIdle), so launch lands the caret in
 * the editor and tab switches keep focus in the right place.
 */

import { useEffect } from 'react';
import { TabBar } from './components/TabBar';
import { Ribbon } from './components/Ribbon';
import { FileExplorer } from './components/FileExplorer';
import { EditorHost } from './components/EditorHost';
import { ImageView } from './components/ImageView';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { setFullscreen } from './fullscreen';
import { tabsStore, useTabsStore } from './stores/tabs';
import { useUiStore } from './stores/ui';
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
 * these floating controls are the always-there way back. F11 cycles stages and
 * Esc steps back; the mouse gets a small cluster: the stage toggle for the stage
 * you're NOT in (⛶ = full screen from 'window', ⤢ = full window from 'screen')
 * plus an exit ✕.
 *
 * Desktop: the cluster is tucked just above the top-CENTER edge and slides down
 * when the mouse moves into that area — a generous top-center trigger strip
 * catches the hover. Nothing spans the full width (that full-width reveal bar
 * read as cheap/janky). Window dragging in the 'window' stage lives in a
 * separate strip over the top of the view (see App), not here.
 *
 * Android: hover doesn't apply, so keep the quiet, always-on top-right controls.
 */
function FullscreenControls({ stage }: { stage: 'window' | 'screen' }) {
  const buttons = (
    <>
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

  if (isAndroid()) {
    return <div className="fullscreen-controls">{buttons}</div>;
  }

  // The trigger strip is a sibling BEFORE the cluster so `:hover` on it reveals
  // the cluster via the adjacent-sibling selector; hovering the cluster itself
  // keeps it open.
  return (
    <>
      <div className="fullscreen-exit-trigger" />
      <div className="fullscreen-topcenter">{buttons}</div>
    </>
  );
}
