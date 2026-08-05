/**
 * What KIND of document a path holds, and therefore which editor modes make
 * sense for it.
 *
 * Until the whiteboard, every editable tab was markdown and every mode applied
 * everywhere. An `.svg` tab is still an ordinary `kind:'file'` tab — same dirty
 * tracking, session buffering, Ctrl+S, conflict detection, tear-off — it just
 * offers a different pair of modes: Draw (the whiteboard editor) and Raw (the
 * CM6 source view, which is a free SVG source editor).
 *
 * Deliberately keyed on the mode, not the tab kind: `parseManifest` hard-
 * validates `kind` but never validates `mode`, so a `mode:'draw'` file tab
 * round-trips through an OLD build of the app, where `kindFor` degrades it to
 * the source editor instead of self-healing the whole session away.
 */

import { extName } from './session/plan-flush';
import type { EditorMode } from './types';

export type DocFamily = 'markdown' | 'svg';

const MARKDOWN_MODES: readonly EditorMode[] = ['raw', 'split', 'wysiwyg', 'read'];
const SVG_MODES: readonly EditorMode[] = ['draw', 'raw'];

export function docFamilyFor(path: string | null | undefined): DocFamily {
  return path && extName(path).toLowerCase() === '.svg' ? 'svg' : 'markdown';
}

export function allowedModesFor(family: DocFamily): readonly EditorMode[] {
  return family === 'svg' ? SVG_MODES : MARKDOWN_MODES;
}

export function isModeAllowed(family: DocFamily, mode: EditorMode): boolean {
  return allowedModesFor(family).includes(mode);
}

/**
 * `preferred` if this family supports it, else the family's natural default
 * (Draw for a whiteboard, the caller's markdown mode otherwise). This is the
 * self-heal for a manifest — or a `lastFileMode` — carrying a mode from the
 * other family.
 */
export function defaultModeFor(family: DocFamily, preferred: EditorMode): EditorMode {
  const allowed = allowedModesFor(family);
  return allowed.includes(preferred) ? preferred : allowed[0]!;
}
