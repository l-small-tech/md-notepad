import { describe, expect, test } from 'vitest';
import {
  DEFAULT_REVIEW_STATE,
  reduceReview,
  XRAY_FULL,
  xrayOpenedMap,
  type ReviewState,
} from '../review-state';

const s0: ReviewState = DEFAULT_REVIEW_STATE;

describe('reduceReview', () => {
  test('view, filter, show-all and baseline set their field and no-op when unchanged', () => {
    const s1 = reduceReview(s0, { type: 'view', view: 'calls' });
    expect(s1.view).toBe('calls');
    expect(reduceReview(s1, { type: 'view', view: 'calls' })).toBe(s1);
    const s2 = reduceReview(s1, { type: 'filter', filter: 'types' });
    expect(s2.filter).toBe('types');
    expect(reduceReview(s2, { type: 'filter', filter: 'types' })).toBe(s2);
    const s3 = reduceReview(s2, { type: 'show-all', showAll: true });
    expect(s3.showAll).toBe(true);
    expect(reduceReview(s3, { type: 'show-all', showAll: true })).toBe(s3);
    const s4 = reduceReview(s3, { type: 'baseline', baseline: 'uncommitted' });
    expect(s4.baseline).toBe('uncommitted');
    expect(reduceReview(s4, { type: 'baseline', baseline: 'uncommitted' })).toBe(s4);
    // Untouched fields ride along.
    expect(s4).toMatchObject({ view: 'calls', filter: 'types', showAll: true });
  });

  test('toggle-expander: open, switch, close; other cards untouched', () => {
    const a = reduceReview(s0, { type: 'toggle-expander', unitId: 'f', expander: 'code' });
    expect(a.expanded).toEqual({ f: 'code' });
    const b = reduceReview(a, { type: 'toggle-expander', unitId: 'g', expander: 'doc' });
    expect(b.expanded).toEqual({ f: 'code', g: 'doc' });
    const c = reduceReview(b, { type: 'toggle-expander', unitId: 'f', expander: 'flow' });
    expect(c.expanded).toEqual({ f: 'flow', g: 'doc' });
    const d = reduceReview(c, { type: 'toggle-expander', unitId: 'f', expander: 'flow' });
    expect(d.expanded).toEqual({ g: 'doc' });
    expect(s0.expanded).toEqual({}); // never mutated
  });

  test('open-xray accumulates per marker; xray-depth replaces the base and clears the opens', () => {
    const a = reduceReview(s0, { type: 'open-xray', unitId: 'f', line: 10, depth: 2 });
    const b = reduceReview(a, { type: 'open-xray', unitId: 'f', line: 30, depth: 2 });
    const c = reduceReview(b, { type: 'open-xray', unitId: 'f', line: 10, depth: 3 });
    expect(c.xrayOpened).toEqual({ f: { 10: 3, 30: 2 } });
    expect(xrayOpenedMap(c, 'f')).toEqual(
      new Map([
        [10, 3],
        [30, 2],
      ]),
    );
    expect(xrayOpenedMap(c, 'g')).toEqual(new Map());
    const d = reduceReview(c, { type: 'xray-depth', unitId: 'f', depth: XRAY_FULL });
    expect(d.xrayDepth).toEqual({ f: XRAY_FULL });
    expect(d.xrayOpened).toEqual({});
    expect(reduceReview(d, { type: 'xray-depth', unitId: 'f', depth: XRAY_FULL })).toBe(d);
  });
});
