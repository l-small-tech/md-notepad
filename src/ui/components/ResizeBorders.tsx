/**
 * ResizeBorders — invisible edge/corner strips that resize the undecorated
 * window on Windows and Linux (macOS keeps native decorations, Android has no
 * resizable window).
 *
 * With `decorations: false` the only built-in resize affordance is tao's ~5px
 * borderless inset, which is unreliable on Linux and loses the top edge to the
 * TabBar's `data-tauri-drag-region`. These strips sit above all chrome
 * (z-index) and hand the gesture to the OS via `startResizeDragging`, so every
 * edge gets the same, larger hitbox. They unmount while the window is
 * maximized — there is nothing to resize, and the top strip would otherwise
 * steal clicks from tabs pushed against the screen edge.
 */

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Direction =
  'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

const HANDLES: ReadonlyArray<{ dir: Direction; className: string }> = [
  { dir: 'North', className: 'rb-n' },
  { dir: 'South', className: 'rb-s' },
  { dir: 'East', className: 'rb-e' },
  { dir: 'West', className: 'rb-w' },
  { dir: 'NorthEast', className: 'rb-ne' },
  { dir: 'NorthWest', className: 'rb-nw' },
  { dir: 'SouthEast', className: 'rb-se' },
  { dir: 'SouthWest', className: 'rb-sw' },
];

/** Null outside a Tauri webview (plain `vite` dev), so render degrades safely. */
function tauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function ResizeBorders() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = tauriWindow();
    if (!win) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const sync = () =>
      void win
        .isMaximized()
        .then((m) => {
          if (!disposed) {
            setMaximized(m);
          }
        })
        .catch(() => {});
    sync();
    void win
      .onResized(sync)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (maximized) {
    return null;
  }

  return (
    <>
      {HANDLES.map(({ dir, className }) => (
        <div
          key={dir}
          className={`resize-border ${className}`}
          onMouseDown={(e) => {
            if (e.button !== 0) {
              return;
            }
            e.preventDefault();
            void tauriWindow()
              ?.startResizeDragging(dir)
              .catch(() => {});
          }}
        />
      ))}
    </>
  );
}
