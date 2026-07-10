/**
 * Clipboard → image bytes, shared by the CM6 and Milkdown paste handlers.
 * Both editors intercept a paste that carries image files (a screenshot, a
 * "copy image"), hand the bytes to the session's image saver, and insert the
 * returned markdown reference at the caret. This module is just the extraction
 * step; the DOM-insertion differs per editor and stays in each adapter.
 */

import { bytesToBase64, extForImageMime, isImagePath } from '../core/images';

export interface PastedImageData {
  base64: string;
  /** Extension including the dot (`.png`). */
  ext: string;
  /** Basename to use (no extension), or null for a timestamped default. */
  name: string | null;
}

/** The image Files present on a clipboard/drag `DataTransfer` (may be empty). */
export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const out: File[] = [];
  for (const item of data.items) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (file && (file.type.startsWith('image/') || isImagePath(file.name))) {
      out.push(file);
    }
  }
  return out;
}

/** Read one image `File` into the shape the session's image saver expects. */
export async function readImageFile(file: File): Promise<PastedImageData> {
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : (extForImageMime(file.type) ?? '.png');
  // A generic clipboard screenshot arrives as "image.png" — treat that as
  // unnamed so it gets a timestamp; a genuinely named file keeps its base.
  const base = dot > 0 ? file.name.slice(0, dot) : '';
  const name = base && file.name.toLowerCase() !== 'image.png' ? base : null;
  return { base64: bytesToBase64(await file.arrayBuffer()), ext, name };
}
