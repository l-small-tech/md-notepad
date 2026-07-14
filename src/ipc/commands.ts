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

import { invoke } from '@tauri-apps/api/core';

export type IpcErrorCode = 'NOT_FOUND' | 'EXISTS' | 'INVALID_PATH' | 'INVALID_DATA' | 'IO';

const IPC_ERROR_CODES: readonly IpcErrorCode[] = [
  'NOT_FOUND',
  'EXISTS',
  'INVALID_PATH',
  'INVALID_DATA',
  'IO',
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
  /** Secondary-window manifests (`session-<label>.json`) in the session dir. */
  listSessionManifests: (dir: string) => call<string[]>('list_session_manifests', { dir }),
  /** Binary file → base64 (image tabs build a data: URL from it). */
  readFileBase64: (path: string) => call<string>('read_file_base64', { path }),
  /** base64 → atomic binary write (pasted clipboard images). */
  writeFileBase64: (path: string, data: string) => call<void>('write_file_base64', { path, data }),
  /** Copy a file; refuses to clobber (EXISTS) like renamePath. */
  copyPath: (from: string, to: string) => call<void>('copy_path', { from, to }),
  /** Create a directory; refuses to clobber (EXISTS). */
  createDir: (path: string) => call<void>('create_dir', { path }),
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
};

export type Ipc = typeof ipc;
