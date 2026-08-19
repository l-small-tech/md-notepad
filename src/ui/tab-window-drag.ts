/**
 * Live tear-off window motion (M8.6) — the Chrome trick, applied.
 *
 * Chrome never drags a *ghost* between windows: the moment a tab is pulled
 * vertically out of the strip it becomes a real window, and the cursor drags
 * THAT. This module is the motion half of our version — TabBar decides when
 * to tear (the vertical threshold) and the session controller moves the tab;
 * what lives here is how the freshly spawned window then rides the cursor.
 *
 * Windows/macOS only (`globalCoordsTrusted()`): the same follow loop the OS
 * drag ghost uses (`tab-drag-ghost.ts`) — global cursor (physical px) →
 * `setPosition` every frame — pointed at the real window. The source window
 * keeps the pointer (capture), so it also keeps the release: the drop can
 * still land the tab in another window (session `dropTornWindow`).
 *
 * Linux deliberately has NO live tear-off (it keeps the release-time path).
 * The compositor route — spawn unpositioned, then `startDragging` the new
 * window — was tried and reverted: Wayland forbids placing the window at the
 * cursor, so even a compositor that honors the cross-surface move (KWin)
 * moves a window the cursor was never holding — it appears elsewhere and
 * rides out of sync, which reads as broken.
 *
 * A window's ONLY tab never tears where live tear-off exists: dragging it
 * vertically moves the whole window ({@link startWholeWindowDrag}), Chrome
 * parity — the move starts from the pressed window's own pointer grab.
 */

import { cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** The one live follow loop; a new drag stops any stale one. */
let follow: { stop: boolean } | null = null;

/**
 * Glue the torn-off window `label` to the global cursor until
 * {@link stopTornWindowFollow}. `holdX`/`holdY` are where inside the window
 * the cursor grips it (logical px — the point that keeps the cursor on the
 * new window's own tab). Every frame is best-effort: a window mid-creation
 * or mid-close just skips one.
 */
export function startTornWindowFollow(label: string, holdX: number, holdY: number): void {
  stopTornWindowFollow();
  const state = { stop: false };
  follow = state;
  void WebviewWindow.getByLabel(label)
    .then((win) => {
      if (!win) {
        return;
      }
      const step = (): void => {
        if (state.stop) {
          return;
        }
        requestAnimationFrame(() => {
          void (async () => {
            try {
              const cursor = await cursorPosition();
              // Same scale caveat as the ghost: physical cursor, logical grip
              // — assume the torn-off window shares this window's monitor
              // scale for the duration of the drag.
              const scale = window.devicePixelRatio || 1;
              await win.setPosition(
                new PhysicalPosition(
                  Math.round(cursor.x - holdX * scale),
                  Math.round(cursor.y - holdY * scale),
                ),
              );
            } catch {
              // Mid-close or mid-move-to-window — skip this frame.
            }
            step();
          })();
        });
      };
      step();
    })
    .catch(() => {});
}

/** The drag released (or was cancelled) — let go of the torn-off window. */
export function stopTornWindowFollow(): void {
  if (follow) {
    follow.stop = true;
  }
  follow = null;
}

/**
 * Dragging a window's only tab drags the WINDOW: the move starts from this
 * window's own pointer grab.
 */
export function startWholeWindowDrag(): void {
  void getCurrentWindow()
    .startDragging()
    .catch(() => {});
}
