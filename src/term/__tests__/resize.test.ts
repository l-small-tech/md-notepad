import { describe, expect, it } from 'vitest';
import { CSI, feed, term } from './helpers';

describe('resize', () => {
  it('wider: rows pad with blanks, content intact', () => {
    const t = term({ cols: 5, rows: 3 });
    feed(t, 'abc\r\ndef');
    t.resize(8, 3);
    expect(t.serialize()).toEqual(['abc', 'def', '']);
    expect(t.cols).toBe(8);
  });

  it('narrower: rows truncate (no reflow in v1)', () => {
    const t = term({ cols: 8, rows: 2 });
    feed(t, 'abcdefgh');
    t.resize(4, 2);
    expect(t.serialize()[0]).toBe('abcd');
  });

  it('truncating through a wide char blanks it rather than halving it', () => {
    const t = term({ cols: 6, rows: 2 });
    feed(t, 'ab中');
    t.resize(3, 2); // cut severs the wide char from its spacer
    expect(t.serialize()[0]).toBe('ab');
  });

  it('taller: pulls lines back from scrollback', () => {
    const t = term({ cols: 5, rows: 2 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    expect(t.scrollbackLength).toBe(2);
    t.resize(5, 4);
    expect(t.serialize()).toEqual(['a', 'b', 'c', 'd']);
    expect(t.scrollbackLength).toBe(0);
    expect(t.cursor.y).toBe(3);
  });

  it('shorter: trims blank lines below the cursor first', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb');
    t.resize(5, 2);
    expect(t.serialize()).toEqual(['a', 'b']);
    expect(t.scrollbackLength).toBe(0);
  });

  it('shorter with content everywhere: top lines go to scrollback', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    t.resize(5, 2);
    expect(t.serialize()).toEqual(['c', 'd']);
    expect(t.scrollbackLength).toBe(2);
    expect(t.scrollbackLine(1)).toBe('b');
    expect(t.cursor.y).toBe(1);
  });

  it('resize resets scroll margins and clamps the cursor', () => {
    const t = term({ cols: 10, rows: 10 });
    t.write(`${CSI}3;6r${CSI}10;10H`);
    t.resize(4, 3);
    const cursor = t.cursor;
    expect(cursor.x).toBeLessThan(4);
    expect(cursor.y).toBeLessThan(3);
    // Margins are gone: LF at the new bottom scrolls the whole screen.
    feed(t, `${CSI}3;1Hx\r\n`);
    expect(t.rows).toBe(3);
  });
});

describe('dirty tracking', () => {
  it('reports printed rows dirty, then clears', () => {
    const t = term();
    t.takeDirty(); // initial all-dirty
    t.write('x');
    let dirty = t.takeDirty();
    expect(dirty.all).toBe(false);
    expect(dirty.rows).toEqual([0]);
    dirty = t.takeDirty();
    expect(dirty.all).toBe(false);
    expect(dirty.rows).toEqual([]);
  });

  it('scrolling marks everything dirty', () => {
    const t = term({ cols: 3, rows: 2 });
    t.takeDirty();
    feed(t, 'a\r\nb\r\nc');
    expect(t.takeDirty().all).toBe(true);
  });

  it('synchronized output is observable for render gating', () => {
    const t = term();
    t.write(`${CSI}?2026h`);
    expect(t.synchronized).toBe(true);
    t.write(`${CSI}?2026l`);
    expect(t.synchronized).toBe(false);
    expect(t.takeDirty().all).toBe(true); // release forces a repaint
  });
});
