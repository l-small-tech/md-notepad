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
import { docFamilyFor } from '../../core/doc-family';
import { createModeSync, type AdapterFactory, type AdapterKind } from '../../core/mode-sync';
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
  takePendingReveal,
} from '../session';
import { diagramViewerStore } from '../stores/diagram-viewer';
import { settingsStore } from '../stores/settings';
import { tabsStore, useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import {
  currentToolSettings,
  registerWhiteboardAdapter,
  unregisterWhiteboardAdapter,
  whiteboardStore,
} from '../stores/whiteboard';
import {
  previewNavStore,
  registerPreviewGoBack,
  registerPreviewReveal,
  unregisterPreviewGoBack,
  unregisterPreviewReveal,
} from '../stores/preview-nav';
import { isDark, subscribeDark } from '../theme';
import { isAndroid } from '../platform';
import { capturePhotoForScan, pickPhotoForScan } from '../scan-photo';
import { createScanDebugSaver } from '../scan-debug';
import { scanTextRecognizer } from '../scan-ocr';
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

function EditorHostImpl({ tabId, active }: { tabId: string; active: boolean }) {
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

    // Only the adapters this document family can actually use are supplied. An
    // .svg tab gets Draw (+ Raw, which is a free SVG source editor); a markdown
    // tab gets Rich. Anything else is a mode the status bar never offers.
    const family = docFamilyFor(tab.filePath ?? tab.notePath);
    const familyAdapters: Partial<Record<AdapterKind, AdapterFactory>> =
      family === 'svg'
        ? {
            // Lazy import, same rule as Milkdown (I8): the whiteboard chunk
            // loads on the first draw-mode attach, never at startup.
            draw: async () => {
              const { createWhiteboardAdapter } = await import('../../editors/whiteboard');
              const adapter = createWhiteboardAdapter({
                onOpenAsText: () => tabsStore.getState().setMode(tabId, 'raw'),
                // The ribbon owns the tool picker; the adapter reads it at the
                // start of each gesture and reports undo depth back, so neither
                // side has to subscribe to the other.
                getTool: () => currentToolSettings(),
                onStateChange: (state) => whiteboardStore.getState().reportTabState(tabId, state),
                // Touch policy (phase 3): the preference lives in the store,
                // the adapter resolves it against the pen it has actually
                // seen, and tells the store so the ribbon can say so.
                getFingerDraws: () => whiteboardStore.getState().fingerDraws,
                onPenSeen: () => whiteboardStore.getState().notePenSeen(),
                // Viewport persistence is per-tab SESSION state — never the
                // file, because panning must not dirty a document.
                getSavedView: () => whiteboardStore.getState().viewByTab[tabId] ?? null,
                onViewChange: (view) => whiteboardStore.getState().saveView(tabId, view),
                // Photo acquisition is INJECTED (phase 4): the camera is an
                // Android-only IPC bridge and the picker is a native dialog,
                // and neither belongs inside an editor module. The adapter
                // just gets two functions and a way to speak to the user.
                scan: {
                  capture: isAndroid() ? capturePhotoForScan : null,
                  pick: isAndroid() ? null : pickPhotoForScan,
                  onNotice: (message) => uiStore.getState().showNotice(message),
                  // Text recognition (phase 7) is injected for the same
                  // reason: the engines are platform bridges, and the null on
                  // macOS/Linux is what makes the scan record "unavailable".
                  recognize: scanTextRecognizer(),
                  // "Debug insert": the same insert, plus every intermediate
                  // written into a dated folder BESIDE the board (app-local
                  // storage only for a never-saved board — see ui/scan-debug.ts).
                  // Injected for the same layering reason as the camera — the
                  // editor must not know about storage.
                  saveDebug: createScanDebugSaver(() => {
                    const t = tabsStore.getState().tabs.find((tab) => tab.id === tabId);
                    return t ? (t.filePath ?? t.notePath) : null;
                  }),
                  // The scan panel remembers its tuning across scans and
                  // relaunches; the settings store is the persistence, the
                  // panel never sees it directly (I9).
                  prefs: {
                    get: () => ({
                      preset: settingsStore.getState().settings.scanPreset,
                      smoothing: settingsStore.getState().settings.scanSmoothing,
                    }),
                    set: ({ preset, smoothing }) =>
                      settingsStore
                        .getState()
                        .update({ scanPreset: preset, scanSmoothing: smoothing }),
                  },
                },
              });
              registerWhiteboardAdapter(tabId, adapter);
              return adapter;
            },
          }
        : {
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
          };

    const sync = createModeSync({
      model: tab.model,
      host,
      initialMode: tab.mode,
      adapters: {
        ...familyAdapters,
        source: () => {
          const adapter = createCm6Adapter({
            wordWrap: settingsStore.getState().settings.wordWrap,
            lineNumbers: settingsStore.getState().settings.lineNumbers,
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
            // Raw mode on a whiteboard is an SVG source editor — highlight it
            // as XML, and drop the markdown-only auto-bullet behaviours.
            language: family === 'svg' ? 'xml' : 'markdown',
          });
          sourceAdapterRef.current = adapter;
          registerSourceAdapter(tabId, adapter);
          return adapter;
        },
      },
      onError: (error, failedMode) => {
        console.error(`[editor] ${failedMode} adapter failed`, error);
        uiStore.getState().showNotice(`Could not switch to ${failedMode} mode.`);
      },
    });

    tabsStore.getState().registerModeSync(tabId, sync);

    // Search "jump to line": a reveal parked for this tab's path (the file was
    // opened by search before any editor existed) fires once the initial
    // attach settles. In wysiwyg/read mode there is no source adapter — the
    // entry is still consumed and the tab just opens (accepted degrade).
    const pendingLine = takePendingReveal(tab.filePath ?? tab.notePath);
    if (pendingLine !== null) {
      void sync.whenIdle().then(() => {
        sourceAdapterRef.current?.revealLine(pendingLine);
      });
    }

    // Live word-wrap: reconfigure the (already-mounted) CM6 editor when the
    // setting flips, instead of re-creating it. No-op while the source editor
    // hasn't been created yet (a tab that opened straight into wysiwyg) — the
    // factory reads the current setting when it eventually runs.
    let lastWordWrap = settingsStore.getState().settings.wordWrap;
    let lastLineNumbers = settingsStore.getState().settings.lineNumbers;
    const unsubscribeSettings = settingsStore.subscribe((s) => {
      if (s.settings.wordWrap !== lastWordWrap) {
        lastWordWrap = s.settings.wordWrap;
        sourceAdapterRef.current?.setWordWrap(lastWordWrap);
      }
      if (s.settings.lineNumbers !== lastLineNumbers) {
        lastLineNumbers = s.settings.lineNumbers;
        sourceAdapterRef.current?.setLineNumbers(lastLineNumbers);
      }
    });

    return () => {
      unsubscribeSettings();
      unregisterSourceAdapter(tabId);
      unregisterWhiteboardAdapter(tabId);
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
      // A clicked diagram opens the fullscreen zoomable viewer.
      onOpenDiagram: (svg) => diagramViewerStore.getState().openWith(svg),
    });
    registerPreviewGoBack(tabId, () => pane.goBack());
    registerPreviewReveal(tabId, (index) => pane.scrollToHeading(index));
    const unsubscribeDark = subscribeDark((dark) => pane.setDark(dark));
    // A theme change that KEEPS the light/dark boolean (one light theme to
    // another) still recolours the `--wb-*` palette, which whiteboard images
    // bake into their data URLs — tell the pane so it re-inlines them.
    // setDark's render wins the race when both fire (same render sequence).
    let lastScheme = settingsStore.getState().settings.colorScheme;
    const unsubscribeScheme = settingsStore.subscribe(() => {
      const scheme = settingsStore.getState().settings.colorScheme;
      if (scheme !== lastScheme) {
        lastScheme = scheme;
        pane.refreshTheme();
      }
    });
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
      unsubscribeScheme();
      unsubscribePath();
      unregisterPreviewGoBack(tabId);
      unregisterPreviewReveal(tabId);
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
      // `display: none` on purpose, and deliberately NOT what a terminal tab
      // does (invariant I10, TerminalTab.tsx): a hidden CM6/preview must not
      // lay out, while a hidden terminal pane must keep its box or its pty is
      // resized to 1x1. Same problem, opposite right answer.
      style={{ display: active ? 'flex' : 'none' }}
      data-mode={mode satisfies EditorMode}
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
