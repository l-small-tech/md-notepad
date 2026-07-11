/**
 * Settings schema + normalization.
 *
 * Settings are persisted via tauri-plugin-store (see src/README.md), which
 * hands back `unknown` JSON. `normalizeSettings` is the single choke point
 * that turns anything — missing file, older schema, hand-edited garbage —
 * into a valid `Settings`, field by field. There is deliberately no zod/
 * schema library: a handful of fields doesn't justify a dependency.
 */

import { EDITOR_FONT_IDS, UI_FONT_IDS, WORKSPACE_COLORS } from './types';
import type { EditorFontId, Settings, UiFontId, WorkspaceColor, WorkspaceEntry } from './types';

export const DEFAULT_SETTINGS: Settings = {
  notesDir: null,
  theme: 'system',
  fontSize: 14,
  editorFont: 'fira-code',
  uiFont: 'match',
  defaultMode: 'raw',
  wordWrap: true,
  ligatures: true,
  readerMargins: 'normal',
  confirmFileMove: true,
  liveSave: false,
  previewTabs: true,
  workspaces: [],
  defaultWorkspaceColor: null,
  imagePasteLocation: 'subfolder',
  imageFolderName: 'images',
};

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeColor(raw: unknown): WorkspaceColor | null {
  return (WORKSPACE_COLORS as readonly unknown[]).includes(raw) ? (raw as WorkspaceColor) : null;
}

/**
 * Color for a newly added workspace: the least-used palette color, first-in-
 * palette-order among ties — so fresh workspaces get distinct colors until
 * the palette is exhausted, then it cycles fairly. (The user can still set
 * any color, or none, by hand afterwards.)
 */
export function pickUnusedColor(used: readonly (WorkspaceColor | null)[]): WorkspaceColor {
  const counts = new Map<WorkspaceColor, number>(WORKSPACE_COLORS.map((c) => [c, 0]));
  for (const color of used) {
    if (color !== null) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  let best: WorkspaceColor = WORKSPACE_COLORS[0];
  for (const color of WORKSPACE_COLORS) {
    if (counts.get(color)! < counts.get(best)!) {
      best = color;
    }
  }
  return best;
}

/** Keep only well-formed entries; malformed ones are dropped, not defaulted. */
function normalizeWorkspaces(raw: unknown): WorkspaceEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: WorkspaceEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.length === 0) {
      continue;
    }
    const name =
      typeof entry.name === 'string' && entry.name.trim().length > 0
        ? entry.name.trim()
        : entry.path;
    out.push({
      name,
      path: entry.path,
      color: normalizeColor(entry.color),
      ...(entry.readOnly === true ? { readOnly: true } : {}),
    });
  }
  return out;
}

/** Per-field validation; every invalid field falls back to its default. */
export function normalizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    notesDir: typeof r.notesDir === 'string' && r.notesDir.length > 0 ? r.notesDir : d.notesDir,
    theme: r.theme === 'system' || r.theme === 'light' || r.theme === 'dark' ? r.theme : d.theme,
    fontSize:
      typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)
        ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(r.fontSize)))
        : d.fontSize,
    editorFont: (EDITOR_FONT_IDS as readonly unknown[]).includes(r.editorFont)
      ? (r.editorFont as EditorFontId)
      : d.editorFont,
    uiFont: (UI_FONT_IDS as readonly unknown[]).includes(r.uiFont)
      ? (r.uiFont as UiFontId)
      : d.uiFont,
    defaultMode:
      r.defaultMode === 'raw' ||
      r.defaultMode === 'split' ||
      r.defaultMode === 'wysiwyg' ||
      r.defaultMode === 'read'
        ? r.defaultMode
        : d.defaultMode,
    wordWrap: typeof r.wordWrap === 'boolean' ? r.wordWrap : d.wordWrap,
    ligatures: typeof r.ligatures === 'boolean' ? r.ligatures : d.ligatures,
    readerMargins:
      r.readerMargins === 'narrow' || r.readerMargins === 'normal' || r.readerMargins === 'wide'
        ? r.readerMargins
        : d.readerMargins,
    confirmFileMove: typeof r.confirmFileMove === 'boolean' ? r.confirmFileMove : d.confirmFileMove,
    liveSave: typeof r.liveSave === 'boolean' ? r.liveSave : d.liveSave,
    previewTabs: typeof r.previewTabs === 'boolean' ? r.previewTabs : d.previewTabs,
    workspaces: normalizeWorkspaces(r.workspaces),
    defaultWorkspaceColor: normalizeColor(r.defaultWorkspaceColor),
    imagePasteLocation:
      r.imagePasteLocation === 'subfolder' ||
      r.imagePasteLocation === 'sameFolder' ||
      r.imagePasteLocation === 'workspaceRoot'
        ? r.imagePasteLocation
        : d.imagePasteLocation,
    // A blank or non-string folder name degrades to the default rather than
    // producing a nameless subfolder.
    imageFolderName:
      typeof r.imageFolderName === 'string' && r.imageFolderName.trim().length > 0
        ? r.imageFolderName.trim()
        : d.imageFolderName,
  };
}
