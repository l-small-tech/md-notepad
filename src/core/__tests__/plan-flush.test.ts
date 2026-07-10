import { describe, expect, test, vi } from 'vitest';
import {
  executeFlushPlan,
  parseManifest,
  planFlush,
  relativePath,
  toAbsolutePath,
  type AppSessionView,
  type FlushIo,
  type SessionTabView,
} from '../session/plan-flush';

function tab(partial: Partial<SessionTabView> & { id: string }): SessionTabView {
  return {
    kind: 'note',
    notePath: null,
    filePath: null,
    customTitle: null,
    title: 'Untitled',
    text: '',
    mode: 'raw',
    sessionDirty: false,
    fileDirty: false,
    savedMtimeMs: null,
    cursor: null,
    ...partial,
  };
}

function view(partial?: Partial<AppSessionView>): AppSessionView {
  return {
    notesDir: '/notes',
    sessionDir: '/session',
    activeTabId: null,
    tabs: [],
    existingNoteFiles: [],
    closedNotePaths: [],
    obsoleteBufferPaths: [],
    ...partial,
  };
}

describe('planFlush — note tabs', () => {
  test('a new note with content gets a slugged path and a write', () => {
    const plan = planFlush(
      view({
        tabs: [tab({ id: 't1', title: 'Buy Milk!', text: '# Buy Milk!', sessionDirty: true })],
      }),
    );
    expect(plan.writes).toEqual([{ path: '/notes/buy-milk.md', text: '# Buy Milk!' }]);
    expect(plan.assignedNotePaths).toEqual({ t1: '/notes/buy-milk.md' });
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/buy-milk.md');
  });

  test('a new EMPTY note creates no file (empty tabs cost nothing)', () => {
    const plan = planFlush(view({ tabs: [tab({ id: 't1', sessionDirty: true })] }));
    expect(plan.writes).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({});
    expect(plan.manifest.tabs[0]?.notePath).toBeNull();
  });

  test('two new notes with the same title get collision suffixes', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({ id: 't1', title: 'Idea', text: 'a', sessionDirty: true }),
          tab({ id: 't2', title: 'Idea', text: 'b', sessionDirty: true }),
        ],
      }),
    );
    expect(plan.writes.map((w) => w.path)).toEqual(['/notes/idea.md', '/notes/idea-2.md']);
  });

  test('a new note never clobbers an on-disk file no tab owns', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'],
        tabs: [tab({ id: 't1', title: 'Idea', text: 'x', sessionDirty: true })],
      }),
    );
    expect(plan.writes[0]?.path).toBe('/notes/idea-2.md');
  });

  test('collision checks are case-insensitive (Windows/macOS filesystems)', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['Idea.md'],
        tabs: [tab({ id: 't1', title: 'idea', text: 'x', sessionDirty: true })],
      }),
    );
    expect(plan.writes[0]?.path).toBe('/notes/idea-2.md');
  });

  test('a dirty existing note writes to its current path — no rename when slug is unchanged', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Idea',
            text: 'updated',
            sessionDirty: true,
          }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([{ path: '/notes/idea.md', text: 'updated' }]);
  });

  test('a clean existing note produces no operations at all', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Idea', text: 'x' })] }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  test('a title change plans a lazy rename; manifest points at the NEW path', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Grand Plan',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/idea.md', to: '/notes/grand-plan.md' }]);
    expect(plan.writes).toEqual([{ path: '/notes/grand-plan.md', text: 'body' }]);
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/grand-plan.md');
  });

  test('rename-only flush when the title changed but content did not', () => {
    const plan = planFlush(
      view({
        tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Renamed', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/idea.md', to: '/notes/renamed.md' }]);
    expect(plan.writes).toEqual([]);
  });

  test('a rename target avoids other tabs and disk files', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['taken.md'],
        tabs: [tab({ id: 't1', notePath: '/notes/other.md', title: 'Taken', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([{ from: '/notes/other.md', to: '/notes/taken-2.md' }]);
  });

  test('a tab whose name already matches its slug is not renamed to itself', () => {
    const plan = planFlush(
      view({
        existingNoteFiles: ['idea.md'], // the tab's own file also shows up in the listing
        tabs: [tab({ id: 't1', notePath: '/notes/idea.md', title: 'Idea', text: 'x' })],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
  });

  test('a suppressed rename is skipped; the file keeps its current name', () => {
    const plan = planFlush(
      view({
        suppressedRenamePaths: new Set(['/notes/idea.md']),
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/idea.md',
            title: 'Grand Plan',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    // No rename planned, and the content write goes to the OLD path…
    expect(plan.noteRenames).toEqual([]);
    expect(plan.writes).toEqual([{ path: '/notes/idea.md', text: 'body' }]);
    // …and the manifest keeps pointing at the current name.
    expect(plan.manifest.tabs[0]?.notePath).toBe('/notes/idea.md');
  });

  test('suppressing one rename leaves its slug free for another tab', () => {
    const plan = planFlush(
      view({
        suppressedRenamePaths: new Set(['/notes/idea.md']),
        tabs: [
          // t1 wants to become grand-plan.md but is suppressed → stays idea.md.
          tab({ id: 't1', notePath: '/notes/idea.md', title: 'Grand Plan', text: 'a' }),
          // t2 is a fresh note that also slugs to grand-plan; the freed name is
          // available to it (no -2 suffix).
          tab({ id: 't2', title: 'Grand Plan', text: 'b', sessionDirty: true }),
        ],
      }),
    );
    expect(plan.noteRenames).toEqual([]);
    expect(plan.assignedNotePaths).toEqual({ t2: '/notes/grand-plan.md' });
  });
});

describe('planFlush — file tabs, deletes, manifest', () => {
  test('a dirty file tab writes a session buffer and is flagged hasBuffer', () => {
    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 'f1',
            kind: 'file',
            filePath: 'C:/docs/readme.md',
            text: 'unsaved edits',
            sessionDirty: true,
            fileDirty: true,
            savedMtimeMs: 111,
          }),
        ],
      }),
    );
    expect(plan.writes).toEqual([{ path: '/session/buffers/f1.md', text: 'unsaved edits' }]);
    expect(plan.manifest.tabs[0]).toMatchObject({
      kind: 'file',
      filePath: 'C:/docs/readme.md',
      hasBuffer: true,
      savedMtimeMs: 111,
    });
  });

  test('a clean file tab gets no buffer and hasBuffer=false', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 'f1', kind: 'file', filePath: 'C:/docs/readme.md', text: 'x' })] }),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.manifest.tabs[0]?.hasBuffer).toBe(false);
  });

  test('closed notes and obsolete buffers become deletes', () => {
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/discarded.md'],
        obsoleteBufferPaths: ['/session/buffers/gone.md'],
      }),
    );
    expect(plan.deletes).toEqual(['/notes/discarded.md', '/session/buffers/gone.md']);
  });

  test('manifest carries tab order, active tab, modes and cursors', () => {
    const plan = planFlush(
      view({
        activeTabId: 't2',
        tabs: [
          tab({ id: 't1', notePath: '/notes/a.md', title: 'A', text: 'a', mode: 'split' }),
          tab({
            id: 't2',
            notePath: '/notes/b.md',
            title: 'B',
            text: 'b',
            mode: 'wysiwyg',
            customTitle: 'B',
            cursor: { anchor: 3, head: 7 },
          }),
        ],
      }),
    );
    expect(plan.manifest).toMatchObject({
      schema: 1,
      activeTabId: 't2',
      tabs: [
        { id: 't1', mode: 'split' },
        { id: 't2', mode: 'wysiwyg', customTitle: 'B', cursor: { anchor: 3, head: 7 } },
      ],
    });
    expect(plan.manifestPath).toBe('/session/session.json');
  });
});

describe('executeFlushPlan', () => {
  function fakeIo() {
    const ops: string[] = [];
    const io: FlushIo = {
      atomicWriteText: vi.fn(async (path: string) => {
        ops.push(`write:${path}`);
      }),
      renamePath: vi.fn(async (from: string, to: string) => {
        ops.push(`rename:${from}->${to}`);
      }),
      deletePath: vi.fn(async (path: string) => {
        ops.push(`delete:${path}`);
      }),
    };
    return { ops, io };
  }

  test('executes renames → writes → deletes → manifest LAST (invariant I4)', async () => {
    const { ops, io } = fakeIo();
    const plan = planFlush(
      view({
        closedNotePaths: ['/notes/old.md'],
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/a.md',
            title: 'Renamed',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    await executeFlushPlan(plan, io);
    expect(ops).toEqual([
      'rename:/notes/a.md->/notes/renamed.md',
      'write:/notes/renamed.md',
      'delete:/notes/old.md',
      'write:/session/session.json',
    ]);
  });

  test('a failed rename is tolerated: write redirected, manifest patched, failure reported', async () => {
    const { io } = fakeIo();
    vi.mocked(io.renamePath).mockRejectedValueOnce(new Error('EXISTS: sync tool lock'));
    const written = new Map<string, string>();
    vi.mocked(io.atomicWriteText).mockImplementation(async (path, text) => {
      written.set(path, text);
    });

    const plan = planFlush(
      view({
        tabs: [
          tab({
            id: 't1',
            notePath: '/notes/a.md',
            title: 'Renamed',
            text: 'body',
            sessionDirty: true,
          }),
        ],
      }),
    );
    const result = await executeFlushPlan(plan, io);

    expect(result.renameFailures).toEqual([{ from: '/notes/a.md', to: '/notes/renamed.md' }]);
    // The note write went back to the OLD path…
    expect(written.get('/notes/a.md')).toBe('body');
    expect(written.has('/notes/renamed.md')).toBe(false);
    // …and the manifest references the old path too, never a phantom file.
    const manifest = JSON.parse(written.get('/session/session.json') ?? '{}');
    expect(manifest.tabs[0].notePath).toBe('/notes/a.md');
  });

  test('a failed write aborts the flush BEFORE the manifest is touched', async () => {
    const { ops, io } = fakeIo();
    vi.mocked(io.atomicWriteText).mockRejectedValueOnce(new Error('disk full'));
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', title: 'A', text: 'a', sessionDirty: true })] }),
    );
    await expect(executeFlushPlan(plan, io)).rejects.toThrow('disk full');
    expect(ops.filter((op) => op.includes('session.json'))).toEqual([]);
  });
});

describe('parseManifest', () => {
  test('round-trips a planned manifest', () => {
    const plan = planFlush(
      view({ tabs: [tab({ id: 't1', title: 'A', text: 'a', sessionDirty: true })] }),
    );
    const parsed = parseManifest(JSON.stringify(plan.manifest));
    expect(parsed).toEqual(plan.manifest);
  });

  test('rejects garbage, wrong schema, and malformed tabs', () => {
    expect(parseManifest('not json at all {{{')).toBeNull();
    expect(parseManifest('null')).toBeNull();
    expect(parseManifest(JSON.stringify({ schema: 2, tabs: [] }))).toBeNull();
    expect(parseManifest(JSON.stringify({ schema: 1, tabs: [{ id: 42 }] }))).toBeNull();
    expect(
      parseManifest(JSON.stringify({ schema: 1, tabs: [{ id: 'a', kind: 'nope' }] })),
    ).toBeNull();
  });
});

describe('relativePath', () => {
  test('descends into a subdirectory (explicit ./ prefix)', () => {
    expect(relativePath('/notes', '/notes/images/pic.png')).toBe('./images/pic.png');
  });

  test('same directory yields ./name', () => {
    expect(relativePath('/notes', '/notes/other.md')).toBe('./other.md');
  });

  test('ascends with ../ for a sibling directory', () => {
    expect(relativePath('/notes/sub', '/notes/other.md')).toBe('../other.md');
    expect(relativePath('/a/b/c', '/a/x/y.md')).toBe('../../x/y.md');
  });

  test('normalizes Windows backslashes and drive letters to forward slashes', () => {
    expect(relativePath('C:\\Users\\me\\notes', 'C:\\Users\\me\\pics\\a.png')).toBe(
      '../pics/a.png',
    );
    expect(relativePath('C:\\Users\\me\\notes', 'C:\\Users\\me\\notes\\a.png')).toBe('./a.png');
  });

  test('treats drive letters case-insensitively (same root)', () => {
    expect(relativePath('c:/users/me', 'C:/users/me/x.png')).toBe('./x.png');
  });

  test('returns null across different drives (no relative path exists)', () => {
    expect(relativePath('C:\\Users\\me', 'D:\\media\\a.png')).toBeNull();
  });

  test('returns . when the target IS the directory', () => {
    expect(relativePath('/notes', '/notes')).toBe('.');
  });
});

describe('toAbsolutePath', () => {
  test('joins a relative target onto a POSIX base dir', () => {
    expect(toAbsolutePath('/notes', 'pics/a.png')).toBe('/notes/pics/a.png');
    expect(toAbsolutePath('/notes', './pics/a.png')).toBe('/notes/pics/a.png');
  });

  test('collapses ../ segments', () => {
    expect(toAbsolutePath('/notes/sub', '../a.png')).toBe('/notes/a.png');
    expect(toAbsolutePath('/a/b/c', '../../x/y.png')).toBe('/a/x/y.png');
  });

  test('resolves against a Windows drive base, forward-slashed', () => {
    expect(toAbsolutePath('C:\\Users\\me\\notes', 'pics\\a.png')).toBe(
      'C:/Users/me/notes/pics/a.png',
    );
    expect(toAbsolutePath('C:\\Users\\me\\notes', '..\\shared\\a.png')).toBe(
      'C:/Users/me/shared/a.png',
    );
  });

  test('an already-absolute target is returned normalized, ignoring the base', () => {
    expect(toAbsolutePath('/notes', '/other/a.png')).toBe('/other/a.png');
    expect(toAbsolutePath('/notes', 'D:\\media\\a.png')).toBe('D:/media/a.png');
  });

  test('no absolute base (unsaved doc) yields a normalized relative path', () => {
    expect(toAbsolutePath('', './pics/a.png')).toBe('pics/a.png');
  });
});
