/**
 * new-workspace.ts — the pure side of "Create new workspace": whether a typed
 * name can be a folder, and where the new folder goes by default.
 *
 * The folder name is checked against the strictest rules the app runs under
 * (Windows), so a workspace made on one machine syncs to every other.
 */

import { dirName } from './session/plan-flush';

// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows forbids
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why `name` cannot be a folder name, or null when it can. Expects it trimmed. */
export function folderNameError(name: string): string | null {
  if (name.length === 0) {
    return 'Give the workspace a name.';
  }
  if (name === '.' || name === '..') {
    return 'That name is reserved.';
  }
  if (ILLEGAL_CHARS.test(name)) {
    return 'A folder name cannot contain < > : " / \\ | ? *';
  }
  if (/[. ]$/.test(name)) {
    return 'A folder name cannot end with a dot or a space.';
  }
  if (RESERVED.test(name)) {
    return `"${name}" is reserved by Windows.`;
  }
  if (name.length > 255) {
    return 'That name is too long.';
  }
  return null;
}

export interface WorkspaceParentHints {
  /** Folders added to the explorer, oldest first. */
  workspacePaths: readonly string[];
  /** The default (notes) workspace, if any. */
  defaultWorkspacePath: string | null;
  /** The app's own data folder: a default workspace inside it is no place to put projects. */
  appDataDir: string | null;
  documentsDir: string | null;
}

/**
 * Where a new workspace is created unless the user picks elsewhere: next to
 * the most recently added workspace (so the last place used is remembered
 * for free), else next to the default workspace when the user moved it out of
 * app data, else the Documents folder, else nowhere (null — the user must
 * choose).
 */
export function defaultWorkspaceParent(hints: WorkspaceParentHints): string | null {
  const { defaultWorkspacePath, appDataDir } = hints;
  const candidates = [...hints.workspacePaths].reverse();
  if (defaultWorkspacePath && !(appDataDir && isInside(defaultWorkspacePath, appDataDir))) {
    candidates.push(defaultWorkspacePath);
  }
  for (const path of candidates) {
    const parent = dirName(trimSeparators(path));
    if (parent.length > 0) {
      // "D:" alone means the drive's current directory, not its root.
      return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
    }
  }
  return hints.documentsDir;
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function isInside(path: string, dir: string): boolean {
  const key = (p: string) => trimSeparators(p.replaceAll('\\', '/').toLowerCase());
  return `${key(path)}/`.startsWith(`${key(dir)}/`);
}
