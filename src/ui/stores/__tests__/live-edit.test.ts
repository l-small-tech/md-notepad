import { beforeEach, describe, expect, test } from 'vitest';
import { liveEditStore } from '../live-edit';

beforeEach(() => {
  liveEditStore.setState({ byTab: {}, lost: {} });
});

describe('liveEditStore', () => {
  test('recordMerge counts merges per tab and keeps the latest time', () => {
    liveEditStore.getState().recordMerge('t1', 100);
    liveEditStore.getState().recordMerge('t1', 200);
    liveEditStore.getState().recordMerge('t2', 300);
    expect(liveEditStore.getState().byTab).toEqual({
      t1: { lastMergeAt: 200, merges: 2 },
      t2: { lastMergeAt: 300, merges: 1 },
    });
  });

  test('setLost stores overwritten blocks; an empty list clears them', () => {
    const blocks = [{ lines: ['mine'], afterOffset: 10 }];
    liveEditStore.getState().setLost('t1', blocks);
    expect(liveEditStore.getState().lost).toEqual({ t1: blocks });
    liveEditStore.getState().setLost('t1', []);
    expect(liveEditStore.getState().lost).toEqual({});
    const before = liveEditStore.getState().lost;
    liveEditStore.getState().setLost('never', []);
    expect(liveEditStore.getState().lost).toBe(before); // no-op keeps the reference
  });

  test('forget drops one tab from both maps; forgetting an unknown tab keeps the references', () => {
    liveEditStore.getState().recordMerge('t1', 100);
    liveEditStore.getState().setLost('t1', [{ lines: ['x'], afterOffset: 0 }]);
    liveEditStore.getState().recordMerge('t2', 100);
    liveEditStore.getState().forget('t1');
    expect(Object.keys(liveEditStore.getState().byTab)).toEqual(['t2']);
    expect(liveEditStore.getState().lost).toEqual({});
    const before = liveEditStore.getState().byTab;
    liveEditStore.getState().forget('nope');
    expect(liveEditStore.getState().byTab).toBe(before);
  });
});
