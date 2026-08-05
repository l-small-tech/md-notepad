/**
 * Pointer routing and palm rejection — "does this contact draw, or move the
 * view, or is it the side of a hand?"
 *
 * Pure and DOM-free so the truth table can be tested exhaustively, which
 * matters more here than anywhere else in the whiteboard: a routing bug on a
 * tablet reads as "the app randomly ignores my pen", and no amount of manual
 * poking covers the combinations. The adapter feeds it plain records taken off
 * `PointerEvent`s and owns everything stateful (capture, coalesced samples).
 *
 * The model, in one paragraph. A PEN always draws — that is the one contact
 * whose intent is never ambiguous, so while it is down (and for a moment after)
 * every touch is a palm and is dropped. A MOUSE draws with the primary button
 * and pans with any other, plus the space bar as the conventional temporary-pan
 * modifier. A FINGER is the ambiguous one: it draws only when the user asked it
 * to, and even then a SECOND finger converts the gesture into a pan/pinch,
 * because two fingers on a canvas have meant "move the canvas" since the first
 * touchscreen map.
 */

/** Pen eraser end. `PointerEvent.button` 5 is the standard code for it. */
export const ERASER_BUTTON = 5;

/** Touches are ignored for this long after the pen lifts (a resting palm). */
export const PALM_GRACE_MS = 300;

/**
 * A touch stroke that was committed within this window before a pen landed is
 * undone: the palm touched down a fraction of a second ahead of the nib, drew a
 * short worm, and lifted. Long enough to catch it, short enough never to eat a
 * deliberate finger stroke.
 */
export const PEN_TAKEOVER_MS = 150;

/**
 * Contact sizes above this (CSS px) are a palm or a knuckle, never a fingertip.
 * Generous on purpose — a thumb on a tablet is genuinely wide, and a false
 * reject ("my drawing stopped working") is far worse than a false accept.
 */
export const MAX_TOUCH_CONTACT = 45;

/** What the adapter reads off a PointerEvent. Nothing DOM-shaped survives. */
export interface PointerInfo {
  readonly pointerType: string;
  /** `PointerEvent.button`: 0 primary, 5 pen eraser, -1 on moves. */
  readonly button: number;
  readonly width: number;
  readonly height: number;
  readonly timeMs: number;
}

/** Where a contact is sent. `ignore` is the palm-rejection outcome. */
export type PointerRoute = 'tool' | 'erase' | 'navigate' | 'ignore';

/**
 * The stylus-versus-hand state that persists between events.
 *
 * `penSeen` is deliberately sticky for the life of the adapter: once a device
 * has proved it has a pen, finger-draw stops being the sensible default even
 * while the pen is in its loop.
 */
export interface InputState {
  readonly penSeen: boolean;
  readonly penDown: boolean;
  /** Timestamp of the last pen lift; `-Infinity` until there is one. */
  readonly penUpAt: number;
}

export function createInputState(): InputState {
  return { penSeen: false, penDown: false, penUpAt: -Infinity };
}

export function notePointerDown(state: InputState, info: PointerInfo): InputState {
  if (info.pointerType !== 'pen') {
    return state;
  }
  return { penSeen: true, penDown: true, penUpAt: state.penUpAt };
}

export function notePointerUp(state: InputState, info: PointerInfo): InputState {
  if (info.pointerType !== 'pen') {
    return state;
  }
  return { penSeen: true, penDown: false, penUpAt: info.timeMs };
}

/** What else is going on when a contact lands. */
export interface RouteContext {
  /** The "draw with finger" toggle, already resolved. */
  readonly fingerDraws: boolean;
  /** Space bar held — the temporary-pan modifier. */
  readonly spaceHeld: boolean;
  /** A finger is already driving a TOOL gesture (so this one makes a pinch). */
  readonly touchDrawing: boolean;
}

export function isPalm(state: InputState, info: PointerInfo): boolean {
  if (info.pointerType !== 'touch') {
    return false;
  }
  if (state.penDown || info.timeMs - state.penUpAt < PALM_GRACE_MS) {
    return true;
  }
  return info.width > MAX_TOUCH_CONTACT || info.height > MAX_TOUCH_CONTACT;
}

export function routePointer(
  state: InputState,
  info: PointerInfo,
  context: RouteContext,
): PointerRoute {
  if (info.pointerType === 'pen') {
    if (context.spaceHeld) {
      return 'navigate';
    }
    // The eraser end overrides whatever tool is selected while IT is the end
    // touching the board — what every stylus user expects, and free to honour.
    return info.button === ERASER_BUTTON ? 'erase' : 'tool';
  }

  if (info.pointerType === 'touch') {
    if (isPalm(state, info)) {
      return 'ignore';
    }
    // Second finger down while the first is drawing: the user is reaching for
    // a pinch, so the whole gesture becomes navigation (the adapter discards
    // the half-drawn stroke).
    if (!context.fingerDraws || context.spaceHeld || context.touchDrawing) {
      return 'navigate';
    }
    return 'tool';
  }

  // Mouse (and anything unfamiliar, treated as one).
  if (context.spaceHeld) {
    return 'navigate';
  }
  if (info.button === ERASER_BUTTON) {
    return 'erase';
  }
  return info.button === 0 || info.button < 0 ? 'tool' : 'navigate';
}

/**
 * Resolve the "draw with finger" toggle. `preference` is the user's explicit
 * choice, or null while they have not made one — in which case fingers draw
 * until a pen shows up, so a finger-only tablet works out of the box and a
 * stylus tablet stops smearing the moment the stylus proves it exists.
 */
export function fingerDrawsEnabled(preference: boolean | null, penSeen: boolean): boolean {
  return preference ?? !penSeen;
}

/**
 * Should the touch stroke that was committed at `committedAt` be undone,
 * because a pen landed at `penDownAt`? See {@link PEN_TAKEOVER_MS}.
 */
export function shouldUndoTouchStroke(committedAt: number | null, penDownAt: number): boolean {
  return committedAt !== null && penDownAt - committedAt < PEN_TAKEOVER_MS;
}
