/**
 * Explorer operations — the FileExplorer's context-menu and drag-drop disk
 * surgery: new file/folder, rename (routed through the owning tab when one
 * exists), move (with tab retargeting and the comments sidecar following), and
 * delete (owning tab closed first so it can't write the bytes back).
 */

import { baseName, dirName, extName, joinPath } from '../../core/session/plan-flush';
import { commentsPathFor, isCommentsPath } from '../../core/comments';
import { blankWhiteboardSource } from '../../core/whiteboard/serialize';
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
   * Context-menu "New vector drawing": write a blank board (`.svg`) into `dir`
   * and open it. Unlike "New file" this one does NOT start an inline rename —
   * a drawing opens straight into Draw mode, and the point of the entry is to
   * be drawing a second later; the row can still be renamed the usual way.
   */
  async function createNewWhiteboard(dir: string): Promise<string | null> {
    if (ctx.refuseReadOnly(dir)) {
      return null;
    }
    try {
      const target = await ctx.uniquePathIn(dir, 'drawing', '.svg');
      await ctx.ipc.atomicWriteText(target, blankWhiteboardSource());
      uiStore.getState().refreshExplorer();
      await openPaths([target]);
      return target;
    } catch (error) {
      uiStore.getState().showNotice('Could not create a drawing there.');
      ctx.deps.onError?.(error);
      return null;
    }
  }

  /**
   * The same thing with no directory named — what the new-tab menu's "Vector
   * drawing" does. It lands beside the tab in front (a drawing made from a
   * note belongs with that note), falling back to the notes dir when nothing
   * open has a home yet.
   */
  function createNewWhiteboardHere(): Promise<string | null> {
    const tab = tabsStore.getState().activeTab();
    const path = tab?.filePath ?? tab?.notePath ?? null;
    const dir = path ? dirName(path) : '';
    return createNewWhiteboard(dir || ctx.notesDir);
  }

  /**
   * "Import › Scan whiteboard as image…" lands here with the finished bytes:
   * write them as a uniquely-named image file in `dir` and open it. The scan
   * screen produced the bytes; this owns naming, disk and the explorer.
   * `ext` includes the dot ('.png' / '.jpg').
   */
  async function createScanImage(dir: string, ext: string, base64: string): Promise<string | null> {
    if (ctx.refuseReadOnly(dir)) {
      return null;
    }
    try {
      const target = await ctx.uniquePathIn(dir, 'scan', ext);
      await ctx.ipc.writeFileBase64(target, base64);
      uiStore.getState().refreshExplorer();
      await openPaths([target]);
      return target;
    } catch (error) {
      uiStore.getState().showNotice('Could not save the scanned image there.');
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
    // Raw compare, not pathKey: a case-only rename of the note must carry the
    // sidecar's spelling along with it.
    if (from === to) {
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

  /**
   * The on-disk mtime baseline to hand a tab whose file just moved to `path`,
   * falling back to the tab's previous one when the stat fails (harmless — the
   * next save re-stats anyway).
   */
  async function mtimeOf(path: string, tab: { savedMtimeMs: number | null }): Promise<number> {
    try {
      const stat = await ctx.ipc.statPath(path);
      if (stat.mtimeMs !== null) {
        return stat.mtimeMs;
      }
    } catch {
      // Keep the prior baseline.
    }
    return tab.savedMtimeMs ?? ctx.now();
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
    // Compare the BASENAMES, not pathKey: the directory is unchanged by
    // construction, and pathKey lowercases — a case-only rename ("notes" →
    // "Notes") is a real rename the user asked for, not a no-op. Comparing
    // raw paths wouldn't do either: joinPath uses "/" while the listing hands
    // us Windows "\" separators.
    if (baseName(newPath) === baseName(path)) {
      return; // nothing changed
    }
    // On a case-insensitive filesystem the case-only target "exists" because
    // it IS this entry, so the collision guard has to skip it (rename_path
    // makes the same distinction on the Rust side).
    const caseOnly = pathKey(newPath) === pathKey(path);
    try {
      if (!caseOnly && (await ctx.ipc.statPath(newPath)).exists) {
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
   * `destDir`, keeping its basename. `destDir` is ANY writable folder or
   * workspace root — a move across workspaces (even one on another drive; the
   * backend falls back to copy+delete there) is the same operation as a move
   * into a sibling folder. Confirms first (VSCode-style) unless the user turned
   * that prompt off in settings. No-ops when it's already there; refuses a name
   * collision.
   *
   * A tab that owns the file is retargeted so the flusher and restore stay
   * consistent:
   * - file/image/import tabs — `retargetFilePath`;
   * - a NOTE tab still landing directly in the notes dir — `applyFlushResult`
   *   (the same remap changeNotesDir uses), since it is still a note;
   * - a NOTE tab moved ANYWHERE ELSE — it stops being a note
   *   (`adoptMovedNoteAsFile`). A note file's name follows the tab title and
   *   lives in the notes dir by definition, so leaving it a note would let the
   *   next title change drag the file back there, and closing the tab would
   *   delete it out of its new workspace.
   */
  async function moveEntry(sourcePath: string, destDir: string): Promise<void> {
    if (ctx.refuseReadOnly(sourcePath) || ctx.refuseReadOnly(destDir)) {
      return;
    }
    // A note tab's file is written LAZILY (and renamed to follow the title) by
    // the flusher: drain it first, so the bytes being moved are current and no
    // in-flight rename can race the move. The drain may itself have renamed the
    // file, so re-read the path from the tab afterwards.
    let source = sourcePath;
    const noteOwner = ctx.tabOwning(pathKey(sourcePath));
    if (noteOwner?.kind === 'note') {
      await ctx.flusher.flushNow();
      const flushed = tabsStore.getState().tabs.find((t) => t.id === noteOwner.id);
      if (flushed?.notePath) {
        source = flushed.notePath;
      }
    }
    if (pathKey(dirName(source)) === pathKey(destDir)) {
      return; // already in this folder
    }
    const newPath = joinPath(destDir, baseName(source));
    if (pathKey(newPath) === pathKey(source)) {
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
        `Move "${baseName(source)}" to "${baseName(destDir)}"?`,
        'Move file',
      );
      if (!ok) {
        return;
      }
    }
    const owner = ctx.tabOwning(pathKey(source));
    try {
      await ctx.ipc.renamePath(source, newPath);
    } catch (error) {
      uiStore.getState().showNotice(`Could not move "${baseName(source)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    await moveCommentsSidecar(source, newPath);
    if (owner && (owner.kind === 'file' || owner.kind === 'image' || owner.kind === 'import')) {
      tabsStore
        .getState()
        .retargetFilePath(owner.id, { filePath: newPath, mtimeMs: await mtimeOf(newPath, owner) });
    } else if (owner && owner.kind === 'note') {
      if (pathKey(dirName(newPath)) === pathKey(ctx.notesDir)) {
        tabsStore.getState().applyFlushResult({
          assignedNotePaths: {},
          renamedPaths: { [source]: newPath },
          consumedClosedNotePaths: [],
          consumedObsoleteBufferTabIds: [],
        });
      } else {
        tabsStore.getState().adoptMovedNoteAsFile(owner.id, {
          filePath: newPath,
          mtimeMs: await mtimeOf(newPath, owner),
        });
      }
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

  /**
   * Context-menu "Delete" for a folder entry. Recursive and unrecoverable (no
   * trash), so it confirms with an explicit "everything inside it" warning. Any
   * tab whose file lives anywhere under the folder is closed BEFORE the delete —
   * same guard as {@link deleteEntry}, widened to the whole subtree so neither
   * Ctrl+S nor the flusher can recreate a file from a still-open editor. The
   * backend `delete_path` removes the directory tree (comments sidecars and all).
   */
  async function deleteFolder(path: string): Promise<void> {
    if (ctx.refuseReadOnly(path)) {
      return;
    }
    const ok = await ctx.confirm(
      `Delete the folder "${baseName(path)}" and everything inside it? This can’t be undone.`,
      'Delete folder',
    );
    if (!ok) {
      return;
    }
    const prefix = `${pathKey(path)}/`;
    for (const t of tabsStore.getState().tabs) {
      const owned = t.filePath ?? t.notePath;
      if (owned && pathKey(owned).startsWith(prefix)) {
        tabsStore.getState().closeTab(t.id);
      }
    }
    try {
      await ctx.ipc.deletePath(path);
    } catch (error) {
      uiStore.getState().showNotice(`Could not delete "${baseName(path)}".`);
      ctx.deps.onError?.(error);
      return;
    }
    uiStore.getState().showNotice(`Deleted "${baseName(path)}".`);
    uiStore.getState().dropSelectedExplorerDirUnder(path);
    uiStore.getState().refreshExplorer();
  }

  return {
    createNewFile,
    createNewWhiteboard,
    createNewWhiteboardHere,
    createScanImage,
    createNewFolder,
    renameEntry,
    moveEntry,
    deleteEntry,
    deleteFolder,
  };
}
