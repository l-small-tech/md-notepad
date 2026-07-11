/**
 * Ribbon — a toolbar between the tabs and the editor.
 *
 * Layout: explorer + settings buttons on the left, a mode-dependent center
 * cluster, and a copy-raw-text button on the right. Its background is
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

import type { ReactNode } from 'react';
import type { FormatAction } from '../../editors/cm6';
import { appendMentions } from '../../core/link-mentions';
import { dirName } from '../../core/session/plan-flush';
import { DEFAULT_SETTINGS, MAX_FONT_SIZE, MIN_FONT_SIZE } from '../../core/settings';
import { getSourceAdapter } from '../editor-registry';
import { detectPlatform } from '../keymap';
import { cycleReaderView } from '../reader-fullscreen';
import { insertFileLink } from '../session';
import { settingsStore, useSettingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';

/** Platform-correct shortcut hint for the fullscreen tooltips. */
const FULLSCREEN_KEY = detectPlatform(navigator.platform) === 'mac' ? '⌃⌘F' : 'F11';

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
      <RibbonButton action="code" title="Inline code" label={<code>&lt;/&gt;</code>} />

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

      <span className="ribbon-divider" role="separator" />

      <button
        className="ribbon-btn"
        aria-label="Reset zoom"
        title="Reset text size (Ctrl/Cmd+0)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => zoom('reset')}
      >
        ⟲
      </button>
    </div>
  );
}

export function Ribbon() {
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode ?? 'raw');
  return (
    <div className="ribbon">
      <div className="ribbon-left">
        <button
          className="ribbon-btn ribbon-btn-lg"
          aria-label="Toggle file explorer"
          title="File explorer"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => uiStore.getState().toggleExplorer()}
        >
          ☰
        </button>
        <button
          className="ribbon-btn ribbon-btn-lg"
          aria-label="Settings"
          title="Settings (Ctrl+,)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => uiStore.getState().openSettings()}
        >
          ⚙
        </button>
      </div>

      {mode === 'read' ? <ReaderControls /> : <FormatControls />}

      <div className="ribbon-right">
        <button
          className="ribbon-btn"
          aria-label="Copy all raw text"
          title="Copy raw text (+ @path mentions for linked files, for the Claude Code CLI)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={copyRawText}
        >
          ⧉
        </button>
        {mode === 'read' && (
          <button
            className="ribbon-btn"
            aria-label="Full screen"
            title={`Full screen — fills the window first, the screen second (${FULLSCREEN_KEY}; Esc steps back)`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={cycleReaderView}
          >
            ⛶
          </button>
        )}
      </div>
    </div>
  );
}
