/**
 * Explorer operations — the FileExplorer's context-menu and drag-drop disk
 * surgery: new file/folder, rename (routed through the owning tab when one
 * exists), move (with tab retargeting and the comments sidecar following), and
 * delete (owning tab closed first so it can't write the bytes back).
 */

import { baseName, dirName, extName, joinPath } from '../../core/session/plan-flush';
import { commentsPathFor, isCommentsPath } from '../../core/comments';
import { dropTrailingExtension, sanitizeFileBaseName } from '../../core/title';
import { settingsStore } from '../stores/settings';
import { tabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';
import { pathKey } from './facade';

export function createExplorerOps(
  ctx: SessionCtx,
  openPaths: (paths: string[], opts?: { preview?: boolean }) => Promise<void>,
  renameFileTab: (id: string, newName: string) => Promise<void>,
) {
  /**
   * Context-menu "New file": create an empty, uniquely-named .md file in
   * `dir`, open it as a file tab, and begin the inline tab rename so the user
   * can name it in one motion (the rename also renames the file on disk).
   */
  async function createNewFile(dir: string): Promise<string | null> {
    if (ctx.refuseReadOnly(dir)) {
      return null;
    }
    try {
      const target = await ctx.uniquePathIn(dir, 'untitled', '.md');
      await ctx.ipc.atomicWriteText(target, '');
      uiStore.getState().refreshExplorer();
      await openPaths([target]);
      // Naming happens inline on the file's explorer row (the caller starts
      // the rename with this path); no tab-rename here so there's one input.
      return target;
    } catch (error) {
      uiStore.getState().showNotice('Could not create a new file there.');
      ctx.deps.onError?.(error);
      return null;
    }
  }

  /**
   * Context-menu "New folder": create a uniquely-named subfolder in `dir` and
   * return its path so the caller can begin the inline rename on its explorer
   * row (same one-motion naming as "New file").
   */
  async function createNewFolder(dir: string): Promise<string | null> {
    if (ctx.refuseReadOnly(dir)) {
      return null;
    }
    try {
      const target = await ctx.uniquePathIn(dir, 'new-folder', '');
      await ctx.ipc.createDir(target);
      uiStore.getState().refreshExplorer();
      return target;
    } catch (error) {
      uiStore.getState().showNotice('Could not create a folder there.');
      ctx.deps.onError?.(error);
      return null;
    }
  }

  /**
   * Context-menu "Rename" for an explorer entry. A file some tab already owns
   * goes through the tab-rename flow instead of a raw disk rename — one code
   * path for the clobber guard and tab retarget (file/image tabs) or the
   * title-drives-the-filename flush machinery (note tabs). Renaming a folder
   * retargets every open tab whose file lives under it.
   */
  /**
   * Best-effort: follow a note file's `.comments.md` sidecar when the note file
   * is renamed/moved, so its voice comments stay attached. A stranded sidecar is
   * harmless (it re-associates by name if the note is renamed back) and never
   * loses transcripts, so any failure is swallowed. Desktop audio clips are not
   * relocated on a cross-directory move yet (a documented follow-up).
   */
  async function moveCommentsSidecar(oldNotePath: string, newNotePath: string): Promise<void> {
    if (isCommentsPath(oldNotePath) || extName(oldNotePath).toLowerCase() !== '.md') {
      return;
    }
    const from = commentsPathFor(oldNotePath);
    const to = commentsPathFor(newNotePath);
    if (pathKey(from) === pathKey(to)) {
      return;
    }
    try {
      if ((await ctx.ipc.statPath(from)).exists) {
        await ctx.ipc.renamePath(from, to);
      }
    } catch {
      // Best effort — see the doc comment.
    }
  }

  async function renameEntry(path: string, newName: string, isDir: boolean): Promise<void> {
    if (ctx.refuseReadOnly(path)) {
      return;
    }
    const owner = isDir ? undefined : ctx.tabOwning(pathKey(path));
    if (owner && (owner.kind === 'file' || owner.kind === 'image' || owner.kind === 'import')) {
      await renameFileTab(owner.id, newName);
      uiStore.getState().refreshExplorer();
      return;
    }
    if (owner) {
      // A note tab: its filename follows the tab title (slugged) at the next
      // flush — renaming the file out from under the flusher would fight it.
      tabsStore.getState().renameTab(owner.id, newName);
      return;
    }
    const ext = isDir ? '' : extName(path);
    // If the user typed the extension too ("notes.md"), don't double it.
    const safeBase = sanitizeFileBaseName(dropTrailingExtension(newName.trim(), ext));
    if (!safeBase) {
      uiStore.getState().showNotice('That name can’t be used.');
      return;
    }
    const newPath = joinPath(dirName(path), `${safeBase}${ext}`);
    if (pathKey(newPath) === pathKey(path)) {
      return; // no change (or case-only on a case-insensitive FS)
    }
    try {
      if ((await ctx.ipc.statPath(newPath)).exists) {
        uiStore.getState().showNotice(`"${baseName(newPath)}" already exists.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the rename; renamePath below
      // will surface a real problem.
    }
    try {
      await ctx.ipc.renamePath(path, newPath);
    } catch (error) {
      uiStore.getState().showNotice(`Could not rename "${baseName(path)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    if (!isDir) {
      await moveCommentsSidecar(path, newPath);
    }
    if (isDir) {
      // Retarget open tabs whose files lived under the renamed folder. Key
      // comparison for the prefix match, raw-path surgery for the new value
      // (pathKey preserves length, so slicing by `path.length` is safe).
      const oldPrefix = `${pathKey(path)}/`;
      const renamedNotePaths: Record<string, string> = {};
      for (const t of tabsStore.getState().tabs) {
        if (t.filePath && pathKey(t.filePath).startsWith(oldPrefix)) {
          tabsStore.getState().retargetFilePath(t.id, {
            filePath: newPath + t.filePath.slice(path.length),
            mtimeMs: t.savedMtimeMs ?? ctx.now(),
          });
        } else if (t.notePath && pathKey(t.notePath).startsWith(oldPrefix)) {
          renamedNotePaths[t.notePath] = newPath + t.notePath.slice(path.length);
        }
      }
      if (Object.keys(renamedNotePaths).length > 0) {
        tabsStore.getState().applyFlushResult({
          assignedNotePaths: {},
          renamedPaths: renamedNotePaths,
          consumedClosedNotePaths: [],
          consumedObsoleteBufferTabIds: [],
        });
      }
    }
    uiStore.getState().refreshExplorer();
  }

  /**
   * Drag-drop move: relocate a single file/image from the explorer into
   * `destDir`, keeping its basename. Confirms first (VSCode-style) unless the
   * user turned that prompt off in settings. No-ops when it's already there;
   * refuses a name collision. A tab that owns the file is retargeted so the
   * flusher and restore stay consistent — file/image tabs via retargetFilePath,
   * note tabs via applyFlushResult (same remap changeNotesDir uses).
   */
  async function moveEntry(sourcePath: string, destDir: string): Promise<void> {
    if (ctx.refuseReadOnly(sourcePath) || ctx.refuseReadOnly(destDir)) {
      return;
    }
    if (pathKey(dirName(sourcePath)) === pathKey(destDir)) {
      return; // already in this folder
    }
    const newPath = joinPath(destDir, baseName(sourcePath));
    if (pathKey(newPath) === pathKey(sourcePath)) {
      return;
    }
    try {
      if ((await ctx.ipc.statPath(newPath)).exists) {
        uiStore.getState().showNotice(`"${baseName(newPath)}" already exists in that folder.`);
        return;
      }
    } catch {
      // A transient stat failure must not block the move; renamePath surfaces
      // any real problem below.
    }
    if (settingsStore.getState().settings.confirmFileMove) {
      const ok = await ctx.confirm(
        `Move "${baseName(sourcePath)}" to "${baseName(destDir)}"?`,
        'Move file',
      );
      if (!ok) {
        return;
      }
    }
    const owner = ctx.tabOwning(pathKey(sourcePath));
    try {
      await ctx.ipc.renamePath(sourcePath, newPath);
    } catch (error) {
      uiStore.getState().showNotice(`Could not move "${baseName(sourcePath)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    await moveCommentsSidecar(sourcePath, newPath);
    if (owner && (owner.kind === 'file' || owner.kind === 'image' || owner.kind === 'import')) {
      let mtimeMs = owner.savedMtimeMs ?? ctx.now();
      try {
        const after = await ctx.ipc.statPath(newPath);
        mtimeMs = after.mtimeMs ?? mtimeMs;
      } catch {
        // Keep the prior baseline; the next save re-stats anyway.
      }
      tabsStore.getState().retargetFilePath(owner.id, { filePath: newPath, mtimeMs });
    } else if (owner && owner.kind === 'note') {
      tabsStore.getState().applyFlushResult({
        assignedNotePaths: {},
        renamedPaths: { [sourcePath]: newPath },
        consumedClosedNotePaths: [],
        consumedObsoleteBufferTabIds: [],
      });
    }
    uiStore.getState().refreshExplorer();
  }

  /**
   * Context-menu "Delete" for a file/image entry. Deletion is unrecoverable
   * (there is no trash), so it confirms first. A tab that owns the file is
   * closed BEFORE the delete so neither Ctrl+S nor the flusher can recreate the
   * file from the still-open editor. Folders aren't deletable here — delete_path
   * removes files only.
   */
  async function deleteEntry(path: string): Promise<void> {
    if (ctx.refuseReadOnly(path)) {
      return;
    }
    const ok = await ctx.confirm(
      `Delete "${baseName(path)}"? This can’t be undone.`,
      'Delete file',
    );
    if (!ok) {
      return;
    }
    const owner = ctx.tabOwning(pathKey(path));
    if (owner) {
      tabsStore.getState().closeTab(owner.id);
    }
    try {
      await ctx.ipc.deletePath(path);
    } catch (error) {
      uiStore.getState().showNotice(`Could not delete "${baseName(path)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    uiStore.getState().showNotice(`Deleted "${baseName(path)}".`);
    uiStore.getState().refreshExplorer();
  }

  return { createNewFile, createNewFolder, renameEntry, moveEntry, deleteEntry };
}
