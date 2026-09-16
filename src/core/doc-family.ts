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

import { isImagePath } from './images';
import { isImportablePath } from './import/registry';
import { extName } from './session/plan-flush';
import { isEditableTextPath } from './text-files';
import type { EditorMode, TabKind } from './types';

export type DocFamily = 'markdown' | 'svg' | 'code' | 'terminal';

/**
 * Order matters: this is the order the mode segments are drawn in. Every
 * family leads with `raw`, so the source view sits in the same place on every
 * kind of tab. It is NOT the default-mode order — that lives in
 * `FAMILY_DEFAULTS` below.
 */
const MARKDOWN_MODES: readonly EditorMode[] = ['raw', 'split', 'wysiwyg', 'read'];
const SVG_MODES: readonly EditorMode[] = ['raw', 'draw'];
/**
 * Any other file (`.ts`, `.json`, `Makefile`…) — listed where the user shows
 * unsupported files. It is not markdown, so rendering it (Rich, split preview)
 * would mangle it: the source editor applies, plus `read`, which for this
 * family is *Review* — the structural, read-only view of a code file
 * (`preview/code-review.ts`; review_plan.md §1). The mode VALUE stays `read`
 * so session manifests, the mode picker, mod+4 and `isModeAllowed` all work
 * unchanged; only the label is *Review* (`modeLabel`).
 */
const CODE_MODES: readonly EditorMode[] = ['raw', 'read'];
/**
 * A terminal offers exactly one mode. It still goes through this table so the
 * mode picker and the mod+1..4 shortcuts filter it out with the same
 * `isModeAllowed` check everything else uses, instead of a special case each.
 */
const TERMINAL_MODES: readonly EditorMode[] = ['term'];

/**
 * No path (an unsaved note) is markdown. Images and importable documents stay
 * 'markdown' too: they open as viewer/import tabs, never through a mode.
 */
export function docFamilyFor(path: string | null | undefined): DocFamily {
  if (!path) {
    return 'markdown';
  }
  if (extName(path).toLowerCase() === '.svg') {
    return 'svg';
  }
  return isEditableTextPath(path) || isImagePath(path) || isImportablePath(path)
    ? 'markdown'
    : 'code';
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
    case 'code':
      return CODE_MODES;
    case 'terminal':
      return TERMINAL_MODES;
    default:
      return MARKDOWN_MODES;
  }
}

export function isModeAllowed(family: DocFamily, mode: EditorMode): boolean {
  return allowedModesFor(family).includes(mode);
}

const MODE_LABELS: Record<EditorMode, string> = {
  raw: 'Raw',
  split: 'Split',
  wysiwyg: 'Rich',
  read: 'Review',
  draw: 'Draw',
  term: 'Terminal',
};

/**
 * The name a mode is shown under for a document family — the ONE place the
 * label is decided, so the status bar, the palette and any tooltip agree.
 * `read` is *Review* for every family (for code, the same mode value renders
 * the file's structure instead of markdown).
 */
export function modeLabel(mode: EditorMode, _family: DocFamily): string {
  return MODE_LABELS[mode];
}

/**
 * The mode a family falls back to. Kept separate from the segment order in
 * the tables above, because for SVG the two disagree: Raw is drawn first (so
 * it lines up with every other family's first segment) but opening a drawing
 * should land you in Draw.
 */
const FAMILY_DEFAULTS: Record<DocFamily, EditorMode> = {
  markdown: 'raw',
  svg: 'draw',
  code: 'raw',
  terminal: 'term',
};

/**
 * `preferred` if this family supports it, else the family's natural default
 * (Draw for a whiteboard, the caller's markdown mode otherwise). This is the
 * self-heal for a manifest — or a `lastFileMode` — carrying a mode from the
 * other family.
 */
export function defaultModeFor(family: DocFamily, preferred: EditorMode): EditorMode {
  return allowedModesFor(family).includes(preferred) ? preferred : FAMILY_DEFAULTS[family];
}
