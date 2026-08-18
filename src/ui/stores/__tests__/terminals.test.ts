import { beforeEach, describe, expect, test } from 'vitest';
import { paneIds } from '../../../core/panes';
import { activePaneOf, resetTerminalIds, terminalsStore } from '../terminals';

function reset(): void {
  resetTerminalIds();
  terminalsStore.setState({ sessions: {}, panes: {} });
}

/** Clear the store WITHOUT rewinding the id counter — ids are never reused. */
function clearState(): void {
  terminalsStore.setState({ sessions: {}, panes: {} });
}

const store = () => terminalsStore.getState();

beforeEach(reset);

describe('sessions', () => {
  test('opening a tab creates exactly one focused pane', () => {
    store().openSession('t1', { profileId: 'shell', cwd: '/work' });

    const session = store().sessions.t1!;
    expect(paneIds(session.tree)).toHaveLength(1);
    expect(session.activePaneId).toBe(paneIds(session.tree)[0]);
    expect(activePaneOf('t1')).toMatchObject({ tabId: 't1', profileId: 'shell', cwd: '/work' });
  });

  test('opening the same tab twice is a no-op (no second pty)', () => {
    store().openSession('t1', { profileId: 'shell' });
    const first = store().sessions.t1!.activePaneId;
    store().openSession('t1', { profileId: 'claude' });
    expect(store().sessions.t1!.activePaneId).toBe(first);
  });

  test('closing a session drops the tab and every pane it owned', () => {
    store().openSession('t1', { profileId: 'shell' });
    store().openSession('t2', { profileId: 'shell' });
    store().splitActivePane('t1', 'row');

    store().closeSession('t1');

    expect(store().sessions.t1).toBeUndefined();
    expect(Object.values(store().panes).every((p) => p.tabId === 't2')).toBe(true);
  });
});

describe('splits', () => {
  test('a split inherits the profile and cwd of the pane it grew from', () => {
    store().openSession('t1', { profileId: 'claude', cwd: '/proj' });
    store().splitActivePane('t1', 'row');

    const session = store().sessions.t1!;
    expect(paneIds(session.tree)).toHaveLength(2);
    // Focus moves to the new pane — that is where the user is about to type.
    const created = store().panes[session.activePaneId]!;
    expect(created).toMatchObject({ profileId: 'claude', cwd: '/proj' });
  });

  test('closing a pane keeps the tab and refocuses a survivor', () => {
    store().openSession('t1', { profileId: 'shell' });
    const first = store().sessions.t1!.activePaneId;
    store().splitActivePane('t1', 'column');
    const second = store().sessions.t1!.activePaneId;

    expect(store().closePane(second)).toBe(false);
    expect(store().panes[second]).toBeUndefined();
    expect(store().sessions.t1!.activePaneId).toBe(first);
  });

  test('closing the LAST pane reports that the tab is finished', () => {
    store().openSession('t1', { profileId: 'shell' });
    // The caller (the tab component / mod+Shift+X) closes the tab, which is
    // what then calls closeSession — this only reports it.
    expect(store().closePane(store().sessions.t1!.activePaneId)).toBe(true);
  });

  test('cycling wraps around the panes of one tab', () => {
    store().openSession('t1', { profileId: 'shell' });
    const a = store().sessions.t1!.activePaneId;
    store().splitActivePane('t1', 'row');
    const b = store().sessions.t1!.activePaneId;

    store().cyclePane('t1', 1);
    expect(store().sessions.t1!.activePaneId).toBe(a);
    store().cyclePane('t1', -1);
    expect(store().sessions.t1!.activePaneId).toBe(b);
  });

  test('a ratio is clamped so a pane can never be dragged to nothing', () => {
    store().openSession('t1', { profileId: 'shell' });
    store().splitActivePane('t1', 'row');
    const tree = store().sessions.t1!.tree;
    const splitId = tree.kind === 'split' ? tree.id : '';

    store().setRatio('t1', splitId, 0);
    const after = store().sessions.t1!.tree;
    expect(after.kind === 'split' && after.ratio).toBeGreaterThan(0);
  });
});

describe('pane state', () => {
  test('title, cwd and exit are recorded per pane', () => {
    store().openSession('t1', { profileId: 'shell' });
    const id = store().sessions.t1!.activePaneId;

    store().setPaneTitle(id, 'vim README.md');
    store().setPaneCwd(id, '/home/me/proj');
    store().markExited(id, 3);

    expect(store().panes[id]).toMatchObject({
      title: 'vim README.md',
      cwd: '/home/me/proj',
      exited: true,
      exitCode: 3,
    });
  });

  test('a second exit does not overwrite the first code', () => {
    store().openSession('t1', { profileId: 'shell' });
    const id = store().sessions.t1!.activePaneId;
    store().markExited(id, 1);
    store().markExited(id, 0);
    expect(store().panes[id]!.exitCode).toBe(1);
  });
});

describe('snapshot / restore', () => {
  test('a snapshot round-trips the layout with fresh pane ids', () => {
    store().openSession('t1', { profileId: 'claude', cwd: '/a' });
    store().splitActivePane('t1', 'row');
    store().setPaneCwd(store().sessions.t1!.activePaneId, '/b');
    const snapshot = store().snapshot('t1')!;

    clearState();
    store().openSession('t2', { profileId: 'shell', snapshot });

    const restored = store().sessions.t2!;
    expect(paneIds(restored.tree)).toHaveLength(2);
    // Ids are reallocated: two windows restoring the same manifest must not
    // collide in the flat pane map.
    expect(paneIds(restored.tree).some((id) => snapshot.panes.some((p) => p.id === id))).toBe(
      false,
    );
    expect(
      Object.values(store().panes)
        .map((p) => p.cwd)
        .sort(),
    ).toEqual(['/a', '/b']);
    expect(Object.values(store().panes).every((p) => p.profileId === 'claude')).toBe(true);
  });

  test('the focused pane survives a round trip', () => {
    store().openSession('t1', { profileId: 'shell' });
    store().splitActivePane('t1', 'column');
    const snapshot = store().snapshot('t1')!;
    const activeIndex = snapshot.panes.findIndex((p) => p.id === snapshot.activePaneId);

    clearState();
    store().openSession('t2', { profileId: 'shell', snapshot });
    const restored = store().sessions.t2!;
    expect(paneIds(restored.tree)[activeIndex]).toBe(restored.activePaneId);
  });

  test('an unreadable tree degrades to one fresh pane, not to no tab', () => {
    store().openSession('t1', {
      profileId: 'shell',
      snapshot: { tree: { kind: 'nonsense' } as never, activePaneId: 'x', panes: [] },
    });
    expect(paneIds(store().sessions.t1!.tree)).toHaveLength(1);
  });

  test('a tab with no session snapshots as null', () => {
    expect(store().snapshot('nope')).toBeNull();
  });
});
