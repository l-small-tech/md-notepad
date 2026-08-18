/**
 * Settings schema + normalization.
 *
 * Settings are persisted via tauri-plugin-store (see src/README.md), which
 * hands back `unknown` JSON. `normalizeSettings` is the single choke point
 * that turns anything — missing file, older schema, hand-edited garbage —
 * into a valid `Settings`, field by field. There is deliberately no zod/
 * schema library: a handful of fields doesn't justify a dependency.
 */

import {
  CURSOR_STYLES,
  DEFAULT_COLOR_SCHEME,
  EDITOR_FONT_IDS,
  SHELL_PROFILE_ID,
  TERMINAL_BELLS,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_EXIT_BEHAVIORS,
  UI_FONT_IDS,
  WORKSPACE_COLORS,
} from './types';
import {
  DEFAULT_SCAN_PRESET,
  DEFAULT_SCAN_SMOOTHING,
  SCAN_PRESETS,
  SCAN_SMOOTHING,
  type ScanPreset,
  type ScanSmoothing,
} from './whiteboard/scan/types';
import type {
  CursorStyle,
  EditorFontId,
  Settings,
  TerminalBell,
  TerminalCursorStyle,
  TerminalExitBehavior,
  TerminalProfile,
  UiFontId,
  WorkspaceColor,
  WorkspaceEntry,
} from './types';

/**
 * The profiles a fresh install offers. The first is the login shell, which is
 * why it names no program: Rust resolves `$SHELL` at spawn time. The second is
 * an example agentic-CLI profile — harmless when `claude` is not installed
 * (the pane shows the spawn error and nothing else breaks).
 */
export const DEFAULT_TERMINAL_PROFILES: readonly TerminalProfile[] = [
  { id: SHELL_PROFILE_ID, name: 'System shell', args: [], env: {} },
  { id: 'claude', name: 'Claude Code', program: 'claude', args: [], env: {} },
];

export const DEFAULT_SETTINGS: Settings = {
  notesDir: null,
  theme: 'system',
  colorScheme: 'default',
  fontSize: 14,
  editorFont: 'fira-code',
  uiFont: 'match',
  defaultMode: 'raw',
  wordWrap: true,
  lineNumbers: false,
  ligatures: true,
  readerMargins: 'normal',
  cursorStyle: 'bar',
  confirmFileMove: true,
  liveSave: false,
  previewTabs: true,
  workspaces: [],
  defaultWorkspaceColor: null,
  imagePasteLocation: 'subfolder',
  imageFolderName: 'images',
  explorerCollapsedWorkspaces: [],
  explorerExpandedDirs: [],
  scanPreset: DEFAULT_SCAN_PRESET,
  scanSmoothing: DEFAULT_SCAN_SMOOTHING,

  terminalProfiles: DEFAULT_TERMINAL_PROFILES.map((profile) => ({ ...profile })),
  defaultTerminalProfile: SHELL_PROFILE_ID,
  terminalScrollback: 10_000,
  terminalScrollLines: 3,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalBell: 'visual',
  terminalCopyOnSelect: false,
  terminalConfirmMultilinePaste: true,
  terminalAllowOscClipboard: false,
  terminalAltSendsEscape: true,
  terminalBackspaceSendsDelete: true,
  terminalOnExit: 'close',
  terminalConfirmCloseRunning: true,
};

/** Bounds the settings UI enforces, exported so the UI cannot disagree. */
export const TERMINAL_SCROLLBACK_RANGE = { min: 0, max: 1_000_000 } as const;
export const TERMINAL_SCROLL_LINES_RANGE = { min: 1, max: 20 } as const;

/**
 * Upper bound on a persisted explorer path list. Folders the user expanded and
 * then deleted (or renamed) leave entries nothing prunes, so without a cap the
 * list would grow forever across sessions. Oldest entries fall off first.
 */
export const MAX_EXPLORER_PATHS = 200;

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
    // Synced (SAF) workspaces carry two extra fields that must survive a
    // round-trip through the store, or the persisted folder-permission handle
    // (treeUri) is lost and the workspace can't be reconnected after relaunch.
    const synced = entry.kind === 'synced' && typeof entry.treeUri === 'string';
    out.push({
      name,
      path: entry.path,
      color: normalizeColor(entry.color),
      ...(entry.readOnly === true ? { readOnly: true } : {}),
      ...(synced ? { kind: 'synced' as const, treeUri: entry.treeUri as string } : {}),
    });
  }
  return out;
}

/** Non-empty strings only, de-duplicated, newest-last, capped. */
export function normalizePathList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value === 'string' && value.length > 0) {
      seen.add(value);
    }
  }
  const out = [...seen];
  return out.length > MAX_EXPLORER_PATHS ? out.slice(out.length - MAX_EXPLORER_PATHS) : out;
}

/** A string map with string values; anything else in it is dropped. */
function normalizeEnv(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 0 && typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/** One hand-editable profile. Returns null when it has no usable id. */
export function normalizeTerminalProfile(raw: unknown): TerminalProfile | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id.length === 0) {
    return null;
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id;
  const program =
    typeof raw.program === 'string' && raw.program.trim().length > 0
      ? raw.program.trim()
      : undefined;
  const cwd = typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined;
  const fontSize =
    typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
      ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(raw.fontSize)))
      : undefined;
  return {
    id,
    name,
    ...(program ? { program } : {}),
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
    ...(cwd ? { cwd } : {}),
    env: normalizeEnv(raw.env),
    ...(fontSize !== undefined ? { fontSize } : {}),
  };
}

/**
 * The profile list, always non-empty: an empty or unreadable list falls back
 * to the defaults, because a terminal with no profile could never be opened
 * and the user would have no UI to fix it with.
 */
function normalizeTerminalProfiles(raw: unknown): TerminalProfile[] {
  const list = Array.isArray(raw)
    ? raw.map(normalizeTerminalProfile).filter((p): p is TerminalProfile => p !== null)
    : [];
  const seen = new Set<string>();
  // Later duplicates lose: the first entry for an id is the one tabs resolve.
  const unique = list.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return unique.length > 0 ? unique : DEFAULT_TERMINAL_PROFILES.map((p) => ({ ...p }));
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, Math.round(raw)))
    : fallback;
}

/** Per-field validation; every invalid field falls back to its default. */
export function normalizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_SETTINGS;
  // Any non-empty string is a valid scheme id now (themes are pluggable —
  // core/theme-plugins.ts). An id with no loaded theme falls through to the
  // default palette at render time, so no allowlist is needed here.
  const colorScheme =
    typeof r.colorScheme === 'string' && r.colorScheme.trim().length > 0
      ? r.colorScheme.trim()
      : DEFAULT_COLOR_SCHEME;
  const rawTheme =
    r.theme === 'system' || r.theme === 'light' || r.theme === 'dark' ? r.theme : d.theme;
  const terminalProfiles = normalizeTerminalProfiles(r.terminalProfiles);
  return {
    notesDir: typeof r.notesDir === 'string' && r.notesDir.length > 0 ? r.notesDir : d.notesDir,
    // The Theme picker is unified (Settings): a plugin scheme always follows the
    // OS light/dark, so light/dark is only a meaningful override for the built-in
    // `default` palette. Coerce any legacy `theme: 'light'|'dark'` paired with a
    // plugin back to 'system' so persisted state matches the merged model.
    theme: colorScheme === DEFAULT_COLOR_SCHEME ? rawTheme : 'system',
    colorScheme,
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
    lineNumbers: typeof r.lineNumbers === 'boolean' ? r.lineNumbers : d.lineNumbers,
    ligatures: typeof r.ligatures === 'boolean' ? r.ligatures : d.ligatures,
    readerMargins:
      r.readerMargins === 'narrow' || r.readerMargins === 'normal' || r.readerMargins === 'wide'
        ? r.readerMargins
        : d.readerMargins,
    cursorStyle: (CURSOR_STYLES as readonly unknown[]).includes(r.cursorStyle)
      ? (r.cursorStyle as CursorStyle)
      : d.cursorStyle,
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
    explorerCollapsedWorkspaces: normalizePathList(r.explorerCollapsedWorkspaces),
    explorerExpandedDirs: normalizePathList(r.explorerExpandedDirs),
    scanPreset:
      typeof r.scanPreset === 'string' && r.scanPreset in SCAN_PRESETS
        ? (r.scanPreset as ScanPreset)
        : d.scanPreset,
    scanSmoothing:
      typeof r.scanSmoothing === 'string' && r.scanSmoothing in SCAN_SMOOTHING
        ? (r.scanSmoothing as ScanSmoothing)
        : d.scanSmoothing,

    terminalProfiles: terminalProfiles,
    // A default naming no surviving profile would make "New terminal" fail
    // silently, so it degrades to the first profile that does exist.
    defaultTerminalProfile: terminalProfiles.some((p) => p.id === r.defaultTerminalProfile)
      ? (r.defaultTerminalProfile as string)
      : (terminalProfiles[0]?.id ?? SHELL_PROFILE_ID),
    terminalScrollback: clampInt(
      r.terminalScrollback,
      d.terminalScrollback,
      TERMINAL_SCROLLBACK_RANGE.min,
      TERMINAL_SCROLLBACK_RANGE.max,
    ),
    terminalScrollLines: clampInt(
      r.terminalScrollLines,
      d.terminalScrollLines,
      TERMINAL_SCROLL_LINES_RANGE.min,
      TERMINAL_SCROLL_LINES_RANGE.max,
    ),
    terminalCursorStyle: (TERMINAL_CURSOR_STYLES as readonly unknown[]).includes(
      r.terminalCursorStyle,
    )
      ? (r.terminalCursorStyle as TerminalCursorStyle)
      : d.terminalCursorStyle,
    terminalCursorBlink:
      typeof r.terminalCursorBlink === 'boolean' ? r.terminalCursorBlink : d.terminalCursorBlink,
    terminalBell: (TERMINAL_BELLS as readonly unknown[]).includes(r.terminalBell)
      ? (r.terminalBell as TerminalBell)
      : d.terminalBell,
    terminalCopyOnSelect:
      typeof r.terminalCopyOnSelect === 'boolean' ? r.terminalCopyOnSelect : d.terminalCopyOnSelect,
    terminalConfirmMultilinePaste:
      typeof r.terminalConfirmMultilinePaste === 'boolean'
        ? r.terminalConfirmMultilinePaste
        : d.terminalConfirmMultilinePaste,
    terminalAllowOscClipboard:
      typeof r.terminalAllowOscClipboard === 'boolean'
        ? r.terminalAllowOscClipboard
        : d.terminalAllowOscClipboard,
    terminalAltSendsEscape:
      typeof r.terminalAltSendsEscape === 'boolean'
        ? r.terminalAltSendsEscape
        : d.terminalAltSendsEscape,
    terminalBackspaceSendsDelete:
      typeof r.terminalBackspaceSendsDelete === 'boolean'
        ? r.terminalBackspaceSendsDelete
        : d.terminalBackspaceSendsDelete,
    terminalOnExit: (TERMINAL_EXIT_BEHAVIORS as readonly unknown[]).includes(r.terminalOnExit)
      ? (r.terminalOnExit as TerminalExitBehavior)
      : d.terminalOnExit,
    terminalConfirmCloseRunning:
      typeof r.terminalConfirmCloseRunning === 'boolean'
        ? r.terminalConfirmCloseRunning
        : d.terminalConfirmCloseRunning,
  };
}

/** The profile with this id, or the default one, or the first that exists. */
export function resolveTerminalProfile(settings: Settings, id?: string): TerminalProfile {
  const byId = id ? settings.terminalProfiles.find((p) => p.id === id) : undefined;
  if (byId) {
    return byId;
  }
  const fallback = settings.terminalProfiles.find((p) => p.id === settings.defaultTerminalProfile);
  return fallback ?? settings.terminalProfiles[0] ?? { ...DEFAULT_TERMINAL_PROFILES[0]! };
}
