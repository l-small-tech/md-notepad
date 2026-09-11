import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REVIEW_STATE, XRAY_FULL } from '../../../core/code/review-state';
import { codeReviewStore, reviewStateFor } from '../code-review';

beforeEach(() => {
  codeReviewStore.setState({ tabs: {} });
});

const s = () => codeReviewStore.getState();

describe('codeReviewStore', () => {
  it('answers the default state for a tab it has never seen, without creating it', () => {
    expect(reviewStateFor('t1')).toBe(DEFAULT_REVIEW_STATE);
    expect(s().tabs).toEqual({});
  });

  it('setView / setFilter / setShowAll / setBaseline are per tab', () => {
    s().setView('t1', 'calls');
    s().setFilter('t1', 'exported');
    s().setShowAll('t1', true);
    s().setBaseline('t1', 'branch');
    expect(reviewStateFor('t1')).toMatchObject({
      view: 'calls',
      filter: 'exported',
      showAll: true,
      baseline: 'branch',
    });
    expect(reviewStateFor('t2')).toBe(DEFAULT_REVIEW_STATE);
  });

  it('toggleExpander opens, switches, and closes on a repeat', () => {
    s().toggleExpander('t1', 'function:f', 'code');
    expect(reviewStateFor('t1').expanded).toEqual({ 'function:f': 'code' });
    s().toggleExpander('t1', 'function:f', 'flow');
    expect(reviewStateFor('t1').expanded).toEqual({ 'function:f': 'flow' });
    s().toggleExpander('t1', 'function:f', 'flow');
    expect(reviewStateFor('t1').expanded).toEqual({});
  });

  it('openXray records per-marker opens; setXrayDepth resets them', () => {
    s().openXray('t1', 'function:f', 12, 2);
    s().openXray('t1', 'function:f', 40, 3);
    expect(reviewStateFor('t1').xrayOpened).toEqual({ 'function:f': { 12: 2, 40: 3 } });
    s().setXrayDepth('t1', 'function:f', XRAY_FULL);
    expect(reviewStateFor('t1').xrayDepth['function:f']).toBe(XRAY_FULL);
    expect(reviewStateFor('t1').xrayOpened).toEqual({});
  });

  it('a no-op action does not produce a new state object', () => {
    s().setView('t1', 'calls');
    const before = s().tabs;
    s().setView('t1', 'calls');
    expect(s().tabs).toBe(before);
  });

  it('dispatch takes a raw action', () => {
    s().dispatch('t1', { type: 'filter', filter: 'types' });
    expect(reviewStateFor('t1').filter).toBe('types');
  });

  it('clear forgets a tab and ignores unknown ones', () => {
    s().setView('t1', 'calls');
    const before = s().tabs;
    s().clear('nope');
    expect(s().tabs).toBe(before);
    s().clear('t1');
    expect(s().tabs).toEqual({});
    expect(reviewStateFor('t1')).toBe(DEFAULT_REVIEW_STATE);
  });
});
