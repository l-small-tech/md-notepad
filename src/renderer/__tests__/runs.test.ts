import { describe, expect, it } from 'vitest';
import { Terminal, UnderlineStyle } from '../../term';
import { ColorResolver } from '../colors';
import { buildRowRuns } from '../runs';
import { DEFAULT_DARK_THEME } from '../theme';

const DEFAULTS = { foreground: 0xd0d0d0, background: 0x101010, cursor: 0xd0d0d0 };

function rowRuns(data: string, options: Parameters<typeof buildRowRuns>[3] = {}, cols = 20) {
  const terminal = new Terminal({ cols, rows: 2 });
  terminal.write(data);
  const resolver = new ColorResolver(DEFAULT_DARK_THEME, DEFAULTS);
  return buildRowRuns(terminal.row(0), cols, resolver, options);
}

describe('buildRowRuns', () => {
  it('batches a plain line into a single text run', () => {
    const { texts, backgrounds } = rowRuns('hello world');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('hello world');
    expect(texts[0]!.col).toBe(0);
    // Default background everywhere: nothing to paint, so nothing is.
    expect(backgrounds).toHaveLength(0);
  });

  it('splits runs where an attribute changes', () => {
    const { texts } = rowRuns('ab\x1b[31mcd\x1b[0mef');
    expect(texts.map((run) => run.text)).toEqual(['ab', 'cd', 'ef']);
    expect(texts[1]!.colors.fg).toBe(DEFAULT_DARK_THEME.ansi[1]);
  });

  it('merges a background across cells that differ only in glyph', () => {
    const { backgrounds } = rowRuns('\x1b[44mabc');
    expect(backgrounds).toEqual([{ col: 0, width: 3, color: DEFAULT_DARK_THEME.ansi[4] }]);
  });

  it('does not batch blank cells into a run', () => {
    const { texts } = rowRuns('a\x1b[5Cb');
    expect(texts.map((run) => run.text)).toEqual(['a', 'b']);
    expect(texts[1]!.col).toBe(6);
  });

  it('keeps trailing spaces that carry a background', () => {
    const { backgrounds, texts } = rowRuns('\x1b[42m   ');
    expect(backgrounds).toEqual([{ col: 0, width: 3, color: DEFAULT_DARK_THEME.ansi[2] }]);
    expect(texts).toHaveLength(0);
  });

  it('emits a run for undecorated-looking blanks that are underlined', () => {
    const { texts } = rowRuns('\x1b[4m   ');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.underline).toBe(UnderlineStyle.Single);
    expect(texts[0]!.width).toBe(3);
  });

  it('gives a wide character a two-column run and skips its spacer', () => {
    const { texts } = rowRuns('a漢b');
    expect(texts.map((run) => [run.text, run.col, run.width])).toEqual([
      ['a', 0, 1],
      ['漢', 1, 2],
      ['b', 3, 1],
    ]);
    expect(texts[1]!.perCell).toBe(true);
  });

  it('does not batch glyphs whose advance a fallback font may not match', () => {
    const { texts } = rowRuns('ab─cd');
    expect(texts.map((run) => run.text)).toEqual(['ab', '─', 'cd']);
    expect(texts[0]!.perCell).toBe(false);
    expect(texts[1]!.perCell).toBe(true);
    expect(texts[2]!.col).toBe(3);
  });

  it('keeps a combining sequence in one cell, drawn on its own', () => {
    const { texts } = rowRuns('aéb');
    expect(texts.map((run) => run.text)).toEqual(['a', 'é', 'b']);
    expect(texts[1]!.perCell).toBe(true);
  });

  it('records underline style, strikethrough and link id per run', () => {
    const { texts } = rowRuns('\x1b[4:3m\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.underline).toBe(UnderlineStyle.Curly);
    expect(texts[0]!.linkId).toBeGreaterThan(0);
  });

  it('splits a run at a hyperlink boundary', () => {
    const { texts } = rowRuns('a\x1b]8;;https://example.com\x1b\\b\x1b]8;;\x1b\\c');
    expect(texts.map((run) => run.text)).toEqual(['a', 'b', 'c']);
    expect(texts[1]!.linkId).toBeGreaterThan(0);
    expect(texts[0]!.linkId).toBe(0);
  });

  it('paints the selection as a background override', () => {
    const { backgrounds, texts } = rowRuns('hello', { selection: { start: 1, end: 3 } });
    expect(backgrounds).toEqual([{ col: 1, width: 2, color: DEFAULT_DARK_THEME.selection }]);
    expect(texts.map((run) => run.text)).toEqual(['h', 'el', 'lo']);
  });

  it('honors DECSCNM by inverting the whole row, blanks included', () => {
    const { backgrounds } = rowRuns('hi', { reverseVideo: true });
    expect(backgrounds).toEqual([{ col: 0, width: 20, color: DEFAULTS.foreground }]);
  });
});
