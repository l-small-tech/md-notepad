/**
 * Shared domain types. This file is the vocabulary of the whole app —
 * read it first.
 *
 * Layering (invariant I9): src/core imports NOTHING from ipc/editors/
 * preview/ui, no DOM types in runtime code, no Tauri. Pure logic only.
 */

/**
 * The edit modes. 'split' = raw editor plus a live preview pane; 'read' = a
 * full-width, read-only rendered view (no editor, optimized for reading). Both
 * 'raw', 'split', and 'read' share the one CM6 source editor under the hood
 * (see core/mode-sync `kindFor`) — 'read' just hides it behind the preview.
 */
export type EditorMode = 'raw' | 'split' | 'wysiwyg' | 'read';

/**
 * 'note'  — an ephemeral Notepad-style tab, backed by a .md file in the
 *           notes dir that the session flusher owns entirely.
 * 'file'  — a user-opened file anywhere on disk; explicit save semantics,
 *           unsaved edits are session-buffered (see core/session).
 */
export type TabKind = 'note' | 'file';

export interface CursorPos {
  anchor: number;
  head: number;
}

/** UI-facing tab state held in the tabs store (src/ui builds this in M1). */
export interface TabState {
  /** nanoid; stable for the tab's lifetime, used as the session buffer name. */
  id: string;
  kind: TabKind;
  /** kind='note': backing file in the notes dir. Null until the first non-empty flush. */
  notePath: string | null;
  /** kind='file': the user's file path. */
  filePath: string | null;
  /** User rename override; null = auto-derive from first line (core/title.ts). */
  customTitle: string | null;
  mode: EditorMode;
  /** kind='file': disk mtime at last load/save, baseline for conflict detection. */
  savedMtimeMs: number | null;
}

export interface Settings {
  /** null = platform default: appDataDir()/notes (resolved in src/ipc, not here). */
  notesDir: string | null;
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  defaultMode: EditorMode;
  wordWrap: boolean;
  /** Fira Code ligatures (-> as a single glyph). Default on. */
  ligatures: boolean;
}
