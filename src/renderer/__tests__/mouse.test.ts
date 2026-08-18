import { describe, expect, it } from 'vitest';
import {
  WHEEL_DOWN,
  WHEEL_UP,
  encodeFocus,
  encodeMouse,
  wantsMouse,
  type MouseInput,
  type MouseState,
} from '../mouse';

const sgr: MouseState = { tracking: 'drag', encoding: 'sgr' };
const x10: MouseState = { tracking: 'drag', encoding: 'default' };

/** Reports are bytes; latin-1 makes the X10 form readable in assertions. */
function text(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  return String.fromCharCode(...bytes);
}

const press = (over: Partial<MouseInput> = {}): MouseInput => ({
  kind: 'press',
  button: 0,
  col: 0,
  row: 0,
  ...over,
});

describe('wantsMouse', () => {
  it('reports nothing while tracking is off', () => {
    const off: MouseState = { tracking: 'none', encoding: 'sgr' };
    expect(wantsMouse(off, { kind: 'press' })).toBe(false);
    expect(wantsMouse(off, { kind: 'wheel' })).toBe(false);
  });

  it('reports clicks and the wheel in every tracking mode', () => {
    for (const tracking of ['click', 'drag', 'any'] as const) {
      const state: MouseState = { tracking, encoding: 'sgr' };
      expect(wantsMouse(state, { kind: 'press' })).toBe(true);
      expect(wantsMouse(state, { kind: 'release' })).toBe(true);
      expect(wantsMouse(state, { kind: 'wheel' })).toBe(true);
    }
  });

  it('distinguishes the three motion policies', () => {
    const click: MouseState = { tracking: 'click', encoding: 'sgr' };
    const drag: MouseState = { tracking: 'drag', encoding: 'sgr' };
    const any: MouseState = { tracking: 'any', encoding: 'sgr' };

    expect(wantsMouse(click, { kind: 'move', buttons: 1 })).toBe(false);
    expect(wantsMouse(drag, { kind: 'move', buttons: 0 })).toBe(false);
    expect(wantsMouse(drag, { kind: 'move', buttons: 1 })).toBe(true);
    expect(wantsMouse(any, { kind: 'move', buttons: 0 })).toBe(true);
  });
});

describe('SGR encoding (1006)', () => {
  it('reports one-based coordinates and the button', () => {
    expect(text(encodeMouse(press({ col: 4, row: 9 }), sgr))).toBe('\x1b[<0;5;10M');
    expect(text(encodeMouse(press({ button: 1 }), sgr))).toBe('\x1b[<1;1;1M');
    expect(text(encodeMouse(press({ button: 2 }), sgr))).toBe('\x1b[<2;1;1M');
  });

  it('marks a release with a lowercase final, keeping the button', () => {
    expect(text(encodeMouse(press({ kind: 'release', button: 2 }), sgr))).toBe('\x1b[<2;1;1m');
  });

  it('adds the modifier bits (meta is folded into alt by the caller)', () => {
    expect(text(encodeMouse(press({ shift: true }), sgr))).toBe('\x1b[<4;1;1M');
    expect(text(encodeMouse(press({ alt: true }), sgr))).toBe('\x1b[<8;1;1M');
    expect(text(encodeMouse(press({ ctrl: true }), sgr))).toBe('\x1b[<16;1;1M');
    expect(text(encodeMouse(press({ shift: true, ctrl: true }), sgr))).toBe('\x1b[<20;1;1M');
  });

  it('sets the motion bit and reports the held button on a drag', () => {
    expect(text(encodeMouse(press({ kind: 'move', buttons: 1 }), sgr))).toBe('\x1b[<32;1;1M');
    // Middle held: DOM bit 4, report button 1.
    expect(text(encodeMouse(press({ kind: 'move', buttons: 4 }), sgr))).toBe('\x1b[<33;1;1M');
    // No button held (mode 1003) is reported as button 3.
    const any: MouseState = { tracking: 'any', encoding: 'sgr' };
    expect(text(encodeMouse(press({ kind: 'move', buttons: 0 }), any))).toBe('\x1b[<35;1;1M');
  });

  it('encodes the wheel as buttons 64/65', () => {
    expect(text(encodeMouse(press({ kind: 'wheel', button: WHEEL_UP }), sgr))).toBe(
      '\x1b[<64;1;1M',
    );
    expect(text(encodeMouse(press({ kind: 'wheel', button: WHEEL_DOWN }), sgr))).toBe(
      '\x1b[<65;1;1M',
    );
  });

  it('has no coordinate limit', () => {
    expect(text(encodeMouse(press({ col: 399, row: 299 }), sgr))).toBe('\x1b[<0;400;300M');
  });
});

describe('X10 encoding (the default)', () => {
  it('offsets the fields by 32', () => {
    expect(text(encodeMouse(press(), x10))).toBe('\x1b[M\x20\x21\x21');
    expect(text(encodeMouse(press({ col: 4, row: 9 }), x10))).toBe('\x1b[M\x20\x25\x2a');
  });

  it('reports every release as button 3, keeping the modifier bits', () => {
    expect(text(encodeMouse(press({ kind: 'release', button: 2 }), x10))).toBe(
      '\x1b[M\x23\x21\x21',
    );
    expect(text(encodeMouse(press({ kind: 'release', button: 2, ctrl: true }), x10))).toBe(
      '\x1b[M\x33\x21\x21',
    );
  });

  it('keeps the report inside one byte per field, or sends nothing', () => {
    // ESC [ M cb col row — the column byte is the fifth, and 255 is its ceiling.
    const bytes = encodeMouse(press({ col: 222, row: 0 }), x10);
    expect(bytes?.[4]).toBe(255);
    expect(encodeMouse(press({ col: 223, row: 0 }), x10)).toBeNull();
  });

  it('encodes the same fields as UTF-8 in mode 1005', () => {
    const utf8: MouseState = { tracking: 'drag', encoding: 'utf8' };
    // Column 300 is two UTF-8 bytes rather than an unencodable one.
    const bytes = encodeMouse(press({ col: 299, row: 0 }), utf8)!;
    expect(new TextDecoder().decode(bytes)).toBe(`\x1b[M\x20${String.fromCharCode(332)}\x21`);
  });
});

describe('encodeFocus', () => {
  it('sends CSI I on focus and CSI O on blur', () => {
    expect(encodeFocus(true)).toBe('\x1b[I');
    expect(encodeFocus(false)).toBe('\x1b[O');
  });
});
