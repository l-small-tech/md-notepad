/**
 * Photo acquisition for the whiteboard scan screen (phase 4, S0).
 *
 * The draw adapter is handed these as plain functions rather than importing
 * them: an editor module must not know about Tauri (the layering contract is
 * `editors → core, ipc`, and native dialogs live above even that), and the two
 * platforms acquire a photo in completely different ways.
 *
 * - **Android** — `ipc.capturePhoto()` drives the system camera through the
 *   androidfs plugin. Kotlin normalizes EXIF orientation and downscales to
 *   ≤2600 px before encoding, so what arrives here is a few hundred KB rather
 *   than a raw sensor frame.
 * - **Desktop** — the native file picker, filtered to images, read back as
 *   base64. There is no in-app camera on desktop; the flow is
 *   "photograph with your phone, drop the file in", plus clipboard paste and
 *   OS drag-drop, which the adapter handles directly.
 */

import { ipc } from '../ipc/commands';
import { createWhiteboardIn, pathKey, pickPhotoForScan, type ScanPhotoRef } from './session';
import { getWhiteboardAdapter } from './stores/whiteboard';
import { tabsStore } from './stores/tabs';
import { uiStore } from './stores/ui';

/** Take a photo with the device camera. Android only — rejects elsewhere. */
export async function capturePhotoForScan(): Promise<ScanPhotoRef> {
  const photo = await ipc.capturePhoto();
  return {
    dataUrl: `data:image/jpeg;base64,${photo.base64}`,
    width: photo.width,
    height: photo.height,
  };
}

/**
 * Explorer "Import › Whiteboard scan…" — create a board in `dir`, open it, and
 * put its scan screen up.
 *
 * The wait is unavoidable rather than sloppy: the draw adapter is a LAZY chunk
 * (invariant I8) created in an effect after the tab mounts, so there is nothing
 * to call `startScan` on at the moment the file is written. Polling for it with
 * a deadline is honest about that; the fallback notice points at the ribbon
 * button, which does the same thing, rather than failing silently.
 */
export async function scanWhiteboardInto(dir: string): Promise<void> {
  const path = await createWhiteboardIn(dir);
  if (path === null) {
    return;
  }
  const key = pathKey(path);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tab = tabsStore.getState().tabs.find((t) => {
      const own = t.filePath ?? t.notePath;
      return own !== null && pathKey(own) === key;
    });
    const adapter = tab ? getWhiteboardAdapter(tab.id) : undefined;
    if (adapter?.canScan()) {
      adapter.startScan();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  uiStore
    .getState()
    .showNotice('The whiteboard is open — use the camera button in the toolbar to scan into it.');
}

export { pickPhotoForScan };
export type { ScanPhotoRef };
