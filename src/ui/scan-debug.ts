/**
 * Debug dumps for the whiteboard scan screen.
 *
 * "Debug insert" inserts exactly what the normal button inserts, and also drops
 * every intermediate the pipeline produced — the camera's own photo, the
 * straightened photo, the cleaned raster, the traced SVG — into a fresh folder.
 * When a scan comes out wrong, those four files are the whole story: which
 * stage lost the ink is visible by looking at them in order.
 *
 * They land in app-owned LOCAL storage (`resolveScanDebugDir`), never beside the
 * board. A dump is tens of megabytes of throwaway diagnostics; beside the board
 * it would ride into whatever workspace the user saved to, and a Google Drive
 * folder full of large binaries written from another device is precisely the
 * thing that leaves Explorer spinning in streaming mode. Local also means an
 * unsaved board can be debugged, which it could not before.
 *
 * This lives here rather than in the editor for the same reason photo
 * acquisition does: choosing WHERE to write is a workspace question, and
 * `editors → core, ipc` must not learn about storage providers or tabs. The
 * adapter receives one function.
 */

import type { ScanDebugFile } from '../editors/whiteboard-scan';
import { baseName, joinPath } from '../core/session/plan-flush';
import { resolveScanDebugDir } from '../ipc/paths';
import { LocalFsProvider } from '../ipc/provider';

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
 * Folder name for one dump: `<board>-<stamp>`, or just `scan-<stamp>` for a
 * board that has never been saved. The board's own file name is already
 * filesystem-legal, so only its extension needs dropping.
 */
function folderName(docPath: string | null, at: Date): string {
  const name = docPath === null ? '' : baseName(docPath).replace(/\.[^.]+$/, '');
  return `${name === '' ? 'scan' : name}-${stamp(at)}`;
}

/**
 * Build the save function the draw adapter's scan screen calls. `getDocPath`
 * is read at click time, not at wiring time — the tab may have been saved
 * somewhere else since — and only names the folder; it never decides where the
 * dump goes.
 *
 * Returns the folder that was created, or null when there was nothing to write.
 */
export function createScanDebugSaver(
  getDocPath: () => string | null,
  now: () => Date = () => new Date(),
): (files: readonly ScanDebugFile[]) => Promise<string | null> {
  return async (files) => {
    if (files.length === 0) {
      return null;
    }
    const folder = joinPath(await resolveScanDebugDir(), folderName(getDocPath(), now()));
    // Always the local FS, on both platforms — same as the themes folder, and
    // the reason this never goes through `currentProvider()`.
    await LocalFsProvider.createDir(folder);
    for (const file of files) {
      const target = joinPath(folder, file.name);
      if (file.kind === 'text') {
        await LocalFsProvider.atomicWriteText(target, file.data);
      } else {
        await LocalFsProvider.writeFileBase64(target, file.data);
      }
    }
    return folder;
  };
}
