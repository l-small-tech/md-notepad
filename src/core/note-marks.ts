/**
 * note-marks.ts — which review notes belong to which rendered thing.
 *
 * The Review panes show a marker beside every block (markdown) or card (code)
 * that already has a note, the way a word processor marks commented lines.
 * The notes only carry a source line (and, for code, the declaration's
 * label), so the panes need a rule for attaching them to what is on screen:
 *
 * - a markdown block owns every note whose line falls between its own first
 *   line and the next block's (`notesByBlock`); a note above the first block
 *   (front matter) attaches to that first block;
 * - a code card owns the notes that name its declaration, plus any note
 *   without a declaration that sits on its signature line (`notesForUnit`).
 *
 * Pure: no DOM, no I/O. The panes call these after every render.
 */

import type { VoiceComment } from './comments';

/** The declaration label a code note stores in `unit`: `showAllFiles (function)`. */
export function unitNoteLabel(unit: { name: string; kind: string }): string {
  return `${unit.name} (${unit.kind})`;
}

/**
 * Group notes by the block that owns them. `blockLines` are the 1-based first
 * lines of the top-level blocks in document order (duplicates are collapsed
 * onto the first). Notes without a line are skipped: nothing on screen is
 * theirs. The result maps a block's line to its notes in file order.
 */
export function notesByBlock(
  notes: readonly VoiceComment[],
  blockLines: readonly number[],
): Map<number, VoiceComment[]> {
  const out = new Map<number, VoiceComment[]>();
  if (blockLines.length === 0) {
    return out;
  }
  const sorted = [...new Set(blockLines)].sort((a, b) => a - b);
  for (const note of notes) {
    if (note.line === null) {
      continue;
    }
    // The greatest block line ≤ the note's line; the first block if none.
    let owner = sorted[0]!;
    for (const line of sorted) {
      if (line > note.line) {
        break;
      }
      owner = line;
    }
    const list = out.get(owner);
    if (list) {
      list.push(note);
    } else {
      out.set(owner, [note]);
    }
  }
  return out;
}

/** The notes a code card owns (see the module comment), in file order. */
export function notesForUnit(
  notes: readonly VoiceComment[],
  unit: { name: string; kind: string; signatureLine: number },
): VoiceComment[] {
  const label = unitNoteLabel(unit);
  return notes.filter((n) =>
    n.unit !== undefined ? n.unit === label : n.line === unit.signatureLine,
  );
}

/**
 * The note the sheet should lead with when opened from a marker: the first
 * note on that line — for a code card, the first that names the declaration.
 */
export function firstNoteAt(
  notes: readonly VoiceComment[],
  target: { line?: number; unit?: string },
): VoiceComment | undefined {
  if (target.unit !== undefined) {
    return notes.find((n) => n.unit === target.unit);
  }
  return notes.find((n) => n.line === target.line);
}
