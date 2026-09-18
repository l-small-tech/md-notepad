/**
 * Full screen and distraction-free — two INDEPENDENT view toggles, available
 * in every editor mode:
 *
 *   - Full screen (F11 / ⌃⌘F) makes the OS window fill the screen (Tauri
 *     `setFullscreen`, so the titlebar and taskbar disappear) and changes
 *     nothing else: the tabbar, ribbon and status bar stay exactly as they
 *     were. It is the OS-level toggle every other desktop app has.
 *   - Distraction-free (⤢ in the ribbon / app menu) hides the app chrome
 *     (tabbar, ribbon, status bar) and shows only the document; the OS window
 *     is left exactly where it was.
 *
 * Either can be on without the other, and both can be on at once. Escape
 * leaves distraction-free first (the innermost view), then full screen.
 *
 * On Android there is no OS full screen: the window already fills the screen,
 * so a full-screen request folds into the distraction-free toggle — the only
 * thing that can visibly change there — and the Tauri fullscreen/geometry
 * path is never touched on mobile.
 *
 * This module is the single writer of the ui-store `distractionFree` and
 * `osFullscreen` values, keeping the store side-effect free: every path
 * (ribbon button, floating exit cluster, app menu, F11, Escape) funnels
 * through here so the OS window state and the flag can never drift apart.
 *
 * Both flags are global view state, independent of the active tab: switching
 * mode (Review → Split), switching tabs, or closing a tab all keep them. There
 * is never a chrome-less view with no way out: desktop gets the floating
 * cluster (App.tsx) plus Esc, and touch/pen get the tap-and-hold menu
 * (components/FullscreenMenu), which works in every mode — including on a
 * whiteboard, whose stage swallows the gestures the cluster used to rely on.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import type { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { uiStore } from './stores/ui';
import { isAndroid } from './platform';

/**
 * Window geometry captured just before entering OS fullscreen. Windows does
 * NOT reliably put the window back where it was when leaving fullscreen (it
 * can jump to the top-left of the primary monitor), so we snapshot it here and
 * restore it on exit. Null while not in (or entering) OS fullscreen.
 */
let preFullscreen: { position: PhysicalPosition; size: PhysicalSize; maximized: boolean } | null =
  null;

/**
 * Serializes the OS-fullscreen enter/exit transitions. Each request that
 * touches the OS window chains its transition onto this promise so the next
 * can't start until the previous has fully settled. Without this, a rapid
 * toggle could let an `exit`'s `setFullscreen(false)` land BEFORE an in-flight
 * `enter`'s `setFullscreen(true)` (which awaits geometry reads first) — leaving
 * the window stuck fullscreen while the UI says otherwise — or let two calls
 * race on the single `preFullscreen` global. Serialized, the last-requested
 * state always wins because the chain preserves request order.
 */
let opChain: Promise<void> = Promise.resolve();

/** Enter OS fullscreen, remembering where the window was first. */
async function enterOsFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  try {
    // Guard: only snapshot when we don't already hold a saved geometry, so an
    // enter can never clobber a position captured by an earlier (still-pending)
    // enter with the already-fullscreen geometry.
    if (!preFullscreen) {
      preFullscreen = {
        position: await win.outerPosition(),
        size: await win.innerSize(),
        maximized: await win.isMaximized(),
      };
    }
    // A MAXIMIZED window must be restored before going fullscreen. tao keeps
    // the WS_MAXIMIZE style on the window while it applies the monitor-sized
    // bounds, and Windows clamps a maximized window to the work area — so the
    // "fullscreen" window stops above the taskbar, leaving a black strip where
    // it was. Unmaximizing first makes the bounds stick; the exit path
    // re-maximizes from the snapshot above.
    if (preFullscreen.maximized) {
      await win.unmaximize();
    }
    await win.setFullscreen(true);
  } catch {
    // No-op outside a Tauri webview (plain `vite`): the flag still flips, so
    // the feature degrades gracefully instead of throwing.
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
      // Windows restores the window's pre-snap placement asynchronously after
      // leaving fullscreen (a snapped window's "normal position" is wherever it
      // was before Win+Arrow), which stomps a single immediate setPosition.
      // Re-apply the saved geometry until it actually sticks.
      for (let attempt = 0; attempt < 8; attempt++) {
        await win.setPosition(saved.position);
        await win.setSize(saved.size);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const pos = await win.outerPosition();
        if (pos.x === saved.position.x && pos.y === saved.position.y) {
          break;
        }
      }
    }
  } catch {
    // Not in a Tauri webview — nothing to restore.
  }
}

/**
 * Queue an OS-fullscreen transition behind any already-pending one. Enter and
 * exit swallow their own errors, so the chain never rejects and later
 * transitions always run — the final applied OS state matches the latest
 * requested flag.
 */
function scheduleOsTransition(target: boolean): void {
  opChain = opChain.then(() => (target ? enterOsFullscreen() : exitOsFullscreen()));
}

/**
 * Show only the document (hide the tabbar, ribbon and status bar) or bring the
 * chrome back. Pure CSS — the OS window is never touched.
 */
export function setDistractionFree(on: boolean): void {
  const state = uiStore.getState();
  if (state.distractionFree === on) {
    return;
  }
  // Going distraction-free shuts the side panels: it means the document and
  // nothing else. They are no longer hidden by CSS while chrome-less (the
  // tap-and-hold menu can open either one from in there), so without this an
  // explorer left open would simply stay on screen.
  if (on) {
    state.closePanels();
  }
  state.setDistractionFree(on);
}

export function toggleDistractionFree(): void {
  setDistractionFree(!uiStore.getState().distractionFree);
}

/**
 * Make the OS window fill the screen, or give it back its frame. The app
 * chrome is untouched either way. On Android the window already fills the
 * screen, so this folds into the distraction-free toggle — the only thing
 * that can visibly change there.
 */
export function setOsFullscreen(on: boolean): void {
  if (isAndroid()) {
    setDistractionFree(on);
    return;
  }
  const state = uiStore.getState();
  if (state.osFullscreen === on) {
    return;
  }
  state.setOsFullscreen(on);
  // Save the geometry on the way into fullscreen and restore it on the way
  // out so Windows can't strand the window on the wrong monitor/side.
  scheduleOsTransition(on);
}

/** F11: toggle OS full screen (distraction-free on Android). */
export function toggleFullscreen(): void {
  setOsFullscreen(
    isAndroid() ? !uiStore.getState().distractionFree : !uiStore.getState().osFullscreen,
  );
}

/**
 * Escape: leave the innermost view. Distraction-free comes back first (the
 * chrome returns; the window stays fullscreen if it was), then full screen.
 * Returns false when neither was on, so the caller can let Escape through.
 */
export function escapeFullscreen(): boolean {
  const state = uiStore.getState();
  if (state.distractionFree) {
    setDistractionFree(false);
    return true;
  }
  if (state.osFullscreen) {
    setOsFullscreen(false);
    return true;
  }
  return false;
}
