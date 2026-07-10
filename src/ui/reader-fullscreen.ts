/**
 * Reader full screen — READ mode's distraction-free view, in two stages:
 *
 *   normal ──⛶/F11──▶ window ──⛶/F11──▶ screen ──⛶/F11──▶ normal
 *
 * Stage 'window' hides the app chrome (tabbar, ribbon, status bar, explorer)
 * but leaves the OS window exactly where it was — a full-window reading view.
 * Stage 'screen' additionally makes the OS window truly fullscreen (Tauri
 * `setFullscreen`, so the titlebar/taskbar disappear). Escape steps BACK one
 * stage at a time, mirroring how the stages were entered.
 *
 * This module is the single writer of the ui-store `readerView` value,
 * keeping the store side-effect free: every path (ribbon button, floating
 * exit button, F11 / ⌃⌘F, Escape) funnels through here so the OS window
 * state and the stage can never drift apart.
 *
 * Only READ mode can enter; leaving read mode (mode switch, tab switch, tab
 * close) resets to 'normal' via the tabs-store subscription installed by
 * `initReaderFullscreen`.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabsStore } from './stores/tabs';
import { uiStore, type ReaderViewStage } from './stores/ui';

function apply(stage: ReaderViewStage): void {
  const previous = uiStore.getState().readerView;
  if (previous === stage) {
    return;
  }
  uiStore.getState().setReaderView(stage);
  // Only the 'screen' boundary touches the OS window; normal↔window is pure
  // CSS. No-op outside a Tauri webview (plain `vite`): the chrome still
  // hides, so the feature degrades gracefully instead of throwing.
  if (stage === 'screen' || previous === 'screen') {
    void getCurrentWindow()
      .setFullscreen(stage === 'screen')
      .catch(() => {});
  }
}

/** Advance one stage: normal → window → screen → normal (read mode only). */
export function cycleReaderView(): void {
  const stage = uiStore.getState().readerView;
  if (stage === 'window') {
    apply('screen');
    return;
  }
  if (stage === 'screen') {
    apply('normal');
    return;
  }
  const state = tabsStore.getState();
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active?.mode === 'read') {
    apply('window');
  }
}

/** Step back one stage (Escape): screen → window → normal. */
export function stepBackReaderView(): void {
  const stage = uiStore.getState().readerView;
  if (stage === 'screen') {
    apply('window');
  } else if (stage === 'window') {
    apply('normal');
  }
}

export function exitReaderView(): void {
  apply('normal');
}

/**
 * Auto-exit whenever the active tab is no longer in read mode — a mode
 * shortcut (mod+1/2/3), a tab switch, or closing the reading tab all land
 * back in the normal chrome instead of a fullscreen editor with no controls.
 */
export function initReaderFullscreen(): void {
  tabsStore.subscribe((state) => {
    if (uiStore.getState().readerView === 'normal') {
      return;
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (active?.mode !== 'read') {
      apply('normal');
    }
  });
}
