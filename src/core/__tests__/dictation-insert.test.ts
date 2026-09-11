import { describe, expect, test } from 'vitest';
import { joinDictation } from '../dictation-insert';

describe('joinDictation', () => {
  test('at the start of the document the phrase goes in bare', () => {
    expect(joinDictation('', 'hello world')).toBe('hello world');
  });

  test('after a word it gets a leading space', () => {
    expect(joinDictation('o', 'world')).toBe(' world');
    expect(joinDictation('.', 'Next')).toBe(' Next');
  });

  test('after whitespace or an opening bracket/quote it does not', () => {
    for (const before of [' ', '\n', '\t', '(', '[', '{', '"', "'", '`']) {
      expect(joinDictation(before, 'x')).toBe('x');
    }
  });

  test('before a word it gets a trailing space; before punctuation it does not', () => {
    expect(joinDictation(' ', 'big', 'dog')).toBe('big ');
    expect(joinDictation('a', 'dog', '.')).toBe(' dog');
    expect(joinDictation('', 'é', 'été')).toBe('é ');
  });

  test('trims the engine output and drops an empty phrase', () => {
    expect(joinDictation('', '  hi \n')).toBe('hi');
    expect(joinDictation('a', '   ', 'b')).toBe('');
  });
});
