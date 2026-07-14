/**
 * Storage-provider seam.
 *
 * All of the app's file I/O goes through a `StorageProvider`. Today the only
 * provider is `LocalFsProvider` — literally the `ipc` fs wrappers plus a
 * capabilities descriptor — so this indirection is behaviourally a no-op on
 * desktop and Android alike. Its purpose is forward-looking: a future cloud
 * drive (OneDrive, Google Drive, …) becomes a new `StorageProvider` whose
 * methods interpret their own scheme-prefixed identifiers, and swapping it in is
 * the only change needed — `setProvider(new OneDriveProvider(...))`. The app's
 * path helpers (`pathKey`, `splitPath`, …) stay local-only concerns because
 * identifiers remain opaque strings that each provider interprets itself.
 */

import { ipc, type Ipc } from './commands';
import { isAndroid } from '../ui/platform';

export interface StorageCapabilities {
  /** Can the user pick an arbitrary folder as a root/workspace? (No on Android/cloud.) */
  canPickDir: boolean;
  /** Does the backend support cheap rename/move in place? */
  canRename: boolean;
  /** True only for the real local filesystem; gates desktop path assumptions if ever needed. */
  isLocalFs: boolean;
}

/**
 * The storage surface a provider must implement: exactly the fs methods the app
 * already calls on `ipc`. Local FS is `ipc`; a cloud provider implements the
 * same shape over its own identifiers.
 */
export type StorageOps = Pick<
  Ipc,
  | 'readTextFile'
  | 'atomicWriteText'
  | 'listNotes'
  | 'listDir'
  | 'listSessionManifests'
  | 'readFileBase64'
  | 'writeFileBase64'
  | 'copyPath'
  | 'createDir'
  | 'renamePath'
  | 'deletePath'
  | 'statPath'
>;

export interface StorageProvider extends StorageOps {
  readonly id: string;
  readonly capabilities: StorageCapabilities;
}

/** The local filesystem provider — the `ipc` fs wrappers, unchanged. */
export const LocalFsProvider: StorageProvider = {
  id: 'local',
  // No arbitrary folder picking on Android (SAF folder-picking is out of scope);
  // the single app-scoped Notes workspace is the whole surface there.
  capabilities: { canPickDir: !isAndroid(), canRename: true, isLocalFs: true },
  readTextFile: ipc.readTextFile,
  atomicWriteText: ipc.atomicWriteText,
  listNotes: ipc.listNotes,
  listDir: ipc.listDir,
  listSessionManifests: ipc.listSessionManifests,
  readFileBase64: ipc.readFileBase64,
  writeFileBase64: ipc.writeFileBase64,
  copyPath: ipc.copyPath,
  createDir: ipc.createDir,
  renamePath: ipc.renamePath,
  deletePath: ipc.deletePath,
  statPath: ipc.statPath,
};

let active: StorageProvider = LocalFsProvider;

/** The active storage provider. The session controller routes all fs I/O here. */
export function currentProvider(): StorageProvider {
  return active;
}

/** Swap the active provider (future cloud-drive entry point). */
export function setProvider(provider: StorageProvider): void {
  active = provider;
}
