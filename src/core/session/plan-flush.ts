/**
 * Session persistence, part 1: the flush planner and executor.
 *
 * The design is a strict PLAN → EXECUTE split:
 *
 * - `planFlush` is a PURE function: current app state in, a `FlushPlan` of
 *   filesystem operations out. All the tricky logic (slug collisions, lazy
 *   renames, what to delete) lives here where Vitest can reach it.
 * - `executeFlushPlan` performs the plan through an injected `FlushIo`
 *   (the real one wraps src/ipc/commands.ts; tests use a fake).
 *
 * THE ordering invariant (I4): the manifest is written LAST, after every
 * buffer/note write it references. A crash mid-flush therefore leaves the
 * PREVIOUS manifest pointing at intact files — stale by at most maxWaitMs,
 * but always self-consistent. Never reorder this.
 *
 * Data placement (two tiers — see src/core/README.md for the rationale):
 * - Note tabs are real `.md` files in the NOTES DIR (user-visible data).
 *   Filename = slugified title (+ `-2`, `-3` collision suffix). Renames are
 *   lazy: they happen during a flush, only when the slug actually changed,
 *   and a failed rename (sync-tool lock, EXISTS race) is tolerated — the
 *   old path stays, writes are redirected back to it, and the next flush
 *   retries. The tab LABEL mirrors this slug (tabDisplayTitle), so name and
 *   file stay matched; the note's `title` field is just the slug's source.
 * - The SESSION DIR (machine-local app data, never synced) holds
 *   `session.json` plus `buffers/<tabId>.md` — unsaved edits of FILE tabs
 *   only. Note tabs need no buffer: their note file IS the persistence.
 *
 * Deliberate, user-visible semantics (mirrors Windows Notepad):
 * - Closing a note tab DISCARDS it: its note file is deleted (UI confirms
 *   for non-empty notes; the store then records the path in
 *   `closedNotePaths` for the next flush).
 * - "Save As" on a note tab converts it to a file tab; the note file is
 *   deleted the same way (the note graduated — no duplicate truth).
 */

import type { CursorPos, EditorMode, TabKind } from '../types';
import { slugifyTitle } from '../title';

/* ----------------------------- input view ------------------------------ */

/** Read-only view of one tab, assembled by the tabs store for planning. */
export interface SessionTabView {
  id: string;
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  /** Display title (customTitle ?? deriveTitle(text)) — drives the slug. */
  title: string;
  /** Canonical text from the DocModel. */
  text: string;
  mode: EditorMode;
  /** model.isDirty('session') — needs a note/buffer write this flush. */
  sessionDirty: boolean;
  /** model.isDirty('file') — file tabs only; decides whether a buffer exists. */
  fileDirty: boolean;
  savedMtimeMs: number | null;
  cursor: CursorPos | null;
}

export interface AppSessionView {
  notesDir: string;
  /** Machine-local session dir; manifest and buffers live under it. */
  sessionDir: string;
  /**
   * This window's manifest filename inside sessionDir (M8 multi-window:
   * 'session.json' for the main window, 'session-<label>.json' for torn-off
   * tab windows). Absent = 'session.json'.
   */
  manifestName?: string;
  activeTabId: string | null;
  tabs: SessionTabView[];
  /**
   * Basenames (e.g. "todo.md") currently on disk in notesDir. Needed so a
   * NEW note never silently clobbers a file no open tab owns. Callers keep
   * this fresh from restore + their own flush results.
   */
  existingNoteFiles: string[];
  /** Note files of tabs closed (= discarded) since the last flush. */
  closedNotePaths: string[];
  /** Buffer files made obsolete since the last flush (tab saved or closed). */
  obsoleteBufferPaths: string[];
  /**
   * `from` paths of note renames the flusher has given up on (after ~3
   * consecutive failures — see src/core/README.md rename-failure policy).
   * planFlush keeps such files at their CURRENT name rather than re-planning
   * a doomed rename every flush. Optional: absent/empty suppresses nothing.
   */
  suppressedRenamePaths?: ReadonlySet<string>;
}

/* ------------------------------ manifest ------------------------------- */

export interface PersistedTab {
  id: string;
  kind: TabKind;
  notePath: string | null;
  filePath: string | null;
  customTitle: string | null;
  mode: EditorMode;
  savedMtimeMs: number | null;
  hasBuffer: boolean;
  cursor: CursorPos | null;
}

export interface SessionManifest {
  schema: 1;
  activeTabId: string | null;
  tabs: PersistedTab[];
}

/** Safe manifest parse: null on any structural problem (caller self-heals). */
export function parseManifest(raw: string): SessionManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const m = value as Record<string, unknown>;
  if (m.schema !== 1 || !Array.isArray(m.tabs)) {
    return null;
  }
  for (const tab of m.tabs) {
    if (typeof tab !== 'object' || tab === null) {
      return null;
    }
    const t = tab as Record<string, unknown>;
    if (
      typeof t.id !== 'string' ||
      (t.kind !== 'note' && t.kind !== 'file' && t.kind !== 'image')
    ) {
      return null;
    }
  }
  return value as SessionManifest;
}

/* -------------------------------- plan --------------------------------- */

export interface WriteOp {
  path: string;
  text: string;
}

export interface RenameOp {
  from: string;
  to: string;
}

export interface FlushPlan {
  /** Applied first. A failure here is tolerated (see executeFlushPlan). */
  noteRenames: RenameOp[];
  /** Note files + buffers; every one goes through atomic_write_text. */
  writes: WriteOp[];
  /** Closed note files + obsolete buffers. delete_path is idempotent. */
  deletes: string[];
  manifestPath: string;
  manifest: SessionManifest;
  /** tabId → note path assigned by THIS plan (new notes). The caller applies
   *  these to the store only after executeFlushPlan resolves. */
  assignedNotePaths: Record<string, string>;
}

/** Forward-slash join; Rust's PathBuf handles mixed separators fine. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}/${name}`;
}

export function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Directory portion of a path (everything before the final separator). */
export function dirName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(0, idx) : '';
}

/** File extension including the dot (`report.md` → `.md`), or '' if none. */
export function extName(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

export function bufferPathFor(sessionDir: string, tabId: string): string {
  return joinPath(joinPath(sessionDir, 'buffers'), `${tabId}.md`);
}

/** Split an absolute path into its root (drive `C:`, `/`, or '') + segments. */
function splitPath(path: string): { root: string; segments: string[] } {
  const normalized = path.replace(/\\/g, '/');
  const drive = /^([a-zA-Z]:)\/?/.exec(normalized);
  let root = '';
  let rest = normalized;
  if (drive) {
    root = drive[1]!.toUpperCase();
    rest = normalized.slice(drive[0].length);
  } else if (normalized.startsWith('/')) {
    root = '/';
    rest = normalized.slice(1);
  }
  const segments = rest.split('/').filter((s) => s.length > 0 && s !== '.');
  return { root, segments };
}

/**
 * Relative path FROM a directory TO a target file, always with forward slashes
 * (portable, and valid in a markdown link on every OS). Returns null when no
 * relative path exists — different Windows drive letters or roots — so the
 * caller can fall back to an absolute path.
 */
export function relativePath(fromDir: string, toPath: string): string | null {
  const from = splitPath(fromDir);
  const to = splitPath(toPath);
  if (from.root.toLowerCase() !== to.root.toLowerCase()) {
    return null;
  }
  let i = 0;
  while (
    i < from.segments.length &&
    i < to.segments.length &&
    from.segments[i]!.toLowerCase() === to.segments[i]!.toLowerCase()
  ) {
    i++;
  }
  const up = from.segments.slice(i).map(() => '..');
  const down = to.segments.slice(i);
  const rel = [...up, ...down].join('/');
  if (rel === '') {
    return '.';
  }
  // A path that stays at or below `fromDir` gets an explicit `./` so it reads
  // as relative rather than looking like a bare filename or a URL scheme.
  return up.length === 0 ? `./${rel}` : rel;
}

/**
 * Resolve `target` against `baseDir` into an absolute, forward-slashed path,
 * collapsing `.`/`..` segments. An already-absolute `target` (drive letter or
 * `/` root) is returned normalized, ignoring `baseDir`. When `baseDir` has no
 * root either (an unsaved document), the best we can do is a normalized
 * relative path — the inverse of {@link relativePath}.
 */
export function toAbsolutePath(baseDir: string, target: string): string {
  const t = splitPath(target);
  const base = t.root !== '' ? t : splitPath(baseDir);
  const segments = t.root !== '' ? t.segments : [...base.segments, ...t.segments];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  const body = out.join('/');
  if (base.root === '/') {
    return `/${body}`;
  }
  if (base.root === '') {
    return body; // no absolute base to resolve against (unsaved doc)
  }
  return `${base.root}/${body}`;
}

/**
 * Pick `slug.md`, or `slug-2.md`, `slug-3.md`… — first name not in `taken`.
 * `taken` must be lowercase: Windows and macOS filesystems are
 * case-insensitive, so collision checks have to be too.
 */
function resolveCollision(slug: string, taken: ReadonlySet<string>): string {
  const plain = `${slug}.md`;
  if (!taken.has(plain)) {
    return plain;
  }
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function planFlush(view: AppSessionView): FlushPlan {
  const noteRenames: RenameOp[] = [];
  const writes: WriteOp[] = [];
  const assignedNotePaths: Record<string, string> = {};

  // The taken-name set starts as: everything on disk, plus every open note
  // tab's current basename. Each tab's own name is removed just for its own
  // resolution, then the CHOSEN name is added back — later tabs see it.
  const taken = new Set<string>(view.existingNoteFiles.map((n) => n.toLowerCase()));
  for (const tab of view.tabs) {
    if (tab.kind === 'note' && tab.notePath) {
      taken.add(baseName(tab.notePath).toLowerCase());
    }
  }

  // Planned note paths per tab id — the manifest must reference the paths as
  // they will be AFTER this plan's renames/writes.
  const plannedNotePath = new Map<string, string | null>();

  for (const tab of view.tabs) {
    if (tab.kind !== 'note') {
      continue;
    }
    const currentName = tab.notePath ? baseName(tab.notePath) : null;
    const slug = slugifyTitle(tab.title);

    if (currentName !== null) {
      taken.delete(currentName.toLowerCase());
    }
    const desiredName = resolveCollision(slug, taken);
    taken.add(desiredName.toLowerCase());

    if (currentName === null) {
      // New note. No file until there is content (empty tabs cost nothing).
      if (tab.text.length === 0) {
        plannedNotePath.set(tab.id, null);
        continue;
      }
      const path = joinPath(view.notesDir, desiredName);
      assignedNotePaths[tab.id] = path;
      plannedNotePath.set(tab.id, path);
      writes.push({ path, text: tab.text });
      continue;
    }

    // Existing note: rename lazily when the slug-derived name changed.
    let path = tab.notePath as string;
    if (desiredName.toLowerCase() !== currentName.toLowerCase()) {
      if (view.suppressedRenamePaths?.has(path)) {
        // Given up on this rename: keep the current name. Undo the tentative
        // reservation of `desiredName` and keep `currentName` reserved so a
        // later tab neither steals this file's name nor is blocked by a name
        // we won't actually use.
        taken.delete(desiredName.toLowerCase());
        taken.add(currentName.toLowerCase());
      } else {
        const to = joinPath(view.notesDir, desiredName);
        noteRenames.push({ from: path, to });
        path = to;
      }
    }
    plannedNotePath.set(tab.id, path);
    if (tab.sessionDirty) {
      writes.push({ path, text: tab.text });
    }
  }

  // File tabs: unsaved edits live in a session buffer.
  for (const tab of view.tabs) {
    if (tab.kind === 'file' && tab.fileDirty && tab.sessionDirty) {
      writes.push({ path: bufferPathFor(view.sessionDir, tab.id), text: tab.text });
    }
  }

  const manifest: SessionManifest = {
    schema: 1,
    activeTabId: view.activeTabId,
    tabs: view.tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      notePath: tab.kind === 'note' ? (plannedNotePath.get(tab.id) ?? tab.notePath) : null,
      filePath: tab.filePath,
      customTitle: tab.customTitle,
      mode: tab.mode,
      savedMtimeMs: tab.savedMtimeMs,
      hasBuffer: tab.kind === 'file' && tab.fileDirty,
      cursor: tab.cursor,
    })),
  };

  return {
    noteRenames,
    writes,
    deletes: [...view.closedNotePaths, ...view.obsoleteBufferPaths],
    manifestPath: joinPath(view.sessionDir, view.manifestName ?? 'session.json'),
    manifest,
    assignedNotePaths,
  };
}

/* ------------------------------- execute ------------------------------- */

/** Injected I/O — the real implementation wraps src/ipc/commands.ts. */
export interface FlushIo {
  atomicWriteText(path: string, text: string): Promise<void>;
  renamePath(from: string, to: string): Promise<void>;
  deletePath(path: string): Promise<void>;
}

export interface FlushResult {
  /** Renames that failed and were tolerated; the caller keeps the old path
   *  in the store so the next flush retries (give up after ~3 attempts). */
  renameFailures: RenameOp[];
  assignedNotePaths: Record<string, string>;
}

/**
 * Execute in the invariant order: renames → writes → deletes → manifest.
 * Rename failures are tolerated (redirected); ANY OTHER failure throws,
 * leaving the previous manifest in charge — the flusher retries.
 */
export async function executeFlushPlan(plan: FlushPlan, io: FlushIo): Promise<FlushResult> {
  const renameFailures: RenameOp[] = [];
  for (const rename of plan.noteRenames) {
    try {
      await io.renamePath(rename.from, rename.to);
    } catch {
      renameFailures.push(rename);
    }
  }

  // Writes aimed at a failed rename's target go back to the old path.
  const redirect = new Map(renameFailures.map((r) => [r.to, r.from]));
  for (const write of plan.writes) {
    await io.atomicWriteText(redirect.get(write.path) ?? write.path, write.text);
  }

  for (const path of plan.deletes) {
    await io.deletePath(path);
  }

  // Manifest LAST (invariant I4), patched so it never references a path a
  // failed rename left nonexistent.
  let manifest = plan.manifest;
  if (redirect.size > 0) {
    manifest = {
      ...manifest,
      tabs: manifest.tabs.map((tab) =>
        tab.notePath !== null && redirect.has(tab.notePath)
          ? { ...tab, notePath: redirect.get(tab.notePath) as string }
          : tab,
      ),
    };
  }
  await io.atomicWriteText(plan.manifestPath, JSON.stringify(manifest, null, 2));

  return { renameFailures, assignedNotePaths: plan.assignedNotePaths };
}
