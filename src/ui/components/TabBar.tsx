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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeAllTabs, closeTab, renameTab } from '../session';
import { detectPlatform } from '../keymap';
import { computeTabWindow } from '../tab-overflow';
import { tabsStore, tabDisplayTitle, useTabsStore, type TabEntry } from '../stores/tabs';
import { WindowControls } from './WindowControls';

/**
 * The TabBar doubles as the window titlebar (no native decorations, so tabs
 * sit level with the window buttons). On macOS the native traffic lights
 * overlay the top-left (titleBarStyle Overlay) — inset the tabs past them and
 * render no custom controls; on Windows/Linux render our own on the right.
 */
const IS_MAC = detectPlatform(navigator.platform) === 'mac';

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
      className={`tab${active ? ' tab-active' : ''}${tab.preview ? ' tab-preview' : ''}`}
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
  // Transient menu — a one-shot store read is fine (it closes on any change).
  const isPreview = tabsStore.getState().tabs.find((t) => t.id === menu.tabId)?.preview ?? false;
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
      {isPreview && (
        <button
          className="tab-menu-item"
          role="menuitem"
          onClick={() => {
            tabsStore.getState().promoteTab(menu.tabId);
            onClose();
          }}
        >
          Keep open
        </button>
      )}
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
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          closeAllTabs();
          onClose();
        }}
      >
        Close all
      </button>
    </div>
  );
}

/**
 * Dropdown listing the tabs the bar has no room for. Selecting one activates
 * it — the windowing math then slides the visible row to include it.
 */
function OverflowMenu({
  tabs,
  anchor,
  onClose,
}: {
  tabs: TabEntry[];
  anchor: DOMRect;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
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
      className="tab-menu tab-overflow-menu"
      role="menu"
      // Right-aligned under the ⋯ button so it never runs off the window edge.
      style={{ right: window.innerWidth - anchor.right, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className="tab-menu-item"
          role="menuitem"
          title={tab.filePath ?? undefined}
          onClick={() => {
            tabsStore.getState().activateTab(tab.id);
            onClose();
          }}
        >
          {tabDisplayTitle(tab)}
          {tab.kind === 'file' && tab.dirty && <span className="tab-dirty-dot"> •</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Width budget for the visible-tab window. A tab can flex-shrink down to its
 * 96px min-width (+1px border), so as long as we show no more tabs than
 * `available / 97` the row always fits with no tab cut off; below that count
 * tabs simply take their natural width. The constants mirror app.css — the
 * spacer's min-width and the ⋯ button reserve are budgeted even when those
 * elements are absent so the capacity can't oscillate as they come and go.
 */
const TAB_MIN_TOTAL = 97;
const SPACER_MIN = 32;
const OVERFLOW_BTN_RESERVE = 34;
const MAC_INSET = 78; // .tabbar-mac padding-left

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const barRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);
  const [capacity, setCapacity] = useState(Number.MAX_SAFE_INTEGER);
  const windowStartRef = useRef(0);

  // How many whole tabs fit: bar width minus everything that isn't a tab
  // (new-tab button, window controls, spacer minimum, ⋯ reserve, mac inset).
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) {
      return;
    }
    const measure = () => {
      let reserved = SPACER_MIN + OVERFLOW_BTN_RESERVE + (IS_MAC ? MAC_INSET : 0);
      for (const child of bar.children) {
        const el = child as HTMLElement;
        if (
          el.classList.contains('tabbar-scroller') ||
          el.classList.contains('tabbar-spacer') ||
          el.classList.contains('tab-overflow') ||
          el.classList.contains('tab-menu')
        ) {
          continue;
        }
        reserved += el.offsetWidth;
      }
      setCapacity(Math.max(1, Math.floor((bar.clientWidth - reserved) / TAB_MIN_TOTAL)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
  const start = computeTabWindow(tabs.length, capacity, activeIndex, windowStartRef.current);
  windowStartRef.current = start;
  const visible = tabs.slice(start, start + Math.max(1, capacity));
  const hidden = [...tabs.slice(0, start), ...tabs.slice(start + Math.max(1, capacity))];

  return (
    // data-tauri-drag-region only fires on the element itself, never its
    // children — so empty bar space drags/double-click-maximizes the window
    // while tabs and buttons keep their own interactions.
    <div
      ref={barRef}
      className={IS_MAC ? 'tabbar tabbar-mac' : 'tabbar'}
      role="tablist"
      data-tauri-drag-region=""
    >
      <div className="tabbar-scroller">
        {visible.map((tab) => (
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
      {hidden.length > 0 && (
        <button
          className="tab-overflow"
          aria-label={`Show ${hidden.length} more tab(s)`}
          title={`${hidden.length} more tab(s)`}
          onClick={(e) =>
            setOverflowAnchor(overflowAnchor ? null : e.currentTarget.getBoundingClientRect())
          }
          // Keep the window pointerdown dismiss handler from instantly
          // re-closing the menu this click opens.
          onPointerDown={(e) => e.stopPropagation()}
        >
          ⋯
        </button>
      )}
      <div className="tabbar-spacer" data-tauri-drag-region="" />
      <button
        className="tab-close-all"
        aria-label="Close all tabs"
        title="Close all tabs"
        onClick={() => closeAllTabs()}
      >
        ⊗
      </button>
      {!IS_MAC && <WindowControls />}
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {overflowAnchor && hidden.length > 0 && (
        <OverflowMenu
          tabs={hidden}
          anchor={overflowAnchor}
          onClose={() => setOverflowAnchor(null)}
        />
      )}
    </div>
  );
}
