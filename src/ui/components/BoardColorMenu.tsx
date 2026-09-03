/**
 * BoardColorMenu — the right-click menu on a whiteboard image inside a
 * markdown document (preview pane in read/split, rich editor). Switches the
 * clicked board between the app theme's colours and the colours it was drawn
 * or scanned with, and offers the same for every board the document
 * references. Each choice rewrites the `.svg` itself (the board's `colorMode`
 * metadata), so every viewer — and the draw editor — agrees afterwards.
 *
 * Positioned at the pointer, clamped to the viewport; the click-away overlay
 * and item styling are the explorer's context-menu classes.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { BoardColorMode } from '../../core/whiteboard/scene';
import { applyBoardColorMode } from '../board-color-mode';
import { boardColorMenuStore, useBoardColorMenu } from '../stores/board-color-menu';

const EDGE_GAP = 8;

export function BoardColorMenu() {
  const open = useBoardColorMenu((s) => s.open);
  if (!open) {
    return null;
  }
  return <BoardColorMenuBody />;
}

function BoardColorMenuBody() {
  const path = useBoardColorMenu((s) => s.path);
  const mode = useBoardColorMenu((s) => s.mode);
  const docPaths = useBoardColorMenu((s) => s.docPaths);
  const x = useBoardColorMenu((s) => s.x);
  const y = useBoardColorMenu((s) => s.y);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the whole menu on screen when the click lands near an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP));
    const top = Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP));
    setPos({ left, top });
  }, [x, y]);

  const close = () => boardColorMenuStore.getState().close();
  const run = (paths: readonly string[], next: BoardColorMode) => {
    close();
    void applyBoardColorMode(paths, next);
  };

  const others = docPaths.length > 1 || (docPaths.length === 1 && docPaths[0] !== path);

  return (
    <>
      <div className="context-menu-overlay" onClick={close} onContextMenu={close} />
      <div
        ref={ref}
        className="context-menu is-floating"
        role="menu"
        style={{ left: pos.left, top: pos.top }}
      >
        {path !== null && (
          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => run([path], mode === 'fixed' ? 'themed' : 'fixed')}
          >
            {mode === 'fixed' ? 'Use theme colours' : 'Use true colours'}
          </button>
        )}
        {others && (
          <>
            <div className="context-menu-separator" role="separator" />
            <div className="context-menu-heading">All boards in this document</div>
            <button
              className="context-menu-item"
              role="menuitem"
              onClick={() => run(docPaths, 'themed')}
            >
              Theme colours
            </button>
            <button
              className="context-menu-item"
              role="menuitem"
              onClick={() => run(docPaths, 'fixed')}
            >
              True colours
            </button>
          </>
        )}
      </div>
    </>
  );
}
