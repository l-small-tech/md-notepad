/**
 * Pure planning for the M6 "change notes directory" flow.
 *
 * When the user points the notes dir at a new location and opts to bring the
 * existing notes along, this decides EXACTLY which files move where — a list
 * of `{ from, to }` pairs the session controller then feeds to
 * `ipc.renamePath` one at a time (reporting any it can't move). Keeping the
 * decision pure means the move set is unit-testable without touching disk
 * (plan.md M6: "Vitest for the move-notes planning logic").
 *
 * Only note basenames are moved; the manifest and session buffers stay put in
 * the session dir (which is never user-configurable — see core/README two-tier
 * data placement). Moving to the same directory is a no-op.
 */

import { baseName, joinPath } from './session/plan-flush';

export interface NoteMove {
  from: string;
  to: string;
}

/**
 * Build the move set for relocating `noteFiles` (basenames or full paths in
 * `fromDir`) from `fromDir` into `toDir`. Returns `[]` when the directory is
 * unchanged. Duplicate basenames are de-duplicated so a file is never planned
 * to move twice.
 */
export function planNoteMoves(noteFiles: string[], fromDir: string, toDir: string): NoteMove[] {
  if (fromDir === toDir) {
    return [];
  }
  const seen = new Set<string>();
  const moves: NoteMove[] = [];
  for (const entry of noteFiles) {
    const name = baseName(entry);
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    moves.push({ from: joinPath(fromDir, name), to: joinPath(toDir, name) });
  }
  return moves;
}
