import { describe, expect, it } from 'vitest';
import { Terminal } from '../../term';
import {
  expandToWord,
  isEmpty,
  normalize,
  rangeForLine,
  selectionText,
  type LineSource,
  type Selection,
} from '../selection';

const selection = (a: [number, number], b: [number, number]): Selection => ({
  anchor: { line: a[0], col: a[1] },
  head: { line: b[0], col: b[1] },
});

describe('normalize', () => {
  it('orders endpoints regardless of drag direction', () => {
    const forward = normalize(selection([2, 3], [5, 1]));
    const backward = normalize(selection([5, 1], [2, 3]));
    expect(forward).toEqual(backward);
    expect(forward.start).toEqual({ line: 2, col: 3 });
  });

  it('orders by column within a line', () => {
    expect(normalize(selection([2, 7], [2, 1])).start.col).toBe(1);
  });

  it('recognizes an empty selection', () => {
    expect(isEmpty(selection([1, 1], [1, 1]))).toBe(true);
    expect(isEmpty(selection([1, 1], [1, 2]))).toBe(false);
  });
});

describe('rangeForLine', () => {
  const multi = selection([2, 3], [4, 5]);

  it('clips the first and last lines and fills the ones between', () => {
    expect(rangeForLine(multi, 2, 80)).toEqual({ start: 3, end: 80 });
    expect(rangeForLine(multi, 3, 80)).toEqual({ start: 0, end: 80 });
    expect(rangeForLine(multi, 4, 80)).toEqual({ start: 0, end: 5 });
  });

  it('returns null outside the selection', () => {
    expect(rangeForLine(multi, 1, 80)).toBeNull();
    expect(rangeForLine(multi, 5, 80)).toBeNull();
  });

  it('returns null for a zero-width range on a single line', () => {
    expect(rangeForLine(selection([2, 4], [2, 4]), 2, 80)).toBeNull();
  });
});

describe('expandToWord', () => {
  it('selects the word under the column', () => {
    expect(expandToWord('the quick brown', 6)).toEqual({ start: 4, end: 9 });
  });

  it('treats path-ish characters as part of the word', () => {
    const text = 'run /usr/local/bin/tool --flag';
    expect(expandToWord(text, 8)).toEqual({ start: 4, end: 23 });
  });

  it('selects the run of whitespace when the click lands in a gap', () => {
    expect(expandToWord('a    b', 2)).toEqual({ start: 1, end: 5 });
  });

  it('clamps past the end of the line', () => {
    expect(expandToWord('ab', 9)).toEqual({ start: 9, end: 10 });
  });
});

describe('selectionText', () => {
  /** A line source over a real terminal, the way the app wires it. */
  function source(terminal: Terminal): LineSource {
    return {
      cols: terminal.cols,
      lineText: (line) => terminal.bufferRow(line)?.text() ?? null,
      // A line continues into the next when the next row is a wrap continuation.
      isWrapped: (line) => terminal.bufferRow(line + 1)?.wrapped ?? false,
    };
  }

  it('joins hard-wrapped lines with newlines', () => {
    const terminal = new Terminal({ cols: 20, rows: 4 });
    terminal.write('alpha\r\nbeta\r\ngamma');
    expect(selectionText(selection([0, 0], [2, 5]), source(terminal))).toBe('alpha\nbeta\ngamma');
  });

  it('joins soft-wrapped lines without one, so a wrapped command pastes back intact', () => {
    const terminal = new Terminal({ cols: 10, rows: 4 });
    terminal.write('echo hello-world');
    expect(selectionText(selection([0, 0], [1, 6]), source(terminal))).toBe('echo hello-world');
  });

  it('clips to the selected columns', () => {
    const terminal = new Terminal({ cols: 20, rows: 2 });
    terminal.write('hello world');
    expect(selectionText(selection([0, 6], [0, 11]), source(terminal))).toBe('world');
  });

  it('skips lines that have fallen out of scrollback', () => {
    const terminal = new Terminal({ cols: 20, rows: 2, scrollback: 0 });
    terminal.write('one\r\ntwo\r\nthree');
    // Line 0 was evicted; the selection still resolves what remains.
    expect(selectionText(selection([0, 0], [2, 5]), source(terminal))).toBe('two\nthree');
  });
});
