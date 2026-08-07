/**
 * Debug dumps for the whiteboard scan screen.
 *
 * "Debug insert" inserts exactly what the normal button inserts, and also drops
 * every intermediate the pipeline produced — the camera's own photo, the
 * straightened photo, the cleaned raster, the removed-components artifact, the
 * traced SVG — into a fresh folder. When a scan comes out wrong, those files
 * are the whole story: which stage lost the ink is visible by looking at them
 * in order.
 *
 * They land BESIDE THE BOARD (UAT decision — reversing an earlier move to
 * app-local storage): the user who right-clicks a workspace folder and scans
 * into it expects the dump where they are looking, not buried in `%APPDATA%`.
 * Writes go through `currentProvider()`, so a synced (SAF) workspace works
 * too. The known cost, accepted knowingly: a dump is tens of megabytes, and in
 * a cloud-synced folder the sync client will upload it — debug dumps are a
 * deliberate act, deleted when done. Only a board that has never been saved
 * falls back to app-owned local storage (`resolveScanDebugDir`), which is what
 * lets it be debugged at all.
 *
 * This lives here rather than in the editor for the same reason photo
 * acquisition does: choosing WHERE to write is a workspace question, and
 * `editors → core, ipc` must not learn about storage providers or tabs. The
 * adapter receives one function.
 */

import type { ScanDebugFile } from '../editors/whiteboard-scan';
import { dirName, joinPath } from '../core/session/plan-flush';
import { resolveScanDebugDir } from '../ipc/paths';
import { currentProvider, LocalFsProvider, type StorageProvider } from '../ipc/provider';
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
    const docPath = getDocPath();
    let folder: string;
    let provider: StorageProvider;
    if (docPath !== null) {
      folder = joinPath(dirName(docPath), `scan-debug-${stamp(now())}`);
      provider = currentProvider();
    } else {
      folder = joinPath(await resolveScanDebugDir(), `scan-${stamp(now())}`);
      // Always the local FS — app-owned storage never goes through a synced
      // provider, same as the themes folder.
      provider = LocalFsProvider;
    }
    await provider.createDir(folder);
    for (const file of files) {
      const target = joinPath(folder, file.name);
      if (file.kind === 'text') {
        await provider.atomicWriteText(target, file.data);
      } else {
        await provider.writeFileBase64(target, file.data);
      }
    }
    if (docPath !== null) {
      // The dump is sitting in the workspace — show it.
      uiStore.getState().refreshExplorer();
    }
    return folder;
  };
}
