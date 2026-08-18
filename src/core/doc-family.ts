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
import type { EditorMode, TabKind } from './types';

export type DocFamily = 'markdown' | 'svg' | 'terminal';

const MARKDOWN_MODES: readonly EditorMode[] = ['raw', 'split', 'wysiwyg', 'read'];
const SVG_MODES: readonly EditorMode[] = ['draw', 'raw'];
/**
 * A terminal offers exactly one mode. It still goes through this table so the
 * mode picker and the mod+1..4 shortcuts filter it out with the same
 * `isModeAllowed` check everything else uses, instead of a special case each.
 */
const TERMINAL_MODES: readonly EditorMode[] = ['term'];

export function docFamilyFor(path: string | null | undefined): DocFamily {
  return path && extName(path).toLowerCase() === '.svg' ? 'svg' : 'markdown';
}

/**
 * The family of a whole tab. A terminal tab has no path at all, so the
 * path-keyed function above cannot see it — callers holding a tab use this
 * one, callers holding only a path use `docFamilyFor`.
 */
export function docFamilyForTab(tab: {
  kind: TabKind;
  filePath?: string | null;
  notePath?: string | null;
}): DocFamily {
  return tab.kind === 'terminal' ? 'terminal' : docFamilyFor(tab.filePath ?? tab.notePath);
}

export function allowedModesFor(family: DocFamily): readonly EditorMode[] {
  switch (family) {
    case 'svg':
      return SVG_MODES;
    case 'terminal':
      return TERMINAL_MODES;
    default:
      return MARKDOWN_MODES;
  }
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
