/**
 * Smooth scrolling — the shared physics.
 *
 * Two very different surfaces animate their scroll position: DOM scrollers
 * (`ui/smooth-scroll.ts` drives `scrollTop`) and the terminal canvas
 * (`renderer/view.ts` drives the viewport offset in lines). Both want the same
 * feel, so the math lives here — pure numbers, no DOM, unit-tested.
 *
 * The curve is a critically damped spring, not a fixed-duration tween and not
 * a plain exponential decay. The spring carries a velocity state, which is
 * what buys the two properties high-end scrolling is recognized by:
 *
 *   - **Ease-in.** From rest the motion starts at zero velocity and builds,
 *     instead of teleporting to its maximum speed on the first frame.
 *   - **Momentum.** A wheel notch arriving mid-flight moves the target while
 *     the velocity carries over, so a fast run of notches accelerates into one
 *     gathering glide instead of restarting the curve — and a hard flick may
 *     carry a few pixels past the target and settle back, which is the spring
 *     behaving like mass, not a bug.
 *
 * The second half of the feel is knowing when NOT to animate: precision
 * touchpads and trackpoints stream dozens of fine deltas a second with their
 * own inertia already applied by the OS. Animating those stacks a second
 * easing on top and everything turns floaty. `WheelSourceTracker` tells the
 * two apart so streams can track 1:1 and only discrete notches get the spring.
 */

/**
 * Spring stiffness, per millisecond. A critically damped spring from rest
 * covers ~95% of a step at ω·t ≈ 4.7, so 0.026/ms settles a notch in roughly
 * 180ms — quick enough to feel connected to the wheel, long enough to read as
 * a glide. This is THE feel constant; tune it here and every surface follows.
 */
export const SCROLL_STIFFNESS = 0.026;

/**
 * A frame gap longer than this is treated as a stall (a background tab, a
 * blocked main thread) and clamped, so waking up never teleports the surface
 * — the animation just resumes at full speed.
 */
export const MAX_FRAME_MS = 64;

/** Position + velocity — the whole state of a glide. Velocity is per ms. */
export interface ScrollSpring {
  position: number;
  velocity: number;
}

export function restingSpring(position: number): ScrollSpring {
  return { position, velocity: 0 };
}

/**
 * Advance the spring toward `target` by one frame, using the closed-form
 * solution of the critically damped oscillator (exact for any dt — no
 * integration error, no tuning against frame rate):
 *
 *   x(t) = target + (c₁ + c₂·t)·e^(−ω·t),  c₁ = x₀ − target, c₂ = v₀ + ω·c₁
 *
 * `epsilon` is in the caller's unit (pixels for DOM scrollers, lines for the
 * terminal) and ends the animation: the glide snaps onto the target once the
 * remaining excursion — distance plus the travel the leftover velocity is
 * still good for — is below it. A spring never arrives exactly on its own.
 */
export function springStep(
  spring: ScrollSpring,
  target: number,
  dtMs: number,
  epsilon: number,
  stiffness: number = SCROLL_STIFFNESS,
): ScrollSpring {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return spring;
  }
  const dt = Math.min(dtMs, MAX_FRAME_MS);
  const c1 = spring.position - target;
  const c2 = spring.velocity + stiffness * c1;
  const decay = Math.exp(-stiffness * dt);
  const position = target + (c1 + c2 * dt) * decay;
  const velocity = (c2 - stiffness * (c1 + c2 * dt)) * decay;
  if (Math.abs(target - position) + Math.abs(velocity) / stiffness <= epsilon) {
    return { position: target, velocity: 0 };
  }
  return { position, velocity };
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

// ---------------------------------------------------------------------------
// Wheel-source classification
// ---------------------------------------------------------------------------

/**
 * `notch` — a ratcheted wheel: discrete jumps that want the spring.
 * `stream` — a touchpad/trackpoint/momentum stream: fine-grained deltas with
 * the OS's own inertia already in them, which want to be applied 1:1.
 */
export type WheelKind = 'notch' | 'stream';

/** Silence longer than this ends a stream; the next event is judged fresh. */
export const STREAM_QUIET_MS = 200;
/**
 * Every real mouse notch we know of lands at ≥ 40px (WebKitGTK 40, Chromium
 * X11 ~53, WebView2 100–120); touchpads mostly deliver a few px per event.
 * Below this an integer delta counts toward a stream.
 */
const NOTCH_MIN_PX = 30;
/** Small integer deltas in a row before the stream is believed. */
const STREAM_LATCH_COUNT = 3;

/**
 * Tells wheel ratchets and touchpad streams apart, one event at a time.
 *
 * The browser deliberately hides the input device, so this is a heuristic
 * built from the two signals that survive the event model:
 *
 *   - a **fractional** pixel delta only ever comes from a smooth-scroll source
 *     (libinput/GDK touchpads, macOS trackpads, Windows Precision drivers) —
 *     one is enough to latch;
 *   - a run of **small** pixel deltas (below any known per-notch step) is a
 *     stream too, believed after a short streak so a single odd event cannot
 *     flip a mouse out of the spring.
 *
 * Once latched the stream holds — a fast fling legitimately produces large
 * per-event deltas — until `STREAM_QUIET_MS` of silence, which is how the
 * classification survives a momentum tail and still resets between gestures.
 * Timestamps are injected so this stays pure and fake-timer-testable.
 */
export class WheelSourceTracker {
  private lastAt = Number.NEGATIVE_INFINITY;
  private streak = 0;
  private latched = false;

  classify(deltaY: number, deltaMode: number, nowMs: number): WheelKind {
    const gap = nowMs - this.lastAt;
    this.lastAt = nowMs;
    if (!(gap < STREAM_QUIET_MS)) {
      this.latched = false;
      this.streak = 0;
    }
    // Line- and page-wise wheels are ratchets by definition.
    if (deltaMode !== 0) {
      this.latched = false;
      this.streak = 0;
      return 'notch';
    }
    if (this.latched) {
      return 'stream';
    }
    const magnitude = Math.abs(deltaY);
    if (magnitude > 0 && !Number.isInteger(deltaY)) {
      this.latched = true;
      return 'stream';
    }
    if (magnitude > 0 && magnitude < NOTCH_MIN_PX) {
      this.streak += 1;
      if (this.streak >= STREAM_LATCH_COUNT) {
        this.latched = true;
        return 'stream';
      }
    } else {
      this.streak = 0;
    }
    return 'notch';
  }
}
