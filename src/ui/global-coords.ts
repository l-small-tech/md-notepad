/**
 * Do Tauri's global coordinates mean anything on this platform?
 *
 * `cursorPosition()` and `outerPosition()` return real screen coordinates on
 * Windows and macOS. On Linux they don't get to matter: Wayland by protocol
 * design tells an app neither where the cursor is nor where its windows sit
 * (the calls return junk, not errors), and rather than carrying an X11-only
 * enablement nobody exercises, Linux is simply treated as coordinate-less —
 * tab drags there tear off (the pre-M8.5 behavior) and the context menu's
 * "Move to window …" rows are the route into an existing window.
 *
 * Two features gate on the answer: the cross-window tab-drop hit-test
 * (main.tsx `findDropWindow`) and the OS-level drag ghost window
 * (`ui/tab-drag-ghost.ts`), both of which would misbehave rather than fail
 * loudly if fed junk coordinates.
 */

import { isAndroid } from './platform';

/** Android's UA also reports Linux — and Android is single-window anyway. */
const IS_LINUX_DESKTOP = /linux/i.test(navigator.platform) && !isAndroid();

/** True when global cursor / window positions are real screen coordinates. */
export function globalCoordsTrusted(): boolean {
  return !IS_LINUX_DESKTOP;
}
