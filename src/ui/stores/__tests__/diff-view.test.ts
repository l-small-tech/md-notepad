import { beforeEach, describe, expect, test } from 'vitest';
import { diffViewStore } from '../diff-view';

beforeEach(() => {
  diffViewStore.setState({ byTab: {} });
});

describe('diffViewStore', () => {
  test('open stores the disk snapshot per tab', () => {
    diffViewStore.getState().open('t1', 'disk text');
    diffViewStore.getState().open('t2', 'other');
    expect(diffViewStore.getState().byTab['t1']).toEqual({ diskText: 'disk text' });
    expect(diffViewStore.getState().byTab['t2']).toEqual({ diskText: 'other' });
  });

  test('re-opening replaces the snapshot', () => {
    diffViewStore.getState().open('t1', 'v1');
    diffViewStore.getState().open('t1', 'v2');
    expect(diffViewStore.getState().byTab['t1']).toEqual({ diskText: 'v2' });
  });

  test('close removes only that tab; closing an absent tab is a no-op', () => {
    diffViewStore.getState().open('t1', 'a');
    diffViewStore.getState().open('t2', 'b');
    diffViewStore.getState().close('t1');
    expect(diffViewStore.getState().byTab).toEqual({ t2: { diskText: 'b' } });
    const before = diffViewStore.getState().byTab;
    diffViewStore.getState().close('missing');
    expect(diffViewStore.getState().byTab).toBe(before); // unchanged reference
  });
});
