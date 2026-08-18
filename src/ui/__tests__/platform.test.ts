import { describe, expect, test } from 'vitest';
import { desktopOsFromUA, isAndroidUA } from '../platform';

describe('isAndroidUA', () => {
  test('recognizes Android WebView user-agents', () => {
    expect(
      isAndroidUA(
        'Mozilla/5.0 (Linux; Android 14; SM-X230) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36',
      ),
    ).toBe(true);
    expect(isAndroidUA('Mozilla/5.0 (Linux; Android 11)')).toBe(true);
  });

  test('rejects desktop user-agents', () => {
    expect(isAndroidUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isAndroidUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isAndroidUA('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });
});

describe('desktopOsFromUA', () => {
  test('separates the three desktop platforms the shell picker asks about', () => {
    expect(desktopOsFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(desktopOsFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(desktopOsFromUA('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  test('an unknown or empty UA is treated as Linux, not macOS', () => {
    expect(desktopOsFromUA('')).toBe('linux');
  });

  test("Android says 'Linux' and 'Mac OS X' in one breath — it must not read as mac", () => {
    // Some Android WebViews carry an "Apple WebKit ... like Mac OS X" tail.
    expect(
      desktopOsFromUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (like Mac OS X)'),
    ).toBe('linux');
  });
});
