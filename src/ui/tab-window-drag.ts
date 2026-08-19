/**
 * Live tear-off window motion (M8.6) — the Chrome trick, applied.
 *
 * Chrome never drags a *ghost* between windows: the moment a tab is pulled
 * vertically out of the strip it becomes a real window, and the cursor drags
 * THAT. This module is the motion half of our version — TabBar decides when
 * to tear (the vertical threshold) and the session controller moves the tab;
 * what lives here is how the freshly spawned window then rides the cursor,
 * per platform:
 *
 * - Windows/macOS (`globalCoordsTrusted()`): the same follow loop the OS drag
 *   ghost uses (`tab-drag-ghost.ts`) — global cursor (physical px) →
 *   `setPosition` every frame — pointed at the real window. The source window
 *   keeps the pointer (capture), so it also keeps the release: the drop can
 *   still land the tab in another window (session `dropTornWindow`).
 * - Linux: no global cursor, no app-side positioning — instead ask the
 *   COMPOSITOR to move the window (`startDragging`, i.e. xdg_toplevel.move /
 *   _NET_WM_MOVERESIZE) while the button is still held. Compositors are free
 *   to refuse a move started from another surface's grab (GNOME does); the
 *   degrade is the window simply standing where the compositor placed it,
 *   already holding the tab — never a lost tab.
 *
 * A window's ONLY tab never tears: dragging it vertically moves the whole
 * window ({@link startWholeWindowDrag}) — Chrome parity, and the one variant
 * every platform including Wayland supports (the move starts from this
 * window's own pointer grab, so the compositor honors it).
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
 * Linux: hand the torn-off window to the compositor's interactive move while
 * the mouse button is still held. Best-effort by design — see the header.
 */
export function beginCompositorWindowDrag(label: string): void {
  void WebviewWindow.getByLabel(label)
    .then((win) => win?.startDragging())
    .catch(() => {});
}

/**
 * Dragging a window's only tab drags the WINDOW (all platforms): the move
 * starts from this window's own pointer grab, which even Wayland honors.
 */
export function startWholeWindowDrag(): void {
  void getCurrentWindow()
    .startDragging()
    .catch(() => {});
}
