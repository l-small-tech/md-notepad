/**
 * EditorHost — THE never-remount component (invariant I7, src/ui/README).
 *
 * One instance per open tab, all mounted simultaneously; inactive ones are
 * hidden with `display: none`, never unmounted. The editor for a tab is
 * created exactly once, in an effect keyed on `tabId` only — mode changes go
 * through `modeSync.setMode` (a store action), never through props that would
 * re-run the effect and re-create editors.
 *
 * DOM shape: a stable editor pane (the mode-sync host) plus, in split mode, a
 * sibling preview pane. The editor pane node is identical across raw/split —
 * toggling only shows/hides the preview column, so CM6 is never disturbed.
 */

import { memo, useEffect, useRef } from 'react';
import { createModeSync } from '../../core/mode-sync';
import type { EditorMode } from '../../core/types';
import { createCm6Adapter, type Cm6Adapter } from '../../editors/cm6';
import { NORMALIZATION_HINT } from '../../editors/wysiwyg-normalize';
import { attachPreviewPane } from '../../preview/pane';
import { registerSourceAdapter, unregisterSourceAdapter } from '../editor-registry';
import {
  enrichCopiedText,
  getCursor,
  noteCursor,
  openNotePath,
  savePastedImageForTab,
} from '../session';
import { settingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import {
  previewNavStore,
  registerPreviewGoBack,
  unregisterPreviewGoBack,
} from '../stores/preview-nav';
import { isDark, subscribeDark } from '../theme';
import { isAndroid } from '../platform';
import { addCommentAtLine, openComment } from '../voice-comments';
import { ConflictBanner } from './ConflictBanner';

/**
 * Split-divider position, shared by every tab (module scope, not React
 * state — dragging fires on every pointermove and must never trigger a
 * re-render). Persists across tab switches for the session; not saved to
 * the manifest (splitting hairs over pixels isn't worth a persisted field).
 */
let splitRatio = 0.5;
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

function clampSplitRatio(ratio: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/** Which work-area pane a host renders in, or null when hidden (see WorkSplit). */
export type HostPane = 'primary' | 'secondary' | null;

function EditorHostImpl({ tabId, pane }: { tabId: string; pane: HostPane }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const previewHostRef = useRef<HTMLDivElement>(null);
  // The CM6 source adapter, captured when its factory runs, so live settings
  // changes (word wrap) can reconfigure it without re-mounting (I7). Font size
  // needs no hook here — it rides the `--editor-font-size` CSS variable.
  const sourceAdapterRef = useRef<Cm6Adapter | null>(null);
  const mode = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.mode ?? 'raw');

  function startDividerDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const row = rowRef.current;
    const editorPane = hostRef.current;
    if (!row || !editorPane) {
      return;
    }
    function onMove(moveEvent: PointerEvent): void {
      const rect = row!.getBoundingClientRect();
      splitRatio = clampSplitRatio((moveEvent.clientX - rect.left) / rect.width);
      editorPane!.style.flex = `0 0 ${splitRatio * 100}%`;
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  useEffect(() => {
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    const host = hostRef.current;
    if (!tab || !host) {
      return;
    }

    const sync = createModeSync({
      model: tab.model,
      host,
      initialMode: tab.mode,
      adapters: {
        source: () => {
          const adapter = createCm6Adapter({
            wordWrap: settingsStore.getState().settings.wordWrap,
            initialSelection: getCursor(tabId) ?? undefined,
            onSelection: (pos) => {
              uiStore.getState().reportCursor(tabId, { line: pos.line, col: pos.col });
              noteCursor(tabId, { anchor: pos.anchor, head: pos.head });
            },
            saveImage: (data) => savePastedImageForTab(tabId, data),
            enrichCopy: (text) => enrichCopiedText(tabId, text),
            // Voice comments: a gutter marker opens the transcript; on touch a
            // long-press on a line starts a new dictated comment there.
            onOpenComment: (id, line) => void openComment(tabId, id, line),
            onLongPressLine: isAndroid() ? (line) => void addCommentAtLine(tabId, line) : undefined,
            // Android: double-tap the text to dismiss the soft keyboard.
            dismissKeyboardOnDoubleTap: isAndroid(),
          });
          sourceAdapterRef.current = adapter;
          registerSourceAdapter(tabId, adapter);
          return adapter;
        },
        // Lazy import keeps @milkdown/crepe out of the entry chunk (I8); the
        // module loads on the first switch to rich mode, never at startup.
        wysiwyg: async () => {
          const { createMilkdownAdapter } = await import('../../editors/milkdown');
          return createMilkdownAdapter({
            onNormalizationHint: () => uiStore.getState().showNotice(NORMALIZATION_HINT),
            saveImage: (data) => savePastedImageForTab(tabId, data),
            getDocPath: () => {
              const t = tabsStore.getState().tabs.find((tab) => tab.id === tabId);
              return t ? (t.filePath ?? t.notePath) : null;
            },
          });
        },
      },
      onError: (error, failedMode) => {
        console.error(`[editor] ${failedMode} adapter failed`, error);
        uiStore.getState().showNotice(`Could not switch to ${failedMode} mode.`);
      },
    });

    tabsStore.getState().registerModeSync(tabId, sync);

    // Live word-wrap: reconfigure the (already-mounted) CM6 editor when the
    // setting flips, instead of re-creating it. No-op while the source editor
    // hasn't been created yet (a tab that opened straight into wysiwyg) — the
    // factory reads the current setting when it eventually runs.
    let lastWordWrap = settingsStore.getState().settings.wordWrap;
    const unsubscribeSettings = settingsStore.subscribe((s) => {
      if (s.settings.wordWrap !== lastWordWrap) {
        lastWordWrap = s.settings.wordWrap;
        sourceAdapterRef.current?.setWordWrap(lastWordWrap);
      }
    });

    return () => {
      unsubscribeSettings();
      unregisterSourceAdapter(tabId);
      void sync.dispose();
    };
    // tab.id only — see I7. Adding reactive deps would re-mount the editor.
  }, [tabId]);

  // The preview pane is not the source editor (I7 governs that alone) — it's a
  // plain DOM projection that mounts/unmounts with split OR read mode. In read
  // mode it fills the row (the source editor is hidden via CSS); in split it
  // shares the row with the editor at the dragged ratio.
  useEffect(() => {
    if (mode !== 'split' && mode !== 'read') {
      return;
    }
    const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
    const host = previewHostRef.current;
    const editorPane = hostRef.current;
    if (!tab || !host || !editorPane) {
      return;
    }
    if (mode === 'split') {
      editorPane.style.flex = `0 0 ${splitRatio * 100}%`;
    }
    const pane = attachPreviewPane(host, tab.model, {
      dark: isDark(),
      docPath: tab.filePath ?? tab.notePath,
      // A followed link to an image (or any non-text file) opens in a tab —
      // the reader can only render markdown/text inline.
      onOpenFile: (path) => openNotePath(path),
      // Surface Back state so the fullscreen cluster can host the Back button
      // (the in-pane bar is hidden in fullscreen — see preview.css).
      onCanGoBackChange: (canGoBack) => previewNavStore.getState().setCanGoBack(tabId, canGoBack),
    });
    registerPreviewGoBack(tabId, () => pane.goBack());
    const unsubscribeDark = subscribeDark((dark) => pane.setDark(dark));
    // A freshly-created untitled note has no path yet; the flusher assigns one
    // later. Keep the pane's docDir in sync so in-pane relative links/images
    // resolve once the note is saved — WITHOUT re-keying this effect (which
    // would remount the pane and lose scroll). setDocPath no-ops when the dir
    // is unchanged, so firing on every store tick is cheap.
    const unsubscribePath = tabsStore.subscribe(() => {
      const t = tabsStore.getState().tabs.find((t) => t.id === tabId);
      pane.setDocPath(t ? (t.filePath ?? t.notePath) : null);
    });
    // Read mode: move focus onto the scrollable reading pane so keyboard
    // scrolling works and the hidden source editor can never take a keystroke.
    if (mode === 'read' && tabsStore.getState().activeTabId === tabId) {
      host.focus();
    }
    return () => {
      unsubscribeDark();
      unsubscribePath();
      unregisterPreviewGoBack(tabId);
      previewNavStore.getState().clear(tabId);
      pane.dispose();
      if (mode === 'split') {
        editorPane.style.flex = ''; // back to the raw-mode CSS default
      }
    };
  }, [tabId, mode]);

  return (
    <div
      className="editor-host"
      style={{ display: pane !== null ? 'flex' : 'none' }}
      data-mode={mode satisfies EditorMode}
      data-pane={pane ?? undefined}
    >
      <ConflictBanner tabId={tabId} />
      <div ref={rowRef} className="editor-row">
        <div ref={hostRef} className="editor-pane" />
        {mode === 'split' && (
          <div
            className="split-divider"
            onPointerDown={startDividerDrag}
            role="separator"
            aria-orientation="vertical"
          />
        )}
        {(mode === 'split' || mode === 'read') && (
          <div
            ref={previewHostRef}
            className={`preview ${mode === 'read' ? 'reader-preview' : 'split-preview'}`}
            tabIndex={mode === 'read' ? 0 : undefined}
          />
        )}
      </div>
    </div>
  );
}

export const EditorHost = memo(EditorHostImpl);
