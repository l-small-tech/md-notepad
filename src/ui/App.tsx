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
import { tabsStore, useTabsStore } from './stores/tabs';

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);

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
    <div className="app">
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
    </div>
  );
}
