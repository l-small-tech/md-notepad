/**
 * Update-check schedule — the pure "is an automatic check due?" decision.
 *
 * Policy: at most ONE automatic check per calendar week, and never before
 * Sunday of the current week (local time). Concretely, a check is due when the
 * previous one predates the most recent Sunday-midnight — so a machine that is
 * off all Sunday still checks on Monday rather than skipping the week, and a
 * machine left running across the Sunday boundary becomes due at midnight.
 *
 * Kept here (DOM-free, clock injected) so the policy is testable without
 * waiting a week; `ui/update.ts` owns the side effects.
 */

/** How often a long-running window re-asks `isUpdateCheckDue`. */
export const UPDATE_CHECK_POLL_MS = 60 * 60 * 1000;

/**
 * Local-time midnight of the most recent Sunday at or before `now`
 * (`now` itself when it already IS Sunday midnight).
 */
export function lastSundayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Sunday
  return d.getTime();
}

export interface UpdateCheckDueInput {
  /** The `autoUpdateCheck` setting. */
  enabled: boolean;
  /** Epoch ms of the last check of any kind, or null if never checked. */
  lastCheck: number | null;
  now: number;
}

export function isUpdateCheckDue({ enabled, lastCheck, now }: UpdateCheckDueInput): boolean {
  if (!enabled) {
    return false;
  }
  // Never checked, a garbage timestamp, or a clock that has moved backwards
  // (dual-boot, timezone fix): check once now, which also repairs the stamp.
  if (lastCheck === null || !Number.isFinite(lastCheck) || lastCheck > now) {
    return true;
  }
  return lastCheck < lastSundayStart(now);
}
