/**
 * Mouse reporting: pointer events → the escape sequences an application that
 * asked for mouse tracking expects.
 *
 * Byte-oriented on purpose. The original X10 encoding puts coordinates in
 * single bytes above 0x7f, which UTF-8 encoding would mangle, so every encoder
 * here returns bytes and the caller writes them to the pty unchanged. SGR
 * (1006) is the modern form and the only one with unlimited coordinates —
 * everything current asks for it, but `less` and friends still use X10.
 */

import type { MouseEncoding, MouseTracking } from '../term';

export type MouseKind = 'press' | 'release' | 'move' | 'wheel';

/** Wheel directions, as the report's low button bits. */
export const WHEEL_UP = 0;
export const WHEEL_DOWN = 1;
export const WHEEL_LEFT = 2;
export const WHEEL_RIGHT = 3;

export interface MouseInput {
  kind: MouseKind;
  /** Press/release/move: 0 left, 1 middle, 2 right. Wheel: a `WHEEL_*` value. */
  button: number;
  /** Zero-based cell within the viewport. */
  col: number;
  row: number;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  /** `MouseEvent.buttons` — which buttons a move happens under. */
  buttons?: number;
}

export interface MouseState {
  tracking: MouseTracking;
  encoding: MouseEncoding;
}

/** Modifier bits in the button byte. Meta is reported as Alt, as in xterm. */
const SHIFT_BIT = 4;
const ALT_BIT = 8;
const CTRL_BIT = 16;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;

/** X10 offsets everything by 32 and cannot express a value past this. */
const X10_OFFSET = 32;
const X10_MAX = 223;

const encoder = new TextEncoder();

/**
 * Does the application want this event? Tracking modes differ only in motion:
 * 1000 reports none, 1002 reports it while a button is down, 1003 reports all.
 */
export function wantsMouse(
  state: MouseState,
  input: Pick<MouseInput, 'kind' | 'buttons'>,
): boolean {
  if (state.tracking === 'none') return false;
  if (input.kind !== 'move') return true;
  if (state.tracking === 'any') return true;
  return state.tracking === 'drag' && (input.buttons ?? 0) !== 0;
}

function buttonCode(input: MouseInput): number {
  let code =
    input.kind === 'wheel'
      ? WHEEL_BIT + (input.button & 3)
      : input.kind === 'move'
        ? // A drag reports the held button; a bare move reports "no button" (3).
          MOTION_BIT + (input.buttons ? heldButton(input.buttons) : 3)
        : input.button & 3;
  if (input.shift) code += SHIFT_BIT;
  if (input.alt) code += ALT_BIT;
  if (input.ctrl) code += CTRL_BIT;
  return code;
}

/** Lowest held button in a `MouseEvent.buttons` mask, as a report button. */
function heldButton(buttons: number): number {
  if (buttons & 1) return 0;
  if (buttons & 4) return 1; // middle is bit 2 in the DOM mask
  if (buttons & 2) return 2; // right is bit 1
  return 3;
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * The report for one event, or null when the application does not want it (or
 * the position cannot be expressed in the negotiated encoding).
 */
export function encodeMouse(input: MouseInput, state: MouseState): Uint8Array | null {
  if (!wantsMouse(state, input)) return null;
  const col = Math.max(0, input.col) + 1;
  const row = Math.max(0, input.row) + 1;
  const code = buttonCode(input);

  if (state.encoding === 'sgr') {
    // Release is the one event SGR distinguishes by final byte, which is why
    // it is the only encoding that can report *which* button was let go.
    const final = input.kind === 'release' ? 'm' : 'M';
    return encoder.encode(`\x1b[<${code};${col};${row}${final}`);
  }

  if (state.encoding === 'utf8') {
    // 1005: the same fields as X10, each written as a UTF-8 codepoint.
    return encoder.encode(
      `\x1b[M${String.fromCharCode(X10_OFFSET + code, X10_OFFSET + col, X10_OFFSET + row)}`,
    );
  }

  // X10: a release is button 3, and a cell past 223 is simply unreportable.
  const legacy = input.kind === 'release' ? 3 + (code & ~3) : code;
  if (col > X10_MAX || row > X10_MAX) return null;
  return latin1(
    `\x1b[M${String.fromCharCode(X10_OFFSET + legacy, X10_OFFSET + col, X10_OFFSET + row)}`,
  );
}

/**
 * Focus reporting (mode 1004): `CSI I` on focus, `CSI O` on blur. Applications
 * use it to redraw a dimmed cursor, so it must not be sent when unrequested.
 */
export function encodeFocus(focused: boolean): string {
  return focused ? '\x1b[I' : '\x1b[O';
}
