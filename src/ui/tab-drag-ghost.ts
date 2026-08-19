/**
 * The OS-level tab drag ghost (M8) — the part of the drag image a webview
 * cannot draw.
 *
 * TabBar's DOM ghost dies at the window edge: a DOM element can only paint
 * inside its own window. So while a tab drag is outside the window, the ghost
 * becomes a WINDOW — a tiny undecorated, always-on-top, click-through,
 * non-focusable webview (label `ghost-<source label>`) that renders just the
 * tab pill and follows the global cursor, riding over the desktop and other
 * windows the way Chrome's dragged tab does.
 *
 * Lifecycle: spawned hidden the moment a press becomes a drag (so it is ready
 * before the cursor ever leaves), shown/hidden as the pointer crosses the
 * window edge, destroyed on release. It never boots the app: main.tsx routes
 * `?ghost=1` to {@link renderOsGhostPage}, which renders the pill and stops —
 * no session controller, no manifest, nothing to resurrect at next launch.
 * Everyone else ignores these windows: the drop hit-test, the "Move to
 * window" list and the close-handoff all skip `ghost-*` labels, and the
 * window-state plugin is filtered off them (src-tauri/src/lib.rs).
 *
 * Platform gate ({@link osGhostAvailable}): Windows only — the one platform
 * with all three prerequisites: real global cursor coordinates (Linux/Wayland
 * has none, and an app there cannot draw outside its windows at all),
 * app-positioned windows, and transparent webviews without extra flags
 * (macOS would need the private-API flag this app doesn't enable). TabBar
 * gates the in-window DOM ghost on the same answer, so platforms that can't
 * complete the picture show no half-ghost that dies at the window edge.
 */

import { cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isWindows } from './platform';

/** Logical px; matches the strip's tab height (38px bar − 6px card float). */
const GHOST_HEIGHT = 32;

interface OsGhost {
  win: WebviewWindow;
  /** Where inside the pill the cursor grips it, in logical px. */
  grabX: number;
  grabY: number;
  /** The webview finished creating (safe to show / configure). */
  ready: boolean;
  /** What TabBar last asked for; applied on ready if it arrived early. */
  wantVisible: boolean;
  visible: boolean;
  dead: boolean;
}

let current: OsGhost | null = null;

/** Whether this platform can float a ghost window over the desktop at all. */
export function osGhostAvailable(): boolean {
  return isWindows();
}

/**
 * One positioning step ≈ one frame: global cursor (physical px) → window
 * position, keeping the cursor on the pill's grab point. Self-reschedules
 * until the ghost dies. Every call is best-effort — a window mid-creation or
 * mid-teardown just skips a frame.
 */
function follow(g: OsGhost): void {
  if (g.dead) {
    return;
  }
  requestAnimationFrame(() => {
    void (async () => {
      try {
        const cursor = await cursorPosition();
        const scale = window.devicePixelRatio || 1;
        await g.win.setPosition(
          new PhysicalPosition(
            Math.round(cursor.x - g.grabX * scale),
            Math.round(cursor.y - g.grabY * scale),
          ),
        );
      } catch {
        // Not created yet, or being destroyed — skip this frame.
      }
      follow(g);
    })();
  });
}

/**
 * Spawn the (hidden) ghost for a drag that just started. No-op where the
 * platform gate is closed; a spawn failure just means this drag has no OS
 * ghost (the in-window DOM ghost still runs). `width` is the grabbed tab's
 * rendered width, `grabX`/`grabY` the press point inside it — all logical px.
 */
export function startOsGhost(info: {
  title: string;
  width: number;
  grabX: number;
  grabY: number;
}): void {
  if (!osGhostAvailable()) {
    return;
  }
  endOsGhost(); // a stale ghost from an aborted drag must not linger
  const url =
    `index.html?ghost=1&title=${encodeURIComponent(info.title)}` +
    `&width=${Math.round(info.width)}`;
  let g: OsGhost;
  try {
    const win = new WebviewWindow(`ghost-${getCurrentWindow().label}`, {
      url,
      width: Math.round(info.width),
      height: GHOST_HEIGHT,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      focusable: false,
      visible: false,
    });
    g = {
      win,
      grabX: info.grabX,
      grabY: info.grabY,
      ready: false,
      wantVisible: false,
      visible: false,
      dead: false,
    };
  } catch {
    return; // e.g. the previous ghost's teardown still owns the label
  }
  current = g;
  void g.win
    .once('tauri://created', () => {
      if (g.dead) {
        return;
      }
      g.ready = true;
      // Click-through, so the window glued to the cursor can never swallow
      // the release. Belt and braces — the drop hit-test skips ghost-*
      // labels, and the source window's implicit grab keeps the events —
      // but a stray OS hit on it would end the drag invisibly.
      void g.win.setIgnoreCursorEvents(true).catch(() => {});
      if (g.wantVisible && !g.visible) {
        g.visible = true;
        void g.win.show().catch(() => {});
      }
    })
    .catch(() => {});
  void g.win.once('tauri://error', () => endOsGhost()).catch(() => {});
  follow(g);
}

/** TabBar per pointermove: the pointer crossed the window edge (or back). */
export function setOsGhostOutside(outside: boolean): void {
  const g = current;
  if (!g || g.dead) {
    return;
  }
  g.wantVisible = outside;
  if (!g.ready || g.visible === outside) {
    return;
  }
  g.visible = outside;
  void (outside ? g.win.show() : g.win.hide()).catch(() => {});
}

/** Drag over (drop, cancel, or a new drag superseding) — tear the ghost down. */
export function endOsGhost(): void {
  const g = current;
  if (!g) {
    return;
  }
  current = null;
  g.dead = true;
  void g.win.destroy().catch(() => {});
}

/**
 * The ghost window's entire frontend, called from main.tsx instead of boot
 * when `?ghost=1` is in the URL: paint the pill described by the params on a
 * transparent page, then do nothing forever. Styling rides the classes the
 * in-window DOM ghost already uses (app.css `.tab-drag-ghost` /
 * `.tab-os-ghost`), so the two ghosts cannot drift apart visually.
 */
export function renderOsGhostPage(params: URLSearchParams): void {
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  const pill = document.createElement('div');
  pill.className = 'tab tab-drag-ghost tab-os-ghost';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = params.get('title') ?? '';
  pill.appendChild(title);
  document.body.appendChild(pill);
}
