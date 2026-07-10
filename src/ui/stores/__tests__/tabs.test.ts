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
