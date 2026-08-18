/**
 * Smooth scrolling — the shared easing math.
 *
 * Two very different surfaces animate their scroll position: DOM scrollers
 * (`ui/smooth-scroll.ts` drives `scrollTop`) and the terminal canvas
 * (`renderer/view.ts` drives the viewport offset in lines). Both want the same
 * feel, so the curve lives here — pure numbers, no DOM, unit-tested.
 *
 * The curve is an exponential approach rather than a fixed-duration tween: a
 * wheel notch arriving mid-flight simply moves the target, and the motion
 * continues from wherever it is without a seam or a restart. That is what
 * makes a fast run of notches read as one glide instead of a stutter.
 */

/** Time for half the remaining distance to be covered. */
export const SCROLL_HALF_LIFE_MS = 45;

/**
 * A frame gap longer than this is treated as a stall (a background tab, a
 * blocked main thread) and clamped, so waking up never teleports the surface
 * — the animation just resumes at full speed.
 */
export const MAX_FRAME_MS = 64;

/**
 * Step a value toward its target. `epsilon` is in the caller's unit (pixels
 * for DOM scrollers, lines for the terminal) and is what ends the animation:
 * an exponential approach never arrives exactly.
 */
export function approach(
  current: number,
  target: number,
  dtMs: number,
  epsilon: number,
  halfLifeMs: number = SCROLL_HALF_LIFE_MS,
): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return current;
  }
  const dt = Math.min(dtMs, MAX_FRAME_MS);
  const next = target + (current - target) * Math.pow(2, -dt / halfLifeMs);
  return Math.abs(target - next) <= epsilon ? target : next;
}

/**
 * A wheel event's delta in pixels, whatever unit it arrived in: `deltaMode`
 * 0 is already pixels, 1 counts lines (touchpads on X11/Wayland, some mice)
 * and 2 counts pages.
 */
export function wheelPixels(
  delta: number,
  deltaMode: number,
  lineHeightPx: number,
  pageHeightPx: number,
): number {
  if (!Number.isFinite(delta)) {
    return 0;
  }
  if (deltaMode === 1) {
    return delta * lineHeightPx;
  }
  if (deltaMode === 2) {
    return delta * pageHeightPx;
  }
  return delta;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
