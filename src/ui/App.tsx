/**
 * App — the layout shell: TabBar / editor stack / StatusBar.
 *
 * All EditorHosts stay mounted (I7); only the active one is visible. When the
 * active tab changes, App focuses that tab's editor once its ModeSync has
 * finished its initial/last attach (whenIdle), so launch lands the caret in
 * the editor and tab switches keep focus in the right place.
 */

import { useEffect, useState } from 'react';
import { TabBar } from './components/TabBar';
import { Ribbon } from './components/Ribbon';
import { FileExplorer } from './components/FileExplorer';
import { OutlinePanel } from './components/OutlinePanel';
import { EditorHost } from './components/EditorHost';
import { ImageView } from './components/ImageView';
import { ImportView } from './components/ImportView';
import { TerminalTab } from './components/TerminalTab';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { ExportPreviewDialog } from './components/ExportPreviewDialog';
import { DiagramViewer } from './components/DiagramViewer';
import { CommandPalette } from './components/CommandPalette';
import { ExternalLinkPrompt } from './components/ExternalLinkPrompt';
import { SearchPanel } from './components/SearchPanel';
import { VoiceComments } from './components/VoiceComments';
import { FullscreenMenu, useFullscreenLongPress } from './components/FullscreenMenu';
import { ResizeBorders } from './components/ResizeBorders';
import { IS_MAC } from './components/AppMenu';
import { setFullscreen } from './fullscreen';
import { tabsStore, useTabsStore } from './stores/tabs';
import { useUiStore } from './stores/ui';
import { goBackPreview, usePreviewNav } from './stores/preview-nav';
import { isAndroid } from './platform';

export function App() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeMode = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.mode);
  const activeKind = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.kind);
  const fullscreenView = useUiStore((s) => s.fullscreenView);

  // Tap-and-hold anywhere in full screen opens the escape-hatch menu.
  useFullscreenLongPress(fullscreenView !== 'normal');

  useEffect(() => {
    const sync = tabsStore.getState().tabs.find((t) => t.id === activeTabId)?.modeSync;
    if (!sync) {
      return;
    }
    let cancelled = false;
    void sync.whenIdle().then(() => {
      if (cancelled || tabsStore.getState().activeTabId !== activeTabId) {
        return;
      }
      // Never yank focus out of an open text field. Opening a tab is async, so
      // this can resolve after an inline rename input has taken focus (the
      // explorer's "New file" does exactly that) — stealing it there would fire
      // the input's blur-commit and cancel the rename the user never got to type.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return;
      }
      sync.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [activeTabId]);

  // A terminal tab is not a document: the ribbon, explorer, outline and status
  // bar all read editor state it does not have, so they are NOT RENDERED (not
  // merely hidden) while one is in front. Their open/closed flags in uiStore
  // are untouched, so switching back to a document restores exactly what was
  // there. The TabBar stays — it is the window titlebar.
  const terminalActive = activeKind === 'terminal';

  return (
    <div
      className={fullscreenView === 'normal' ? 'app' : 'app app-fullscreen'}
      data-tab-kind={activeKind ?? 'note'}
    >
      <TabBar />
      {!terminalActive && <Ribbon />}
      <div className="editor-area">
        {!terminalActive && <FileExplorer />}
        <div className="editor-stack">
          {tabs.map((tab) =>
            // A tab's kind never changes, so each branch is stable per key and
            // never remounts an editor (I7 holds).
            tab.kind === 'image' ? (
              <ImageView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'import' ? (
              <ImportView key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : tab.kind === 'terminal' ? (
              <TerminalTab key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ) : (
              <EditorHost key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ),
          )}
        </div>
        {!terminalActive && <OutlinePanel />}
      </div>
      {!terminalActive && <StatusBar />}
      <SettingsDialog />
      <ExportPreviewDialog />
      <DiagramViewer />
      <CommandPalette />
      <ExternalLinkPrompt />
      <SearchPanel />
      <VoiceComments />
      {/* Desktop keeps the hover-revealed cluster; Android's way out is the
          tap-and-hold menu (which works on a board too, where the old
          double-tap-the-edge gesture never reached the window). */}
      {fullscreenView !== 'normal' && !isAndroid() && <FullscreenControls stage={fullscreenView} />}
      <FullscreenMenu />
      {/* The 'window' stage hides all chrome and leaves the OS window in place, so
          there's no titlebar to grab. A strip over the top of the view doubles as
          the grab-to-move handle in every mode. It fires only on itself, so content
          below stays interactive. In Read mode it's tall (~3 lines of top
          whitespace); in edit modes it's titlebar-height so it doesn't swallow the
          first editor lines. Android has no draggable OS window, so it's
          desktop-only. */}
      {fullscreenView === 'window' && !isAndroid() && (
        <div
          className={`fullscreen-drag-strip${activeMode === 'read' ? ' fullscreen-drag-strip-read' : ''}`}
          data-tauri-drag-region=""
        />
      )}
      {/* Custom resize hitboxes for the undecorated window (macOS keeps native
          decorations; the 'screen' stage is truly fullscreen — nothing to
          resize). Rendered last so the strips layer over all chrome. */}
      {fullscreenView !== 'screen' && !IS_MAC && !isAndroid() && <ResizeBorders />}
    </div>
  );
}

/**
 * The chrome (with the ribbon's fullscreen button) is hidden in full screen, so
 * this floating cluster is the DESKTOP way back. F11 cycles stages and Esc steps
 * back; the cluster holds the stage toggle for the stage you're NOT in (⛶ = full
 * screen from 'window', ⤢ = full window from 'screen'), an exit ✕, and — when
 * browsing a followed link in the preview — a ← Back that pops the page. Back
 * lives here (not as an in-pane bar) in full screen so it hides with the rest.
 *
 * The cluster is tucked just above the top-CENTER edge and slides down when
 * summoned. Nothing spans the full width (that full-width reveal bar read as
 * cheap/janky). Window dragging in the 'window' stage lives in a separate strip
 * over the top of the view (see App), not here.
 *
 * Reveal is JS-driven (not `:hover`) so the cluster survives the pointer
 * overshooting the top edge: it appears while the pointer is in the top reveal
 * zone and, once the pointer drops below, lingers briefly then hides.
 * `:focus-within` (CSS) also holds it open so it's reachable by keyboard.
 *
 * Android has no cluster at all — the tap-and-hold menu (FullscreenMenu) is its
 * single, mode-independent way out, including on a whiteboard.
 */
function FullscreenControls({ stage }: { stage: 'window' | 'screen' }) {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const canGoBack = usePreviewNav(
    (s) => (activeTabId != null && s.canGoBack[activeTabId]) || false,
  );
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const HIDE_MS = 600; // linger before auto-hiding
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    // Local mirror of the reveal state — lets the listener gate on "currently
    // shown" without a render-time ref read (setRevealed is the only writer).
    let shown = false;
    const clearHide = () => {
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };
    const show = () => {
      clearHide();
      shown = true;
      setRevealed(true);
    };
    const hide = () => {
      clearHide();
      shown = false;
      setRevealed(false);
    };
    const scheduleHide = () => {
      clearHide();
      hideTimer = setTimeout(hide, HIDE_MS);
    };

    // Reveal near the top; once the pointer drops below the zone, a single
    // linger timer hides it (continued movement below doesn't reset it, so it
    // hides promptly instead of clinging while the mouse wanders).
    const REVEAL_Y = 72;
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= REVEAL_Y) {
        show();
      } else if (shown && hideTimer === undefined) {
        scheduleHide();
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearHide();
    };
  }, []);

  const buttons = (
    <>
      {canGoBack && (
        <button
          className="fullscreen-btn"
          aria-label="Back"
          title="Back"
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
      {/* The stage toggle (full window ⇄ full screen). */}
      {stage === 'screen' ? (
        <button
          className="fullscreen-btn"
          aria-label="Full window"
          title="Full window (Esc)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFullscreen('window')}
        >
          ⤢
        </button>
      ) : (
        <button
          className="fullscreen-btn"
          aria-label="Full screen"
          title="Full screen (F11)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFullscreen('screen')}
        >
          ⛶
        </button>
      )}
      <button
        className="fullscreen-btn"
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setFullscreen('normal')}
      >
        ✕
      </button>
    </>
  );

  return <div className={`fullscreen-topcenter${revealed ? ' is-revealed' : ''}`}>{buttons}</div>;
}
