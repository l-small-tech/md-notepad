/**
 * WindowControls — minimize / maximize-restore / close buttons for the
 * undecorated window on Windows and Linux (the TabBar row doubles as the
 * titlebar there; macOS keeps its native traffic lights via titleBarStyle
 * Overlay instead, so this component is not rendered on mac).
 *
 * Close goes through `window.close()`, which fires onCloseRequested — the
 * flush-then-destroy path in main.tsx — so live edits are never lost.
 */

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Null outside a Tauri webview (plain `vite` dev), so render degrades safely. */
function tauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function WindowControls() {
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
    // Maximize state can change without our buttons (Win+Up, snap, drag to
    // top edge, double-click on the drag region) — resize covers them all.
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

  return (
    <div className="window-controls">
      <button
        className="wc-btn"
        aria-label="Minimize"
        tabIndex={-1}
        onClick={() => void tauriWindow()?.minimize().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        className="wc-btn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        tabIndex={-1}
        onClick={() => void tauriWindow()?.toggleMaximize().catch(() => {})}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5v-2h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button
        className="wc-btn wc-close"
        aria-label="Close window"
        tabIndex={-1}
        onClick={() => void tauriWindow()?.close().catch(() => {})}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}
