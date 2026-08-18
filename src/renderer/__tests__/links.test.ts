import { describe, expect, it } from 'vitest';
import { detectUrls, urlAt } from '../links';

describe('detectUrls', () => {
  it('finds a bare URL and reports its columns', () => {
    const text = 'see https://example.com/x now';
    expect(detectUrls(text)).toEqual([{ start: 4, end: 25, uri: 'https://example.com/x' }]);
  });

  it('finds several per line', () => {
    expect(detectUrls('http://a.test and http://b.test').map((link) => link.uri)).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('leaves sentence punctuation out of the URL', () => {
    expect(detectUrls('go to https://example.com.')[0]!.uri).toBe('https://example.com');
    expect(detectUrls('(see https://example.com)')[0]!.uri).toBe('https://example.com');
  });

  it('keeps a closing paren that belongs to the URL', () => {
    const uri = 'https://en.wikipedia.org/wiki/Terminal_(disambiguation)';
    expect(detectUrls(`x ${uri}`)[0]!.uri).toBe(uri);
  });

  it('handles file: and ftp: schemes', () => {
    expect(detectUrls('file:///home/user/notes.md')[0]!.uri).toBe('file:///home/user/notes.md');
    expect(detectUrls('ftp://mirror.test/pub')[0]!.uri).toBe('ftp://mirror.test/pub');
  });

  it('ignores things that only look like links', () => {
    expect(detectUrls('example.com is not linkified')).toEqual([]);
    expect(detectUrls('run https:// alone')).toEqual([]);
  });

  it('stops at whitespace and quotes', () => {
    expect(detectUrls('"https://example.com/a b"')[0]!.uri).toBe('https://example.com/a');
  });
});

describe('urlAt', () => {
  const text = 'see https://example.com/x now';

  it('returns the link covering a column', () => {
    expect(urlAt(text, 4)?.uri).toBe('https://example.com/x');
    expect(urlAt(text, 24)?.uri).toBe('https://example.com/x');
  });

  it('returns null just outside it', () => {
    expect(urlAt(text, 3)).toBeNull();
    expect(urlAt(text, 25)).toBeNull();
  });
});
