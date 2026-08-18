import { describe, expect, it } from 'vitest';
import { CSI, feed, term } from './helpers';

describe('cursor movement', () => {
  it('CUP positions 1-based, clamped', () => {
    const t = term();
    t.write(`${CSI}3;4H`);
    expect(t.cursor).toMatchObject({ x: 3, y: 2 });
    t.write(`${CSI}99;99H`);
    expect(t.cursor).toMatchObject({ x: 9, y: 4 });
    t.write(`${CSI}H`);
    expect(t.cursor).toMatchObject({ x: 0, y: 0 });
  });

  it('CUU/CUD/CUF/CUB move relatively and clamp at edges', () => {
    const t = term();
    t.write(`${CSI}3;3H${CSI}A${CSI}2D`);
    expect(t.cursor).toMatchObject({ x: 0, y: 1 });
    t.write(`${CSI}9B${CSI}99C`);
    expect(t.cursor).toMatchObject({ x: 9, y: 4 });
  });

  it('CHA and VPA set column/row absolutely', () => {
    const t = term();
    t.write(`${CSI}5G`);
    expect(t.cursor.x).toBe(4);
    t.write(`${CSI}3d`);
    expect(t.cursor).toMatchObject({ x: 4, y: 2 });
  });

  it('CR and LF', () => {
    const t = term();
    expect(feed(t, 'ab\r\ncd')).toEqual(['ab', 'cd', '', '', '']);
    expect(t.cursor).toMatchObject({ x: 2, y: 1 });
  });

  it('bare LF keeps the column', () => {
    const t = term();
    feed(t, 'ab\ncd');
    expect(t.serialize()).toEqual(['ab', '  cd', '', '', '']);
  });

  it('backspace stops at column 0', () => {
    const t = term();
    feed(t, 'abc\b\b\b\b\bX');
    expect(t.serialize()[0]).toBe('Xbc');
  });

  it('tabs land on every 8th column', () => {
    const t = term({ cols: 20 });
    feed(t, 'a\tb\tc');
    expect(t.serialize()[0]).toBe('a       b       c');
  });

  it('HTS sets and TBC clears tab stops', () => {
    const t = term({ cols: 20 });
    t.write(`${CSI}1;4H\x1bH${CSI}1;1H\tX`);
    expect(t.serialize()[0]).toBe('   X');
    t.write(`${CSI}3g\r\tY`);
    expect(t.serialize()[0]?.endsWith('Y')).toBe(true);
    expect(t.cursor.x).toBe(20 - 1 + 1 - 1); // ran to the last column
  });

  it('CNL/CPL move vertically to column 0', () => {
    const t = term();
    t.write(`${CSI}3;5H${CSI}E`);
    expect(t.cursor).toMatchObject({ x: 0, y: 3 });
    t.write(`${CSI}5G${CSI}2F`);
    expect(t.cursor).toMatchObject({ x: 0, y: 1 });
  });

  it('autowrap uses pending-wrap semantics', () => {
    const t = term({ cols: 5 });
    feed(t, '12345');
    // Cursor visually sits on the last column; nothing wrapped yet.
    expect(t.cursor).toMatchObject({ x: 4, y: 0 });
    feed(t, '6');
    expect(t.serialize().slice(0, 2)).toEqual(['12345', '6']);
    expect(t.cursor).toMatchObject({ x: 1, y: 1 });
  });

  it('CR after filling the line does not wrap', () => {
    const t = term({ cols: 5 });
    feed(t, '12345\rX');
    expect(t.serialize()[0]).toBe('X2345');
    expect(t.serialize()[1]).toBe('');
  });

  it('cursor movement cancels a pending wrap', () => {
    const t = term({ cols: 5 });
    feed(t, `12345${CSI}1;5HX`);
    expect(t.serialize()[0]).toBe('1234X');
    expect(t.serialize()[1]).toBe('');
  });

  it('DECAWM off overwrites the last column instead of wrapping', () => {
    const t = term({ cols: 5 });
    feed(t, `${CSI}?7labcdefg`);
    expect(t.serialize()).toEqual(['abcdg', '', '', '', '']);
  });

  it('DECSC/DECRC save and restore cursor and attributes', () => {
    const t = term();
    t.write(`${CSI}2;3H${CSI}31m\x1b7${CSI}H${CSI}0m\x1b8`);
    expect(t.cursor).toMatchObject({ x: 2, y: 1 });
    t.write('x');
    const cell = t.row(1).getCell(2);
    expect(cell.fg & 0xff).toBe(1); // red palette index survived restore
  });

  it('REP repeats the last printed character', () => {
    const t = term();
    feed(t, `a${CSI}3b`);
    expect(t.serialize()[0]).toBe('aaaa');
  });

  it('ICH inserts blanks, pushing content right', () => {
    const t = term();
    feed(t, `abcdef${CSI}1;3H${CSI}2@`);
    expect(t.serialize()[0]).toBe('ab  cdef');
  });

  it('DCH deletes cells, pulling content left', () => {
    const t = term();
    feed(t, `abcdef${CSI}1;2H${CSI}2P`);
    expect(t.serialize()[0]).toBe('adef');
  });

  it('ECH erases without shifting', () => {
    const t = term();
    feed(t, `abcdef${CSI}1;2H${CSI}3X`);
    expect(t.serialize()[0]).toBe('a   ef');
  });

  it('insert mode (IRM) shifts as characters are typed', () => {
    const t = term();
    feed(t, `abc${CSI}1;1H${CSI}4hXY${CSI}4l`);
    expect(t.serialize()[0]).toBe('XYabc');
  });

  it('ED 0/1/2 erase the right parts of the display', () => {
    const t = term({ cols: 3, rows: 3 });
    feed(t, 'aaa\r\nbbb\r\nccc');
    t.write(`${CSI}2;2H${CSI}0J`);
    expect(t.serialize()).toEqual(['aaa', 'b', '']);
    feed(t, `${CSI}2;2H`);
    t.write(`${CSI}1J`);
    expect(t.serialize()).toEqual(['', '', '']);
  });

  it('EL erases within the line', () => {
    const t = term();
    feed(t, `abcdef${CSI}1;3H${CSI}K`);
    expect(t.serialize()[0]).toBe('ab');
    feed(t, `${CSI}1;9Hxy`);
    t.write(`${CSI}1;2H${CSI}1K`);
    expect(t.serialize()[0]).toBe('        xy');
  });

  it('DECALN fills the screen with E', () => {
    const t = term({ cols: 3, rows: 2 });
    t.write('\x1b#8');
    expect(t.serialize()).toEqual(['EEE', 'EEE']);
  });

  it('DEC special graphics maps line-drawing characters', () => {
    const t = term();
    feed(t, '\x1b(0lqk\x1b(B');
    expect(t.serialize()[0]).toBe('┌─┐');
  });

  it('SO/SI switch between G0 and G1', () => {
    const t = term();
    feed(t, '\x1b)0a\x0eq\x0fa');
    expect(t.serialize()[0]).toBe('a─a');
  });
});
