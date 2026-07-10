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

export const ipc = {
  readTextFile: (path: string) => call<FileText>('read_text_file', { path }),
  atomicWriteText: (path: string, text: string) => call<void>('atomic_write_text', { path, text }),
  listNotes: (dir: string) => call<NoteMeta[]>('list_notes', { dir }),
  /** One explorer level: subdirs + .md/image files (dirs A→Z, files newest first). */
  listDir: (dir: string) => call<DirEntryMeta[]>('list_dir', { dir }),
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
};

export type Ipc = typeof ipc;
