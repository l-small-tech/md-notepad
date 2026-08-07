/**
 * "Import › Scan whiteboard as image…" — camera capture (or photo pick)
 * straight to an image file.
 *
 * The same scan screen the drawing editor uses (capture/pick → crop →
 * straighten → clean), with one less step: nothing is traced into strokes.
 * The cleaned board — or the straightened photo — is saved as a NEW IMAGE
 * FILE in the folder that was right-clicked, instead of landing inside a
 * drawing.
 *
 * The panel is an editor module and stays storage-ignorant: it renders into a
 * fullscreen host element this module owns, and the file write goes through
 * the session controller (`createScanImageIn`), which picks a unique name,
 * writes via the active storage provider (so SAF/synced workspaces work) and
 * opens the result. Layering: ui → editors is legal (I9), and the dynamic
 * import keeps the whiteboard chunk lazy (I8) — this path loads it without a
 * board ever opening.
 */

import type { ScanResult } from '../editors/whiteboard-scan';
import { capturePhotoForScan } from './scan-photo';
import { createScanImageIn, pickPhotoForScan } from './session';
import { settingsStore } from './stores/settings';
import { uiStore } from './stores/ui';
import { isAndroid } from './platform';

/** `data:image/png;base64,AAA` → `AAA` (the write primitive takes payloads). */
function base64Payload(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/**
 * Put the scan screen up over the whole app and save its result into `dir`.
 * Resolves when the screen is open — the save happens whenever the user
 * finishes, through the panel's own callbacks.
 */
export async function scanImageInto(dir: string): Promise<void> {
  const { createScanPanel } = await import('../editors/whiteboard-scan');
  const host = document.createElement('div');
  host.className = 'wb-scan-standalone';
  const panel = createScanPanel({
    capture: isAndroid() ? capturePhotoForScan : null,
    pick: isAndroid() ? null : pickPhotoForScan,
    output: 'image',
    // The panel closed itself before this fires; the write is all that's left.
    // The extension follows the encoder: the cleaned board is a PNG, the
    // straightened photo a JPEG — the data: URL's own mime says which.
    onInsert: (result: ScanResult) => {
      const ext = result.dataUrl.startsWith('data:image/png') ? '.png' : '.jpg';
      void createScanImageIn(dir, ext, base64Payload(result.dataUrl));
    },
    // Unreachable: image output never traces, so there are never strokes.
    onInsertStrokes: () => {},
    onClose: () => {
      panel.destroy();
      host.remove();
    },
    onNotice: (message) => uiStore.getState().showNotice(message),
    // No OCR and no debug dump here — both belong to the board flow: OCR's
    // output lives in the drawing's metadata, and the debug dump saves beside
    // a board this flow never creates.
    recognize: null,
    saveDebug: null,
    prefs: {
      get: () => ({
        preset: settingsStore.getState().settings.scanPreset,
        smoothing: settingsStore.getState().settings.scanSmoothing,
      }),
      set: ({ preset, smoothing }) =>
        settingsStore.getState().update({ scanPreset: preset, scanSmoothing: smoothing }),
    },
  });
  host.append(panel.element);
  document.body.append(host);
  panel.open(isAndroid() ? 'camera' : 'picker');
}
