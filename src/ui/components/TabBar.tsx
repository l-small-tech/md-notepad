/**
 * TabBar — the row of tabs plus the new-tab button.
 *
 * Interactions (src/ui/README): click activates; middle-click closes; the ×
 * button closes; double-click, F2, or the right-click / long-press context
 * menu starts an inline rename; native HTML5 drag reorders (no dnd
 * dependency). The displayed label mirrors the tab's file name minus its
 * extension (see `tabDisplayTitle`); committing a rename renames that file on
 * disk (see session.renameTab). All behavior dispatches store/session
 * actions; the component itself stays declarative.
 */

import { useEffect, useRef, useState } from 'react';
import { closeTab, renameTab } from '../session';
import { tabsStore, tabDisplayTitle, useTabsStore, type TabEntry } from '../stores/tabs';

/** Where a context menu is open, and for which tab. */
interface TabMenu {
  tabId: string;
  x: number;
  y: number;
}

function RenameInput({ tab }: { tab: TabEntry }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const initial = tabDisplayTitle(tab);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  function commit() {
    // Renaming the tab renames its underlying file so name and file stay
    // matched (session.renameTab branches on note vs file tab).
    renameTab(tab.id, inputRef.current?.value ?? '');
    tabsStore.getState().cancelRename();
  }

  return (
    <input
      ref={inputRef}
      className="tab-rename-input"
      defaultValue={initial}
      aria-label="Rename tab"
      onBlur={commit}
      onKeyDown={(e) => {
        // Keep these off the global shortcut listener.
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          tabsStore.getState().cancelRename();
        }
      }}
    />
  );
}

function Tab({
  tab,
  active,
  onMenu,
}: {
  tab: TabEntry;
  active: boolean;
  onMenu: (tabId: string, x: number, y: number) => void;
}) {
  const renaming = useTabsStore((s) => s.renamingTabId === tab.id);
  const store = tabsStore.getState;
  const label = tabDisplayTitle(tab);
  // Long-press (touch) opens the same menu right-click does on the desktop.
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelLongPress() {
    if (longPress.current !== null) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }

  return (
    <div
      className={`tab${active ? ' tab-active' : ''}`}
      role="tab"
      aria-selected={active}
      title={tab.filePath ?? label}
      draggable={!renaming}
      onPointerDown={(e) => {
        // Left-click activates immediately (pointerdown feels snappier than
        // click); ignore clicks that originate on the close button.
        if (e.button === 0 && !(e.target as HTMLElement).closest('.tab-close')) {
          store().activateTab(tab.id);
        }
        if (e.pointerType === 'touch') {
          const { clientX, clientY } = e;
          cancelLongPress();
          longPress.current = setTimeout(() => onMenu(tab.id, clientX, clientY), 500);
        }
      }}
      onPointerUp={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(tab.id, e.clientX, e.clientY);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      }}
      onDoubleClick={() => store().beginRename(tab.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/tab-id', tab.id);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/tab-id')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(e) => {
        const draggedId = e.dataTransfer.getData('text/tab-id');
        if (!draggedId || draggedId === tab.id) {
          return;
        }
        e.preventDefault();
        const tabs = tabsStore.getState().tabs;
        const targetIndex = tabs.findIndex((t) => t.id === tab.id);
        // Drop on the right half of a tab inserts after it.
        const rect = e.currentTarget.getBoundingClientRect();
        const after = e.clientX - rect.left > rect.width / 2 ? 1 : 0;
        tabsStore.getState().reorderTab(draggedId, targetIndex + after);
      }}
    >
      {renaming ? (
        <RenameInput tab={tab} />
      ) : (
        <span className="tab-title">
          {label}
          {tab.kind === 'file' && tab.dirty && (
            <span className="tab-dirty-dot" aria-label="Unsaved changes">
              {' '}
              •
            </span>
          )}
        </span>
      )}
      <button
        className="tab-close"
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

function TabContextMenu({ menu, onClose }: { menu: TabMenu; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    // Any outside interaction, Escape, or scroll dismisses the menu.
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      className="tab-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      // Don't let the menu's own pointerdown reach the window dismiss handler.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          tabsStore.getState().beginRename(menu.tabId);
          onClose();
        }}
      >
        Rename
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          closeTab(menu.tabId);
          onClose();
        }}
      >
        Close
      </button>
    </div>
  );
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);

  // Keep the active tab in view when switching with the keyboard.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector<HTMLElement>('.tab-active');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  return (
    <div className="tabbar" role="tablist">
      <div className="tabbar-scroller" ref={scrollerRef}>
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onMenu={(tabId, x, y) => setMenu({ tabId, x, y })}
          />
        ))}
      </div>
      <button
        className="tab-new"
        aria-label="New tab"
        title="New tab (Ctrl/Cmd+N)"
        onClick={() => tabsStore.getState().newTab()}
      >
        +
      </button>
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
