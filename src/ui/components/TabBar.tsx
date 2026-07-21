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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeAllTabs, closeTab, moveTabToNewWindow, renameTab } from '../session';
import { detectPlatform } from '../keymap';
import { computeTabWindow } from '../tab-overflow';
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
 * Width budget for the visible-item window. A tab can flex-shrink down to its
 * 96px min-width (+1px border), so as long as we show no more items than
 * `available / 97` the row always fits with no tab cut off; below that count
 * items simply take their natural width. (Group chips are narrower than tabs,
 * so budgeting them as full tabs errs on the safe side.) The constants mirror
 * app.css — the spacer's min-width and the ⋯ button reserve are budgeted even
 * when those elements are absent so the capacity can't oscillate as they come
 * and go.
 */
const TAB_MIN_TOTAL = 97;
const SPACER_MIN = 32;
const OVERFLOW_BTN_RESERVE = 34;
const MAC_INSET = 78; // .tabbar-mac padding-left

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const groups = useTabsStore((s) => s.groups);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const barRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);
  const [capacity, setCapacity] = useState(Number.MAX_SAFE_INTEGER);
  const [windowStart, setWindowStart] = useState(0);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);

  // How many whole items fit: bar width minus everything that isn't a tab
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
      const x = (after ? rect.right : rect.left) - sRect.left;
      setDropHint((prev) => (prev && 'x' in prev && prev.x === x ? prev : { x }));
      return;
    }
    if (barRef.current?.contains(under)) {
      // Over the bar but past the tabs (spacer / empty right area) → end.
      dropTargetRef.current = { type: 'end' };
      const last = scroller.lastElementChild;
      const x = last ? last.getBoundingClientRect().right - sRect.left : 0;
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

  const activeIndex = items.findIndex((it) => it.kind === 'tab' && it.tab.id === activeTabId);
  const start = computeTabWindow(items.length, capacity, activeIndex, windowStart);
  if (start !== windowStart) {
    // Derived state with history: remember the window so it only slides when
    // the active tab leaves it (set-state-during-render, per React docs).
    setWindowStart(start);
  }
  const visible = items.slice(start, start + Math.max(1, capacity));
  const hidden = [...items.slice(0, start), ...items.slice(start + Math.max(1, capacity))]
    .filter((it): it is StripItem & { kind: 'tab' } => it.kind === 'tab')
    .map((it) => it.tab);

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
      <div className="tabbar-scroller" ref={scrollerRef}>
        {visible.map((item) =>
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
      {!IS_MAC && !isAndroid() && <WindowControls />}
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {groupMenu && <GroupContextMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
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
