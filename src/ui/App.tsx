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
      {fullscreenView !== 'normal' && (
        // The chrome (with the ribbon's fullscreen button) is hidden, so leave
        // quiet always-there mouse controls in the same top-right spot. Each
        // glyph has one fixed meaning wherever it appears: ⤢ = full window,
        // ⛶ = full screen, ✕ = exit. We only show the toggle for the stage
        // you're NOT in, plus exit. F11/Esc remain the keyboard paths.
        <div className="fullscreen-controls">
          {fullscreenView === 'screen' ? (
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
            title="Exit full screen"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFullscreen('normal')}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
