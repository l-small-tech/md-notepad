/**
 * Image-file vocabulary shared by the explorer and image tabs. The extension
 * list mirrors `IMAGE_EXTENSIONS` in src-tauri/src/commands/fs.rs (Rust is
 * the listing gatekeeper; TS decides how a clicked path opens).
 */

import { extName } from './session/plan-flush';

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
