/**
 * Pure geometry for "where does a pasted/dropped image get saved, and how is
 * it referenced from the markdown file?" — the one decision shared by the
 * editor paste path and the explorer drag path (both in src/ui/session.ts).
 *
 * Kept in core (no ipc/DOM) so it is trivially testable: the caller supplies
 * the already-resolved directories and a `join`, this returns the target dir.
 */

import type { ImagePasteLocation } from './types';

export interface ImageTargetOpts {
  /** Directory of the markdown file the image is being embedded into. */
  mdDir: string;
  /**
   * Root of the workspace the markdown file belongs to (for 'workspaceRoot').
   * Callers pass `mdDir` when no enclosing workspace is known.
   */
  workspaceRoot: string;
  location: ImagePasteLocation;
  /**
   * Sanitized folder name for the 'subfolder'/'workspaceRoot' modes. An empty
   * string collapses those modes to "no subfolder" (mdDir / workspaceRoot).
   */
  folderName: string;
  /** Path join (session passes core's joinPath, tests pass a POSIX join). */
  join: (dir: string, name: string) => string;
}

/** The directory an image should be written to for the given settings. */
export function imageTargetDir(opts: ImageTargetOpts): string {
  const { mdDir, workspaceRoot, location, folderName, join } = opts;
  switch (location) {
    case 'sameFolder':
      return mdDir;
    case 'workspaceRoot':
      return folderName ? join(workspaceRoot, folderName) : workspaceRoot;
    case 'subfolder':
    default:
      return folderName ? join(mdDir, folderName) : mdDir;
  }
}
