import { describe, expect, it } from 'vitest';
import { CSI, feed, term } from './helpers';

describe('scrolling and regions', () => {
  it('LF at the bottom scrolls and feeds scrollback', () => {
    const t = term({ cols: 5, rows: 3 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    expect(t.serialize()).toEqual(['b', 'c', 'd']);
    expect(t.scrollbackLength).toBe(1);
    expect(t.scrollbackLine(0)).toBe('a');
  });

  it('DECSTBM scrolling stays inside the margins', () => {
    const t = term({ cols: 5, rows: 5 });
    feed(t, '1\r\n2\r\n3\r\n4\r\n5');
    t.write(`${CSI}2;4r`); // margins rows 2–4, cursor homes
    t.write(`${CSI}4;1H\n`); // LF at region bottom
    expect(t.serialize()).toEqual(['1', '3', '4', '', '5']);
    // Lines scrolled inside a region do not pollute scrollback.
    expect(t.scrollbackLength).toBe(0);
  });

  it('RI at the top of the region scrolls down', () => {
    const t = term({ cols: 5, rows: 5 });
    feed(t, '1\r\n2\r\n3\r\n4\r\n5');
    t.write(`${CSI}2;4r${CSI}2;1H\x1bM`);
    expect(t.serialize()).toEqual(['1', '', '2', '3', '5']);
  });

  it('SU and SD shift region content without moving the cursor', () => {
    const t = term({ cols: 5, rows: 3 });
    feed(t, 'a\r\nb\r\nc');
    t.write(`${CSI}2;2H${CSI}1S`);
    expect(t.serialize()).toEqual(['b', 'c', '']);
    expect(t.cursor).toMatchObject({ x: 1, y: 1 });
    t.write(`${CSI}1T`);
    expect(t.serialize()).toEqual(['', 'b', 'c']);
  });

  it('IL inserts lines at the cursor inside the region', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    t.write(`${CSI}2;1H${CSI}2L`);
    expect(t.serialize()).toEqual(['a', '', '', 'b']);
  });

  it('DL deletes lines pulling from below the cursor', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    t.write(`${CSI}2;1H${CSI}1M`);
    expect(t.serialize()).toEqual(['a', 'c', 'd', '']);
  });

  it('DL at row 0 with default margins destroys the line, never archiving it', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    t.write(`${CSI}1;1H${CSI}1M`);
    expect(t.serialize()).toEqual(['b', 'c', 'd', '']);
    expect(t.scrollbackLength).toBe(0);
  });

  it('IL/DL outside the scroll region are ignored', () => {
    const t = term({ cols: 5, rows: 4 });
    feed(t, 'a\r\nb\r\nc\r\nd');
    t.write(`${CSI}2;3r${CSI}4;1H${CSI}5L`);
    expect(t.serialize()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('origin mode addresses relative to the region', () => {
    const t = term({ cols: 5, rows: 5 });
    t.write(`${CSI}2;4r${CSI}?6h${CSI}1;1HX`);
    expect(t.serialize()).toEqual(['', 'X', '', '', '']);
    // CUP cannot leave the region while origin mode is set.
    t.write(`${CSI}99;1HY`);
    expect(t.serialize()[3]).toBe('Y');
  });

  it('vertical movement stops at the margins', () => {
    const t = term({ cols: 5, rows: 5 });
    t.write(`${CSI}2;4r${CSI}3;1H${CSI}9A`);
    expect(t.cursor.y).toBe(1);
    t.write(`${CSI}9B`);
    expect(t.cursor.y).toBe(3);
  });

  it('scrollback is capped at the configured size', () => {
    const t = term({ cols: 3, rows: 2, scrollback: 5 });
    for (let i = 0; i < 20; i++) feed(t, `${i}\r\n`);
    expect(t.scrollbackLength).toBe(5);
    expect(t.scrollbackLine(4)).toBe('18');
  });

  it('viewport offset holds position while output scrolls beneath', () => {
    const t = term({ cols: 3, rows: 2 });
    feed(t, 'a\r\nb\r\nc\r\n');
    t.scrollViewport(2);
    expect(t.viewportOffset).toBe(2);
    expect(t.viewportRow(0).text()).toBe('a');
    feed(t, 'd\r\n');
    expect(t.viewportRow(0).text()).toBe('a');
    t.scrollToBottom();
    expect(t.viewportOffset).toBe(0);
  });

  it('ED 3 clears scrollback but not the screen', () => {
    const t = term({ cols: 3, rows: 2 });
    feed(t, 'a\r\nb\r\nc');
    expect(t.scrollbackLength).toBeGreaterThan(0);
    t.write(`${CSI}3J`);
    expect(t.scrollbackLength).toBe(0);
    expect(t.serialize()).toEqual(['b', 'c']);
  });

  it('wrapped continuation rows carry the wrapped flag', () => {
    const t = term({ cols: 3, rows: 4 });
    feed(t, 'abcdef');
    expect(t.row(0).wrapped).toBe(false);
    expect(t.row(1).wrapped).toBe(true);
  });
});
