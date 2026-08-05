/**
 * The pointer-routing truth table.
 *
 * This is the module that most deserves exhaustive tests: a routing bug shows
 * up on a tablet as "the app randomly ignores my pen", and the combinations
 * (three pointer types × the finger toggle × the space bar × a pen resting on
 * the glass) are exactly what hand-testing misses.
 */

import { describe, expect, it } from 'vitest';
import {
  createInputState,
  ERASER_BUTTON,
  fingerDrawsEnabled,
  isPalm,
  MAX_TOUCH_CONTACT,
  notePointerDown,
  notePointerUp,
  PALM_GRACE_MS,
  PEN_TAKEOVER_MS,
  routePointer,
  shouldUndoTouchStroke,
  type PointerInfo,
  type RouteContext,
} from '../input';

const info = (over: Partial<PointerInfo> = {}): PointerInfo => ({
  pointerType: 'mouse',
  button: 0,
  width: 1,
  height: 1,
  timeMs: 1000,
  ...over,
});

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  fingerDraws: true,
  spaceHeld: false,
  touchDrawing: false,
  ...over,
});

describe('routePointer — mouse', () => {
  it('draws with the primary button and pans with the others', () => {
    const state = createInputState();
    expect(routePointer(state, info({ button: 0 }), ctx())).toBe('tool');
    expect(routePointer(state, info({ button: 1 }), ctx())).toBe('navigate');
    expect(routePointer(state, info({ button: 2 }), ctx())).toBe('navigate');
  });

  it('treats a move (button -1) as belonging to the tool', () => {
    expect(routePointer(createInputState(), info({ button: -1 }), ctx())).toBe('tool');
  });

  it('pans while the space bar is held', () => {
    expect(routePointer(createInputState(), info({ button: 0 }), ctx({ spaceHeld: true }))).toBe(
      'navigate',
    );
  });
});

describe('routePointer — pen', () => {
  const pen = (over: Partial<PointerInfo> = {}) => info({ pointerType: 'pen', ...over });

  it('always draws, whatever the finger toggle says', () => {
    const state = createInputState();
    expect(routePointer(state, pen(), ctx({ fingerDraws: false }))).toBe('tool');
    expect(routePointer(state, pen(), ctx({ fingerDraws: true }))).toBe('tool');
  });

  it('erases with the eraser end', () => {
    expect(routePointer(createInputState(), pen({ button: ERASER_BUTTON }), ctx())).toBe('erase');
  });

  it('still yields to the space bar', () => {
    expect(routePointer(createInputState(), pen(), ctx({ spaceHeld: true }))).toBe('navigate');
  });
});

describe('routePointer — touch', () => {
  const touch = (over: Partial<PointerInfo> = {}) => info({ pointerType: 'touch', ...over });

  it('draws when the finger toggle is on, pans when it is off', () => {
    const state = createInputState();
    expect(routePointer(state, touch(), ctx({ fingerDraws: true }))).toBe('tool');
    expect(routePointer(state, touch(), ctx({ fingerDraws: false }))).toBe('navigate');
  });

  it('makes a SECOND finger navigate, so two fingers always pinch', () => {
    expect(routePointer(createInputState(), touch(), ctx({ touchDrawing: true }))).toBe('navigate');
  });
});

describe('palm rejection', () => {
  const touch = (over: Partial<PointerInfo> = {}) => info({ pointerType: 'touch', ...over });

  it('ignores every touch while the pen is down', () => {
    const down = notePointerDown(createInputState(), info({ pointerType: 'pen', timeMs: 500 }));
    expect(isPalm(down, touch({ timeMs: 501 }))).toBe(true);
    expect(routePointer(down, touch({ timeMs: 501 }), ctx())).toBe('ignore');
  });

  it('keeps ignoring them through the grace window after the pen lifts', () => {
    const up = notePointerUp(
      notePointerDown(createInputState(), info({ pointerType: 'pen', timeMs: 500 })),
      info({ pointerType: 'pen', timeMs: 900 }),
    );
    expect(routePointer(up, touch({ timeMs: 900 + PALM_GRACE_MS - 1 }), ctx())).toBe('ignore');
    expect(routePointer(up, touch({ timeMs: 900 + PALM_GRACE_MS }), ctx())).toBe('tool');
  });

  it('rejects an oversized contact — a knuckle or the side of a hand', () => {
    const state = createInputState();
    expect(routePointer(state, touch({ width: MAX_TOUCH_CONTACT + 1 }), ctx())).toBe('ignore');
    expect(routePointer(state, touch({ height: MAX_TOUCH_CONTACT + 1 }), ctx())).toBe('ignore');
    expect(routePointer(state, touch({ width: 20, height: 20 }), ctx())).toBe('tool');
  });

  it('never rejects a pen or a mouse for its size', () => {
    const state = createInputState();
    expect(isPalm(state, info({ pointerType: 'pen', width: 200 }))).toBe(false);
    expect(isPalm(state, info({ pointerType: 'mouse', width: 200 }))).toBe(false);
  });
});

describe('pen state', () => {
  it('remembers that a pen exists even after it lifts', () => {
    const state = notePointerUp(
      notePointerDown(createInputState(), info({ pointerType: 'pen' })),
      info({ pointerType: 'pen', timeMs: 1100 }),
    );
    expect(state.penSeen).toBe(true);
    expect(state.penDown).toBe(false);
  });

  it('is untouched by mouse and touch events', () => {
    const state = createInputState();
    expect(notePointerDown(state, info({ pointerType: 'touch' }))).toBe(state);
    expect(notePointerUp(state, info({ pointerType: 'mouse' }))).toBe(state);
  });
});

describe('fingerDrawsEnabled', () => {
  it('defaults to on until a pen is seen, then off', () => {
    expect(fingerDrawsEnabled(null, false)).toBe(true);
    expect(fingerDrawsEnabled(null, true)).toBe(false);
  });

  it('lets an explicit choice win in both directions', () => {
    expect(fingerDrawsEnabled(true, true)).toBe(true);
    expect(fingerDrawsEnabled(false, false)).toBe(false);
  });
});

describe('shouldUndoTouchStroke', () => {
  it('undoes a stroke the palm laid down just before the nib landed', () => {
    expect(shouldUndoTouchStroke(1000, 1000 + PEN_TAKEOVER_MS - 1)).toBe(true);
  });

  it('leaves a deliberate finger stroke alone', () => {
    expect(shouldUndoTouchStroke(1000, 1000 + PEN_TAKEOVER_MS)).toBe(false);
    expect(shouldUndoTouchStroke(null, 1000)).toBe(false);
  });
});
