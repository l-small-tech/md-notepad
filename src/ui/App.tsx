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
    </div>
  );
}

/**
 * The chrome (with the ribbon's fullscreen button) is hidden in full screen, so
 * these floating controls are the always-there way back. Each glyph has one
 * fixed meaning: ⤢ = full window, ⛶ = full screen, ✕ = exit; only the toggle
 * for the stage you're NOT in shows, plus exit. F11/Esc remain the keyboard paths.
 *
 * Desktop: the controls ride a full-width bar that stays tucked above the top
 * edge and slides down (Chrome-style) when the mouse reaches the top — a thin
 * trigger strip catches that hover. In the 'window' stage (OS window unchanged,
 * no titlebar) the bar is a `data-tauri-drag-region`, so grabbing it drags the
 * window; in 'screen' stage the window is already OS-fullscreen, so no drag.
 *
 * Android: hover and window dragging don't apply, so keep the quiet, always-on
 * top-right controls instead.
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

  // The thin trigger strip is a sibling BEFORE the bar so `:hover` on it reveals
  // the bar via the adjacent-sibling selector; hovering the bar itself keeps it
  // open. Only the 'window' stage is draggable (see doc comment).
  return (
    <>
      <div className="fullscreen-trigger" />
      <div
        className={`fullscreen-topbar${stage === 'window' ? ' fullscreen-topbar-drag' : ''}`}
        {...(stage === 'window' ? { 'data-tauri-drag-region': '' } : {})}
      >
        {buttons}
      </div>
    </>
  );
}
