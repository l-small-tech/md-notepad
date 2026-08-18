/**
 * Ribbon — a toolbar between the tabs and the editor.
 *
 * Layout: the panel toggles bookend the row on the side their panel opens —
 * explorer (◧) leftmost, outline (◨) rightmost. Next to the explorer sits the
 * ☰ app menu (search / palette / export / copy raw / settings), keeping the
 * one-shot commands out of the toolbar, and then Save — which is also the
 * auto-save indicator, so it lives with the chrome that every mode shows. The
 * center is a mode-dependent cluster; fullscreen stays as a direct button on
 * the right. Its background is
 * `var(--bg)`, matching the active tab, so the selected tab appears to flow
 * down into the ribbon as one continuous surface (the tabbar drops its bottom
 * border for this to read).
 *
 * The center swaps with the active tab's mode: edit modes get the formatting
 * controls (inline styles · block styles · links), which drive the CM6 source
 * editor via `editor-registry` (the file/image link buttons go one hop further
 * through `session` for the native file picker). READ mode has nothing to edit,
 * so the center becomes a display toolset (text zoom) instead. In WYSIWYG mode
 * there is no source editor, so formatting posts a notice (Crepe carries its
 * own inline toolbar there).
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FormatAction } from '../../editors/cm6';
import { appendMentions } from '../../core/link-mentions';
import { dirName } from '../../core/session/plan-flush';
import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings';
import { getSourceAdapter } from '../editor-registry';
import { detectPlatform } from '../keymap';
import { isAndroid } from '../platform';
import { setFullscreen } from '../fullscreen';
import { insertFileLink, openExportPreview, saveActiveTab, saveActiveTabAs } from '../session';
import { addCommentAtLine, openAllComments } from '../voice-comments';
import {
  canRevealThemesFolder,
  newTheme,
  openThemesFolder,
  openThemesHelp,
  reloadThemes,
  selectTheme,
  unpinThemeFromWindow,
} from '../theme-actions';
import {
  FONT_FAMILIES,
  PALETTE,
  paletteSlot,
  STATIC_PALETTE,
  STROKE_WIDTHS,
  TEXT_SIZES,
  THEMED_SLOT_NAMES,
  type DrawTool,
} from '../../core/whiteboard/tool-settings';
// Also a dependency-free leaf (the same I8 constraint tool-settings is under):
// the ribbon needs the finger-toggle's resolution rule, nothing more.
import { fingerDrawsEnabled } from '../../core/whiteboard/input';
import { getWhiteboardAdapter, useWhiteboardStore, whiteboardStore } from '../stores/whiteboard';
import { searchStore } from '../stores/search';
import { settingsStore, useSettingsStore } from '../stores/settings';
import { currentThemeValue, themePickerGroups, useThemeRegistry } from '../stores/theme-registry';
import { useWindowTheme } from '../stores/window-theme';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import { goBackPreview, usePreviewNav } from '../stores/preview-nav';

const IS_MAC = detectPlatform(navigator.platform) === 'mac';

/** Whether this machine has a touchscreen — gates the board's touch policy. */
const HAS_TOUCH = navigator.maxTouchPoints > 0;

/** Platform-correct shortcut hint for the fullscreen tooltips. */
const FULLSCREEN_KEY = IS_MAC ? '⌃⌘F' : 'F11';

/**
 * Tooltip for the ribbon's fullscreen button. Desktop has two stages (hide
 * chrome, then OS fullscreen); Android has a single distraction-free stage.
 */
const FULLSCREEN_TITLE = isAndroid()
  ? 'Full screen — hide the app chrome'
  : `Full window — hide the app chrome (${FULLSCREEN_KEY}; press again for full screen)`;

function applyFormat(action: FormatAction): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    return;
  }
  if (tab.mode === 'wysiwyg' || tab.mode === 'draw') {
    uiStore.getState().showNotice('Formatting controls work in Markdown and Split modes.');
    return;
  }
  getSourceAdapter(tab.id)?.format(action);
}

/**
 * Adjust the shared editor/preview font size (the `--editor-font-size` CSS
 * variable both the source editor and the preview read). `'reset'` returns to
 * the default; a numeric step nudges it within the allowed range. This is the
 * read-mode "zoom", and mirrors the mod +/-/0 keyboard shortcuts.
 */
function zoom(step: number | 'reset'): void {
  const current = settingsStore.getState().settings.fontSize;
  const next =
    step === 'reset'
      ? DEFAULT_SETTINGS.fontSize
      : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + step));
  settingsStore.getState().update({ fontSize: next });
}

/**
 * Line-art ribbon glyphs.
 *
 * The link / attach / image / comment buttons used to be emoji (🔗 📎 🖼 💬),
 * which the OS renders in full colour at its own weight — beside the flat
 * monochrome B / I / H of the rest of the strip they read as stickers. These
 * are the same 20-unit, 1.4-weight `currentColor` outlines as the explorer and
 * outline toggles, so the whole toolbar is one drawing.
 */
function RibbonIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="ribbon-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Two chain links — a hyperlink. */
const LinkIcon = (
  <RibbonIcon>
    <path d="M8.4 11.6a3 3 0 0 0 4.3 0l2.6-2.6a3 3 0 0 0-4.3-4.3l-1.3 1.3" />
    <path d="M11.6 8.4a3 3 0 0 0-4.3 0l-2.6 2.6a3 3 0 0 0 4.3 4.3l1.3-1.3" />
  </RibbonIcon>
);

/** A paperclip — attach a file. */
const AttachIcon = (
  <RibbonIcon>
    <path d="M14.6 9.3l-5.2 5.2a3 3 0 0 1-4.2-4.2l6-6a2.1 2.1 0 0 1 3 3l-6 6a1.1 1.1 0 0 1-1.6-1.6l5.2-5.2" />
  </RibbonIcon>
);

/** A framed picture with a hill and a sun. */
const ImageIcon = (
  <RibbonIcon>
    <rect x="3" y="4.5" width="14" height="11" rx="1.6" />
    <circle cx="7.4" cy="8.4" r="1.2" />
    <path d="M3.4 13.6l3.8-3.4 3.1 2.7 2.3-1.9 4 3.5" />
  </RibbonIcon>
);

/** A speech bubble — a voice comment. */
const CommentIcon = (
  <RibbonIcon>
    <path d="M16.5 11.3a1.8 1.8 0 0 1-1.8 1.8H8.2L5 15.8v-2.7h-.2a1.8 1.8 0 0 1-1.3-1.8V6a1.8 1.8 0 0 1 1.8-1.8h9.4A1.8 1.8 0 0 1 16.5 6z" />
  </RibbonIcon>
);

/** A floppy disk — save. The manual-mode save button. */
const SaveIcon = (
  <RibbonIcon>
    <path d="M3.5 4.8A1.3 1.3 0 0 1 4.8 3.5h8.1l3.6 3.6v8.1a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3z" />
    <path d="M6.8 3.5v3.6h5.4V3.5" />
    <path d="M6.3 16.5v-4.4h7.4v4.4" />
  </RibbonIcon>
);

/**
 * The same floppy wearing a circular-arrow badge — auto save. It is the ribbon's
 * auto-save INDICATOR as much as its button, so the difference has to survive a
 * glance at 16px: a badge outside the crowded body reads where a change inside
 * it would not, and `[data-auto]` tints the whole glyph with the accent. The
 * badge is knocked out of the body with a `--bg` disc so the two don't merge.
 */
const SaveAutoIcon = (
  <RibbonIcon>
    <path d="M3.5 4.8A1.3 1.3 0 0 1 4.8 3.5h8.1l3.6 3.6v8.1a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3z" />
    <path d="M6.8 3.5v3.6h5.4V3.5" />
    <circle cx="14.8" cy="14.8" r="4.4" fill="var(--bg)" stroke="none" />
    <path d="M12.2 14.8a2.6 2.6 0 1 0 0.9-2" />
    <path d="M13.6 10.6l-0.5 2.3 2.3-0.4" />
  </RibbonIcon>
);

/**
 * Copy the active tab's raw markdown to the clipboard, with an appended block of
 * Claude-Code-CLI `@path` mentions for every local file/image it links to.
 * Relative link paths are auto-resolved to absolute against the document's own
 * directory so the CLI can find them regardless of where it was launched.
 */
/**
 * Start a voice comment anchored to the caret's line (desktop entry point; on
 * mobile a long-press on the line does this). Gated out of WYSIWYG like the
 * formatting controls — anchor tokens live in the CM6 source, and a rich-mode
 * re-serialize could drop them.
 */
function addVoiceCommentAtCaret(): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    return;
  }
  if (tab.mode === 'wysiwyg' || tab.mode === 'draw') {
    uiStore.getState().showNotice('Voice comments work in Markdown and Split modes.');
    return;
  }
  const adapter = getSourceAdapter(tab.id);
  if (!adapter) {
    return;
  }
  void addCommentAtLine(tab.id, adapter.anchorLineAt());
}

/** Open the voice-comments panel for the active tab (read-mode entry point). */
function openVoiceComments(): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (tab) {
    void openAllComments(tab.id);
  }
}

function copyRawText(): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    return;
  }
  const baseDir = dirName(tab.filePath ?? tab.notePath ?? '');
  const { text, count } = appendMentions(tab.model.getText(), baseDir);
  const done =
    count > 0
      ? `Copied raw text + ${count} file ${count === 1 ? 'mention' : 'mentions'} (@paths).`
      : 'Copied raw text to clipboard.';
  void navigator.clipboard
    .writeText(text)
    .then(() => uiStore.getState().showNotice(done))
    .catch(() => uiStore.getState().showNotice('Could not access the clipboard.'));
}

/** One row of the ☰ app menu: glyph + label, optional right-aligned shortcut. */
function RibbonMenuItem({
  glyph,
  label,
  shortcut,
  title,
  onPick,
  onSecondaryPick,
  onClose,
  keepOpen,
}: {
  glyph: string;
  label: string;
  shortcut?: string;
  title?: string;
  onPick: () => void;
  /** Right-click variant of the row's action (theme rows: this window only).
   *  Rows that don't set it keep the browser's default context menu. */
  onSecondaryPick?: () => void;
  onClose: () => void;
  /** Drill-in / back rows stay open — they navigate within the popover. */
  keepOpen?: boolean;
}) {
  return (
    <button
      className="tab-menu-item ribbon-menu-item"
      role="menuitem"
      title={title}
      onClick={() => {
        if (!keepOpen) {
          onClose();
        }
        onPick();
      }}
      onContextMenu={
        onSecondaryPick &&
        ((e) => {
          e.preventDefault();
          if (!keepOpen) {
            onClose();
          }
          onSecondaryPick();
        })
      }
    >
      <span>
        <span className="ribbon-menu-glyph">{glyph}</span>
        {label}
      </span>
      {shortcut && <span className="ribbon-menu-shortcut">{shortcut}</span>}
    </button>
  );
}

/**
 * The Themes submenu — every installed theme (same grouping and order as the
 * Settings dropdown, ✓ on the current one), then the folder actions that used
 * to live in Settings: Open folder / New theme… / Reload, plus Help, which
 * opens the bundled themes guide.
 *
 * It's a drill-in page of the ☰ popover rather than a flyout: one panel works
 * the same under a mouse and a finger (Android has no hover), and the theme
 * list can be long.
 */
function ThemesSubmenu({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const plugins = useThemeRegistry((s) => s.plugins);
  const settings = useSettingsStore((s) => s.settings);
  const pinned = useWindowTheme((s) => s.override !== null);
  const current = currentThemeValue(settings);
  const groups = themePickerGroups(plugins);
  // Android runs a single webview — a per-window theme has nothing to be per
  // (and there is no right-click there either).
  const perWindow = !isAndroid();
  return (
    <>
      <RibbonMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <div className="ribbon-menu-divider" role="separator" />
      {/* Picking sets the theme for every window; right-clicking pins it here. */}
      {perWindow && (
        <>
          <div className="ribbon-menu-heading">Right-click: this window only</div>
          {pinned && (
            <RibbonMenuItem
              glyph="⌂"
              label="Use shared theme"
              title="Stop pinning a theme to this window and follow the all-windows theme again"
              onPick={unpinThemeFromWindow}
              onClose={onClose}
              keepOpen
            />
          )}
          <div className="ribbon-menu-divider" role="separator" />
        </>
      )}
      {groups.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <div className="ribbon-menu-divider" role="separator" />}
          {group.label !== null && <div className="ribbon-menu-heading">{group.label}</div>}
          {group.options.map((option) => (
            <RibbonMenuItem
              key={option.value}
              // The ✓ column is the glyph slot, so checked and unchecked rows
              // keep their labels aligned.
              glyph={option.value === current ? '✓' : ''}
              label={option.label}
              title={perWindow ? 'Set for all windows (right-click: this window only)' : undefined}
              onPick={() => selectTheme(option.value)}
              onSecondaryPick={perWindow ? () => selectTheme(option.value, true) : undefined}
              onClose={onClose}
              // Picking applies live — staying open lets the user try a few.
              keepOpen
            />
          ))}
        </Fragment>
      ))}
      <div className="ribbon-menu-divider" role="separator" />
      {canRevealThemesFolder() && (
        <RibbonMenuItem
          glyph="📂"
          label="Open folder"
          title="Show the themes folder in your file manager"
          onPick={() => void openThemesFolder()}
          onClose={onClose}
        />
      )}
      <RibbonMenuItem
        glyph="✚"
        label="New theme…"
        title="Create a starter theme file, select it, and reveal it"
        onPick={() => void newTheme()}
        onClose={onClose}
      />
      <RibbonMenuItem
        glyph="⟲"
        label="Reload"
        title="Re-read the themes folder after editing or adding files"
        onPick={() => void reloadThemes()}
        onClose={onClose}
      />
      <RibbonMenuItem
        glyph="?"
        label="Help"
        title="How to create your own theme"
        onPick={openThemesHelp}
        onClose={onClose}
      />
    </>
  );
}

/**
 * The ☰ app menu — one-shot commands that don't earn a toolbar slot. Same
 * fixed-position popover pattern as the tab bar's OverflowMenu, but
 * left-aligned under its trigger (the button sits near the window's left edge).
 */
function RibbonMenu({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const [page, setPage] = useState<'root' | 'themes'>('root');
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
      className="tab-menu ribbon-menu"
      role="menu"
      style={{ left: anchor.left, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {page === 'themes' ? (
        <ThemesSubmenu onBack={() => setPage('root')} onClose={onClose} />
      ) : (
        <RootMenuPage onOpenThemes={() => setPage('themes')} onClose={onClose} />
      )}
    </div>
  );
}

/** The ☰ menu's top level. */
function RootMenuPage({
  onOpenThemes,
  onClose,
}: {
  onOpenThemes: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <RibbonMenuItem
        glyph="🔍"
        label="Search workspaces"
        shortcut={IS_MAC ? '⇧⌘F' : 'Ctrl+Shift+F'}
        onPick={() => searchStore.getState().openSearch()}
        onClose={onClose}
      />
      {/* The menu is the palette's only entry point on Android (no Ctrl+K
          there), and a discoverable one on desktop. */}
      <RibbonMenuItem
        glyph="»"
        label="Command palette"
        shortcut={IS_MAC ? '⌘K' : 'Ctrl+K'}
        onPick={() => uiStore.getState().togglePalette()}
        onClose={onClose}
      />
      <RibbonMenuItem
        glyph="⇩"
        label="Export…"
        title="Export as PDF, DOCX or HTML — opens a themed preview"
        onPick={() => openExportPreview()}
        onClose={onClose}
      />
      <RibbonMenuItem
        glyph="⧉"
        label="Copy all raw text"
        title="Copy raw text (+ @path mentions for linked files, for the Claude Code CLI)"
        onPick={copyRawText}
        onClose={onClose}
      />
      <div className="ribbon-menu-divider" role="separator" />
      <RibbonMenuItem
        glyph="🎨"
        label="Themes"
        title="Pick a theme, or make your own"
        shortcut="›"
        onPick={onOpenThemes}
        onClose={onClose}
        keepOpen
      />
      <RibbonMenuItem
        glyph="⚙"
        label="Settings"
        shortcut={IS_MAC ? '⌘,' : 'Ctrl+,'}
        onPick={() => uiStore.getState().openSettings()}
        onClose={onClose}
      />
    </>
  );
}

/** How long the save button has to be held before its options menu opens. */
const SAVE_HOLD_MS = 500;
/** How far the contact may wander during that hold and still count as a press. */
const SAVE_HOLD_SLOP_PX = 10;

/**
 * The save button — and the auto-save indicator.
 *
 * One control says two things. Its glyph is the mode (plain floppy = you save;
 * badged floppy = the app saves), and a click always saves right now, in either
 * mode — an explicit save under auto save is harmless and is what a hand
 * reaching for Ctrl+S expects. The mode toggle lives behind a HOLD rather than
 * a second button because switching it is rare and switching it by accident is
 * not: an auto-save mode you flipped without noticing quietly changes what your
 * files do. Right-click opens the same menu, since a mouse user has no reason
 * to guess that a toolbar button can be held.
 *
 * Disabled for tabs with nothing to write (image/import viewers, read-only
 * documents). A NOTE tab stays enabled: saving one is Save As, which is how the
 * command and Ctrl+S already behave.
 */
function SaveControl() {
  const liveSave = useSettingsStore((s) => s.settings.liveSave);
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOrigin = useRef<{ x: number; y: number } | null>(null);
  // A hold that opened the menu must not also fire the button's click on
  // release — the finger that summoned the menu would save on the way out.
  const suppressClick = useRef(false);

  const savable = !!tab && tab.kind !== 'image' && tab.kind !== 'import' && !tab.readOnly;
  const dirty = tab?.kind === 'file' && tab.dirty;

  const cancelHold = (): void => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    holdOrigin.current = null;
  };
  useEffect(() => cancelHold, []);

  const title = liveSave
    ? 'Auto save is ON — changes save themselves. Click to save now; hold or right-click for options.'
    : `Save (${IS_MAC ? '⌘S' : 'Ctrl+S'}) — hold or right-click for auto-save options.`;

  return (
    <>
      <button
        className="ribbon-btn ribbon-btn-lg ribbon-save"
        aria-label={liveSave ? 'Save now (auto save is on)' : 'Save'}
        aria-haspopup="menu"
        aria-expanded={menuAnchor != null}
        data-auto={liveSave || undefined}
        data-dirty={dirty || undefined}
        title={title}
        disabled={!savable}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          // No stopPropagation here (unlike the ☰ trigger): this press opens
          // nothing yet, so letting it reach the window lets an already-open
          // popover — the ☰ menu, or this button's own — dismiss normally. The
          // menu appears 500 ms later, by which time the press is long over.
          cancelHold();
          if (e.pointerType === 'mouse' && e.button !== 0) {
            return; // right-click has its own path (onContextMenu)
          }
          const rect = e.currentTarget.getBoundingClientRect();
          holdOrigin.current = { x: e.clientX, y: e.clientY };
          holdTimer.current = setTimeout(() => {
            cancelHold();
            suppressClick.current = true;
            setMenuAnchor(rect);
          }, SAVE_HOLD_MS);
        }}
        onPointerMove={(e) => {
          const at = holdOrigin.current;
          if (
            at &&
            (Math.abs(e.clientX - at.x) > SAVE_HOLD_SLOP_PX ||
              Math.abs(e.clientY - at.y) > SAVE_HOLD_SLOP_PX)
          ) {
            cancelHold();
          }
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => {
          e.preventDefault();
          cancelHold();
          setMenuAnchor(e.currentTarget.getBoundingClientRect());
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          saveActiveTab();
        }}
      >
        {liveSave ? SaveAutoIcon : SaveIcon}
      </button>
      {menuAnchor && (
        <SaveMenu anchor={menuAnchor} liveSave={liveSave} onClose={() => setMenuAnchor(null)} />
      )}
    </>
  );
}

/** The save button's hold menu: the auto-save toggle, plus Save as…. */
function SaveMenu({
  anchor,
  liveSave,
  onClose,
}: {
  anchor: DOMRect;
  liveSave: boolean;
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
      className="tab-menu ribbon-menu"
      role="menu"
      aria-label="Save options"
      style={{ left: anchor.left, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <RibbonMenuItem
        glyph={liveSave ? '✓' : ''}
        label="Auto save"
        title="Save opened files automatically as you type, without Ctrl+S"
        onPick={() => {
          const next = !liveSave;
          settingsStore.getState().update({ liveSave: next });
          uiStore.getState().showNotice(next ? 'Auto save is on.' : 'Auto save is off.');
        }}
        onClose={onClose}
      />
      <div className="ribbon-menu-divider" role="separator" />
      <RibbonMenuItem
        glyph="⤓"
        label="Save as…"
        shortcut={IS_MAC ? '⇧⌘S' : 'Ctrl+Shift+S'}
        onPick={() => saveActiveTabAs()}
        onClose={onClose}
      />
    </div>
  );
}

function RibbonButton({
  action,
  label,
  title,
}: {
  action: FormatAction;
  label: ReactNode;
  title: string;
}) {
  return (
    <button
      className="ribbon-btn"
      aria-label={title}
      title={title}
      // Keep the editor's selection visible — don't let the button grab focus
      // on press; the format command refocuses the editor afterward.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => applyFormat(action)}
    >
      {label}
    </button>
  );
}

/** Center cluster for the edit modes: inline styles · block styles · links. */
function FormatControls() {
  return (
    <div className="ribbon-center">
      <RibbonButton action="bold" title="Bold" label={<strong>B</strong>} />
      <RibbonButton action="italic" title="Italic" label={<em>I</em>} />
      <RibbonButton
        action="strikethrough"
        title="Strikethrough"
        label={<span className="ribbon-strike">S</span>}
      />
      <RibbonButton action="codeBlock" title="Code block" label={<code>&lt;/&gt;</code>} />

      <span className="ribbon-divider" role="separator" />

      <RibbonButton action="heading" title="Heading (cycles H1–H3)" label="H" />
      <RibbonButton action="quote" title="Blockquote" label="❝" />
      <RibbonButton action="bulletList" title="Bulleted list" label="•" />
      <RibbonButton action="orderedList" title="Numbered list" label="1." />

      <span className="ribbon-divider" role="separator" />

      <RibbonButton action="link" title="Link (text + URL)" label={LinkIcon} />
      <button
        className="ribbon-btn"
        aria-label="Link to a file"
        title="Link to a file — click for an absolute path, Alt+click for relative"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => insertFileLink({ image: false, absolute: !e.altKey })}
      >
        {AttachIcon}
      </button>
      <button
        className="ribbon-btn"
        aria-label="Insert an image"
        title="Insert an image — click for an absolute path, Alt+click for relative"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => insertFileLink({ image: true, absolute: !e.altKey })}
      >
        {ImageIcon}
      </button>

      <span className="ribbon-divider" role="separator" />

      <button
        className="ribbon-btn"
        aria-label="Add a voice comment"
        title="Add a voice comment on the current line"
        onMouseDown={(e) => e.preventDefault()}
        onClick={addVoiceCommentAtCaret}
      >
        {CommentIcon}
      </button>
    </div>
  );
}

/**
 * Center cluster for DRAW mode — the whiteboard's toolbar.
 *
 * The ribbon IS the draw toolbar (a Phase 1 QA decision): the same strip that
 * shows bold/italic for markdown swaps to pen/highlighter/eraser/shapes here,
 * so there is one toolbar to learn and the whole pane stays board. Tool,
 * colour and width live in the whiteboard store (global — the marker you picked
 * is still picked on the next board); undo and the layers panel are per-tab and
 * go through the adapter registry.
 */
function DrawControls({ tabId }: { tabId: string | null }) {
  const tool = useWhiteboardStore((s) => s.tool);
  const color = useWhiteboardStore((s) => s.color);
  const width = useWhiteboardStore((s) => s.width);
  const paletteKind = useWhiteboardStore((s) => s.paletteKind);
  const fingerDrawsPref = useWhiteboardStore((s) => s.fingerDraws);
  const penSeen = useWhiteboardStore((s) => s.penSeen);
  const tabState = useWhiteboardStore((s) => (tabId !== null ? s.byTab[tabId] : undefined));
  const fingerDraws = fingerDrawsEnabled(fingerDrawsPref, penSeen);
  const fontSize = useWhiteboardStore((s) => s.fontSize);
  const fontFamily = useWhiteboardStore((s) => s.fontFamily);
  // The type row shows for the text tool, and whenever a selection could
  // contain text to restyle.
  const typeControls = tool === 'text' || (tool === 'select' && !!tabState?.selectionCount);
  const adapter = tabId !== null ? getWhiteboardAdapter(tabId) : undefined;
  // Themed slots preview through their --wb-* var; static/custom stay literal.
  const colorSlot = paletteSlot(color);
  const nibColor = colorSlot < 0 ? color : `var(--wb-c${colorSlot}, ${color})`;
  const themedRow = paletteKind === 'themed';

  function toolButton(id: DrawTool, label: ReactNode, title: string) {
    return (
      <button
        className="ribbon-btn"
        aria-label={title}
        aria-pressed={tool === id}
        data-active={tool === id || undefined}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          whiteboardStore.getState().setTool(id);
          // The adapter pulls tool settings per gesture; what it needs told is
          // the between-gesture chrome (cursor, selection handles).
          adapter?.refreshTool();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="ribbon-center ribbon-center-draw">
      {toolButton('select', '⬚', 'Select — drag to move, handles to resize, Delete to remove')}
      {toolButton('pen', '✎', 'Pen')}
      {toolButton('highlighter', '▤', 'Highlighter')}
      {toolButton('eraser', '⌫', 'Eraser — removes a whole stroke')}
      {toolButton(
        'text',
        'T',
        'Text — click to type, Enter for a new line, Ctrl/Cmd+Enter to finish',
      )}

      <span className="ribbon-divider" role="separator" />

      {toolButton('rect', '▭', 'Rectangle')}
      {toolButton('ellipse', '◯', 'Ellipse')}
      {toolButton('line', '╱', 'Line')}
      {toolButton('arrow', '➜', 'Arrow')}

      <span className="ribbon-divider" role="separator" />

      <button
        className="ribbon-btn"
        aria-label={themedRow ? 'Switch to static colours' : 'Switch to theme colours'}
        title={
          themedRow
            ? 'Theme colours — ink follows the app/OS theme. Click for static colours.'
            : 'Static colours — ink stays exactly this colour everywhere. Click for theme colours.'
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => whiteboardStore.getState().setPaletteKind(themedRow ? 'static' : 'themed')}
      >
        {themedRow ? 'Auto' : 'Fixed'}
      </button>

      <div className="ribbon-swatches" role="group" aria-label="Ink colour">
        {/* The themed row renders through the --wb-* slot vars (phase 2.5) so
            the picker shows the ink the CURRENT theme will actually draw —
            hence role names, not hue names, on its tooltips; the static row is
            named colours, shown (and saved) literally. */}
        {(themedRow ? PALETTE : STATIC_PALETTE).map((swatch, slot) => {
          const name = themedRow ? (THEMED_SLOT_NAMES[slot] ?? swatch) : swatch;
          return (
            <button
              key={swatch}
              className="ribbon-swatch"
              style={{ background: themedRow ? `var(--wb-c${slot}, ${swatch})` : swatch }}
              aria-label={`Colour ${name}`}
              aria-pressed={color === swatch}
              data-active={color === swatch || undefined}
              title={name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => whiteboardStore.getState().setColor(swatch)}
            />
          );
        })}
      </div>

      {/* Type controls replace the nib row for the text tool — a nib size says
          nothing useful about type, and both rows at once is clutter. They also
          restyle SELECTED text, so they act on what you are looking at. */}
      {typeControls ? (
        <div className="ribbon-swatches" role="group" aria-label="Text style">
          <select
            className="ribbon-select"
            aria-label="Font"
            title="Font"
            value={fontFamily}
            onMouseDown={(e) => e.preventDefault()}
            onChange={(e) => {
              whiteboardStore.getState().setFontFamily(e.target.value);
              adapter?.applyTextStyle({ fontFamily: e.target.value });
            }}
          >
            {FONT_FAMILIES.map((font) => (
              <option key={font.label} value={font.stack} style={{ fontFamily: font.stack }}>
                {font.label}
              </option>
            ))}
          </select>
          <select
            className="ribbon-select"
            aria-label="Text size"
            title="Text size"
            value={fontSize}
            onMouseDown={(e) => e.preventDefault()}
            onChange={(e) => {
              const size = Number(e.target.value);
              whiteboardStore.getState().setFontSize(size);
              adapter?.applyTextStyle({ fontSize: size });
            }}
          >
            {TEXT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* Not `hidden` — `.ribbon-swatches` sets `display:flex`, which beats the
          UA sheet's `[hidden]{display:none}`, so the nib row stayed on screen
          next to the type controls it was supposed to make room for. */}
      {!typeControls && (
        <div className="ribbon-swatches" role="group" aria-label="Stroke width">
          {STROKE_WIDTHS.map((size) => (
            <button
              key={size}
              className="ribbon-nib"
              aria-label={`Width ${size}`}
              aria-pressed={width === size}
              data-active={width === size || undefined}
              title={`Width ${size}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => whiteboardStore.getState().setWidth(size)}
            >
              {/* The dot is the nib at (a readable multiple of) its size. */}
              <span
                style={{ width: 3 + size * 1.5, height: 3 + size * 1.5, background: nibColor }}
              />
            </button>
          ))}
        </div>
      )}

      <span className="ribbon-divider" role="separator" />

      {/* Touch policy — what ONE FINGER does, and nothing else: a mouse and a
          pen always draw. Hidden without a touchscreen, because there it
          governs nothing, and a button that changes nothing you can see is
          worse than a missing one. The glyph shows the current ANSWER rather
          than the action, so the board's behaviour is readable at a glance. */}
      {HAS_TOUCH && (
        <button
          className="ribbon-btn"
          aria-label={fingerDraws ? 'One finger draws' : 'One finger pans'}
          aria-pressed={fingerDraws}
          data-active={fingerDraws || undefined}
          title={
            (fingerDraws
              ? 'Touch: one finger draws, two fingers pan and zoom.'
              : 'Touch: one finger pans and zooms — draw with a pen.') +
            (fingerDrawsPref === null
              ? penSeen
                ? ' (Automatic: a pen was detected.)'
                : ' (Automatic: no pen seen yet.)'
              : '') +
            (fingerDraws ? ' Click to pan instead.' : ' Click to draw instead.') +
            ' A mouse or pen is unaffected.'
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => whiteboardStore.getState().setFingerDraws(!fingerDraws)}
        >
          {fingerDraws ? '✍' : '✋'}
        </button>
      )}

      {/* Scan (phase 4). Sits next to the destructive/history cluster rather
          than among the tools because it is not a tool — it is an import, and
          it does not change what the pen does. */}
      {adapter?.canScan() && (
        <button
          className="ribbon-btn"
          aria-label="Scan a whiteboard"
          title={
            HAS_TOUCH
              ? 'Scan — photograph a physical whiteboard, straighten it, and add it to this drawing'
              : 'Scan — choose a photo of a physical whiteboard, straighten it, and add it to this drawing. You can also paste or drop an image onto the board.'
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => adapter.startScan()}
        >
          📷
        </button>
      )}

      <button
        className="ribbon-btn"
        aria-label="Delete selection"
        title="Delete the selection (Del)"
        disabled={!tabState?.selectionCount}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => adapter?.deleteSelection()}
      >
        🗑
      </button>

      <button
        className="ribbon-btn"
        aria-label="Undo"
        title="Undo (Ctrl/Cmd+Z)"
        disabled={!tabState?.canUndo}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => adapter?.undo()}
      >
        ↶
      </button>
      <button
        className="ribbon-btn"
        aria-label="Redo"
        title="Redo (Ctrl/Cmd+Shift+Z)"
        disabled={!tabState?.canRedo}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => adapter?.redo()}
      >
        ↷
      </button>
      <button
        className="ribbon-btn"
        aria-label="Layers"
        aria-pressed={tabState?.layersOpen ?? false}
        data-active={tabState?.layersOpen || undefined}
        title={
          tabState?.activeLayerName ? `Layers — drawing on "${tabState.activeLayerName}"` : 'Layers'
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => adapter?.toggleLayers()}
      >
        ☰▤
      </button>
    </div>
  );
}

/**
 * Center cluster for READ mode: a display toolset (text zoom). No text-editing
 * controls — reading is read-only — so the ribbon offers ways to change how the
 * text is shown instead. preventDefault on press keeps focus on the reading
 * pane so keyboard scrolling survives a zoom click.
 */
function ReaderControls() {
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  return (
    <div className="ribbon-center">
      <button
        className="ribbon-btn"
        aria-label="Zoom out"
        title="Zoom out (Ctrl/Cmd+-)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => zoom(-1)}
      >
        A−
      </button>
      <span className="ribbon-zoom" aria-live="polite" title="Text size">
        {fontSize}
      </span>
      <button
        className="ribbon-btn"
        aria-label="Zoom in"
        title="Zoom in (Ctrl/Cmd+=)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => zoom(1)}
      >
        A+
      </button>

      <button
        className="ribbon-btn"
        aria-label="Reset zoom"
        title="Reset text size (Ctrl/Cmd+0)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => zoom('reset')}
      >
        ⟲
      </button>

      <span className="ribbon-divider" role="separator" />

      <button
        className="ribbon-btn"
        aria-label="Voice comments"
        title="Voice comments — view, play, or add"
        onMouseDown={(e) => e.preventDefault()}
        onClick={openVoiceComments}
      >
        {CommentIcon}
      </button>
    </div>
  );
}

export function Ribbon() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode ?? 'raw');
  // Back appears only while browsing a followed link in the active tab's preview
  // (read/split). It sits with the chrome, so full screen (which hides the
  // ribbon) uses the floating cluster's Back instead — no in-pane bar either way.
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="ribbon">
      <div className="ribbon-left">
        {/* A folder reads as "files"; the outline button uses a heading-list
            icon so the two panel toggles aren't mirror images of each other. */}
        <button
          className="ribbon-btn ribbon-btn-lg"
          aria-label="Toggle file explorer"
          title="File explorer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => uiStore.getState().toggleExplorer()}
        >
          <svg
            className="ribbon-icon"
            viewBox="0 0 20 20"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          >
            <path d="M2.7 15.3V4.7h4.6l1.7 2.2h8.3v8.4z" />
            <path d="M2.7 6.9h14.6" />
          </svg>
        </button>
        <button
          className="ribbon-btn ribbon-btn-lg"
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuAnchor != null}
          title="Menu"
          onMouseDown={(e) => e.preventDefault()}
          // Keep the window pointerdown dismiss handler from instantly
          // re-closing the menu this click opens.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) =>
            setMenuAnchor(menuAnchor ? null : e.currentTarget.getBoundingClientRect())
          }
        >
          ☰
        </button>
        {/* Save sits with the chrome, not in the mode-dependent center: it
            means the same thing in every mode, and its glyph doubles as the
            auto-save indicator, which must not vanish when you switch modes. */}
        <SaveControl />
        {canGoBack && (
          <button
            className="ribbon-btn ribbon-btn-lg"
            aria-label="Back"
            title="Back to the previous page"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (activeTabId) {
                goBackPreview(activeTabId);
              }
            }}
          >
            ←
          </button>
        )}
      </div>

      {mode === 'draw' ? (
        <DrawControls tabId={activeTabId} />
      ) : mode === 'read' ? (
        <ReaderControls />
      ) : (
        <FormatControls />
      )}

      <div className="ribbon-right">
        <button
          className="ribbon-btn"
          aria-label={isAndroid() ? 'Full screen' : 'Full window'}
          title={FULLSCREEN_TITLE}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFullscreen('window')}
        >
          ⤢
        </button>
        {/* A whiteboard has no headings, so hide (not remove) the outline
            toggle in draw mode — the reserved space keeps the fullscreen
            button where muscle memory expects it. */}
        <button
          className="ribbon-btn ribbon-btn-lg"
          style={mode === 'draw' ? { visibility: 'hidden' } : undefined}
          aria-hidden={mode === 'draw' || undefined}
          tabIndex={mode === 'draw' ? -1 : undefined}
          aria-label="Toggle outline"
          title="Outline (Ctrl/Cmd+Shift+O)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => uiStore.getState().toggleOutline()}
        >
          <svg
            className="ribbon-icon"
            viewBox="0 0 20 20"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <path d="M3 5h14" />
            <path d="M6.5 10h10.5" />
            <path d="M10 15h7" />
          </svg>
        </button>
      </div>
      {menuAnchor && <RibbonMenu anchor={menuAnchor} onClose={() => setMenuAnchor(null)} />}
    </div>
  );
}
