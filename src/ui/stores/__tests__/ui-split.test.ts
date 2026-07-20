import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Work-area split behavior (ui.ts): splitTab pinning rules and the tabs-store
 * subscription that swaps/clears the split as tabs are activated and closed.
 * Both stores are module singletons wired together at import time, so the
 * module registry is reset before each test (same pattern as tabs.test.ts).
 */
type TabsModule = typeof import('../tabs');
type UiModule = typeof import('../ui');
let tabsMod: TabsModule;
let uiMod: UiModule;

beforeEach(async () => {
  vi.resetModules();
  tabsMod = await import('../tabs');
  uiMod = await import('../ui');
});

function tabs() {
  return tabsMod.tabsStore.getState();
}
function split() {
  return uiMod.uiStore.getState().workSplit;
}
function tabIdAt(i: number): string {
  const tab = tabs().tabs[i];
  if (!tab) {
    throw new Error(`no tab at index ${i}`);
  }
  return tab.id;
}

describe('splitTab', () => {
  test('pins a non-active tab into the secondary pane, active tab unchanged', () => {
    tabs().newTab(); // [t0, t1], t1 active
    uiMod.splitTab(tabIdAt(0), 'right');
    expect(split()).toEqual({ tabId: tabIdAt(0), orientation: 'right' });
    expect(tabs().activeTabId).toBe(tabIdAt(1));
  });

  test('splitting the ACTIVE tab hands the primary pane to a neighbor first', () => {
    tabs().newTab(); // t1 active
    uiMod.splitTab(tabIdAt(1), 'down');
    expect(split()).toEqual({ tabId: tabIdAt(1), orientation: 'down' });
    expect(tabs().activeTabId).toBe(tabIdAt(0));
  });

  test('no-ops with a single tab (nothing to pair with)', () => {
    uiMod.splitTab(tabIdAt(0), 'right');
    expect(split()).toBeNull();
  });
});

describe('split coherence subscription', () => {
  test('activating the pinned tab swaps the panes', () => {
    tabs().newTab(); // t1 active
    uiMod.splitTab(tabIdAt(0), 'right'); // t0 pinned, t1 primary
    tabs().activateTab(tabIdAt(0));
    // Selection honored in primary; the previously active tab is now pinned.
    expect(tabs().activeTabId).toBe(tabIdAt(0));
    expect(split()).toEqual({ tabId: tabIdAt(1), orientation: 'right' });
  });

  test('closing the pinned tab clears the split', () => {
    tabs().newTab();
    uiMod.splitTab(tabIdAt(0), 'down');
    tabs().closeTab(tabIdAt(0));
    expect(split()).toBeNull();
  });

  test('closing the active tab collapses onto the pinned tab and clears', () => {
    tabs().newTab(); // [t0, t1], t1 active
    uiMod.splitTab(tabIdAt(0), 'right'); // t0 pinned
    tabs().closeTab(tabIdAt(1)); // active gone → its neighbor (t0) activates
    expect(tabs().activeTabId).toBe(tabIdAt(0));
    expect(split()).toBeNull();
  });

  test('an unrelated tab switch leaves the split alone', () => {
    tabs().newTab();
    tabs().newTab(); // [t0, t1, t2], t2 active
    uiMod.splitTab(tabIdAt(0), 'right');
    tabs().activateTab(tabIdAt(1));
    expect(split()).toEqual({ tabId: tabIdAt(0), orientation: 'right' });
  });
});
