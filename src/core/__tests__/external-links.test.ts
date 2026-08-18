import { describe, expect, test } from 'vitest';
import { externalLinkHost, isExternalHref, shortenUrl } from '../external-links';

describe('isExternalHref', () => {
  test('accepts http and https, case-insensitively, ignoring surrounding space', () => {
    expect(isExternalHref('http://example.com')).toBe(true);
    expect(isExternalHref('https://example.com/a?b#c')).toBe(true);
    expect(isExternalHref('HTTPS://Example.COM')).toBe(true);
    expect(isExternalHref('  https://example.com  ')).toBe(true);
  });

  test('rejects local paths, in-document anchors and other schemes', () => {
    for (const href of [
      'notes/other.md',
      '/abs/path.md',
      'C:\\notes\\a.md',
      '#heading',
      'mailto:a@b.com',
      'data:text/plain,hi',
      'javascript:alert(1)',
      'httpx://example.com',
      '',
    ]) {
      expect(isExternalHref(href)).toBe(false);
    }
  });
});

describe('externalLinkHost', () => {
  test('reads the host, lowercased, without the port-less path or query', () => {
    expect(externalLinkHost('https://GitHub.com/owner/repo?x=1')).toBe('github.com');
    expect(externalLinkHost('http://example.com:8080/a')).toBe('example.com:8080');
    expect(externalLinkHost('https://example.com')).toBe('example.com');
  });

  test('names the real host when userinfo dresses the URL up as another site', () => {
    expect(externalLinkHost('https://github.com@evil.example/path')).toBe('evil.example');
  });

  test('is empty when there is no authority to read', () => {
    expect(externalLinkHost('notes/a.md')).toBe('');
    expect(externalLinkHost('https:///path')).toBe('');
  });
});

describe('shortenUrl', () => {
  test('leaves a URL that already fits alone', () => {
    expect(shortenUrl('https://example.com/a', 72)).toBe('https://example.com/a');
  });

  test('elides the middle, keeping both ends, to exactly max characters', () => {
    const url = `https://example.com/${'x'.repeat(200)}/end`;
    const short = shortenUrl(url, 40);
    expect(short).toHaveLength(40);
    expect(short.startsWith('https://example.com/')).toBe(true);
    expect(short.endsWith('/end')).toBe(true);
    expect(short).toContain('…');
  });
});
