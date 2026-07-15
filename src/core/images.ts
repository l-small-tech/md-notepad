/**
 * Image-file vocabulary shared by the explorer and image tabs. The extension
 * list mirrors `IMAGE_EXTENSIONS` in src-tauri/src/commands/fs.rs (Rust is
 * the listing gatekeeper; TS decides how a clicked path opens).
 */

import { extName, toAbsolutePath } from './session/plan-flush';

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

export function isImagePath(path: string): boolean {
  return extName(path).toLowerCase() in IMAGE_MIME;
}

/** MIME type for a data: URL; falls back to octet-stream (never happens for
 *  paths that passed {@link isImagePath}). */
export function imageMimeType(path: string): string {
  return IMAGE_MIME[extName(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Extension (incl. dot) for an image MIME type, or null if not an image type. */
export function extForImageMime(mime: string): string | null {
  const entry = Object.entries(IMAGE_MIME).find(([, m]) => m === mime);
  return entry ? entry[0] : null;
}

/**
 * For a raw `<img>` src on a document living in `docDir`, the absolute image
 * file to inline as a data URL, or null to leave the src exactly as-is. Null
 * covers: empty, external (http/https), already-inlined (data:), an unsaved doc
 * (no `docDir`), and non-image targets. Shared by the split-preview pane and
 * the rich-mode (Milkdown) editor — both must read local images off disk and
 * inline them, because the app CSP blocks loading a local file by path.
 */
export function localImageToInline(docDir: string | null, rawSrc: string): string | null {
  if (!rawSrc || /^(?:https?:|data:)/i.test(rawSrc) || !docDir) {
    return null;
  }
  let rel = rawSrc;
  try {
    rel = decodeURI(rawSrc);
  } catch {
    // A malformed escape — resolve the raw string instead.
  }
  const abs = toAbsolutePath(docDir, rel);
  return isImagePath(abs) ? abs : null;
}

/**
 * Chunked base64 of raw bytes. `btoa` chokes on large spreads and pasted
 * screenshots run to megabytes, so encode in 32 KiB windows. Shared by the
 * clipboard-paste paths in the explorer and the editors.
 */
/** Inverse of {@link bytesToBase64}: decode base64 to raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
