/**
 * Debug dumps for the whiteboard scan screen.
 *
 * "Debug insert" inserts exactly what the normal button inserts, and also drops
 * every intermediate the pipeline produced — the camera's own photo, the
 * straightened photo, the cleaned raster, the traced SVG — into a fresh folder
 * beside the whiteboard. When a scan comes out wrong, those four files are the
 * whole story: which stage lost the ink is visible by looking at them in order.
 *
 * It lives here rather than in the editor for the same reason photo
 * acquisition does: choosing WHERE to write is a workspace question, and
 * `editors → core, ipc` must not learn about storage providers or tabs. The
 * adapter receives one function.
 */

import type { ScanDebugFile } from '../editors/whiteboard-scan';
import { dirName, joinPath } from '../core/session/plan-flush';
import { currentProvider } from '../ipc/provider';
import { uiStore } from './stores/ui';

/** `2026-08-06-143205` — sortable, filename-safe, local time (the user's own
 *  frame of reference when they go looking for the folder later). */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * Build the save function the draw adapter's scan screen calls. `getDocPath`
 * is read at click time, not at wiring time — the tab may have been saved
 * somewhere else since.
 *
 * Returns the folder that was created, or null when there is nowhere to put it
 * (an unsaved board has no directory to sit beside).
 */
export function createScanDebugSaver(
  getDocPath: () => string | null,
  now: () => Date = () => new Date(),
): (files: readonly ScanDebugFile[]) => Promise<string | null> {
  return async (files) => {
    const docPath = getDocPath();
    if (docPath === null || files.length === 0) {
      return null;
    }
    const folder = joinPath(dirName(docPath), `scan-debug-${stamp(now())}`);
    const provider = currentProvider();
    await provider.createDir(folder);
    for (const file of files) {
      const target = joinPath(folder, file.name);
      if (file.kind === 'text') {
        await provider.atomicWriteText(target, file.data);
      } else {
        await provider.writeFileBase64(target, file.data);
      }
    }
    uiStore.getState().refreshExplorer();
    return folder;
  };
}
