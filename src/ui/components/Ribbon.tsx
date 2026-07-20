/**
 * Ribbon — a toolbar between the tabs and the editor.
 *
 * Layout: the panel toggles bookend the row on the side their panel opens —
 * explorer (◧) leftmost, outline (◨) rightmost. Next to the explorer sits the
 * ☰ app menu (search / palette / export / copy raw / settings), keeping the
 * one-shot commands out of the toolbar. The center is a mode-dependent
 * cluster; fullscreen stays as a direct button on the right. Its background is
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

import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { FormatAction } from '../../editors/cm6';
import { appendMentions } from '../../core/link-mentions';
import { dirName } from '../../core/session/plan-flush';
import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings';
import { getSourceAdapter } from '../editor-registry';
import { detectPlatform } from '../keymap';
import { isAndroid } from '../platform';
import { setFullscreen } from '../fullscreen';
import { insertFileLink, openExportPreview } from '../session';
import { addCommentAtLine, openAllComments } from '../voice-comments';
import {
  canRevealThemesFolder,
  newTheme,
  openThemesFolder,
  openThemesHelp,
  reloadThemes,
  selectTheme,
} from '../theme-actions';
import { searchStore } from '../stores/search';
import { settingsStore, useSettingsStore } from '../stores/settings';
import { currentThemeValue, themePickerGroups, useThemeRegistry } from '../stores/theme-registry';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import { goBackPreview, usePreviewNav } from '../stores/preview-nav';

const IS_MAC = detectPlatform(navigator.platform) === 'mac';

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
  if (tab.mode === 'wysiwyg') {
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
  if (tab.mode === 'wysiwyg') {
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
  onClose,
  keepOpen,
}: {
  glyph: string;
  label: string;
  shortcut?: string;
  title?: string;
  onPick: () => void;
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
  const current = currentThemeValue(settings);
  const groups = themePickerGroups(plugins);
  return (
    <>
      <RibbonMenuItem glyph="‹" label="Back" onPick={onBack} onClose={onClose} keepOpen />
      <div className="ribbon-menu-divider" role="separator" />
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
              onPick={() => selectTheme(option.value)}
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

      <RibbonButton action="link" title="Link (text + URL)" label="🔗" />
      <button
        className="ribbon-btn"
        aria-label="Link to a file"
        title="Link to a file — click for an absolute path, Alt+click for relative"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => insertFileLink({ image: false, absolute: !e.altKey })}
      >
        📎
      </button>
      <button
        className="ribbon-btn"
        aria-label="Insert an image"
        title="Insert an image — click for an absolute path, Alt+click for relative"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => insertFileLink({ image: true, absolute: !e.altKey })}
      >
        🖼
      </button>

      <span className="ribbon-divider" role="separator" />

      <button
        className="ribbon-btn"
        aria-label="Add a voice comment"
        title="Add a voice comment on the current line"
        onMouseDown={(e) => e.preventDefault()}
        onClick={addVoiceCommentAtCaret}
      >
        💬
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
        💬
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

      {mode === 'read' ? <ReaderControls /> : <FormatControls />}

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
        <button
          className="ribbon-btn ribbon-btn-lg"
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
