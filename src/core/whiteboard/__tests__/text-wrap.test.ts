/**
 * Word wrapping for the dragged text box.
 *
 * The measure is injected, so these tests use a monospace stand-in: one unit
 * per character. That is enough to pin every DECISION the wrapper makes — where
 * it breaks, what it does with the space it broke on, and what happens to a
 * word that cannot fit at all — without pretending to test a font engine.
 */

import { describe, expect, it } from 'vitest';
import { wrapLines } from '../text-wrap';

/** One unit per character. */
const mono = (run: string) => run.length;

describe('wrapLines', () => {
  it('breaks a paragraph at the last word that fits', () => {
    expect(wrapLines('the quick brown fox', 10, mono)).toEqual(['the quick ', 'brown fox']);
  });

  it('keeps explicit newlines — the user pressed Enter and meant it', () => {
    expect(wrapLines('one\n\ntwo', 40, mono)).toEqual(['one', '', 'two']);
  });

  it('wraps each paragraph independently', () => {
    expect(wrapLines('aaa bbb\nccc ddd', 4, mono)).toEqual(['aaa ', 'bbb', 'ccc ', 'ddd']);
  });

  it('breaks a word too long for the box rather than letting it run out', () => {
    expect(wrapLines('supercalifragilistic', 6, mono)).toEqual([
      'superc',
      'alifra',
      'gilist',
      'ic',
    ]);
  });

  it('never starts a line with the space it broke on', () => {
    for (const line of wrapLines('alpha beta gamma delta', 8, mono)) {
      expect(line.startsWith(' ')).toBe(false);
    }
  });

  it('leaves text alone when it fits, and when there is no width to wrap to', () => {
    expect(wrapLines('short', 100, mono)).toEqual(['short']);
    expect(wrapLines('a b c', 0, mono)).toEqual(['a b c']);
  });

  it('produces the same lines when re-wrapped, so a re-edit is stable', () => {
    const once = wrapLines('the quick brown fox jumps over it', 12, mono);
    expect(wrapLines(once.join('\n'), 12, mono)).toEqual(once);
  });

  it('always makes progress — an empty result would hang the caller', () => {
    expect(wrapLines('', 10, mono)).toEqual(['']);
    expect(wrapLines('xxxx', 1, mono)).toEqual(['x', 'x', 'x', 'x']);
  });
});
