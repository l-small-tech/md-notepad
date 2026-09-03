import { describe, expect, it } from 'vitest';
import { isUpdateCheckDue, lastSundayStart, UPDATE_CHECK_POLL_MS } from '../update-schedule';

/** Local-time epoch ms — the policy is deliberately local, not UTC. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

// 2026-09-06 is a Sunday; 2026-09-02 (today, when this was written) a Wednesday.
const SUNDAY = at(2026, 9, 6);
const WEDNESDAY = at(2026, 9, 2, 15, 30);

describe('lastSundayStart', () => {
  it('rolls a midweek instant back to Sunday midnight', () => {
    expect(lastSundayStart(WEDNESDAY)).toBe(at(2026, 8, 30));
  });

  it('is the identity on Sunday midnight', () => {
    expect(lastSundayStart(SUNDAY)).toBe(SUNDAY);
  });

  it('keeps Sunday itself once the day is underway', () => {
    expect(lastSundayStart(at(2026, 9, 6, 23, 59))).toBe(SUNDAY);
  });

  it('crosses a month boundary', () => {
    // 2026-10-01 is a Thursday; its Sunday is 2026-09-27.
    expect(lastSundayStart(at(2026, 10, 1, 9))).toBe(at(2026, 9, 27));
  });
});

describe('isUpdateCheckDue', () => {
  const due = (lastCheck: number | null, now: number, enabled = true) =>
    isUpdateCheckDue({ enabled, lastCheck, now });

  it('is never due when the setting is off — not even on a fresh profile', () => {
    expect(due(null, SUNDAY, false)).toBe(false);
    expect(due(at(2020, 1, 1), SUNDAY, false)).toBe(false);
  });

  it('is due when no check has ever run', () => {
    expect(due(null, WEDNESDAY)).toBe(true);
  });

  it('is not due again within the same week', () => {
    // Checked Monday, asked again on Wednesday of the same week.
    expect(due(at(2026, 8, 31, 8), WEDNESDAY)).toBe(false);
  });

  it('is not due again after a check made ON Sunday', () => {
    expect(due(at(2026, 9, 6, 10), at(2026, 9, 6, 22))).toBe(false);
  });

  it('becomes due when Sunday arrives', () => {
    const checked = at(2026, 9, 2, 9); // Wednesday
    expect(due(checked, at(2026, 9, 5, 23, 59))).toBe(false); // Saturday night
    expect(due(checked, SUNDAY)).toBe(true); // Sunday midnight
  });

  it('still fires on Monday when the machine was off all Sunday', () => {
    expect(due(at(2026, 9, 2, 9), at(2026, 9, 7, 9))).toBe(true);
  });

  it('is due exactly once for a long gap, then settles', () => {
    const now = WEDNESDAY;
    expect(due(at(2024, 5, 1), now)).toBe(true);
    // …and after the check stamps `now`, the next ask that week is quiet.
    expect(due(now, now + 60_000)).toBe(false);
  });

  it('repairs a garbage or backwards clock by checking once', () => {
    expect(due(Number.NaN, WEDNESDAY)).toBe(true);
    expect(due(Number.POSITIVE_INFINITY, WEDNESDAY)).toBe(true);
    expect(due(at(2027, 1, 1), WEDNESDAY)).toBe(true); // stamp from the future
  });
});

describe('UPDATE_CHECK_POLL_MS', () => {
  it('re-asks often enough to notice a Sunday crossed with the app open', () => {
    expect(UPDATE_CHECK_POLL_MS).toBeGreaterThan(0);
    expect(UPDATE_CHECK_POLL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
