/**
 * TabBar — the row of tabs, group chips, and the new-tab button.
 *
 * Interactions (src/ui/README): click activates; middle-click closes; the ×
 * button closes; double-click, F2, or the right-click / long-press context
 * menu starts an inline rename; pointer-event drag reorders tabs and moves
 * them between groups (no dnd dependency, and NOT HTML5 drag-and-drop —
 * Tauri's OS drag-drop interception swallows webview-internal HTML5 drags on
 * Windows, the same constraint the FileExplorer documents). The displayed
 * label mirrors the tab's file name minus its extension (see
 * `tabDisplayTitle`); committing a rename renames that file on disk (see
 * session.renameTab). All behavior dispatches store/session actions; the
 * component itself stays declarative.
 *
 * Tab groups (Chrome-style): a colored chip precedes each group's contiguous
 * run of tabs; clicking the chip collapses/expands the group (collapsed =
 * only the chip shows), right-click / long-press opens the group menu
 * (rename, color, ungroup, close). Dropping a dragged tab strictly INSIDE a
 * group's run joins the group; dropping on the chip appends to the group;
 * dropping at run boundaries leaves it ungrouped (core/tab-groups owns the
 * rules — the store's moveTab re-normalizes contiguity after every drop).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeAllTabs, closeTab, moveTabToNewWindow, renameTab } from '../session';
import { runNewTabChoice, newTabDefault, terminalsAvailable } from '../new-tab';
import { openTerminal } from '../terminal-open';
import { useSettingsStore } from '../stores/settings';
import { useUiStore, uiStore } from '../stores/ui';
import { detectPlatform } from '../keymap';
import { clippedTabIds, sameIds, type StripItemRect } from '../tab-overflow';
import { computeGroupRuns } from '../../core/tab-groups';
import { WORKSPACE_COLORS, type TabGroup } from '../../core/types';
import { tabsStore, tabDisplayTitle, useTabsStore, type TabEntry } from '../stores/tabs';
import { WindowControls } from './WindowControls';
import { isAndroid } from '../platform';

/**
 * The TabBar doubles as the window titlebar (no native decorations, so tabs
 * sit level with the window buttons). On macOS the native traffic lights
 * overlay the top-left (titleBarStyle Overlay) — inset the tabs past them and
 * render no custom controls; on Windows/Linux render our own on the right.
 */
const IS_MAC = detectPlatform(navigator.platform) === 'mac';

/**
 * Tear-off gesture (M8): releasing a tab drag outside the window spawns a new
 * window there. Gated off on Linux — Wayland gives apps no reliable global
 * cursor position or window placement, so only the context-menu fallback
 * ("Move to new window") is offered there — and on Android, which is
 * single-window (its UA already reports Linux, so this is belt-and-suspenders).
 */
const CAN_TEAR_OFF = !/linux/i.test(navigator.platform) && !isAndroid();

/** Pointer travel (px, manhattan) before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/** Where a context menu is open, and for which tab. */
interface TabMenu {
  tabId: string;
  x: number;
  y: number;
}

/** Where the group menu is open, and for which group. */
interface GroupMenu {
  groupId: string;
  x: number;
  y: number;
}

/** Semantic drop target tracked during a tab drag. */
type DropTarget =
  { type: 'before' | 'after'; tabId: string } | { type: 'chip'; groupId: string } | { type: 'end' };

/** Visual drop feedback: an insertion bar at x (scroller-relative) or a chip highlight. */
type DropHint = { x: number } | { chip: string };

/** One rendered element of the strip: a group chip or a tab. */
type StripItem =
  | { kind: 'chip'; group: TabGroup; count: number }
  | { kind: 'tab'; tab: TabEntry; group: TabGroup | null; groupStart: boolean; groupEnd: boolean };

/** Menu label for a group: its name, else its color token ("blue"). */
function groupLabel(group: TabGroup): string {
  return group.name || group.color;
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
  group,
  groupStart,
  groupEnd,
  onMenu,
  onDragPress,
}: {
  tab: TabEntry;
  active: boolean;
  group: TabGroup | null;
  groupStart: boolean;
  groupEnd: boolean;
  onMenu: (tabId: string, x: number, y: number) => void;
  onDragPress: (e: React.PointerEvent, tabId: string) => void;
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

  const className =
    `tab${active ? ' tab-active' : ''}${tab.preview ? ' tab-preview' : ''}` +
    `${group ? ' tab-grouped' : ''}${groupStart ? ' tab-group-start' : ''}` +
    `${groupEnd ? ' tab-group-end' : ''}`;

  return (
    <div
      className={className}
      role="tab"
      aria-selected={active}
      title={tab.filePath ?? label}
      data-strip-tab={tab.id}
      // Group membership, read by the overflow measurement: a clipped chip
      // takes its whole run into the overflow list.
      data-strip-group={group?.id}
      data-color={group?.color}
      onPointerDown={(e) => {
        // Left-click activates immediately (pointerdown feels snappier than
        // click); ignore clicks that originate on the close button.
        if (e.button === 0 && !(e.target as HTMLElement).closest('.tab-close')) {
          store().activateTab(tab.id);
          if (!renaming) {
            onDragPress(e, tab.id);
          }
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

/**
 * The colored pill heading a group's run. Click toggles collapse; right-click
 * / long-press opens the group menu. While a tab drag hovers it, it
 * highlights as "drop here to join".
 */
function GroupChip({
  group,
  count,
  dropHighlight,
  onMenu,
}: {
  group: TabGroup;
  count: number;
  dropHighlight: boolean;
  onMenu: (groupId: string, x: number, y: number) => void;
}) {
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelLongPress() {
    if (longPress.current !== null) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }

  return (
    <button
      className={`tab-group-chip${dropHighlight ? ' chip-drop' : ''}`}
      data-strip-chip={group.id}
      data-color={group.color}
      aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} group ${groupLabel(group)}`}
      title={`${groupLabel(group)} — ${count} tab(s)`}
      onClick={() => tabsStore.getState().toggleGroupCollapsed(group.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(group.id, e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch') {
          const { clientX, clientY } = e;
          cancelLongPress();
          longPress.current = setTimeout(() => onMenu(group.id, clientX, clientY), 500);
        }
      }}
      onPointerUp={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
      <span className="tab-group-chip-dot" />
      {group.name && <span className="tab-group-chip-name">{group.name}</span>}
      {group.collapsed && <span className="tab-group-chip-count">{count}</span>}
    </button>
  );
}

function TabContextMenu({ menu, onClose }: { menu: TabMenu; onClose: () => void }) {
  // Transient menu — a one-shot store read is fine (it closes on any change).
  const s = tabsStore.getState();
  const tab = s.tabs.find((t) => t.id === menu.tabId);
  const isPreview = tab?.preview ?? false;
  const groupId = tab?.groupId ?? null;
  const otherGroups = s.groups.filter((g) => g.id !== groupId);
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
          tabsStore.getState().addTabToNewGroup(menu.tabId);
          onClose();
        }}
      >
        Add to new group
      </button>
      {otherGroups.map((g) => (
        <button
          key={g.id}
          className="tab-menu-item tab-menu-group-item"
          role="menuitem"
          data-color={g.color}
          onClick={() => {
            tabsStore.getState().addTabToGroup(menu.tabId, g.id);
            onClose();
          }}
        >
          <span className="tab-group-chip-dot" /> Add to “{groupLabel(g)}”
        </button>
      ))}
      {groupId !== null && (
        <button
          className="tab-menu-item"
          role="menuitem"
          onClick={() => {
            tabsStore.getState().removeTabFromGroup(menu.tabId);
            onClose();
          }}
        >
          Remove from group
        </button>
      )}
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          moveTabToNewWindow(menu.tabId, null);
          onClose();
        }}
      >
        Move to new window
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

/** Right-click menu on a group chip: rename, recolor, ungroup, close. */
function GroupContextMenu({ menu, onClose }: { menu: GroupMenu; onClose: () => void }) {
  const group = tabsStore.getState().groups.find((g) => g.id === menu.groupId);
  const nameRef = useRef<HTMLInputElement>(null);
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

  if (!group) {
    return null;
  }

  function commitName() {
    tabsStore.getState().renameGroup(menu.groupId, nameRef.current?.value ?? '');
  }

  return (
    <div
      className="tab-menu tab-group-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={nameRef}
        className="tab-group-menu-name"
        defaultValue={group.name}
        placeholder="Name group…"
        aria-label="Group name"
        onBlur={commitName}
        onKeyDown={(e) => {
          // Keep these off the global shortcut listener.
          e.stopPropagation();
          if (e.key === 'Enter') {
            commitName();
            onClose();
          }
        }}
      />
      <div className="context-menu-swatches">
        {WORKSPACE_COLORS.map((color) => (
          <button
            key={color}
            className="color-swatch"
            data-color={color}
            data-active={group.color === color ? '' : undefined}
            aria-label={`Color ${color}`}
            onClick={() => tabsStore.getState().setGroupColor(menu.groupId, color)}
          />
        ))}
      </div>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          tabsStore.getState().toggleGroupCollapsed(menu.groupId);
          onClose();
        }}
      >
        {group.collapsed ? 'Expand group' : 'Collapse group'}
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          tabsStore.getState().ungroupTabs(menu.groupId);
          onClose();
        }}
      >
        Ungroup
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => {
          // Interactive close per member (confirms discards, like Close all).
          for (const t of tabsStore.getState().tabs.filter((x) => x.groupId === menu.groupId)) {
            closeTab(t.id);
          }
          onClose();
        }}
      >
        Close group
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
      // Right-aligned under the button so it never runs off the window edge.
      style={{ right: window.innerWidth - anchor.right, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {tabs.map((tab) => (
        <div key={tab.id} className="tab-overflow-row">
          <button
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
          {/* A clipped tab has no × of its own on screen — this is the only
              way to close one without first scrolling it into view. */}
          <button
            className="tab-overflow-close"
            aria-label={`Close ${tabDisplayTitle(tab)}`}
            title="Close"
            onClick={() => {
              closeTab(tab.id);
              onClose();
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Phone-width layout (mirrors app.css's 640px breakpoint). On phones the strip
 * shows ONLY the active tab, stretched across the row like a mobile browser's
 * title bar; every other tab is one tap away in the switcher (the overflow
 * button, which shows a count instead of ⋯). CSS does the hiding; the hidden
 * tabs then measure as zero-width, which `clippedTabIds` already reports as
 * clipped — so the switcher's contents fall out of the same rule the desktop
 * overflow uses. This flag only picks the button's label.
 */
const PHONE_QUERY = '(max-width: 640px)';

function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/**
 * The "+" button's type picker: alt-click, right-click, long-press, or
 * mod+Shift+N. A plain click never opens it — it just makes another one of
 * whatever is in front (core/new-tab.ts) — so the menu is the explicit route
 * to a type the inference would not have chosen.
 */
function NewTabMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const profiles = useSettingsStore((s) => s.settings.terminalProfiles);
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

  function pick(run: () => void) {
    onClose();
    run();
  }

  return (
    <div
      className="tab-menu tab-new-menu"
      role="menu"
      style={{ left: Math.max(4, anchor.left), top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => pick(() => runNewTabChoice('note'))}
      >
        Markdown note
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => pick(() => runNewTabChoice('drawing'))}
      >
        Vector drawing (.svg)
      </button>
      {/* Android has no pty, so the whole terminal section is absent there. */}
      {terminalsAvailable() &&
        (profiles.length > 1 ? (
          <>
            <div className="tab-menu-label">Terminal</div>
            {profiles.map((profile) => (
              <button
                key={profile.id}
                className="tab-menu-item tab-menu-sub"
                role="menuitem"
                onClick={() => pick(() => openTerminal(profile.id))}
              >
                {profile.name}
              </button>
            ))}
          </>
        ) : (
          <button
            className="tab-menu-item"
            role="menuitem"
            onClick={() => pick(() => runNewTabChoice('terminal'))}
          >
            Terminal
          </button>
        ))}
    </div>
  );
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const groups = useTabsStore((s) => s.groups);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const barRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);
  /** Ids of the tabs the strip is currently cutting off, in strip order. */
  const [clipped, setClipped] = useState<readonly string[]>([]);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const phone = usePhoneLayout();
  // The picker's open flag lives in uiStore because mod+Shift+N opens it too
  // (global shortcuts dispatch store actions); the anchor is local geometry.
  const newTabMenuOpen = useUiStore((s) => s.newTabMenuOpen);
  const newTabRef = useRef<HTMLButtonElement>(null);
  const newTabLongPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newTabAnchor, setNewTabAnchor] = useState<DOMRect | null>(null);

  function cancelNewTabLongPress() {
    if (newTabLongPress.current !== null) {
      clearTimeout(newTabLongPress.current);
      newTabLongPress.current = null;
    }
  }

  function openPicker() {
    cancelNewTabLongPress();
    setNewTabAnchor(newTabRef.current?.getBoundingClientRect() ?? null);
    uiStore.getState().openNewTabMenu();
  }

  // mod+Shift+N opens the picker without a click, so the anchor has to be
  // taken when the flag flips rather than only in the click handler.
  useLayoutEffect(() => {
    if (newTabMenuOpen && !newTabAnchor) {
      setNewTabAnchor(newTabRef.current?.getBoundingClientRect() ?? null);
    }
    if (!newTabMenuOpen && newTabAnchor) {
      setNewTabAnchor(null);
    }
  }, [newTabMenuOpen, newTabAnchor]);

  /**
   * Which tabs the strip is cutting off. Ids and rects come off the DOM rather
   * than out of `tabs`, which is what lets this stay a stable callback: a
   * ResizeObserver that re-subscribed on every render would cost more than the
   * measurement it schedules. The rule itself is `clippedTabIds` (pure, tested).
   */
  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const strip = scroller.getBoundingClientRect();
    const items: StripItemRect[] = [];
    for (const node of scroller.children) {
      const el = node as HTMLElement;
      const tabId = el.dataset.stripTab ?? null;
      const chipGroup = el.dataset.stripChip ?? null;
      if (tabId === null && chipGroup === null) {
        continue; // the drop indicator
      }
      const box = el.getBoundingClientRect();
      items.push({
        tabId,
        groupId: chipGroup ?? el.dataset.stripGroup ?? null,
        left: box.left,
        right: box.right,
      });
    }
    const hidden = clippedTabIds(strip, items);
    setClipped((prev) => (sameIds(prev, hidden) ? prev : hidden));
  }, []);

  // Re-measure on everything that can change the answer: which tabs there are
  // and what they're called (a title sets a width, and a renamed tab can push
  // another off), the strip's own size, and scrolling it (wired to onScroll).
  const layoutKey = `${tabs.map((t) => `${t.id}\u0001${tabDisplayTitle(t)}`).join('\u0000')}|${groups
    .map((g) => `${g.id}:${g.collapsed ? 'c' : 'o'}`)
    .join(',')}`;
  useLayoutEffect(measure, [measure, layoutKey, phone]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [measure]);

  // Keep the active tab on screen: activating one with the keyboard or from
  // the overflow menu is useless if it stays scrolled away.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeTabId) {
      return;
    }
    for (const node of scroller.children) {
      if ((node as HTMLElement).dataset.stripTab === activeTabId) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
    }
  }, [activeTabId, layoutKey]);

  /* ---- Pointer drag: reorder / regroup / tear-off ----------------------- */

  function updateDropHint(ev: PointerEvent, movedId: string): void {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const scroller = scrollerRef.current;
    if (!under || !scroller) {
      dropTargetRef.current = null;
      setDropHint(null);
      return;
    }
    const sRect = scroller.getBoundingClientRect();
    const chipEl = under.closest('[data-strip-chip]');
    if (chipEl) {
      const groupId = chipEl.getAttribute('data-strip-chip')!;
      dropTargetRef.current = { type: 'chip', groupId };
      setDropHint((prev) =>
        prev && 'chip' in prev && prev.chip === groupId ? prev : { chip: groupId },
      );
      return;
    }
    const tabEl = under.closest('[data-strip-tab]');
    if (tabEl) {
      const tabId = tabEl.getAttribute('data-strip-tab')!;
      if (tabId === movedId) {
        dropTargetRef.current = null;
        setDropHint(null);
        return;
      }
      const rect = tabEl.getBoundingClientRect();
      const after = ev.clientX - rect.left > rect.width / 2;
      dropTargetRef.current = { type: after ? 'after' : 'before', tabId };
      // Scroller-relative, and the strip scrolls now: without scrollLeft the
      // indicator drifts off the seam as soon as the strip is scrolled.
      const x = (after ? rect.right : rect.left) - sRect.left + scroller.scrollLeft;
      setDropHint((prev) => (prev && 'x' in prev && prev.x === x ? prev : { x }));
      return;
    }
    if (barRef.current?.contains(under)) {
      // Over the bar but past the tabs (spacer / empty right area) → end.
      dropTargetRef.current = { type: 'end' };
      const last = scroller.lastElementChild;
      const x = last ? last.getBoundingClientRect().right - sRect.left + scroller.scrollLeft : 0;
      setDropHint((prev) => (prev && 'x' in prev && prev.x === x ? prev : { x }));
      return;
    }
    dropTargetRef.current = null;
    setDropHint(null);
  }

  /** Turn the semantic drop target into a store moveTab call. */
  function applyDrop(movedId: string, target: DropTarget): void {
    const s = tabsStore.getState();
    const rest = s.tabs.filter((t) => t.id !== movedId);
    if (target.type === 'chip') {
      const idx = rest.map((t) => t.groupId).lastIndexOf(target.groupId) + 1;
      s.moveTab(movedId, idx, target.groupId);
      return;
    }
    if (target.type === 'end') {
      s.moveTab(movedId, rest.length, null);
      return;
    }
    const base = rest.findIndex((t) => t.id === target.tabId);
    if (base < 0) {
      return;
    }
    const idx = target.type === 'before' ? base : base + 1;
    // Membership the landing spot implies: inside a group's run joins it,
    // boundaries leave the tab ungrouped (store's reorderTab rule).
    s.reorderTab(movedId, idx);
  }

  function onDragPress(e: React.PointerEvent, tabId: string): void {
    if (e.button !== 0) {
      return;
    }
    // Synchronous grab — React nulls currentTarget after the handler returns.
    const el = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      el.classList.remove('tab-dragging');
      setDropHint(null);
    }
    function onMove(ev: PointerEvent): void {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        dragging = true;
        // Keep receiving moves after the pointer leaves the window — that's
        // what lets the release position decide tear-off vs reorder.
        try {
          el.setPointerCapture(pointerId);
        } catch {
          // A tab that re-rendered away mid-press can't capture; drag on.
        }
        el.classList.add('tab-dragging');
      }
      updateDropHint(ev, tabId);
    }
    function onUp(ev: PointerEvent): void {
      const wasDrag = dragging;
      const target = dropTargetRef.current;
      dropTargetRef.current = null;
      cleanup();
      if (!wasDrag) {
        return; // plain click — activation already happened on pointerdown
      }
      if (CAN_TEAR_OFF) {
        const outside =
          ev.screenX < window.screenX ||
          ev.screenX > window.screenX + window.outerWidth ||
          ev.screenY < window.screenY ||
          ev.screenY > window.screenY + window.outerHeight;
        if (outside) {
          // Offset so the new window's tab sits under the cursor, not at it.
          moveTabToNewWindow(tabId, {
            x: Math.round(ev.screenX - 80),
            y: Math.round(ev.screenY - 20),
          });
          return;
        }
      }
      if (target) {
        applyDrop(tabId, target);
      }
    }
    function onCancel(): void {
      dropTargetRef.current = null;
      cleanup();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /* ---- Strip layout ------------------------------------------------------ */

  // Tabs + chips as one flat item list; the overflow window slides over it.
  const items: StripItem[] = [];
  for (const run of computeGroupRuns(tabs)) {
    const group = run.groupId !== null ? groups.find((g) => g.id === run.groupId) : undefined;
    if (!group) {
      for (let i = 0; i < run.count; i++) {
        items.push({
          kind: 'tab',
          tab: tabs[run.start + i]!,
          group: null,
          groupStart: false,
          groupEnd: false,
        });
      }
      continue;
    }
    items.push({ kind: 'chip', group, count: run.count });
    if (!group.collapsed) {
      for (let i = 0; i < run.count; i++) {
        items.push({
          kind: 'tab',
          tab: tabs[run.start + i]!,
          group,
          groupStart: i === 0,
          groupEnd: i === run.count - 1,
        });
      }
    }
  }

  // EVERY item renders; the strip shrinks them and then scrolls. What is
  // currently cut off is measured, not computed — see `measure` above.
  const clippedSet = new Set(clipped);
  const hidden = items
    .filter((it): it is StripItem & { kind: 'tab' } => it.kind === 'tab')
    .map((it) => it.tab)
    .filter((tab) => clippedSet.has(tab.id));

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
      <div className="tabbar-scroller" ref={scrollerRef} onScroll={measure}>
        {items.map((item) =>
          item.kind === 'chip' ? (
            <GroupChip
              key={`chip:${item.group.id}`}
              group={item.group}
              count={item.count}
              dropHighlight={
                dropHint !== null && 'chip' in dropHint && dropHint.chip === item.group.id
              }
              onMenu={(groupId, x, y) => setGroupMenu({ groupId, x, y })}
            />
          ) : (
            <Tab
              key={item.tab.id}
              tab={item.tab}
              active={item.tab.id === activeTabId}
              group={item.group}
              groupStart={item.groupStart}
              groupEnd={item.groupEnd}
              onMenu={(tabId, x, y) => setMenu({ tabId, x, y })}
              onDragPress={onDragPress}
            />
          ),
        )}
        {dropHint !== null && 'x' in dropHint && (
          <div className="tab-drop-indicator" style={{ left: dropHint.x }} />
        )}
      </div>
      <button
        ref={newTabRef}
        className="tab-new"
        aria-label="New tab"
        title="New tab (Ctrl/Cmd+N) — Alt-click or right-click to choose a type"
        onClick={(e) => {
          // Alt-click is the mouse's route to the picker; a plain click makes
          // another one of whatever is in front.
          if (e.altKey) {
            openPicker();
          } else {
            newTabDefault();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openPicker();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.pointerType !== 'touch') {
            return;
          }
          cancelNewTabLongPress();
          newTabLongPress.current = setTimeout(openPicker, 500);
        }}
        onPointerUp={cancelNewTabLongPress}
        onPointerLeave={cancelNewTabLongPress}
        onPointerCancel={cancelNewTabLongPress}
      >
        +
      </button>
      {hidden.length > 0 && (
        <button
          className="tab-overflow"
          aria-label={`Show ${hidden.length} tab(s) that don't fit`}
          title={`${hidden.length} tab(s) don't fit`}
          onClick={(e) =>
            setOverflowAnchor(overflowAnchor ? null : e.currentTarget.getBoundingClientRect())
          }
          // Keep the window pointerdown dismiss handler from instantly
          // re-closing the menu this click opens.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* The count, not an anonymous ⋯: it says how much is off screen,
              and on phones the same pill IS the tab switcher. */}
          {phone ? `+${hidden.length}` : `›${hidden.length}`}
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
      {!IS_MAC && !isAndroid() && <WindowControls />}
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {groupMenu && <GroupContextMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
      {newTabMenuOpen && newTabAnchor && (
        <NewTabMenu anchor={newTabAnchor} onClose={() => uiStore.getState().closeNewTabMenu()} />
      )}
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
