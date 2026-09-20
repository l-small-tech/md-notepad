/**
 * Ribbon — a toolbar between the tabs and the editor.
 *
 * Layout: the panel toggles bookend the row on the side their panel opens —
 * explorer (◧) leftmost, outline (◨) rightmost. Next to the explorer sits
 * Save — which is also the auto-save indicator, so it lives with the chrome
 * that every mode shows. The ribbon has no menu button of its own: the app
 * commands live in the "+ ⌄" picker beside the new-tab button and in the tab
 * bar's own right-click menu (`AppMenu.AppActionRows`), and the per-document
 * ones (export, copy raw text) in a tab's right-click menu. The
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

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FormatAction } from '../../editors/cm6';
import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings';
import { docFamilyForTab } from '../../core/doc-family';
import { getSourceAdapter } from '../editor-registry';
import { AppMenuDivider, AppMenuItem } from './AppMenu';
import { detectPlatform } from '../keymap';
import { isAndroid } from '../platform';
import { setDistractionFree } from '../fullscreen';
import { insertFileLink, isTabLive, saveActiveTab, saveActiveTabAs } from '../session';
import { dictationEngine, toggleArmed, useVoiceStore } from '../voice-comments';
import { toggleOverview, useNotesOverview } from '../notes-overview';
import { stopVoiceTyping, toggleVoiceTyping, useVoiceTypingStore } from '../voice-typing';
import {
  ARROW_HEAD_GLYPHS,
  ARROW_HEAD_LABELS,
  ARROW_HEADS,
  CONNECTOR_ROUTES,
  DASH_LABELS,
  DASH_STYLES,
  DEFAULT_GRID,
  FONT_FAMILIES,
  GRID_SIZES,
  NO_FILL,
  PALETTE,
  paletteSlot,
  PAPER_FILL,
  ROUTE_LABELS,
  SHAPE_OPTIONS,
  STATIC_PALETTE,
  STROKE_WIDTHS,
  TEXT_SIZES,
  THEMED_SLOT_NAMES,
  type ArrowHeads,
  type DashStyle,
  type DrawTool,
  type GridSettings,
  type ShapeTool,
} from '../../core/whiteboard/tool-settings';
import type { ConnectorRoute } from '../../core/whiteboard/scene';
// Also a dependency-free leaf (the same I8 constraint tool-settings is under):
// the ribbon needs the finger-toggle's resolution rule, nothing more.
import { fingerDrawsEnabled } from '../../core/whiteboard/input';
import { getWhiteboardAdapter, useWhiteboardStore, whiteboardStore } from '../stores/whiteboard';
import { settingsStore, useSettingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import { goBackPreview, usePreviewNav } from '../stores/preview-nav';

const IS_MAC = detectPlatform(navigator.platform) === 'mac';

/** Whether this machine has a touchscreen — gates the board's touch policy. */
const HAS_TOUCH = navigator.maxTouchPoints > 0;

/** Platform-correct shortcut hint for the distraction-free tooltip. */
const FULLSCREEN_KEY = IS_MAC ? '⌃⌘F' : 'F11';

/**
 * Tooltip for the ribbon's distraction-free button. Desktop also has OS full
 * screen (F11), which is independent and leaves the chrome alone; Android has
 * only this.
 */
const DISTRACTION_FREE_TITLE = isAndroid()
  ? 'Distraction-free — hide the app chrome'
  : `Distraction-free — hide the app chrome (${FULLSCREEN_KEY} for full screen)`;

function applyFormat(action: FormatAction): void {
  const state = tabsStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) {
    return;
  }
  if (tab.mode === 'wysiwyg' || tab.mode === 'draw' || docFamilyForTab(tab) === 'svg') {
    uiStore.getState().showNotice('Formatting controls work in Markdown and Split modes.');
    return;
  }
  getSourceAdapter(tab.id)?.format(action);
}

/**
 * Adjust the shared editor/preview font size (the `--editor-font-size` CSS
 * variable both the source editor and the preview read). `'reset'` returns to
 * the default; a numeric step nudges it within the allowed range. This is the
 * Review-mode "zoom", and mirrors the mod +/-/0 keyboard shortcuts.
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

/** A microphone — voice typing. */
const MicIcon = (
  <RibbonIcon>
    <rect x="7.4" y="2.8" width="5.2" height="9" rx="2.6" />
    <path d="M4.6 9.4a5.4 5.4 0 0 0 10.8 0" />
    <path d="M10 14.8v2.6" />
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
 * The Review-mode review-notes toggle. While on, pressing and holding a line
 * of the rendered document opens the note sheet for that line (the pane's
 * hold gesture → `openNoteAtLine`), and lines that already have a note show
 * a marker. Review mode only: notes are about reviewing a finished document,
 * and the rendered view is where a line is held.
 *
 * "Review notes", not "voice notes": on Android the note is dictated (the
 * on-device recognizer or Whisper), on desktop it is typed — with the OS's
 * dictation, or Whisper — so the name says what they are for, not how they
 * are made. There is no platform without a way to add one.
 */
function VoiceNotesToggle() {
  const armed = useVoiceStore((s) => s.armed);
  return (
    <button
      className="ribbon-btn"
      data-active={armed || undefined}
      aria-pressed={armed}
      aria-label="Review notes"
      title={
        armed
          ? 'Review notes on — press and hold a line to add one'
          : 'Review notes — turn on, then press and hold a line'
      }
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggleArmed}
    >
      {CommentIcon}
    </button>
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
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOrigin = useRef<{ x: number; y: number } | null>(null);
  // A hold that opened the menu must not also fire the button's click on
  // release — the finger that summoned the menu would save on the way out.
  const suppressClick = useRef(false);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);

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
          // No stopPropagation here: this press opens nothing yet, so letting
          // it reach the window lets an already-open popover — another menu,
          // or this button's own — dismiss normally. The
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
  // The per-tab Live Edit override is offered for a saved FILE tab only —
  // notes have no file of their own to share.
  // (Two primitive selectors, not one object — a fresh object per call would
  // re-render the menu on every store change.)
  const liveTabId = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind === 'file' && tab.filePath && !tab.readOnly ? tab.id : null;
  });
  const liveOn = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? isTabLive(tab) : false;
  });
  const liveTab = liveTabId === null ? null : { id: liveTabId, live: liveOn };
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
      className="tab-menu app-menu"
      role="menu"
      aria-label="Save options"
      style={{ left: anchor.left, top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <AppMenuItem
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
      {liveTab && (
        <AppMenuItem
          glyph={liveTab.live ? '✓' : ''}
          label="Live edit (shared file)"
          title="Save this file as you type AND merge changes other people save to it, live — for a file in a shared Drive/OneDrive folder. Overrides the workspace setting for this tab."
          onPick={() => {
            const next = !liveTab.live;
            tabsStore.getState().setLiveEdit(liveTab.id, next);
            uiStore
              .getState()
              .showNotice(
                next
                  ? 'Live edit is on for this file: it saves as you type and merges changes from others.'
                  : 'Live edit is off for this file.',
              );
          }}
          onClose={onClose}
        />
      )}
      <AppMenuDivider />
      <AppMenuItem
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

      <VoiceTypingSlot />
    </div>
  );
}

/** The divider + mic, present only while an engine exists — re-evaluated when the settings change. */
function VoiceTypingSlot() {
  useSettingsStore((s) => s.settings.desktopDictationEngine);
  useSettingsStore((s) => s.settings.androidDictationEngine);
  if (dictationEngine() === null) {
    return null;
  }
  return (
    <>
      <span className="ribbon-divider" role="separator" />
      <VoiceTypingButton />
    </>
  );
}

/**
 * Voice typing in the edit modes (`ui/voice-typing.ts`): speak and the words
 * land at the caret. Pressing keeps focus in the editor, which Windows voice
 * typing needs to type into it. Switching tabs, or to Review/Draw (which
 * unmounts this), finishes a live capture into the tab it started on.
 */
function VoiceTypingButton() {
  const phase = useVoiceTypingStore((s) => s.phase);
  const stopping = useVoiceTypingStore((s) => s.stopping);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  useEffect(() => stopVoiceTyping, [activeTabId]);
  const listening = phase === 'listening' && !stopping;
  const busy = phase === 'transcribing' || stopping;
  return (
    <button
      className="ribbon-btn ribbon-mic"
      data-listening={listening || undefined}
      data-busy={busy || undefined}
      aria-pressed={phase !== 'idle'}
      aria-busy={busy}
      aria-label="Voice typing"
      title={
        busy
          ? 'Voice typing — writing it down…'
          : listening
            ? 'Voice typing — listening; click to finish'
            : 'Voice typing — speak to type at the cursor'
      }
      disabled={phase === 'transcribing'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggleVoiceTyping}
    >
      {MicIcon}
    </button>
  );
}

/**
 * A ribbon popover: a `.tab-menu` anchored under the button that opened it,
 * dismissed by the same three things every other menu in the app is (a press
 * outside, Escape, the window moving under it). Draw mode has two — the shape
 * picker and the shape-style menu — and they exist so ten shapes and three
 * style controls cost two ribbon slots instead of thirteen.
 */
function RibbonPopover({
  anchor,
  label,
  className,
  onClose,
  children,
}: {
  anchor: DOMRect;
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
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
      className={`tab-menu wb-popover${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label}
      // Right-aligned would run off a narrow window; left of the button is
      // where every other ribbon menu opens.
      style={{ left: Math.max(4, anchor.left - 60), top: anchor.bottom + 4 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * The shape tool, as one button plus a grid.
 *
 * Ten shapes as ten buttons would push the ribbon past the width it has to fit
 * on a tablet, so the button shows the LAST shape used and one click draws it
 * again; the grid is one more click away. That keeps the original four exactly
 * as cheap as they were while the other six cost nothing until you want them.
 */
function ShapePicker({
  tool,
  lastShape,
  onPick,
}: {
  tool: DrawTool;
  lastShape: ShapeTool;
  onPick: (shape: ShapeTool) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const current = SHAPE_OPTIONS.find((s) => s.id === lastShape) ?? SHAPE_OPTIONS[0]!;
  const active = SHAPE_OPTIONS.some((s) => s.id === tool);
  return (
    <>
      <button
        className="ribbon-btn"
        aria-label={`Shape — ${current.label}`}
        aria-pressed={active}
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        data-active={active || undefined}
        title={`${current.label} — click to draw it, or ⌄ for other shapes (R rect, O ellipse, L line, A arrow). Hold Shift while dragging to keep it square (a line snaps to 45°).`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(current.id)}
      >
        {current.glyph}
      </button>
      <button
        className="ribbon-btn ribbon-caret"
        aria-label="Choose a shape"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        title="Choose a shape"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          setAnchor((open) => (open ? null : e.currentTarget.getBoundingClientRect()))
        }
      >
        ⌄
      </button>
      {anchor && (
        <RibbonPopover
          anchor={anchor}
          label="Shapes"
          className="wb-shape-grid"
          onClose={() => setAnchor(null)}
        >
          {SHAPE_OPTIONS.map((shape) => (
            <button
              key={shape.id}
              className="ribbon-btn"
              role="menuitemradio"
              aria-checked={tool === shape.id}
              data-active={tool === shape.id || undefined}
              aria-label={shape.label}
              title={shape.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(shape.id);
                setAnchor(null);
              }}
            >
              {shape.glyph}
            </button>
          ))}
        </RibbonPopover>
      )}
    </>
  );
}

/**
 * Fill, dash, arrow heads and route — the shape properties that are not a
 * colour or a nib, behind one button.
 *
 * They act on the SELECTION when there is one and always set the tool default,
 * which is the whole styling model for the board: no floating toolbar, no
 * properties panel, one strip that means "this is what that looks like".
 */
function ShapeStyleMenu({
  fill,
  dash,
  heads,
  route,
  onFill,
  onDash,
  onHeads,
  onRoute,
}: {
  fill: string | null;
  dash: DashStyle | null;
  heads: ArrowHeads | null;
  route: ConnectorRoute | null;
  onFill: (fill: string) => void;
  onDash: (dash: DashStyle) => void;
  onHeads: (heads: ArrowHeads) => void;
  onRoute: (route: ConnectorRoute) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className="ribbon-btn"
        aria-label="Shape style — fill, dashes, arrow heads, route"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        title="Shape style — fill, dashes, arrow heads and how a line routes. With something selected, these restyle it."
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          setAnchor((open) => (open ? null : e.currentTarget.getBoundingClientRect()))
        }
      >
        ◧
      </button>
      {anchor && (
        <RibbonPopover
          anchor={anchor}
          label="Shape style"
          className="wb-style-menu"
          onClose={() => setAnchor(null)}
        >
          <div className="wb-style-label">Fill</div>
          <div className="ribbon-swatches" role="group" aria-label="Fill">
            <button
              className="ribbon-swatch wb-swatch-none"
              aria-label="No fill"
              aria-pressed={fill === NO_FILL}
              data-active={fill === NO_FILL || undefined}
              title="No fill — the shape is an outline"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFill(NO_FILL)}
            />
            <button
              className="ribbon-swatch"
              style={{ background: `var(--wb-bg, ${PAPER_FILL})` }}
              aria-label="Paper fill"
              aria-pressed={fill === PAPER_FILL}
              data-active={fill === PAPER_FILL || undefined}
              title="Paper — the board's own colour, so the box hides what is behind it on a light or a dark board"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFill(PAPER_FILL)}
            />
            {PALETTE.map((swatch, slot) => (
              <button
                key={swatch}
                className="ribbon-swatch"
                style={{ background: `var(--wb-c${slot}, ${swatch})` }}
                aria-label={`Fill ${THEMED_SLOT_NAMES[slot] ?? swatch}`}
                aria-pressed={fill === swatch}
                data-active={fill === swatch || undefined}
                title={THEMED_SLOT_NAMES[slot] ?? swatch}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFill(swatch)}
              />
            ))}
          </div>

          <div className="wb-style-label">Outline</div>
          <div className="ribbon-swatches" role="group" aria-label="Outline">
            {DASH_STYLES.map((style) => (
              <button
                key={style}
                className="ribbon-btn"
                role="menuitemradio"
                aria-checked={dash === style}
                data-active={dash === style || undefined}
                aria-label={DASH_LABELS[style]}
                title={DASH_LABELS[style]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onDash(style)}
              >
                <svg className="ribbon-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <line
                    x1="2"
                    y1="10"
                    x2="18"
                    y2="10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={
                      style === 'dashed' ? '6 3' : style === 'dotted' ? '0 4' : undefined
                    }
                  />
                </svg>
              </button>
            ))}
          </div>

          <div className="wb-style-label">Arrow heads</div>
          <div className="ribbon-swatches" role="group" aria-label="Arrow heads">
            {ARROW_HEADS.map((kind) => (
              <button
                key={kind}
                className="ribbon-btn"
                role="menuitemradio"
                aria-checked={heads === kind}
                data-active={heads === kind || undefined}
                aria-label={ARROW_HEAD_LABELS[kind]}
                title={ARROW_HEAD_LABELS[kind]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onHeads(kind)}
              >
                {ARROW_HEAD_GLYPHS[kind]}
              </button>
            ))}
          </div>

          <div className="wb-style-label">Route</div>
          <div className="ribbon-swatches" role="group" aria-label="Line route">
            {CONNECTOR_ROUTES.map((kind) => (
              <button
                key={kind}
                className="ribbon-btn"
                role="menuitemradio"
                aria-checked={route === kind}
                data-active={route === kind || undefined}
                aria-label={ROUTE_LABELS[kind]}
                title={`${ROUTE_LABELS[kind]}. A line that starts or ends on a shape stays attached to it.`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRoute(kind)}
              >
                <svg className="ribbon-icon" viewBox="0 0 20 20" aria-hidden="true">
                  <polyline
                    points={kind === 'elbow' ? '3,16 10,16 10,4 17,4' : '3,16 17,4'}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ))}
          </div>
        </RibbonPopover>
      )}
    </>
  );
}

/**
 * The grid: one toggle, plus a caret for the two things you set once and
 * forget (whether it snaps, and how big it is).
 *
 * The strip has to fit a tablet and has no room for three controls, so the
 * split follows what people actually do — the grid gets turned on and off all
 * the time, its spacing almost never. Unlike every other control here, this
 * one edits the DOCUMENT: the grid is stored in the file and comes back with
 * it, which is why the state arrives per tab through `WhiteboardUiState`
 * rather than living in the store.
 */
function GridControl({
  grid,
  onChange,
}: {
  grid: GridSettings;
  onChange: (patch: Partial<GridSettings>) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        className="ribbon-btn"
        aria-label={grid.show ? 'Hide the grid' : 'Show the grid'}
        aria-pressed={grid.show}
        data-active={grid.show || undefined}
        title={
          (grid.show
            ? `Grid on, ${grid.size} units${grid.snap ? ', snapping' : ', not snapping'}. `
            : 'Grid off. ') +
          'Toggle with G. Hold Alt while dragging to ignore snapping; ' +
          'things also snap to other shapes’ edges and centres.'
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange({ show: !grid.show })}
      >
        ⊞
      </button>
      <button
        className="ribbon-btn ribbon-caret"
        aria-label="Grid settings"
        aria-haspopup="menu"
        aria-expanded={anchor != null}
        title="Grid settings — snapping and spacing"
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          setAnchor((open) => (open ? null : e.currentTarget.getBoundingClientRect()))
        }
      >
        ⌄
      </button>
      {anchor && (
        <RibbonPopover
          anchor={anchor}
          label="Grid"
          className="wb-style-menu"
          onClose={() => setAnchor(null)}
        >
          <div className="wb-style-label">Snapping</div>
          <div className="ribbon-swatches" role="group" aria-label="Snapping">
            <button
              className="ribbon-btn wb-grid-snap"
              role="menuitemcheckbox"
              aria-checked={grid.snap}
              data-active={grid.snap || undefined}
              title={
                grid.snap
                  ? 'Snapping on — shapes land on the grid and on other shapes’ edges. Alt ignores it for one drag.'
                  : 'Snapping off — nothing is pulled anywhere.'
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange({ snap: !grid.snap })}
            >
              {grid.snap ? 'Snap on' : 'Snap off'}
            </button>
          </div>

          <div className="wb-style-label">Spacing</div>
          <div className="ribbon-swatches" role="group" aria-label="Grid spacing">
            {GRID_SIZES.map((size) => (
              <button
                key={size}
                className="ribbon-btn"
                role="menuitemradio"
                aria-checked={grid.size === size}
                data-active={grid.size === size || undefined}
                aria-label={`Grid ${size} units`}
                title={`${size} units`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange({ size })}
              >
                {size}
              </button>
            ))}
          </div>
        </RibbonPopover>
      )}
    </>
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
  const fill = useWhiteboardStore((s) => s.fill);
  const dash = useWhiteboardStore((s) => s.dash);
  const heads = useWhiteboardStore((s) => s.heads);
  const route = useWhiteboardStore((s) => s.route);
  const lastShape = useWhiteboardStore((s) => s.lastShape);
  // The type row shows for the text tool, and whenever the selection actually
  // HOLDS text to restyle — before phase A it showed for any selection, which
  // meant selecting a shape hid the nib the shape's outline needed.
  const typeControls = tool === 'text' || (tabState?.selectionStyle?.hasText ?? false);
  const adapter = tabId !== null ? getWhiteboardAdapter(tabId) : undefined;
  // Themed slots preview through their --wb-* var; static/custom stay literal.
  const colorSlot = paletteSlot(color);
  const nibColor = colorSlot < 0 ? color : `var(--wb-c${colorSlot}, ${color})`;
  const themedRow = paletteKind === 'themed';

  // With a selection active the ribbon shows what is SELECTED, not what the
  // tool would draw next — and shows nothing at all where the selection
  // disagrees with itself (`null` from `selectionStyle`). Without one it is the
  // tool's own settings, exactly as before.
  const selected = tabState?.selectionStyle ?? null;
  const shownColor = selected ? selected.stroke : color;
  const shownWidth = selected ? selected.strokeWidth : width;
  const shownFill = selected ? selected.fill : fill;
  const shownDash = selected ? selected.dash : dash;
  const shownHeads = selected ? selected.heads : heads;
  const shownRoute = selected ? selected.route : route;

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
      {toolButton(
        'select',
        '⬚',
        'Select (V) — drag to move, handles to resize, right-click for arrange, Delete to remove',
      )}
      {toolButton('pen', '✎', 'Pen (P)')}
      {toolButton('highlighter', '▤', 'Highlighter (H)')}
      {toolButton('eraser', '⌫', 'Eraser (E) — removes a whole stroke')}
      {toolButton(
        'text',
        'T',
        'Text (T) — click to type, Enter for a new line, Ctrl/Cmd+Enter to finish. Double-click a shape to label it.',
      )}

      <span className="ribbon-divider" role="separator" />

      <ShapePicker
        tool={tool}
        lastShape={lastShape}
        onPick={(shape) => {
          whiteboardStore.getState().setTool(shape);
          adapter?.refreshTool();
        }}
      />

      <ShapeStyleMenu
        fill={shownFill}
        dash={shownDash}
        heads={shownHeads}
        route={shownRoute}
        onRoute={(next) => {
          whiteboardStore.getState().setRoute(next);
          adapter?.restyleSelection({ route: next });
        }}
        onFill={(next) => {
          whiteboardStore.getState().setFill(next);
          adapter?.restyleSelection({ fill: next });
        }}
        onDash={(next) => {
          whiteboardStore.getState().setDash(next);
          adapter?.restyleSelection({ dash: next });
        }}
        onHeads={(next) => {
          whiteboardStore.getState().setHeads(next);
          adapter?.refreshTool();
          // The end head lives in the shape KIND, so "none" is a line and
          // anything else an arrow — see core/whiteboard/style.ts.
          adapter?.restyleSelection({
            markerEnd: next !== 'none',
            markerStart: next === 'both',
          });
        }}
      />

      <GridControl
        grid={tabState?.grid ?? DEFAULT_GRID}
        onChange={(patch) => adapter?.setGrid(patch)}
      />

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
              aria-pressed={shownColor === swatch}
              data-active={shownColor === swatch || undefined}
              title={name}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                whiteboardStore.getState().setColor(swatch);
                // One click, both meanings: restyle what is selected AND set
                // the colour the next stroke will use. A no-op when nothing
                // is selected, which is the common case.
                adapter?.restyleSelection({ stroke: swatch });
              }}
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
      {(!typeControls || (selected?.hasInk ?? false)) && (
        <div className="ribbon-swatches" role="group" aria-label="Stroke width">
          {STROKE_WIDTHS.map((size) => (
            <button
              key={size}
              className="ribbon-nib"
              aria-label={`Width ${size}`}
              aria-pressed={shownWidth === size}
              data-active={shownWidth === size || undefined}
              title={`Width ${size}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                whiteboardStore.getState().setWidth(size);
                adapter?.restyleSelection({ strokeWidth: size });
              }}
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

      <VoiceNotesSlot />
    </div>
  );
}

/** A stack of note lines — every review note. */
const NotesListIcon = (
  <RibbonIcon>
    <path d="M4 5.5h12M4 10h12M4 14.5h7" />
    <circle cx="15.2" cy="14.5" r="1.6" />
  </RibbonIcon>
);

/**
 * "See all review notes": the overview of every note across the workspaces
 * (`notes-overview.ts`). Always available in Review mode — reading what was
 * noted needs no toggle — and the button lights while the panel is open.
 */
function AllNotesButton() {
  const open = useNotesOverview((s) => s.open);
  return (
    <button
      className="ribbon-btn"
      data-active={open || undefined}
      aria-pressed={open}
      aria-label="All review notes"
      title="All review notes — every note in this document and the workspaces"
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggleOverview}
    >
      {NotesListIcon}
    </button>
  );
}

/** The divider + review-notes toggle + the all-notes overview. */
function VoiceNotesSlot() {
  return (
    <>
      <span className="ribbon-divider" role="separator" />
      <VoiceNotesToggle />
      <AllNotesButton />
    </>
  );
}

export function Ribbon() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode ?? 'raw');
  // The draw cluster follows the BOARD, not the mode name: a drawing's Split
  // has one on screen beside the source editor, and the markdown formatting
  // controls it would otherwise show mean nothing in SVG.
  const drawing = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab !== undefined && docFamilyForTab(tab) === 'svg';
  });
  const showDraw = mode === 'draw' || (drawing && mode === 'split');
  // Back appears only while browsing a followed link in the active tab's preview
  // (read/split). It sits with the chrome, so full screen (which hides the
  // ribbon) uses the floating cluster's Back instead — no in-pane bar either way.
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );
  return (
    <div
      className="ribbon"
      // The whole bar is buttons and blank space — a press anywhere in it must
      // never start a text selection (WebKit can otherwise anchor one in the
      // nearest selectable content) or steal focus from the editor. Same
      // preventDefault RibbonButton uses; inputs don't live in the ribbon.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        // Free bar space has no menu of its own — swallow the event so the
        // webview default (Back / Reload / Inspect) never shows. Buttons and
        // any open popover keep their own handling; their events merely bubble
        // through here.
        if ((e.target as HTMLElement).closest('button, .tab-menu')) {
          return;
        }
        e.preventDefault();
      }}
    >
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

      {showDraw ? (
        <DrawControls tabId={activeTabId} />
      ) : mode === 'read' ? (
        <ReaderControls />
      ) : (
        <FormatControls />
      )}

      <div className="ribbon-right">
        <button
          className="ribbon-btn"
          aria-label="Distraction-free"
          title={DISTRACTION_FREE_TITLE}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setDistractionFree(true)}
        >
          ⤢
        </button>
        {/* A whiteboard has no headings, so hide (not remove) the outline
            toggle on a drawing — the reserved space keeps the distraction-free
            button where muscle memory expects it. */}
        <button
          className="ribbon-btn ribbon-btn-lg"
          style={drawing ? { visibility: 'hidden' } : undefined}
          aria-hidden={drawing || undefined}
          tabIndex={drawing ? -1 : undefined}
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
    </div>
  );
}
