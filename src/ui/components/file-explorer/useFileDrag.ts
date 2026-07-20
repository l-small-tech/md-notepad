/**
 * The FileExplorer's pointer drag state machine: the drawer-resize drag on the
 * right-edge divider and the pointer-based file-move drag (see FileExplorer's
 * header comment for why raw pointer events, not HTML5 drag-and-drop).
 */

import { useRef } from 'react';
import { isImagePath } from '../../../core/images';
import { appendImagesToMd, moveExplorerEntryInto } from '../../session';
import { uiStore } from '../../stores/ui';
import { clampExplorerWidth, DRAG_THRESHOLD_PX } from './helpers';

/**
 * Drawer width in px — module scope, not React state: dragging fires on every
 * pointermove and must not re-render; session-only, like the split ratio.
 */
let explorerWidth = 220;

export function useFileDrag() {
  const rootRef = useRef<HTMLDivElement>(null);
  /** True for the single click event that trails a completed row drag. */
  const dragConsumedClick = useRef(false);

  function startResizeDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const drawer = rootRef.current;
    if (!drawer) {
      return;
    }
    const left = drawer.getBoundingClientRect().left;
    function onMove(moveEvent: PointerEvent): void {
      explorerWidth = clampExplorerWidth(moveEvent.clientX - left);
      drawer!.style.width = `${explorerWidth}px`;
    }
    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      // A pointercancel mid-resize (touch/pen, or the OS stealing the pointer)
      // must tear down the same listeners — otherwise they leak and the drawer
      // keeps resizing on every later move. Mirrors startFileDrag's cleanup.
      window.removeEventListener('pointercancel', cleanup);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }

  /**
   * Pointer-based file move (see the file header for why not HTML5 DnD).
   * A press on a file row becomes a drag once the pointer travels past the
   * threshold; while dragging, the hovered `data-drop-dir` gets the same
   * highlight OS drops use, and releasing over one hands the move to the
   * controller (which confirms, guards collisions, and retargets tabs).
   */
  function startFileDrag(event: React.PointerEvent, sourcePath: string): void {
    if (event.button !== 0) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    function targetDirAt(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y)?.closest('[data-drop-dir]');
      return el?.getAttribute('data-drop-dir') ?? null;
    }
    // An md file row under the pointer, but only relevant when dragging an
    // image — that combination embeds the image instead of moving the file.
    function targetMdFileAt(x: number, y: number): string | null {
      if (!isImagePath(sourcePath)) {
        return null;
      }
      const el = document.elementFromPoint(x, y)?.closest('[data-drop-file]');
      return el?.getAttribute('data-drop-file') ?? null;
    }
    function cleanup(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.body.classList.remove('explorer-dragging');
      uiStore.getState().setDropTarget(null);
    }
    function onMove(e: PointerEvent): void {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        dragging = true;
        document.body.classList.add('explorer-dragging');
      }
      // Prefer the md-file target (image embed) over its containing folder.
      uiStore
        .getState()
        .setDropTarget(targetMdFileAt(e.clientX, e.clientY) ?? targetDirAt(e.clientX, e.clientY));
    }
    function onUp(e: PointerEvent): void {
      const wasDrag = dragging;
      cleanup();
      if (!wasDrag) {
        return; // a plain click — the row's onClick opens the file
      }
      // Swallow the click that fires right after this pointerup when the
      // pointer is released back over the source row; self-reset in case the
      // release happened elsewhere and no click follows.
      dragConsumedClick.current = true;
      setTimeout(() => {
        dragConsumedClick.current = false;
      }, 0);
      // Dropping an image onto an md file embeds it (with confirmation);
      // anything else is an in-workspace move into the hovered folder.
      const mdFile = targetMdFileAt(e.clientX, e.clientY);
      if (mdFile) {
        void appendImagesToMd(mdFile, [sourcePath]);
        return;
      }
      const dir = targetDirAt(e.clientX, e.clientY);
      if (dir) {
        void moveExplorerEntryInto(sourcePath, dir);
      }
    }
    function onCancel(): void {
      cleanup();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  return { rootRef, dragConsumedClick, explorerWidth, startResizeDrag, startFileDrag };
}
