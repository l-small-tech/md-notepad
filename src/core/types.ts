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
 * 'import' — a foreign document (PDF/DOCX) shown as an inline import card over
 *           `filePath`: offers a one-click "Import as Markdown" (no dialog), or
 *           a link to the already-imported note. Like 'image', it holds no text
 *           and is only recorded in the manifest.
 */
export type TabKind = 'note' | 'file' | 'image' | 'import';

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
  /**
   * Chrome-style tab group membership: id of a TabGroup in the tabs store, or
   * null for an ungrouped tab. Members of one group are always CONTIGUOUS in
   * the tab strip (core/tab-groups.ts owns that invariant).
   */
  groupId: string | null;
}

/**
 * A Chrome-style tab group: a named, colored, collapsible band around a
 * contiguous run of tabs. Groups are per-window (they live in that window's
 * tabs store and session manifest) and vanish when their last member closes.
 */
export interface TabGroup {
  id: string;
  /** Display name; empty shows the chip as a plain colored dot (Chrome-style). */
  name: string;
  /** Accent color token — same palette as workspace accents (data-color CSS). */
  color: WorkspaceColor;
  /** Collapsed groups render only their chip; member tabs are hidden. */
  collapsed: boolean;
}

/**
 * Read-mode side margins. Named modes instead of pixels — each maps to a
 * responsive gutter in preview.css (narrow ≈ near-full-width text, wide ≈ a
 * book-like centered column).
 */
export type ReaderMargins = 'narrow' | 'normal' | 'wide';

/**
 * Editor caret (text cursor) styles. Each maps to a `--caret-width` (and, for
 * 'underscore', a bottom-border geometry) in base.css, keyed off the
 * `data-cursor` attribute on <html>:
 * - 'bar'        — the default vertical bar, a hair thicker than CM's native 1.2px.
 * - 'thin'       — a 1px hairline bar.
 * - 'thick'      — a bold vertical bar.
 * - 'underscore' — an underline caret under the character.
 */
export const CURSOR_STYLES = ['bar', 'thin', 'thick', 'underscore'] as const;

export type CursorStyle = (typeof CURSOR_STYLES)[number];

/**
 * Where a pasted/dropped image is saved, relative to the markdown file it is
 * embedded into:
 * - 'subfolder'     — a folder (named by `imageFolderName`) beside the .md file.
 * - 'sameFolder'    — right next to the .md file, no subfolder.
 * - 'workspaceRoot' — one shared folder (named by `imageFolderName`) at the
 *                     root of the workspace the file belongs to.
 */
export type ImagePasteLocation = 'subfolder' | 'sameFolder' | 'workspaceRoot';

/**
 * Editor color scheme — the palette family id, chosen independently of light/dark
 * (the `theme` setting still decides light-vs-dark, and OS auto-switching keeps
 * working). A scheme supplies BOTH a light and a dark palette by overriding the
 * ten `--bg`/`--fg`/`--accent`/… variables, keyed off `data-color-scheme` on
 * <html>. Because the whole app (CM6, preview, reader) styles itself only through
 * those variables, switching schemes needs no code beyond flipping the attribute.
 *
 * The id is a free-form string, not a closed union: schemes are pluggable theme
 * files loaded from the themes folder at runtime (see core/theme-plugins.ts,
 * ipc/theme-loader.ts). 'default' is the built-in blue/grey palette in base.css
 * (it has no plugin — the base :root IS its palette); an id with no loaded plugin
 * simply matches no injected block and falls through to that default.
 */
export const DEFAULT_COLOR_SCHEME = 'default';

export type ColorScheme = string;

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
 * Bundled editor typefaces (all SIL OFL 1.1, shipped via @fontsource; woff2
 * files are only fetched by the WebView when a family is actually used).
 * Display labels and CSS stacks live in ./fonts.ts.
 */
export const EDITOR_FONT_IDS = [
  'fira-code',
  'jetbrains-mono',
  'cascadia-code',
  'source-code-pro',
  'ibm-plex-mono',
  'inconsolata',
  'victor-mono',
] as const;

export type EditorFontId = (typeof EDITOR_FONT_IDS)[number];

/**
 * Typeface for the UI chrome (tabs, sidebar, dialogs — not the note text).
 * 'match' follows the editor font (the app's classic monospace-everywhere
 * look); 'inter' is the bundled Inter sans; 'system' is the OS UI font.
 */
export const UI_FONT_IDS = ['match', 'inter', 'system'] as const;

export type UiFontId = (typeof UI_FONT_IDS)[number];

/**
 * A workspace is just a folder the file explorer lists. The notes dir is the
 * implicit default workspace and is NOT stored here — this array holds only
 * the extra folders the user added (removing one never touches its files).
 */
export interface WorkspaceEntry {
  /** Display name; defaults to the folder's basename when added. */
  name: string;
  /**
   * The workspace root identifier. For a local workspace this is an absolute
   * folder path; for a `kind: 'synced'` workspace it is the opaque scheme-
   * prefixed id `saf://<encodeURIComponent(treeUri)>` the storage router
   * dispatches on (see src/ipc/provider.ts). Never lowercase/normalize a
   * synced id — SAF document ids are case-sensitive.
   */
  path: string;
  /** Accent color, or null for none. */
  color: WorkspaceColor | null;
  /**
   * Read-only workspace (the bundled documentation): files open pinned to
   * read mode and the explorer offers no create/rename/move/delete for it.
   */
  readOnly?: boolean;
  /**
   * 'synced' = an Android Storage-Access-Framework folder (Google Drive,
   * OneDrive, an SD card, …) whose ops route through the SafProvider. Absent
   * or 'local' = an ordinary filesystem folder. Persisted so the workspace
   * survives relaunch.
   */
  kind?: 'local' | 'synced';
  /**
   * `kind: 'synced'` only — the durable SAF tree URI whose persisted
   * permission Android re-grants on launch. It is the release handle used when
   * the workspace is removed (releasePersistableUriPermission).
   */
  treeUri?: string;
}

export interface Settings {
  /** null = platform default: appDataDir()/notes (resolved in src/ipc, not here). */
  notesDir: string | null;
  theme: 'system' | 'light' | 'dark';
  /** Palette family; light-vs-dark still comes from `theme`. Default 'default'. */
  colorScheme: ColorScheme;
  fontSize: number;
  /** Editor/content typeface. Default 'fira-code'. */
  editorFont: EditorFontId;
  /** UI-chrome typeface. Default 'match' (follow the editor font). */
  uiFont: UiFontId;
  defaultMode: EditorMode;
  wordWrap: boolean;
  /**
   * Code ligatures (-> as a single glyph) in fonts that carry them
   * (Fira Code, JetBrains Mono, Cascadia Code, Victor Mono). Default on.
   */
  ligatures: boolean;
  readerMargins: ReaderMargins;
  /** Editor caret shape/weight. Default 'bar'. */
  cursorStyle: CursorStyle;
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
  /**
   * Preview tabs (VSCode-style): single-clicking a file in the explorer opens
   * it in a shared, italic "preview" tab; selecting another file reuses that
   * tab instead of piling up new ones. The preview becomes a permanent tab as
   * soon as you edit it, double-click it in the explorer, or pick "Keep open".
   * Default on; off makes every click open its own persistent tab.
   */
  previewTabs: boolean;
  /** Extra explorer workspaces beyond the default notes dir. */
  workspaces: WorkspaceEntry[];
  /** Accent color of the default (notes dir) workspace, which has no entry above. */
  defaultWorkspaceColor: WorkspaceColor | null;
  /** Where pasted/dropped images land relative to their markdown file. Default 'subfolder'. */
  imagePasteLocation: ImagePasteLocation;
  /**
   * Folder name used by the 'subfolder' and 'workspaceRoot' storage modes
   * (ignored by 'sameFolder'). Default 'images'.
   */
  imageFolderName: string;
  /**
   * Explorer tree shape, persisted so the drawer reopens (and the app relaunches)
   * looking exactly as it was left. Not user-facing settings — no dialog field —
   * they just ride along on the same persisted store.
   *
   * Note the inverted polarity, which mirrors the defaults: workspaces start
   * EXPANDED so this holds the collapsed ones; subfolders start COLLAPSED so
   * `explorerExpandedDirs` holds the open ones.
   */
  explorerCollapsedWorkspaces: string[];
  explorerExpandedDirs: string[];
}
