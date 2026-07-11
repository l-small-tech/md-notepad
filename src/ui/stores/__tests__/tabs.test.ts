import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The tabs store is a module singleton that self-creates its first tab at
 * import time. We reset the module registry before each test so every case
 * starts from a pristine one-tab store.
 */
type TabsModule = typeof import('../tabs');
let mod: TabsModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../tabs');
});

function state() {
  return mod.tabsStore.getState();
}
/** Indexed access under noUncheckedIndexedAccess; tests know the tab exists. */
function tabAt(i: number) {
  const tab = state().tabs[i];
  if (!tab) {
    throw new Error(`no tab at index ${i}`);
  }
  return tab;
}

describe('initial state', () => {
  test('opens exactly one Untitled note tab, active', () => {
    const s = state();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(tabAt(0).id);
    expect(tabAt(0).title).toBe('Untitled');
    expect(tabAt(0).kind).toBe('note');
    expect(tabAt(0).wordCount).toBe(0);
    expect(s.renamingTabId).toBeNull();
  });
});

describe('newTab', () => {
  test('appends a tab and makes it active', () => {
    state().newTab();
    expect(state().tabs).toHaveLength(2);
    expect(state().activeTabId).toBe(tabAt(1).id);
  });
});

describe('live title + word count', () => {
  test('title follows the first line until a custom title is set', () => {
    tabAt(0).model.pushText('# Grocery list\nmilk', 'cm6');
    expect(tabAt(0).title).toBe('Grocery list');
    // Whitespace-delimited tokens, markdown syntax included: #, Grocery, list, milk
    expect(tabAt(0).wordCount).toBe(4);
  });

  test('deleting the content reverts the title to Untitled', () => {
    const model = tabAt(0).model;
    model.pushText('# Hello', 'cm6');
    expect(tabAt(0).title).toBe('Hello');
    model.pushText('', 'cm6');
    expect(tabAt(0).title).toBe('Untitled');
    expect(tabAt(0).wordCount).toBe(0);
  });
});

describe('rename override', () => {
  test('a custom title sticks and stops following the first line', () => {
    const id = tabAt(0).id;
    const model = tabAt(0).model;
    state().renameTab(id, 'My Ideas');
    expect(tabAt(0).customTitle).toBe('My Ideas');
    expect(tabAt(0).title).toBe('My Ideas');
    model.pushText('# A different heading', 'cm6');
    expect(tabAt(0).title).toBe('My Ideas');
  });

  test('renaming to blank reverts to the auto-derived title', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Derived name', 'cm6');
    state().renameTab(id, 'Custom');
    expect(tabAt(0).title).toBe('Custom');
    state().renameTab(id, '   ');
    expect(tabAt(0).customTitle).toBeNull();
    expect(tabAt(0).title).toBe('Derived name');
  });

  test('beginRename/cancelRename toggle the editing marker', () => {
    const id = tabAt(0).id;
    state().beginRename(id);
    expect(state().renamingTabId).toBe(id);
    state().cancelRename();
    expect(state().renamingTabId).toBeNull();
  });
});

describe('tabDisplayTitle', () => {
  test('a fresh empty note reads "Untitled"', () => {
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('Untitled');
  });

  test('a note shows the slug of its title (matches its note filename)', () => {
    tabAt(0).model.pushText('# My Report', 'cm6');
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('my-report');
  });

  test('a renamed note shows the slug of the custom title', () => {
    tabAt(0).model.pushText('content', 'cm6');
    state().renameTab(tabAt(0).id, 'Budget Q3');
    expect(mod.tabDisplayTitle(tabAt(0))).toBe('budget-q3');
  });

  test('a file tab shows its filename minus extension, casing preserved', () => {
    const id = state().openFileTab({
      filePath: '/notes/Budget Q3.md',
      text: 'hi',
      savedMtimeMs: 1,
    });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(mod.tabDisplayTitle(tab)).toBe('Budget Q3');
  });
});

describe('retargetFilePath', () => {
  test('repoints a file tab and its mtime baseline, leaving content untouched', () => {
    const id = state().openFileTab({ filePath: '/notes/old.md', text: 'body', savedMtimeMs: 1 });
    state().retargetFilePath(id, { filePath: '/notes/new.md', mtimeMs: 42 });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.filePath).toBe('/notes/new.md');
    expect(tab.savedMtimeMs).toBe(42);
    expect(tab.model.getText()).toBe('body');
    expect(mod.tabDisplayTitle(tab)).toBe('new');
  });
});

describe('closeTab bookkeeping', () => {
  test('closing the active tab activates the right neighbor', () => {
    state().newTab();
    state().newTab(); // three tabs: [0,1,2], active = 2
    const middle = tabAt(1);
    state().activateTab(middle.id);
    state().closeTab(middle.id);
    expect(state().tabs).toHaveLength(2);
    // right neighbor (old index 2) becomes active
    expect(state().activeTabId).toBe(tabAt(1).id);
  });

  test('closing a non-active tab leaves the active tab unchanged', () => {
    state().newTab(); // [0,1], active = 1
    const first = tabAt(0).id;
    const active = state().activeTabId;
    state().closeTab(first);
    expect(state().activeTabId).toBe(active);
    expect(state().tabs).toHaveLength(1);
  });

  test('closing the last tab leaves one fresh Untitled tab', () => {
    const originalId = tabAt(0).id;
    tabAt(0).model.pushText('# had content', 'cm6');
    state().closeTab(originalId);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).id).not.toBe(originalId);
    expect(tabAt(0).title).toBe('Untitled');
    expect(state().activeTabId).toBe(tabAt(0).id);
  });
});

describe('activateAdjacent', () => {
  test('cycles forward and wraps around', () => {
    state().newTab();
    state().newTab(); // [0,1,2], active = 2
    state().activateAdjacent(1); // wraps to 0
    expect(state().activeTabId).toBe(tabAt(0).id);
    state().activateAdjacent(-1); // back to 2
    expect(state().activeTabId).toBe(tabAt(2).id);
  });
});

describe('reorderTab', () => {
  test('moves a tab to a new index, preserving identity', () => {
    state().newTab();
    state().newTab(); // [0,1,2]
    const ids = state().tabs.map((t) => t.id);
    state().reorderTab(ids[0]!, 2); // move first to the end
    expect(state().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
  });
});

describe('setMode', () => {
  test('updates the tab mode without a registered modeSync', () => {
    const id = tabAt(0).id;
    expect(() => state().setMode(id, 'split')).not.toThrow();
    expect(tabAt(0).mode).toBe('split');
  });

  test('registerModeSync stores the sync and setMode drives it', () => {
    const id = tabAt(0).id;
    const calls: string[] = [];
    const fakeSync = {
      getMode: () => 'raw' as const,
      setMode: (m: string) => {
        calls.push(m);
        return Promise.resolve();
      },
      whenIdle: () => Promise.resolve(),
      focus: () => {},
      dispose: () => Promise.resolve(),
    };
    state().registerModeSync(id, fakeSync);
    state().setMode(id, 'wysiwyg');
    expect(calls).toEqual(['wysiwyg']);
  });
});

describe('openFileTab (M3)', () => {
  test('appends a clean file tab and makes it active', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: '# Hi', savedMtimeMs: 5 });
    expect(state().tabs).toHaveLength(2);
    expect(state().activeTabId).toBe(id);
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/docs/hi.md');
    expect(tab.savedMtimeMs).toBe(5);
    expect(tab.title).toBe('Hi');
    expect(tab.dirty).toBe(false);
    expect(tab.model.isDirty('file')).toBe(false);
  });
});

describe('dirty dot (M3)', () => {
  test('a file tab goes dirty on edit; note tabs never do', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: 'hi', savedMtimeMs: 1 });
    const fileTab = () => state().tabs.find((t) => t.id === id)!;
    expect(fileTab().dirty).toBe(false);
    fileTab().model.pushText('hi there', 'cm6');
    expect(fileTab().dirty).toBe(true);

    // The original note tab is unaffected by the 'file' persistence kind.
    tabAt(0).model.pushText('note text', 'cm6');
    expect(tabAt(0).dirty).toBe(false);
  });
});

describe('markSaved (M3)', () => {
  test('clears the dirty dot, updates the mtime baseline, and queues buffer cleanup', () => {
    const id = state().openFileTab({ filePath: '/docs/hi.md', text: 'hi', savedMtimeMs: 1 });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('hi edited', 'cm6');
    expect(state().tabs.find((t) => t.id === id)!.dirty).toBe(true);

    state().markSaved(id, 42);

    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.dirty).toBe(false);
    expect(tab.conflict).toBe(false);
    expect(tab.savedMtimeMs).toBe(42);
    expect(tab.model.isDirty('file')).toBe(false);
    expect(tab.model.isDirty('session')).toBe(false);
    expect(state().obsoleteBufferTabIds).toContain(id);
  });
});

describe('saveToPath (M3)', () => {
  test('Save As on a note tab converts it to a file tab and queues the old note for deletion', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Grocery list', 'cm6');
    // Simulate a prior flush having assigned a note path.
    tabAt(0).model.markPersisted('session');
    state().applyFlushResult({
      assignedNotePaths: { [id]: '/notes/grocery-list.md' },
      renamedPaths: {},
      consumedClosedNotePaths: [],
      consumedObsoleteBufferTabIds: [],
    });
    expect(tabAt(0).notePath).toBe('/notes/grocery-list.md');

    state().saveToPath(id, { filePath: '/docs/grocery-list.md', mtimeMs: 9 });

    const tab = tabAt(0);
    expect(tab.kind).toBe('file');
    expect(tab.filePath).toBe('/docs/grocery-list.md');
    expect(tab.notePath).toBeNull();
    expect(tab.savedMtimeMs).toBe(9);
    expect(tab.dirty).toBe(false);
    expect(state().closedNotePaths).toContain('/notes/grocery-list.md');
  });

  test('Save As on an existing file tab just retargets the path', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    state().saveToPath(id, { filePath: '/docs/b.md', mtimeMs: 2 });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.filePath).toBe('/docs/b.md');
    expect(tab.savedMtimeMs).toBe(2);
    expect(state().closedNotePaths).toEqual([]);
  });
});

describe('preview tabs', () => {
  test('opens an italic preview tab, active', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    const tab = state().tabs.find((t) => t.id === id)!;
    expect(tab.preview).toBe(true);
    expect(state().activeTabId).toBe(id);
  });

  test('previewing another file REPLACES the preview tab in place', () => {
    const first = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    const before = state().tabs.length;
    const second = state().openFileTab({
      filePath: '/docs/b.md',
      text: 'b',
      savedMtimeMs: 1,
      preview: true,
    });
    // Same tab count (reused slot); the first preview tab is gone.
    expect(state().tabs).toHaveLength(before);
    expect(state().tabs.some((t) => t.id === first)).toBe(false);
    const tab = state().tabs.find((t) => t.id === second)!;
    expect(tab.filePath).toBe('/docs/b.md');
    expect(tab.preview).toBe(true);
    // The displaced clean file tab's (nonexistent) buffer is queued for cleanup.
    expect(state().obsoleteBufferTabIds).toContain(first);
  });

  test('a permanent (non-preview) open leaves an existing preview tab untouched', () => {
    const preview = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state().openFileTab({ filePath: '/docs/b.md', text: 'b', savedMtimeMs: 1 });
    // Both exist; the preview tab is still there and still preview.
    expect(state().tabs.some((t) => t.id === preview && t.preview)).toBe(true);
  });

  test('a user edit promotes a preview tab to permanent', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('a edited', 'cm6');
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
  });

  test('a programmatic push (file reload) does NOT promote a preview tab', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state()
      .tabs.find((t) => t.id === id)!
      .model.pushText('reloaded', 'file-load');
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(true);
  });

  test('promoteTab pins a preview tab and is a no-op afterwards', () => {
    const id = state().openFileTab({
      filePath: '/docs/a.md',
      text: 'a',
      savedMtimeMs: 1,
      preview: true,
    });
    state().promoteTab(id);
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
    // Idempotent.
    expect(() => state().promoteTab(id)).not.toThrow();
    expect(state().tabs.find((t) => t.id === id)!.preview).toBe(false);
  });
});

describe('detachTab / adoptTabs (M8 multi-window)', () => {
  test('detachTab removes the tab WITHOUT close-tab tombstones', () => {
    const id = tabAt(0).id;
    tabAt(0).model.pushText('# Torn off', 'cm6');
    state().applyFlushResult({
      assignedNotePaths: { [id]: '/notes/torn-off.md' },
      renamedPaths: {},
      consumedClosedNotePaths: [],
      consumedObsoleteBufferTabIds: [],
    });
    state().newTab();

    state().detachTab(id);

    expect(state().tabs.some((t) => t.id === id)).toBe(false);
    // Nothing queued for deletion — another window is adopting the files.
    expect(state().closedNotePaths).toEqual([]);
    expect(state().obsoleteBufferTabIds).toEqual([]);
  });

  test('detaching a file tab leaves its session buffer unqueued (closeTab queues it)', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    state().detachTab(id);
    expect(state().obsoleteBufferTabIds).toEqual([]);
  });

  test('detaching the last tab leaves one fresh Untitled', () => {
    state().detachTab(tabAt(0).id);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).title).toBe('Untitled');
    expect(state().activeTabId).toBe(tabAt(0).id);
  });

  test('detaching the active tab activates a neighbor', () => {
    const first = tabAt(0).id;
    state().newTab();
    state().activateTab(first);
    state().detachTab(first);
    expect(state().tabs).toHaveLength(1);
    expect(state().activeTabId).toBe(tabAt(0).id);
  });

  test('adoptTabs appends with ids preserved and activates the last adopted tab', () => {
    tabAt(0).model.pushText('existing content', 'cm6');
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
      {
        id: 'adopted-2',
        kind: 'file',
        notePath: null,
        filePath: '/docs/two.md',
        customTitle: null,
        mode: 'split',
        savedMtimeMs: 3,
        text: 'two',
      },
    ]);
    expect(state().tabs.map((t) => t.id)).toContain('adopted-1');
    expect(state().tabs).toHaveLength(3);
    expect(state().activeTabId).toBe('adopted-2');
    const file = state().tabs.find((t) => t.id === 'adopted-2')!;
    expect(file.kind).toBe('file');
    expect(file.mode).toBe('split');
  });

  test('adopting into a pristine window replaces the placeholder Untitled', () => {
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
    ]);
    expect(state().tabs).toHaveLength(1);
    expect(tabAt(0).id).toBe('adopted-1');
  });

  test('a non-pristine Untitled survives adoption', () => {
    tabAt(0).model.pushText('draft', 'cm6');
    state().adoptTabs([
      {
        id: 'adopted-1',
        kind: 'note',
        notePath: '/notes/one.md',
        filePath: null,
        customTitle: null,
        mode: 'raw',
        savedMtimeMs: null,
        text: '# One',
      },
    ]);
    expect(state().tabs).toHaveLength(2);
  });
});

describe('conflict flags (M3)', () => {
  test('setConflict toggles the per-tab ConflictBanner flag', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(false);
    state().setConflict(id, true);
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(true);
    state().setConflict(id, false);
    expect(state().tabs.find((t) => t.id === id)!.conflict).toBe(false);
  });

  test('acknowledgeConflict ("keep mine") clears the banner without touching dirty/model', () => {
    const id = state().openFileTab({ filePath: '/docs/a.md', text: 'a', savedMtimeMs: 1 });
    const tab = state().tabs.find((t) => t.id === id)!;
    tab.model.pushText('a edited', 'cm6');
    state().setConflict(id, true);

    state().acknowledgeConflict(id, 77);

    const after = state().tabs.find((t) => t.id === id)!;
    expect(after.conflict).toBe(false);
    expect(after.savedMtimeMs).toBe(77);
    // Local edits remain unsaved — "keep mine" defers to the next explicit save.
    expect(after.dirty).toBe(true);
    expect(after.model.isDirty('file')).toBe(true);
  });
});
