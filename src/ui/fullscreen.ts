/**
 * Full screen — a distraction-free view available in every editor mode, in
 * two stages:
 *
 *   normal ──⛶/F11──▶ window ──⛶/F11──▶ screen ──⛶/F11──▶ normal
 *
 * Stage 'window' hides the app chrome (tabbar, ribbon, status bar, explorer)
 * but leaves the OS window exactly where it was — a full-window view of the
 * active tab. Stage 'screen' additionally makes the OS window truly fullscreen
 * (Tauri `setFullscreen`, so the titlebar/taskbar disappear). Escape steps
 * BACK one stage at a time, mirroring how the stages were entered.
 *
 * This module is the single writer of the ui-store `fullscreenView` value,
 * keeping the store side-effect free: every path (ribbon button, floating
 * exit button, F11 / ⌃⌘F, Escape) funnels through here so the OS window
 * state and the stage can never drift apart.
 *
 * The stage is a global view state, independent of the active tab: switching
 * mode (Read → Split), switching tabs, or closing a tab all keep the current
 * stage. The floating exit controls (App.tsx) show in every mode, so there is
 * never a fullscreen tab with no way out.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import type { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { uiStore, type FullscreenStage } from './stores/ui';

/**
 * Window geometry captured just before entering OS fullscreen. Windows does
 * NOT reliably put the window back where it was when leaving fullscreen (it
 * can jump to the top-left of the primary monitor), so we snapshot it here and
 * restore it on exit. Null while not in (or entering) the 'screen' stage.
 */
let preFullscreen: { position: PhysicalPosition; size: PhysicalSize; maximized: boolean } | null =
  null;

/** Enter OS fullscreen, remembering where the window was first. */
async function enterOsFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  try {
    preFullscreen = {
      position: await win.outerPosition(),
      size: await win.innerSize(),
      maximized: await win.isMaximized(),
    };
    await win.setFullscreen(true);
  } catch {
    // No-op outside a Tauri webview (plain `vite`): the chrome still hides via
    // CSS, so the feature degrades gracefully instead of throwing.
  }
}

/** Leave OS fullscreen and put the window back exactly where it was. */
async function exitOsFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  const saved = preFullscreen;
  preFullscreen = null;
  try {
    await win.setFullscreen(false);
    if (!saved) {
      return;
    }
    // A maximized window has no meaningful free-floating position to restore —
    // re-maximizing puts it back to fill the monitor it was on. Otherwise pin
    // the exact position/size Windows would otherwise have dropped.
    if (saved.maximized) {
      await win.maximize();
    } else {
      await win.setPosition(saved.position);
      await win.setSize(saved.size);
    }
  } catch {
    // Not in a Tauri webview — nothing to restore.
  }
}

function apply(stage: FullscreenStage): void {
  const previous = uiStore.getState().fullscreenView;
  if (previous === stage) {
    return;
  }
  uiStore.getState().setFullscreenView(stage);
  // Only the 'screen' boundary touches the OS window; normal↔window is pure
  // CSS. Save the geometry on the way into fullscreen and restore it on the
  // way out so Windows can't strand the window on the wrong monitor/side.
  if (stage === 'screen') {
    void enterOsFullscreen();
  } else if (previous === 'screen') {
    void exitOsFullscreen();
  }
}

/**
 * Jump straight to a stage. The mouse controls use this so each glyph has one
 * fixed destination (⤢ → 'window', ⛶ → 'screen', ✕ → 'normal') no matter the
 * current stage; only the keyboard (F11 / Esc) steps through stages.
 */
export function setFullscreen(stage: FullscreenStage): void {
  apply(stage);
}

/** Advance one stage (F11): normal → window → screen → normal. */
export function cycleFullscreen(): void {
  const stage = uiStore.getState().fullscreenView;
  if (stage === 'window') {
    apply('screen');
  } else if (stage === 'screen') {
    apply('normal');
  } else {
    apply('window');
  }
}

/** Step back one stage (Escape): screen → window → normal. */
export function stepBackFullscreen(): void {
  const stage = uiStore.getState().fullscreenView;
  if (stage === 'screen') {
    apply('window');
  } else if (stage === 'window') {
    apply('normal');
  }
}
