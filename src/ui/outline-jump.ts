/**
 * The outline panel's PURE jump decision: given the active tab's mode and
 * which reveal mechanisms are currently available, decide how a clicked
 * heading should be reached. Kept free of stores/DOM so the mode matrix is
 * unit-testable (src/README "Testing expectations"); OutlinePanel executes
 * the plan against the real adapters/panes.
 *
 * - raw/split: the CM6 source editor is attached — jump by source LINE.
 * - read: the source editor is hidden; jump by rendered heading INDEX via the
 *   preview pane's registered reveal.
 * - wysiwyg: source lines don't exist in the rendered doc — jump by heading
 *   index via the adapter's (optional) revealHeading.
 */

import type { EditorMode } from '../core/types';

export type OutlineJumpPlan =
  { kind: 'line'; line: number } | { kind: 'heading'; index: number } | { kind: 'none' };

export function planOutlineJump(
  mode: EditorMode,
  hasSourceAdapter: boolean,
  hasPaneReveal: boolean,
  headingIndex: number,
  headingLine: number,
): OutlineJumpPlan {
  switch (mode) {
    case 'raw':
    case 'split':
      return hasSourceAdapter ? { kind: 'line', line: headingLine } : { kind: 'none' };
    case 'read':
      return hasPaneReveal ? { kind: 'heading', index: headingIndex } : { kind: 'none' };
    case 'wysiwyg':
      // The adapter may not implement revealHeading; the executor no-ops then.
      return { kind: 'heading', index: headingIndex };
  }
}
