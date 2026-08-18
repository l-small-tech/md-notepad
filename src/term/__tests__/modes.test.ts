import { describe, expect, it } from 'vitest';
import { CSI, term } from './helpers';

describe('modifyOtherKeys (XTMODKEYS)', () => {
  it('is off until an application asks', () => {
    expect(term().modes().modifyOtherKeys).toBe(0);
  });

  it('records the level the application set', () => {
    const t = term();
    t.write(`${CSI}>4;1m`);
    expect(t.modes().modifyOtherKeys).toBe(1);
    t.write(`${CSI}>4;2m`);
    expect(t.modes().modifyOtherKeys).toBe(2);
  });

  it('turns off when the value is omitted, and on XTRMMODKEYS', () => {
    const t = term();
    t.write(`${CSI}>4;2m`);
    t.write(`${CSI}>4m`);
    expect(t.modes().modifyOtherKeys).toBe(0);

    t.write(`${CSI}>4;2m`);
    t.write(`${CSI}>4n`);
    expect(t.modes().modifyOtherKeys).toBe(0);
  });

  it('ignores the other XTMODKEYS resources', () => {
    const t = term();
    t.write(`${CSI}>4;2m`);
    t.write(`${CSI}>1;1m`); // modifyCursorKeys — not implemented
    expect(t.modes().modifyOtherKeys).toBe(2);
  });

  it('clamps an out-of-range level rather than trusting it', () => {
    const t = term();
    t.write(`${CSI}>4;9m`);
    expect(t.modes().modifyOtherKeys).toBe(2);
  });

  it('resets with the terminal', () => {
    const t = term();
    t.write(`${CSI}>4;2m`);
    t.reset();
    expect(t.modes().modifyOtherKeys).toBe(0);
  });
});

describe('clearScrollback', () => {
  it('drops history without renumbering the lines still on screen', () => {
    const t = term({ cols: 10, rows: 3 });
    t.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(t.scrollbackLength).toBe(2);
    const topLine = t.topLine;

    t.clearScrollback();
    expect(t.scrollbackLength).toBe(0);
    // The visible lines keep their absolute numbers, so a live selection or an
    // OSC 133 mark still points at the text it pointed at before.
    expect(t.topLine).toBe(topLine);
    expect(t.serialize()).toEqual(['three', 'four', 'five']);
  });

  it('snaps the viewport back to the live screen', () => {
    const t = term({ cols: 10, rows: 3 });
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    t.scrollViewport(2);
    expect(t.viewportOffset).toBe(2);
    t.clearScrollback();
    expect(t.viewportOffset).toBe(0);
  });
});

describe('setScrollbackLimit', () => {
  it('keeps the newest lines when the setting shrinks', () => {
    const t = term({ cols: 10, rows: 2, scrollback: 100 });
    t.write('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(t.scrollbackLength).toBe(3);

    t.setScrollbackLimit(2);
    expect(t.scrollbackLength).toBe(2);
    // 'one' is the line that fell off the end, not 'three'.
    expect(t.scrollbackLine(0)).toBe('two');
    expect(t.scrollbackLine(1)).toBe('three');
  });

  it('pulls the viewport back inside what is left', () => {
    const t = term({ cols: 10, rows: 2, scrollback: 100 });
    t.write('a\r\nb\r\nc\r\nd\r\ne');
    t.scrollViewport(3);
    expect(t.viewportOffset).toBe(3);

    t.setScrollbackLimit(1);
    expect(t.viewportOffset).toBe(1);
  });

  it('turning scrollback off drops it entirely, and it can be grown again', () => {
    const t = term({ cols: 10, rows: 2, scrollback: 10 });
    t.write('a\r\nb\r\nc');
    t.setScrollbackLimit(0);
    expect(t.scrollbackLength).toBe(0);

    t.setScrollbackLimit(10);
    t.write('\r\nd\r\ne');
    expect(t.scrollbackLength).toBe(2);
  });
});
