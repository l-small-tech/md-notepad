import { describe, expect, test } from 'vitest';
import { appendMentions, collectMentions, isLocalLinkTarget } from '../link-mentions';

describe('isLocalLinkTarget', () => {
  test('accepts relative and POSIX-absolute paths', () => {
    expect(isLocalLinkTarget('./pics/a.png')).toBe(true);
    expect(isLocalLinkTarget('../doc.md')).toBe(true);
    expect(isLocalLinkTarget('/notes/a.png')).toBe(true);
  });

  test('accepts Windows drive paths (despite the leading letter:)', () => {
    expect(isLocalLinkTarget('C:\\media\\a.png')).toBe(true);
    expect(isLocalLinkTarget('D:/x/y.png')).toBe(true);
  });

  test('rejects URLs, mailto/data schemes, and in-document anchors', () => {
    expect(isLocalLinkTarget('https://example.com/a.png')).toBe(false);
    expect(isLocalLinkTarget('mailto:me@x.com')).toBe(false);
    expect(isLocalLinkTarget('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalLinkTarget('#section')).toBe(false);
    expect(isLocalLinkTarget('')).toBe(false);
  });
});

describe('collectMentions', () => {
  test('resolves relative link/image paths to absolute against the base dir', () => {
    const text = 'See ![pic](./pics/a.png) and [notes](../shared/b.md).';
    expect(collectMentions(text, '/home/me/notes')).toEqual([
      '/home/me/notes/pics/a.png',
      '/home/me/shared/b.md',
    ]);
  });

  test('leaves already-absolute destinations absolute (forward-slashed)', () => {
    const text = '[x](C:\\media\\a.png)';
    expect(collectMentions(text, '/notes')).toEqual(['C:/media/a.png']);
  });

  test('skips remote URLs and anchors', () => {
    const text = '[site](https://example.com) [top](#top) ![p](./a.png)';
    expect(collectMentions(text, '/notes')).toEqual(['/notes/a.png']);
  });

  test('handles angle-bracket destinations with spaces and titles', () => {
    const text = '![p](<./my pics/a b.png> "a title")';
    expect(collectMentions(text, '/notes')).toEqual(['/notes/my pics/a b.png']);
  });

  test('dedupes the same resolved path case-insensitively, keeping first order', () => {
    const text = '![a](./A.png) then [again](./sub/../A.png) then ![b](./b.png)';
    expect(collectMentions(text, '/notes')).toEqual(['/notes/A.png', '/notes/b.png']);
  });

  test('with no base dir (unsaved doc), paths stay relative and normalized', () => {
    expect(collectMentions('![p](./pics/a.png)', '')).toEqual(['pics/a.png']);
  });
});

describe('appendMentions', () => {
  test('appends an @-mention block and reports the count', () => {
    const { text, count } = appendMentions('body ![p](./a.png)', '/notes');
    expect(count).toBe(1);
    expect(text).toBe('body ![p](./a.png)\n\n@/notes/a.png');
  });

  test('returns the text untouched when there are no local links', () => {
    const { text, count } = appendMentions('just [a link](https://x.com)', '/notes');
    expect(count).toBe(0);
    expect(text).toBe('just [a link](https://x.com)');
  });
});
