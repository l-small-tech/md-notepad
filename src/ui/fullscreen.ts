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
 * Distraction-free shuts the side panels on the way in, but they can be pulled
 * back out from inside it — the workspace pane above all, since Review mode
 * there is how a knowledge base gets read and that means changing files
 * (desktop: App's left-edge pull tab and the cluster's folder button; touch:
 * the tap-and-hold menu). Escape puts such a panel away before anything else.
 *
 * On Android there is no OS full screen: the window already fills the screen,
 * so a full-screen request folds into the distraction-free toggle — the only
 * thing that can visibly change there — and the Tauri fullscreen/geometry
 * path is never touched on mobile.
 *
 * OS fullscreen on Windows is fragile in one specific way: a MAXIMIZE applied
 * to the fullscreen window (tao keeps the borderless window plain, and Windows
 * clamps a maximized window to the work area) leaves a black strip where the
 * taskbar was and a half-restored window on the way out. So nothing in the
 * app may maximize or drag the window while fullscreen — the tabbar's drag
 * region and maximize button are inert then (TabBar / WindowControls) — and a
 * resize watcher undoes a maximize the shell applies anyway (Win+Up, snap).
 * The close path (`leaveOsFullscreenForClose`) leaves fullscreen before the
 * window-state plugin can persist the monitor rect as the window's size.
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

import { currentMonitor, getCurrentWindow, type Window } from '@tauri-apps/api/window';
import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';
import { uiStore } from './stores/ui';
import { isAndroid } from './platform';

/**
 * Whether the window was MAXIMIZED when OS fullscreen was entered, so exit can
 * put it back. Null while not in (or entering) OS fullscreen.
 *
 * Nothing else is snapshotted on purpose. tao saves the window's own
 * WINDOWPLACEMENT on the way in and restores it on the way out, and that
 * placement is where Windows keeps snap state (Win+Arrow): a snapped window's
 * "normal position" is where it sat before the snap, and Windows itself moves
 * the window back to its arranged rect. Re-applying our own position/size on
 * top of that — as an earlier version did — left the window at the right
 * pixels but no longer *arranged* as far as the shell was concerned, which is
 * what broke Win+Arrow after a fullscreen round trip.
 */
let preFullscreen: { maximized: boolean } | null = null;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make sure the fullscreen window really covers its monitor. tao applies the
 * monitor bounds with an ASYNC SetWindowPos, and on Windows a restore
 * animation or the shell can still land after it and leave the window at the
 * work-area height — the same black strip along the taskbar edge, just
 * intermittent. Re-assert the monitor rect (which also re-sizes the webview
 * to it) until the inner size matches; a few short rounds are plenty.
 */
async function settleFullscreenBounds(win: Window): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const monitor = await currentMonitor();
    if (!monitor) {
      return;
    }
    const size = await win.innerSize();
    if (size.width === monitor.size.width && size.height === monitor.size.height) {
      return;
    }
    await win.setPosition(monitor.position);
    await win.setSize(monitor.size);
    await sleep(60);
  }
}

/**
 * Undo a maximize that landed on the FULLSCREEN window. Nothing in the app
 * asks for one (the tabbar's drag region and maximize button are inert while
 * fullscreen — see components/TabBar and components/WindowControls), but the
 * shell still can: Win+Up, Win+Shift+Up, a snap gesture. tao then
 * `SW_MAXIMIZE`s the borderless window and Windows clamps it to the WORK AREA,
 * which is the black strip along the taskbar edge — and the WS_MAXIMIZE style
 * it leaves behind makes the later exit's placement restore fight the
 * re-maximize. Restoring puts the window back on tao's saved "normal" rect
 * (the monitor bounds), which the settle loop then re-asserts.
 */
async function unmaximizeIfFullscreenGotMaximized(win: Window): Promise<boolean> {
  if (!(await win.isMaximized())) {
    return false;
  }
  await win.unmaximize();
  return true;
}

/**
 * Stop function for the resize watcher installed while OS fullscreen (null
 * while not). The watcher catches a maximize the shell applied to the
 * fullscreen window and repairs it in place; see
 * `unmaximizeIfFullscreenGotMaximized`.
 */
let stopFullscreenWatch: (() => void) | null = null;

/** Whether a watcher-triggered repair is already running (they must not stack). */
let repairing = false;

async function watchFullscreenWindow(win: Window): Promise<void> {
  if (stopFullscreenWatch) {
    return;
  }
  let stopped = false;
  stopFullscreenWatch = () => {
    stopped = true;
  };
  const unlisten = await win.onResized(() => {
    // A pending exit will restore the placement itself; repairing on top of it
    // would re-assert the monitor rect on a window that is about to leave.
    if (stopped || repairing || !uiStore.getState().osFullscreen) {
      return;
    }
    repairing = true;
    void (async () => {
      try {
        if (await unmaximizeIfFullscreenGotMaximized(win)) {
          await settleFullscreenBounds(win);
        }
      } catch {
        // Not in a Tauri webview — nothing to repair.
      } finally {
        repairing = false;
      }
    })();
  });
  if (stopped) {
    unlisten();
  } else {
    stopFullscreenWatch = () => {
      stopped = true;
      unlisten();
    };
  }
}

/** Enter OS fullscreen, remembering whether the window was maximized first. */
async function enterOsFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  try {
    // Guard: only snapshot when we don't already hold one, so an enter can
    // never clobber the state captured by an earlier (still-pending) enter.
    if (!preFullscreen) {
      preFullscreen = { maximized: await win.isMaximized() };
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
    await settleFullscreenBounds(win);
    await watchFullscreenWindow(win);
  } catch {
    // No-op outside a Tauri webview (plain `vite`): the flag still flips, so
    // the feature degrades gracefully instead of throwing.
  }
}

/** Leave OS fullscreen; tao puts the window back where it was. */
async function exitOsFullscreen(): Promise<void> {
  const win = getCurrentWindow();
  const saved = preFullscreen;
  preFullscreen = null;
  stopFullscreenWatch?.();
  stopFullscreenWatch = null;
  try {
    // A maximize that landed while fullscreen (see the watcher) must be undone
    // BEFORE tao restores its saved placement: tao's own MAXIMIZED flag is set
    // by then, and `SetWindowPlacement` under a WS_MAXIMIZE style leaves the
    // window half-restored — the frame at the normal rect, the style and the
    // shell's idea of it still "maximized".
    await unmaximizeIfFullscreenGotMaximized(win);
    await win.setFullscreen(false);
    // We unmaximized on the way in, so this is the one thing tao's placement
    // restore cannot know to undo.
    if (saved?.maximized) {
      await win.maximize();
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

/**
 * Close path: leave OS fullscreen before the window goes, and re-save the
 * window state once it has settled.
 *
 * The window-state plugin snapshots geometry at close-requested — while
 * fullscreen that is the MONITOR rect, and the plugin does not know fullscreen
 * from a big window. Saved as-is, the next launch opens a monitor-sized,
 * un-maximized window at the monitor origin: its bottom under the taskbar,
 * its edges past the screen, and the next F11 round trip "restores" to the
 * same rect. Exiting first lets tao restore the real placement; the explicit
 * save then records it (and the re-applied maximize, which the plugin's own
 * resize listener skips over) in place of the fullscreen snapshot.
 *
 * Resolves once the exit transition — and everything queued before it — has
 * run, so the caller can await it before destroying the window. Nothing to do
 * when the window is not fullscreen (Android included).
 */
export async function leaveOsFullscreenForClose(): Promise<void> {
  if (isAndroid() || !uiStore.getState().osFullscreen) {
    return;
  }
  setOsFullscreen(false);
  await opChain;
  try {
    await saveWindowState(StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED);
  } catch {
    // Outside a Tauri webview, or the plugin is absent — the close proceeds.
  }
}

/** F11: toggle OS full screen (distraction-free on Android). */
export function toggleFullscreen(): void {
  setOsFullscreen(
    isAndroid() ? !uiStore.getState().distractionFree : !uiStore.getState().osFullscreen,
  );
}

/**
 * Escape: leave the innermost view. A side panel pulled out while
 * distraction-free goes first (back to the document and nothing else), then
 * distraction-free (the chrome returns; the window stays fullscreen if it
 * was), then full screen. Returns false when neither was on, so the caller can
 * let Escape through.
 */
export function escapeFullscreen(): boolean {
  const state = uiStore.getState();
  if (state.distractionFree && (state.explorerOpen || state.outlineOpen)) {
    state.closePanels();
    return true;
  }
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
