import { describe, expect, it } from 'vitest';
import {
  BG_STRIKETHROUGH,
  BG_UNDERLINE_MASK,
  BG_UNDERLINE_SHIFT,
  ColorMode,
  FG_BOLD,
  FG_DIM,
  FG_INVERSE,
  FG_ITALIC,
  UnderlineStyle,
  colorMode,
  colorValue,
} from '../attributes';
import { feed, term, CSI } from './helpers';

function cellAt(t: ReturnType<typeof term>, x: number, y = 0) {
  return t.row(y).getCell(x);
}

describe('SGR', () => {
  it('16-color foreground and background', () => {
    const t = term();
    feed(t, `${CSI}31;44mX`);
    const cell = cellAt(t, 0);
    expect(colorMode(cell.fg)).toBe(ColorMode.Palette);
    expect(colorValue(cell.fg)).toBe(1);
    expect(colorMode(cell.bg)).toBe(ColorMode.Palette);
    expect(colorValue(cell.bg)).toBe(4);
  });

  it('bright colors 90–97 / 100–107', () => {
    const t = term();
    feed(t, `${CSI}92;101mX`);
    const cell = cellAt(t, 0);
    expect(colorValue(cell.fg)).toBe(10);
    expect(colorValue(cell.bg)).toBe(9);
  });

  it('256-color, semicolon form', () => {
    const t = term();
    feed(t, `${CSI}38;5;196m${CSI}48;5;24mX`);
    const cell = cellAt(t, 0);
    expect(colorValue(cell.fg)).toBe(196);
    expect(colorValue(cell.bg)).toBe(24);
  });

  it('truecolor, semicolon and colon forms match', () => {
    const t = term();
    feed(t, `${CSI}38;2;10;20;30mA${CSI}0m${CSI}38:2:10:20:30mB`);
    const a = cellAt(t, 0);
    const b = cellAt(t, 1);
    expect(colorMode(a.fg)).toBe(ColorMode.Rgb);
    expect(colorValue(a.fg)).toBe((10 << 16) | (20 << 8) | 30);
    expect(b.fg).toBe(a.fg);
  });

  it('truecolor colon form with colorspace id', () => {
    const t = term();
    feed(t, `${CSI}38:2::10:20:30mX`);
    expect(colorValue(cellAt(t, 0).fg)).toBe((10 << 16) | (20 << 8) | 30);
  });

  it('SGR after extended color still applies later params', () => {
    const t = term();
    feed(t, `${CSI}38;5;100;1mX`);
    const cell = cellAt(t, 0);
    expect(colorValue(cell.fg)).toBe(100);
    expect(cell.fg & FG_BOLD).toBeTruthy();
  });

  it('flags set and clear', () => {
    const t = term();
    feed(t, `${CSI}1;2;3;7;9mA`);
    let cell = cellAt(t, 0);
    expect(cell.fg & FG_BOLD).toBeTruthy();
    expect(cell.fg & FG_DIM).toBeTruthy();
    expect(cell.fg & FG_ITALIC).toBeTruthy();
    expect(cell.fg & FG_INVERSE).toBeTruthy();
    expect(cell.bg & BG_STRIKETHROUGH).toBeTruthy();
    feed(t, `${CSI}22;23;27;29mB`);
    cell = cellAt(t, 1);
    expect(cell.fg & (FG_BOLD | FG_DIM | FG_ITALIC | FG_INVERSE)).toBe(0);
    expect(cell.bg & BG_STRIKETHROUGH).toBe(0);
  });

  it('underline styles via 4, 4:x and 21', () => {
    const t = term();
    const style = (x: number) => (cellAt(t, x).bg & BG_UNDERLINE_MASK) >>> BG_UNDERLINE_SHIFT;
    feed(t, `${CSI}4mA${CSI}4:3mB${CSI}21mC${CSI}24mD${CSI}4:0mE`);
    expect(style(0)).toBe(UnderlineStyle.Single);
    expect(style(1)).toBe(UnderlineStyle.Curly);
    expect(style(2)).toBe(UnderlineStyle.Double);
    expect(style(3)).toBe(UnderlineStyle.None);
    expect(style(4)).toBe(UnderlineStyle.None);
  });

  it('underline color 58/59 lands in extended attrs', () => {
    const t = term();
    feed(t, `${CSI}4m${CSI}58;2;1;2;3mA${CSI}59mB`);
    const a = cellAt(t, 0);
    expect(a.extended?.underlineColor).toBeTruthy();
    expect(colorValue(a.extended!.underlineColor)).toBe((1 << 16) | (2 << 8) | 3);
    expect(cellAt(t, 1).extended).toBeNull();
  });

  it('39/49 reset to default colors, keeping flags', () => {
    const t = term();
    feed(t, `${CSI}1;31;44m${CSI}39;49mX`);
    const cell = cellAt(t, 0);
    expect(colorMode(cell.fg)).toBe(ColorMode.Default);
    expect(colorMode(cell.bg)).toBe(ColorMode.Default);
    expect(cell.fg & FG_BOLD).toBeTruthy();
  });

  it('SGR 0 resets everything', () => {
    const t = term();
    feed(t, `${CSI}1;4;38;5;123;48;5;321m${CSI}0mX`);
    const cell = cellAt(t, 0);
    expect(cell.fg).toBe(0);
    expect(cell.bg).toBe(0);
  });

  it('erase uses current background (BCE)', () => {
    const t = term();
    feed(t, `${CSI}44m${CSI}2J`);
    expect(colorValue(cellAt(t, 5, 2).bg)).toBe(4);
    expect(colorMode(cellAt(t, 5, 2).bg)).toBe(ColorMode.Palette);
  });
});
