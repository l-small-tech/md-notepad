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
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { cycleReaderView, stepBackReaderView } from './reader-fullscreen';
import { tabsStore, useTabsStore } from './stores/tabs';
import { useUiStore } from './stores/ui';

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const readerView = useUiStore((s) => s.readerView);

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
    <div className={readerView === 'normal' ? 'app' : 'app app-fullscreen'}>
      <TabBar />
      <Ribbon />
      <div className="editor-area">
        <FileExplorer />
        <div className="editor-stack">
          {tabs.map((tab) => (
            <EditorHost key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
          ))}
        </div>
      </div>
      <StatusBar />
      <SettingsDialog />
      {readerView !== 'normal' && (
        // The chrome (with the ribbon's fullscreen button) is hidden, so leave
        // quiet always-there mouse controls in the same top-right spot: one
        // advances to the next stage (hidden once at 'screen' — the cycle's
        // next step is exit, which is the other button's job), one steps back.
        // Esc and F11 remain the keyboard paths.
        <div className="reader-view-controls">
          {readerView === 'window' && (
            <button
              className="reader-view-btn"
              aria-label="Expand to full screen"
              title="Expand to full screen (F11)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cycleReaderView}
            >
              ⛶
            </button>
          )}
          <button
            className="reader-view-btn"
            aria-label={readerView === 'screen' ? 'Back to full window' : 'Exit full window'}
            title={readerView === 'screen' ? 'Back to full window (Esc)' : 'Exit full window (Esc)'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={stepBackReaderView}
          >
            {readerView === 'screen' ? '⇲' : '✕'}
          </button>
        </div>
      )}
    </div>
  );
}
