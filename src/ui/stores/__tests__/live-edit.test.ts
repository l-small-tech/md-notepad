import { beforeEach, describe, expect, test } from 'vitest';
import { liveEditStore } from '../live-edit';

beforeEach(() => {
  liveEditStore.setState({ byTab: {} });
});

describe('liveEditStore', () => {
  test('recordMerge counts merges per tab and keeps the latest time + overlap flag', () => {
    liveEditStore.getState().recordMerge('t1', 100, false);
    liveEditStore.getState().recordMerge('t1', 200, true);
    liveEditStore.getState().recordMerge('t2', 300, false);
    expect(liveEditStore.getState().byTab).toEqual({
      t1: { lastMergeAt: 200, merges: 2, overlapped: true },
      t2: { lastMergeAt: 300, merges: 1, overlapped: false },
    });
  });

  test('forget drops one tab; forgetting an unknown tab keeps the reference', () => {
    liveEditStore.getState().recordMerge('t1', 100, false);
    liveEditStore.getState().recordMerge('t2', 100, false);
    liveEditStore.getState().forget('t1');
    expect(Object.keys(liveEditStore.getState().byTab)).toEqual(['t2']);
    const before = liveEditStore.getState().byTab;
    liveEditStore.getState().forget('nope');
    expect(liveEditStore.getState().byTab).toBe(before);
  });
});
