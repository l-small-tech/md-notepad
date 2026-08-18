import { describe, expect, it } from 'vitest';
import { bracketPaste, isMultiline, pasteChunks, preparePaste, sanitizePaste } from '../paste';

describe('sanitizePaste', () => {
  it('turns every line ending into CR, the way Enter does', () => {
    expect(sanitizePaste('a\nb')).toBe('a\rb');
    expect(sanitizePaste('a\r\nb')).toBe('a\rb');
    expect(sanitizePaste('a\rb')).toBe('a\rb');
  });

  it('keeps tabs and ordinary text, including astral characters', () => {
    expect(sanitizePaste('a\tb 🙂 é')).toBe('a\tb 🙂 é');
  });

  it('strips control characters a paste has no business carrying', () => {
    expect(sanitizePaste('a\x1b[31mb')).toBe('a[31mb');
    expect(sanitizePaste('a\x00\x07\x08\x7fb')).toBe('ab');
  });

  it('cannot be made to end a bracketed paste early', () => {
    // The ESC is stripped, so the remainder stays inside the bracket instead of
    // being read as keystrokes.
    expect(sanitizePaste('ls\x1b[201~rm -rf /')).toBe('ls[201~rm -rf /');
  });
});

describe('isMultiline', () => {
  it('is true only when the payload would submit more than one line', () => {
    expect(isMultiline('one line')).toBe(false);
    expect(isMultiline('two\rlines')).toBe(true);
    expect(isMultiline('two\nlines')).toBe(true);
  });
});

describe('bracketPaste', () => {
  it('wraps the payload when the application enabled mode 2004', () => {
    expect(bracketPaste('hi', true)).toBe('\x1b[200~hi\x1b[201~');
    expect(bracketPaste('hi', false)).toBe('hi');
  });
});

describe('pasteChunks', () => {
  it('leaves a small payload in one piece, and an empty one in none', () => {
    expect(pasteChunks('hello')).toEqual(['hello']);
    expect(pasteChunks('')).toEqual([]);
  });

  it('splits at the chunk size', () => {
    const chunks = pasteChunks('abcdefg', 3);
    expect(chunks).toEqual(['abc', 'def', 'g']);
  });

  it('never splits a surrogate pair', () => {
    // '🙂' is two code units; a naive split at 3 would cut it in half.
    const chunks = pasteChunks('ab🙂cd', 3);
    expect(chunks).toEqual(['ab', '🙂c', 'd']);
    expect(chunks.join('')).toBe('ab🙂cd');
  });
});

describe('preparePaste', () => {
  it('sanitizes, brackets and chunks in one step', () => {
    const { chunks, text } = preparePaste('one\ntwo', true);
    expect(text).toBe('one\rtwo');
    expect(chunks.join('')).toBe('\x1b[200~one\rtwo\x1b[201~');
  });

  it('returns nothing for a payload that sanitizes away', () => {
    expect(preparePaste('\x00\x07', false).chunks).toEqual([]);
  });
});
