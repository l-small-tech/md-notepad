import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** A fake file tree: directories → their entries; files → their text. */
const fs = vi.hoisted(() => ({
  dirs: new Map<string, { path: string; isDir: boolean }[]>(),
  files: new Map<string, string>(),
  listed: [] as string[],
}));
const session = vi.hoisted(() => ({
  defaultPath: 'C:/ws' as string | null,
  opened: [] as string[],
}));
const settings = vi.hoisted(() => ({ workspaces: [] as { path: string }[] }));
const tabs = vi.hoisted(() => ({
  tabs: [] as { id: string; filePath: string | null; notePath: string | null; mode: string }[],
  activeTabId: null as string | null,
  modes: [] as [string, string][],
  listeners: new Set<() => void>(),
}));
const voice = vi.hoisted(() => ({
  armed: false,
  reveals: [] as unknown[],
  mutations: [] as string[],
  listener: null as
    null | ((notePath: string, sidecar: string, notes: readonly { id: string }[]) => void),
}));

vi.mock('../../ipc/provider', () => ({
  currentProvider: () => ({
    listDir: (dir: string) => {
      fs.listed.push(dir);
      const entries = fs.dirs.get(dir);
      return entries ? Promise.resolve(entries) : Promise.reject(new Error('ENOENT'));
    },
    readTextFile: (path: string) => {
      const text = fs.files.get(path);
      return text === undefined
        ? Promise.reject(new Error('NOT_FOUND'))
        : Promise.resolve({ text, mtimeMs: 0 });
    },
  }),
}));
vi.mock('../session', () => ({
  getDefaultWorkspacePath: () => session.defaultPath,
  openNotePath: (path: string) => session.opened.push(path),
}));
vi.mock('../stores/settings', () => ({
  settingsStore: { getState: () => ({ settings }) },
}));
vi.mock('../stores/tabs', () => ({
  tabsStore: {
    getState: () => ({
      tabs: tabs.tabs,
      activeTabId: tabs.activeTabId,
      setMode: (id: string, mode: string) => {
        tabs.modes.push([id, mode]);
        const tab = tabs.tabs.find((t) => t.id === id);
        if (tab) tab.mode = mode;
      },
    }),
    subscribe: (fn: () => void) => {
      tabs.listeners.add(fn);
      return () => tabs.listeners.delete(fn);
    },
  },
}));
vi.mock('../voice-comments', () => ({
  voiceStore: {
    getState: () => ({ armed: voice.armed }),
    setState: (patch: { armed?: boolean }) => {
      if (patch.armed !== undefined) voice.armed = patch.armed;
    },
  },
  sidecarFor: (notePath: string) => notePath.replace(/\.md$/, '.comments.md'),
  requestReveal: (path: string, line: number, unit: string | null) =>
    voice.reveals.push({ path, line, unit }),
  onNotesChanged: (fn: typeof voice.listener) => {
    voice.listener = fn;
    return () => {};
  },
  mutateNotes: (_notePath: string, sidecar: string, change: (n: never[]) => unknown) => {
    voice.mutations.push(`${sidecar}:${JSON.stringify(change([]))}`);
    return Promise.resolve([]);
  },
}));

import { serializeCommentsFile } from '../../core/comments';
import {
  activeDocPath,
  closeOverview,
  deleteOverviewNote,
  goToNote,
  notesOverviewStore,
  openOverview,
  refreshOverview,
  workspaceRoots,
} from '../notes-overview';

const note = (id: string, file: string, line = 1) => ({
  id,
  file,
  line,
  quote: '',
  time: '2026-09-11T10:00:00.000Z',
  transcript: `text ${id}`,
});

function dir(path: string, entries: { path: string; isDir: boolean }[]): void {
  fs.dirs.set(path, entries);
}

const state = () => notesOverviewStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  fs.dirs.clear();
  fs.files.clear();
  fs.listed.length = 0;
  session.defaultPath = 'C:/ws';
  session.opened.length = 0;
  settings.workspaces = [];
  tabs.tabs = [];
  tabs.activeTabId = null;
  tabs.modes.length = 0;
  tabs.listeners.clear();
  voice.armed = false;
  voice.reveals.length = 0;
  voice.mutations.length = 0;
  notesOverviewStore.setState({
    open: false,
    loading: false,
    loaded: false,
    docs: [],
    truncated: false,
    query: '',
    view: 'newest',
    scope: 'all',
  });

  // C:/ws: a shared Voice Notes folder, a doc with a beside-file sidecar, a
  // node_modules to skip, a dotdir to skip, and an empty sidecar to ignore.
  dir('C:/ws', [
    { path: 'C:/ws/Voice Notes', isDir: true },
    { path: 'C:/ws/docs', isDir: true },
    { path: 'C:/ws/node_modules', isDir: true },
    { path: 'C:/ws/.git', isDir: true },
    { path: 'C:/ws/readme.md', isDir: false },
    { path: 'C:/ws/empty.comments.md', isDir: false },
  ]);
  dir('C:/ws/Voice Notes', [{ path: 'C:/ws/Voice Notes/plan.comments.md', isDir: false }]);
  dir('C:/ws/docs', [
    { path: 'C:/ws/docs/beside.md', isDir: false },
    { path: 'C:/ws/docs/beside.comments.md', isDir: false },
  ]);
  dir('C:/ws/node_modules', [{ path: 'C:/ws/node_modules/x.comments.md', isDir: false }]);
  fs.files.set(
    'C:/ws/Voice Notes/plan.comments.md',
    serializeCommentsFile([note('c1', '../plan.md', 4), note('c2', '../plan.md', 9)], '../plan.md'),
  );
  fs.files.set(
    'C:/ws/docs/beside.comments.md',
    serializeCommentsFile([note('c3', 'beside.md')], 'beside.md'),
  );
  fs.files.set('C:/ws/empty.comments.md', serializeCommentsFile([], 'empty.md'));
  fs.files.set(
    'C:/ws/node_modules/x.comments.md',
    serializeCommentsFile([note('c9', 'x.md')], 'x.md'),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the walk', () => {
  test('finds every sidecar under the workspace roots, resolving each to its document', async () => {
    settings.workspaces = [{ path: 'C:/ws' }, { path: 'D:/other' }]; // a duplicate and a missing root
    expect(workspaceRoots()).toEqual(['C:/ws', 'D:/other']);
    await refreshOverview();
    expect(state().loaded).toBe(true);
    expect(state().loading).toBe(false);
    expect(state().truncated).toBe(false);
    expect(state().docs.map((d) => [d.notePath, d.notes.map((n) => n.id)])).toEqual([
      ['C:/ws/plan.md', ['c1', 'c2']],
      ['C:/ws/docs/beside.md', ['c3']],
    ]);
    // node_modules and dot-directories were never listed; the missing root was skipped.
    expect(fs.listed).not.toContain('C:/ws/node_modules');
    expect(fs.listed).not.toContain('C:/ws/.git');
  });

  test("an open tab's document outside every workspace is read too", async () => {
    tabs.tabs = [
      { id: 't1', filePath: 'E:/loose/notes.md', notePath: null, mode: 'raw' },
      { id: 't2', filePath: 'C:/ws/plan.md', notePath: null, mode: 'raw' }, // already found
      { id: 't3', filePath: null, notePath: null, mode: 'raw' },
    ];
    fs.files.set(
      'E:/loose/notes.comments.md',
      serializeCommentsFile([note('c7', 'notes.md')], 'notes.md'),
    );
    await refreshOverview();
    expect(state().docs.map((d) => d.notePath)).toEqual([
      'C:/ws/plan.md',
      'C:/ws/docs/beside.md',
      'E:/loose/notes.md',
    ]);
  });

  test('opening walks once; a later open walks again; a superseded walk is dropped', async () => {
    openOverview('current');
    expect(state().open).toBe(true);
    expect(state().scope).toBe('current');
    expect(state().loading).toBe(true);
    await vi.runAllTimersAsync();
    expect(state().docs).toHaveLength(2);
    const before = fs.listed.length;
    openOverview(); // already open: no second walk, scope untouched
    expect(fs.listed).toHaveLength(before);
    expect(state().scope).toBe('current');

    closeOverview();
    fs.files.delete('C:/ws/docs/beside.comments.md');
    const stale = refreshOverview();
    const fresh = refreshOverview();
    await Promise.all([stale, fresh]);
    expect(state().docs).toHaveLength(1);
  });
});

describe('acting on a note', () => {
  test('Go to closes the panel, arms review notes, asks for the reveal and opens the document in Review', () => {
    notesOverviewStore.setState({ open: true });
    const doc = {
      sidecar: 'C:/ws/Voice Notes/plan.comments.md',
      notePath: 'C:/ws/plan.md',
      notes: [],
    };
    goToNote(doc, { line: 9, unit: 'f (function)' });
    expect(state().open).toBe(false);
    expect(voice.armed).toBe(true);
    expect(voice.reveals).toEqual([{ path: 'C:/ws/plan.md', line: 9, unit: 'f (function)' }]);
    expect(session.opened).toEqual(['C:/ws/plan.md']);
    // The tab appears later (the open is async): the mode switch waits for it.
    expect(tabs.modes).toEqual([]);
    tabs.tabs.push({ id: 't1', filePath: 'c:\\ws\\plan.md', notePath: null, mode: 'raw' });
    for (const fn of tabs.listeners) fn();
    expect(tabs.modes).toEqual([['t1', 'read']]);
    // Already in Review: nothing to switch.
    goToNote(doc, { line: null });
    expect(tabs.modes).toHaveLength(1);
    expect(voice.reveals[1]).toMatchObject({ line: 1, unit: null });
  });

  test('a delete goes through the shared sidecar write; the change listener updates the list', async () => {
    await refreshOverview();
    const plan = state().docs[0]!;
    await deleteOverviewNote(plan, 'c1');
    expect(voice.mutations).toEqual(['C:/ws/Voice Notes/plan.comments.md:[]']);
    // The write's listener (as voice-comments would call it) replaces that document's notes…
    voice.listener!('C:/ws/plan.md', 'C:/ws/Voice Notes/plan.comments.md', [{ id: 'c2' }]);
    expect(
      state()
        .docs.find((d) => d.notePath === 'C:/ws/plan.md')
        ?.notes.map((n) => n.id),
    ).toEqual(['c2']);
    // …and drops the document once it has none.
    voice.listener!('C:/ws/plan.md', 'C:/ws/Voice Notes/plan.comments.md', []);
    expect(state().docs.map((d) => d.notePath)).toEqual(['C:/ws/docs/beside.md']);
  });

  test('the active document is what "This document" means', () => {
    expect(activeDocPath()).toBeNull();
    tabs.tabs = [{ id: 't1', filePath: null, notePath: 'C:/ws/plan.md', mode: 'read' }];
    tabs.activeTabId = 't1';
    expect(activeDocPath()).toBe('C:/ws/plan.md');
  });
});
