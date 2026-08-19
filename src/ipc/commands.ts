/**
 * Typed wrappers for every custom Tauri command — the ONLY place `invoke`
 * is called with a command string. UI/session code imports `ipc` and never
 * touches @tauri-apps/api/core directly, so the Rust↔TS contract can't
 * drift silently: adding a command means editing exactly two files, this
 * one and src-tauri/src/commands/ (checklist in src-tauri/README.md).
 *
 * Error contract: Rust's `FsError` serializes as `{ code, message }`
 * (src-tauri/src/commands/fs.rs). `call` converts that into a typed
 * `IpcError`. Frontend logic switches on `.code`; `.message` is for logs
 * and the status bar only.
 */

import { Channel, invoke } from '@tauri-apps/api/core';

export type IpcErrorCode =
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'INVALID_PATH'
  | 'INVALID_DATA'
  | 'IO'
  /** A child process could not be started (bad program, bad cwd) — pty only. */
  | 'SPAWN';

const IPC_ERROR_CODES: readonly IpcErrorCode[] = [
  'NOT_FOUND',
  'EXISTS',
  'INVALID_PATH',
  'INVALID_DATA',
  'IO',
  'SPAWN',
];

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

function toIpcError(raw: unknown): IpcError {
  if (typeof raw === 'object' && raw !== null) {
    const candidate = raw as { code?: unknown; message?: unknown };
    if (
      typeof candidate.code === 'string' &&
      (IPC_ERROR_CODES as readonly string[]).includes(candidate.code) &&
      typeof candidate.message === 'string'
    ) {
      return new IpcError(candidate.code as IpcErrorCode, candidate.message);
    }
  }
  // Anything unshaped (plugin errors, panics) degrades to IO with its text.
  return new IpcError('IO', typeof raw === 'string' ? raw : JSON.stringify(raw));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toIpcError(raw);
  }
}

/* Mirrors of the Rust structs (serde renames snake_case → camelCase). */

export interface FileText {
  text: string;
  mtimeMs: number;
}

export interface NoteMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface PathStat {
  exists: boolean;
  mtimeMs: number | null;
}

export interface DirEntryMeta {
  path: string;
  isDir: boolean;
  mtimeMs: number;
  size: number;
}

/** Mirrors `SpawnOptions` in src-tauri/src/pty.rs. Desktop only. */
export interface PtySpawnArgs {
  cols: number;
  rows: number;
  /** Defaults to the user's login shell (`default_shell`). */
  program?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

/**
 * What arrives on the spawn channel. Child output is an `ArrayBuffer` — the
 * Rust side sends `InvokeResponseBody::Raw`, so bytes stay bytes across the
 * boundary. Control messages are tagged objects, ordered against the output
 * that preceded them because they share the one channel.
 */
export type PtyMessage = ArrayBuffer | { type: 'exit'; code: number } | { type: 'closed' };

/** One workspace-search hit (mirrors `SearchHit` in commands/search.rs). */
export interface SearchHit {
  path: string;
  line: number;
  col: number;
  lineText: string;
}

/** One raw entry from a synced-folder listing (name only, not a full id). */
export interface SafEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export const ipc = {
  readTextFile: (path: string) => call<FileText>('read_text_file', { path }),
  atomicWriteText: (path: string, text: string) => call<void>('atomic_write_text', { path, text }),
  listNotes: (dir: string) => call<NoteMeta[]>('list_notes', { dir }),
  /** One explorer level: subdirs + .md/image files (dirs A→Z, files newest first). */
  listDir: (dir: string) => call<DirEntryMeta[]>('list_dir', { dir }),
  /** Recursive: does `dir`'s subtree hold anything the explorer would list (or
   *  an extension-less file)? Local paths only — never call with `saf://`. */
  dirHasRelevantFiles: (dir: string) => call<boolean>('dir_has_relevant_files', { dir }),
  /** Secondary-window manifests (`session-<label>.json`) in the session dir. */
  listSessionManifests: (dir: string) => call<string[]>('list_session_manifests', { dir }),
  /** Theme-plugin files (`*.json`) in the themes folder; full paths, sorted. */
  listThemeFiles: (dir: string) => call<string[]>('list_theme_files', { dir }),
  /** Binary file → base64 (image tabs build a data: URL from it). */
  readFileBase64: (path: string) => call<string>('read_file_base64', { path }),
  /** base64 → atomic binary write (pasted clipboard images). */
  writeFileBase64: (path: string, data: string) => call<void>('write_file_base64', { path, data }),
  /** Copy a file; refuses to clobber (EXISTS) like renamePath. */
  copyPath: (from: string, to: string) => call<void>('copy_path', { from, to }),
  /** Create a directory; refuses to clobber (EXISTS). */
  createDir: (path: string) => call<void>('create_dir', { path }),
  /** Recursive case-insensitive substring search under a LOCAL root (capped).
   *  `saf://` roots never come here — the frontend walks those itself. */
  searchNotes: (dir: string, query: string, maxResults: number) =>
    call<SearchHit[]>('search_notes', { dir, query, maxResults }),
  /** Desktop only: replace the set of recursively-watched workspace roots.
   *  Rust emits a debounced `fs-changed` event (payload: affected roots) when
   *  anything under them changes. Not registered on Android — only call
   *  behind a platform check. */
  watchDirs: (dirs: string[]) => call<void>('watch_dirs', { dirs }),
  /** Desktop only: flip the engine's own smooth wheel scrolling for THIS
   *  window (WebKitGTK's enable-smooth-scrolling; a no-op on Windows/macOS,
   *  whose engines have their own behavior). Not registered on Android —
   *  only call behind a platform check. */
  setSmoothScrolling: (enabled: boolean) => call<void>('set_smooth_scrolling', { enabled }),
  /** Desktop only: the display server this process talks to — 'x11',
   *  'wayland', or 'none' off Linux. Gates cursor-position-based features
   *  (the cross-window tab drop) off on Wayland, which offers an app no
   *  global coordinates. Not registered on Android — only call behind a
   *  platform check. */
  displayServer: () => call<string>('display_server'),
  renamePath: (from: string, to: string) => call<void>('rename_path', { from, to }),
  deletePath: (path: string) => call<void>('delete_path', { path }),
  statPath: (path: string) => call<PathStat>('stat_path', { path }),
  /** Files from first-launch argv; call once at boot (see src-tauri/src/lib.rs). */
  drainStartupFiles: () => call<string[]>('drain_startup_files'),
  /**
   * Android only: the app-specific EXTERNAL files dir
   * (`/storage/emulated/0/Android/data/<pkg>/files`), or null if unavailable.
   * The command is not registered on desktop — only call it behind an Android
   * platform check (see src/ipc/paths.ts).
   */
  externalFilesDir: () => call<string | null>('external_files_dir'),
  /**
   * Android only: extract the bundled docs assets to a real filesystem path and
   * return it (null if unavailable). The APK ships docs as compressed assets the
   * std::fs-based read/list commands can't touch, so Settings "Open docs" needs
   * a POSIX copy. Not registered on desktop — only call behind an Android check
   * (see src/ipc/paths.ts).
   */
  extractDocsDir: () => call<string | null>('extract_docs_dir'),
  /**
   * Android only: read a `content://` URI's bytes (base64) + display name, for
   * copy-into-app open of an external file (picker or "Open with" intent). Not
   * registered on desktop — only call it behind an Android platform check.
   */
  readContentUri: (uri: string) =>
    call<{ base64: string; displayName?: string }>('read_content_uri', { uri }),
  /**
   * Android only: drain content:// URIs from incoming "Open with"/"Share"
   * intents since the last call. Called at boot and on window focus.
   */
  takeIncomingUris: () => call<string[]>('take_incoming_uris'),
  /**
   * Android only — Storage Access Framework (synced-folder workspaces). Each
   * addresses a document by (treeUri, relPath) under a persisted-permission
   * tree; the SafProvider (src/ipc/provider.ts) wraps these behind the same
   * `saf://` identifiers the storage router dispatches on. Not registered on
   * desktop — only call behind an Android platform check.
   */
  pickSyncedTree: () => call<{ treeUri: string; displayName?: string }>('pick_synced_tree'),
  safList: (treeUri: string, relPath: string) =>
    call<{ entries: SafEntry[] }>('saf_list', { treeUri, relPath }),
  /** Force a synced dir to re-fetch from its backend (picks up remote changes). */
  safRefresh: (treeUri: string, relPath: string) => call<void>('saf_refresh', { treeUri, relPath }),
  safRead: (treeUri: string, relPath: string) =>
    call<{ base64: string }>('saf_read', { treeUri, relPath }),
  safWrite: (treeUri: string, relPath: string, base64: string) =>
    call<void>('saf_write', { treeUri, relPath, base64 }),
  safCreateDir: (treeUri: string, relPath: string) =>
    call<void>('saf_create_dir', { treeUri, relPath }),
  safRename: (treeUri: string, relPath: string, newName: string) =>
    call<void>('saf_rename', { treeUri, relPath, newName }),
  safDelete: (treeUri: string, relPath: string) => call<void>('saf_delete', { treeUri, relPath }),
  safStat: (treeUri: string, relPath: string) =>
    call<{ exists: boolean; isDir?: boolean; size?: number; mtimeMs?: number }>('saf_stat', {
      treeUri,
      relPath,
    }),
  releaseSyncedTree: (treeUri: string) => call<void>('release_synced_tree', { treeUri }),
  /**
   * Android only — on-device speech-to-text for voice comments. These are native
   * bridges (SpeechRecognizer), not storage ops, so they're called directly
   * behind an `isAndroid()` check, never through a StorageProvider. Not
   * registered on desktop.
   *   - sttAvailable: is on-device recognition available on this device?
   *   - sttPermission: current RECORD_AUDIO grant (no prompt).
   *   - sttRequestPermission: prompt if needed; resolves the resulting grant.
   *   - sttStart: begin listening; resolves the final transcript text.
   *   - sttStop: stop listening (the final transcript still resolves sttStart).
   */
  sttAvailable: () => call<boolean>('stt_available'),
  sttPermission: () => call<boolean>('stt_permission'),
  sttRequestPermission: () => call<boolean>('stt_request_permission'),
  sttStart: () => call<string>('stt_start'),
  sttStop: () => call<void>('stt_stop'),
  /**
   * Android only — take a photo with the system camera (whiteboard scan, S0).
   * Same native-bridge shape as the `stt_*` commands: called directly behind an
   * `isAndroid()` check, never through a StorageProvider, and not registered on
   * desktop (which uses the file picker / clipboard instead).
   *
   * Resolves a JPEG as base64, already EXIF-upright and downscaled on the
   * Kotlin side. Rejects (as an `IpcError` with code `IO`) carrying the native
   * reason: `PERMISSION_DENIED`, `cancelled`, or `NO_CAMERA`.
   */
  capturePhoto: () => call<{ base64: string; width: number; height: number }>('capture_photo'),
  /**
   * Android only — on-device handwriting recognition for the whiteboard scan
   * (S6). Same native-bridge shape as `stt_*`/`capturePhoto`: called behind an
   * `isAndroid()` check, not registered on desktop.
   *
   * `inkRecognize` takes a JSON payload (built by `src/ui/scan-ocr.ts`) of
   * text lines, each a list of strokes in a shared pixel space — ML Kit
   * Digital Ink is a stroke model, and the traced centerlines ARE strokes.
   * Kotlin downloads the language model on first use (may take a while on the
   * first scan; recognition is async by design so nothing blocks on it).
   * Rejects with `INK_UNAVAILABLE` when no model exists for the device
   * language — the caller falls back to `textRecognize`.
   *
   * `textRecognize` runs ML Kit Text Recognition (the printed-text raster
   * model) over a PNG; the fallback when the ink model is missing or fails.
   */
  inkRecognize: (payload: string) =>
    call<{ lines: { text: string; confidence: number | null }[] }>('ink_recognize', { payload }),
  textRecognize: (base64: string) =>
    call<{
      lines: {
        text: string;
        confidence: number | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>('text_recognize', { base64 }),
  /**
   * Windows only — on-device OCR over the cleaned scan raster via
   * `Windows.Media.Ocr` (ships with Windows 10/11, offline). Called behind an
   * `isWindows()` check; not registered on macOS/Linux, which report the scan
   * OCR as unavailable. Line boxes come back in the PNG's own pixel space;
   * confidence is always null (the engine reports none).
   */
  ocrImageAvailable: () => call<boolean>('ocr_image_available'),
  ocrImageRecognize: (pngBase64: string) =>
    call<{
      engine: string;
      lines: {
        text: string;
        confidence: number | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }[];
    }>('ocr_image_recognize', { pngBase64 }),

  /* ---------------------------- terminal pty ---------------------------- */
  /* Desktop only: these commands are not registered on Android (no pty).
     Everything above the IPC layer goes through src/ipc/pty.ts, never here. */

  /** The shell a profile spawns when it names no program. */
  defaultShell: () => call<string>('default_shell'),

  ptySpawn: (options: PtySpawnArgs, onEvent: Channel<PtyMessage>) =>
    call<number>('pty_spawn', { options, onEvent }),

  // `invoke` args are JSON, and a Uint8Array would stringify to `{"0":…}`,
  // which serde rejects. Keystrokes and chunked pastes are small (paste is
  // already split into 4 KB writes by renderer/paste.ts).
  ptyWrite: (id: number, data: Uint8Array) =>
    call<void>('pty_write', { id, data: Array.from(data) }),

  ptyResize: (id: number, cols: number, rows: number) =>
    call<void>('pty_resize', { id, cols, rows }),

  ptyKill: (id: number) => call<void>('pty_kill', { id }),
};

export type Ipc = typeof ipc;

/** Injectable so tests can drive a pty provider without a Tauri runtime. */
export type ChannelFactory = () => Channel<PtyMessage>;

export const createIpcChannel: ChannelFactory = () => new Channel<PtyMessage>();
