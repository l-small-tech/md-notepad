/**
 * Do Tauri's global coordinates mean anything on this platform?
 *
 * `cursorPosition()` and `outerPosition()` return real screen coordinates on
 * Windows, macOS and X11 — and junk on Wayland, which by protocol design
 * tells an app neither where the cursor is nor where its windows sit. Two
 * features gate on the answer: the cross-window tab-drop hit-test
 * (main.tsx `findDropWindow`) and the OS-level drag ghost window
 * (`ui/tab-drag-ghost.ts`), both of which would misbehave rather than fail
 * loudly if fed Wayland's junk.
 *
 * Linux starts pessimistic (features off) and flips on when the boot probe
 * finds the display server is X11 — including a Wayland session running the
 * app under XWayland via `GDK_BACKEND=x11`.
 */

import { ipc } from '../ipc/commands';
import { isAndroid } from './platform';

/** Android's UA also reports Linux — and Android is single-window anyway. */
const IS_LINUX_DESKTOP = /linux/i.test(navigator.platform) && !isAndroid();

let trusted = !IS_LINUX_DESKTOP;

/** True when global cursor / window positions are real screen coordinates. */
export function globalCoordsTrusted(): boolean {
  return trusted;
}

/**
 * Boot-time probe (main.tsx). Off the boot path on purpose: until the answer
 * arrives the gated features just stay off, which is the safe direction.
 */
export function initGlobalCoordTrust(): void {
  if (!IS_LINUX_DESKTOP) {
    return;
  }
  void ipc
    .displayServer()
    .then((server) => {
      trusted = server === 'x11';
    })
    .catch(() => {});
}
