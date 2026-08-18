/**
 * TabBar — the row of tabs and the new-tab button.
 *
 * Interactions (src/ui/README): click activates; middle-click closes; the ×
 * button closes; double-click, F2, or the right-click / long-press context
 * menu starts an inline rename; right-clicking the bar's FREE space (not a
 * tab) opens the strip's own menu — a small app menu (New tab, command
 * palette, Themes, Settings, the full-screen stages, "Close all tabs");
 * pointer-event drag reorders tabs and moves
 * around (no dnd dependency, and NOT HTML5 drag-and-drop —
 * Tauri's OS drag-drop interception swallows webview-internal HTML5 drags on
 * Windows, the same constraint the FileExplorer documents). The displayed
 * label mirrors the tab's file name minus its extension (see
 * `tabDisplayTitle`); committing a rename renames that file on disk (see
 * session.renameTab). All behavior dispatches store/session actions; the
 * component itself stays declarative.
 *
 * Agent status cues: a terminal tab whose shell prefixes its OSC title with a
 * status glyph (Claude Code writes `✳ ` when idle and alternates `◐ `/`◑ `
 * while it works) shows that glyph as a colored badge instead of as one more
 * 13px character in the label — amber and pulsing while working, green when
 * the turn is yours, blue when it is blocked on you, red when it failed.
 * core/tab-status.ts owns the glyph → activity table.
 *
 * Workspace cues (what replaced the Chrome-style tab groups): a tab wears the
 * accent of the WORKSPACE its file lives in — the same `data-color` →
 * `--ws-accent` tokens the explorer's workspace sections use — as a stripe
 * along its top and a quiet wash, and neighbors from one workspace flow
 * together as a run. Nothing here is user-managed: the grouping IS the
 * explorer's, so there is no chip to name, color, collapse, or garbage-collect
 * (src/ui/workspace-cues.ts resolves a tab's workspace, core/tab-workspaces.ts
 * owns the rules). Dragging reorders freely; with the
 * `groupTabsByWorkspace` setting on, the store pulls each workspace's tabs
 * back into one contiguous run after every drop.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { closeAllTabs, closeTab, moveTabToNewWindow, renameTab } from '../session';
import { runNewTabChoice, newTabDefault, terminalsAvailable } from '../new-tab';
import { openTerminal } from '../terminal-open';
import { setFullscreen } from '../fullscreen';
import { useSettingsStore } from '../stores/settings';
import { useUiStore, uiStore } from '../stores/ui';
import { detectPlatform } from '../keymap';
import { clippedTabIds, sameIds, wholeTabsWidth, type StripItemRect } from '../tab-overflow';
import { computeWorkspaceRuns } from '../../core/tab-workspaces';
import { splitAgentStatus, type AgentStatusCue } from '../../core/tab-status';
import type { WorkspaceColor } from '../../core/types';
import { workspaceCueFor } from '../workspace-cues';
import { tabsStore, tabDisplayTitle, useTabsStore, type TabEntry } from '../stores/tabs';
import { AppMenuDivider, AppMenuItem, ThemesMenuPage } from './AppMenu';
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

/** Gap kept between a clamped popover menu and the window edge (px). */
const MENU_EDGE_MARGIN = 8;

/** Pointer travel (px, manhattan) before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 5;

/** Where a context menu is open, and for which tab. */
interface TabMenu {
  tabId: string;
  x: number;
  y: number;
}

/** Semantic drop target tracked during a tab drag. */
type DropTarget = { type: 'before' | 'after'; tabId: string } | { type: 'end' };

/** Visual drop feedback: an insertion bar at x (scroller-relative). */
interface DropHint {
  x: number;
}

/** One rendered tab, with the workspace run it sits in. */
interface StripItem {
  tab: TabEntry;
  /** Workspace color token, or null for a tab in no (or an uncolored) workspace. */
  color: WorkspaceColor | null;
  /** Workspace key — null when the tab belongs to none; drives run grouping. */
  workspaceKey: string | null;
  runStart: boolean;
  runEnd: boolean;
}

/**
 * A tab's label, split into the agent status glyph and the text after it.
 * Only terminal tabs carry a cue — a note called "✳ ideas" is a note, not a
 * busy agent.
 */
function tabLabelParts(tab: TabEntry): { cue: AgentStatusCue | null; text: string } {
  const label = tabDisplayTitle(tab);
  if (tab.kind !== 'terminal') {
    return { cue: null, text: label };
  }
  const { cue, rest } = splitAgentStatus(label);
  return { cue, text: rest };
}

/**
 * The status badge is a SIBLING of `.tab-title`, never a child: that span
 * clips its text with `overflow: hidden` to make room for the ellipsis, which
 * would shave the badge's disc and its pulse glow off at both edges.
 */
function StatusBadge({ cue }: { cue: AgentStatusCue }) {
  return (
    <span className="tab-status" data-activity={cue.activity} aria-label={cue.label} role="img">
      {cue.glyph}
    </span>
  );
}

/** The same badge + label inside an overflow-menu row, which never ellipsizes. */
function OverflowLabel({ tab }: { tab: TabEntry }) {
  const { cue, text } = tabLabelParts(tab);
  return (
    <>
      {cue && <StatusBadge cue={cue} />}
      {text}
    </>
  );
}

function RenameInput({ tab }: { tab: TabEntry }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // A rename replaces the title outright, so seed the box with the label the
  // user reads — never with the agent's status glyph.
  const initial = splitAgentStatus(tabDisplayTitle(tab)).rest;

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
  color,
  workspaceKey,
  runStart,
  runEnd,
  onMenu,
  onDragPress,
}: {
  tab: TabEntry;
  active: boolean;
  color: WorkspaceColor | null;
  workspaceKey: string | null;
  runStart: boolean;
  runEnd: boolean;
  onMenu: (tabId: string, x: number, y: number) => void;
  onDragPress: (e: React.PointerEvent, tabId: string) => void;
}) {
  const renaming = useTabsStore((s) => s.renamingTabId === tab.id);
  const store = tabsStore.getState;
  const label = tabDisplayTitle(tab);
  const { cue, text } = tabLabelParts(tab);
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
    `${color ? ' tab-workspace' : ''}${runStart ? ' tab-run-start' : ''}` +
    `${runEnd ? ' tab-run-end' : ''}`;

  return (
    <div
      className={className}
      role="tab"
      aria-selected={active}
      title={tab.filePath ?? label}
      data-strip-tab={tab.id}
      data-strip-workspace={workspaceKey ?? undefined}
      data-color={color ?? undefined}
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
        <>
          {cue && <StatusBadge cue={cue} />}
          <span className="tab-title">
            {text}
            {tab.kind === 'file' && tab.dirty && (
              <span className="tab-dirty-dot" aria-label="Unsaved changes">
                {' '}
                •
              </span>
            )}
          </span>
        </>
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
 * Dismiss a transient menu on any outside interaction: a pointerdown that did
 * not reach the menu (menus stop their own), Escape, resize, or window blur.
 */
function useMenuDismiss(onClose: () => void): void {
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
}

function TabContextMenu({ menu, onClose }: { menu: TabMenu; onClose: () => void }) {
  // Transient menu — a one-shot store read is fine (it closes on any change).
  const s = tabsStore.getState();
  const tab = s.tabs.find((t) => t.id === menu.tabId);
  const isPreview = tab?.preview ?? false;
  useMenuDismiss(onClose);

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

/**
 * The strip's own menu — right-clicking free tab-bar space (the slack after
 * the last tab, or the spacer before the window controls). It carries what
 * belongs to the bar and to the app rather than to one tab, so the empty
 * strip is a full app menu and not a single-item stub: a New tab page (every
 * type, one row per terminal profile), the palette, Themes, Settings, the
 * full-screen stages, and "Close all tabs" — which lives here instead of as a
 * permanent ⊗ button in the titlebar.
 *
 * Themes drills in rather than flying out, and shares its page with the
 * ribbon's ☰ menu (components/AppMenu) so the two can't drift apart.
 */
function BarContextMenu({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);
  const [page, setPage] = useState<'root' | 'new' | 'themes'>('root');
  useMenuDismiss(onClose);

  // The menu is tall (and taller still on a drill-in page), and it opens at
  // the pointer — clamp it inside the viewport before the first paint, and
  // again whenever a page swap changes its height.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPlaced({
      x: Math.max(
        MENU_EDGE_MARGIN,
        Math.min(at.x, window.innerWidth - box.width - MENU_EDGE_MARGIN),
      ),
      y: Math.max(
        MENU_EDGE_MARGIN,
        Math.min(at.y, window.innerHeight - box.height - MENU_EDGE_MARGIN),
      ),
    });
  }, [at.x, at.y, page]);

  return (
    <div
      ref={ref}
      className="tab-menu app-menu"
      role="menu"
      aria-label="Tab bar menu"
      style={{
        left: (placed ?? at).x,
        top: (placed ?? at).y,
        // Invisible for the one frame it takes to measure and clamp.
        visibility: placed ? undefined : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {page === 'themes' ? (
        <ThemesMenuPage onBack={() => setPage('root')} onClose={onClose} />
      ) : page === 'new' ? (
        <NewTabPage onBack={() => setPage('root')} onClose={onClose} />
      ) : (
        <BarMenuRoot
          onOpenNew={() => setPage('new')}
          onOpenThemes={() => setPage('themes')}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** The bar menu's top level. */
function BarMenuRoot({
  onOpenNew,
  onOpenThemes,
  onClose,
}: {
  onOpenNew: () => void;
  onOpenThemes: () => void;
  onClose: () => void;
}) {
  const count = useTabsStore((s) => s.tabs.length);
  const stage = useUiStore((s) => s.fullscreenView);

  return (
    <>
      <AppMenuItem
        glyph="✚"
        label="New tab"
        title="Pick the kind of tab to open"
        shortcut="›"
        onPick={onOpenNew}
        onClose={onClose}
        keepOpen
      />
      <AppMenuDivider />
      <AppMenuItem
        glyph="»"
        label="Command palette"
        shortcut={IS_MAC ? '⌘K' : 'Ctrl+K'}
        onPick={() => uiStore.getState().togglePalette()}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="🎨"
        label="Themes"
        title="Pick a theme, or make your own"
        shortcut="›"
        onPick={onOpenThemes}
        onClose={onClose}
        keepOpen
      />
      <AppMenuItem
        glyph="⚙"
        label="Settings"
        shortcut={IS_MAC ? '⌘,' : 'Ctrl+,'}
        onPick={() => uiStore.getState().openSettings()}
        onClose={onClose}
      />
      <AppMenuDivider />
      {/* Both rows toggle: picking the stage you are already in returns to
          normal, so the ✓ reads as a switch rather than a destination. */}
      <AppMenuItem
        glyph={stage === 'window' ? '✓' : '⤢'}
        label={isAndroid() ? 'Full screen' : 'Full window'}
        title="Hide the app chrome and show only the document"
        onPick={() => setFullscreen(stage === 'window' ? 'normal' : 'window')}
        onClose={onClose}
      />
      {/* Android's window already fills the screen — the OS stage would look
          identical to the chrome-hiding one (see ui/fullscreen.ts). */}
      {!isAndroid() && (
        <AppMenuItem
          glyph={stage === 'screen' ? '✓' : '⛶'}
          label="Full screen"
          title="Hide the app chrome and make the window fullscreen"
          shortcut={IS_MAC ? '⌃⌘F' : 'F11'}
          onPick={() => setFullscreen(stage === 'screen' ? 'normal' : 'screen')}
          onClose={onClose}
        />
      )}
      <AppMenuDivider />
      <AppMenuItem
        glyph="⊗"
        label="Close all tabs"
        disabled={count === 0}
        onPick={closeAllTabs}
        onClose={onClose}
      />
    </>
  );
}

/**
 * The bar menu's New tab page — the same choices as the "+" button's picker
 * (components: `NewTabMenu`), as a drill-in page so the whole bar menu stays
 * one panel under a finger as well as a mouse.
 */
function NewTabPage({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const profiles = useSettingsStore((s) => s.settings.terminalProfiles);

  return (
    <>
      <AppMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <AppMenuDivider />
      <AppMenuItem
        glyph="📝"
        label="Markdown note"
        onPick={() => runNewTabChoice('note')}
        onClose={onClose}
      />
      <AppMenuItem
        glyph="✎"
        label="Vector drawing (.svg)"
        onPick={() => runNewTabChoice('drawing')}
        onClose={onClose}
      />
      {/* Android has no pty, so the whole terminal section is absent there. */}
      {terminalsAvailable() &&
        (profiles.length > 1 ? (
          <>
            <div className="app-menu-heading">Terminal</div>
            {profiles.map((profile) => (
              <AppMenuItem
                key={profile.id}
                glyph="❯"
                label={profile.name}
                onPick={() => openTerminal(profile.id)}
                onClose={onClose}
              />
            ))}
          </>
        ) : (
          <AppMenuItem
            glyph="❯"
            label="Terminal"
            onPick={() => runNewTabChoice('terminal')}
            onClose={onClose}
          />
        ))}
    </>
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
  // A clipped tab has lost its stripe with its rect — the dot carries the
  // workspace cue into the list so the switcher reads like the strip.
  const colors = tabs.map((tab) => workspaceCueFor(tab)?.color ?? null);
  useMenuDismiss(onClose);

  return (
    <div
      className="tab-menu tab-overflow-menu"
      role="menu"
      // Right-aligned under the button so it never runs off the window edge.
      style={{ right: window.innerWidth - anchor.right, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {tabs.map((tab, index) => (
        <div key={tab.id} className="tab-overflow-row" data-color={colors[index] ?? undefined}>
          <button
            className="tab-menu-item tab-overflow-item"
            role="menuitem"
            title={tab.filePath ?? undefined}
            onClick={() => {
              tabsStore.getState().activateTab(tab.id);
              onClose();
            }}
          >
            {colors[index] && <span className="tab-workspace-dot" />}
            <OverflowLabel tab={tab} />
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
  useMenuDismiss(onClose);

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
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // Read for reactivity: the cues below come from these two settings, and the
  // strip has to repaint when a workspace is recolored, added, or removed.
  useSettingsStore((s) => s.settings.workspaces);
  useSettingsStore((s) => s.settings.defaultWorkspaceColor);
  const barRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  /** Where the bar's own (empty-space) context menu is open, if at all. */
  const [barMenu, setBarMenu] = useState<{ x: number; y: number } | null>(null);
  const [overflowAnchor, setOverflowAnchor] = useState<DOMRect | null>(null);
  /** Ids of the tabs the strip is currently cutting off, in strip order. */
  const [clipped, setClipped] = useState<readonly string[]>([]);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  /** True between pointerdown on a tab and its release — freezes strip auto-scroll. */
  const pressingRef = useRef(false);
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

  const measuredScrollLeft = useRef(0);
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
    // Measure at the strip's NATURAL width: the cap below narrows the element
    // itself, so measuring the capped box would pin it there for good — the
    // window could grow and the strip would never notice the new room.
    // Uncapping momentarily widens the box, which clamps scrollLeft down when
    // the strip is scrolled near its end — remember it so it can be restored.
    const scrollLeftBefore = scroller.scrollLeft;
    scroller.style.maxWidth = '';
    const strip = scroller.getBoundingClientRect();
    const items: StripItemRect[] = [];
    for (const node of scroller.children) {
      const el = node as HTMLElement;
      const tabId = el.dataset.stripTab ?? null;
      if (tabId === null) {
        continue; // the drop indicator
      }
      const box = el.getBoundingClientRect();
      items.push({ tabId, left: box.left, right: box.right });
    }
    // End the strip on a tab boundary — a tab sliced down the middle reads as
    // a rendering glitch, and the ›N button already says what is off screen.
    // The sliced tab was clipped either way, so the overflow list is unchanged.
    const cap = wholeTabsWidth(strip.width, items);
    scroller.style.maxWidth = cap === null ? '' : `${cap}px`;
    if (scroller.scrollLeft !== scrollLeftBefore) {
      scroller.scrollLeft = scrollLeftBefore;
    }
    measuredScrollLeft.current = scrollLeftBefore;
    const hidden = clippedTabIds(strip, items);
    setClipped((prev) => (sameIds(prev, hidden) ? prev : hidden));
  }, []);

  // The clamp-and-restore above nets out to an unchanged position but still
  // fires a scroll event; re-measuring on it would loop forever at the strip's
  // end. Only a scroll that actually moved the strip re-measures.
  const onStripScroll = useCallback(() => {
    if (scrollerRef.current && scrollerRef.current.scrollLeft === measuredScrollLeft.current) {
      return;
    }
    measure();
  }, [measure]);

  // Re-measure on everything that can change the answer: which tabs there are
  // and what they're called (a title sets a width, and a renamed tab can push
  // another off), the strip's own size, and scrolling it (wired to onScroll).
  const layoutKey = tabs.map((t) => `${t.id}\u0001${tabDisplayTitle(t)}`).join('\u0000');
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
  const scrollActiveIntoView = useCallback(() => {
    const scroller = scrollerRef.current;
    const id = tabsStore.getState().activeTabId;
    if (!scroller || !id) {
      return;
    }
    for (const node of scroller.children) {
      if ((node as HTMLElement).dataset.stripTab === id) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
    }
  }, []);

  // ...but never while a tab press is in flight. Clicking a partially clipped
  // tab activates it, and scrolling the strip then slides every tab out from
  // under a stationary cursor: the press is still live, so the smallest jitter
  // promotes it to a drag whose drop target is whatever tab slid under the
  // pointer — releasing swapped two tabs the user only meant to click. The
  // deferred scroll runs on release instead (see onDragPress).
  useEffect(() => {
    if (pressingRef.current) {
      return;
    }
    scrollActiveIntoView();
  }, [activeTabId, layoutKey, scrollActiveIntoView]);

  /* ---- Pointer drag: reorder / tear-off -------------------------------- */

  function updateDropHint(ev: PointerEvent, movedId: string): void {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const scroller = scrollerRef.current;
    if (!under || !scroller) {
      dropTargetRef.current = null;
      setDropHint(null);
      return;
    }
    const sRect = scroller.getBoundingClientRect();
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
      setDropHint((prev) => (prev && prev.x === x ? prev : { x }));
      return;
    }
    if (barRef.current?.contains(under)) {
      // Over the bar but past the tabs (spacer / empty right area) → end.
      dropTargetRef.current = { type: 'end' };
      const last = scroller.lastElementChild;
      const x = last ? last.getBoundingClientRect().right - sRect.left + scroller.scrollLeft : 0;
      setDropHint((prev) => (prev && prev.x === x ? prev : { x }));
      return;
    }
    dropTargetRef.current = null;
    setDropHint(null);
  }

  /** Turn the semantic drop target into a store reorder. */
  function applyDrop(movedId: string, target: DropTarget): void {
    const s = tabsStore.getState();
    const rest = s.tabs.filter((t) => t.id !== movedId);
    if (target.type === 'end') {
      s.reorderTab(movedId, rest.length);
      return;
    }
    const base = rest.findIndex((t) => t.id === target.tabId);
    if (base < 0) {
      return;
    }
    // With workspace arranging on, the store snaps the landing spot back into
    // the tab's own run; otherwise the tab simply lands where it was dropped.
    s.reorderTab(movedId, target.type === 'before' ? base : base + 1);
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
    pressingRef.current = true;

    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      el.classList.remove('tab-dragging');
      setDropHint(null);
      pressingRef.current = false;
      // The scroll the press suppressed: bring the now-active tab fully into
      // view once the pointer is no longer riding on top of the strip.
      scrollActiveIntoView();
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

  // Each tab's workspace decides its color and which run it flows into. The
  // cue is derived on every render rather than stored: recoloring a workspace
  // or moving a file must repaint the strip, and the two settings read above
  // are what make that re-render happen.
  const cues = tabs.map((tab) => workspaceCueFor(tab));
  const runs = computeWorkspaceRuns(
    tabs.map((tab, i) => ({ id: tab.id, workspaceKey: cues[i]?.key ?? null })),
  );
  const items: StripItem[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.count; i++) {
      const index = run.start + i;
      items.push({
        tab: tabs[index]!,
        color: cues[index]?.color ?? null,
        workspaceKey: run.workspaceKey,
        // A lone tab is both ends of its own run, which is what keeps its
        // corners rounded on both sides.
        runStart: i === 0,
        runEnd: i === run.count - 1,
      });
    }
  }

  // EVERY item renders; the strip shrinks them and then scrolls. What is
  // currently cut off is measured, not computed — see `measure` above.
  const clippedSet = new Set(clipped);
  const hidden = items.map((it) => it.tab).filter((tab) => clippedSet.has(tab.id));

  return (
    // data-tauri-drag-region only fires on the element itself, never its
    // children — so empty bar space drags/double-click-maximizes the window
    // while tabs and buttons keep their own interactions.
    <div
      ref={barRef}
      className={IS_MAC ? 'tabbar tabbar-mac' : 'tabbar'}
      role="tablist"
      data-tauri-drag-region=""
      onContextMenu={(e) => {
        // Free space only — a tab (or a button) opens its own menu and its
        // event merely bubbles through here.
        if ((e.target as HTMLElement).closest('.tab, button, .tab-menu')) {
          return;
        }
        e.preventDefault();
        setMenu(null);
        setBarMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* The scroller is only as wide as its tabs, so the free space after the
          last tab lives in `.tabbar-spacer`, which carries the drag region.
          Keep data-tauri-drag-region here too: it fires only on the element
          itself, so any slack inside the strip still drags the window. */}
      <div
        className="tabbar-scroller"
        ref={scrollerRef}
        onScroll={onStripScroll}
        data-tauri-drag-region=""
      >
        {items.map((item) => (
          <Tab
            key={item.tab.id}
            tab={item.tab}
            active={item.tab.id === activeTabId}
            color={item.color}
            workspaceKey={item.workspaceKey}
            runStart={item.runStart}
            runEnd={item.runEnd}
            onMenu={(tabId, x, y) => setMenu({ tabId, x, y })}
            onDragPress={onDragPress}
          />
        ))}
        {dropHint !== null && <div className="tab-drop-indicator" style={{ left: dropHint.x }} />}
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
            // The button's own pointerdown stops the menu's dismiss handler,
            // so a plain click while it is open has to close it itself.
            uiStore.getState().closeNewTabMenu();
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
      {!IS_MAC && !isAndroid() && <WindowControls />}
      {menu && <TabContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {barMenu && <BarContextMenu at={barMenu} onClose={() => setBarMenu(null)} />}
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
