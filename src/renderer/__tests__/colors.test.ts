import { describe, expect, it } from 'vitest';
import { Terminal, type Cell } from '../../term';
import { ColorResolver } from '../colors';
import { DEFAULT_DARK_THEME, type TerminalTheme } from '../theme';

const THEME: TerminalTheme = {
  ...DEFAULT_DARK_THEME,
  background: 0x101010,
  foreground: 0xd0d0d0,
  cursor: 0xd0d0d0,
  selection: 0x223344,
  ansi: [
    0x000000, 0xaa0000, 0x00aa00, 0xaaaa00, 0x0000aa, 0xaa00aa, 0x00aaaa, 0xaaaaaa, 0x555555,
    0xff5555, 0x55ff55, 0xffff55, 0x5555ff, 0xff55ff, 0x55ffff, 0xffffff,
  ],
};

const DEFAULTS = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xd0d0d0 };

/** The cell produced by printing `X` under an SGR sequence. */
function cell(sgr: string): Cell {
  const terminal = new Terminal({ cols: 4, rows: 1 });
  terminal.write(`\x1b[${sgr}mX`);
  return terminal.row(0).getCell(0);
}

function resolver(override: (index: number) => number | null = () => null): ColorResolver {
  return new ColorResolver(THEME, DEFAULTS, override);
}

describe('ColorResolver', () => {
  it('leaves a default background transparent so the window shows through', () => {
    const colors = resolver().resolve(cell('0'));
    expect(colors.bg).toBeNull();
    expect(colors.fg).toBe(DEFAULTS.foreground);
  });

  it('paints an explicit background opaquely', () => {
    expect(resolver().resolve(cell('41')).bg).toBe(THEME.ansi[1]);
  });

  it('takes the 16 ANSI colors from the theme', () => {
    expect(resolver().resolve(cell('32')).fg).toBe(THEME.ansi[2]);
  });

  it('promotes bold palette colors to their bright twin', () => {
    expect(resolver().resolve(cell('1;32')).fg).toBe(THEME.ansi[10]);
  });

  it('honors boldIsBright: false', () => {
    const plain = new ColorResolver(THEME, DEFAULTS, () => null, { boldIsBright: false });
    expect(plain.resolve(cell('1;32')).fg).toBe(THEME.ansi[2]);
  });

  it('reads truecolor straight from the cell', () => {
    expect(resolver().resolve(cell('38;2;18;52;86')).fg).toBe(0x123456);
  });

  it('uses the xterm cube for 256-color indices above the ANSI range', () => {
    // Index 196 is the pure-red corner of the 6×6×6 cube.
    expect(resolver().resolve(cell('38;5;196')).fg).toBe(0xff0000);
  });

  it('lets an OSC 4 override win over the theme', () => {
    const withOverride = resolver((index) => (index === 2 ? 0x00ff00 : null));
    expect(withOverride.resolve(cell('32')).fg).toBe(0x00ff00);
  });

  it('memoizes palette lookups until invalidated', () => {
    let current = 0x111111;
    let calls = 0;
    const memoized = new ColorResolver(THEME, DEFAULTS, (index) => {
      if (index !== 1) return null;
      calls++;
      return current;
    });
    expect(memoized.resolve(cell('31')).fg).toBe(0x111111);
    expect(memoized.resolve(cell('31')).fg).toBe(0x111111);
    expect(calls).toBe(1);
    current = 0x222222;
    memoized.invalidate();
    expect(memoized.resolve(cell('31')).fg).toBe(0x222222);
  });

  describe('inverse', () => {
    it('swaps in the default background when the cell has no explicit one', () => {
      const colors = resolver().resolve(cell('7;32'));
      expect(colors.bg).toBe(THEME.ansi[2]);
      expect(colors.fg).toBe(DEFAULTS.background);
    });

    it('swaps explicit colors', () => {
      const colors = resolver().resolve(cell('7;32;41'));
      expect(colors.bg).toBe(THEME.ansi[2]);
      expect(colors.fg).toBe(THEME.ansi[1]);
    });

    it('cancels out against DECSCNM, which inverts the whole screen', () => {
      const colors = resolver().resolve(cell('7'), true);
      expect(colors.bg).toBeNull();
      expect(colors.fg).toBe(DEFAULTS.foreground);
    });

    it('makes reverse video opaque for otherwise-default cells', () => {
      const colors = resolver().resolve(cell('0'), true);
      expect(colors.bg).toBe(DEFAULTS.foreground);
      expect(colors.fg).toBe(DEFAULTS.background);
    });
  });

  it('pulls dim text toward the background', () => {
    const bright = resolver().resolve(cell('0')).fg;
    const dim = resolver().resolve(cell('2')).fg;
    expect(dim).not.toBe(bright);
    // 40% of the way from #d0d0d0 (208) to #101010 (16): 208 - 76.8 → 131.
    expect(dim).toBe(0x838383);
  });

  it('reports invisible cells as hidden without dropping their background', () => {
    const colors = resolver().resolve(cell('8;41'));
    expect(colors.hidden).toBe(true);
    expect(colors.bg).toBe(THEME.ansi[1]);
  });

  it('defaults the underline color to the foreground, and honors SGR 58', () => {
    expect(resolver().resolve(cell('4;32')).underline).toBe(THEME.ansi[2]);
    expect(resolver().resolve(cell('4;58;2;1;2;3')).underline).toBe(0x010203);
  });

  it('overrides the background for selected cells, keeping the glyph color', () => {
    const colors = resolver().resolveSelected(cell('32'));
    expect(colors.bg).toBe(THEME.selection);
    expect(colors.fg).toBe(THEME.ansi[2]);
  });

  it('uses selectionText when the theme sets one', () => {
    const withText = new ColorResolver({ ...THEME, selectionText: 0xffffff }, DEFAULTS);
    expect(withText.resolveSelected(cell('32')).fg).toBe(0xffffff);
  });

  it('follows OSC 11 when the application moves the default background', () => {
    const live = resolver();
    live.setDefaults({ ...DEFAULTS, background: 0x004400 });
    expect(live.resolve(cell('0'), true).bg).toBe(DEFAULTS.foreground);
    expect(live.resolve(cell('7')).fg).toBe(0x004400);
  });
});
