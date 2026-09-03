/**
 * Apply a colour mode to saved whiteboards from OUTSIDE the draw editor — the
 * preview / rich-editor right-click menu's action. Each file is read, flipped
 * through the real parse → serialize route (`core/whiteboard/color-mode.ts`,
 * the same edit the board's own `◐` control makes) and atomically written
 * back; files already in that mode, and SVGs that are not boards, are left
 * byte-identical. Every open view showing one of the files then reloads it.
 *
 * A board that is ALSO open in a draw tab picks the change up through the
 * fs-changed watcher like any external edit.
 */

import { withErrorDetail } from '../core/error-text';
import { withBoardColorMode } from '../core/whiteboard/color-mode';
import type { BoardColorMode } from '../core/whiteboard/scene';
import { ipc } from '../ipc/commands';
import { refreshImagesEverywhere } from './stores/board-color-menu';
import { uiStore } from './stores/ui';

/** Rewrite the boards at `paths` to render in `mode`; reports failures as notices. */
export async function applyBoardColorMode(
  paths: readonly string[],
  mode: BoardColorMode,
): Promise<void> {
  const changed: string[] = [];
  let failure: { path: string; error: unknown } | null = null;
  for (const path of paths) {
    try {
      const { text } = await ipc.readTextFile(path);
      const next = withBoardColorMode(text, mode);
      if (next === text) {
        continue;
      }
      await ipc.atomicWriteText(path, next);
      changed.push(path);
    } catch (error) {
      failure ??= { path, error };
    }
  }
  if (changed.length > 0) {
    refreshImagesEverywhere(changed);
  }
  if (failure) {
    const name = failure.path.split(/[\\/]/).pop() ?? failure.path;
    uiStore.getState().showNotice(withErrorDetail(`Could not update "${name}".`, failure.error));
  }
}
