/**
 * Pure helpers shared by the FileExplorer container and its extracted pieces:
 * row indentation, the file-type badge, drawer-width clamping, paste MIME
 * vocabulary, and the timeout-guarded directory listing.
 */

import { isImagePath } from '../../../core/images';
import { isImportablePath } from '../../../core/import/registry';
import { listNoteFiles, type ExplorerEntry } from '../../session';

/** Indentation per tree depth; file rows add the caret column's width. */
export function dirIndent(depth: number): number {
  return 8 + depth * 12;
}

/**
 * The right-pinned type badge for a recognized file, or null for anything
 * else (which then keeps its full name, extension included). Recognized files
 * show their name WITHOUT the extension plus this badge: 'md' for markdown
 * (rendered in the accent blue), the uppercased extension for images and
 * importable documents (PDF/DOCX).
 */
export function fileBadge(name: string): { label: string; kind: 'md' | 'image' | 'doc' } | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const ext = name.slice(dot).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    return { label: 'md', kind: 'md' };
  }
  if (ext === '.txt') {
    return { label: 'txt', kind: 'md' };
  }
  if (isImportablePath(name)) {
    return { label: name.slice(dot + 1), kind: 'doc' };
  }
  if (isImagePath(name)) {
    return { label: name.slice(dot + 1), kind: 'image' };
  }
  return null;
}

/** Pointer travel (px, Manhattan) before a press on a file row becomes a drag. */
export const DRAG_THRESHOLD_PX = 5;

export const MIN_EXPLORER_WIDTH = 160;
export const MAX_EXPLORER_WIDTH = 480;

export function clampExplorerWidth(px: number): number {
  return Math.min(MAX_EXPLORER_WIDTH, Math.max(MIN_EXPLORER_WIDTH, px));
}

export const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

/**
 * A directory listing that outruns this is treated as failed, so a cloud folder
 * (Google Drive / OneDrive) whose backend never responds surfaces a Retry
 * affordance instead of sitting on "Loading…" forever. Generous, because a cold
 * synced-folder fetch is legitimately slow.
 */
const LISTING_TIMEOUT_MS = 20_000;

/** `listNoteFiles`, but rejects if the backend hasn't answered in time. */
export function listWithTimeout(dir: string): Promise<ExplorerEntry[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listing timed out')), LISTING_TIMEOUT_MS);
    listNoteFiles(dir).then(
      (list) => {
        clearTimeout(timer);
        resolve(list);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
