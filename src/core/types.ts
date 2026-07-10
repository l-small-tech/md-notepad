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
 * 'image' — a read-only image viewer over `filePath`. Never written, never
 *           buffered; the flusher only records it in the manifest.
 */
export type TabKind = 'note' | 'file' | 'image';

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

/**
 * Read-mode side margins. Named modes instead of pixels — each maps to a
 * responsive gutter in preview.css (narrow ≈ near-full-width text, wide ≈ a
 * book-like centered column).
 */
export type ReaderMargins = 'narrow' | 'normal' | 'wide';

/**
 * Workspace accent colors — named tokens, not hex, so the palette can be
 * tuned per theme in CSS without touching persisted settings.
 */
export const WORKSPACE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/**
 * A workspace is just a folder the file explorer lists. The notes dir is the
 * implicit default workspace and is NOT stored here — this array holds only
 * the extra folders the user added (removing one never touches its files).
 */
export interface WorkspaceEntry {
  /** Display name; defaults to the folder's basename when added. */
  name: string;
  /** Absolute path to the folder. */
  path: string;
  /** Accent color, or null for none. */
  color: WorkspaceColor | null;
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
  readerMargins: ReaderMargins;
  /**
   * Ask for confirmation before an in-explorer drag moves a file into another
   * folder (VSCode-style). Default on; unchecking it suppresses the prompt.
   */
  confirmFileMove: boolean;
  /**
   * Live save: automatically write dirty FILE tabs to their own path at the
   * session-flush cadence, instead of only buffering edits until Ctrl+S.
   * Note tabs always autosave regardless. Default off.
   */
  liveSave: boolean;
  /** Extra explorer workspaces beyond the default notes dir. */
  workspaces: WorkspaceEntry[];
  /** Accent color of the default (notes dir) workspace, which has no entry above. */
  defaultWorkspaceColor: WorkspaceColor | null;
}
