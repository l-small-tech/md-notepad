import { describe, expect, it } from 'vitest';
import { charWidth } from '../charwidth';
import { CSI, feed, term } from './helpers';

describe('character widths', () => {
  it('classifies representative codepoints', () => {
    expect(charWidth(0x41)).toBe(1); // A
    expect(charWidth(0x4e2d)).toBe(2); // 中
    expect(charWidth(0xac00)).toBe(2); // 가
    expect(charWidth(0x1f600)).toBe(2); // 😀
    expect(charWidth(0x0301)).toBe(0); // combining acute
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // variation selector 16
    expect(charWidth(0x2500)).toBe(1); // box drawing ─
    expect(charWidth(0x00e9)).toBe(1); // é
  });
});

describe('wide characters in the grid', () => {
  it('a wide char occupies two cells with a spacer', () => {
    const t = term();
    feed(t, '中a');
    expect(t.row(0).getCell(0).text).toBe('中');
    expect(t.row(0).getCell(0).width).toBe(2);
    expect(t.row(0).getCell(1).width).toBe(0);
    expect(t.row(0).getCell(2).text).toBe('a');
    expect(t.cursor.x).toBe(3);
  });

  it('overwriting the spacer blanks the wide char', () => {
    const t = term();
    feed(t, `中${CSI}1;2HX`);
    expect(t.serialize()[0]).toBe(' X');
  });

  it('overwriting the lead cell blanks the spacer', () => {
    const t = term();
    feed(t, `中${CSI}1;1HX`);
    expect(t.serialize()[0]).toBe('X');
    expect(t.row(0).getCell(1).width).toBe(1); // no dangling spacer
  });

  it('a wide char at the last column wraps whole', () => {
    const t = term({ cols: 4 });
    feed(t, 'abc中');
    expect(t.serialize().slice(0, 2)).toEqual(['abc', '中']);
    expect(t.row(1).wrapped).toBe(true);
  });

  it('combining marks attach to the previous cell', () => {
    const t = term();
    feed(t, 'e\u0301x');
    expect(t.row(0).getCell(0).text).toBe('e\u0301');
    expect(t.row(0).getCell(1).text).toBe('x');
    expect(t.cursor.x).toBe(2);
  });

  it('combining mark after a wide char attaches to the wide cell', () => {
    const t = term();
    feed(t, '中\u0301');
    expect(t.row(0).getCell(0).text).toBe('中\u0301');
  });

  it('ZWJ emoji sequences stay in one cell pair', () => {
    const t = term();
    feed(t, '👩‍💻x');
    expect(t.row(0).getCell(0).text).toBe('👩‍💻');
    expect(t.row(0).getCell(1).width).toBe(0);
    expect(t.row(0).getCell(2).text).toBe('x');
  });

  it('variation selector attaches without advancing', () => {
    const t = term();
    feed(t, '❤️x');
    expect(t.row(0).getCell(0).text).toBe('❤️');
    expect(t.row(0).getCell(1).text).toBe('x');
  });

  it('combining mark at column 0 attaches across a soft wrap', () => {
    const t = term({ cols: 3 });
    feed(t, 'abcd\u0301');
    expect(t.row(1).getCell(0).text).toBe('d\u0301');
  });
});
