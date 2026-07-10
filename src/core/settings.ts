/**
 * Settings schema + normalization.
 *
 * Settings are persisted via tauri-plugin-store (see src/README.md), which
 * hands back `unknown` JSON. `normalizeSettings` is the single choke point
 * that turns anything — missing file, older schema, hand-edited garbage —
 * into a valid `Settings`, field by field. There is deliberately no zod/
 * schema library: a handful of fields doesn't justify a dependency.
 */

import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  notesDir: null,
  theme: 'system',
  fontSize: 14,
  defaultMode: 'raw',
  wordWrap: true,
  ligatures: true,
  readerMargins: 'normal',
};

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  };
}
