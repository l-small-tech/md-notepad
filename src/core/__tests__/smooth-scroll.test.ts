import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME_MS,
  NotchUnitTracker,
  SCROLL_STIFFNESS,
  STREAM_QUIET_MS,
  WheelSourceTracker,
  clamp,
  restingSpring,
  springStep,
  type ScrollSpring,
} from '../smooth-scroll';

/** Run the spring to rest (or long enough to prove it never gets there). */
function settle(spring: ScrollSpring, target: number, epsilon = 0.5): ScrollSpring {
  for (let i = 0; i < 400 && (spring.position !== target || spring.velocity !== 0); i++) {
    spring = springStep(spring, target, 16, epsilon);
  }
  return spring;
}

describe('springStep', () => {
  it('eases in: starts slow from rest and accelerates', () => {
    const first = springStep(restingSpring(0), 100, 16, 0.5);
    const second = springStep(first, 100, 16, 0.5);
    const initialStep = first.position;
    const nextStep = second.position - first.position;
    expect(initialStep).toBeGreaterThan(0);
    expect(nextStep).toBeGreaterThan(initialStep); // still gathering speed
  });

  it('moves toward the target from either side', () => {
    expect(springStep(restingSpring(100), 0, 64, 0.5).position).toBeLessThan(100);
    expect(springStep(restingSpring(100), 0, 64, 0.5).position).toBeGreaterThan(0);
    expect(springStep(restingSpring(0), -100, 64, 0.5).position).toBeLessThan(0);
  });

  it('carries velocity across a retarget instead of restarting the curve', () => {
    // Fly toward 100 until the spring has real speed, then extend the target.
    let spring = restingSpring(0);
    for (let i = 0; i < 5; i++) spring = springStep(spring, 100, 16, 0.5);
    const speed = spring.velocity;
    expect(speed).toBeGreaterThan(0);
    const retargeted = springStep(spring, 200, 16, 0.5);
    // No seam: the very next frame keeps at least the speed it already had.
    expect(retargeted.position - spring.position).toBeGreaterThanOrEqual(speed * 16 * 0.9);
  });

  it('snaps to the target inside epsilon rather than crawling forever', () => {
    const spring = springStep(restingSpring(99.9), 100, 16, 0.5);
    expect(spring).toEqual({ position: 100, velocity: 0 });
  });

  it('does not snap while leftover velocity is still worth real distance', () => {
    // A pixel from the target but moving fast: snapping would swallow motion.
    const spring = springStep({ position: 99, velocity: 1 }, 100, 1, 0.5);
    expect(spring.velocity).not.toBe(0);
  });

  it('comes to rest exactly on the target', () => {
    expect(settle(restingSpring(0), 500)).toEqual({ position: 500, velocity: 0 });
    expect(settle(restingSpring(500), 0)).toEqual({ position: 0, velocity: 0 });
  });

  it('clamps a stalled frame so waking up does not teleport', () => {
    expect(springStep(restingSpring(0), 100, 10_000, 0.5)).toEqual(
      springStep(restingSpring(0), 100, MAX_FRAME_MS, 0.5),
    );
  });

  it('stands still for a non-positive or invalid frame time', () => {
    const spring = restingSpring(10);
    expect(springStep(spring, 100, 0, 0.5)).toBe(spring);
    expect(springStep(spring, 100, -5, 0.5)).toBe(spring);
    expect(springStep(spring, 100, Number.NaN, 0.5)).toBe(spring);
  });

  it('is critically damped: never overshoots from rest', () => {
    let spring = restingSpring(0);
    for (let i = 0; i < 400; i++) {
      spring = springStep(spring, 100, 16, 0.001, SCROLL_STIFFNESS);
      expect(spring.position).toBeLessThanOrEqual(100);
      if (spring.position === 100 && spring.velocity === 0) break;
    }
  });
});

describe('clamp', () => {
  it('bounds a value both ways', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('WheelSourceTracker', () => {
  it('keeps a ratcheted mouse on the notch path', () => {
    const tracker = new WheelSourceTracker();
    // WebKitGTK 40s, Chromium ~53s, WebView2 120s — all integers, all big.
    for (const [i, delta] of [40, 53, 120, -120, 100].entries()) {
      expect(tracker.classify(delta, 0, i * 50)).toBe('notch');
    }
  });

  it('latches a stream on a single fractional delta', () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.classify(8.25, 0, 0)).toBe('stream');
    // …and holds it for the fling's big integer deltas that follow.
    expect(tracker.classify(180, 0, 10)).toBe('stream');
  });

  it('believes a run of small integer deltas on the third event', () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.classify(4, 0, 0)).toBe('notch');
    expect(tracker.classify(6, 0, 10)).toBe('notch');
    expect(tracker.classify(5, 0, 20)).toBe('stream');
    expect(tracker.classify(7, 0, 30)).toBe('stream');
  });

  it('does not let stray small deltas accumulate across separate gestures', () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.classify(4, 0, 0)).toBe('notch');
    expect(tracker.classify(4, 0, STREAM_QUIET_MS + 1)).toBe('notch');
    expect(tracker.classify(4, 0, 2 * (STREAM_QUIET_MS + 1))).toBe('notch');
  });

  it('a big notch resets a building streak', () => {
    const tracker = new WheelSourceTracker();
    tracker.classify(4, 0, 0);
    tracker.classify(4, 0, 10);
    expect(tracker.classify(120, 0, 20)).toBe('notch');
    expect(tracker.classify(4, 0, 30)).toBe('notch'); // streak starts over
  });

  it('unlatches after the quiet gap', () => {
    const tracker = new WheelSourceTracker();
    expect(tracker.classify(8.25, 0, 0)).toBe('stream');
    expect(tracker.classify(120, 0, STREAM_QUIET_MS + 1)).toBe('notch');
  });

  it('treats line- and page-wise wheels as ratchets whatever the rhythm', () => {
    const tracker = new WheelSourceTracker();
    for (let i = 0; i < 5; i++) {
      expect(tracker.classify(1, 1, i * 8)).toBe('notch');
    }
    expect(tracker.classify(1, 2, 48)).toBe('notch');
  });
});

describe('NotchUnitTracker', () => {
  it('reads one notch whatever the platform per-notch step', () => {
    // The same physical notch: WebKitGTK, Chromium/X11, WebView2.
    for (const step of [40, 53, 100, 120]) {
      expect(new NotchUnitTracker().notches(step)).toBe(1);
      expect(new NotchUnitTracker().notches(-step)).toBe(-1);
    }
  });

  it('divides an accelerated multi-notch delta back into notches', () => {
    const tracker = new NotchUnitTracker();
    expect(tracker.notches(120)).toBe(1); // learns the 120px step
    expect(tracker.notches(360)).toBe(3); // OS acceleration: 3 notches in one event
    expect(tracker.notches(-240)).toBe(-2);
  });

  it('re-learns downward when the honest single-notch step appears', () => {
    const tracker = new NotchUnitTracker();
    expect(tracker.notches(240)).toBeGreaterThanOrEqual(1); // first event was accelerated
    expect(tracker.notches(120)).toBe(1); // the real step is smaller — adopt it
    expect(tracker.notches(240)).toBe(2);
  });

  it('returns 0 for sub-notch deltas so touchpads keep their pixels', () => {
    const tracker = new NotchUnitTracker();
    expect(tracker.notches(8)).toBe(0);
    expect(tracker.notches(-16)).toBe(0);
    expect(tracker.notches(Number.NaN)).toBe(0);
    expect(tracker.notches(40)).toBe(1); // the small deltas did not poison the unit
  });

  it('caps the learned unit so a huge first delta still divides into notches', () => {
    const tracker = new NotchUnitTracker();
    // 1000px as the first event: the unit clamps to the largest known
    // per-notch step (150) instead of swallowing the fling as one notch.
    expect(tracker.notches(1000)).toBe(7);
    expect(tracker.notches(40)).toBe(1); // and the real step re-learns downward
  });
});
